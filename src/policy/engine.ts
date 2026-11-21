import type {
  ArgOperatorPredicate,
  ArgPredicate,
  BudgetConfig,
  PolicyConfig,
  PolicyEvaluationResult,
  PolicyRule,
  UsageTotals,
} from '../types.js';

export interface PolicyEvaluationInput {
  toolName: string;
  args: Record<string, unknown>;
  adapterReadOnly?: boolean;
  adapterSpendUsd?: number;
  currentUsage: UsageTotals;
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Converts a simple glob pattern (* and ?) into a full-string RegExp.
 */
export function globToRegExp(pattern: string): RegExp {
  const converted = pattern
    .split('*')
    .map((part) => part.split('?').map(escapeRegex).join('.'))
    .join('.*');
  return new RegExp(`^${converted}$`);
}

/**
 * Resolves a dot-separated path (e.g. "options.permanent") from an object.
 */
export function getNestedValue(
  record: Record<string, unknown>,
  dotPath: string,
): unknown {
  const segments = dotPath.split('.');
  let current: unknown = record;

  for (const segment of segments) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== 'object'
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function isOperatorPredicate(
  value: ArgPredicate,
): value is ArgOperatorPredicate {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Evaluates a single argument value against a primitive or operator predicate.
 */
export function matchesPredicate(
  actual: unknown,
  predicate: ArgPredicate,
): boolean {
  if (!isOperatorPredicate(predicate)) {
    return actual === predicate;
  }

  if (predicate.eq !== undefined && actual !== predicate.eq) {
    return false;
  }
  if (predicate.neq !== undefined && actual === predicate.neq) {
    return false;
  }
  if (predicate.gt !== undefined) {
    if (typeof actual !== 'number' || !(actual > predicate.gt)) return false;
  }
  if (predicate.gte !== undefined) {
    if (typeof actual !== 'number' || !(actual >= predicate.gte)) return false;
  }
  if (predicate.lt !== undefined) {
    if (typeof actual !== 'number' || !(actual < predicate.lt)) return false;
  }
  if (predicate.lte !== undefined) {
    if (typeof actual !== 'number' || !(actual <= predicate.lte)) return false;
  }
  if (predicate.in !== undefined) {
    if (!predicate.in.includes(actual)) return false;
  }
  if (predicate.contains !== undefined) {
    if (typeof actual === 'string') {
      if (!actual.includes(predicate.contains)) return false;
    } else if (Array.isArray(actual)) {
      if (!actual.includes(predicate.contains)) return false;
    } else {
      return false;
    }
  }
  if (predicate.regex !== undefined) {
    if (actual === null || actual === undefined) return false;
    const re = new RegExp(predicate.regex);
    if (!re.test(String(actual))) return false;
  }

  return true;
}

function matchesRule(
  rule: PolicyRule,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  const patterns = Array.isArray(rule.match.tool)
    ? rule.match.tool
    : [rule.match.tool];

  const toolMatched = patterns.some((pattern) =>
    globToRegExp(pattern).test(toolName),
  );
  if (!toolMatched) {
    return false;
  }

  if (!rule.match.args) {
    return true;
  }

  for (const [argPath, predicate] of Object.entries(rule.match.args)) {
    const actual = getNestedValue(args, argPath);
    if (!matchesPredicate(actual, predicate)) {
      return false;
    }
  }

  return true;
}

/**
 * Deterministic policy and budget cap evaluator.
 */
export class PolicyEngine {
  private readonly config: PolicyConfig;

  constructor(config: PolicyConfig) {
    this.config = config;
  }

  getConfig(): PolicyConfig {
    return this.config;
  }

  getBudgetLimits(): BudgetConfig {
    return this.config.budgets ?? {};
  }

  evaluate(input: PolicyEvaluationInput): PolicyEvaluationResult {
    const matchedRule =
      this.config.rules.find((rule) =>
        matchesRule(rule, input.toolName, input.args),
      ) ?? null;

    const baseDecision = matchedRule?.decision ?? this.config.defaultDecision;
    const baseReason =
      matchedRule?.reason ??
      (matchedRule
        ? `Matched rule "${matchedRule.id}" (${baseDecision})`
        : `Matched default policy decision (${baseDecision})`);

    const readOnly =
      matchedRule?.readOnly ??
      input.adapterReadOnly ??
      baseDecision === 'allow';

    const mutationUnits = readOnly ? 0 : 1;

    let spendUsd = input.adapterSpendUsd ?? 0;
    if (matchedRule?.spendExtractor) {
      const rawValue = getNestedValue(input.args, matchedRule.spendExtractor.arg);
      if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
        const scale = matchedRule.spendExtractor.scale ?? 1;
        spendUsd = Math.max(0, rawValue * scale);
      }
    }
    spendUsd = Math.round(spendUsd * 1_000_000) / 1_000_000;

    if (baseDecision === 'deny') {
      return {
        decision: 'deny',
        ruleId: matchedRule?.id ?? null,
        reason: baseReason,
        denyCode: 'POLICY_RULE_DENY',
        graceSeconds: 0,
        readOnly,
        spendUsd,
        mutationUnits,
      };
    }

    const budgets = this.config.budgets;
    const sessionMaxSpend = budgets?.session?.maxSpendUsd;
    if (
      sessionMaxSpend !== undefined &&
      spendUsd > 0 &&
      input.currentUsage.sessionSpendUsd + spendUsd > sessionMaxSpend
    ) {
      return {
        decision: 'deny',
        ruleId: matchedRule?.id ?? null,
        reason: `Session spend cap exceeded ($${(input.currentUsage.sessionSpendUsd + spendUsd).toFixed(2)} > $${sessionMaxSpend.toFixed(2)})`,
        denyCode: 'SESSION_SPEND_CAP_EXCEEDED',
        graceSeconds: 0,
        readOnly,
        spendUsd,
        mutationUnits,
      };
    }

    const dailyMaxSpend = budgets?.daily?.maxSpendUsd;
    if (
      dailyMaxSpend !== undefined &&
      spendUsd > 0 &&
      input.currentUsage.dailySpendUsd + spendUsd > dailyMaxSpend
    ) {
      return {
        decision: 'deny',
        ruleId: matchedRule?.id ?? null,
        reason: `Daily spend cap exceeded ($${(input.currentUsage.dailySpendUsd + spendUsd).toFixed(2)} > $${dailyMaxSpend.toFixed(2)})`,
        denyCode: 'DAILY_SPEND_CAP_EXCEEDED',
        graceSeconds: 0,
        readOnly,
        spendUsd,
        mutationUnits,
      };
    }

    const sessionMaxMutations = budgets?.session?.maxMutations;
    if (
      sessionMaxMutations !== undefined &&
      mutationUnits > 0 &&
      input.currentUsage.sessionMutations + mutationUnits > sessionMaxMutations
    ) {
      return {
        decision: 'deny',
        ruleId: matchedRule?.id ?? null,
        reason: `Session mutation cap exceeded (${input.currentUsage.sessionMutations + mutationUnits} > ${sessionMaxMutations})`,
        denyCode: 'SESSION_MUTATION_CAP_EXCEEDED',
        graceSeconds: 0,
        readOnly,
        spendUsd,
        mutationUnits,
      };
    }

    const dailyMaxMutations = budgets?.daily?.maxMutations;
    if (
      dailyMaxMutations !== undefined &&
      mutationUnits > 0 &&
      input.currentUsage.dailyMutations + mutationUnits > dailyMaxMutations
    ) {
      return {
        decision: 'deny',
        ruleId: matchedRule?.id ?? null,
        reason: `Daily mutation cap exceeded (${input.currentUsage.dailyMutations + mutationUnits} > ${dailyMaxMutations})`,
        denyCode: 'DAILY_MUTATION_CAP_EXCEEDED',
        graceSeconds: 0,
        readOnly,
        spendUsd,
        mutationUnits,
      };
    }

    const graceSeconds =
      baseDecision === 'grace_window'
        ? (matchedRule?.graceSeconds ?? this.config.defaultGraceSeconds)
        : 0;

    return {
      decision: baseDecision,
      ruleId: matchedRule?.id ?? null,
      reason: baseReason,
      denyCode: null,
      graceSeconds,
      readOnly,
      spendUsd,
      mutationUnits,
    };
  }
}
