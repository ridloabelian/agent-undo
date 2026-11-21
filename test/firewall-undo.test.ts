import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentUndoEngine,
  IrreversibleActionError,
  PolicyEngine,
  UndoDatabase,
  createBuiltinAdapters,
  createFirewall,
  parsePolicy,
  seedDemoState,
  wrapTool,
} from '../src/index.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Firewall Interception, Grace Windows, Rollbacks & Audit Chain', () => {
  const tempDirs: string[] = [];

  function setupTestEnv(graceSeconds = 0.12) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-undo-test-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'state.db');
    const sandboxDir = path.join(dir, 'sandbox');

    const policy = new PolicyEngine(
      parsePolicy(`
version: "0.1"
defaultDecision: require_approval
defaultGraceSeconds: ${graceSeconds}
budgets:
  session:
    maxSpendUsd: 80
    maxMutations: 10
  daily:
    maxSpendUsd: 200
    maxMutations: 25
rules:
  - id: deny-env
    match:
      tool: "fs.*"
      args:
        path:
          regex: "(^|/)\\\\.env$"
    decision: deny
  - id: allow-read
    match:
      tool: ["*.list_*", "*.read_*"]
    decision: allow
    readOnly: true
  - id: stripe-approval
    match:
      tool: "stripe.create_charge"
      args:
        amountCents:
          gte: 5000
    decision: require_approval
    spendExtractor:
      arg: amountCents
      scale: 0.01
  - id: stripe-grace
    match:
      tool: "stripe.create_charge"
    decision: grace_window
    graceSeconds: ${graceSeconds}
    spendExtractor:
      arg: amountCents
      scale: 0.01
  - id: grace-mutations
    match:
      tool:
        - "gmail.send_email"
        - "gmail.delete_email"
        - "calendar.create_event"
        - "calendar.cancel_event"
        - "fs.write_file"
    decision: grace_window
    graceSeconds: ${graceSeconds}
  - id: approval-fs-delete
    match:
      tool: "fs.delete_file"
    decision: require_approval
`),
    );

    const db = new UndoDatabase(dbPath);
    const { tools } = createBuiltinAdapters(db, sandboxDir);
    seedDemoState(db, sandboxDir);

    const engine = new AgentUndoEngine({
      db,
      policy,
      schedulerPollMs: 40,
    });
    engine.registerTools(tools);

    return { dir, db, sandboxDir, engine };
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('soft-cancels grace-window actions before execution and releases reserved budget', async () => {
    const { db, engine } = setupTestEnv(1.5);
    try {
      const staged = await engine.intercept({
        toolName: 'stripe.create_charge',
        args: {
          customerId: 'cus_1',
          amountCents: 4500,
          description: 'Charge $45',
        },
        sessionId: 'sess-soft',
      });
      expect(staged.status).toBe('staged');
      expect(db.listMockCharges()).toHaveLength(1); // Only seed charge

      // While staged, $45 is reserved so another $45 charge hits $80 session cap.
      const blocked = await engine.intercept({
        toolName: 'stripe.create_charge',
        args: {
          customerId: 'cus_1',
          amountCents: 4500,
          description: 'Burst second $45',
        },
        sessionId: 'sess-soft',
      });
      expect(blocked.status).toBe('denied');
      expect(blocked.action.denyCode).toBe('SESSION_SPEND_CAP_EXCEEDED');

      const undone = await engine.undo(staged.action.id, 'operator');
      expect(undone.mode).toBe('soft_cancel');
      expect(undone.action.status).toBe('undone');
      expect(db.listMockCharges()).toHaveLength(1); // Never charged

      // Budget is freed after soft-undo.
      const allowedNow = await engine.intercept({
        toolName: 'stripe.create_charge',
        args: {
          customerId: 'cus_1',
          amountCents: 4500,
          description: 'Allowed after undo',
        },
        sessionId: 'sess-soft',
      });
      expect(allowedNow.status).toBe('staged');
      await engine.undo(allowedNow.action.id, 'operator');
    } finally {
      engine.stop();
      db.close();
    }
  });

  it('auto-executes after grace window expires and performs snapshot compensating rollbacks', async () => {
    const { db, sandboxDir, engine } = setupTestEnv(0.08);
    try {
      const roadmapPath = path.join(sandboxDir, 'notes/roadmap.md');
      const originalRoadmap = fs.readFileSync(roadmapPath, 'utf8');

      // 1) Overwrite existing file -> expire -> rollback restores exact original bytes
      const writeExisting = await engine.intercept({
        toolName: 'fs.write_file',
        args: {
          path: 'notes/roadmap.md',
          content: '# Replaced\nLine 2\n',
        },
        sessionId: 'sess-comp',
      });
      expect(writeExisting.status).toBe('staged');
      expect(writeExisting.action.diff.unifiedDiff).toContain('-# Q4 Agent Safety Roadmap');
      expect(writeExisting.action.diff.unifiedDiff).toContain('+# Replaced');

      // 2) Create brand new file -> expire -> rollback deletes created file
      const writeNew = await engine.intercept({
        toolName: 'fs.write_file',
        args: {
          path: 'tmp/created.txt',
          content: 'brand new file',
        },
        sessionId: 'sess-comp',
      });
      expect(writeNew.status).toBe('staged');

      // 3) Stripe charge -> expire -> rollback issues refund and frees spend
      const charge = await engine.intercept({
        toolName: 'stripe.create_charge',
        args: {
          customerId: 'cus_2',
          amountCents: 3000,
          description: 'Refundable charge',
        },
        sessionId: 'sess-comp',
      });
      expect(charge.status).toBe('staged');

      // 4) Calendar create + cancel -> expire -> rollback reverts both
      const calCreate = await engine.intercept({
        toolName: 'calendar.create_event',
        args: {
          title: 'Temp Meeting',
          startIso: '2026-12-01T10:00:00Z',
          endIso: '2026-12-01T10:30:00Z',
        },
        sessionId: 'sess-comp',
      });
      const calCancel = await engine.intercept({
        toolName: 'calendar.cancel_event',
        args: { eventId: 'evt_launch_001', reason: 'Moved' },
        sessionId: 'sess-comp',
      });

      // 5) Gmail trash -> expire -> rollback restores email back to inbox
      const gmailDel = await engine.intercept({
        toolName: 'gmail.delete_email',
        args: { messageId: 'msg_inbox_001', permanent: false },
        sessionId: 'sess-comp',
      });

      await sleep(220);
      await engine.flushDueGraceActions();

      expect(fs.readFileSync(roadmapPath, 'utf8')).toBe('# Replaced\nLine 2\n');
      expect(fs.existsSync(path.join(sandboxDir, 'tmp/created.txt'))).toBe(true);
      expect(db.getMockEvent('evt_launch_001')?.status).toBe('canceled');
      expect(db.getMockEmail('msg_inbox_001')?.folder).toBe('trash');

      const r1 = await engine.undo(writeExisting.action.id, 'tester');
      expect(r1.mode).toBe('compensating_rollback');
      expect(fs.readFileSync(roadmapPath, 'utf8')).toBe(originalRoadmap);

      const r2 = await engine.undo(writeNew.action.id, 'tester');
      expect(r2.mode).toBe('compensating_rollback');
      expect(fs.existsSync(path.join(sandboxDir, 'tmp/created.txt'))).toBe(false);

      const r3 = await engine.undo(charge.action.id, 'tester');
      expect(r3.mode).toBe('compensating_rollback');
      const chargedId = (db.getAction(charge.action.id)?.result as { id: string }).id;
      expect(db.getMockCharge(chargedId)?.status).toBe('refunded');
      expect(db.getUsage('sess-comp').sessionSpendUsd).toBe(0);

      await engine.undo(calCreate.action.id, 'tester');
      const createdEvtId = (db.getAction(calCreate.action.id)?.result as { id: string }).id;
      expect(db.getMockEvent(createdEvtId)).toBeNull();

      await engine.undo(calCancel.action.id, 'tester');
      expect(db.getMockEvent('evt_launch_001')?.status).toBe('confirmed');

      await engine.undo(gmailDel.action.id, 'tester');
      expect(db.getMockEmail('msg_inbox_001')?.folder).toBe('inbox');
    } finally {
      engine.stop();
      db.close();
    }
  });

  it('rejects post-execution undo on irreversible actions and supports approval + file delete rollback', async () => {
    const { db, sandboxDir, engine } = setupTestEnv(0.06);
    try {
      const email = await engine.intercept({
        toolName: 'gmail.send_email',
        args: {
          to: 'user@example.com',
          subject: 'Sent Notice',
          body: 'Already delivered.',
        },
        awaitCompletion: true,
      });
      expect(email.status).toBe('executed');

      await expect(engine.undo(email.action.id, 'tester')).rejects.toThrow(
        IrreversibleActionError,
      );

      // File delete requires approval, then executes, then rolls back cleanly.
      const readmePath = path.join(sandboxDir, 'README.txt');
      const originalReadme = fs.readFileSync(readmePath, 'utf8');

      const pendingDel = await engine.intercept({
        toolName: 'fs.delete_file',
        args: { path: 'README.txt' },
      });
      expect(pendingDel.status).toBe('pending_approval');
      expect(fs.existsSync(readmePath)).toBe(true);

      const approvedDel = await engine.approve(pendingDel.action.id, 'reviewer');
      expect(approvedDel.status).toBe('executed');
      expect(fs.existsSync(readmePath)).toBe(false);

      await engine.undo(pendingDel.action.id, 'reviewer');
      expect(fs.existsSync(readmePath)).toBe(true);
      expect(fs.readFileSync(readmePath, 'utf8')).toBe(originalReadme);
    } finally {
      engine.stop();
      db.close();
    }
  });

  it('enforces immutable append-only audit logs and validates SHA-256 hash chaining', async () => {
    const { db, engine } = setupTestEnv(0.2);
    try {
      await engine.intercept({
        toolName: 'fs.write_file',
        args: { path: '.env', content: 'KEY=1' },
      });
      await engine.intercept({
        toolName: 'gmail.list_messages',
        args: { folder: 'inbox' },
      });

      const verification = db.verifyAuditChain();
      expect(verification.valid).toBe(true);
      expect(verification.totalEntries).toBeGreaterThanOrEqual(2);

      // SQLite triggers must forbid UPDATE and DELETE on audit_logs.
      expect(() =>
        db.db
          .prepare("UPDATE audit_logs SET summary = 'tampered' WHERE seq = 1")
          .run(),
      ).toThrow(/immutable/i);

      expect(() =>
        db.db.prepare('DELETE FROM audit_logs WHERE seq = 1').run(),
      ).toThrow(/immutable/i);
    } finally {
      engine.stop();
      db.close();
    }
  });

  it('provides ergonomic TypeScript SDK middleware via createFirewall and wrapTool', async () => {
    const { db, engine } = createFirewall({
      dbPath: ':memory:',
      policyConfig: parsePolicy(`
version: "0.1"
defaultDecision: grace_window
defaultGraceSeconds: 0.05
rules: []
`),
      schedulerPollMs: 30,
    });

    try {
      const sideEffects: string[] = [];
      const guardedAction = wrapTool(
        engine,
        {
          name: 'webhook.post',
          description: 'Send webhook notification',
          execute: (args: { target: string }) => {
            sideEffects.push(args.target);
            return { sent: true, target: args.target };
          },
          compensate: ({ args }) => {
            sideEffects.push(`compensate:${args.target}`);
            return { reverted: true };
          },
        },
        { sessionId: 'sdk-sess', agentId: 'sdk-agent' },
      );

      const staged = await guardedAction({ target: 'https://hooks.local/1' });
      expect(staged.status).toBe('staged');
      expect(sideEffects).toEqual([]);

      await sleep(120);
      await engine.flushDueGraceActions();
      expect(sideEffects).toEqual(['https://hooks.local/1']);

      await engine.undo(staged.action.id, 'sdk-caller');
      expect(sideEffects).toEqual([
        'https://hooks.local/1',
        'compensate:https://hooks.local/1',
      ]);
    } finally {
      engine.stop();
      db.close();
    }
  });
});
