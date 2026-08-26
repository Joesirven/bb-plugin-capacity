// The plugin's own SQLite tables: the admission queue, the sample history,
// and the durable record of warnings raised.
import type Database from "better-sqlite3";
import type { CapacityReading } from "./policy.js";

export type QueueState = "queued" | "spawned" | "cancelled" | "failed";

export interface QueueRow {
  id: string;
  createdAt: number;
  updatedAt: number;
  state: QueueState;
  priority: number;
  projectId: string;
  prompt: string;
  title: string | null;
  providerId: string | null;
  model: string | null;
  visibility: string | null;
  parentThreadId: string | null;
  requestedBy: string | null;
  attempts: number;
  threadId: string | null;
  error: string | null;
}

export interface WarningRow {
  id: number;
  raisedAt: number;
  level: string;
  reasons: string;
  agentLoad: number;
  clearedAt: number | null;
}

export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS queued_spawns (
     id TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     state TEXT NOT NULL,
     priority INTEGER NOT NULL DEFAULT 0,
     project_id TEXT NOT NULL,
     prompt TEXT NOT NULL,
     title TEXT,
     provider_id TEXT,
     model TEXT,
     visibility TEXT,
     parent_thread_id TEXT,
     requested_by TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     thread_id TEXT,
     error TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS queued_spawns_ready_idx
     ON queued_spawns (state, priority DESC, created_at)`,
  `CREATE TABLE IF NOT EXISTS samples (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     taken_at INTEGER NOT NULL,
     level TEXT NOT NULL,
     agent_load INTEGER NOT NULL,
     active_threads INTEGER NOT NULL,
     background_agents INTEGER NOT NULL,
     memory_available_mb INTEGER NOT NULL,
     swap_used_mb INTEGER NOT NULL,
     load_per_core REAL NOT NULL,
     event_loop_lag_ms INTEGER NOT NULL,
     detail TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS samples_taken_idx ON samples (taken_at)`,
  `CREATE TABLE IF NOT EXISTS warnings (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     raised_at INTEGER NOT NULL,
     level TEXT NOT NULL,
     reasons TEXT NOT NULL,
     agent_load INTEGER NOT NULL,
     cleared_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS warnings_raised_idx ON warnings (raised_at)`,
  `CREATE TABLE IF NOT EXISTS shed_threads (
     thread_id TEXT PRIMARY KEY,
     shed_at INTEGER NOT NULL,
     reason TEXT NOT NULL
   )`,
];

interface QueueRecord {
  id: string;
  created_at: number;
  updated_at: number;
  state: QueueState;
  priority: number;
  project_id: string;
  prompt: string;
  title: string | null;
  provider_id: string | null;
  model: string | null;
  visibility: string | null;
  parent_thread_id: string | null;
  requested_by: string | null;
  attempts: number;
  thread_id: string | null;
  error: string | null;
}

function toQueueRow(record: QueueRecord): QueueRow {
  return {
    id: record.id,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    state: record.state,
    priority: record.priority,
    projectId: record.project_id,
    prompt: record.prompt,
    title: record.title,
    providerId: record.provider_id,
    model: record.model,
    visibility: record.visibility,
    parentThreadId: record.parent_thread_id,
    requestedBy: record.requested_by,
    attempts: record.attempts,
    threadId: record.thread_id,
    error: record.error,
  };
}

export interface EnqueueInput {
  id: string;
  projectId: string;
  prompt: string;
  title?: string | null;
  providerId?: string | null;
  model?: string | null;
  visibility?: string | null;
  parentThreadId?: string | null;
  requestedBy?: string | null;
  priority?: number;
}

export class CapacityStore {
  constructor(private readonly db: Database.Database) {}

  enqueue(input: EnqueueInput, now: number): QueueRow {
    this.db
      .prepare(
        `INSERT INTO queued_spawns
           (id, created_at, updated_at, state, priority, project_id, prompt,
            title, provider_id, model, visibility, parent_thread_id,
            requested_by, attempts)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        input.id,
        now,
        now,
        input.priority ?? 0,
        input.projectId,
        input.prompt,
        input.title ?? null,
        input.providerId ?? null,
        input.model ?? null,
        input.visibility ?? null,
        input.parentThreadId ?? null,
        input.requestedBy ?? null,
      );
    return this.get(input.id)!;
  }

  get(id: string): QueueRow | null {
    const record = this.db
      .prepare(`SELECT * FROM queued_spawns WHERE id = ?`)
      .get(id) as QueueRecord | undefined;
    return record ? toQueueRow(record) : null;
  }

  /** Oldest queued rows, highest priority first. */
  nextQueued(limit: number): QueueRow[] {
    const records = this.db
      .prepare(
        `SELECT * FROM queued_spawns WHERE state = 'queued'
         ORDER BY priority DESC, created_at ASC LIMIT ?`,
      )
      .all(limit) as QueueRecord[];
    return records.map(toQueueRow);
  }

  queuedCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS total FROM queued_spawns WHERE state = 'queued'`)
      .get() as { total: number };
    return row.total;
  }

  /** Queue position of a row, counting from one. Zero when it is not queued. */
  position(id: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS ahead FROM queued_spawns AS other
         JOIN queued_spawns AS self ON self.id = ?
         WHERE other.state = 'queued'
           AND (other.priority > self.priority
                OR (other.priority = self.priority AND other.created_at <= self.created_at))`,
      )
      .get(id) as { ahead: number } | undefined;
    return row?.ahead ?? 0;
  }

  list(states: QueueState[], limit: number): QueueRow[] {
    const placeholders = states.map(() => "?").join(", ");
    const records = this.db
      .prepare(
        `SELECT * FROM queued_spawns WHERE state IN (${placeholders})
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...states, limit) as QueueRecord[];
    return records.map(toQueueRow);
  }

  settle(
    id: string,
    state: Exclude<QueueState, "queued">,
    now: number,
    detail: { threadId?: string | null; error?: string | null } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE queued_spawns
         SET state = ?, updated_at = ?, thread_id = ?, error = ?,
             attempts = attempts + 1
         WHERE id = ?`,
      )
      .run(state, now, detail.threadId ?? null, detail.error ?? null, id);
  }

  /** Cancel a row only while it is still waiting; returns whether it moved. */
  cancel(id: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE queued_spawns SET state = 'cancelled', updated_at = ?
         WHERE id = ? AND state = 'queued'`,
      )
      .run(now, id);
    return result.changes > 0;
  }

  recordSample(reading: CapacityReading): void {
    this.db
      .prepare(
        `INSERT INTO samples
           (taken_at, level, agent_load, active_threads, background_agents,
            memory_available_mb, swap_used_mb, load_per_core,
            event_loop_lag_ms, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reading.sample.takenAt,
        reading.level,
        reading.agentLoad,
        reading.count.activeThreads,
        reading.count.backgroundAgents,
        reading.sample.memoryAvailableMb,
        reading.sample.swapUsedMb,
        reading.sample.loadPerCore,
        reading.sample.eventLoopLagMs,
        [...reading.breached, ...reading.strained].join("; ") || null,
      );
  }

  recentSamples(limit: number): Array<Record<string, unknown>> {
    return this.db
      .prepare(`SELECT * FROM samples ORDER BY taken_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
  }

  raiseWarning(reading: CapacityReading, now: number): WarningRow {
    const result = this.db
      .prepare(
        `INSERT INTO warnings (raised_at, level, reasons, agent_load, cleared_at)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(
        now,
        reading.level,
        [...reading.breached, ...reading.strained].join("; "),
        reading.agentLoad,
      );
    return this.warning(Number(result.lastInsertRowid))!;
  }

  warning(id: number): WarningRow | null {
    const record = this.db
      .prepare(`SELECT * FROM warnings WHERE id = ?`)
      .get(id) as
      | {
          id: number;
          raised_at: number;
          level: string;
          reasons: string;
          agent_load: number;
          cleared_at: number | null;
        }
      | undefined;
    if (!record) return null;
    return {
      id: record.id,
      raisedAt: record.raised_at,
      level: record.level,
      reasons: record.reasons,
      agentLoad: record.agent_load,
      clearedAt: record.cleared_at,
    };
  }

  clearOpenWarnings(now: number): number {
    return this.db
      .prepare(`UPDATE warnings SET cleared_at = ? WHERE cleared_at IS NULL`)
      .run(now).changes;
  }

  recentWarnings(limit: number): WarningRow[] {
    const records = this.db
      .prepare(`SELECT * FROM warnings ORDER BY raised_at DESC LIMIT ?`)
      .all(limit) as Array<{
      id: number;
      raised_at: number;
      level: string;
      reasons: string;
      agent_load: number;
      cleared_at: number | null;
    }>;
    return records.map((record) => ({
      id: record.id,
      raisedAt: record.raised_at,
      level: record.level,
      reasons: record.reasons,
      agentLoad: record.agent_load,
      clearedAt: record.cleared_at,
    }));
  }

  recordShed(threadId: string, reason: string, now: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO shed_threads (thread_id, shed_at, reason)
         VALUES (?, ?, ?)`,
      )
      .run(threadId, now, reason);
  }

  recentShed(limit: number): Array<{ threadId: string; shedAt: number; reason: string }> {
    const records = this.db
      .prepare(`SELECT * FROM shed_threads ORDER BY shed_at DESC LIMIT ?`)
      .all(limit) as Array<{ thread_id: string; shed_at: number; reason: string }>;
    return records.map((record) => ({
      threadId: record.thread_id,
      shedAt: record.shed_at,
      reason: record.reason,
    }));
  }

  prune(before: number): void {
    this.db.prepare(`DELETE FROM samples WHERE taken_at < ?`).run(before);
    this.db.prepare(`DELETE FROM warnings WHERE cleared_at IS NOT NULL AND raised_at < ?`).run(before);
    this.db
      .prepare(`DELETE FROM queued_spawns WHERE state != 'queued' AND updated_at < ?`)
      .run(before);
    this.db.prepare(`DELETE FROM shed_threads WHERE shed_at < ?`).run(before);
  }
}
