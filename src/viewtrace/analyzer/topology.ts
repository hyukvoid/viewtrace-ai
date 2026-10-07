/**
 * ViewTrace M3 Exploration Tree and Topology Engine.
 *
 * Constructs topology nodes/edges (activity, query cluster, inferred branch
 * and facet nodes), frontier status, observed duration, and mathematically
 * honest activity and source concentration metrics.
 * Per docs/MILESTONES.md §8: denominators represent actual event/source
 * counts, never CoT, hidden thought steps, or network traffic proxies.
 * Inferred structures (branch segmentation, facet grouping) are labelled
 * VIEWTRACE_INFERRED with the rule and its limits attached.
 */

import type {
  ConcentrationMetric,
  DerivedBasis,
  ObservedDuration,
  SourceLedgerEntry,
  TopologyAnalysis,
  TopologyEdge,
  TopologyFoldSnapshot,
  TopologyNode,
} from '../analysis-types.js';
import type { ViewTraceEvent } from '../types.js';

export interface TopologyFold {
  readonly eventIndex: { eventId: string; type: string; sequence: number }[];
  first: { eventId: string; occurredAt: string } | undefined;
  last: { eventId: string; occurredAt: string } | undefined;
  readonly eventsByType: Map<string, string[]>;
  readonly queryClusters: { eventId: string; query: string }[];
  readonly sequencePairs: { fromEventId: string; toEventId: string; fromType: string; toType: string }[];
  readonly readCountsByCanonicalSource: Map<string, number>;
  addEvent(ev: ViewTraceEvent, canonicalSourceId?: string): void;
  snapshot(): TopologyFoldSnapshot;
}

export function createTopologyFold(): TopologyFold {
  const eventIndex: TopologyFold['eventIndex'] = [];
  const eventsByType = new Map<string, string[]>();
  const queryClusters: { eventId: string; query: string }[] = [];
  const sequencePairs: TopologyFold['sequencePairs'] = [];
  const readCountsByCanonicalSource = new Map<string, number>();

  const fold: TopologyFold = {
    eventIndex,
    first: undefined,
    last: undefined,
    eventsByType,
    queryClusters,
    sequencePairs,
    readCountsByCanonicalSource,
    addEvent(ev: ViewTraceEvent, canonicalSourceId?: string): void {
      const prev = eventIndex[eventIndex.length - 1];
      eventIndex.push({ eventId: ev.eventId, type: ev.type, sequence: ev.sequence });
      const list = eventsByType.get(ev.type) ?? [];
      list.push(ev.eventId);
      eventsByType.set(ev.type, list);

      if (!fold.first) fold.first = { eventId: ev.eventId, occurredAt: ev.occurredAt };
      fold.last = { eventId: ev.eventId, occurredAt: ev.occurredAt };

      if (prev) {
        sequencePairs.push({
          fromEventId: prev.eventId,
          toEventId: ev.eventId,
          fromType: prev.type,
          toType: ev.type,
        });
      }

      if (ev.type === 'SEARCH') {
        queryClusters.push({ eventId: ev.eventId, query: (ev.payload as { query?: string }).query ?? 'search' });
      }

      if (ev.type === 'READ' && canonicalSourceId) {
        readCountsByCanonicalSource.set(
          canonicalSourceId,
          (readCountsByCanonicalSource.get(canonicalSourceId) ?? 0) + 1,
        );
      }
    },
    snapshot(): TopologyFoldSnapshot {
      const copy = (x?: { eventId: string; occurredAt: string }) => (x ? { ...x } : undefined);
      return {
        eventIndex: eventIndex.map(({ eventId, type, sequence }) => ({ eventId, type, sequence })),
        eventsByType: Array.from(eventsByType.entries()).map(([type, eventIds]) => ({ type, eventIds: [...eventIds] })),
        queryClusters: queryClusters.map((q) => ({ ...q })),
        firstEvent: copy(fold.first),
        lastEvent: copy(fold.last),
        sequencePairs: sequencePairs.map((p) => ({ ...p })),
        readCountsByCanonicalSource: Array.from(readCountsByCanonicalSource.entries()).map(
          ([canonicalSourceId, count]) => ({ canonicalSourceId, count }),
        ),
      };
    },
  };
  return fold;
}

export function restoreTopologyFold(snap: TopologyFoldSnapshot): TopologyFold {
  const fold = createTopologyFold();
  for (const e of snap.eventIndex) fold.eventIndex.push({ ...e });
  for (const { type, eventIds } of snap.eventsByType) fold.eventsByType.set(type, [...eventIds]);
  for (const q of snap.queryClusters) fold.queryClusters.push({ ...q });
  for (const p of snap.sequencePairs) fold.sequencePairs.push({ ...p });
  for (const r of snap.readCountsByCanonicalSource)
    fold.readCountsByCanonicalSource.set(r.canonicalSourceId, r.count);
  fold.first = snap.firstEvent ? { ...snap.firstEvent } : undefined;
  fold.last = snap.lastEvent ? { ...snap.lastEvent } : undefined;
  return fold;
}

function foldSequencePairs(snap: TopologyFoldSnapshot): readonly {
  fromEventId: string;
  toEventId: string;
  fromType: string;
  toType: string;
}[] {
  return snap.sequencePairs;
}

const INFERRED_TOPOLOGY_BASIS: DerivedBasis = {
  ruleId: 'topology-inference-v1',
  ruleVersion: '1.0.0',
  inputAnchors: [],
  limitations: [
    'Branch and facet structure is an inferred segmentation of observed events (SEARCH boundaries, shared canonical sources); it is not a reconstruction of agent reasoning or hidden thought paths.',
    'No discard rationale is inferred for non-final branches; branch abandonment is not claimed.',
  ],
};

export function buildTopologyFromSnapshot(
  snap: TopologyFoldSnapshot,
  sources: readonly SourceLedgerEntry[],
): TopologyAnalysis {
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];

  const totalEvents = snap.eventIndex.length;

  // 1. Group events by activity type into ACTIVITY nodes
  for (const { type, eventIds } of snap.eventsByType) {
    nodes.push({
      nodeId: `node-activity-${type.toLowerCase()}`,
      kind: 'ACTIVITY',
      label: `${type} Activity (${eventIds.length})`,
      eventIds: [...eventIds],
      provenance: 'VIEWTRACE_OBSERVED',
    });
  }

  // 2. QUERY_CLUSTER nodes from SEARCH events
  for (const q of snap.queryClusters) {
    nodes.push({
      nodeId: `node-query-${q.eventId}`,
      kind: 'QUERY_CLUSTER',
      label: `Query: ${q.query.slice(0, 40)}`,
      eventIds: [q.eventId],
      provenance: 'VIEWTRACE_OBSERVED',
    });
  }

  // 3. Inferred BRANCH nodes: segmentation at observed SEARCH boundaries (linear pass)
  const searchIndex = snap.eventIndex.filter((e) => e.type === 'SEARCH');
  const branches: { nodeId: string; eventIds: string[] }[] = [];
  if (searchIndex.length > 0) {
    let currentBranchIdx = 0;
    let currentBranch: { nodeId: string; eventIds: string[] } | null = null;
    let sIdx = 0;
    for (const e of snap.eventIndex) {
      if (sIdx < searchIndex.length && e.sequence === searchIndex[sIdx]!.sequence) {
        if (currentBranch) {
          branches.push(currentBranch);
          nodes.push({
            nodeId: currentBranch.nodeId,
            kind: 'BRANCH',
            label: `Inferred branch ${currentBranchIdx} (from SEARCH boundary)`,
            eventIds: currentBranch.eventIds,
            provenance: 'VIEWTRACE_INFERRED',
            basis: INFERRED_TOPOLOGY_BASIS,
          });
        }
        currentBranchIdx++;
        currentBranch = {
          nodeId: `node-branch-${currentBranchIdx}-${e.eventId}`,
          eventIds: [e.eventId],
        };
        sIdx++;
      } else if (currentBranch) {
        currentBranch.eventIds.push(e.eventId);
      }
    }
    if (currentBranch) {
      branches.push(currentBranch);
      nodes.push({
        nodeId: currentBranch.nodeId,
        kind: 'BRANCH',
        label: `Inferred branch ${currentBranchIdx} (from SEARCH boundary)`,
        eventIds: currentBranch.eventIds,
        provenance: 'VIEWTRACE_INFERRED',
        basis: INFERRED_TOPOLOGY_BASIS,
      });
    }

    // INFERRED_BRANCH edges: branch -> its query cluster node
    for (let i = 0; i < branches.length; i++) {
      const b = branches[i]!;
      edges.push({
        edgeId: `edge-ibranch-${b.nodeId}`,
        fromNodeId: b.nodeId,
        toNodeId: `node-query-${searchIndex[i]!.eventId}`,
        kind: 'INFERRED_BRANCH',
        eventIds: [searchIndex[i]!.eventId],
        basis: INFERRED_TOPOLOGY_BASIS,
      });
      if (i > 0) {
        edges.push({
          edgeId: `edge-ibranch-seq-${branches[i - 1]!.nodeId}-${b.nodeId}`,
          fromNodeId: branches[i - 1]!.nodeId,
          toNodeId: b.nodeId,
          kind: 'INFERRED_BRANCH',
          eventIds: [searchIndex[i - 1]!.eventId, searchIndex[i]!.eventId],
          basis: INFERRED_TOPOLOGY_BASIS,
        });
      }
    }
  }

  // 4. FACET nodes: groups of query clusters sharing a canonical source
  const sourceByAnchorEvent = new Map<string, string>();
  for (const src of sources) {
    for (const a of src.anchors) {
      if (a.eventId) sourceByAnchorEvent.set(a.eventId, src.canonicalSourceId);
    }
  }
  const facetGroups = new Map<string, string[]>(); // canonical source -> query eventIds
  for (const q of snap.queryClusters) {
    const canonical = sourceByAnchorEvent.get(q.eventId);
    if (canonical) {
      const list = facetGroups.get(canonical) ?? [];
      if (!list.includes(q.eventId)) list.push(q.eventId);
      facetGroups.set(canonical, list);
    }
  }
  let facetIdx = 0;
  for (const [canonical, queryEventIds] of facetGroups) {
    facetIdx++;
    const nodeId = `node-facet-${facetIdx}-${canonical}`;
    nodes.push({
      nodeId,
      kind: 'FACET',
      label: `Facet: sources shared with ${canonical}`,
      eventIds: [...queryEventIds],
      provenance: 'VIEWTRACE_INFERRED',
      basis: INFERRED_TOPOLOGY_BASIS,
    });
    for (const qeid of queryEventIds) {
      edges.push({
        edgeId: `edge-facet-${nodeId}-${qeid}`,
        fromNodeId: nodeId,
        toNodeId: `node-query-${qeid}`,
        kind: 'INFERRED_BRANCH',
        eventIds: [qeid],
        basis: INFERRED_TOPOLOGY_BASIS,
      });
    }
  }

  // 5. Observed sequence edges between successive events (per observed
  // pair, preserving traceability to both anchor events)
  for (const pair of foldSequencePairs(snap)) {
    edges.push({
      edgeId: `edge-seq-${pair.fromEventId}-${pair.toEventId}`,
      fromNodeId: `node-activity-${pair.fromType.toLowerCase()}`,
      toNodeId: `node-activity-${pair.toType.toLowerCase()}`,
      kind: 'OBSERVED_SEQUENCE',
      eventIds: [pair.fromEventId, pair.toEventId],
    });
  }

  // SHARED_SOURCE edges between branches that read a common canonical source (indexed lookup)
  const branchesBySource = new Map<string, number[]>();
  for (let i = 0; i < branches.length; i++) {
    const b = branches[i]!;
    const seenSources = new Set<string>();
    for (const eid of b.eventIds) {
      const c = sourceByAnchorEvent.get(eid);
      if (c && !seenSources.has(c)) {
        seenSources.add(c);
        const list = branchesBySource.get(c) ?? [];
        list.push(i);
        branchesBySource.set(c, list);
      }
    }
  }
  const connectedBranchPairs = new Set<string>();
  for (const [, branchIdxs] of branchesBySource) {
    if (branchIdxs.length < 2) continue;
    // Chain consecutive branches reading the same source (exploration sequence rail without O(B^2) graph blowup)
    for (let i = 0; i < branchIdxs.length - 1; i++) {
      const bi = branchIdxs[i]!;
      const bj = branchIdxs[i + 1]!;
      const pairKey = `${bi}-${bj}`;
      if (!connectedBranchPairs.has(pairKey)) {
        connectedBranchPairs.add(pairKey);
        edges.push({
          edgeId: `edge-shared-${branches[bi]!.nodeId}-${branches[bj]!.nodeId}`,
          fromNodeId: branches[bi]!.nodeId,
          toNodeId: branches[bj]!.nodeId,
          kind: 'SHARED_SOURCE',
          eventIds: [],
        });
      }
    }
  }

  // 6. Concentration Metrics (Mathematically honest denominators)
  const activityConcentration: ConcentrationMetric[] = [];

  if (totalEvents > 0) {
    let maxTypeCount = 0;
    for (const { eventIds } of snap.eventsByType) {
      if (eventIds.length > maxTypeCount) maxTypeCount = eventIds.length;
    }

    activityConcentration.push({
      numerator: maxTypeCount,
      denominator: totalEvents,
      excluded: 0,
      unit: 'EVENTS',
      meaning: 'OBSERVED_ACTIVITY_SHARE',
    });
  }

  const totalSources = sources.length;
  const sourceConcentration: ConcentrationMetric[] = [];
  if (totalSources > 0 && totalEvents > 0) {
    let maxReads = 0;
    for (const { count } of snap.readCountsByCanonicalSource) {
      if (count > maxReads) maxReads = count;
    }
    const maxAnchors = Math.max(maxReads, ...sources.map((s) => s.anchors.length), 0);
    sourceConcentration.push({
      numerator: maxAnchors,
      denominator: totalEvents,
      excluded: 0,
      unit: 'SOURCES',
      meaning: 'SOURCE_SHARE',
    });
  }

  // 7. Observed Duration
  let observedDuration: ObservedDuration | undefined = undefined;
  if (snap.firstEvent && snap.lastEvent) {
    const t0 = Date.parse(snap.firstEvent.occurredAt);
    const t1 = Date.parse(snap.lastEvent.occurredAt);
    if (!isNaN(t0) && !isNaN(t1) && t1 >= t0) {
      observedDuration = {
        milliseconds: t1 - t0,
        startEventId: snap.firstEvent.eventId,
        endEventId: snap.lastEvent.eventId,
        measurement: 'CAPTURED_EVENT_TIMESTAMPS',
      };
    }
  }

  // 8. Current Frontier — the latest observed activity; OBSERVED means
  // "this is where observation ends", not a claim about agent intent.
  const frontierStatus: TopologyAnalysis['frontierStatus'] = totalEvents > 0 ? 'OBSERVED' : 'UNKNOWN';
  const lastEntry = snap.eventIndex[snap.eventIndex.length - 1];
  const currentFrontierNodeIds: string[] = [];
  if (lastEntry) {
    currentFrontierNodeIds.push(`node-activity-${lastEntry.type.toLowerCase()}`);
    const branchIdx = branches.findIndex((b) => b.eventIds.includes(lastEntry.eventId));
    if (branchIdx >= 0) currentFrontierNodeIds.push(branches[branchIdx]!.nodeId);
  }

  return {
    nodes,
    edges,
    frontierStatus,
    currentFrontierNodeIds: currentFrontierNodeIds.length > 0 ? currentFrontierNodeIds : undefined,
    activityConcentration,
    sourceConcentration,
    observedDuration,
    limitations: [
      'Topology structures and concentration denominators reflect observed trace events only.',
      'Denominators exclude uncaptured internal operations and do not proxy hidden thought processes.',
      'Branch and facet nodes are inferred segmentations (rule topology-inference-v1); absence of a branch does not mean the agent abandoned an idea.',
      'Frontier status OBSERVED denotes the end of the observed event sequence only.',
    ],
  };
}

export function snapshotFromEvents(events: readonly ViewTraceEvent[]): TopologyFoldSnapshot {
  const fold = createTopologyFold();
  for (const ev of events) fold.addEvent(ev);
  return fold.snapshot();
}

export function buildTopology(
  events: readonly ViewTraceEvent[],
  sources: readonly SourceLedgerEntry[],
): TopologyAnalysis {
  return buildTopologyFromSnapshot(snapshotFromEvents(events), sources);
}
