import type { AgentUndoEngine } from '../core/firewall.js';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface UpstreamMcpClient {
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close?: () => Promise<void> | void;
}

export interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpFirewallRouterOptions {
  engine: AgentUndoEngine;
  upstream?: UpstreamMcpClient;
  defaultSessionId?: string;
  graceResponseMode?: 'receipt' | 'wait';
}

const META_TOOLS: McpToolInfo[] = [
  {
    name: 'agent_undo_undo',
    description:
      'Cancel a staged grace-window action before execution, or trigger compensating rollback for a reversible executed action.',
    inputSchema: {
      type: 'object',
      properties: {
        actionId: {
          type: 'string',
          description: 'Action ID returned by an intercepted tool call.',
        },
      },
      required: ['actionId'],
    },
  },
  {
    name: 'agent_undo_status',
    description:
      'Inspect pending grace-window/approval actions and remaining session & daily budgets.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Optional session ID to query.',
        },
      },
    },
  },
];

function makeError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, data },
  };
}

function makeToolResult(payload: unknown, isError = false) {
  return {
    content: [
      {
        type: 'text',
        text:
          typeof payload === 'string'
            ? payload
            : JSON.stringify(payload, null, 2),
      },
    ],
    isError,
  };
}

/**
 * Protocol-agnostic MCP JSON-RPC 2.0 router sitting in front of local tools
 * and/or an upstream MCP server.
 */
export class McpFirewallRouter {
  private readonly engine: AgentUndoEngine;
  private readonly upstream?: UpstreamMcpClient;
  private readonly defaultSessionId: string;
  private readonly graceResponseMode: 'receipt' | 'wait';

  constructor(options: McpFirewallRouterOptions) {
    this.engine = options.engine;
    this.upstream = options.upstream;
    this.defaultSessionId = options.defaultSessionId ?? 'mcp-default';
    this.graceResponseMode = options.graceResponseMode ?? 'receipt';
  }

  async handleMessage(
    rawMessage: unknown,
    context?: { sessionId?: string; agentId?: string },
  ): Promise<JsonRpcResponse | null> {
    if (!rawMessage || typeof rawMessage !== 'object') {
      return makeError(null, -32600, 'Invalid JSON-RPC request object.');
    }

    const req = rawMessage as Partial<JsonRpcRequest>;
    const hasId = req.id !== undefined;
    const id = req.id ?? null;

    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return hasId
        ? makeError(id, -32600, 'Invalid JSON-RPC 2.0 envelope.')
        : null;
    }

    // Notifications carry no id and expect no JSON-RPC response.
    if (!hasId || req.method.startsWith('notifications/')) {
      return null;
    }

    try {
      switch (req.method) {
        case 'initialize': {
          const params = req.params ?? {};
          const protocolVersion =
            typeof params.protocolVersion === 'string'
              ? params.protocolVersion
              : '2024-11-05';
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion,
              capabilities: {
                tools: {},
              },
              serverInfo: {
                name: 'agent-undo',
                version: '0.1.0',
              },
            },
          };
        }

        case 'ping': {
          return { jsonrpc: '2.0', id, result: {} };
        }

        case 'tools/list': {
          const tools = await this.collectTools();
          return {
            jsonrpc: '2.0',
            id,
            result: { tools },
          };
        }

        case 'tools/call': {
          const params = req.params ?? {};
          const name = params.name;
          if (typeof name !== 'string' || !name) {
            return makeError(id, -32602, 'tools/call requires a tool "name".');
          }
          const rawArgs = params.arguments;
          const args =
            rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
              ? (rawArgs as Record<string, unknown>)
              : {};

          const sessionId = context?.sessionId ?? this.defaultSessionId;
          const agentId = context?.agentId ?? 'mcp-agent';

          const callResult = await this.handleToolCall(name, args, {
            sessionId,
            agentId,
          });
          return {
            jsonrpc: '2.0',
            id,
            result: callResult,
          };
        }

        default:
          return makeError(id, -32601, `Method not found: ${req.method}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return makeError(id, -32603, message);
    }
  }

  private async collectTools(): Promise<McpToolInfo[]> {
    const byName = new Map<string, McpToolInfo>();

    for (const local of this.engine.listTools()) {
      byName.set(local.name, {
        name: local.name,
        description: local.description,
        inputSchema: local.inputSchema ?? { type: 'object', properties: {} },
      });
    }

    if (this.upstream) {
      const upstreamTools = await this.upstream.listTools();
      for (const tool of upstreamTools) {
        if (!byName.has(tool.name)) {
          byName.set(tool.name, {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
          });
        }
      }
    }

    for (const meta of META_TOOLS) {
      byName.set(meta.name, meta);
    }

    return Array.from(byName.values());
  }

  private async handleToolCall(
    name: string,
    args: Record<string, unknown>,
    ctx: { sessionId: string; agentId: string },
  ) {
    if (name === 'agent_undo_undo') {
      const actionId = args.actionId;
      if (typeof actionId !== 'string' || !actionId) {
        return makeToolResult(
          { error: 'actionId string argument is required.' },
          true,
        );
      }
      try {
        const undoRes = await this.engine.undo(actionId, ctx.agentId);
        return makeToolResult({
          status: undoRes.action.status,
          mode: undoRes.mode,
          actionId: undoRes.action.id,
          toolName: undoRes.action.toolName,
          rollbackResult:
            undoRes.mode === 'compensating_rollback'
              ? undoRes.rollbackResult
              : undefined,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return makeToolResult({ error: msg }, true);
      }
    }

    if (name === 'agent_undo_status') {
      const sid =
        typeof args.sessionId === 'string' && args.sessionId
          ? args.sessionId
          : ctx.sessionId;
      const pending = this.engine.db.listActions({
        status: ['grace_pending', 'pending_approval'],
        sessionId: sid,
      });
      const budget = this.engine.db.getBudgetMeter(
        sid,
        this.engine.policy.getBudgetLimits(),
      );
      return makeToolResult({
        sessionId: sid,
        budget,
        pendingActions: pending.map((a) => ({
          id: a.id,
          toolName: a.toolName,
          status: a.status,
          executeAt: a.executeAt,
          spendUsd: a.spendUsd,
          diffSummary: a.diffSummary,
        })),
      });
    }

    const isRegisteredLocally = Boolean(this.engine.getTool(name));
    const customExecutor =
      !isRegisteredLocally && this.upstream
        ? async (toolArgs: Record<string, unknown>) =>
            this.upstream!.callTool(name, toolArgs)
        : undefined;

    // Preview whether policy puts this call in a grace window so `wait` mode
    // awaits grace expiry without blocking indefinitely on `require_approval`.
    let shouldAwaitCompletion = false;
    if (this.graceResponseMode === 'wait') {
      const usage = this.engine.db.getUsage(ctx.sessionId);
      const previewEval = this.engine.policy.evaluate({
        toolName: name,
        args,
        adapterReadOnly: this.engine.getTool(name)?.readOnly,
        currentUsage: usage,
      });
      shouldAwaitCompletion = previewEval.decision === 'grace_window';
    }

    const intercepted = await this.engine.intercept({
      toolName: name,
      args,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      actor: ctx.agentId,
      awaitCompletion: shouldAwaitCompletion,
      customExecutor,
    });

    if (intercepted.status === 'executed') {
      return makeToolResult({
        actionId: intercepted.action.id,
        status: 'executed',
        reversible: intercepted.action.reversible,
        result: intercepted.result,
      });
    }

    if (intercepted.status === 'staged') {
      return makeToolResult({
        actionId: intercepted.action.id,
        status: 'grace_pending',
        graceSeconds: intercepted.action.graceSeconds,
        executeAt: intercepted.action.executeAt,
        undoTool: 'agent_undo_undo',
        diff: intercepted.action.diff,
        message: `Staged in ${intercepted.action.graceSeconds}s grace window. Call agent_undo_undo with actionId "${intercepted.action.id}" before ${intercepted.action.executeAt} to cancel.`,
      });
    }

    if (intercepted.status === 'pending_approval') {
      return makeToolResult({
        actionId: intercepted.action.id,
        status: 'pending_approval',
        reason: intercepted.action.reason,
        diff: intercepted.action.diff,
        message: `Blocked pending human approval. Approve via CLI ("agent-undo approve ${intercepted.action.id}") or Web Inspector.`,
      });
    }

    if (intercepted.status === 'undone') {
      return makeToolResult({
        actionId: intercepted.action.id,
        status: 'undone',
        message: `Action "${intercepted.action.id}" was undone before execution.`,
      });
    }

    if (intercepted.status === 'denied') {
      return makeToolResult(
        {
          actionId: intercepted.action.id,
          status: 'denied',
          denyCode: intercepted.action.denyCode,
          reason: intercepted.action.reason,
        },
        true,
      );
    }

    return makeToolResult(
      {
        actionId: intercepted.action.id,
        status: 'failed',
        error: intercepted.error,
      },
      true,
    );
  }
}
