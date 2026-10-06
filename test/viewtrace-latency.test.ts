/**
 * M1 live-latency gate (§4): 1k events over a 10-second synthetic stream —
 * accepted→CLI display p95 ≤ 1s, loss 0, duplicate 0, collector drains all
 * 1000 events. Measurement boundary: the latency log records teedAt (line
 * sanitized and written to the spool) and displayedAt (line printed after
 * local validation) inside the wrapper; collector acceptance is verified as
 * an end-state count (nothing displayed that was not accepted, and vice
 * versa). Runner/Node/OS are recorded in the M1 verification document.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';

import {
  downService,
  parseRunJson,
  producerHeader,
  runBin,
  upService,
  writeProducer,
} from './helpers/m1.js';

interface LatencyEntry {
  eventId: string;
  teedAt: number;
  displayedAt: number;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

describe('viewtrace live latency (1k events / 10s synthetic stream)', () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'vt-latency-'));
    await upService(root);
  });

  after(async () => {
    await downService(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('displays events with p95 ≤ 1s and loses nothing', { timeout: 120_000 }, async () => {
    const producer = await writeProducer(
      join(root, 'producers'),
      'stream.mjs',
      `${producerHeader()}
run('RUNNING');
for (let i = 0; i < 1000; i++) {
  event('evt-lat-' + i, 'SEARCH', { type: 'SEARCH', query: 'stream-' + i, results: [] });
  await new Promise((r) => setTimeout(r, 10));
}
run('COMPLETED');
`,
    );
    const latencyLog = join(root, 'latency.jsonl');
    const startedAt = Date.now();
    const result = await runBin(
      ['run', '--data-root', root, '--json', '--latency-log', latencyLog, '--', process.execPath, producer],
      { timeoutMs: 110_000 },
    );
    const wallSeconds = (Date.now() - startedAt) / 1000;
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);

    const { summary } = parseRunJson(result.stdout);
    assert.notEqual(summary, null, 'a summary line must close the run');
    assert.equal(summary?.['eventsAccepted'], 1000);
    assert.equal(summary?.['losses'], 0);
    assert.equal(summary?.['eventsRejected'], 0);
    assert.equal(summary?.['duplicatesIdempotent'], 0);
    assert.equal(summary?.['duplicatesConflicting'], 0);
    assert.equal(summary?.['completeness'], 'COMPLETE');

    const logText = await readFile(latencyLog, 'utf8');
    const entries: LatencyEntry[] = logText
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l) as LatencyEntry & { type?: string })
      .filter((e) => e.type === undefined)
      .map((e) => ({ eventId: e.eventId, teedAt: e.teedAt, displayedAt: e.displayedAt }));
    assert.equal(entries.length, 1000, `expected 1000 latency entries, got ${entries.length}`);

    const deltas = entries.map((e) => Math.max(1, e.displayedAt - e.teedAt));
    const p95 = percentile(deltas, 95);
    const median = percentile(deltas, 50);
    assert.ok(
      p95 <= 1000,
      `accepted→display p95 must be ≤ 1000ms: measured p95=${p95}ms, median=${median}ms ` +
        `(wall ${wallSeconds.toFixed(1)}s, cpus=${cpus().length}, node ${process.version}, ${process.platform})`,
    );

    // Cross-check: every displayed event id is stored exactly once.
    const replay = await runBin(['replay', String(summary?.['runId']), '--data-root', root, '--json']);
    const storedIds = (JSON.parse(replay.stdout) as { records: { record: { eventId?: string } }[] }).records
      .map((r) => r.record.eventId)
      .filter((id): id is string => id !== undefined);
    assert.equal(storedIds.length, 1000, 'store holds the 1000 domain events');
    const storedSet = new Set(storedIds);
    for (const entry of entries) {
      assert.ok(storedSet.has(entry.eventId), `every displayed event must be stored: ${entry.eventId}`);
    }
  });
});
