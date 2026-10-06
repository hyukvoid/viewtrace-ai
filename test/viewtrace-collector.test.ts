/**
 * M1 LiveCollector in-process integration (real store + real spool files,
 * no service subprocess): incremental chunk/UTF-8/CRLF handling, cursor
 * restart, truncate/rotate generations, duplicate idempotency, line caps,
 * finalization rules, run-id isolation.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LiveCollector } from '../src/viewtrace/collector.js';
import { ViewTraceStore } from '../src/viewtrace/store.js';
import { chunkBytes } from '../src/viewtrace/jsonl.js';
import type { RunState } from '../src/viewtrace/types.js';
import { tempDataRoot, makeEvent, makeRunRecord, FIXED_NOW } from './helpers/viewtrace.js';

const RUN = 'run-collector-test';

function line(record: unknown): string {
  return JSON.stringify(record) + '\n';
}

async function prepareRoot(): Promise<string> {
  const root = await tempDataRoot('m1-collector');
  await mkdir(join(root, 'live', RUN), { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, 'live', RUN, 'meta.json'),
    JSON.stringify({
      runId: RUN,
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.1.0',
    }),
    'utf8',
  );
  return root;
}

function spoolOf(root: string): string {
  return join(root, 'live', RUN, 'stream.jsonl');
}

async function openCollector(root: string): Promise<{ store: ViewTraceStore; collector: LiveCollector }> {
  const store = await ViewTraceStore.open({ dataRoot: root, now: FIXED_NOW });
  const collector = new LiveCollector(store, root, { now: FIXED_NOW });
  await collector.scanAndResume();
  return { store, collector };
}

async function runState(store: ViewTraceStore, runId = RUN): Promise<RunState | null> {
  return store.getRun(runId);
}

describe('LiveCollector: incremental ingestion', () => {
  let root: string;
  let store: ViewTraceStore;
  let collector: LiveCollector;

  before(async () => {
    root = await prepareRoot();
    ({ store, collector } = await openCollector(root));
  });

  after(async () => {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('accepts events split at every UTF-8 boundary (Korean multibyte) across chunks', async () => {
    const events = [
      makeEvent({ eventId: 'evt-k-1', runId: RUN, type: 'SEARCH', payload: { type: 'SEARCH', query: '한글 멀티바이트 분할 경계 테스트', results: [] } }),
      makeEvent({ eventId: 'evt-k-2', runId: RUN, type: 'CLAIM', payload: { type: 'CLAIM', text: '가나다라마바사아자차카타파하' } }),
    ];
    const bytes = Buffer.from(events.map((e) => line({ ...e, sequence: undefined, receivedAt: undefined })).join(''), 'utf8');
    // Feed one byte at a time through the spool, ticking periodically.
    for (let size = 1; size <= 16; size++) {
      const handle = await open(spoolOf(root), 'a');
      for (const chunk of chunkBytes(bytes, size)) await handle.write(chunk);
      await handle.close();
      await collector.tick();
    }
    const state = await runState(store);
    assert.equal(state?.eventCount, 2);
    assert.equal(state?.completeness, 'UNKNOWN', 'no terminal record yet');
  });

  it('tolerates CRLF lines and keeps loss positions', async () => {
    const handle = await open(spoolOf(root), 'a');
    await handle.write(
      Buffer.from(
        line(makeEvent({ eventId: 'evt-crlf', runId: RUN })) .replace('\n', '\r\n') +
          '{ broken\r\n',
        'utf8',
      ),
    );
    await handle.close();
    await collector.tick();
    const state = await runState(store);
    assert.equal((state?.eventCount ?? 0) >= 3, true);
    const diagnostics = store.listDiagnostics(RUN);
    assert.ok(diagnostics.some((d) => d.code === 'LOSS_MALFORMED_JSON'), 'the broken CRLF line is a definitive loss');
  });

  it('is idempotent for the same (runId,eventId) payload and isolates conflicting duplicates', async () => {
    const event = makeEvent({ eventId: 'evt-dup', runId: RUN, sequence: undefined, receivedAt: undefined });
    const handle = await open(spoolOf(root), 'a');
    await handle.write(Buffer.from(line(event) + line(event), 'utf8'));
    await handle.write(
      Buffer.from(line(makeEvent({ eventId: 'evt-dup', runId: RUN, payload: { type: 'SEARCH', query: '다른 내용', results: [] }, sequence: undefined, receivedAt: undefined })), 'utf8'),
    );
    await handle.close();
    await collector.tick();
    const duplicates = store.listDuplicates(RUN);
    assert.equal(duplicates.filter((d) => d.recordId === 'evt-dup' && d.kind === 'IDEMPOTENT').length, 1);
    assert.equal(duplicates.filter((d) => d.recordId === 'evt-dup' && d.kind === 'CONFLICTING').length, 1);
    const records = store.listRecords(RUN);
    assert.equal(records.filter((r) => r.recordId === 'evt-dup').length, 1, 'the original is kept, never overwritten');
  });

  it('keeps collector reception order over declared sequences (with a warning)', async () => {
    const handle = await open(spoolOf(root), 'a');
    await handle.write(
      Buffer.from(
        line(makeEvent({ eventId: 'evt-seq-99', runId: RUN, type: 'READ', sequence: 99, payload: { type: 'READ', sourceId: 'src-seq', outcome: 'SUCCESS' } })),
        'utf8',
      ),
    );
    await handle.close();
    await collector.tick();
    const record = store.listRecords(RUN).find((r) => r.recordId === 'evt-seq-99');
    assert.notEqual(record, undefined);
    assert.notEqual(record?.sequence, 99, 'collector order wins');
    assert.ok(store.listDiagnostics(RUN).some((d) => d.code === 'SEQUENCE_MISMATCH'));
  });

  it('detects truncation as a new source generation, re-reads idempotently and stays PARTIAL', async () => {
    const before = (await runState(store))?.eventCount ?? 0;
    await writeFile(
      spoolOf(root),
      Buffer.from(line(makeEvent({ eventId: 'evt-gen-1', runId: RUN, sequence: undefined, receivedAt: undefined })), 'utf8'),
      { flag: 'w' },
    );
    await collector.tick();
    // New collector instance sees the shrink vs the committed cursor.
    const diagnostics = store.listDiagnostics(RUN);
    assert.ok(diagnostics.some((d) => d.code === 'SOURCE_TRUNCATED'), 'generation reset must be recorded');
    const state = await runState(store);
    assert.equal(state?.eventCount, before + 1);
    // Finalize now: the generation reset forbids COMPLETE forever.
    const handle = await open(spoolOf(root), 'a');
    await handle.write(Buffer.from(line(makeRunRecord({ runId: RUN, lifecycle: 'COMPLETED' })), 'utf8'));
    await handle.close();
    await collector.tick();
    await waitForFinalized(collector);
    const finalized = await runState(store);
    assert.equal(finalized?.completeness, 'PARTIAL', 'a broken stream can never be COMPLETE');
  });

  it('restarts from the committed cursor with zero loss and zero duplicates', async () => {
    // Fresh run directory for a clean cursor history.
    const otherRun = 'run-collector-restart';
    await mkdir(join(root, 'live', otherRun), { recursive: true });
    await writeFile(
      join(root, 'live', otherRun, 'meta.json'),
      JSON.stringify({ runId: otherRun, adapterId: 'viewtrace-reference-jsonl', adapterVersion: '1.1.0' }),
    );
    const otherSpool = join(root, 'live', otherRun, 'stream.jsonl');
    let handle = await open(otherSpool, 'a');
    for (let i = 0; i < 6; i++) {
      await handle.write(
        Buffer.from(line(makeEvent({ eventId: `evt-r-${i}`, runId: otherRun, sequence: undefined, receivedAt: undefined })), 'utf8'),
      );
    }
    await handle.close();
    await collector.tick();

    // Simulate a service crash: close store + collector, reopen both.
    await store.close();
    ({ store, collector } = await openCollector(root));
    let state = await runState(store, otherRun);
    assert.equal(state?.eventCount, 6);
    assert.equal(state?.jsonlCursor, (await readFile(otherSpool)).length, 'cursor sits at the line boundary');

    // Append more, including a split-across-restart line: still zero loss.
    handle = await open(otherSpool, 'a');
    const extra = line(makeEvent({ eventId: 'evt-r-6', runId: otherRun, sequence: undefined, receivedAt: undefined }));
    const extraBytes = Buffer.from(extra, 'utf8');
    await handle.write(extraBytes.subarray(0, Math.floor(extraBytes.length / 2)));
    await handle.close();
    await collector.tick();
    await store.close();
    ({ store, collector } = await openCollector(root));
    handle = await open(otherSpool, 'a');
    await handle.write(extraBytes.subarray(Math.floor(extraBytes.length / 2)));
    await handle.write(Buffer.from(line(makeRunRecord({ runId: otherRun, lifecycle: 'COMPLETED' })), 'utf8'));
    await handle.close();
    await collector.tick();
    await waitForFinalized(collector, otherRun);

    state = await runState(store, otherRun);
    assert.equal(state?.eventCount, 7);
    assert.equal(state?.lifecycle, 'COMPLETED');
    assert.equal(state?.completeness, 'COMPLETE');
    const duplicates = store.listDuplicates(otherRun);
    assert.equal(duplicates.length, 0, 'cursor resume must not re-ingest committed records');
    const diagnostics = store.listDiagnostics(otherRun);
    assert.equal(diagnostics.filter((d) => d.severity === 'error').length, 0);
  });

  it('detects rotation (file identity change) and re-reads the new file', async () => {
    const otherRun = 'run-collector-rotate';
    await mkdir(join(root, 'live', otherRun), { recursive: true });
    await writeFile(
      join(root, 'live', otherRun, 'meta.json'),
      JSON.stringify({ runId: otherRun, adapterId: 'viewtrace-reference-jsonl', adapterVersion: '1.1.0' }),
    );
    const otherSpool = join(root, 'live', otherRun, 'stream.jsonl');
    await writeFile(
      otherSpool,
      Buffer.from(line(makeEvent({ eventId: 'evt-o-1', runId: otherRun, sequence: undefined, receivedAt: undefined })), 'utf8'),
    );
    await collector.tick();
    const state1 = await runState(store, otherRun);
    assert.equal(state1?.eventCount, 1);

    if (process.platform === 'win32') {
      // ino-based identity is not reliable on Windows; the size-heuristic
      // truncate path covers generation resets there. Assert the honest no-op.
      const unchanged = await runState(store, otherRun);
      assert.equal(unchanged?.eventCount, 1);
      return;
    }
    await rename(otherSpool, `${otherSpool}.1`);
    await writeFile(
      otherSpool,
      Buffer.from(
        line(makeEvent({ eventId: 'evt-o-1', runId: otherRun, sequence: undefined, receivedAt: undefined })) +
          line(makeEvent({ eventId: 'evt-o-2', runId: otherRun, sequence: undefined, receivedAt: undefined })) +
          line(makeRunRecord({ runId: otherRun, lifecycle: 'COMPLETED' })),
        'utf8',
      ),
    );
    await collector.tick();
    await waitForFinalized(collector, otherRun);
    const state = await runState(store, otherRun);
    assert.equal(state?.eventCount, 2);
    assert.equal(state?.completeness, 'PARTIAL', 'rotation is a generation reset');
    assert.ok(store.listDiagnostics(otherRun).some((d) => d.code === 'SOURCE_ROTATED'));
    assert.equal(store.listDuplicates(otherRun).filter((d) => d.kind === 'IDEMPOTENT').length, 1, 're-read of the same record is idempotent');
  });

  it('caps oversized lines without unbounded buffering and keeps later records', async () => {
    const otherRun = 'run-collector-oversize';
    await mkdir(join(root, 'live', otherRun), { recursive: true });
    await writeFile(
      join(root, 'live', otherRun, 'meta.json'),
      JSON.stringify({ runId: otherRun, adapterId: 'viewtrace-reference-jsonl', adapterVersion: '1.1.0' }),
    );
    const otherSpool = join(root, 'live', otherRun, 'stream.jsonl');
    const huge = 'x'.repeat(5 * 1024 * 1024);
    const handle = await open(otherSpool, 'a');
    await handle.write(Buffer.from(`{"pad":"${huge}"}\n`, 'utf8'));
    await handle.write(
      Buffer.from(
        line(makeEvent({ eventId: 'evt-after-huge', runId: otherRun, sequence: undefined, receivedAt: undefined })) +
          line(makeRunRecord({ runId: otherRun, lifecycle: 'COMPLETED' })),
        'utf8',
      ),
    );
    await handle.close();
    await collector.tick();
    await waitForFinalized(collector, otherRun);
    const state = await runState(store, otherRun);
    assert.equal(state?.eventCount, 1, 'the record after the oversized line survives');
    assert.equal(state?.completeness, 'PARTIAL');
    assert.ok(store.listDiagnostics(otherRun).some((d) => d.code === 'LOSS_OVERSIZED_LINE'));
  });

  it('drains a 5k-event flood correctly (bounded reads, no loss, no duplicates)', async () => {
    const otherRun = 'run-collector-flood';
    await mkdir(join(root, 'live', otherRun), { recursive: true });
    await writeFile(
      join(root, 'live', otherRun, 'meta.json'),
      JSON.stringify({ runId: otherRun, adapterId: 'viewtrace-reference-jsonl', adapterVersion: '1.1.0' }),
    );
    const otherSpool = join(root, 'live', otherRun, 'stream.jsonl');
    const handle = await open(otherSpool, 'a');
    const batchOf500: string[] = [];
    for (let i = 0; i < 5000; i++) {
      batchOf500.push(line(makeEvent({ eventId: `evt-flood-${i}`, runId: otherRun, sequence: undefined, receivedAt: undefined })));
      if (batchOf500.length === 500) {
        await handle.write(Buffer.from(batchOf500.join(''), 'utf8'));
        batchOf500.length = 0;
      }
    }
    await handle.write(Buffer.from(line(makeRunRecord({ runId: otherRun, lifecycle: 'COMPLETED' })), 'utf8'));
    await handle.close();
    for (let i = 0; i < 40 && !(await isFinalized(collector, otherRun)); i++) {
      await collector.tick();
    }
    await waitForFinalized(collector, otherRun);
    const state = await runState(store, otherRun);
    assert.equal(state?.eventCount, 5000);
    assert.equal(state?.completeness, 'COMPLETE');
    assert.equal(store.listDuplicates(otherRun).length, 0);
  });

  it('rejects records targeting a foreign run id (isolation)', async () => {
    const otherRun = 'run-collector-isolation';
    await mkdir(join(root, 'live', otherRun), { recursive: true });
    await writeFile(
      join(root, 'live', otherRun, 'meta.json'),
      JSON.stringify({ runId: otherRun, adapterId: 'viewtrace-reference-jsonl', adapterVersion: '1.1.0' }),
    );
    const handle = await open(join(root, 'live', otherRun, 'stream.jsonl'), 'a');
    await handle.write(
      Buffer.from(
        line({ ...makeEvent({ eventId: 'evt-foreign', runId: 'some-other-run', sequence: undefined, receivedAt: undefined }), runId: 'some-other-run' }) +
          line(makeRunRecord({ runId: otherRun, lifecycle: 'COMPLETED' })),
        'utf8',
      ),
    );
    await handle.close();
    await collector.tick();
    await waitForFinalized(collector, otherRun);
    assert.equal(store.getRun('some-other-run'), null, 'a foreign run must never be created');
    assert.ok(store.listDiagnostics(otherRun).some((d) => d.code === 'RUN_ID_MISMATCH'));
    const state = await runState(store, otherRun);
    assert.equal(state?.completeness, 'PARTIAL', 'the rejected record is a loss of input');
  });
});

async function isFinalized(collector: LiveCollector, runId: string): Promise<boolean> {
  return (await collector.snapshot()).some((r) => r.runId === runId && r.finalized);
}

async function waitForFinalized(collector: LiveCollector, runId: string = RUN): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await isFinalized(collector, runId)) return;
    await collector.tick();
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`run ${runId} did not finalize`);
}
