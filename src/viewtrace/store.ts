/**
 * ViewTrace store — SQLite is authoritative, JSONL is the derived
 * replay/export representation (docs/MILESTONES.md §3.3).
 *
 * Commit/recovery contract (fixed in M0):
 *  1. All accepted records, diagnostics, duplicates, lifecycle transitions
 *     and the JSONL cursor are committed in ONE SQLite transaction
 *     (BEGIN IMMEDIATE … COMMIT, synchronous=FULL).
 *  2. Only after the DB commit are canonical lines appended to
 *     runs/<runId>/trace.jsonl and fsynced.
 *  3. Consequence: the DB may briefly be *ahead* of the JSONL. On open,
 *     recover() compares each run's trace.jsonl with the committed line count
 *     and rewrites the derived file from the records table when they differ
 *     (partial trailing line, missing lines, or extra garbage). The DB is
 *     never modified by recovery and never deleted implicitly.
 *
 * Data root layout (created 0700, files 0600 on POSIX; Windows limitations
 * are documented in SECURITY.md):
 *   <root>/viewtrace.db        authoritative SQLite store
 *   <root>/runs/<runId>/trace.jsonl   derived, minimized replay export
 *   <root>/evidence/ <root>/artifacts/  reserved for later milestones
 */

import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize, contentHash } from './canonical.js';
import { isValidRunId } from './validate.js';
import type {
  CollectionCompleteness,
  Diagnostic,
  DuplicateInfo,
  LifecycleTransition,
  LossRecord,
  ReplayResult,
  RunLifecycle,
  RunState,
  StoredRecord,
  TraceRecord,
  ViewTraceEvent,
} from './types.js';
import { RUN_TRANSITIONS } from './types.js';

export const DB_SCHEMA_VERSION = 1;

export type FaultPoint =
  | 'before-db-commit'
  | 'after-db-commit-before-jsonl'
  | 'mid-jsonl-write';

export interface StoreOptions {
  readonly dataRoot: string;
  /** Deterministic clock for tests and reproducibility. */
  readonly now?: () => string;
  /** Test-only fault injection at commit boundaries. */
  readonly injectFault?: (point: FaultPoint) => Error | undefined;
}

export interface AppendResult {
  readonly accepted: readonly StoredRecord[];
  readonly duplicates: readonly DuplicateInfo[];
  readonly diagnosticsAdded: number;
  /** Set when the DB commit succeeded but the derived JSONL write failed. */
  readonly jsonlWriteError?: { readonly code: string; readonly message: string };
}

export interface RecoveryAction {
  readonly runId: string;
  readonly expectedLines: number;
  readonly actualLines: number;
  readonly action: 'none' | 'rewritten';
}

export interface RecoveryReport {
  readonly actions: readonly RecoveryAction[];
}

export class StoreError extends Error {
  override readonly cause: unknown;

  constructor(
    readonly code:
      | 'INVALID_RUN_ID'
      | 'UNKNOWN_RUN'
      | 'FUTURE_DB_VERSION'
      | 'NOT_A_VIEWTRACE_DB'
      | 'MIGRATION_FAILED'
      | 'DB_ERROR'
      | 'DB_BUSY'
      | 'DB_READ_ONLY'
      | 'STORE_CLOSED',
    message: string,
    cause?: unknown,
  ) {
    super(`${code}: ${message}`);
    this.name = 'StoreError';
    this.cause = cause;
  }
}

const V1_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  completeness TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  jsonl_cursor INTEGER NOT NULL,
  jsonl_lines INTEGER NOT NULL,
  lifecycle_history TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  run_id TEXT NOT NULL,
  record_kind TEXT NOT NULL CHECK (record_kind IN ('event','run')),
  record_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  canonical TEXT NOT NULL,
  PRIMARY KEY (run_id, record_kind, record_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS records_by_sequence ON records (run_id, sequence);
CREATE TABLE IF NOT EXISTS duplicates (
  run_id TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('IDEMPOTENT','CONFLICTING')),
  first_sequence INTEGER NOT NULL,
  duplicate_sequence INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  canonical TEXT,
  PRIMARY KEY (run_id, record_kind, record_id, duplicate_sequence)
);
CREATE TABLE IF NOT EXISTS diagnostics (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  line_index INTEGER,
  byte_offset INTEGER,
  event_id TEXT,
  PRIMARY KEY (run_id, seq)
);
`;

interface Migration {
  from: number;
  to: number;
  apply: (db: DatabaseSync) => void;
}

/**
 * Version 0 is the pre-contract experimental layout (vt_runs/vt_events),
 * only ever produced by development databases — no released v0 exists.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    from: 0,
    to: 1,
    apply: (db) => {
      db.exec(V1_DDL);
      if (hasTable(db, 'vt_runs')) {
        const runs = db.prepare('SELECT run_id, created_at FROM vt_runs').all() as Array<{
          run_id: string;
          created_at: string;
        }>;
        const insertRun = db.prepare(
          `INSERT OR IGNORE INTO runs
             (run_id, adapter_id, adapter_version, lifecycle, completeness,
              created_at, updated_at, jsonl_cursor, jsonl_lines, lifecycle_history)
           VALUES (?, 'unknown', 'unknown', 'UNKNOWN', 'UNKNOWN', ?, ?, 0, 0, '[]')`,
        );
        for (const row of runs) {
          insertRun.run(row.run_id, row.created_at, row.created_at);
        }
        const events = db
          .prepare('SELECT run_id, event_id, data FROM vt_events ORDER BY rowid')
          .all() as Array<{ run_id: string; event_id: string; data: string }>;
        const insertEvent = db.prepare(
          `INSERT OR IGNORE INTO records
             (run_id, record_kind, record_id, sequence, payload_hash, canonical)
           VALUES (?, 'event', ?, ?, ?, ?)`,
        );
        let seq = 0;
        for (const row of events) {
          seq += 1;
          insertEvent.run(row.run_id, row.event_id, seq, '', row.data);
          db.prepare('UPDATE runs SET jsonl_lines = jsonl_lines + 1 WHERE run_id = ?').run(row.run_id);
        }
      }
    },
  },
];

function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

export class ViewTraceStore {
  private db: DatabaseSync | null = null;
  private readonly now: () => string;

  private constructor(
    readonly dataRoot: string,
    private readonly options: StoreOptions,
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  static async open(options: StoreOptions): Promise<ViewTraceStore> {
    const store = new ViewTraceStore(options.dataRoot, options);
    await mkdir(options.dataRoot, { recursive: true, mode: 0o700 });
    await chmodIfPosix(options.dataRoot, 0o700);
    for (const dir of ['runs', 'evidence', 'artifacts']) {
      const p = join(options.dataRoot, dir);
      await mkdir(p, { recursive: true, mode: 0o700 });
      await chmodIfPosix(p, 0o700);
    }
    const dbPath = join(options.dataRoot, 'viewtrace.db');
    const existed = existsSync(dbPath);
    const db = openDatabase(dbPath);
    try {
      db.exec('PRAGMA busy_timeout = 2500');
      db.exec('PRAGMA synchronous = FULL');
      db.exec('PRAGMA foreign_keys = ON');
      if (!existed) {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec(V1_DDL);
          setVersion(db, DB_SCHEMA_VERSION);
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      } else {
        const version = readVersion(db);
        if (version > DB_SCHEMA_VERSION) {
          throw new StoreError(
            'FUTURE_DB_VERSION',
            `database schema version ${version} is newer than supported ${DB_SCHEMA_VERSION}; refusing to open`,
          );
        }
        if (version < DB_SCHEMA_VERSION) {
          migrate(db, version);
        }
      }
    } catch (e) {
      try {
        db.close();
      } catch {
        /* already closing */
      }
      throw e;
    }
    await chmodIfPosix(dbPath, 0o600);
    store.db = db;
    await store.recover();
    return store;
  }

  async close(): Promise<void> {
    if (this.db !== null) {
      this.db.close();
      this.db = null;
    }
  }

  private requireDb(): DatabaseSync {
    if (this.db === null) throw new StoreError('STORE_CLOSED', 'store is closed');
    return this.db;
  }

  private runDir(runId: string): string {
    if (!isValidRunId(runId)) {
      throw new StoreError('INVALID_RUN_ID', 'run id is not filesystem-safe');
    }
    return join(this.dataRoot, 'runs', runId);
  }

  private tracePath(runId: string): string {
    return join(this.runDir(runId), 'trace.jsonl');
  }

  /* ---------------------------------------------------------------- */
  /* Runs                                                              */
  /* ---------------------------------------------------------------- */

  async createRun(
    runId: string,
    info: { adapterId: string; adapterVersion: string },
  ): Promise<RunState> {
    const db = this.requireDb();
    this.runDir(runId); // validate before any path use
    const now = this.now();
    try {
      db.prepare(
        `INSERT OR IGNORE INTO runs
           (run_id, adapter_id, adapter_version, lifecycle, completeness,
            created_at, updated_at, jsonl_cursor, jsonl_lines, lifecycle_history)
         VALUES (?, ?, ?, 'UNKNOWN', 'UNKNOWN', ?, ?, 0, 0, '[]')`,
      ).run(runId, info.adapterId, info.adapterVersion, now, now);
    } catch (e) {
      throw wrapDbError(e);
    }
    const state = this.getRun(runId);
    if (state === null) throw new StoreError('DB_ERROR', 'run row missing after insert');
    return state;
  }

  getRun(runId: string): RunState | null {
    const db = this.requireDb();
    const row = db
      .prepare('SELECT * FROM runs WHERE run_id = ?')
      .get(runId) as unknown as RunRow | undefined;
    if (row === undefined) return null;
    return rowToState(db, row);
  }

  listRuns(): RunState[] {
    const db = this.requireDb();
    const rows = db.prepare('SELECT * FROM runs ORDER BY run_id').all() as unknown as RunRow[];
    return rows.map((row) => rowToState(db, row));
  }

  /** Explicit completeness judgement; losses are never hidden upstream. */
  async setCompleteness(runId: string, completeness: CollectionCompleteness): Promise<RunState> {
    const db = this.requireDb();
    try {
      const changes = db
        .prepare('UPDATE runs SET completeness = ?, updated_at = ? WHERE run_id = ?')
        .run(completeness, this.now(), runId).changes;
      if (changes === 0) throw new StoreError('UNKNOWN_RUN', `run not found: ${runId}`);
    } catch (e) {
      if (e instanceof StoreError) throw e;
      throw wrapDbError(e);
    }
    const state = this.getRun(runId);
    if (state === null) throw new StoreError('DB_ERROR', 'run row missing after update');
    return state;
  }

  /* ---------------------------------------------------------------- */
  /* Record append (the dual-write commit path)                        */
  /* ---------------------------------------------------------------- */

  /**
   * Appends fully validated, collector-stamped records (sequence/receivedAt
   * assigned by the caller). Throws on DB-level failure (nothing committed);
   * a JSONL failure after a successful DB commit is reported through
   * `jsonlWriteError` so callers can surface it honestly.
   */
  async appendRecords(
    runId: string,
    records: readonly TraceRecord[],
    diagnostics: readonly Diagnostic[] = [],
    byteCursor = 0,
  ): Promise<AppendResult> {
    const db = this.requireDb();
    for (const record of records) {
      if (record.runId !== runId) {
        throw new StoreError('UNKNOWN_RUN', 'append batch mixes run ids; append per run only');
      }
    }
    const accepted: StoredRecord[] = [];
    const duplicates: DuplicateInfo[] = [];
    const batchDiagnostics: Diagnostic[] = [...diagnostics];

    let inTransaction = false;
    let history: LifecycleTransition[] = [];
    let lifecycle: RunLifecycle = 'UNKNOWN';
    let jsonlLines = 0;
    try {
      const run = this.getRun(runId);
      if (run === null) throw new StoreError('UNKNOWN_RUN', `run not found: ${runId}`);
      history = [...run.lifecycleHistory];
      lifecycle = run.lifecycle;
      jsonlLines = run.jsonlLines;

      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;

      const insertRecord = db.prepare(
        `INSERT INTO records (run_id, record_kind, record_id, sequence, payload_hash, canonical)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insertDuplicate = db.prepare(
        `INSERT INTO duplicates
           (run_id, record_kind, record_id, kind, first_sequence, duplicate_sequence,
            payload_hash, canonical)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const record of records) {
        const canonical = canonicalize(record);
        // The records table stores the CONTENT hash (collector envelope
        // excluded) — that is what duplicate detection compares.
        const content = contentHash(record);
        const recordId =
          record.recordKind === 'event' ? record.eventId : `run@${record.sequence}`;

        const existing = db
          .prepare('SELECT sequence, payload_hash, canonical FROM records WHERE run_id = ? AND record_kind = ? AND record_id = ?')
          .get(runId, record.recordKind, recordId) as
          | { sequence: number; payload_hash: string; canonical: string }
          | undefined;
        if (existing !== undefined) {
          let existingHash = existing.payload_hash;
          if (existingHash === '') {
            // Row migrated from the experimental v0 layout: backfill its hash
            // from the stored canonical form so future receipts compare properly.
            existingHash = contentHash(JSON.parse(existing.canonical) as TraceRecord);
            db.prepare('UPDATE records SET payload_hash = ? WHERE run_id = ? AND record_kind = ? AND record_id = ?')
              .run(existingHash, runId, record.recordKind, recordId);
          }
          const duplicateKind = existingHash === content ? 'IDEMPOTENT' : 'CONFLICTING';
          insertDuplicate.run(
            runId,
            record.recordKind,
            recordId,
            duplicateKind,
            existing.sequence,
            record.sequence,
            content,
            duplicateKind === 'CONFLICTING' ? canonical : null,
          );
          duplicates.push({
            recordKind: record.recordKind,
            recordId,
            kind: duplicateKind,
            firstSequence: existing.sequence,
            duplicateSequence: record.sequence,
            payloadHash: content,
          });
          if (duplicateKind === 'CONFLICTING') {
            batchDiagnostics.push({
              code: 'DUPLICATE_CONFLICTING',
              severity: 'warning',
              message: `record id received again with a different payload; original kept, duplicate isolated`,
              eventId: record.recordKind === 'event' ? record.eventId : undefined,
              runId,
            });
          }
          continue;
        }

        if (record.recordKind === 'run') {
          const allowed = RUN_TRANSITIONS[lifecycle].includes(record.lifecycle);
          if (!allowed) {
            batchDiagnostics.push({
              code: 'RUN_TRANSITION_INVALID',
              severity: 'warning',
              message: `run lifecycle transition ${lifecycle} -> ${record.lifecycle} is not allowed; observation stored, lifecycle unchanged`,
              runId,
            });
          } else {
            lifecycle = record.lifecycle;
            history = [
              ...history,
              { lifecycle: record.lifecycle, at: record.occurredAt, sequence: record.sequence, observed: true },
            ];
          }
        }

        insertRecord.run(runId, record.recordKind, recordId, record.sequence, content, canonical);
        jsonlLines += 1;
        accepted.push({
          runId,
          recordKind: record.recordKind,
          recordId,
          sequence: record.sequence,
          payloadHash: content,
          record,
        });
      }

      let diagSeq = (
        db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM diagnostics WHERE run_id = ?').get(runId) as {
          m: number;
        }
      ).m;
      for (const d of batchDiagnostics) {
        diagSeq += 1;
        insertDiagnostic(db, runId, diagSeq, d);
      }

      db.prepare(
        'UPDATE runs SET lifecycle = ?, lifecycle_history = ?, updated_at = ?, jsonl_cursor = ?, jsonl_lines = ? WHERE run_id = ?',
      ).run(lifecycle, JSON.stringify(history), this.now(), byteCursor, jsonlLines, runId);

      const fault = this.options.injectFault?.('before-db-commit');
      if (fault !== undefined) throw fault;
      db.exec('COMMIT');
      inTransaction = false;
    } catch (e) {
      if (inTransaction) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* connection already rolled back by close */
        }
      }
      if (e instanceof StoreError) throw e;
      throw wrapDbError(e);
    }

    const postCommitFault = this.options.injectFault?.('after-db-commit-before-jsonl');
    if (postCommitFault !== undefined) {
      throw postCommitFault; // DB committed; JSONL repair happens on next open
    }

    const jsonlWriteError = await this.appendJsonl(runId, accepted);

    return { accepted, duplicates, diagnosticsAdded: batchDiagnostics.length, jsonlWriteError };
  }

  /**
   * Appends canonical lines for newly accepted records. Fault point
   * 'mid-jsonl-write' leaves a partial line on purpose (recovery truncates).
   */
  private async appendJsonl(
    runId: string,
    accepted: readonly StoredRecord[],
  ): Promise<AppendResult['jsonlWriteError']> {
    if (accepted.length === 0) return undefined;
    const dir = this.runDir(runId);
    let handle = null as Awaited<ReturnType<typeof open>> | null;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      handle = await open(this.tracePath(runId), 'a');
      await chmodIfPosix(this.tracePath(runId), 0o600);
      const firstLine = canonicalize(accepted[0]?.record) + '\n';
      const midWriteFault = this.options.injectFault?.('mid-jsonl-write');
      if (midWriteFault !== undefined) {
        await handle.write(firstLine.slice(0, Math.max(1, Math.floor(firstLine.length / 2))));
        await handle.sync();
        throw midWriteFault;
      }
      for (const stored of accepted) {
        await handle.write(canonicalize(stored.record) + '\n');
      }
      await handle.sync();
      return undefined;
    } catch (e) {
      return {
        code: 'JSONL_WRITE_FAILED',
        message: e instanceof Error ? e.message : String(e),
      };
    } finally {
      if (handle !== null) await handle.close();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Recovery                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Brings every run's derived trace.jsonl back in sync with the committed
   * records. The DB is authoritative and is never modified here.
   */
  async recover(): Promise<RecoveryReport> {
    const db = this.requireDb();
    const actions: RecoveryAction[] = [];
    const rows = db.prepare('SELECT run_id, jsonl_lines FROM runs').all() as Array<{
      run_id: string;
      jsonl_lines: number;
    }>;
    for (const row of rows) {
      const expected = row.jsonl_lines;
      const path = this.tracePath(row.run_id);
      let actual = 0;
      let partialTail = false;
      let needsRewrite = false;
      // Only regular files are readable safely: a device/fifo at the trace
      // path (fault injection or sabotage) must be replaced, not streamed.
      const info = await stat(path).catch(() => null);
      if (info !== null && !info.isFile()) {
        needsRewrite = true;
      } else if (info !== null) {
        const bytes = await readFile(path);
        for (const b of bytes) if (b === 0x0a) actual += 1;
        partialTail = bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a;
      }
      if (!needsRewrite && !partialTail && actual === expected && (expected > 0 || info === null)) {
        actions.push({ runId: row.run_id, expectedLines: expected, actualLines: actual, action: 'none' });
        continue;
      }
      const canonicalLines = (
        db
          .prepare('SELECT canonical FROM records WHERE run_id = ? ORDER BY sequence')
          .all(row.run_id) as Array<{ canonical: string }>
      ).map((r) => r.canonical + '\n');
      await mkdir(this.runDir(row.run_id), { recursive: true, mode: 0o700 });
      const tmp = this.tracePath(row.run_id) + '.repair.tmp';
      const handle = await open(tmp, 'w');
      try {
        for (const line of canonicalLines) await handle.write(line);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rm(this.tracePath(row.run_id), { force: true });
      await renameWithOverride(tmp, this.tracePath(row.run_id));
      await chmodIfPosix(this.tracePath(row.run_id), 0o600);
      actions.push({ runId: row.run_id, expectedLines: expected, actualLines: actual, action: 'rewritten' });
    }
    return { actions };
  }

  /* ---------------------------------------------------------------- */
  /* Reads                                                             */
  /* ---------------------------------------------------------------- */

  listRecords(runId: string): StoredRecord[] {
    const db = this.requireDb();
    const rows = db
      .prepare(
        'SELECT run_id, record_kind, record_id, sequence, payload_hash, canonical FROM records WHERE run_id = ? ORDER BY sequence',
      )
      .all(runId) as Array<{
      run_id: string;
      record_kind: string;
      record_id: string;
      sequence: number;
      payload_hash: string;
      canonical: string;
    }>;
    return rows.map((row) => ({
      runId: row.run_id,
      recordKind: row.record_kind as StoredRecord['recordKind'],
      recordId: row.record_id,
      sequence: row.sequence,
      payloadHash: row.payload_hash,
      record: JSON.parse(row.canonical) as TraceRecord,
    }));
  }

  listEvents(runId: string): ViewTraceEvent[] {
    return this.listRecords(runId)
      .filter((r) => r.recordKind === 'event')
      .map((r) => r.record as ViewTraceEvent);
  }

  listDiagnostics(runId: string): Diagnostic[] {
    const db = this.requireDb();
    const rows = db
      .prepare('SELECT code, severity, message, line_index, byte_offset, event_id FROM diagnostics WHERE run_id = ? ORDER BY seq')
      .all(runId) as Array<{
      code: string;
      severity: string;
      message: string;
      line_index: number | null;
      byte_offset: number | null;
      event_id: string | null;
    }>;
    return rows.map((row) => ({
      code: row.code,
      severity: row.severity as Diagnostic['severity'],
      message: row.message,
      lineIndex: row.line_index ?? undefined,
      byteOffset: row.byte_offset ?? undefined,
      eventId: row.event_id ?? undefined,
      runId,
    }));
  }

  listDuplicates(runId: string): DuplicateInfo[] {
    const db = this.requireDb();
    const rows = db
      .prepare(
        'SELECT record_kind, record_id, kind, first_sequence, duplicate_sequence, payload_hash FROM duplicates WHERE run_id = ? ORDER BY duplicate_sequence',
      )
      .all(runId) as Array<{
      record_kind: string;
      record_id: string;
      kind: string;
      first_sequence: number;
      duplicate_sequence: number;
      payload_hash: string;
    }>;
    return rows.map((row) => ({
      recordKind: row.record_kind as DuplicateInfo['recordKind'],
      recordId: row.record_id,
      kind: row.kind as DuplicateInfo['kind'],
      firstSequence: row.first_sequence,
      duplicateSequence: row.duplicate_sequence,
      payloadHash: row.payload_hash,
    }));
  }

  replay(runId: string): ReplayResult | null {
    const run = this.getRun(runId);
    if (run === null) return null;
    return {
      run,
      records: this.listRecords(runId),
      diagnostics: this.listDiagnostics(runId),
      duplicates: this.listDuplicates(runId),
    };
  }

  /** Raw derived JSONL bytes (sanitized canonical lines only). */
  async readTraceJsonl(runId: string): Promise<string> {
    return readFile(this.tracePath(runId), 'utf8');
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

interface RunRow {
  run_id: string;
  adapter_id: string;
  adapter_version: string;
  lifecycle: string;
  completeness: string;
  created_at: string;
  updated_at: string;
  jsonl_cursor: number;
  jsonl_lines: number;
  lifecycle_history: string;
}

function rowToState(db: DatabaseSync, row: RunRow): RunState {
  const count = (
    db
      .prepare("SELECT COUNT(*) AS c FROM records WHERE run_id = ? AND record_kind = 'event'")
      .get(row.run_id) as { c: number }
  ).c;
  return {
    runId: row.run_id,
    adapterId: row.adapter_id,
    adapterVersion: row.adapter_version,
    lifecycle: row.lifecycle as RunLifecycle,
    completeness: row.completeness as CollectionCompleteness,
    // No analyzer exists before M3; support is honestly UNKNOWN.
    evidenceSupport: 'UNKNOWN',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    eventCount: count,
    jsonlCursor: row.jsonl_cursor,
    jsonlLines: row.jsonl_lines,
    lifecycleHistory: parseHistory(row.lifecycle_history),
  };
}

function parseHistory(json: string): LifecycleTransition[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed as LifecycleTransition[];
}

function insertDiagnostic(db: DatabaseSync, runId: string, seq: number, d: Diagnostic): void {
  db.prepare(
    `INSERT INTO diagnostics (run_id, seq, code, severity, message, line_index, byte_offset, event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, seq, d.code, d.severity, d.message, d.lineIndex ?? null, d.byteOffset ?? null, d.eventId ?? null);
}

function openDatabase(dbPath: string): DatabaseSync {
  try {
    return new DatabaseSync(dbPath);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/readonly|SQLITE_READONLY/i.test(message)) {
      throw new StoreError('DB_READ_ONLY', 'database file is not writable', e);
    }
    if (/SQLITE_CANTOPEN|permission|EACCES/i.test(message)) {
      throw new StoreError('DB_READ_ONLY', 'database file cannot be opened for writing', e);
    }
    throw new StoreError('DB_ERROR', `cannot open database: ${message}`, e);
  }
}

function wrapDbError(e: unknown): StoreError {
  if (e instanceof StoreError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (/SQLITE_BUSY|database is locked/i.test(message)) {
    return new StoreError('DB_BUSY', 'database is locked by another writer', e);
  }
  if (/SQLITE_READONLY|readonly/i.test(message)) {
    return new StoreError('DB_READ_ONLY', 'database is read-only', e);
  }
  if (/ENOSPC|no space left/i.test(message)) {
    return new StoreError('DB_ERROR', 'no space left while writing', e);
  }
  return new StoreError('DB_ERROR', message, e);
}

function setVersion(db: DatabaseSync, version: number): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(version));
}

function readVersion(db: DatabaseSync): number {
  if (!hasTable(db, 'meta')) {
    if (hasTable(db, 'vt_runs')) return 0;
    throw new StoreError(
      'NOT_A_VIEWTRACE_DB',
      'file exists but is not a ViewTrace database (no meta table); refusing to initialize over it',
    );
  }
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (row === undefined) {
    if (hasTable(db, 'vt_runs')) return 0;
    throw new StoreError('NOT_A_VIEWTRACE_DB', "meta table exists but has no schema_version; refusing");
  }
  const version = Number(row.value);
  if (!Number.isInteger(version) || version < 0) {
    throw new StoreError('NOT_A_VIEWTRACE_DB', `invalid schema_version value: ${row.value}`);
  }
  return version;
}

function migrate(db: DatabaseSync, fromVersion: number): void {
  let version = fromVersion;
  while (version < DB_SCHEMA_VERSION) {
    const migration = MIGRATIONS.find((m) => m.from === version);
    if (migration === undefined) {
      throw new StoreError('MIGRATION_FAILED', `no migration registered from version ${version}`);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.apply(db);
      setVersion(db, migration.to);
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* nothing to roll back */
      }
      throw new StoreError(
        'MIGRATION_FAILED',
        `migration ${migration.from} -> ${migration.to} failed and was rolled back: ${
          e instanceof Error ? e.message : String(e)
        }`,
        e,
      );
    }
    version = migration.to;
  }
}

async function chmodIfPosix(path: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    await chmod(path, mode);
  } catch {
    /* best effort: permission hardening never masks a functional result */
  }
}

async function renameWithOverride(from: string, to: string): Promise<void> {
  await rm(to, { force: true });
  await rename(from, to);
}
