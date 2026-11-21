import { describe, expect, it } from 'vitest';
import {
  PolicyEngine,
  parsePolicy,
} from '../src/index.js';

describe('Policy Schema & Evaluation Engine', () => {
  it('parses YAML and JSON policies and validates schema constraints', () => {
    const yamlPolicy = parsePolicy(
      `
version: "0.1"
defaultDecision: require_approval
defaultGraceSeconds: 20
budgets:
  session:
    maxSpendUsd: 50
    maxMutations: 10
rules:
  - id: read-only
    match:
      tool: ["*.list_*", "fs.read_file"]
    decision: allow
    readOnly: true
`,
      'yaml',
    );
    expect(yamlPolicy.defaultGraceSeconds).toBe(20);
    expect(yamlPolicy.rules).toHaveLength(1);

    const jsonPolicy = parsePolicy(
      JSON.stringify({
        version: '0.1',
        defaultDecision: 'deny',
        defaultGraceSeconds: 15,
        rules: [],
      }),
      'json',
    );
    expect(jsonPolicy.defaultDecision).toBe('deny');

    expect(() =>
      parsePolicy(
        `
defaultDecision: allow
defaultGraceSeconds: -5
`,
        'yaml',
      ),
    ).toThrow();
  });

  it('evaluates nested argument predicates and first-match precedence', () => {
    const policy = parsePolicy(`
version: "0.1"
defaultDecision: require_approval
defaultGraceSeconds: 30
rules:
  - id: deny-env
    match:
      tool: "fs.*"
      args:
        path:
          regex: "(^|/)\\\\.env$"
    decision: deny
    reason: "Sensitive file blocked"
  - id: allow-read
    match:
      tool: "fs.read_file"
    decision: allow
    readOnly: true
  - id: high-tier-approval
    match:
      tool: "stripe.create_charge"
      args:
        amountCents:
          gte: 5000
        meta.env:
          in: ["prod", "staging"]
    decision: require_approval
    spendExtractor:
      arg: amountCents
      scale: 0.01
  - id: small-charge-grace
    match:
      tool: "stripe.create_charge"
      args:
        amountCents:
          lt: 5000
    decision: grace_window
    graceSeconds: 12
    spendExtractor:
      arg: amountCents
      scale: 0.01
`);

    const engine = new PolicyEngine(policy);
    const zeroUsage = {
      sessionSpendUsd: 0,
      dailySpendUsd: 0,
      sessionMutations: 0,
      dailyMutations: 0,
    };

    const denyEnv = engine.evaluate({
      toolName: 'fs.read_file',
      args: { path: '.env' },
      currentUsage: zeroUsage,
    });
    expect(denyEnv.decision).toBe('deny');
    expect(denyEnv.denyCode).toBe('POLICY_RULE_DENY');
    expect(denyEnv.ruleId).toBe('deny-env');

    const allowNormalRead = engine.evaluate({
      toolName: 'fs.read_file',
      args: { path: 'notes/roadmap.md' },
      currentUsage: zeroUsage,
    });
    expect(allowNormalRead.decision).toBe('allow');
    expect(allowNormalRead.readOnly).toBe(true);
    expect(allowNormalRead.mutationUnits).toBe(0);

    const approvalProd = engine.evaluate({
      toolName: 'stripe.create_charge',
      args: { amountCents: 6500, meta: { env: 'prod' } },
      currentUsage: zeroUsage,
    });
    expect(approvalProd.decision).toBe('require_approval');
    expect(approvalProd.spendUsd).toBe(65);
    expect(approvalProd.mutationUnits).toBe(1);

    const graceSmall = engine.evaluate({
      toolName: 'stripe.create_charge',
      args: { amountCents: 2499 },
      currentUsage: zeroUsage,
    });
    expect(graceSmall.decision).toBe('grace_window');
    expect(graceSmall.graceSeconds).toBe(12);
    expect(graceSmall.spendUsd).toBe(24.99);

    const fallback = engine.evaluate({
      toolName: 'unknown.tool',
      args: {},
      currentUsage: zeroUsage,
    });
    expect(fallback.decision).toBe('require_approval');
    expect(fallback.ruleId).toBeNull();
  });

  it('enforces session and daily spend and mutation caps while exempting read-only calls', () => {
    const policy = parsePolicy(`
version: "0.1"
defaultDecision: grace_window
defaultGraceSeconds: 30
budgets:
  session:
    maxSpendUsd: 100
    maxMutations: 3
  daily:
    maxSpendUsd: 150
    maxMutations: 5
rules:
  - id: allow-read
    match:
      tool: "*.read_*"
    decision: allow
    readOnly: true
  - id: charge
    match:
      tool: "stripe.create_charge"
    decision: grace_window
    spendExtractor:
      arg: amountCents
      scale: 0.01
`);

    const engine = new PolicyEngine(policy);

    const sessionSpendBlock = engine.evaluate({
      toolName: 'stripe.create_charge',
      args: { amountCents: 4100 },
      currentUsage: {
        sessionSpendUsd: 60,
        dailySpendUsd: 60,
        sessionMutations: 1,
        dailyMutations: 1,
      },
    });
    expect(sessionSpendBlock.decision).toBe('deny');
    expect(sessionSpendBlock.denyCode).toBe('SESSION_SPEND_CAP_EXCEEDED');

    const dailySpendBlock = engine.evaluate({
      toolName: 'stripe.create_charge',
      args: { amountCents: 4000 },
      currentUsage: {
        sessionSpendUsd: 20,
        dailySpendUsd: 120,
        sessionMutations: 1,
        dailyMutations: 2,
      },
    });
    expect(dailySpendBlock.decision).toBe('deny');
    expect(dailySpendBlock.denyCode).toBe('DAILY_SPEND_CAP_EXCEEDED');

    const sessionMutBlock = engine.evaluate({
      toolName: 'calendar.create_event',
      args: { title: 'Test' },
      currentUsage: {
        sessionSpendUsd: 0,
        dailySpendUsd: 0,
        sessionMutations: 3,
        dailyMutations: 3,
      },
    });
    expect(sessionMutBlock.decision).toBe('deny');
    expect(sessionMutBlock.denyCode).toBe('SESSION_MUTATION_CAP_EXCEEDED');

    const dailyMutBlock = engine.evaluate({
      toolName: 'calendar.create_event',
      args: { title: 'Test' },
      currentUsage: {
        sessionSpendUsd: 0,
        dailySpendUsd: 0,
        sessionMutations: 1,
        dailyMutations: 5,
      },
    });
    expect(dailyMutBlock.decision).toBe('deny');
    expect(dailyMutBlock.denyCode).toBe('DAILY_MUTATION_CAP_EXCEEDED');

    // Read-only calls remain allowed even when mutation caps are maxed out.
    const readWhenMaxed = engine.evaluate({
      toolName: 'fs.read_file',
      args: { path: 'README.txt' },
      currentUsage: {
        sessionSpendUsd: 100,
        dailySpendUsd: 150,
        sessionMutations: 3,
        dailyMutations: 5,
      },
    });
    expect(readWhenMaxed.decision).toBe('allow');
  });
});
