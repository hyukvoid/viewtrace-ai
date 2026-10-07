import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTopology } from '../src/viewtrace/analyzer/topology.js';
import { buildSourceLedger } from '../src/viewtrace/analyzer/source-ledger.js';
import type { ViewTraceEvent } from '../src/viewtrace/types.js';

describe('M3 topology, exploration tree and honest concentration denominators', () => {
  const events: ViewTraceEvent[] = [
    {
      recordKind: 'event',
      schemaVersion: 1,
      eventId: 'ev-1',
      runId: 'run-topo',
      type: 'SEARCH',
      occurredAt: '2026-10-07T10:00:00Z',
      sequence: 1,
      receivedAt: '2026-10-07T10:00:00Z',
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.0.0',
      origin: { producer: 'test' },
      source: { sourceId: 'src-1', kind: 'URL', location: 'https://example.com/1' },
      provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'c1' } },
      payload: { type: 'SEARCH', query: 'search 1', results: [] },
    },
    {
      recordKind: 'event',
      schemaVersion: 1,
      eventId: 'ev-2',
      runId: 'run-topo',
      type: 'READ',
      occurredAt: '2026-10-07T10:00:10Z',
      sequence: 2,
      receivedAt: '2026-10-07T10:00:10Z',
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.0.0',
      origin: { producer: 'test' },
      source: { sourceId: 'src-1', kind: 'URL', location: 'https://example.com/1' },
      provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'c2' } },
      payload: { type: 'READ', sourceId: 'src-1', outcome: 'SUCCESS' },
    },
    {
      recordKind: 'event',
      schemaVersion: 1,
      eventId: 'ev-3',
      runId: 'run-topo',
      type: 'READ',
      occurredAt: '2026-10-07T10:00:20Z',
      sequence: 3,
      receivedAt: '2026-10-07T10:00:20Z',
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.0.0',
      origin: { producer: 'test' },
      source: { sourceId: 'src-1', kind: 'URL', location: 'https://example.com/1' },
      provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'c3' } },
      payload: { type: 'READ', sourceId: 'src-1', outcome: 'SUCCESS' },
    },
  ];

  it('builds nodes, edges, duration, and honest concentration denominators', () => {
    const sources = buildSourceLedger(events);
    const topo = buildTopology(events, sources);

    // Nodes check
    assert.ok(topo.nodes.some((n) => n.kind === 'ACTIVITY'));
    assert.ok(topo.nodes.some((n) => n.kind === 'QUERY_CLUSTER'));
    assert.ok(topo.nodes.some((n) => n.kind === 'BRANCH'));

    // Edges check
    const seqEdges = topo.edges.filter((e) => e.kind === 'OBSERVED_SEQUENCE');
    assert.equal(seqEdges.length, 2);
    assert.ok(topo.edges.some((e) => e.kind === 'INFERRED_BRANCH'));

    // Frontier check
    assert.equal(topo.frontierStatus, 'OBSERVED');
    assert.ok(topo.currentFrontierNodeIds?.includes('node-activity-read'));

    // Duration check
    assert.ok(topo.observedDuration);
    assert.equal(topo.observedDuration?.milliseconds, 20000); // 10:00:00 to 10:00:20
    assert.equal(topo.observedDuration?.measurement, 'CAPTURED_EVENT_TIMESTAMPS');

    // Concentration denominators check (mathematically honest: totalEvents === 3)
    assert.equal(topo.activityConcentration.length, 1);
    const actMetric = topo.activityConcentration[0]!;
    assert.equal(actMetric.denominator, 3);
    assert.equal(actMetric.numerator, 2); // 2 READs out of 3 events
    assert.equal(actMetric.unit, 'EVENTS');
    assert.equal(actMetric.meaning, 'OBSERVED_ACTIVITY_SHARE');
  });
});
