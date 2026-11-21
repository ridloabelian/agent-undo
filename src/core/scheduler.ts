import type { UndoDatabase } from '../storage/database.js';

export interface GraceSchedulerOptions {
  db: UndoDatabase;
  onDue: (actionId: string) => Promise<void>;
  pollIntervalMs?: number;
}

/**
 * Schedules delayed grace-window executions with exact per-action timers
 * backed by a SQLite polling sweep for cross-process recovery.
 */
export class GraceScheduler {
  private readonly db: UndoDatabase;
  private readonly onDue: (actionId: string) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Set<string>();
  private pollHandle: NodeJS.Timeout | null = null;
  private started = false;

  constructor(options: GraceSchedulerOptions) {
    this.db = options.db;
    this.onDue = options.onDue;
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    for (const pending of this.db.listPendingGraceActions()) {
      if (pending.executeAtMs !== null) {
        this.schedule(pending.id, pending.executeAtMs);
      }
    }

    void this.tick();
    this.pollHandle = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.pollHandle.unref();
  }

  stop(): void {
    this.started = false;
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  schedule(actionId: string, executeAtMs: number): void {
    this.cancel(actionId);
    const delayMs = Math.max(0, executeAtMs - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(actionId);
      void this.dispatch(actionId);
    }, delayMs);
    timer.unref();
    this.timers.set(actionId, timer);
  }

  cancel(actionId: string): void {
    const existing = this.timers.get(actionId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(actionId);
    }
  }

  async tick(): Promise<void> {
    if (!this.started) return;
    const due = this.db.listDueGraceActions(Date.now());
    for (const action of due) {
      await this.dispatch(action.id);
    }
  }

  private async dispatch(actionId: string): Promise<void> {
    if (this.inFlight.has(actionId)) {
      return;
    }
    this.inFlight.add(actionId);
    try {
      await this.onDue(actionId);
    } finally {
      this.inFlight.delete(actionId);
    }
  }
}
