import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AgentUndoEngine,
  McpFirewallRouter,
  PolicyEngine,
  UndoDatabase,
  createBuiltinAdapters,
  loadPolicyFromFile,
  seedDemoState,
} from '../src/index.js';

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const demoDir = path.resolve('.agent-undo/demo');
  const dbPath = path.join(demoDir, 'demo.db');
  const sandboxDir = path.join(demoDir, 'sandbox');

  fs.rmSync(demoDir, { recursive: true, force: true });
  fs.mkdirSync(demoDir, { recursive: true });

  const basePolicy = loadPolicyFromFile(path.resolve('policy.yaml'));
  // Accelerate grace windows to 0.25s for interactive CLI demo speed while preserving all rules and caps.
  const demoPolicyConfig = {
    ...basePolicy,
    defaultGraceSeconds: 0.25,
    rules: basePolicy.rules.map((rule) =>
      rule.decision === 'grace_window' ? { ...rule, graceSeconds: 0.25 } : rule,
    ),
  };

  const db = new UndoDatabase(dbPath);
  const policy = new PolicyEngine(demoPolicyConfig);
  const { tools } = createBuiltinAdapters(db, sandboxDir);
  seedDemoState(db, sandboxDir);

  const engine = new AgentUndoEngine({
    db,
    policy,
    schedulerPollMs: 50,
  });
  engine.registerTools(tools);

  const sessionId = 'demo-session';

  try {
    section('1. Read-Only Allow (Immediate Execution, Zero Mutation Cost)');
    const inboxRes = await engine.intercept({
      toolName: 'gmail.list_messages',
      args: { folder: 'inbox' },
      sessionId,
      agentId: 'demo-agent',
    });
    assert.equal(inboxRes.status, 'executed');
    console.log(
      `gmail.list_messages -> status=${inboxRes.status}, inboxCount=${(inboxRes.result as unknown[]).length}`,
    );

    const roadmapBefore = await engine.intercept({
      toolName: 'fs.read_file',
      args: { path: 'notes/roadmap.md' },
      sessionId,
      agentId: 'demo-agent',
    });
    assert.equal(roadmapBefore.status, 'executed');
    const originalRoadmap = (
      roadmapBefore.result as { content: string }
    ).content;
    console.log(
      `fs.read_file(notes/roadmap.md) -> ${originalRoadmap.split('\n')[0]}`,
    );

    section('2. Soft-Undo During Grace Window (Cancel Outbound Email Before Delivery)');
    const sendStage = await engine.intercept({
      toolName: 'gmail.send_email',
      args: {
        to: 'all-customers@example.com',
        subject: 'Premature Pricing Announcement',
        body: 'Oops — this draft should be canceled before the grace timer fires.',
      },
      sessionId,
      agentId: 'demo-agent',
    });
    assert.equal(sendStage.status, 'staged');
    console.log(
      `Staged ${sendStage.action.id} (${sendStage.action.toolName}) -> status=${sendStage.action.status}`,
    );
    console.log('Dry-Run Diff:\n' + sendStage.action.diff.unifiedDiff);

    const softUndo = await engine.undo(sendStage.action.id, 'human-reviewer');
    assert.equal(softUndo.mode, 'soft_cancel');
    assert.equal(db.listMockEmails('sent').length, 0);
    console.log(
      `Undid ${softUndo.action.id} (${softUndo.mode}) -> sentEmails=${db.listMockEmails('sent').length}`,
    );

    section('3. Grace Execution + Snapshot Compensating Rollback (File + Stripe)');
    const fileStage = await engine.intercept({
      toolName: 'fs.write_file',
      args: {
        path: 'notes/roadmap.md',
        content: '# Corrupted Roadmap\n\nAgent accidentally overwrote this file.\n',
      },
      sessionId,
      agentId: 'demo-agent',
    });
    assert.equal(fileStage.status, 'staged');
    console.log('Proposed File Diff:\n' + fileStage.action.diff.unifiedDiff);

    const charge25Stage = await engine.intercept({
      toolName: 'stripe.create_charge',
      args: {
        customerId: 'cus_acme_01',
        amountCents: 2500,
        currency: 'usd',
        description: 'Demo micro-charge ($25)',
      },
      sessionId,
      agentId: 'demo-agent',
    });
    assert.equal(charge25Stage.status, 'staged');

    await sleep(400);
    await engine.flushDueGraceActions();

    const executedFile = db.getAction(fileStage.action.id);
    const executedCharge = db.getAction(charge25Stage.action.id);
    assert.equal(executedFile?.status, 'executed');
    assert.equal(executedCharge?.status, 'executed');
    console.log(
      `Grace expired -> roadmap.md updated & charge ${(executedCharge.result as { id: string }).id} succeeded`,
    );

    const fileRollback = await engine.undo(fileStage.action.id, 'human-reviewer');
    assert.equal(fileRollback.mode, 'compensating_rollback');
    const restoredContent = fs.readFileSync(
      path.join(sandboxDir, 'notes/roadmap.md'),
      'utf8',
    );
    assert.equal(restoredContent, originalRoadmap);
    console.log('Compensated fs.write_file -> notes/roadmap.md restored byte-for-byte.');

    const stripeRollback = await engine.undo(
      charge25Stage.action.id,
      'human-reviewer',
    );
    assert.equal(stripeRollback.mode, 'compensating_rollback');
    console.log(
      `Compensated stripe.create_charge -> refund=${JSON.stringify(stripeRollback.rollbackResult)}`,
    );

    section('4. Require Approval Gate ($60 Stripe Charge)');
    const charge60Pending = await engine.intercept({
      toolName: 'stripe.create_charge',
      args: {
        customerId: 'cus_acme_01',
        amountCents: 6000,
        currency: 'usd',
        description: 'Approved compute cluster add-on ($60)',
      },
      sessionId,
      agentId: 'demo-agent',
    });
    assert.equal(charge60Pending.status, 'pending_approval');
    console.log(
      `Blocked ${charge60Pending.action.id} -> status=${charge60Pending.action.status}`,
    );

    const approved60 = await engine.approve(
      charge60Pending.action.id,
      'finance-lead',
    );
    assert.equal(approved60.status, 'executed');
    console.log(
      `Approved ${approved60.id} -> status=${approved60.status}, spend=$${approved60.spendUsd.toFixed(2)}`,
    );

    section('5. Policy Rule Deny (.env) & Session Spend Cap Blocking ($60 + $50 > $100)');
    const envDeny = await engine.intercept({
      toolName: 'fs.write_file',
      args: {
        path: '.env',
        content: 'SECRET=oops',
      },
      sessionId,
      agentId: 'demo-agent',
    });
    assert.equal(envDeny.status, 'denied');
    assert.equal(envDeny.action.denyCode, 'POLICY_RULE_DENY');
    console.log(
      `Blocked .env write -> ${envDeny.action.denyCode}: ${envDeny.action.reason}`,
    );

    const capDeny = await engine.intercept({
      toolName: 'stripe.create_charge',
      args: {
        customerId: 'cus_acme_01',
        amountCents: 5000,
        currency: 'usd',
        description: 'Over-budget $50 charge',
      },
      sessionId,
      agentId: 'demo-agent',
    });
    assert.equal(capDeny.status, 'denied');
    assert.equal(capDeny.action.denyCode, 'SESSION_SPEND_CAP_EXCEEDED');
    console.log(
      `Blocked $50 charge -> ${capDeny.action.denyCode}: ${capDeny.action.reason}`,
    );

    section('6. MCP JSON-RPC Proxy Interception & Agent Self-Undo');
    const mcpRouter = new McpFirewallRouter({
      engine,
      defaultSessionId: sessionId,
    });
    const toolsResp = await mcpRouter.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const toolCount = (
      toolsResp?.result as { tools: unknown[] }
    ).tools.length;
    console.log(`MCP tools/list exposed ${toolCount} guarded tools (including meta undo tools).`);

    const calCall = await mcpRouter.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'calendar.create_event',
        arguments: {
          title: 'Temporary Demo Sync',
          startIso: '2026-11-28T09:00:00Z',
          endIso: '2026-11-28T09:30:00Z',
        },
      },
    });
    const calPayload = JSON.parse(
      (calCall?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { actionId: string; status: string };
    assert.equal(calPayload.status, 'grace_pending');

    const agentSelfUndo = await mcpRouter.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'agent_undo_undo',
        arguments: { actionId: calPayload.actionId },
      },
    });
    const undoPayload = JSON.parse(
      (agentSelfUndo?.result as { content: Array<{ text: string }> })
        .content[0]!.text,
    ) as { status: string; mode: string };
    assert.equal(undoPayload.status, 'undone');
    console.log(
      `MCP agent_undo_undo canceled ${calPayload.actionId} -> status=${undoPayload.status}`,
    );

    section('7. Immutable SHA-256 Audit Chain Verification');
    const verification = db.verifyAuditChain();
    assert.equal(verification.valid, true);
    const meter = db.getBudgetMeter(sessionId, policy.getBudgetLimits());
    console.log(
      `Audit chain verified: valid=${verification.valid}, entries=${verification.totalEntries}`,
    );
    console.log(
      `Final session budget: $${meter.sessionSpendUsd.toFixed(2)} / $${meter.sessionMaxSpendUsd?.toFixed(2)} | mutations=${meter.sessionMutations}/${meter.sessionMaxMutations}`,
    );
    console.log('\nDemo complete. Launch the live dashboard with: ./bin/agent-undo start');
  } finally {
    engine.stop();
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
