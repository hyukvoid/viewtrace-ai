import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { analyzeEvents } from '../src/viewtrace/analyzer/index.js';
import type { ViewTraceEvent } from '../src/viewtrace/types.js';

function generateSyntheticEvents(count: number): ViewTraceEvent[] {
  const events: ViewTraceEvent[] = [];
  const baseTime = 1775550000000;

  for (let i = 1; i <= count; i++) {
    const timeIso = new Date(baseTime + i * 1000).toISOString();
    const typeMod = i % 5;

    if (typeMod === 0) {
      events.push({
        recordKind: 'event',
        schemaVersion: 1,
        eventId: `ev-perf-${i}`,
        runId: 'run-perf',
        type: 'SEARCH',
        occurredAt: timeIso,
        sequence: i,
        receivedAt: timeIso,
        adapterId: 'viewtrace-reference-jsonl',
        adapterVersion: '1.0.0',
        origin: { producer: 'perf-synthetic' },
        source: {
          sourceId: `src-perf-${i % 20}`,
          kind: 'URL',
          location: `https://example.com/topic-${i % 20}`,
        },
        provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: `c-${i}` } },
        payload: {
          type: 'SEARCH',
          query: `query for topic ${i % 20}`,
          results: [{ sourceId: `src-perf-${i % 20}` }],
        },
      });
    } else if (typeMod === 1 || typeMod === 2) {
      events.push({
        recordKind: 'event',
        schemaVersion: 1,
        eventId: `ev-perf-${i}`,
        runId: 'run-perf',
        type: 'READ',
        occurredAt: timeIso,
        sequence: i,
        receivedAt: timeIso,
        adapterId: 'viewtrace-reference-jsonl',
        adapterVersion: '1.0.0',
        origin: { producer: 'perf-synthetic' },
        source: {
          sourceId: `src-perf-${i % 20}`,
          kind: 'URL',
          location: `https://example.com/topic-${i % 20}`,
          accessedAt: timeIso,
        },
        provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: `c-${i}` } },
        payload: {
          type: 'READ',
          sourceId: `src-perf-${i % 20}`,
          outcome: 'SUCCESS',
          summary: `Read content for topic ${i % 20}`,
        },
      });
    } else if (typeMod === 3) {
      events.push({
        recordKind: 'event',
        schemaVersion: 1,
        eventId: `ev-perf-${i}`,
        runId: 'run-perf',
        type: 'CLAIM',
        occurredAt: timeIso,
        sequence: i,
        receivedAt: timeIso,
        adapterId: 'viewtrace-reference-jsonl',
        adapterVersion: '1.0.0',
        origin: { producer: 'perf-synthetic' },
        source: {
          sourceId: `src-perf-${i % 20}`,
          kind: 'URL',
          location: `https://example.com/topic-${i % 20}`,
        },
        provenance: { category: 'AGENT_REPORTED' },
        payload: {
          type: 'CLAIM',
          text: `Claim assertion for topic ${i % 20} sequence ${i}`,
          sourceId: `src-perf-${i % 20}`,
        },
      });
    } else {
      events.push({
        recordKind: 'event',
        schemaVersion: 1,
        eventId: `ev-perf-${i}`,
        runId: 'run-perf',
        type: 'COMPARE',
        occurredAt: timeIso,
        sequence: i,
        receivedAt: timeIso,
        adapterId: 'viewtrace-reference-jsonl',
        adapterVersion: '1.0.0',
        origin: { producer: 'perf-synthetic' },
        source: { sourceId: 'src-matrix', kind: 'TOOL_RESULT' },
        provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: `c-${i}` } },
        payload: {
          type: 'COMPARE',
          candidates: [`Cand-${i % 3}`, `Cand-${(i + 1) % 3}`],
          criteria: ['Speed', 'Cost'],
          cells: [
            {
              candidate: `Cand-${i % 3}`,
              criterion: 'Speed',
              value: 'Fast',
              sourceIds: [`src-perf-${i % 20}`],
            },
          ],
        },
      });
    }
  }

  return events;
}

function calculateP95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank method for p95
  const idx = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function calculateMedian(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

describe('M3 deterministic performance benchmarks (docs/MILESTONES.md §4)', () => {
  it('meets 1k vs 10k deterministic benchmark criteria: 10k p95 <= 6.0s, median ratio <= 25x', () => {
    // 1. Generate 1k events benchmark
    const events1k = generateSyntheticEvents(1000);
    // Warmup 1k
    analyzeEvents(events1k, { answerId: 'ans-perf-1k' });

    const samples1k: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      const rep = analyzeEvents(events1k, { answerId: 'ans-perf-1k' });
      const elapsed = performance.now() - t0;
      samples1k.push(elapsed);
      assert.ok(rep.claims.length > 0);
    }

    const median1k = Math.max(1.0, calculateMedian(samples1k)); // Minimum 1ms per contract
    const p95_1k = calculateP95(samples1k);

    // 2. Generate 10k events benchmark
    const events10k = generateSyntheticEvents(10000);
    // Warmup 10k
    analyzeEvents(events10k, { answerId: 'ans-perf-10k' });

    const samples10k: number[] = [];
    let report10k: any = null;
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      report10k = analyzeEvents(events10k, { answerId: 'ans-perf-10k' });
      const elapsed = performance.now() - t0;
      samples10k.push(elapsed);
    }

    const p95_10k = calculateP95(samples10k);
    const median10k = calculateMedian(samples10k);
    const ratio = median10k / median1k;

    process.stderr.write(
      `[M3-PERF] 1k: median=${median1k.toFixed(2)}ms, p95=${p95_1k.toFixed(2)}ms | 10k: median=${median10k.toFixed(2)}ms, p95=${p95_10k.toFixed(2)}ms | ratio=${ratio.toFixed(2)}x\n`,
    );

    // Assertions per docs/MILESTONES.md §4:
    // 10k p95 <= 6.0s (6000ms)
    assert.ok(
      p95_10k <= 6000,
      `10k p95 must be <= 6000ms; measured ${p95_10k.toFixed(2)}ms`,
    );

    // median growth <= 25x (compared to 1k)
    assert.ok(
      ratio <= 25.0,
      `10k median / 1k median ratio must be <= 25x; measured ${ratio.toFixed(2)}x`,
    );

    // Accurate count and relations preserved
    assert.ok(report10k.claims.length > 0);
    assert.ok(report10k.sources.length > 0);
    assert.ok(report10k.topology.nodes.length > 0);
  });
});
