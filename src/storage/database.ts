import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  ActionRecord,
  ActionStatus,
  AuditChainVerification,
  AuditRecord,
  BudgetConfig,
  BudgetMeter,
  DenyCode,
  DryRunDiff,
  PolicyDecision,
  PolicyEvaluationResult,
  SnapshotRecord,
  UsageTotals,
} from '../types.js';

export function getUtcDayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export interface MockEmailRow {
  id: string;
  folder: 'inbox' | 'sent' | 'trash';
  fromAddr: string;
  toAddr: string;
  ccAddr: string | null;
  subject: string;
  body: string;
  createdAt: string;
}

export interface MockEventRow {
  id: string;
  title: string;
  startIso: string;
  endIso: string;
  attendees: string[];
  status: 'confirmed' | 'canceled';
  cancelReason: string | null;
  createdAt: string;
}

export interface MockChargeRow {
  id: string;
  customerId: string;
  amountCents: number;
  currency: string;
  description: string;
  status: 'succeeded' | 'refunded';
  refundId: string | null;
  refundReason: string | null;
  createdAt: string;
}

interface RawActionRow {
  id: string;
  session_id: string;
  agent_id: string;
  day_key: string;
  tool_name: string;
  args_json: string;
  decision: PolicyDecision;
  rule_id: string | null;
  reason: string;
  deny_code: DenyCode | null;
  status: ActionStatus;
  read_only: number;
  spend_usd: number;
  mutation_units: number;
  diff_summary: string;
  diff_json: string;
  grace_seconds: number;
  execute_at_ms: number | null;
  execute_at: string | null;
  created_at: string;
  updated_at: string;
  executed_at: string | null;
  undone_at: string | null;
  rolled_back_at: string | null;
  actor: string;
  result_json: string | null;
  rollback_result_json: string | null;
  error_message: string | null;
  reversible: number;
}

interface RawAuditRow {
  seq: number;
  id: string;
  timestamp: string;
  event_type: string;
  action_id: string | null;
  session_id: string;
  actor: string;
  summary: string;
  payload_json: string;
  prev_hash: string;
  entry_hash: string;
}

interface RawSnapshotRow {
  id: string;
  action_id: string;
  tool_name: string;
  before_json: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

function computeAuditHash(parts: {
  seq: number;
  timestamp: string;
  eventType: string;
  actionId: string | null;
  sessionId: string;
  actor: string;
  summary: string;
  payloadJson: string;
  prevHash: string;
}): string {
  const input = [
    parts.prevHash,
    String(parts.seq),
    parts.timestamp,
    parts.eventType,
    parts.actionId ?? '',
    parts.sessionId,
    parts.actor,
    parts.summary,
    parts.payloadJson,
  ].join('|');

  return crypto.createHash('sha256').update(input).digest('hex');
}

function parseJsonSafe<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  return JSON.parse(raw) as T;
}

function mapActionRow(row: RawActionRow): ActionRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    dayKey: row.day_key,
    toolName: row.tool_name,
    args: parseJsonSafe<Record<string, unknown>>(row.args_json, {}),
    decision: row.decision,
    ruleId: row.rule_id,
    reason: row.reason,
    denyCode: row.deny_code,
    status: row.status,
    readOnly: row.read_only === 1,
    spendUsd: row.spend_usd,
    mutationUnits: row.mutation_units,
    diffSummary: row.diff_summary,
    diff: JSON.parse(row.diff_json) as DryRunDiff,
    graceSeconds: row.grace_seconds,
    executeAtMs: row.execute_at_ms,
    executeAt: row.execute_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    executedAt: row.executed_at,
    undoneAt: row.undone_at,
    rolledBackAt: row.rolled_back_at,
    actor: row.actor,
    result: row.result_json === null ? null : (JSON.parse(row.result_json) as unknown),
    rollbackResult:
      row.rollback_result_json === null
        ? null
        : (JSON.parse(row.rollback_result_json) as unknown),
    errorMessage: row.error_message,
    reversible: row.reversible === 1,
  };
}

function mapAuditRow(row: RawAuditRow): AuditRecord {
  return {
    seq: row.seq,
    id: row.id,
    timestamp: row.timestamp,
    eventType: row.event_type,
    actionId: row.action_id,
    sessionId: row.session_id,
    actor: row.actor,
    summary: row.summary,
    payload: parseJsonSafe<Record<string, unknown>>(row.payload_json, {}),
    prevHash: row.prev_hash,
    entryHash: row.entry_hash,
  };
}

export interface CreateActionInput {
  id: string;
  sessionId: string;
  agentId: string;
  dayKey?: string;
  toolName: string;
  args: Record<string, unknown>;
  diff: DryRunDiff;
  actor: string;
  reversible: boolean;
  evaluate: (usage: UsageTotals) => {
    evaluation: PolicyEvaluationResult;
    status: ActionStatus;
    graceSeconds: number;
    executeAtMs: number | null;
    executeAt: string | null;
    beforeSnapshot?: unknown;
    auditEventType: string;
    auditSummary: string;
  };
}

/**
 * Persistent SQLite store for staged actions, snapshots, immutable audit logs,
 * and built-in local mock adapter state.
 */
export class UndoDatabase {
  readonly db: Database.Database;
  readonly dbPath: string;

  constructor(dbPath: string = '.agent-undo/state.db') {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        day_key TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        decision TEXT NOT NULL,
        rule_id TEXT,
        reason TEXT NOT NULL,
        deny_code TEXT,
        status TEXT NOT NULL,
        read_only INTEGER NOT NULL,
        spend_usd REAL NOT NULL DEFAULT 0,
        mutation_units INTEGER NOT NULL DEFAULT 0,
        diff_summary TEXT NOT NULL,
        diff_json TEXT NOT NULL,
        grace_seconds REAL NOT NULL DEFAULT 0,
        execute_at_ms INTEGER,
        execute_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        executed_at TEXT,
        undone_at TEXT,
        rolled_back_at TEXT,
        actor TEXT NOT NULL,
        result_json TEXT,
        rollback_result_json TEXT,
        error_message TEXT,
        reversible INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_actions_status_execute
        ON actions(status, execute_at_ms);
      CREATE INDEX IF NOT EXISTS idx_actions_session
        ON actions(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_actions_day
        ON actions(day_key, status);

      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL UNIQUE REFERENCES actions(id),
        tool_name TEXT NOT NULL,
        before_json TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        action_id TEXT,
        session_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        entry_hash TEXT NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS prevent_audit_update
      BEFORE UPDATE ON audit_logs
      BEGIN
        SELECT RAISE(ABORT, 'audit_logs is append-only and immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS prevent_audit_delete
      BEFORE DELETE ON audit_logs
      BEGIN
        SELECT RAISE(ABORT, 'audit_logs is append-only and immutable');
      END;

      CREATE TABLE IF NOT EXISTS mock_emails (
        id TEXT PRIMARY KEY,
        folder TEXT NOT NULL,
        from_addr TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        cc_addr TEXT,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mock_events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        start_iso TEXT NOT NULL,
        end_iso TEXT NOT NULL,
        attendees_json TEXT NOT NULL,
        status TEXT NOT NULL,
        cancel_reason TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mock_charges (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        refund_id TEXT,
        refund_reason TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  getUsage(sessionId: string, dayKey: string = getUtcDayKey()): UsageTotals {
    const activeStatuses = `('executed', 'grace_pending', 'pending_approval', 'approved', 'executing')`;

    const sessionRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(spend_usd), 0) AS spend, COALESCE(SUM(mutation_units), 0) AS mutations
         FROM actions
         WHERE session_id = ? AND status IN ${activeStatuses}`,
      )
      .get(sessionId) as { spend: number; mutations: number };

    const dailyRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(spend_usd), 0) AS spend, COALESCE(SUM(mutation_units), 0) AS mutations
         FROM actions
         WHERE day_key = ? AND status IN ${activeStatuses}`,
      )
      .get(dayKey) as { spend: number; mutations: number };

    return {
      sessionSpendUsd: Math.round(sessionRow.spend * 1_000_000) / 1_000_000,
      dailySpendUsd: Math.round(dailyRow.spend * 1_000_000) / 1_000_000,
      sessionMutations: sessionRow.mutations,
      dailyMutations: dailyRow.mutations,
    };
  }

  getBudgetMeter(
    sessionId: string,
    limits?: BudgetConfig,
    dayKey: string = getUtcDayKey(),
  ): BudgetMeter {
    const usage = this.getUsage(sessionId, dayKey);
    return {
      sessionId,
      dayKey,
      sessionSpendUsd: usage.sessionSpendUsd,
      sessionMaxSpendUsd: limits?.session?.maxSpendUsd ?? null,
      dailySpendUsd: usage.dailySpendUsd,
      dailyMaxSpendUsd: limits?.daily?.maxSpendUsd ?? null,
      sessionMutations: usage.sessionMutations,
      sessionMaxMutations: limits?.session?.maxMutations ?? null,
      dailyMutations: usage.dailyMutations,
      dailyMaxMutations: limits?.daily?.maxMutations ?? null,
    };
  }

  private appendAuditInternal(input: {
    eventType: string;
    actionId: string | null;
    sessionId: string;
    actor: string;
    summary: string;
    payload?: Record<string, unknown>;
    timestamp?: string;
  }): AuditRecord {
    const latest = this.db
      .prepare(
        'SELECT seq, entry_hash FROM audit_logs ORDER BY seq DESC LIMIT 1',
      )
      .get() as { seq: number; entry_hash: string } | undefined;

    const seq = (latest?.seq ?? 0) + 1;
    const prevHash = latest?.entry_hash ?? '0'.repeat(64);
    const id = `aud_${crypto.randomUUID().slice(0, 12)}`;
    const timestamp = input.timestamp ?? new Date().toISOString();
    const payload = input.payload ?? {};
    const payloadJson = JSON.stringify(payload);
    const entryHash = computeAuditHash({
      seq,
      timestamp,
      eventType: input.eventType,
      actionId: input.actionId,
      sessionId: input.sessionId,
      actor: input.actor,
      summary: input.summary,
      payloadJson,
      prevHash,
    });

    this.db
      .prepare(
        `INSERT INTO audit_logs (
          seq, id, timestamp, event_type, action_id, session_id,
          actor, summary, payload_json, prev_hash, entry_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        seq,
        id,
        timestamp,
        input.eventType,
        input.actionId,
        input.sessionId,
        input.actor,
        input.summary,
        payloadJson,
        prevHash,
        entryHash,
      );

    return {
      seq,
      id,
      timestamp,
      eventType: input.eventType,
      actionId: input.actionId,
      sessionId: input.sessionId,
      actor: input.actor,
      summary: input.summary,
      payload,
      prevHash,
      entryHash,
    };
  }

  appendAudit(input: {
    eventType: string;
    actionId: string | null;
    sessionId: string;
    actor: string;
    summary: string;
    payload?: Record<string, unknown>;
  }): AuditRecord {
    const tx = this.db.transaction(() => this.appendAuditInternal(input));
    return tx.immediate();
  }

  createActionWithAudit(input: CreateActionInput): {
    action: ActionRecord;
    evaluation: PolicyEvaluationResult;
  } {
    const tx = this.db.transaction(() => {
      const dayKey = input.dayKey ?? getUtcDayKey();
      const usage = this.getUsage(input.sessionId, dayKey);
      const outcome = input.evaluate(usage);
      const now = new Date().toISOString();

      this.db
        .prepare(
          `INSERT INTO actions (
            id, session_id, agent_id, day_key, tool_name, args_json,
            decision, rule_id, reason, deny_code, status, read_only,
            spend_usd, mutation_units, diff_summary, diff_json,
            grace_seconds, execute_at_ms, execute_at, created_at, updated_at,
            executed_at, undone_at, rolled_back_at, actor, result_json,
            rollback_result_json, error_message, reversible
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.sessionId,
          input.agentId,
          dayKey,
          input.toolName,
          JSON.stringify(input.args),
          outcome.evaluation.decision,
          outcome.evaluation.ruleId,
          outcome.evaluation.reason,
          outcome.evaluation.denyCode,
          outcome.status,
          outcome.evaluation.readOnly ? 1 : 0,
          outcome.evaluation.spendUsd,
          outcome.evaluation.mutationUnits,
          input.diff.title,
          JSON.stringify(input.diff),
          outcome.graceSeconds,
          outcome.executeAtMs,
          outcome.executeAt,
          now,
          now,
          null,
          null,
          null,
          input.actor,
          null,
          null,
          null,
          input.reversible ? 1 : 0,
        );

      if (outcome.beforeSnapshot !== undefined) {
        this.db
          .prepare(
            `INSERT INTO snapshots (id, action_id, tool_name, before_json, result_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
            `snp_${crypto.randomUUID().slice(0, 12)}`,
            input.id,
            input.toolName,
            JSON.stringify(outcome.beforeSnapshot),
            now,
            now,
          );
      }

      this.appendAuditInternal({
        eventType: outcome.auditEventType,
        actionId: input.id,
        sessionId: input.sessionId,
        actor: input.actor,
        summary: outcome.auditSummary,
        payload: {
          toolName: input.toolName,
          decision: outcome.evaluation.decision,
          status: outcome.status,
          ruleId: outcome.evaluation.ruleId,
          denyCode: outcome.evaluation.denyCode,
          spendUsd: outcome.evaluation.spendUsd,
        },
        timestamp: now,
      });

      const action = this.getAction(input.id);
      if (!action) {
        throw new Error(`Failed to read newly inserted action ${input.id}`);
      }

      return {
        action,
        evaluation: outcome.evaluation,
      };
    });

    return tx.immediate();
  }

  getAction(id: string): ActionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM actions WHERE id = ?')
      .get(id) as RawActionRow | undefined;
    return row ? mapActionRow(row) : null;
  }

  listActions(options?: {
    status?: ActionStatus | ActionStatus[];
    sessionId?: string;
    limit?: number;
  }): ActionRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options?.status) {
      const statuses = Array.isArray(options.status)
        ? options.status
        : [options.status];
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }

    if (options?.sessionId) {
      clauses.push('session_id = ?');
      params.push(options.sessionId);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = options?.limit ?? 100;
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT * FROM actions ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params) as RawActionRow[];

    return rows.map(mapActionRow);
  }

  getSnapshot(actionId: string): SnapshotRecord | null {
    const row = this.db
      .prepare('SELECT * FROM snapshots WHERE action_id = ?')
      .get(actionId) as RawSnapshotRow | undefined;
    if (!row) return null;

    return {
      id: row.id,
      actionId: row.action_id,
      toolName: row.tool_name,
      beforeSnapshot:
        row.before_json === null ? null : (JSON.parse(row.before_json) as unknown),
      result:
        row.result_json === null ? null : (JSON.parse(row.result_json) as unknown),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  saveExecutionSnapshot(
    actionId: string,
    toolName: string,
    beforeSnapshot: unknown,
    result: unknown,
  ): void {
    const now = new Date().toISOString();
    const beforeJson =
      beforeSnapshot === undefined ? null : JSON.stringify(beforeSnapshot);
    const resultJson = result === undefined ? null : JSON.stringify(result);

    this.db
      .prepare(
        `INSERT INTO snapshots (id, action_id, tool_name, before_json, result_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(action_id) DO UPDATE SET
           before_json = COALESCE(excluded.before_json, snapshots.before_json),
           result_json = excluded.result_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        `snp_${crypto.randomUUID().slice(0, 12)}`,
        actionId,
        toolName,
        beforeJson,
        resultJson,
        now,
        now,
      );
  }

  claimActionForExecution(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE actions
         SET status = 'executing', updated_at = ?
         WHERE id = ? AND status IN ('grace_pending', 'approved')`,
      )
      .run(now, id);
    return result.changes === 1;
  }

  markActionExecuted(id: string, result: unknown, actor: string): ActionRecord {
    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();
      const resultJson = result === undefined ? 'null' : JSON.stringify(result);

      this.db
        .prepare(
          `UPDATE actions
           SET status = 'executed', executed_at = ?, updated_at = ?, result_json = ?, error_message = NULL
           WHERE id = ?`,
        )
        .run(now, now, resultJson, id);

      const action = this.getAction(id);
      if (!action) {
        throw new Error(`Action ${id} not found after execution update`);
      }

      this.appendAuditInternal({
        eventType: 'ACTION_EXECUTED',
        actionId: action.id,
        sessionId: action.sessionId,
        actor,
        summary: `Executed ${action.toolName}`,
        payload: {
          toolName: action.toolName,
          spendUsd: action.spendUsd,
          reversible: action.reversible,
        },
        timestamp: now,
      });

      return action;
    });

    return tx.immediate();
  }

  markActionFailed(
    id: string,
    errorMessage: string,
    actor: string,
  ): ActionRecord {
    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();

      this.db
        .prepare(
          `UPDATE actions
           SET status = 'failed', updated_at = ?, error_message = ?
           WHERE id = ?`,
        )
        .run(now, errorMessage, id);

      const action = this.getAction(id);
      if (!action) {
        throw new Error(`Action ${id} not found after failure update`);
      }

      this.appendAuditInternal({
        eventType: 'ACTION_FAILED',
        actionId: action.id,
        sessionId: action.sessionId,
        actor,
        summary: `Execution failed for ${action.toolName}: ${errorMessage}`,
        payload: {
          toolName: action.toolName,
          errorMessage,
        },
        timestamp: now,
      });

      return action;
    });

    return tx.immediate();
  }

  claimApproveAction(id: string, actor: string): ActionRecord | null {
    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();
      const res = this.db
        .prepare(
          `UPDATE actions
           SET status = 'approved', updated_at = ?, actor = ?
           WHERE id = ? AND status = 'pending_approval'`,
        )
        .run(now, actor, id);

      if (res.changes !== 1) {
        return null;
      }

      const action = this.getAction(id);
      if (!action) return null;

      this.appendAuditInternal({
        eventType: 'ACTION_APPROVED',
        actionId: action.id,
        sessionId: action.sessionId,
        actor,
        summary: `Approved ${action.toolName} (${action.id})`,
        payload: {
          toolName: action.toolName,
        },
        timestamp: now,
      });

      return action;
    });

    return tx.immediate();
  }

  claimSoftUndo(id: string, actor: string): ActionRecord | null {
    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();
      const res = this.db
        .prepare(
          `UPDATE actions
           SET status = 'undone', undone_at = ?, updated_at = ?, actor = ?
           WHERE id = ? AND status IN ('grace_pending', 'pending_approval', 'approved')`,
        )
        .run(now, now, actor, id);

      if (res.changes !== 1) {
        return null;
      }

      const action = this.getAction(id);
      if (!action) return null;

      this.appendAuditInternal({
        eventType: 'ACTION_UNDONE_SOFT',
        actionId: action.id,
        sessionId: action.sessionId,
        actor,
        summary: `Soft-undid staged action ${action.toolName} before execution`,
        payload: {
          toolName: action.toolName,
          releasedSpendUsd: action.spendUsd,
        },
        timestamp: now,
      });

      return action;
    });

    return tx.immediate();
  }

  markActionRolledBack(
    id: string,
    rollbackResult: unknown,
    actor: string,
  ): ActionRecord {
    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();
      const json =
        rollbackResult === undefined ? 'null' : JSON.stringify(rollbackResult);

      this.db
        .prepare(
          `UPDATE actions
           SET status = 'rolled_back', rolled_back_at = ?, updated_at = ?, actor = ?, rollback_result_json = ?
           WHERE id = ?`,
        )
        .run(now, now, actor, json, id);

      const action = this.getAction(id);
      if (!action) {
        throw new Error(`Action ${id} not found after rollback`);
      }

      this.appendAuditInternal({
        eventType: 'ACTION_ROLLED_BACK',
        actionId: action.id,
        sessionId: action.sessionId,
        actor,
        summary: `Rolled back executed action ${action.toolName} via compensating handler`,
        payload: {
          toolName: action.toolName,
          releasedSpendUsd: action.spendUsd,
          rollbackResult,
        },
        timestamp: now,
      });

      return action;
    });

    return tx.immediate();
  }

  markActionRollbackFailed(
    id: string,
    errorMessage: string,
    actor: string,
  ): ActionRecord {
    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();

      this.db
        .prepare(
          `UPDATE actions
           SET status = 'rollback_failed', updated_at = ?, error_message = ?
           WHERE id = ?`,
        )
        .run(now, errorMessage, id);

      const action = this.getAction(id);
      if (!action) {
        throw new Error(`Action ${id} not found after rollback failure`);
      }

      this.appendAuditInternal({
        eventType: 'ACTION_ROLLBACK_FAILED',
        actionId: action.id,
        sessionId: action.sessionId,
        actor,
        summary: `Rollback failed for ${action.toolName}: ${errorMessage}`,
        payload: {
          toolName: action.toolName,
          errorMessage,
        },
        timestamp: now,
      });

      return action;
    });

    return tx.immediate();
  }

  listDueGraceActions(nowMs: number = Date.now()): ActionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM actions
         WHERE (status = 'grace_pending' AND execute_at_ms <= ?)
            OR status = 'approved'
         ORDER BY COALESCE(execute_at_ms, 0) ASC`,
      )
      .all(nowMs) as RawActionRow[];
    return rows.map(mapActionRow);
  }

  listPendingGraceActions(): ActionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM actions
         WHERE status = 'grace_pending'
         ORDER BY execute_at_ms ASC`,
      )
      .all() as RawActionRow[];
    return rows.map(mapActionRow);
  }

  listAuditLogs(limit: number = 100): AuditRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_logs ORDER BY seq DESC LIMIT ?')
      .all(limit) as RawAuditRow[];
    return rows.map(mapAuditRow);
  }

  verifyAuditChain(): AuditChainVerification {
    const rows = this.db
      .prepare('SELECT * FROM audit_logs ORDER BY seq ASC')
      .all() as RawAuditRow[];

    let expectedPrevHash = '0'.repeat(64);
    for (const row of rows) {
      if (row.prev_hash !== expectedPrevHash) {
        return {
          valid: false,
          totalEntries: rows.length,
          brokenAtSeq: row.seq,
          reason: `prev_hash mismatch at seq ${row.seq}`,
        };
      }

      const expectedEntryHash = computeAuditHash({
        seq: row.seq,
        timestamp: row.timestamp,
        eventType: row.event_type,
        actionId: row.action_id,
        sessionId: row.session_id,
        actor: row.actor,
        summary: row.summary,
        payloadJson: row.payload_json,
        prevHash: row.prev_hash,
      });

      if (row.entry_hash !== expectedEntryHash) {
        return {
          valid: false,
          totalEntries: rows.length,
          brokenAtSeq: row.seq,
          reason: `entry_hash mismatch at seq ${row.seq}`,
        };
      }

      expectedPrevHash = row.entry_hash;
    }

    return {
      valid: true,
      totalEntries: rows.length,
    };
  }

  getQueueCounts(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS count FROM actions GROUP BY status')
      .all() as Array<{ status: string; count: number }>;

    const counts: Record<string, number> = {
      grace_pending: 0,
      pending_approval: 0,
      executed: 0,
      undone: 0,
      rolled_back: 0,
      denied: 0,
      failed: 0,
    };
    for (const row of rows) {
      counts[row.status] = row.count;
    }
    return counts;
  }

  // --- Mock World State Persistence Helpers ---

  listMockEmails(folder: string = 'all'): MockEmailRow[] {
    const rows = (
      folder === 'all'
        ? this.db
            .prepare('SELECT * FROM mock_emails ORDER BY created_at DESC')
            .all()
        : this.db
            .prepare(
              'SELECT * FROM mock_emails WHERE folder = ? ORDER BY created_at DESC',
            )
            .all(folder)
    ) as Array<{
      id: string;
      folder: 'inbox' | 'sent' | 'trash';
      from_addr: string;
      to_addr: string;
      cc_addr: string | null;
      subject: string;
      body: string;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      folder: r.folder,
      fromAddr: r.from_addr,
      toAddr: r.to_addr,
      ccAddr: r.cc_addr,
      subject: r.subject,
      body: r.body,
      createdAt: r.created_at,
    }));
  }

  getMockEmail(id: string): MockEmailRow | null {
    const r = this.db
      .prepare('SELECT * FROM mock_emails WHERE id = ?')
      .get(id) as
      | {
          id: string;
          folder: 'inbox' | 'sent' | 'trash';
          from_addr: string;
          to_addr: string;
          cc_addr: string | null;
          subject: string;
          body: string;
          created_at: string;
        }
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      folder: r.folder,
      fromAddr: r.from_addr,
      toAddr: r.to_addr,
      ccAddr: r.cc_addr,
      subject: r.subject,
      body: r.body,
      createdAt: r.created_at,
    };
  }

  insertMockEmail(email: MockEmailRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO mock_emails
         (id, folder, from_addr, to_addr, cc_addr, subject, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        email.id,
        email.folder,
        email.fromAddr,
        email.toAddr,
        email.ccAddr,
        email.subject,
        email.body,
        email.createdAt,
      );
  }

  updateMockEmailFolder(
    id: string,
    folder: 'inbox' | 'sent' | 'trash',
  ): void {
    this.db
      .prepare('UPDATE mock_emails SET folder = ? WHERE id = ?')
      .run(folder, id);
  }

  deleteMockEmail(id: string): void {
    this.db.prepare('DELETE FROM mock_emails WHERE id = ?').run(id);
  }

  listMockEvents(): MockEventRow[] {
    const rows = this.db
      .prepare('SELECT * FROM mock_events ORDER BY start_iso ASC')
      .all() as Array<{
      id: string;
      title: string;
      start_iso: string;
      end_iso: string;
      attendees_json: string;
      status: 'confirmed' | 'canceled';
      cancel_reason: string | null;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      startIso: r.start_iso,
      endIso: r.end_iso,
      attendees: JSON.parse(r.attendees_json) as string[],
      status: r.status,
      cancelReason: r.cancel_reason,
      createdAt: r.created_at,
    }));
  }

  getMockEvent(id: string): MockEventRow | null {
    const r = this.db
      .prepare('SELECT * FROM mock_events WHERE id = ?')
      .get(id) as
      | {
          id: string;
          title: string;
          start_iso: string;
          end_iso: string;
          attendees_json: string;
          status: 'confirmed' | 'canceled';
          cancel_reason: string | null;
          created_at: string;
        }
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      title: r.title,
      startIso: r.start_iso,
      endIso: r.end_iso,
      attendees: JSON.parse(r.attendees_json) as string[],
      status: r.status,
      cancelReason: r.cancel_reason,
      createdAt: r.created_at,
    };
  }

  insertMockEvent(event: MockEventRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO mock_events
         (id, title, start_iso, end_iso, attendees_json, status, cancel_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.title,
        event.startIso,
        event.endIso,
        JSON.stringify(event.attendees),
        event.status,
        event.cancelReason,
        event.createdAt,
      );
  }

  updateMockEventStatus(
    id: string,
    status: 'confirmed' | 'canceled',
    cancelReason: string | null,
  ): void {
    this.db
      .prepare(
        'UPDATE mock_events SET status = ?, cancel_reason = ? WHERE id = ?',
      )
      .run(status, cancelReason, id);
  }

  deleteMockEvent(id: string): void {
    this.db.prepare('DELETE FROM mock_events WHERE id = ?').run(id);
  }

  listMockCharges(): MockChargeRow[] {
    const rows = this.db
      .prepare('SELECT * FROM mock_charges ORDER BY created_at DESC')
      .all() as Array<{
      id: string;
      customer_id: string;
      amount_cents: number;
      currency: string;
      description: string;
      status: 'succeeded' | 'refunded';
      refund_id: string | null;
      refund_reason: string | null;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      customerId: r.customer_id,
      amountCents: r.amount_cents,
      currency: r.currency,
      description: r.description,
      status: r.status,
      refundId: r.refund_id,
      refundReason: r.refund_reason,
      createdAt: r.created_at,
    }));
  }

  getMockCharge(id: string): MockChargeRow | null {
    const r = this.db
      .prepare('SELECT * FROM mock_charges WHERE id = ?')
      .get(id) as
      | {
          id: string;
          customer_id: string;
          amount_cents: number;
          currency: string;
          description: string;
          status: 'succeeded' | 'refunded';
          refund_id: string | null;
          refund_reason: string | null;
          created_at: string;
        }
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      customerId: r.customer_id,
      amountCents: r.amount_cents,
      currency: r.currency,
      description: r.description,
      status: r.status,
      refundId: r.refund_id,
      refundReason: r.refund_reason,
      createdAt: r.created_at,
    };
  }

  insertMockCharge(charge: MockChargeRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO mock_charges
         (id, customer_id, amount_cents, currency, description, status, refund_id, refund_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        charge.id,
        charge.customerId,
        charge.amountCents,
        charge.currency,
        charge.description,
        charge.status,
        charge.refundId,
        charge.refundReason,
        charge.createdAt,
      );
  }

  updateMockChargeRefund(
    id: string,
    refundId: string,
    refundReason: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE mock_charges
         SET status = 'refunded', refund_id = ?, refund_reason = ?
         WHERE id = ?`,
      )
      .run(refundId, refundReason, id);
  }

  deleteMockCharge(id: string): void {
    this.db.prepare('DELETE FROM mock_charges WHERE id = ?').run(id);
  }

  isMockStateEmpty(): boolean {
    const emails = (
      this.db.prepare('SELECT COUNT(*) AS c FROM mock_emails').get() as {
        c: number;
      }
    ).c;
    const events = (
      this.db.prepare('SELECT COUNT(*) AS c FROM mock_events').get() as {
        c: number;
      }
    ).c;
    const charges = (
      this.db.prepare('SELECT COUNT(*) AS c FROM mock_charges').get() as {
        c: number;
      }
    ).c;
    return emails === 0 && events === 0 && charges === 0;
  }
}
