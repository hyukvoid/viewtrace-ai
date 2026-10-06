import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ViewTraceStore, StoreError } from '../src/viewtrace/store.js';
import type { FaultPoint } from '../src/viewtrace/store.js';
import { canonicalize } from '../src/viewtrace/canonical.js';
import {
  FIXED_NOW,
  makeEvent,
  makeRunRecord,
  tempDataRoot,
  viewtraceFixture,
} from './helpers/viewtrace.js';

async function openStore(root: string, extra: { injectFault?: (point: FaultPoint) => Error | undefined } = {}) {
  return ViewTraceStore.open({ dataRoot: root, now: FIXED_NOW, ...extra });
}

function threeEvents(runId = 'run-test-001'): ReturnType<typeof makeEvent>[] {
  return [
    makeEvent({ eventId: 'e1', runId, sequence: 1, payload: { type: 'SEARCH', query: '쿼리1', results: [] } }),
    makeEvent({ eventId: 'e2', runId, sequence: 2, payload: { type: 'READ', sourceId: 's1', outcome: 'SUCCESS' } }),
    makeEvent({ eventId: 'e3', runId, sequence: 3, payload: { type: 'CLAIM', text: '주장' } }),
  ];
}

describe('viewtrace store: open, layout and permissions', () => {
  it('creates the data root layout with restrictive permissions (POSIX)', async () => {
    const root = await tempDataRoot('layout');
    const store = await openStore(root);
    await store.close();
    assert.ok(existsSync(join(root, 'viewtrace.db')));
    assert.ok(existsSync(join(root, 'runs')));
    assert.ok(existsSync(join(root, 'evidence')));
    assert.ok(existsSync(join(root, 'artifacts')));
    if (process.platform !== 'win32') {
      assert.equal((await stat(root)).mode & 0o777, 0o700);
      assert.equal((await stat(join(root, 'viewtrace.db'))).mode & 0o777, 0o600);
      assert.equal((await stat(join(root, 'runs'))).mode & 0o777, 0o700);
    }
  });

  it('is idempotent across repeated reopens and never deletes data implicitly', async () => {
    const root = await tempDataRoot('reopen');
    const store = await openStore(root);
    await store.createRun('run-reopen', { adapterId: 'a', adapterVersion: '1' });
    await store.appendRecords('run-reopen', threeEvents('run-reopen'));
    await store.close();
    for (let i = 0; i < 3; i++) {
      const again = await openStore(root);
      const run = again.getRun('run-reopen');
      assert.ok(run !== null);
      assert.equal(run.eventCount, 3);
      assert.equal(again.listEvents('run-reopen').length, 3);
      await again.close();
    }
  });

  it('refuses to open a foreign SQLite file as a ViewTrace database', async () => {
    const root = await tempDataRoot('foreign');
    const db = new DatabaseSync(join(root, 'viewtrace.db'));
    db.exec('CREATE TABLE other (x)');
    db.close();
    await assert.rejects(() => openStore(root), (e: unknown) => {
      assert.ok(e instanceof StoreError);
      assert.equal(e.code, 'NOT_A_VIEWTRACE_DB');
      return true;
    });
  });

  it('refuses a future database schema version without touching it', async () => {
    const root = await tempDataRoot('future');
    const db = new DatabaseSync(join(root, 'viewtrace.db'));
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare("INSERT INTO meta VALUES ('schema_version', '99')").run();
    db.close();
    await assert.rejects(() => openStore(root), (e: unknown) => {
      assert.ok(e instanceof StoreError);
      assert.equal(e.code, 'FUTURE_DB_VERSION');
      return true;
    });
    const check = new DatabaseSync(join(root, 'viewtrace.db'), { readOnly: true });
    assert.equal(
      (check.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value,
      '99',
    );
    check.close();
  });
});

describe('viewtrace store: runs, events and duplicates', () => {
  it('creates runs with UNKNOWN lifecycle and empty history, then applies transitions', async () => {
    const root = await tempDataRoot('lifecycle');
    const store = await openStore(root);
    await store.createRun('run-life', { adapterId: 'a', adapterVersion: '1' });
    const initial = store.getRun('run-life');
    assert.ok(initial !== null);
    assert.equal(initial.lifecycle, 'UNKNOWN');
    assert.equal(initial.completeness, 'UNKNOWN');
    assert.equal(initial.evidenceSupport, 'UNKNOWN', 'no analyzer exists before M3');

    await store.appendRecords('run-life', [
      makeRunRecord({ runId: 'run-life', lifecycle: 'RUNNING', sequence: 1 }),
      makeRunRecord({ runId: 'run-life', lifecycle: 'COMPLETED', sequence: 2 }),
    ]);
    const done = store.getRun('run-life');
    assert.equal(done?.lifecycle, 'COMPLETED');
    assert.equal(done?.lifecycleHistory.length, 2);
    await store.close();
  });

  it('rejects an invalid lifecycle transition but keeps the observation', async () => {
    const root = await tempDataRoot('badtrans');
    const store = await openStore(root);
    await store.createRun('run-bad', { adapterId: 'a', adapterVersion: '1' });
    await store.appendRecords('run-bad', [
      makeRunRecord({ runId: 'run-bad', lifecycle: 'COMPLETED', sequence: 1 }),
      makeRunRecord({ runId: 'run-bad', lifecycle: 'RUNNING', sequence: 2 }),
    ]);
    const run = store.getRun('run-bad');
    assert.equal(run?.lifecycle, 'COMPLETED', 'terminal state must not regress');
    assert.ok(store.listDiagnostics('run-bad').some((d) => d.code === 'RUN_TRANSITION_INVALID'));
    assert.equal(store.listRecords('run-bad').length, 2, 'both run lines remain stored as observations');
    await store.close();
  });

  it('treats a re-receipt with identical content as idempotent', async () => {
    const root = await tempDataRoot('idem');
    const store = await openStore(root);
    await store.createRun('run-idem', { adapterId: 'a', adapterVersion: '1' });
    const first = makeEvent({ eventId: 'e1', runId: 'run-idem', sequence: 1 });
    const second = makeEvent({ eventId: 'e1', runId: 'run-idem', sequence: 2, receivedAt: '2026-10-06T00:00:09.000Z' });
    const result = await store.appendRecords('run-idem', [first, second]);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.duplicates.length, 1);
    assert.equal(result.duplicates[0]?.kind, 'IDEMPOTENT');
    assert.equal(store.listEvents('run-idem').length, 1);
    await store.close();
  });

  it('isolates a conflicting duplicate without overwriting the original', async () => {
    const root = await tempDataRoot('conflict');
    const store = await openStore(root);
    await store.createRun('run-conf', { adapterId: 'a', adapterVersion: '1' });
    const original = makeEvent({ eventId: 'e1', runId: 'run-conf', sequence: 1, payload: { type: 'CLAIM', text: '원본 주장' } });
    const forged = makeEvent({ eventId: 'e1', runId: 'run-conf', sequence: 2, payload: { type: 'CLAIM', text: '변조된 주장' } });
    const result = await store.appendRecords('run-conf', [original, forged]);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.duplicates[0]?.kind, 'CONFLICTING');
    const events = store.listEvents('run-conf');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.payload.type, 'CLAIM');
    if (events[0]?.payload.type === 'CLAIM') assert.equal(events[0].payload.text, '원본 주장');
    assert.ok(store.listDiagnostics('run-conf').some((d) => d.code === 'DUPLICATE_CONFLICTING'));
    const replay = store.replay('run-conf');
    assert.equal(replay?.records.length, 1);
    await store.close();
  });

  it('keeps the same event id in different runs independent', async () => {
    const root = await tempDataRoot('crossrun');
    const store = await openStore(root);
    await store.createRun('run-x', { adapterId: 'a', adapterVersion: '1' });
    await store.createRun('run-y', { adapterId: 'a', adapterVersion: '1' });
    const a = makeEvent({ eventId: 'shared', runId: 'run-x', sequence: 1 });
    const b = makeEvent({ eventId: 'shared', runId: 'run-y', sequence: 1, payload: { type: 'CLAIM', text: '다른 내용' } });
    await store.appendRecords('run-x', [a]);
    const result = await store.appendRecords('run-y', [b]);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.duplicates.length, 0, 'same id in another run is not a conflict');
    assert.equal(store.listEvents('run-x').length, 1);
    assert.equal(store.listEvents('run-y').length, 1);
    await store.close();
  });

  it('derives trace.jsonl with exactly the committed canonical lines', async () => {
    const root = await tempDataRoot('jsonl');
    const store = await openStore(root);
    await store.createRun('run-j', { adapterId: 'a', adapterVersion: '1' });
    const events = threeEvents('run-j');
    await store.appendRecords('run-j', events);
    const content = await store.readTraceJsonl('run-j');
    const expected = events.map((e) => canonicalize(e)).join('\n') + '\n';
    assert.equal(content, expected);
    await store.close();
  });
});

describe('viewtrace store: crash recovery at commit boundaries', () => {
  const fault = (point: string): Error => new Error(`INJECTED:${point}`);

  it('a fault before the DB commit persists nothing', async () => {
    const root = await tempDataRoot('crash-pre');
    const store = await openStore(root, { injectFault: (p) => (p === 'before-db-commit' ? fault(p) : undefined) });
    await store.createRun('run-c1', { adapterId: 'a', adapterVersion: '1' });
    await assert.rejects(() => store.appendRecords('run-c1', threeEvents('run-c1')));
    await store.close();
    const reopened = await openStore(root);
    assert.equal(reopened.listRecords('run-c1').length, 0);
    assert.equal(replayedJsonlExists(root, 'run-c1'), false);
    await reopened.close();
  });

  it('a fault after the DB commit is repaired on reopen (DB is authoritative)', async () => {
    const root = await tempDataRoot('crash-post');
    const store = await openStore(root, { injectFault: (p) => (p === 'after-db-commit-before-jsonl' ? fault(p) : undefined) });
    await store.createRun('run-c2', { adapterId: 'a', adapterVersion: '1' });
    await assert.rejects(() => store.appendRecords('run-c2', threeEvents('run-c2')));
    await store.close();
    const reopened = await openStore(root);
    const replay = reopened.replay('run-c2');
    assert.equal(replay?.records.length, 3, 'committed events survive');
    const content = await reopened.readTraceJsonl('run-c2');
    const lines = content.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 3, 'derived JSONL was re-derived from the DB');
    for (let i = 0; i < 3; i++) {
      assert.equal(lines[i], canonicalize(replay?.records[i]?.record));
    }
    await reopened.close();
  });

  it('a partial JSONL line from a mid-write crash is truncated and repaired on reopen', async () => {
    const root = await tempDataRoot('crash-mid');
    const store = await openStore(root, { injectFault: (p) => (p === 'mid-jsonl-write' ? fault(p) : undefined) });
    await store.createRun('run-c3', { adapterId: 'a', adapterVersion: '1' });
    const result = await store.appendRecords('run-c3', threeEvents('run-c3'));
    assert.ok(result.jsonlWriteError !== undefined, 'write failure is surfaced, not swallowed');
    const raw = await readFile(join(root, 'runs', 'run-c3', 'trace.jsonl'), 'utf8');
    assert.ok(!raw.endsWith('\n'), 'a partial trailing line is left behind by the crash');
    await store.close();

    const reopened = await openStore(root);
    const replay = reopened.replay('run-c3');
    assert.equal(replay?.records.length, 3);
    const content = await reopened.readTraceJsonl('run-c3');
    assert.ok(content.endsWith('\n'));
    assert.equal(content.split('\n').filter((l) => l.length > 0).length, 3);
    await reopened.close();
  });

  it('recovery holds for all three commit boundaries across 20 consecutive crash iterations', async () => {
    const points = ['before-db-commit', 'after-db-commit-before-jsonl', 'mid-jsonl-write'] as const;
    for (let i = 0; i < 20; i++) {
      const point = points[i % points.length] as (typeof points)[number];
      const root = await tempDataRoot(`crash20-${i}`);
      const store = await openStore(root, { injectFault: (p) => (p === point ? fault(p) : undefined) });
      await store.createRun(`run-20`, { adapterId: 'a', adapterVersion: '1' });
      const events = threeEvents('run-20');
      try {
        const result = await store.appendRecords('run-20', events);
        if (point === 'mid-jsonl-write') {
          assert.ok(result.jsonlWriteError !== undefined);
        }
      } catch (e) {
        assert.ok(e instanceof Error && e.message.includes('INJECTED'), `iteration ${i}: unexpected error ${String(e)}`);
      }
      await store.close();

      const reopened = await openStore(root);
      const replay = reopened.replay('run-20');
      if (point === 'before-db-commit') {
        assert.equal(replay?.records.length, 0, `iteration ${i}`);
      } else {
        assert.equal(replay?.records.length, 3, `iteration ${i}`);
        for (let k = 0; k < 3; k++) {
          assert.equal(
            canonicalize(replay?.records[k]?.record),
            canonicalize(events[k]),
            `iteration ${i} record ${k} must replay identically`,
          );
        }
        const content = await reopened.readTraceJsonl('run-20');
        assert.equal(content.split('\n').filter((l) => l.length > 0).length, 3, `iteration ${i}`);
        assert.ok(content.endsWith('\n'), `iteration ${i}`);
      }
      await reopened.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('viewtrace store: migrations', () => {
  it('migrates a version-0 experimental database and preserves its data', async () => {
    const root = await tempDataRoot('migrate');
    const db = new DatabaseSync(join(root, 'viewtrace.db'));
    db.exec(`
      CREATE TABLE vt_runs (run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE vt_events (run_id TEXT NOT NULL, event_id TEXT NOT NULL, data TEXT NOT NULL);
    `);
    db.prepare('INSERT INTO vt_runs VALUES (?, ?)').run('run-legacy', '2026-09-01T00:00:00Z');
    db.prepare('INSERT INTO vt_events VALUES (?, ?, ?)').run('run-legacy', 'evt-legacy-1', JSON.stringify(makeEvent({ runId: 'run-legacy', eventId: 'evt-legacy-1' })));
    db.close();

    const store = await openStore(root);
    const run = store.getRun('run-legacy');
    assert.ok(run !== null);
    assert.equal(run.eventCount, 1);
    assert.equal(run.lifecycle, 'UNKNOWN', 'legacy rows carry no observed lifecycle');
    // A re-receipt of a migrated event must compare by content (hash backfill).
    const result = await store.appendRecords('run-legacy', [
      makeEvent({ runId: 'run-legacy', eventId: 'evt-legacy-1', sequence: 2 }),
    ]);
    assert.equal(result.duplicates[0]?.kind, 'IDEMPOTENT', 'hash backfill makes migrated rows comparable');
    await store.close();
  });

  it('rolls back a failing migration and leaves the database at version 0', async () => {
    const root = await tempDataRoot('migrate-fail');
    const db = new DatabaseSync(join(root, 'viewtrace.db'));
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '0');
      CREATE TABLE vt_runs (run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE vt_events (run_id TEXT NOT NULL, event_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE records (incompatible INTEGER);
    `);
    db.prepare('INSERT INTO vt_runs VALUES (?, ?)').run('run-x', '2026-09-01T00:00:00Z');
    db.prepare('INSERT INTO vt_events VALUES (?, ?, ?)').run('run-x', 'e1', '{}');
    db.close();

    await assert.rejects(() => openStore(root), (e: unknown) => {
      assert.ok(e instanceof StoreError);
      assert.equal(e.code, 'MIGRATION_FAILED');
      return true;
    });
    const check = new DatabaseSync(join(root, 'viewtrace.db'), { readOnly: true });
    assert.equal(
      (check.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value,
      '0',
      'version must remain 0 after rollback',
    );
    assert.equal((check.prepare('SELECT COUNT(*) AS c FROM vt_runs').get() as { c: number }).c, 1, 'v0 data intact');
    check.close();
  });
});

describe('viewtrace store: fault resistance', () => {
  it('reports an explicit error when the database is locked by another writer', async () => {
    const root = await tempDataRoot('locked');
    const store = await openStore(root);
    await store.createRun('run-l', { adapterId: 'a', adapterVersion: '1' });
    const other = new DatabaseSync(join(root, 'viewtrace.db'));
    other.exec('BEGIN EXCLUSIVE');
    try {
      await assert.rejects(() => store.appendRecords('run-l', threeEvents('run-l')), (e: unknown) => {
        assert.ok(e instanceof StoreError, `expected StoreError, got ${String(e)}`);
        assert.equal(e.code, 'DB_BUSY');
        return true;
      });
    } finally {
      other.exec('COMMIT');
      other.close();
      await store.close();
    }
  });

  it('reports an explicit error when the database file is read-only', async () => {
    const root = await tempDataRoot('readonly');
    const store = await openStore(root);
    await store.createRun('run-ro', { adapterId: 'a', adapterVersion: '1' });
    await store.close();
    if (process.platform === 'win32') return; // POSIX permission bits do not apply
    await chmod(join(root, 'viewtrace.db'), 0o444);
    try {
      // SQLite downgrades a non-writable file to read-only at open time and
      // only fails on the first write — the store must surface that loudly.
      const reopened = await ViewTraceStore.open({ dataRoot: root, now: FIXED_NOW });
      await assert.rejects(
        () => reopened.createRun('run-ro-2', { adapterId: 'a', adapterVersion: '1' }),
        (e: unknown) => {
          assert.ok(e instanceof StoreError, `expected StoreError, got ${String(e)}`);
          assert.equal(e.code, 'DB_READ_ONLY');
          return true;
        },
      );
      await reopened.close();
    } finally {
      await chmod(join(root, 'viewtrace.db'), 0o600);
    }
  });

  it('surfaces ENOSPC on the derived JSONL and repairs it on reopen', async () => {
    if (process.platform === 'win32') return; // /dev/full is POSIX-only
    const root = await tempDataRoot('enospc');
    const store = await openStore(root);
    await store.createRun('run-enospc', { adapterId: 'a', adapterVersion: '1' });
    const runDir = join(root, 'runs', 'run-enospc');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(runDir, { recursive: true });
    await rm(join(runDir, 'trace.jsonl'), { force: true });
    await symlink('/dev/full', join(runDir, 'trace.jsonl'));
    const result = await store.appendRecords('run-enospc', threeEvents('run-enospc'));
    assert.ok(result.jsonlWriteError !== undefined, 'ENOSPC must not be swallowed');
    assert.ok(/no space|ENOSPC/i.test(result.jsonlWriteError.message));
    await store.close();

    const reopened = await openStore(root);
    const replay = reopened.replay('run-enospc');
    assert.equal(replay?.records.length, 3, 'committed events survive the write failure');
    const content = await reopened.readTraceJsonl('run-enospc');
    assert.equal(content.split('\n').filter((l) => l.length > 0).length, 3, 'JSONL re-derived on reopen');
    await reopened.close();
  });
});

function replayedJsonlExists(root: string, runId: string): boolean {
  return existsSync(join(root, 'runs', runId, 'trace.jsonl'));
}
