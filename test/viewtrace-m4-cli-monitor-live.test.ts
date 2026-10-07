/**
 * M4 live monitor growth test (docs/MILESTONES.md §9): `runMonitor` over a
 * real SQLite store and the real incremental analyzer, with injected timers
 * so the poll sequence is deterministic. A run grows while being monitored:
 * an expanded branch collapses at the threshold, keeps printing counts, and
 * a new branch appears later; the monitor stops once the run is terminal
 * and stable. The answer receipt deliberately omits eventIds, so the answer
 * scope is the whole run container (boundary UNKNOWN) — analysis grows as
 * events arrive, exactly like a live capture.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ViewTraceStore } from '../src/viewtrace/store.js';
import { ingestFile } from '../src/viewtrace/ingest.js';
import { runMonitor } from '../src/viewtrace/presentation/monitor.js';
import type { TraceRecord } from '../src/viewtrace/types.js';

/**
 * Append a continuation batch to an existing run through the store's public
 * append API, continuing the run's global sequence numbering (ingestFile
 * numbers sequences per input file, so a second file cannot extend a run).
 */
async function appendExtension(
  store: ViewTraceStore,
  runId: string,
  recordLines: readonly string[],
): Promise<void> {
  const run = store.getRun(runId);
  assert.ok(run !== null, 'run exists before extension');
  let sequence = run.jsonlLines;
  const records: TraceRecord[] = recordLines.map((line) => {
    sequence += 1;
    return {
      ...(JSON.parse(line) as Record<string, unknown>),
      sequence,
      receivedAt: '2026-10-07T03:00:00.000Z',
    } as TraceRecord;
  });
  const bytes = Buffer.byteLength(recordLines.join('\n') + '\n', 'utf8');
  await store.appendRecords(runId, records, [], run.jsonlCursor + bytes);
}

const RUN_ID = 'run-live-1';

function recordLine(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: 1,
    runId: RUN_ID,
    occurredAt: '2026-10-07T03:00:00Z',
    adapterId: 'viewtrace-reference-jsonl',
    adapterVersion: '1.0.0',
    origin: { producer: 'synthetic-live' },
    ...overrides,
  });
}

function eventLine(eventId: string, type: string, payload: Record<string, unknown>, seq: number): string {
  return recordLine({
    recordKind: 'event',
    eventId,
    type,
    occurredAt: `2026-10-07T03:00:${String(seq).padStart(2, '0')}Z`,
    source: { sourceId: 'src-live', kind: 'URL', location: 'https://example.test/live' },
    provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: `call-${seq}` } },
    payload,
  });
}

const SEARCH = (q: string): { type: 'SEARCH'; query: string; results: [] } => ({ type: 'SEARCH', query: q, results: [] });
const READ = { type: 'READ', sourceId: 'src-live', outcome: 'SUCCESS' } as const;

describe('M4 monitor: live branch growth, collapse and stability over real SQLite', () => {
  it('prints growth, collapse transitions and a new branch as the run evolves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vt-m4-live-'));
    const initial = join(root, 'initial.jsonl');
    const ext1 = join(root, 'ext1.jsonl');
    const ext2 = join(root, 'ext2.jsonl');

    await writeFile(
      initial,
      [
        recordLine({ recordKind: 'run', lifecycle: 'RUNNING' }),
        eventLine('m-s1', 'SEARCH', SEARCH('live query one'), 1),
        eventLine('m-r1', 'READ', READ, 2),
        // No eventIds on the receipt: scope boundary UNKNOWN, whole-run
        // analysis that grows with the live run.
        recordLine({
          recordKind: 'answer',
          receiptVersion: 1,
          receiptId: 'rec-live',
          agentId: 'reference-agent',
          answerId: 'ans-live',
          answer: 'Live answer.',
          final: true,
          timestamp: '2026-10-07T03:00:03Z',
          questionSummary: 'live question',
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    await writeFile(
      ext1,
      [eventLine('m-r2', 'READ', READ, 4), eventLine('m-r3', 'READ', READ, 5)].join('\n') + '\n',
      'utf8',
    );
    await writeFile(
      ext2,
      [
        eventLine('m-s2', 'SEARCH', SEARCH('live query two'), 7),
        eventLine('m-r4', 'READ', READ, 8),
        eventLine('m-r5', 'READ', READ, 9),
        eventLine('m-r6', 'READ', READ, 10),
        recordLine({ recordKind: 'run', lifecycle: 'COMPLETED' }),
      ].join('\n') + '\n',
      'utf8',
    );

    await ingestFile(initial, { dataRoot: root });
    const store = await ViewTraceStore.open({ dataRoot: root });

    const lines: string[] = [];
    let sleeps = 0;
    const io = {
      emit: (line: string): void => {
        lines.push(line);
      },
      emitJson: (value: unknown): void => {
        lines.push(JSON.stringify(value));
      },
      fail: (message: string): void => {
        lines.push(`FAIL ${message}`);
      },
      sleep: async (): Promise<void> => {
        sleeps += 1;
        if (sleeps === 1) {
          await appendExtension(store, RUN_ID, readFileSync(ext1, 'utf8').trim().split('\n'));
        }
        if (sleeps === 2) {
          await appendExtension(store, RUN_ID, readFileSync(ext2, 'utf8').trim().split('\n'));
        }
      },
      now: (): number => 0,
    };

    let exit: number;
    try {
      exit = await runMonitor(
        store,
        {
          runId: RUN_ID,
          intervalMs: 1,
          maxWaitMs: 60_000,
          json: false,
          dataRoot: root,
        },
        io,
      );
    } finally {
      store.close();
    }

    const text = lines.join('\n');
    assert.equal(exit, 0, `monitor exits cleanly:\n${text}`);
    assert.ok(
      text.includes('+-- [inf] branch node-branch-1-m-s1 "Inferred branch 1 (from SEARCH boundary)" — 2 events [ids: m-s1, m-r1]'),
      `initial branch renders expanded with its ids:\n${text}`,
    );
    assert.ok(
      text.includes('x branch node-branch-1-m-s1 collapsed at 4 events'),
      `growth past the threshold collapses the branch:\n${text}`,
    );
    assert.ok(
      text.includes('+-- [inf] branch node-branch-2-m-s2'),
      `a later SEARCH opens a new branch:\n${text}`,
    );
    assert.ok(
      text.includes('collapsed: ids hidden, counts continue]') || text.includes('collapsed at '),
      'collapse semantics are stated in the output',
    );
    assert.ok(
      text.includes('frontier [OBSERVED]: node-activity-read, node-branch-2-m-s2'),
      `the frontier follows the newest branch:\n${text}`,
    );
    assert.ok(
      text.includes('status: run run-live-1 COMPLETED / completeness='),
      'terminal lifecycle is reported once',
    );
    assert.equal(
      lines.filter((l) => l.startsWith('status: run run-live-1 COMPLETED')).length,
      1,
      'status lines are deduped across polls',
    );
    assert.ok(
      text.includes('monitor: stopped (terminal and stable)'),
      `stops after the run is terminal and stable:\n${text}`,
    );
    for (const line of lines) {
      assert.ok(!line.includes('\u001b'), `no ESC bytes: ${JSON.stringify(line)}`);
    }
  });

  it('keeps monitoring a run with no answer yet and exits honestly when it ends without one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vt-m4-noanswer-'));
    const fixture = join(root, 'no-answer.jsonl');
    await writeFile(
      fixture,
      [
        recordLine({ recordKind: 'run', lifecycle: 'RUNNING' }),
        eventLine('n-s1', 'SEARCH', SEARCH('no answer query'), 1),
        recordLine({ recordKind: 'run', lifecycle: 'COMPLETED' }),
      ].join('\n') + '\n',
      'utf8',
    );
    await ingestFile(fixture, { dataRoot: root });
    const store = await ViewTraceStore.open({ dataRoot: root });
    const lines: string[] = [];
    let exit: number;
    try {
      exit = await runMonitor(
        store,
        { runId: RUN_ID, intervalMs: 1, maxWaitMs: 5_000, json: false, dataRoot: root },
        {
          emit: (l) => lines.push(l),
          emitJson: (v) => lines.push(JSON.stringify(v)),
          fail: (m) => lines.push(`FAIL ${m}`),
          sleep: async () => undefined,
          now: () => 0,
        },
      );
    } finally {
      store.close();
    }
    assert.equal(exit, 1, 'a terminal run without receipts cannot be analyzed');
    const text = lines.join('\n');
    assert.ok(
      text.includes('answer: none recorded yet — association UNKNOWN; no tree derived'),
      'absence is stated as UNKNOWN, never filled with a derived tree',
    );
    assert.ok(text.includes('ended with no answer receipts'));
  });
});
