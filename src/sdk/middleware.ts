import { AgentUndoEngine } from '../core/firewall.js';
import { PolicyEngine } from '../policy/engine.js';
import {
  DEFAULT_POLICY_CONFIG,
  loadPolicyFromFile,
} from '../policy/schema.js';
import { UndoDatabase } from '../storage/database.js';
import type {
  InterceptResult,
  PolicyConfig,
  ToolDefinition,
} from '../types.js';

export interface CreateFirewallOptions {
  dbPath?: string;
  policyPath?: string;
  policyConfig?: PolicyConfig;
  schedulerPollMs?: number;
  autoStartScheduler?: boolean;
  fallbackExecutor?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

/**
 * Convenience factory creating a wired UndoDatabase, PolicyEngine, and AgentUndoEngine.
 */
export function createFirewall(options: CreateFirewallOptions = {}): {
  db: UndoDatabase;
  policy: PolicyEngine;
  engine: AgentUndoEngine;
} {
  const db = new UndoDatabase(options.dbPath ?? '.agent-undo/state.db');
  const config =
    options.policyConfig ??
    (options.policyPath
      ? loadPolicyFromFile(options.policyPath)
      : DEFAULT_POLICY_CONFIG);
  const policy = new PolicyEngine(config);
  const engine = new AgentUndoEngine({
    db,
    policy,
    fallbackExecutor: options.fallbackExecutor,
    schedulerPollMs: options.schedulerPollMs,
    autoStartScheduler: options.autoStartScheduler,
  });

  return { db, policy, engine };
}

export interface WrapToolContext {
  sessionId?: string;
  agentId?: string;
  actor?: string;
  awaitCompletion?: boolean;
}

export type WrappedToolFn<TArgs extends Record<string, unknown>> = (
  args: TArgs,
  contextOverride?: WrapToolContext,
) => Promise<InterceptResult>;

/**
 * Registers a typed tool with the firewall and returns a guarded middleware wrapper.
 */
export function wrapTool<TArgs extends Record<string, unknown>, TResult>(
  engine: AgentUndoEngine,
  tool: ToolDefinition<TArgs, TResult>,
  defaultContext: WrapToolContext = {},
): WrappedToolFn<TArgs> {
  engine.registerTool(tool);

  return async (args: TArgs, contextOverride: WrapToolContext = {}) => {
    return engine.intercept({
      toolName: tool.name,
      args,
      sessionId: contextOverride.sessionId ?? defaultContext.sessionId,
      agentId: contextOverride.agentId ?? defaultContext.agentId,
      actor: contextOverride.actor ?? defaultContext.actor,
      awaitCompletion:
        contextOverride.awaitCompletion ?? defaultContext.awaitCompletion,
    });
  };
}

/**
 * Wraps a dictionary of ToolDefinitions into guarded middleware callables.
 */
export function wrapToolMap<
  TMap extends Record<string, ToolDefinition<Record<string, unknown>, unknown>>,
>(
  engine: AgentUndoEngine,
  toolMap: TMap,
  defaultContext: WrapToolContext = {},
): { [K in keyof TMap]: WrappedToolFn<Record<string, unknown>> } {
  const wrapped = {} as {
    [K in keyof TMap]: WrappedToolFn<Record<string, unknown>>;
  };

  for (const [key, tool] of Object.entries(toolMap)) {
    wrapped[key as keyof TMap] = wrapTool(engine, tool, defaultContext);
  }

  return wrapped;
}
