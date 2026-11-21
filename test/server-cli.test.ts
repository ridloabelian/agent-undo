import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/main.js';
import {
  AgentUndoEngine,
  PolicyEngine,
  UndoDatabase,
  createBuiltinAdapters,
  createInspectorApp,
  loadPolicyFromFile,
  seedDemoState,
} from '../src/index.js';

describe('Web Inspector REST API & CLI Commands', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves Web Inspector HTML, health, overview, actions, approve, undo, audit, and world endpoints', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-undo-api-'));
    tempDirs.push(dir);

    const db = new UndoDatabase(path.join(dir, 'api.db'));
    const policy = new PolicyEngine(
      loadPolicyFromFile(path.resolve('policy.yaml')),
    );
    const { tools, sandboxDir } = createBuiltinAdapters(
      db,
      path.join(dir, 'sandbox'),
    );
    seedDemoState(db, sandboxDir);

    const engine = new AgentUndoEngine({
      db,
      policy,
      autoStartScheduler: false,
    });
    engine.registerTools(tools);

    const app = createInspectorApp({ engine, sandboxDir });

    try {
      const uiRes = await app.request('/');
      expect(uiRes.status).toBe(200);
      const html = await uiRes.text();
      expect(html).toContain('agent-undo Inspector');
      expect(html).toContain('Immutable Audit Log');

      const healthRes = await app.request('/api/health');
      expect(healthRes.status).toBe(200);
      const health = (await healthRes.json()) as {
        ok: boolean;
        audit: { valid: boolean };
      };
      expect(health.ok).toBe(true);
      expect(health.audit.valid).toBe(true);

      // Intercept an approval-gated $65 charge
      const interceptRes = await app.request('/api/actions/intercept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toolName: 'stripe.create_charge',
          args: {
            customerId: 'cus_web_1',
            amountCents: 6500,
            description: 'Web inspector test charge',
          },
        }),
      });
      expect(interceptRes.status).toBe(200);
      const staged = (await interceptRes.json()) as {
        status: string;
        action: { id: string };
      };
      expect(staged.status).toBe('pending_approval');

      // Approve via REST API
      const approveRes = await app.request(
        `/api/actions/${staged.action.id}/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actor: 'qa-user' }),
        },
      );
      expect(approveRes.status).toBe(200);
      const approved = (await approveRes.json()) as {
        action: { status: string };
      };
      expect(approved.action.status).toBe('executed');

      // Compensating rollback via REST API
      const undoRes = await app.request(
        `/api/actions/${staged.action.id}/undo`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actor: 'qa-user' }),
        },
      );
      expect(undoRes.status).toBe(200);
      const undone = (await undoRes.json()) as {
        mode: string;
        action: { status: string };
      };
      expect(undone.mode).toBe('compensating_rollback');
      expect(undone.action.status).toBe('rolled_back');

      // Missing ID returns 404
      const missingRes = await app.request('/api/actions/act_missing');
      expect(missingRes.status).toBe(404);

      const worldRes = await app.request('/api/world');
      const world = (await worldRes.json()) as {
        charges: Array<{ status: string }>;
        files: unknown[];
      };
      expect(world.charges.some((c) => c.status === 'refunded')).toBe(true);
      expect(world.files.length).toBeGreaterThan(0);

      const auditRes = await app.request('/api/audit');
      const audit = (await auditRes.json()) as {
        entries: unknown[];
        verification: { valid: boolean };
      };
      expect(audit.verification.valid).toBe(true);
      expect(audit.entries.length).toBeGreaterThanOrEqual(3);
    } finally {
      engine.stop();
      db.close();
    }
  });

  it('executes CLI queue, approve, undo, and audit commands against SQLite state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-undo-cli-'));
    tempDirs.push(dir);

    const dbPath = path.join(dir, 'cli.db');
    const sandboxDir = path.join(dir, 'sandbox');
    const policyPath = path.resolve('policy.yaml');

    const db = new UndoDatabase(dbPath);
    const policy = new PolicyEngine(loadPolicyFromFile(policyPath));
    const { tools } = createBuiltinAdapters(db, sandboxDir);
    seedDemoState(db, sandboxDir);
    const engine = new AgentUndoEngine({
      db,
      policy,
      autoStartScheduler: false,
    });
    engine.registerTools(tools);

    const emailStage = await engine.intercept({
      toolName: 'gmail.send_email',
      args: {
        to: 'cli-test@example.com',
        subject: 'CLI Grace Test',
        body: 'Cancel me via CLI',
      },
    });
    const chargePending = await engine.intercept({
      toolName: 'stripe.create_charge',
      args: {
        customerId: 'cus_cli',
        amountCents: 6000,
        description: 'CLI Approval Test',
      },
    });
    engine.stop();
    db.close();

    const capturedLogs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      capturedLogs.push(args.map(String).join(' '));
    };

    try {
      const queueCode = await runCli([
        'queue',
        '--db',
        dbPath,
        '--sandbox',
        sandboxDir,
        '--policy',
        policyPath,
        '--json',
      ]);
      expect(queueCode).toBe(0);
      const queueOutput = JSON.parse(capturedLogs.pop()!) as {
        actions: Array<{ id: string }>;
      };
      expect(queueOutput.actions.map((a) => a.id)).toContain(emailStage.action.id);
      expect(queueOutput.actions.map((a) => a.id)).toContain(
        chargePending.action.id,
      );

      const undoCode = await runCli([
        'undo',
        emailStage.action.id,
        '--db',
        dbPath,
        '--sandbox',
        sandboxDir,
        '--policy',
        policyPath,
      ]);
      expect(undoCode).toBe(0);

      const approveCode = await runCli([
        'approve',
        chargePending.action.id,
        '--db',
        dbPath,
        '--sandbox',
        sandboxDir,
        '--policy',
        policyPath,
      ]);
      expect(approveCode).toBe(0);

      const auditCode = await runCli([
        'audit',
        '--db',
        dbPath,
        '--verify',
        '--json',
      ]);
      expect(auditCode).toBe(0);
      const auditOutput = JSON.parse(capturedLogs.pop()!) as {
        verification: { valid: boolean; totalEntries: number };
      };
      expect(auditOutput.verification.valid).toBe(true);
      expect(auditOutput.verification.totalEntries).toBeGreaterThanOrEqual(4);
    } finally {
      console.log = origLog;
    }
  });
});
