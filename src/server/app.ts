import { Hono } from 'hono';
import { listSandboxFiles } from '../adapters/index.js';
import {
  ActionNotFoundError,
  InvalidActionStateError,
  IrreversibleActionError,
  type AgentUndoEngine,
} from '../core/firewall.js';
import { handleMcpHttpRequest } from '../mcp/http.js';
import { McpFirewallRouter } from '../mcp/router.js';
import type { ActionStatus } from '../types.js';
import { renderInspectorHtml } from './ui.js';

export interface CreateInspectorAppOptions {
  engine: AgentUndoEngine;
  sandboxDir?: string;
  mcpRouter?: McpFirewallRouter;
}

const VALID_STATUSES: ReadonlySet<string> = new Set<ActionStatus>([
  'executed',
  'grace_pending',
  'pending_approval',
  'approved',
  'executing',
  'undone',
  'rolled_back',
  'denied',
  'failed',
  'rollback_failed',
]);

export function createInspectorApp(options: CreateInspectorAppOptions): Hono {
  const app = new Hono();
  const { engine, sandboxDir } = options;
  const mcpRouter =
    options.mcpRouter ?? new McpFirewallRouter({ engine });

  app.get('/', (c) => c.html(renderInspectorHtml()));

  app.get('/api/health', (c) => {
    return c.json({
      ok: true,
      version: '0.1.0',
      audit: engine.db.verifyAuditChain(),
    });
  });

  app.get('/api/overview', (c) => {
    const sessionId = c.req.query('sessionId') || 'default';
    const policyConfig = engine.policy.getConfig();
    return c.json({
      queueCounts: engine.db.getQueueCounts(),
      budget: engine.db.getBudgetMeter(
        sessionId,
        engine.policy.getBudgetLimits(),
      ),
      auditVerification: engine.db.verifyAuditChain(),
      policySummary: {
        version: policyConfig.version,
        defaultDecision: policyConfig.defaultDecision,
        defaultGraceSeconds: policyConfig.defaultGraceSeconds,
        ruleCount: policyConfig.rules.length,
      },
    });
  });

  app.get('/api/actions', (c) => {
    const rawStatus = c.req.query('status');
    const sessionId = c.req.query('sessionId') || undefined;
    const limitParam = Number(c.req.query('limit') ?? 100);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 100;

    let statuses: ActionStatus[] | undefined;
    if (rawStatus) {
      const parsed = rawStatus
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is ActionStatus => VALID_STATUSES.has(s));
      if (parsed.length > 0) {
        statuses = parsed;
      }
    }

    const nowMs = Date.now();
    const actions = engine.db
      .listActions({ status: statuses, sessionId, limit })
      .map((action) => ({
        ...action,
        remainingMs:
          action.status === 'grace_pending' && action.executeAtMs !== null
            ? Math.max(0, action.executeAtMs - nowMs)
            : null,
      }));

    return c.json({ actions });
  });

  app.get('/api/actions/:id', (c) => {
    const id = c.req.param('id');
    const action = engine.db.getAction(id);
    if (!action) {
      return c.json({ error: `Action "${id}" not found.` }, 404);
    }
    const snapshot = engine.db.getSnapshot(id);
    return c.json({ action, snapshot });
  });

  app.post('/api/actions/intercept', async (c) => {
    let body: {
      toolName?: unknown;
      args?: unknown;
      sessionId?: unknown;
      agentId?: unknown;
      actor?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    if (typeof body.toolName !== 'string' || !body.toolName) {
      return c.json({ error: '"toolName" is required.' }, 400);
    }

    const args =
      body.args && typeof body.args === 'object' && !Array.isArray(body.args)
        ? (body.args as Record<string, unknown>)
        : {};

    const result = await engine.intercept({
      toolName: body.toolName,
      args,
      sessionId:
        typeof body.sessionId === 'string' ? body.sessionId : 'default',
      agentId: typeof body.agentId === 'string' ? body.agentId : 'api-client',
      actor: typeof body.actor === 'string' ? body.actor : 'api-client',
    });

    return c.json(result);
  });

  app.post('/api/actions/:id/undo', async (c) => {
    const id = c.req.param('id');
    let actor = 'web-inspector';
    try {
      const body = (await c.req.json()) as { actor?: unknown };
      if (typeof body.actor === 'string' && body.actor) {
        actor = body.actor;
      }
    } catch {
      // Empty body is valid
    }

    try {
      const res = await engine.undo(id, actor);
      return c.json(res);
    } catch (error) {
      if (error instanceof ActionNotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      if (
        error instanceof InvalidActionStateError ||
        error instanceof IrreversibleActionError
      ) {
        return c.json({ error: error.message }, 409);
      }
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 500);
    }
  });

  app.post('/api/actions/:id/approve', async (c) => {
    const id = c.req.param('id');
    let actor = 'web-inspector';
    try {
      const body = (await c.req.json()) as { actor?: unknown };
      if (typeof body.actor === 'string' && body.actor) {
        actor = body.actor;
      }
    } catch {
      // Empty body is valid
    }

    try {
      const action = await engine.approve(id, actor);
      return c.json({ action });
    } catch (error) {
      if (error instanceof ActionNotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof InvalidActionStateError) {
        return c.json({ error: error.message }, 409);
      }
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 500);
    }
  });

  app.get('/api/audit', (c) => {
    const limitParam = Number(c.req.query('limit') ?? 50);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50;
    return c.json({
      entries: engine.db.listAuditLogs(limit),
      verification: engine.db.verifyAuditChain(),
    });
  });

  app.get('/api/world', (c) => {
    return c.json({
      emails: engine.db.listMockEmails(),
      events: engine.db.listMockEvents(),
      charges: engine.db.listMockCharges(),
      files: sandboxDir ? listSandboxFiles(sandboxDir) : [],
    });
  });

  app.post('/mcp', async (c) => handleMcpHttpRequest(c, mcpRouter));

  return app;
}
