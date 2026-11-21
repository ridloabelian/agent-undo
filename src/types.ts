export type PolicyDecision = 'allow' | 'grace_window' | 'require_approval' | 'deny';

export type ActionStatus =
  | 'executed'
  | 'grace_pending'
  | 'pending_approval'
  | 'approved'
  | 'executing'
  | 'undone'
  | 'rolled_back'
  | 'denied'
  | 'failed'
  | 'rollback_failed';

export type DenyCode =
  | 'POLICY_RULE_DENY'
  | 'SESSION_SPEND_CAP_EXCEEDED'
  | 'DAILY_SPEND_CAP_EXCEEDED'
  | 'SESSION_MUTATION_CAP_EXCEEDED'
  | 'DAILY_MUTATION_CAP_EXCEEDED';

export type DiffOperation =
  | 'read'
  | 'create'
  | 'update'
  | 'delete'
  | 'send'
  | 'payment'
  | 'execute';

export interface DryRunDiff {
  title: string;
  operation: DiffOperation;
  target: string;
  before: unknown;
  after: unknown;
  unifiedDiff: string;
  reversible: boolean;
  reversibilityNote: string;
}

export interface ActionRecord {
  id: string;
  sessionId: string;
  agentId: string;
  dayKey: string;
  toolName: string;
  args: Record<string, unknown>;
  decision: PolicyDecision;
  ruleId: string | null;
  reason: string;
  denyCode: DenyCode | null;
  status: ActionStatus;
  readOnly: boolean;
  spendUsd: number;
  mutationUnits: number;
  diffSummary: string;
  diff: DryRunDiff;
  graceSeconds: number;
  executeAtMs: number | null;
  executeAt: string | null;
  createdAt: string;
  updatedAt: string;
  executedAt: string | null;
  undoneAt: string | null;
  rolledBackAt: string | null;
  actor: string;
  result: unknown;
  rollbackResult: unknown;
  errorMessage: string | null;
  reversible: boolean;
}

export interface SnapshotRecord {
  id: string;
  actionId: string;
  toolName: string;
  beforeSnapshot: unknown;
  result: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface AuditRecord {
  seq: number;
  id: string;
  timestamp: string;
  eventType: string;
  actionId: string | null;
  sessionId: string;
  actor: string;
  summary: string;
  payload: Record<string, unknown>;
  prevHash: string;
  entryHash: string;
}

export interface AuditChainVerification {
  valid: boolean;
  totalEntries: number;
  brokenAtSeq?: number;
  reason?: string;
}

export interface UsageTotals {
  sessionSpendUsd: number;
  dailySpendUsd: number;
  sessionMutations: number;
  dailyMutations: number;
}

export interface BudgetMeter {
  sessionId: string;
  dayKey: string;
  sessionSpendUsd: number;
  sessionMaxSpendUsd: number | null;
  dailySpendUsd: number;
  dailyMaxSpendUsd: number | null;
  sessionMutations: number;
  sessionMaxMutations: number | null;
  dailyMutations: number;
  dailyMaxMutations: number | null;
}

export type ArgOperatorPredicate = {
  eq?: unknown;
  neq?: unknown;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  in?: unknown[];
  contains?: string;
  regex?: string;
};

export type ArgPredicate =
  | string
  | number
  | boolean
  | null
  | ArgOperatorPredicate;

export interface SpendExtractor {
  arg: string;
  scale?: number;
}

export interface PolicyRule {
  id: string;
  match: {
    tool: string | string[];
    args?: Record<string, ArgPredicate>;
  };
  decision: PolicyDecision;
  graceSeconds?: number;
  readOnly?: boolean;
  spendExtractor?: SpendExtractor;
  reason?: string;
}

export interface BudgetScopeConfig {
  maxSpendUsd?: number;
  maxMutations?: number;
}

export interface BudgetConfig {
  session?: BudgetScopeConfig;
  daily?: BudgetScopeConfig;
}

export interface PolicyConfig {
  version: string;
  defaultDecision: PolicyDecision;
  defaultGraceSeconds: number;
  budgets?: BudgetConfig;
  rules: PolicyRule[];
}

export interface PolicyEvaluationResult {
  decision: PolicyDecision;
  ruleId: string | null;
  reason: string;
  denyCode: DenyCode | null;
  graceSeconds: number;
  readOnly: boolean;
  spendUsd: number;
  mutationUnits: number;
}

export interface ToolCompensationContext<
  TArgs = Record<string, unknown>,
  TResult = unknown,
> {
  args: TArgs;
  beforeSnapshot: unknown;
  executionResult: TResult;
}

export interface ToolDefinition<
  TArgs extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown,
> {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  readOnly?: boolean;
  estimateSpendUsd?: (args: TArgs) => number;
  previewDiff?: (args: TArgs) => Promise<DryRunDiff> | DryRunDiff;
  captureSnapshot?: (args: TArgs) => Promise<unknown> | unknown;
  execute: (args: TArgs) => Promise<TResult> | TResult;
  compensate?: (
    ctx: ToolCompensationContext<TArgs, TResult>,
  ) => Promise<unknown> | unknown;
}

export interface InterceptRequest {
  toolName: string;
  args: Record<string, unknown>;
  sessionId?: string;
  agentId?: string;
  actor?: string;
  awaitCompletion?: boolean;
  customExecutor?: (args: Record<string, unknown>) => Promise<unknown>;
}

export type InterceptResult =
  | {
      status: 'executed';
      action: ActionRecord;
      result: unknown;
    }
  | {
      status: 'staged';
      action: ActionRecord;
    }
  | {
      status: 'pending_approval';
      action: ActionRecord;
    }
  | {
      status: 'denied';
      action: ActionRecord;
    }
  | {
      status: 'undone';
      action: ActionRecord;
    }
  | {
      status: 'failed';
      action: ActionRecord;
      error: string;
    };

export type UndoResult =
  | {
      mode: 'soft_cancel';
      action: ActionRecord;
    }
  | {
      mode: 'compensating_rollback';
      action: ActionRecord;
      rollbackResult: unknown;
    };
