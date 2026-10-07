import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, symlink, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { answerHash, ANSWER_HASH_VERSION } from '../src/viewtrace/answer.js';
import type { AnswerReceipt, AnswerContext } from '../src/viewtrace/answer.js';
import { validateRecord } from '../src/viewtrace/validate.js';
import { ViewTraceStore } from '../src/viewtrace/store.js';
import { ingestFile } from '../src/viewtrace/ingest.js';
import { resolveAnswer, parseAnswerContext } from '../src/viewtrace/resolver.js';
import { answerReport, eventPage } from '../src/viewtrace/report.js';
import { makeEvent, tempDataRoot, viewtraceFixture } from './helpers/viewtrace.js';

import { receipt } from './helpers/m2.js';
async function multi() {
  const root = await tempDataRoot('answer');
  await ingestFile(viewtraceFixture('answer-multi-turn.jsonl'), {
    dataRoot: root,
  });
  return { root, store: await ViewTraceStore.open({ dataRoot: root }) };
}

describe('M2 finalized public receipt and resolver oracle', () => {
  it('final-only validation rejects drafts, spoofed hash/version/identity/time/scope and sanitizes before hashing', () => {
    const base = receipt();
    for (const bad of [
      { final: false },
      { receiptVersion: 2 },
      { hashVersion: 'unknown' },
      { answerHash: '0'.repeat(64) },
      { agentId: '' },
      { timestamp: '2026-02-30T00:00:00Z' },
      { eventIds: null },
      { eventIds: ['e', 'e'] },
      { eventIds: ['e'], sharedEventIds: ['e'] },
      { eventIds: ['../foreign'] },
      { answer: null },
      { schemaVersion: 99 },
    ])
      assert.equal(validateRecord({ ...base, ...bad }).ok, false, JSON.stringify(bad));
    const sanitized = receipt({
      answer: 'é\r\napi_key=SECRET_CREDENTIAL_123',
      answerHash: undefined,
      thinking: 'PRIVATE_SENTINEL_123',
      credentials: { token: 'TOKEN_SENTINEL_123' },
    });
    assert.equal(sanitized.answer, 'é\napi_key=[REDACTED]');
    assert.equal(sanitized.answerHash, answerHash('e\u0301\napi_key=SECRET_CREDENTIAL_123'));
    assert.equal(sanitized.hashVersion, ANSWER_HASH_VERSION);
    assert.ok(!JSON.stringify(sanitized).includes('SENTINEL'));
    assert.notEqual(answerHash(' answer '), answerHash('answer'), 'no trim/case-fold guessing');
    assert.throws(() => parseAnswerContext({ path: '/tmp/private' }));
  });

  it('opens A1/A2/A3 only through their identities and explicitly scoped evidence; repeated hash stays ambiguous', async () => {
    const { store } = await multi();
    try {
      const oracle = JSON.parse(
        await readFile(viewtraceFixture('answer-multi-turn.oracle.json'), 'utf8'),
      ) as {
        answers: Record<string, string[]>;
        eventCount: number;
        recordCount: number;
      };
      assert.equal(store.getRun('receipt-multi')?.eventCount, oracle.eventCount);
      assert.equal(store.listRecords('receipt-multi').length, oracle.recordCount);
      for (let i = 1; i <= 3; i++) {
        const resolved = resolveAnswer(store, {
          agentId: 'reference-agent',
          agentSessionId: 'session-1',
          turnId: `turn-${i}`,
        });
        assert.equal(resolved.status, 'matched');
        assert.equal(resolved.receipt?.answerId, `A${i}`);
        const page = eventPage(store, 'receipt-multi', 0, 100, `A${i}`)!;
        assert.deepEqual(
          page.events.map((e) => (e.recordKind === 'event' ? e.eventId : 'INVALID')),
          oracle.answers[`A${i}`],
        );
        assert.equal(answerReport(store, 'receipt-multi', `A${i}`)?.evidenceSupport, 'UNKNOWN');
      }
      const a = store.getReceipt('receipt-A1')!;
      assert.equal(a.answerHash, store.getReceipt('receipt-A3')?.answerHash);
      assert.equal(
        resolveAnswer(store, {
          answerHash: a.answerHash,
          hashVersion: a.hashVersion,
        }).status,
        'uncertain',
      );
      assert.equal(resolveAnswer(store, {}).status, 'uncertain');
      assert.equal(
        resolveAnswer(store, { agentSessionId: 'session-1', turnId: 'turn-1' }).status,
        'uncertain',
        'agent namespace required',
      );
      assert.equal(resolveAnswer(store, { receiptId: 'receipt-A2' }).status, 'matched');
      assert.equal(
        resolveAnswer(store, {
          receiptId: a.receiptId,
          answerHash: a.answerHash,
          hashVersion: a.hashVersion,
        }).reason,
        'IDENTITY_AND_HASH_CORROBORATED',
      );
      assert.equal(
        resolveAnswer(store, {
          receiptId: a.receiptId,
          answerHash: a.answerHash,
        }).status,
        'mismatch',
      );
      for (const context of [
        { receiptId: a.receiptId, agentId: 'other' },
        { receiptId: a.receiptId, agentSessionId: 'other' },
        { receiptId: a.receiptId, turnId: 'other' },
        { receiptId: a.receiptId, runId: 'other' },
        { receiptId: a.receiptId, answerId: 'A2' },
        {
          receiptId: a.receiptId,
          answerHash: '0'.repeat(64),
          hashVersion: a.hashVersion,
        },
        {
          agentId: a.agentId,
          agentSessionId: a.agentSessionId,
          turnId: a.turnId,
          receiptId: 'receipt-A2',
        },
      ] as AnswerContext[])
        assert.equal(resolveAnswer(store, context).status, 'mismatch', JSON.stringify(context));
      assert.equal(
        resolveAnswer(store, {
          receiptId: 'deleted',
          answerHash: a.answerHash,
          hashVersion: a.hashVersion,
        }).status,
        'missing',
      );
      assert.equal(
        resolveAnswer(store, {
          agentId: a.agentId,
          agentSessionId: a.agentSessionId,
          turnId: 'missing',
          receiptId: a.receiptId,
        }).status,
        'missing',
        'higher identity never falls back',
      );
    } finally {
      await store.close();
    }
  });

  it('parallel namespaces/runs, revised finals, missing turn and unknown boundaries never auto-match', async () => {
    const root = await tempDataRoot('parallel');
    const store = await ViewTraceStore.open({ dataRoot: root });
    try {
      for (const id of ['run-1', 'run-2', 'run-3'])
        await store.createRun(id, {
          adapterId: 'reference',
          adapterVersion: '1',
        });
      await store.appendRecords('run-1', [receipt({ runId: 'run-1', receiptId: 'r1', sequence: 1 })]);
      await store.appendRecords('run-2', [
        receipt({
          runId: 'run-2',
          receiptId: 'r2',
          agentId: 'other',
          sequence: 1,
        }),
      ]);
      assert.equal(
        resolveAnswer(store, {
          agentId: 'agent',
          agentSessionId: 'session',
          turnId: 'turn',
        }).receipt?.runId,
        'run-1',
      );
      assert.equal(
        resolveAnswer(store, {
          agentId: 'other',
          agentSessionId: 'session',
          turnId: 'turn',
        }).receipt?.runId,
        'run-2',
      );
      await store.appendRecords('run-1', [
        receipt({
          receiptId: 'r1-revised',
          runId: 'run-1',
          answerId: 'a1-revised',
          answer: 'Edited final.',
          sequence: 2,
        }),
      ]);
      assert.equal(
        resolveAnswer(store, {
          agentId: 'agent',
          agentSessionId: 'session',
          turnId: 'turn',
          receiptId: 'r1',
        }).status,
        'uncertain',
        'revised turn is ambiguous even with lower-priority receipt',
      );
      await store.appendRecords('run-3', [
        receipt({
          runId: 'run-3',
          receiptId: 'r3',
          turnId: undefined,
          agentSessionId: undefined,
          eventIds: undefined,
          sequence: 1,
        }),
      ]);
      assert.equal(resolveAnswer(store, { receiptId: 'r3' }).status, 'uncertain');
      assert.equal(answerReport(store, 'run-3', 'a1')?.associationCapability, 'PARTIAL');
      await store.appendRecords('run-3', [
        receipt({
          runId: 'run-3',
          receiptId: 'r4',
          answerId: 'a4',
          turnId: 'turn4',
          eventIds: ['late'],
          sequence: 2,
        }),
      ]);
      assert.equal(resolveAnswer(store, { receiptId: 'r4' }).status, 'uncertain');
      await store.appendRecords('run-3', [makeEvent({ runId: 'run-3', eventId: 'late', sequence: 3 })]);
      assert.equal(resolveAnswer(store, { receiptId: 'r4' }).status, 'matched');
    } finally {
      await store.close();
    }
  });

  it('duplicate receipts are idempotent, conflicts quarantined, scopes cannot bleed across turns/runs', async () => {
    const root = await tempDataRoot('receipt-dupes');
    const store = await ViewTraceStore.open({ dataRoot: root });
    try {
      await store.createRun('run-answers', {
        adapterId: 'reference',
        adapterVersion: '1',
      });
      const r = receipt({ sequence: 1, eventIds: ['late'] });
      const result = await store.appendRecords('run-answers', [
        r,
        { ...r, sequence: 2 },
        { ...r, sequence: 3, answer: 'forged' },
        receipt({ sequence: 4, receiptId: 'alias', answerId: 'a1' }),
      ]);
      assert.equal(result.accepted.length, 1);
      assert.deepEqual(
        result.duplicates.map((d) => d.kind),
        ['IDEMPOTENT', 'CONFLICTING'],
      );
      assert.equal(store.getReceipt('alias'), null);
      assert.equal(store.getReceipt('r1')?.answer, r.answer);
      assert.equal(
        resolveAnswer(store, { receiptId: 'r1' }).status,
        'mismatch',
        'conflicting receipt never auto-matches',
      );
      await store.createRun('other-run', {
        adapterId: 'reference',
        adapterVersion: '1',
      });
      await store.appendRecords('other-run', [
        makeEvent({ runId: 'other-run', eventId: 'late', sequence: 1 }),
        receipt({ runId: 'other-run', receiptId: 'r1', sequence: 2 }),
      ]);
      assert.equal(store.getReceipt('r1')?.runId, 'run-answers', 'receipt ids globally scoped');
      assert.equal(store.answerScope(r).missing.length, 1, 'foreign event does not satisfy scope');
      await store.appendRecords('run-answers', [
        makeEvent({ runId: 'run-answers', eventId: 'late', sequence: 5 }),
      ]);
      assert.equal(store.answerScope(r).status, 'EXPLICIT', 'late event resolves explicit pending scope');
      assert.equal(
        resolveAnswer(store, { receiptId: 'r1' }).status,
        'mismatch',
        'a repaired scope never hides a receipt conflict',
      );
      await store.appendRecords('run-answers', [
        receipt({
          receiptId: 'r2',
          answerId: 'a2',
          turnId: 'turn2',
          eventIds: ['late'],
          sequence: 6,
        }),
      ]);
      assert.equal(
        resolveAnswer(store, { receiptId: 'r2' }).status,
        'uncertain',
        'own event cannot be owned by another turn',
      );
      const selectionId = store.select('r1', 'run-answers');
      assert.equal(
        answerReport(store, 'run-answers', 'a1', selectionId)?.association.status,
        'explicit-selection',
      );
      assert.equal(
        answerReport(store, 'run-answers', 'a2', selectionId)?.association.status,
        'explicit-link',
      );
    } finally {
      await store.close();
    }
  });
});

describe('M2 real SQLite migration, rollback and retention', () => {
  it('retention compares timezone-aware cutoffs in UTC', async () => {
    const root = await tempDataRoot('retention-timezone');
    const store = await ViewTraceStore.open({ dataRoot: root, now: () => '2026-10-07T00:00:00.000Z' });
    try {
      await store.createRun('retained', { adapterId: 'reference', adapterVersion: '1' });
      assert.deepEqual(await store.pruneBefore('2026-10-07T01:00:00+09:00'), []);
      assert.ok(store.getRun('retained'));
      assert.deepEqual(await store.pruneBefore('2026-10-07T10:00:00+09:00'), ['retained']);
    } finally {
      await store.close();
    }
  });
  it('batch receipt conflicts remain PARTIAL across reopen and replay', async () => {
    const root = await tempDataRoot('receipt-batch-conflict');
    const rows = (await readFile(viewtraceFixture('answer-multi-turn.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const original = rows.find((row) => row['receiptId'] === 'receipt-A1')!;
    rows.splice(
      rows.length - 1,
      0,
      { ...original, answer: 'Conflicting final answer.' },
      { ...original, receiptId: 'alias-A1' },
    );
    const input = join(root, 'conflicts.jsonl');
    await writeFile(input, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const result = await ingestFile(input, { dataRoot: root });
    assert.equal(result.runs[0]?.completeness, 'PARTIAL');
    assert.equal(result.runs[0]?.recordsAccepted, 9);
    assert.ok(result.replayChecks.every((check) => check.verified));
    const store = await ViewTraceStore.open({ dataRoot: root });
    try {
      assert.equal(store.getRun('receipt-multi')?.completeness, 'PARTIAL');
      assert.equal(resolveAnswer(store, { receiptId: 'receipt-A1' }).status, 'mismatch');
      assert.equal(store.getReceipt('alias-A1'), null);
    } finally {
      await store.close();
    }
  });
  it('additive v1 migration preserves legacy event bytes; failed migration rolls back', async () => {
    for (const fail of [false, true]) {
      const root = await tempDataRoot('migration-v2');
      let store = await ViewTraceStore.open({ dataRoot: root });
      await store.createRun('legacy', { adapterId: 'a', adapterVersion: '1' });
      await store.appendRecords('legacy', [makeEvent({ runId: 'legacy' })]);
      const before = store.listRecords('legacy');
      await store.close();
      const db = new DatabaseSync(join(root, 'viewtrace.db'));
      for (const table of ['answers', 'answer_events', 'selections', 'retention', 'deleted_runs'])
        db.exec(`DROP TABLE ${table}`);
      db.exec("UPDATE meta SET value='1' WHERE key='schema_version'");
      if (fail) db.exec('CREATE TABLE answers (incompatible TEXT)');
      db.close();
      if (fail) {
        await assert.rejects(() => ViewTraceStore.open({ dataRoot: root }), /MIGRATION_FAILED/);
        const check = new DatabaseSync(join(root, 'viewtrace.db'));
        assert.equal(
          (check.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string })
            .value,
          '1',
        );
        assert.ok(check.prepare("SELECT 1 FROM records WHERE run_id='legacy'").get());
        assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE name='records_v1'").get(), undefined);
        check.close();
      } else {
        store = await ViewTraceStore.open({ dataRoot: root });
        assert.deepEqual(store.listRecords('legacy'), before);
        assert.equal(answerReport(store, 'legacy', 'absent'), null);
        await store.close();
      }
    }
  });
  it('receipt/event index commits atomically and JSONL receipt recovery survives reopen', async () => {
    const root = await tempDataRoot('receipt-crash');
    let fault = 'before-db-commit';
    let store = await ViewTraceStore.open({
      dataRoot: root,
      injectFault: (point) => (point === fault ? new Error('crash') : undefined),
    });
    await store.createRun('run-answers', {
      adapterId: 'a',
      adapterVersion: '1',
    });
    await assert.rejects(() => store.appendRecords('run-answers', [receipt({ sequence: 1 })]), /crash/);
    assert.equal(store.getReceipt('r1'), null);
    fault = 'after-db-commit-before-jsonl';
    await assert.rejects(() => store.appendRecords('run-answers', [receipt({ sequence: 1 })]), /crash/);
    assert.ok(store.getReceipt('r1'));
    await store.close();
    store = await ViewTraceStore.open({ dataRoot: root });
    assert.equal(resolveAnswer(store, { receiptId: 'r1' }).status, 'matched');
    assert.ok((await store.readTraceJsonl('run-answers')).includes('r1'));
    await store.close();
  });
  it('keep/prune isolates targets, delete tombstone prevents resurrection after crash and restart', async () => {
    const { root, store } = await multi();
    store.setKeep('receipt-multi', true);
    assert.deepEqual(await store.pruneBefore('9999-01-01T00:00:00Z'), []);
    await store.createRun('active', { adapterId: 'a', adapterVersion: '1' });
    await store.appendRecords('active', [
      {
        recordKind: 'run',
        schemaVersion: 1,
        runId: 'active',
        lifecycle: 'RUNNING',
        occurredAt: '2026-10-07T00:00:00Z',
        sequence: 1,
        receivedAt: '2026-10-07T00:00:00Z',
        adapterId: 'a',
        adapterVersion: '1',
      },
    ]);
    await assert.rejects(() => store.deleteRun('active'), /active/);
    await store.close();
    let reopened = await ViewTraceStore.open({
      dataRoot: root,
      injectFault: (point) => (point === 'after-delete-commit' ? new Error('crash-delete') : undefined),
    });
    assert.equal(reopened.isKept('receipt-multi'), true);
    await assert.rejects(() => reopened.deleteRun('receipt-multi'), /crash-delete/);
    assert.equal(reopened.getReceipt('receipt-A1'), null);
    assert.equal(resolveAnswer(reopened, { receiptId: 'receipt-A1' }).status, 'missing');
    await reopened.close();
    reopened = await ViewTraceStore.open({ dataRoot: root });
    await assert.rejects(() => stat(join(root, 'runs', 'receipt-multi')), {
      code: 'ENOENT',
    });
    assert.ok(reopened.getRun('active'));
    assert.equal(reopened.getRun('receipt-multi'), null);
    await assert.rejects(
      () =>
        reopened.createRun('receipt-multi', {
          adapterId: 'a',
          adapterVersion: '1',
        }),
      /deleted/,
    );
    await reopened.close();
  });
  it('DB, trace and delete paths refuse symlink escapes without modifying outside files', async () => {
    const root = await tempDataRoot('symlink-answer');
    const outside = await tempDataRoot('outside-answer');
    const marker = join(outside, 'private');
    await writeFile(marker, 'DO_NOT_TOUCH');
    await symlink(marker, join(root, 'viewtrace.db'), process.platform === 'win32' ? 'file' : undefined);
    await assert.rejects(() => ViewTraceStore.open({ dataRoot: root }), /UNSAFE_PATH/);
    const { root: second, store } = await multi();
    await mkdir(join(second, 'artifacts', 'receipt-multi'));
    await symlink(
      outside,
      join(second, 'artifacts', 'receipt-multi', 'nested'),
      process.platform === 'win32' ? 'junction' : undefined,
    );
    // Parent directory erasure unlinks nested symlinks; never follows them.
    await store.deleteRun('receipt-multi');
    assert.equal(await readFile(marker, 'utf8'), 'DO_NOT_TOUCH');
    await store.close();
  });
});
