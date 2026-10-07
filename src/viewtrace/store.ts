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
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize, contentHash } from './canonical.js';
import type {
  AnalysisReportV1,
  IncrementalAnalysisStateV1,
  JevCheckpointV2,
  JevResultV2,
} from './analysis-types.js';
import { assertLocalPath } from './paths.js';
import type { AnswerReceipt } from './answer.js';
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

export const DB_SCHEMA_VERSION = 2;

export type FaultPoint =
  'before-db-commit' | 'after-db-commit-before-jsonl' | 'mid-jsonl-write' | 'after-delete-commit';

export interface StoreOptions {
  readonly dataRoot: string;
  /** Deterministic clock for tests and reproducibility. */
  readonly now?: () => string;
  /** Test-only fault injection at commit boundaries. */
  readonly injectFault?: (point: FaultPoint) => Error | undefined;
  /** Read-only query connection: no recovery, no migration, no writes. */
  readonly readonly?: boolean;
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
      | 'STORE_CLOSED'
      | 'STORE_READ_ONLY',
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

const V2_DDL = `
CREATE TABLE answers (
  receipt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, answer_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, session_id TEXT, turn_id TEXT, answer_hash TEXT NOT NULL,
  timestamp TEXT NOT NULL, UNIQUE(run_id, answer_id)
);
CREATE INDEX answers_by_turn ON answers(agent_id, session_id, turn_id);
CREATE INDEX answers_by_run ON answers(run_id);
CREATE INDEX answers_by_time ON answers(timestamp DESC, receipt_id);
CREATE TABLE answer_events (
  receipt_id TEXT NOT NULL, event_id TEXT NOT NULL, scope TEXT NOT NULL,
  PRIMARY KEY(receipt_id, event_id)
);
CREATE INDEX answer_events_by_event ON answer_events(event_id,scope,receipt_id);
CREATE TABLE selections (
  selection_id INTEGER PRIMARY KEY, receipt_id TEXT, run_id TEXT NOT NULL, selected_at TEXT NOT NULL
);
CREATE TABLE retention (run_id TEXT PRIMARY KEY, keep INTEGER NOT NULL DEFAULT 0);
CREATE TABLE deleted_runs (run_id TEXT PRIMARY KEY);
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
    from: 1,
    to: 2,
    apply: (db) => {
      db.exec(`ALTER TABLE records RENAME TO records_v1;
      DROP INDEX records_by_sequence;
      CREATE TABLE records (
        run_id TEXT NOT NULL, record_kind TEXT NOT NULL CHECK(record_kind IN ('event','run','answer')),
        record_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload_hash TEXT NOT NULL, canonical TEXT NOT NULL,
        PRIMARY KEY(run_id,record_kind,record_id));
      INSERT INTO records SELECT * FROM records_v1;
      DROP TABLE records_v1;
      CREATE UNIQUE INDEX records_by_sequence ON records(run_id,sequence);`);
      db.exec(V2_DDL);
    },
  },
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
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
    { name: string } | undefined;
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
    const store = await ViewTraceStore.openInternal(options);
    return store as ViewTraceStore;
  }

  /**
   * Read-only query connection (CLI `runs`/`replay`/`open` while the
   * collector service owns writes). Readers never run recovery and never
   * create the data root. Returns null when no store exists yet.
   */
  static async openQuery(dataRoot: string): Promise<ViewTraceStore | null> {
    return ViewTraceStore.openInternal({ dataRoot, readonly: true });
  }

  private static async openInternal(options: StoreOptions): Promise<ViewTraceStore | null> {
    const store = new ViewTraceStore(options.dataRoot, options);
    const dbPath = join(options.dataRoot, 'viewtrace.db');
    await assertLocalPath(options.dataRoot, dbPath);
    for (const name of ['viewtrace.db-wal', 'viewtrace.db-shm', 'viewtrace.db-journal'])
      await assertLocalPath(options.dataRoot, join(options.dataRoot, name));

    if (options.readonly === true) {
      if (!existsSync(dbPath)) return null;
      const db = openDatabase(dbPath, true);
      try {
        db.exec('PRAGMA busy_timeout = 2500');
        const version = readVersion(db);
        if (version > DB_SCHEMA_VERSION) {
          throw new StoreError(
            'FUTURE_DB_VERSION',
            `database schema version ${version} is newer than supported ${DB_SCHEMA_VERSION}; refusing to open`,
          );
        }
        if (version < DB_SCHEMA_VERSION) {
          throw new StoreError(
            'MIGRATION_FAILED',
            `store schema v${version} requires migration; open it read-write once (viewtrace ingest or the collector service)`,
          );
        }
      } catch (e) {
        try {
          db.close();
        } catch {
          /* already closing */
        }
        throw e;
      }
      store.db = db;
      return store;
    }

    await mkdir(options.dataRoot, { recursive: true, mode: 0o700 });
    await chmodIfPosix(options.dataRoot, 0o700);
    for (const dir of ['runs', 'evidence', 'artifacts']) {
      const p = join(options.dataRoot, dir);
      await assertLocalPath(options.dataRoot, p);
      await mkdir(p, { recursive: true, mode: 0o700 });
      await chmodIfPosix(p, 0o700);
    }
    const existed = existsSync(dbPath);
    const db = openDatabase(dbPath, false);
    try {
      db.exec('PRAGMA busy_timeout = 2500');
      db.exec('PRAGMA synchronous = FULL');
      db.exec('PRAGMA foreign_keys = ON');
      if (!existed) {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec(V1_DDL);
          setVersion(db, 1);
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        migrate(db, 1);
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
    await store.recoverDeletions();
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

  private assertWritable(): void {
    if (this.options.readonly === true) {
      throw new StoreError(
        'STORE_READ_ONLY',
        'store is open read-only; writes require the collector service',
      );
    }
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

  async createRun(runId: string, info: { adapterId: string; adapterVersion: string }): Promise<RunState> {
    this.assertWritable();
    const db = this.requireDb();
    this.runDir(runId); // validate before any path use
    if (db.prepare('SELECT 1 FROM deleted_runs WHERE run_id = ?').get(runId))
      throw new StoreError('UNKNOWN_RUN', 'deleted run id cannot be reused');
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
    const row = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as unknown as RunRow | undefined;
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
    this.assertWritable();
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
    this.assertWritable();
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
          record.recordKind === 'event'
            ? record.eventId
            : record.recordKind === 'answer'
              ? record.receiptId
              : `run@${record.sequence}`;

        const existing = db
          .prepare(
            'SELECT sequence, payload_hash, canonical FROM records WHERE run_id = ? AND record_kind = ? AND record_id = ?',
          )
          .get(runId, record.recordKind, recordId) as
          { sequence: number; payload_hash: string; canonical: string } | undefined;
        if (existing !== undefined) {
          let existingHash = existing.payload_hash;
          if (existingHash === '') {
            // Row migrated from the experimental v0 layout: backfill its hash
            // from the stored canonical form so future receipts compare properly.
            existingHash = contentHash(JSON.parse(existing.canonical) as TraceRecord);
            db.prepare(
              'UPDATE records SET payload_hash = ? WHERE run_id = ? AND record_kind = ? AND record_id = ?',
            ).run(existingHash, runId, record.recordKind, recordId);
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
              severity: record.recordKind === 'answer' ? 'error' : 'warning',
              message: `record id received again with a different payload; original kept, duplicate isolated`,
              eventId: record.recordKind === 'event' ? record.eventId : undefined,
              runId,
            });
          }
          continue;
        }

        if (record.recordKind === 'answer') {
          const conflict = db
            .prepare('SELECT 1 FROM answers WHERE receipt_id = ? OR (run_id = ? AND answer_id = ?)')
            .get(record.receiptId, runId, record.answerId);
          if (conflict) {
            batchDiagnostics.push({
              code: 'RECEIPT_ID_CONFLICT',
              severity: 'error',
              message: 'receipt or answer identity already belongs to another record',
              runId,
            });
            continue;
          }
          db.prepare('INSERT INTO answers VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
            record.receiptId,
            runId,
            record.answerId,
            record.agentId,
            record.agentSessionId ?? null,
            record.turnId ?? null,
            record.answerHash,
            new Date(record.timestamp).toISOString(),
          );
          const link = db.prepare('INSERT INTO answer_events VALUES (?, ?, ?)');
          for (const id of record.eventIds ?? []) link.run(record.receiptId, id, 'own');
          for (const id of record.sharedEventIds ?? []) link.run(record.receiptId, id, 'shared');
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
              {
                lifecycle: record.lifecycle,
                at: record.occurredAt,
                sequence: record.sequence,
                observed: true,
              },
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
      await assertLocalPath(this.dataRoot, this.tracePath(runId));
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
      await assertLocalPath(this.dataRoot, path);
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
      await assertLocalPath(this.dataRoot, tmp);
      const handle = await open(tmp, 'w', 0o600);
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
      .prepare(
        'SELECT code, severity, message, line_index, byte_offset, event_id FROM diagnostics WHERE run_id = ? ORDER BY seq',
      )
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

  // M2 queries are bounded in SQL; revision is the complete canonical public response hash.
  pageRecords(
    runId: string,
    after: number,
    limit: number,
    receiptId?: string,
  ): { records: TraceRecord[]; nextCursor: number | null } {
    const sql =
      receiptId === undefined
        ? "SELECT canonical FROM records WHERE run_id = ? AND record_kind = 'event' AND sequence > ? ORDER BY sequence LIMIT ?"
        : "SELECT r.canonical FROM records r JOIN answer_events e ON e.event_id = r.record_id WHERE r.run_id = ? AND r.record_kind = 'event' AND r.sequence > ? AND e.receipt_id = ? ORDER BY r.sequence LIMIT ?";
    const stmt = this.requireDb().prepare(sql);
    const rows =
      receiptId === undefined
        ? stmt.iterate(runId, after, limit + 1)
        : stmt.iterate(runId, after, receiptId, limit + 1);
    const records: TraceRecord[] = [];
    let bytes = 0,
      more = false;
    for (const row of rows) {
      const canonical = row['canonical'] as string;
      const size = Buffer.byteLength(canonical, 'utf8');
      if (records.length >= limit || (records.length > 0 && bytes + size > 1024 * 1024)) {
        more = true;
        break;
      }
      bytes += size;
      records.push(JSON.parse(canonical) as TraceRecord);
    }
    return { records, nextCursor: more ? (records.at(-1)?.sequence ?? null) : null };
  }

  pageDiagnostics(runId: string, limit = 100): Diagnostic[] {
    const rows = this.requireDb()
      .prepare(
        'SELECT code,severity,message,line_index,byte_offset,event_id FROM diagnostics WHERE run_id = ? ORDER BY seq DESC LIMIT ?',
      )
      .all(runId, limit) as {
      code: string;
      severity: Diagnostic['severity'];
      message: string;
      line_index: number | null;
      byte_offset: number | null;
      event_id: string | null;
    }[];
    return rows.map((row) => ({
      code: row.code,
      severity: row.severity,
      message: row.message,
      lineIndex: row.line_index ?? undefined,
      byteOffset: row.byte_offset ?? undefined,
      eventId: row.event_id ?? undefined,
      runId,
    }));
  }

  countDiagnostics(runId: string): number {
    return (
      this.requireDb().prepare('SELECT COUNT(*) AS n FROM diagnostics WHERE run_id = ?').get(runId) as {
        n: number;
      }
    ).n;
  }

  recentRuns(limit = 50, offset = 0): RunState[] {
    return (
      this.requireDb()
        .prepare('SELECT * FROM runs ORDER BY updated_at DESC,run_id LIMIT ? OFFSET ?')
        .all(limit, offset) as unknown as RunRow[]
    ).map((row) => rowToState(this.requireDb(), row));
  }

  recentAnswers(limit = 50, offset = 0): AnswerReceipt[] {
    return this.answerRows('ORDER BY a.timestamp DESC,a.receipt_id LIMIT ? OFFSET ?', [limit, offset]);
  }

  private answerRows(suffix: string, params: (string | number)[]): AnswerReceipt[] {
    return (
      this.requireDb()
        .prepare(
          "SELECT r.canonical FROM answers a JOIN records r ON r.run_id=a.run_id AND r.record_kind='answer' AND r.record_id=a.receipt_id " +
            suffix,
        )
        .all(...params) as { canonical: string }[]
    ).map((row) => JSON.parse(row.canonical) as AnswerReceipt);
  }

  receiptConflicted(receipt: AnswerReceipt): boolean {
    return !!this.requireDb()
      .prepare(
        "SELECT 1 FROM duplicates WHERE run_id=? AND record_kind='answer' AND record_id=? AND kind='CONFLICTING' LIMIT 1",
      )
      .get(receipt.runId, receipt.receiptId);
  }
  getReceipt(id: string): AnswerReceipt | null {
    return this.answerRows('WHERE a.receipt_id = ?', [id])[0] ?? null;
  }
  getAnswer(runId: string, answerId: string): AnswerReceipt | null {
    return this.answerRows('WHERE a.run_id = ? AND a.answer_id = ?', [runId, answerId])[0] ?? null;
  }
  turnAnswers(agentId: string, session: string, turn: string): AnswerReceipt[] {
    return this.answerRows('WHERE a.agent_id = ? AND a.session_id = ? AND a.turn_id = ? LIMIT 2', [
      agentId,
      session,
      turn,
    ]);
  }

  answerScope(receipt: AnswerReceipt): {
    status: 'EXPLICIT' | 'UNKNOWN';
    missing: string[];
    missingCount: number;
    conflicts: number;
    eventCount: number;
  } {
    const db = this.requireDb();
    const missing = (
      db
        .prepare(
          "SELECT e.event_id FROM answer_events e LEFT JOIN records r ON r.run_id=? AND r.record_kind='event' AND r.record_id=e.event_id WHERE e.receipt_id=? AND r.record_id IS NULL LIMIT 100",
        )
        .all(receipt.runId, receipt.receiptId) as { event_id: string }[]
    ).map((row) => row.event_id);
    const missingCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM answer_events e LEFT JOIN records r ON r.run_id=? AND r.record_kind='event' AND r.record_id=e.event_id WHERE e.receipt_id=? AND r.record_id IS NULL",
        )
        .get(receipt.runId, receipt.receiptId) as { n: number }
    ).n;
    const conflicts = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM answer_events e JOIN answer_events other ON other.event_id=e.event_id AND other.scope='own' AND other.receipt_id<>e.receipt_id JOIN answers a ON a.receipt_id=other.receipt_id AND a.run_id=? WHERE e.receipt_id=? AND e.scope='own'",
        )
        .get(receipt.runId, receipt.receiptId) as { n: number }
    ).n;
    const eventCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM answer_events e JOIN records r ON r.run_id=? AND r.record_kind='event' AND r.record_id=e.event_id WHERE e.receipt_id=?",
        )
        .get(receipt.runId, receipt.receiptId) as { n: number }
    ).n;
    return {
      status: receipt.eventIds === undefined || missing.length > 0 || conflicts > 0 ? 'UNKNOWN' : 'EXPLICIT',
      missing,
      missingCount,
      conflicts,
      eventCount,
    };
  }

  hasSelection(id: number, receiptId: string, runId: string): boolean {
    return !!this.requireDb()
      .prepare('SELECT 1 FROM selections WHERE selection_id=? AND receipt_id=? AND run_id=?')
      .get(id, receiptId, runId);
  }

  select(receiptId: string | undefined, runId: string): number {
    this.assertWritable();
    if (!this.getRun(runId) || (receiptId && this.getReceipt(receiptId)?.runId !== runId))
      throw new StoreError('UNKNOWN_RUN', 'selection target missing');
    return Number(
      this.requireDb()
        .prepare('INSERT INTO selections(receipt_id,run_id,selected_at) VALUES (?,?,?)')
        .run(receiptId ?? null, runId, this.now()).lastInsertRowid,
    );
  }

  setKeep(runId: string, keep: boolean): void {
    this.assertWritable();
    if (!this.getRun(runId)) throw new StoreError('UNKNOWN_RUN', 'unknown retention target');
    this.requireDb()
      .prepare('INSERT OR REPLACE INTO retention VALUES (?,?)')
      .run(runId, keep ? 1 : 0);
  }
  isKept(runId: string): boolean {
    return (
      (
        this.requireDb().prepare('SELECT keep FROM retention WHERE run_id=?').get(runId) as
          { keep: number } | undefined
      )?.keep === 1
    );
  }

  /** DB tombstone commits first. Reopen finishes filesystem erasure without restoring receipts. */
  async deleteRun(runId: string): Promise<void> {
    this.assertWritable();
    const db = this.requireDb();
    const run = this.getRun(runId);
    if (!run) throw new StoreError('UNKNOWN_RUN', 'unknown delete target');
    if (run.lifecycle === 'RUNNING' || run.lifecycle === 'CREATED')
      throw new StoreError('DB_ERROR', 'active run cannot be deleted');
    for (const area of ['runs', 'live', 'artifacts', 'evidence'])
      await assertLocalPath(this.dataRoot, join(this.dataRoot, area, runId));
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        'DELETE FROM answer_events WHERE receipt_id IN (SELECT receipt_id FROM answers WHERE run_id=?)',
      ).run(runId);
      for (const table of [
        'answers',
        'selections',
        'retention',
        'records',
        'duplicates',
        'diagnostics',
        'runs',
      ])
        db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(runId);
      db.prepare('INSERT OR IGNORE INTO deleted_runs VALUES (?)').run(runId);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw wrapDbError(e);
    }
    const fault = this.options.injectFault?.('after-delete-commit');
    if (fault) throw fault;
    await this.recoverDeletions();
  }

  async pruneBefore(timestamp: string): Promise<string[]> {
    this.assertWritable();
    const targets = (
      this.requireDb()
        .prepare(
          "SELECT r.run_id FROM runs r LEFT JOIN retention k ON k.run_id=r.run_id WHERE r.updated_at < ? AND COALESCE(k.keep,0)=0 AND r.lifecycle NOT IN ('RUNNING','CREATED')",
        )
        .all(new Date(timestamp).toISOString()) as { run_id: string }[]
    ).map((row) => row.run_id);
    for (const id of targets) await this.deleteRun(id);
    return targets;
  }

  private async recoverDeletions(): Promise<void> {
    const rows = this.requireDb().prepare('SELECT run_id FROM deleted_runs').all() as { run_id: string }[];
    for (const row of rows)
      for (const area of ['runs', 'live', 'artifacts', 'evidence']) {
        const path = join(this.dataRoot, area, row.run_id);
        await assertLocalPath(this.dataRoot, path);
        await rm(path, { recursive: true, force: true });
      }
  }

  /** Raw derived JSONL bytes (sanitized canonical lines only). */
  async readTraceJsonl(runId: string): Promise<string> {
    await assertLocalPath(this.dataRoot, this.tracePath(runId));
    return readFile(this.tracePath(runId), 'utf8');
  }

  /* ------------------------------------------------------------------ */
  /* M3 Artifact persistence (atomic writes under <dataRoot>/artifacts)  */
  /* ------------------------------------------------------------------ */

  async saveAnalysisReport(report: AnalysisReportV1): Promise<void> {
    this.assertWritable();
    const runId = report.scope.runId;
    const answerId = report.scope.answerId;
    const dir = join(this.dataRoot, 'artifacts', runId, 'answers', answerId);
    await assertLocalPath(this.dataRoot, dir);
    await mkdir(dir, { recursive: true });
    await chmodIfPosix(dir, 0o700);
    const targetFile = join(dir, 'analysis-report.json');
    const tmpFile = join(dir, `.analysis-report.json.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmpFile, JSON.stringify(report, null, 2), 'utf8');
    await chmodIfPosix(tmpFile, 0o600);
    await renameWithOverride(tmpFile, targetFile);
  }

  /**
   * Distinguishes a missing artifact from a corrupt one: a corrupted report
   * is surfaced as `corrupt` (never silently treated as "never analyzed").
   */
  async loadAnalysisReport(
    runId: string,
    answerId?: string,
  ): Promise<
    | { kind: 'missing' }
    | { kind: 'ok'; report: AnalysisReportV1 }
    | { kind: 'corrupt'; error: string }
  > {
    const targetAnswerId = answerId ?? this.recentAnswers(100).find((a) => a.runId === runId)?.answerId;
    if (!targetAnswerId) return { kind: 'missing' };
    const file = join(this.dataRoot, 'artifacts', runId, 'answers', targetAnswerId, 'analysis-report.json');
    await assertLocalPath(this.dataRoot, file);
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      return { kind: 'missing' };
    }
    try {
      return { kind: 'ok', report: JSON.parse(content) as AnalysisReportV1 };
    } catch (e) {
      return { kind: 'corrupt', error: String(e) };
    }
  }

  async getAnalysisReport(runId: string, answerId?: string): Promise<AnalysisReportV1 | null> {
    const loaded = await this.loadAnalysisReport(runId, answerId);
    return loaded.kind === 'ok' ? loaded.report : null;
  }

  async saveAnalysisState(state: IncrementalAnalysisStateV1): Promise<void> {
    this.assertWritable();
    const scope = state.scopes[0];
    if (!scope) throw new StoreError('DB_ERROR', 'analysis state requires a scope');
    const dir = join(this.dataRoot, 'artifacts', scope.runId, 'answers', scope.answerId);
    await assertLocalPath(this.dataRoot, dir);
    await mkdir(dir, { recursive: true });
    await chmodIfPosix(dir, 0o700);
    const targetFile = join(dir, 'analysis-state.json');
    const tmpFile = join(dir, `.analysis-state.json.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmpFile, JSON.stringify(state, null, 2), 'utf8');
    await chmodIfPosix(tmpFile, 0o600);
    await renameWithOverride(tmpFile, targetFile);
  }

  async getAnalysisState(runId: string, answerId?: string): Promise<IncrementalAnalysisStateV1 | null> {
    const targetAnswerId = answerId ?? this.recentAnswers(100).find((a) => a.runId === runId)?.answerId;
    if (!targetAnswerId) return null;
    const file = join(this.dataRoot, 'artifacts', runId, 'answers', targetAnswerId, 'analysis-state.json');
    await assertLocalPath(this.dataRoot, file);
    try {
      const content = await readFile(file, 'utf8');
      return JSON.parse(content) as IncrementalAnalysisStateV1;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new StoreError('DB_ERROR', `corrupt analysis state for ${runId}/${targetAnswerId}: ${String(e)}`);
    }
  }

  /** Events of one run by explicit event ids (bounded SQL IN chunks). */
  getEventsByIds(runId: string, eventIds: readonly string[]): ViewTraceEvent[] {
    if (eventIds.length === 0) return [];
    const db = this.requireDb();
    const out: ViewTraceEvent[] = [];
    const stmt = db.prepare(
      "SELECT canonical FROM records WHERE run_id = ? AND record_kind = 'event' AND record_id = ?",
    );
    for (const id of eventIds) {
      const row = stmt.get(runId, id) as { canonical: string } | undefined;
      if (row) out.push(JSON.parse(row.canonical) as ViewTraceEvent);
    }
    return out;
  }

  /** All events of one run, sequence-ordered, without a page cap. */
  listRunEvents(runId: string): ViewTraceEvent[] {
    const out: ViewTraceEvent[] = [];
    let after = 0;
    for (;;) {
      const page = this.pageRecords(runId, after, 1000);
      for (const r of page.records) {
        if (r.recordKind === 'event') out.push(r as ViewTraceEvent);
      }
      if (page.nextCursor === null) break;
      after = page.nextCursor;
    }
    return out;
  }

  /** Cheap scoped extent for freshness checks (no event bodies read). */
  scopedEventStats(
    runId: string,
    receiptId?: string,
  ): { count: number; maxSequence: number } {
    const db = this.requireDb();
    if (receiptId === undefined) {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS n, COALESCE(MAX(sequence), 0) AS m FROM records WHERE run_id = ? AND record_kind = 'event'",
        )
        .get(runId) as { n: number; m: number };
      return { count: row.n, maxSequence: row.m };
    }
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(MAX(r.sequence), 0) AS m FROM records r JOIN answer_events e ON e.event_id = r.record_id WHERE r.run_id = ? AND r.record_kind = 'event' AND e.receipt_id = ?",
      )
      .get(runId, receiptId) as { n: number; m: number };
    return { count: row.n, maxSequence: row.m };
  }

  async saveJevCheckpoints(runId: string, checkpoints: readonly JevCheckpointV2[]): Promise<void> {
    this.assertWritable();
    const dir = join(this.dataRoot, 'artifacts', runId);
    await assertLocalPath(this.dataRoot, dir);
    await mkdir(dir, { recursive: true });
    await chmodIfPosix(dir, 0o700);
    const targetFile = join(dir, 'jev-checkpoints.json');
    const tmpFile = join(dir, `.jev-checkpoints.json.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmpFile, JSON.stringify(checkpoints, null, 2), 'utf8');
    await chmodIfPosix(tmpFile, 0o600);
    await renameWithOverride(tmpFile, targetFile);
  }

  async getJevCheckpoints(runId: string): Promise<readonly JevCheckpointV2[]> {
    const file = join(this.dataRoot, 'artifacts', runId, 'jev-checkpoints.json');
    await assertLocalPath(this.dataRoot, file);
    try {
      const content = await readFile(file, 'utf8');
      return JSON.parse(content) as JevCheckpointV2[];
    } catch {
      return [];
    }
  }

  async saveJevResults(runId: string, results: readonly JevResultV2[]): Promise<void> {
    this.assertWritable();
    const dir = join(this.dataRoot, 'artifacts', runId);
    await assertLocalPath(this.dataRoot, dir);
    await mkdir(dir, { recursive: true });
    await chmodIfPosix(dir, 0o700);
    const targetFile = join(dir, 'jev-results.json');
    const tmpFile = join(dir, `.jev-results.json.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmpFile, JSON.stringify(results, null, 2), 'utf8');
    await chmodIfPosix(tmpFile, 0o600);
    await renameWithOverride(tmpFile, targetFile);
  }

  async getJevResults(runId: string): Promise<readonly JevResultV2[]> {
    const file = join(this.dataRoot, 'artifacts', runId, 'jev-results.json');
    await assertLocalPath(this.dataRoot, file);
    try {
      const content = await readFile(file, 'utf8');
      return JSON.parse(content) as JevResultV2[];
    } catch {
      return [];
    }
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
  ).run(
    runId,
    seq,
    d.code,
    d.severity,
    d.message,
    d.lineIndex ?? null,
    d.byteOffset ?? null,
    d.eventId ?? null,
  );
}

function openDatabase(dbPath: string, readOnly: boolean): DatabaseSync {
  try {
    return new DatabaseSync(dbPath, { readOnly });
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
    { value: string } | undefined;
  if (row === undefined) {
    if (hasTable(db, 'vt_runs')) return 0;
    throw new StoreError('NOT_A_VIEWTRACE_DB', 'meta table exists but has no schema_version; refusing');
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
