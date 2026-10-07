/**
 * M4 CLI presentation-boundary tests: the Live Exploration Tree state
 * machine and the analysis report renderer, driven directly with synthetic
 * AnalysisReportV1 objects (docs/MILESTONES.md §9).
 *
 * The renderer must never derive structure of its own — these tests pin the
 * honesty behaviors that exist purely at the presentation layer: repeated
 * collapse/expand, branch growth counts, reconnect dedup, run/answer switch
 * isolation, collapse never hiding unresolved/dropped items, honest
 * frontier, relation lanes from relation provenance, and terminal-injection
 * sanitization of producer-controlled labels.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ExplorationTreeSession,
  TreeTracker,
} from '../src/viewtrace/presentation/tree.js';
import { renderAnalysisReport } from '../src/viewtrace/presentation/report-view.js';
import type {
  AnalysisReportV1,
  ConflictAnalysis,
  JevResultV2,
  ModeProjection,
  TopologyAnalysis,
  TopologyEdge,
  TopologyNode,
  VerifyAssessment,
} from '../src/viewtrace/analysis-types.js';

const BASIS = {
  ruleId: 'test-rule',
  ruleVersion: '1.0.0',
  inputAnchors: [],
  limitations: [],
};

function branchNode(index: number, firstEventId: string, eventIds: readonly string[]): TopologyNode {
  return {
    nodeId: `node-branch-${index}-${firstEventId}`,
    kind: 'BRANCH',
    label: `Inferred branch ${index} (from SEARCH boundary)`,
    eventIds: [...eventIds],
    provenance: 'VIEWTRACE_INFERRED',
    basis: BASIS,
  };
}

function queryNode(eventId: string, query: string): TopologyNode {
  return {
    nodeId: `node-query-${eventId}`,
    kind: 'QUERY_CLUSTER',
    label: `Query: ${query}`,
    eventIds: [eventId],
    provenance: 'VIEWTRACE_OBSERVED',
  };
}

function activityNode(type: string, eventIds: readonly string[]): TopologyNode {
  return {
    nodeId: `node-activity-${type.toLowerCase()}`,
    kind: 'ACTIVITY',
    label: `${type} Activity (${eventIds.length})`,
    eventIds: [...eventIds],
    provenance: 'VIEWTRACE_OBSERVED',
  };
}

function inferredEdge(from: string, to: string): TopologyEdge {
  return {
    edgeId: `edge-ibranch-${from}-${to}`,
    fromNodeId: from,
    toNodeId: to,
    kind: 'INFERRED_BRANCH',
    eventIds: [],
    basis: BASIS,
  };
}

function sharedSourceEdge(from: string, to: string): TopologyEdge {
  return {
    edgeId: `edge-shared-${from}-${to}`,
    fromNodeId: from,
    toNodeId: to,
    kind: 'SHARED_SOURCE',
    eventIds: [],
  };
}

function detectedConflict(conflictId: string, anchorEventId: string): ConflictAnalysis {
  return {
    conflictId,
    status: 'DETECTED',
    claimIds: ['claim-1'],
    conditionMatch: 'SAME',
    history: [
      {
        status: 'DETECTED',
        inputRevision: { algorithm: 'sha256-canonical-schema1-records-v1', value: 'rev', recordCount: 4 },
        anchors: [{ runId: 'run-live', eventId: anchorEventId }],
        basis: BASIS,
      },
    ],
    limitations: [],
  };
}

function verifyAssessment(eventId: string): VerifyAssessment {
  return {
    verifyEventId: eventId,
    target: { kind: 'EVENT', eventId: 'target-1' },
    targetResolution: 'MATCHED',
    result: 'CONFIRMED',
    resolverEvidenceIds: [],
    conditionIds: [],
    correctness: 'VALID',
    limitations: [],
  };
}

interface ReportOverrides {
  runId?: string;
  answerId?: string;
  nodes?: readonly TopologyNode[];
  edges?: readonly TopologyEdge[];
  frontierStatus?: 'OBSERVED' | 'INFERRED' | 'UNKNOWN';
  frontierIds?: readonly string[];
  conflicts?: readonly ConflictAnalysis[];
  verifications?: readonly VerifyAssessment[];
  projection?: ModeProjection;
  jevResults?: readonly JevResultV2[];
  inputRevisionValue?: string;
  stateRevision?: string;
}

function makeReport(overrides: ReportOverrides = {}): AnalysisReportV1 {
  const runId = overrides.runId ?? 'run-live';
  const answerId = overrides.answerId ?? 'ans-live';
  const topology: TopologyAnalysis = {
    nodes: overrides.nodes ?? [],
    edges: overrides.edges ?? [],
    frontierStatus: overrides.frontierStatus ?? 'OBSERVED',
    currentFrontierNodeIds: overrides.frontierIds ? [...overrides.frontierIds] : undefined,
    activityConcentration: [
      { numerator: 2, denominator: 3, excluded: 0, unit: 'EVENTS', meaning: 'OBSERVED_ACTIVITY_SHARE' },
    ],
    sourceConcentration: [
      { numerator: 1, denominator: 3, excluded: 0, unit: 'SOURCES', meaning: 'SOURCE_SHARE' },
    ],
    observedDuration: {
      milliseconds: 1500,
      startEventId: 'e1',
      endEventId: 'e3',
      measurement: 'CAPTURED_EVENT_TIMESTAMPS',
    },
    limitations: [],
  };
  return {
    schema: 'viewtrace.analysis-report@1',
    captureSchemaVersion: 1,
    analyzer: { analyzerId: 'test-analyzer', analyzerVersion: '1.0.0', ruleSetVersion: '1.0.0' },
    inputRevision: {
      algorithm: 'sha256-canonical-schema1-records-v1',
      value: overrides.inputRevisionValue ?? 'rev-1',
      recordCount: 4,
    },
    stateRevision: overrides.stateRevision ?? 'state-1',
    freshness: { status: 'CURRENT', reasons: [] },
    scope: { runId, answerId, receiptId: `rec-${answerId}`, boundary: 'UNKNOWN' },
    lens: { revisions: [], currentRevisionId: 'none', currentMode: 'UNKNOWN', temporal: 'NONE' },
    projection: overrides.projection ?? { mode: 'UNKNOWN', overviewClaimIds: [], unresolvedReasonIds: [] },
    conditions: [],
    sources: [],
    evidence: [],
    claims: [],
    relations: [],
    conflicts: overrides.conflicts ?? [],
    verifications: overrides.verifications ?? [],
    support: {
      status: 'UNKNOWN',
      collectionCompleteness: 'UNKNOWN',
      coreClaimIds: [],
      evaluatedClaimIds: [],
      missingRequiredConditionIds: [],
      unresolvedConflictIds: [],
      reasonCodes: ['TARGET_UNKNOWN'],
      basis: BASIS,
    },
    topology,
    references: [],
    jevResults: overrides.jevResults ?? [],
  };
}

describe('M4 exploration tree: growth, repeated collapse, dedup, isolation', () => {
  it('prints expanded event ids, then collapses at the threshold, then counts further growth', () => {
    const session = new ExplorationTreeSession({ runId: 'run-live', answerId: 'ans-live' });
    const first = session.update(
      makeReport({
        nodes: [branchNode(1, 'e1', ['e1', 'e2']), queryNode('e1', 'first query')],
        frontierIds: ['node-activity-read'],
      }),
    );
    assert.ok(
      first.some((l) => l.includes('+-- [inf] branch node-branch-1-e1') && l.includes('[ids: e1, e2]')),
      `expanded branch lists its event ids: ${JSON.stringify(first)}`,
    );

    const collapse = session.update(
      makeReport({
        nodes: [branchNode(1, 'e1', ['e1', 'e2', 'e3', 'e4']), queryNode('e1', 'first query')],
        frontierIds: ['node-activity-read'],
      }),
    );
    assert.ok(
      collapse.some((l) => l.includes('x branch node-branch-1-e1 collapsed at 4 events')),
      `collapse transition is explicit: ${JSON.stringify(collapse)}`,
    );
    assert.ok(
      collapse.some((l) => l.includes('rail items and dropped/unknown statuses remain')),
      'collapse states that salient items survive it',
    );

    const growth = session.update(
      makeReport({
        nodes: [branchNode(1, 'e1', ['e1', 'e2', 'e3', 'e4', 'e5']), queryNode('e1', 'first query')],
        frontierIds: ['node-activity-read'],
      }),
    );
    assert.ok(
      growth.some((l) => l.includes('= branch node-branch-1-e1 now 5 events (+1 since last; still collapsed)')),
      `growth under collapse is a count line: ${JSON.stringify(growth)}`,
    );
    assert.ok(
      !growth.some((l) => l.includes('[ids: e1,')),
      'collapsed growth must not repeat the event id list',
    );
  });

  it('renders a newly appearing branch alongside growth of an old one', () => {
    const session = new ExplorationTreeSession({ runId: 'run-live', answerId: 'ans-live' });
    session.update(makeReport({ nodes: [branchNode(1, 'e1', ['e1'])] }));
    const next = session.update(
      makeReport({
        nodes: [branchNode(1, 'e1', ['e1', 'e2']), branchNode(2, 'f1', ['f1'])],
        frontierIds: ['node-branch-2-f1'],
      }),
    );
    assert.ok(next.some((l) => l.includes('+-- [inf] branch node-branch-2-f1')), 'new branch printed');
    assert.ok(
      next.some((l) => l.includes('= branch node-branch-1-e1 +1 events [ids: e2]')),
      `old branch prints only its delta ids: ${JSON.stringify(next)}`,
    );
  });

  it('re-delivering the same report emits nothing (reconnect dedup)', () => {
    const session = new ExplorationTreeSession({ runId: 'run-live', answerId: 'ans-live' });
    const report = makeReport({ nodes: [branchNode(1, 'e1', ['e1', 'e2'])] });
    const first = session.update(report);
    assert.ok(first.length > 0, 'first delivery prints the tree');
    const duplicate = session.update(report);
    assert.deepEqual(duplicate, [], 'identical re-delivery prints nothing');
    const equalCopy = session.update(makeReport({ nodes: [branchNode(1, 'e1', ['e1', 'e2'])] }));
    assert.deepEqual(equalCopy, [], 'dedup is by item identity, not object identity');
  });

  it('isolates run/answer state: interleaved scopes never leak into each other', () => {
    const tracker = new TreeTracker();
    tracker.update(makeReport({ runId: 'run-a', answerId: 'ans-a', nodes: [branchNode(1, 'a1', ['a1', 'a2'])] }));
    tracker.update(makeReport({ runId: 'run-b', answerId: 'ans-b', nodes: [branchNode(1, 'b1', ['b1', 'b2', 'b3', 'b4'])] }));
    const backToA = tracker.update(
      makeReport({ runId: 'run-a', answerId: 'ans-a', nodes: [branchNode(1, 'a1', ['a1', 'a2', 'a3', 'a4'])] }),
    );
    assert.ok(
      backToA.some((l) => l.includes('x branch node-branch-1-a1 collapsed at 4 events')),
      'run A kept its prior state across run B updates',
    );
    for (const line of backToA) {
      assert.ok(!line.includes('node-branch-1-b1'), `run B structure must not appear in run A output: ${line}`);
    }

    const session = new ExplorationTreeSession({ runId: 'run-a', answerId: 'ans-a' });
    session.update(makeReport({ runId: 'run-a', answerId: 'ans-a', nodes: [branchNode(1, 'a1', ['a1'])] }));
    const refused = session.update(makeReport({ runId: 'run-b', answerId: 'ans-b' }));
    assert.equal(refused.length, 1);
    assert.match(refused[0]!, /^tree: refusing report for run-b\/ans-b/);
  });

  it('collapse never hides unresolved conflicts, verifications or dropped branch statuses', () => {
    const session = new ExplorationTreeSession({ runId: 'run-live', answerId: 'ans-live' });
    const lines = session.update(
      makeReport({
        nodes: [branchNode(1, 'e1', ['e1', 'e2', 'e3', 'e4']), queryNode('e1', 'q')],
        conflicts: [detectedConflict('conflict-1', 'e3')],
        verifications: [verifyAssessment('e4')],
        projection: {
          mode: 'IDEATE',
          branches: [
            {
              branchId: 'branch-e1',
              eventIds: ['e1', 'e2', 'e3', 'e4'],
              status: 'DROPPED',
            },
          ],
          diversityStatus: 'OBSERVED',
        },
        frontierIds: ['node-activity-read'],
      }),
    );
    const text = lines.join('\n');
    assert.ok(text.includes('[collapsed: ids hidden, counts continue]'), 'branch starts collapsed at >= threshold');
    assert.ok(text.includes('rail CONFLICT conflict-1 [DETECTED] conditionMatch=SAME ? unresolved'), 'unresolved conflict survives collapse');
    assert.ok(text.includes('@branch node-branch-1-e1'), 'rail anchors to the collapsed branch');
    assert.ok(text.includes('rail VERIFY e4 target=event target-1'), 'verification survives collapse');
    assert.ok(text.includes('branch status branch-e1 [DROPPED]'), 'dropped status survives collapse');
    assert.ok(text.includes('discard evidence: none observed'), 'no discard evidence is invented');
  });

  it('keeps the frontier honest: UNKNOWN when nothing was observed, re-expansion on frontier entry', () => {
    const session = new ExplorationTreeSession({ runId: 'run-live', answerId: 'ans-live' });
    const unknown = session.update(makeReport({ frontierStatus: 'UNKNOWN', frontierIds: [] }));
    assert.ok(
      unknown.some((l) => l.startsWith('frontier [UNKNOWN]: no observed events — nothing claimed')),
      'empty frontier is UNKNOWN, not invented',
    );

    // A collapsed branch that the frontier later enters gets re-expanded;
    // leaving and re-entering prints the expansion again.
    const reentry = new ExplorationTreeSession({ runId: 'run-live', answerId: 'ans-live' });
    reentry.update(
      makeReport({ nodes: [branchNode(1, 'e1', ['e1', 'e2', 'e3', 'e4'])], frontierIds: ['node-activity-read'] }),
    );
    const entered = reentry.update(
      makeReport({ nodes: [branchNode(1, 'e1', ['e1', 'e2', 'e3', 'e4'])], frontierIds: ['node-branch-1-e1'] }),
    );
    assert.ok(entered.some((l) => l.includes('frontier [OBSERVED]: node-branch-1-e1')), 'frontier line printed');
    assert.ok(entered.some((l) => l.includes('frontier entered collapsed branch node-branch-1-e1 — expanded')), 'collapsed branch re-expanded for the frontier');
    const left = reentry.update(
      makeReport({ nodes: [branchNode(1, 'e1', ['e1', 'e2', 'e3', 'e4'])], frontierIds: ['node-activity-read'] }),
    );
    assert.ok(left.every((l) => !l.includes('entered collapsed')), 'no spurious expansion while away');
    const reentered = reentry.update(
      makeReport({ nodes: [branchNode(1, 'e1', ['e1', 'e2', 'e3', 'e4'])], frontierIds: ['node-branch-1-e1'] }),
    );
    assert.ok(reentered.some((l) => l.includes('frontier entered collapsed branch node-branch-1-e1 — expanded')), 'repeated expand on frontier re-entry');
  });

  it('labels edges by the relation provenance (solid/dashed), never by endpoints', () => {
    const session = new ExplorationTreeSession({ runId: 'run-live', answerId: 'ans-live' });
    const lines = session.update(
      makeReport({
        nodes: [branchNode(1, 'e1', ['e1']), queryNode('e1', 'q')],
        edges: [
          inferredEdge('node-branch-1-e1', 'node-query-e1'),
          sharedSourceEdge('node-branch-1-e1', 'node-branch-2-f1'),
        ],
      }),
    );
    const text = lines.join('\n');
    assert.ok(
      text.includes('edge node-branch-1-e1 -> node-query-e1 [INFERRED_BRANCH] lane=inf dashed'),
      'inferred relation is dashed with inf lane',
    );
    assert.ok(
      text.includes('[SHARED_SOURCE] lane=obs solid'),
      'shared-source relation is solid with obs lane',
    );
  });

  it('sanitizes producer-controlled labels (terminal injection)', () => {
    const session = new ExplorationTreeSession({ runId: 'run-live', answerId: 'ans-live' });
    const lines = session.update(
      makeReport({
        nodes: [
          queryNode('e1', 'q\u001b[31mRED\u001b[0m\u0007\r\ninject \u001b]0;title'),
          branchNode(1, 'e1', ['e1']),
        ],
      }),
    );
    for (const line of lines) {
      assert.ok(!line.includes('\u001b'), `no ESC bytes: ${JSON.stringify(line)}`);
      assert.ok(!/[\x00-\x08\x0b-\x1f]/.test(line), `no control chars: ${JSON.stringify(line)}`);
    }
    assert.ok(lines.some((l) => l.includes('RED')), 'sanitized label content survives');
  });
});

describe('M4 report view: lanes, concentration honesty, JEV advisory rendering', () => {
  it('prints concentration with denominator and unit labels', () => {
    const lines = renderAnalysisReport({
      report: makeReport({}),
      run: null,
      status: null,
      answerText: null,
      association: 'test',
    });
    const text = lines.join('\n');
    assert.match(text, /activity share: 2\/3 unit=EVENTS \(OBSERVED_ACTIVITY_SHARE; excluded 0; share is not importance or hidden reasoning/);
    assert.match(text, /source share: 1\/3 unit=SOURCES \(SOURCE_SHARE/);
    assert.ok(!text.includes('denominator = scoped observed count'), 'source and activity denominators keep their own recorded units');
    assert.ok(text.includes('Lanes: obs:'), 'provenance lanes are printed');
    assert.ok(text.includes('not hidden reasoning'), 'tree header disclaims hidden reasoning');
    assert.ok(text.includes('Latency: observed span 1500ms (CAPTURED_EVENT_TIMESTAMPS: e1 -> e3)'), 'latency is labeled by measurement basis');
  });

  it('renders JEV advisory labels and UNAVAILABLE results as UNKNOWN without support effect', () => {
    const succeeded: JevResultV2 = {
      schema: 'viewtrace.jev-result@2',
      resultId: 'jr-1',
      checkpointId: 'ck-1',
      inputRevision: { algorithm: 'sha256-canonical-schema1-records-v1', value: 'rev-1', recordCount: 4 },
      evaluator: { provider: 'local-deterministic-stub', evaluatorVersion: '2.1.0' },
      status: 'SUCCEEDED',
      labels: { evidenceGain: 'YES', progress: 'NO', rethinkNeeded: 'UNKNOWN' },
      provenance: 'EVALUATOR_REPORTED',
      supportEffect: 'NONE',
      limitations: [],
    };
    const unavailable: JevResultV2 = {
      schema: 'viewtrace.jev-result@2',
      resultId: 'jr-2',
      checkpointId: 'ck-2',
      inputRevision: { algorithm: 'sha256-canonical-schema1-records-v1', value: 'rev-1', recordCount: 4 },
      evaluator: { provider: 'none', evaluatorVersion: '0' },
      status: 'UNAVAILABLE',
      provenance: 'EVALUATOR_REPORTED',
      supportEffect: 'NONE',
      limitations: ['evaluator not configured'],
    };
    const lines = renderAnalysisReport({
      report: makeReport({ jevResults: [succeeded, unavailable] }),
      run: null,
      status: null,
      answerText: null,
      association: 'test',
    });
    const text = lines.join('\n');
    assert.ok(text.includes('advisory only — never an input to evidence support'), 'JEV stays advisory');
    assert.ok(text.includes('ck-1 [SUCCEEDED] [inf, advisory; EVALUATOR_REPORTED] evidenceGain=YES progress=NO rethinkNeeded=UNKNOWN'));
    assert.ok(
      text.includes('ck-2 [UNAVAILABLE] labels [?] UNKNOWN — evaluation failed or unavailable; the report is unaffected'),
      'unavailable JEV is labeled, not hidden',
    );
  });

  it('prints collection status with sequence/accepted/rejected/completeness/replay/latency/storage', () => {
    const lines = renderAnalysisReport({
      report: makeReport({}),
      run: {
        runId: 'run-live',
        adapterId: 'viewtrace-reference-jsonl',
        adapterVersion: '1.0.0',
        lifecycle: 'COMPLETED',
        completeness: 'PARTIAL',
        evidenceSupport: 'UNKNOWN',
        createdAt: '2026-10-07T01:00:00Z',
        updatedAt: '2026-10-07T01:05:00Z',
        eventCount: 12,
        jsonlCursor: 4400,
        jsonlLines: 14,
        lifecycleHistory: [],
      },
      status: {
        run: {
          runId: 'run-live',
          adapterId: 'viewtrace-reference-jsonl',
          adapterVersion: '1.0.0',
          lifecycle: 'COMPLETED',
          completeness: 'PARTIAL',
          evidenceSupport: 'UNKNOWN',
          createdAt: '2026-10-07T01:00:00Z',
          updatedAt: '2026-10-07T01:05:00Z',
          eventCount: 12,
          jsonlCursor: 4400,
          jsonlLines: 14,
          lifecycleHistory: [],
        },
        scoped: { count: 12, maxSequence: 15 },
        scopeLabel: 'answer-scoped',
        diagnosticsTotal: 3,
        errorDiagnostics: 1,
        lossDiagnostics: 2,
        diagnosticsPageCapped: false,
        dataRoot: '/tmp/vt-status',
      },
      answerText: 'Stored answer text',
      association: 'explicit answer identity within this run',
    });
    const text = lines.join('\n');
    assert.ok(text.includes('collection: lifecycle=COMPLETED completeness=PARTIAL'));
    assert.ok(text.includes('sequence: max=15 accepted events=12 (answer-scoped: 12 records)'));
    assert.ok(text.includes('rejected/validation errors: 1 losses: 2 diagnostics total: 3'));
    assert.ok(text.includes('replay: trace.jsonl lines=14 cursor=4400 (derived export; database is authoritative)'));
    assert.ok(text.includes('storage: /tmp/vt-status — viewtrace.db (authoritative)'));
    assert.ok(text.includes('Stored answer: Stored answer text'));
    assert.ok(text.includes('Association: explicit answer identity within this run'));
  });
});
