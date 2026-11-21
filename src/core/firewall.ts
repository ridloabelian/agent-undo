import crypto from 'node:crypto';
import type { PolicyEngine } from '../policy/engine.js';
import type { UndoDatabase } from '../storage/database.js';
import type {
  ActionRecord,
  ActionStatus,
  DryRunDiff,
  InterceptRequest,
  InterceptResult,
  ToolDefinition,
  UndoResult,
} from '../types.js';
import { generateDefaultDiff } from './diff.js';
import { GraceScheduler } from './scheduler.js';

export class ActionNotFoundError extends Error {
  constructor(actionId: string) {
    super(`Action "${actionId}" was not found.`);
    this.name = 'ActionNotFoundError';
  }
}

export class InvalidActionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidActionStateError';
  }
}

export class IrreversibleActionError extends Error {
  constructor(toolName: string, actionId: string) {
    super(
      `Action "${actionId}" (${toolName}) has already executed and has no compensating rollback handler.`,
    );
    this.name = 'IrreversibleActionError';
  }
}

export interface AgentUndoEngineOptions {
  db: UndoDatabase;
  policy: PolicyEngine;
  fallbackExecutor?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  schedulerPollMs?: number;
  autoStartScheduler?: boolean;
}

/**
 * Core transactional firewall orchestrating policy checks, budget caps,
 * dry-run diffs, delayed soft-undo grace windows, approvals, snapshots,
 * and compensating rollbacks.
 */
export class AgentUndoEngine {
  readonly db: UndoDatabase;
  readonly policy: PolicyEngine;
  private readonly tools = new Map<
    string,
    ToolDefinition<Record<string, unknown>, unknown>
  >();
  private readonly customExecutors = new Map<
    string,
    (args: Record<string, unknown>) => Promise<unknown>
  >();
  private readonly waiters = new Map<
    string,
    Array<(result: InterceptResult) => void>
  >();
  private readonly fallbackExecutor?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  private readonly scheduler: GraceScheduler;

  constructor(options: AgentUndoEngineOptions) {
    this.db = options.db;
    this.policy = options.policy;
    this.fallbackExecutor = options.fallbackExecutor;
    this.scheduler = new GraceScheduler({
      db: this.db,
      pollIntervalMs: options.schedulerPollMs ?? 200,
      onDue: async (actionId) => {
        await this.executeClaimedAction(actionId, 'grace-scheduler');
      },
    });

    if (options.autoStartScheduler !== false) {
      this.scheduler.start();
    }
  }

  registerTool<TArgs extends Record<string, unknown>, TResult>(
    tool: ToolDefinition<TArgs, TResult>,
  ): void {
    this.tools.set(
      tool.name,
      tool as unknown as ToolDefinition<Record<string, unknown>, unknown>,
    );
  }

  registerTools(
    tools: Array<ToolDefinition<Record<string, unknown>, unknown>>,
  ): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  getTool(
    name: string,
  ): ToolDefinition<Record<string, unknown>, unknown> | undefined {
    return this.tools.get(name);
  }

  listTools(): Array<ToolDefinition<Record<string, unknown>, unknown>> {
    return Array.from(this.tools.values());
  }

  start(): void {
    this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
  }

  async flushDueGraceActions(): Promise<void> {
    await this.scheduler.tick();
  }

  async intercept(request: InterceptRequest): Promise<InterceptResult> {
    const sessionId = request.sessionId ?? 'default';
    const agentId = request.agentId ?? 'agent';
    const actor = request.actor ?? agentId;
    const actionId = `act_${crypto.randomUUID().slice(0, 12)}`;

    const tool = this.tools.get(request.toolName);
    if (request.customExecutor) {
      this.customExecutors.set(actionId, request.customExecutor);
    }

    const reversible = Boolean(tool?.compensate);
    const reversibilityNote = reversible
      ? 'Reversible via pre-execution snapshot compensating rollback.'
      : 'Irreversible once executed; only soft-undoable during staging.';

    const diff: DryRunDiff = tool?.previewDiff
      ? await tool.previewDiff(request.args)
      : generateDefaultDiff(
          request.toolName,
          request.args,
          reversible,
          reversibilityNote,
        );

    const adapterSpendUsd = tool?.estimateSpendUsd
      ? tool.estimateSpendUsd(request.args)
      : undefined;

    const previewSnapshot = tool?.captureSnapshot
      ? await tool.captureSnapshot(request.args)
      : undefined;

    const { action, evaluation } = this.db.createActionWithAudit({
      id: actionId,
      sessionId,
      agentId,
      toolName: request.toolName,
      args: request.args,
      diff,
      actor,
      reversible,
      evaluate: (usage) => {
        const evalResult = this.policy.evaluate({
          toolName: request.toolName,
          args: request.args,
          adapterReadOnly: tool?.readOnly,
          adapterSpendUsd,
          currentUsage: usage,
        });

        let status: ActionStatus;
        let executeAtMs: number | null = null;
        let executeAt: string | null = null;
        let auditEventType = 'ACTION_DENIED';
        let auditSummary = `Denied ${request.toolName}: ${evalResult.reason}`;

        if (evalResult.decision === 'allow') {
          status = 'executing';
          auditEventType = 'ACTION_ALLOWED';
          auditSummary = `Allowed ${request.toolName} for immediate execution`;
        } else if (evalResult.decision === 'grace_window') {
          status = 'grace_pending';
          executeAtMs = Date.now() + Math.round(evalResult.graceSeconds * 1000);
          executeAt = new Date(executeAtMs).toISOString();
          auditEventType = 'ACTION_STAGED_GRACE';
          auditSummary = `Staged ${request.toolName} in ${evalResult.graceSeconds}s grace window`;
        } else if (evalResult.decision === 'require_approval') {
          status = 'pending_approval';
          auditEventType = 'ACTION_PENDING_APPROVAL';
          auditSummary = `Blocked ${request.toolName} pending human approval`;
        } else {
          status = 'denied';
        }

        return {
          evaluation: evalResult,
          status,
          graceSeconds: evalResult.graceSeconds,
          executeAtMs,
          executeAt,
          beforeSnapshot: previewSnapshot,
          auditEventType,
          auditSummary,
        };
      },
    });

    if (evaluation.decision === 'deny') {
      this.customExecutors.delete(actionId);
      return {
        status: 'denied',
        action,
      };
    }

    if (evaluation.decision === 'allow') {
      return await this.runToolExecution(action, actor);
    }

    const completionPromise = request.awaitCompletion
      ? this.waitForCompletion(action.id)
      : null;

    if (
      evaluation.decision === 'grace_window' &&
      action.executeAtMs !== null
    ) {
      this.scheduler.schedule(action.id, action.executeAtMs);
    }

    if (completionPromise) {
      return await completionPromise;
    }

    if (evaluation.decision === 'grace_window') {
      return {
        status: 'staged',
        action,
      };
    }

    return {
      status: 'pending_approval',
      action,
    };
  }

  async approve(actionId: string, actor: string = 'human'): Promise<ActionRecord> {
    const existing = this.db.getAction(actionId);
    if (!existing) {
      throw new ActionNotFoundError(actionId);
    }
    if (existing.status !== 'pending_approval') {
      throw new InvalidActionStateError(
        `Action "${actionId}" is in status "${existing.status}" and cannot be approved.`,
      );
    }

    const approved = this.db.claimApproveAction(actionId, actor);
    if (!approved) {
      throw new InvalidActionStateError(
        `Action "${actionId}" could not be transitioned from pending_approval.`,
      );
    }

    const execResult = await this.executeClaimedAction(actionId, actor);
    if (!execResult) {
      const latest = this.db.getAction(actionId);
      if (!latest) throw new ActionNotFoundError(actionId);
      return latest;
    }

    return execResult.action;
  }

  async undo(actionId: string, actor: string = 'human'): Promise<UndoResult> {
    const existing = this.db.getAction(actionId);
    if (!existing) {
      throw new ActionNotFoundError(actionId);
    }

    if (
      existing.status === 'grace_pending' ||
      existing.status === 'pending_approval' ||
      existing.status === 'approved'
    ) {
      this.scheduler.cancel(actionId);
      const undone = this.db.claimSoftUndo(actionId, actor);
      if (undone) {
        this.customExecutors.delete(actionId);
        this.resolveWaiters(actionId, {
          status: 'undone',
          action: undone,
        });
        return {
          mode: 'soft_cancel',
          action: undone,
        };
      }
    }

    const current = this.db.getAction(actionId);
    if (!current) {
      throw new ActionNotFoundError(actionId);
    }

    if (current.status !== 'executed') {
      throw new InvalidActionStateError(
        `Action "${actionId}" is in status "${current.status}" and cannot be undone.`,
      );
    }

    const tool = this.tools.get(current.toolName);
    if (!tool?.compensate) {
      this.db.appendAudit({
        eventType: 'ACTION_ROLLBACK_DENIED',
        actionId: current.id,
        sessionId: current.sessionId,
        actor,
        summary: `Rollback rejected for irreversible action ${current.toolName}`,
        payload: { toolName: current.toolName },
      });
      throw new IrreversibleActionError(current.toolName, current.id);
    }

    const snapshot = this.db.getSnapshot(current.id);
    try {
      const rollbackResult = await tool.compensate({
        args: current.args,
        beforeSnapshot: snapshot?.beforeSnapshot ?? null,
        executionResult: snapshot?.result ?? current.result,
      });

      const rolledBackAction = this.db.markActionRolledBack(
        current.id,
        rollbackResult,
        actor,
      );

      return {
        mode: 'compensating_rollback',
        action: rolledBackAction,
        rollbackResult,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.db.markActionRollbackFailed(current.id, message, actor);
      throw error;
    }
  }

  async executeClaimedAction(
    actionId: string,
    actor: string = 'scheduler',
  ): Promise<InterceptResult | null> {
    const claimed = this.db.claimActionForExecution(actionId);
    if (!claimed) {
      return null;
    }

    const action = this.db.getAction(actionId);
    if (!action) {
      return null;
    }

    return await this.runToolExecution(action, actor);
  }

  private async runToolExecution(
    action: ActionRecord,
    actor: string,
  ): Promise<InterceptResult> {
    const tool = this.tools.get(action.toolName);
    const customExecutor = this.customExecutors.get(action.id);
    this.customExecutors.delete(action.id);

    try {
      const beforeSnapshot = tool?.captureSnapshot
        ? await tool.captureSnapshot(action.args)
        : this.db.getSnapshot(action.id)?.beforeSnapshot;

      let executionResult: unknown;
      if (customExecutor) {
        executionResult = await customExecutor(action.args);
      } else if (tool) {
        executionResult = await tool.execute(action.args);
      } else if (this.fallbackExecutor) {
        executionResult = await this.fallbackExecutor(
          action.toolName,
          action.args,
        );
      } else {
        throw new Error(
          `No executor registered for tool "${action.toolName}".`,
        );
      }

      this.db.saveExecutionSnapshot(
        action.id,
        action.toolName,
        beforeSnapshot,
        executionResult,
      );

      const executedAction = this.db.markActionExecuted(
        action.id,
        executionResult,
        actor,
      );

      const resultPayload: InterceptResult = {
        status: 'executed',
        action: executedAction,
        result: executionResult,
      };
      this.resolveWaiters(action.id, resultPayload);
      return resultPayload;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      const failedAction = this.db.markActionFailed(action.id, message, actor);
      const resultPayload: InterceptResult = {
        status: 'failed',
        action: failedAction,
        error: message,
      };
      this.resolveWaiters(action.id, resultPayload);
      return resultPayload;
    }
  }

  private waitForCompletion(actionId: string): Promise<InterceptResult> {
    return new Promise((resolve) => {
      const list = this.waiters.get(actionId) ?? [];
      list.push(resolve);
      this.waiters.set(actionId, list);
    });
  }

  private resolveWaiters(actionId: string, result: InterceptResult): void {
    const list = this.waiters.get(actionId);
    if (!list) return;
    this.waiters.delete(actionId);
    for (const resolve of list) {
      resolve(result);
    }
  }
}
