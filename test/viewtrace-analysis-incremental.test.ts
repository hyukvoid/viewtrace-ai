import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { viewtraceFixture, tempDataRoot, makeEvent, makeRunRecord } from './helpers/viewtrace.js';
import { receipt } from './helpers/m2.js';
import { ViewTraceStore } from '../src/viewtrace/store.js';
import { ingestFile } from '../src/viewtrace/ingest.js';
import { analyzeAnswer, analyzeAnswerWithStats, rebuildAnalysis } from '../src/viewtrace/analyzer/index.js';
import { M3_INCREMENTAL_STATE_SCHEMA } from '../src/viewtrace/analysis-types.js';

describe('M3 incremental analyzer, state persistence and rebuild equivalence', () => {
  it('proves incremental output === deterministic full rebuild output', async () => {
    const root = await tempDataRoot('incremental-equivalence');
    const fixturePath = viewtraceFixture('analysis-incremental.jsonl');

    await ingestFile(fixturePath, { dataRoot: root });
    const store = await ViewTraceStore.open({ dataRoot: root });

    try {
      const runId = 'run-incremental-001';
      const ans1 = 'ans-inc-t1';
      const ans2 = 'ans-inc-t2';

      // Incremental analysis
      const report1 = await analyzeAnswer(store, runId, ans1);
      const report2 = await analyzeAnswer(store, runId, ans2);

      // Rebuild analysis from scratch
      const rebuild1 = await rebuildAnalysis(store, runId, ans1);
      const rebuild2 = await rebuildAnalysis(store, runId, ans2);

      assert.ok(report1 && rebuild1);
      assert.ok(report2 && rebuild2);

      // Invariance assertion: must be deeply equal!
      assert.deepEqual(report1, rebuild1);
      assert.deepEqual(report2, rebuild2);
    } finally {
      store.close();
    }
  });

  it('proves 0 cross-answer pollution between multi-turn answers', async () => {
    const root = await tempDataRoot('cross-answer-pollution');
    const store = await ViewTraceStore.open({ dataRoot: root });

    try {
      await ingestFile(viewtraceFixture('analysis-incremental.jsonl'), { dataRoot: root });
      const runId = 'run-incremental-001';

      const report1 = await analyzeAnswer(store, runId, 'ans-inc-t1');
      const report2 = await analyzeAnswer(store, runId, 'ans-inc-t2');

      assert.ok(report1 && report2);

      // Answer 1 claims must only relate to Alpha
      assert.ok(report1.claims.some((c) => c.text.includes('Alpha')));
      assert.ok(!report1.claims.some((c) => c.text.includes('Beta')));

      // Answer 2 claims must only relate to Beta
      assert.ok(report2.claims.some((c) => c.text.includes('Beta')));
      assert.ok(!report2.claims.some((c) => c.text.includes('Alpha')));

      // Scopes must remain strictly separated
      assert.equal(report1.scope.answerId, 'ans-inc-t1');
      assert.equal(report2.scope.answerId, 'ans-inc-t2');
    } finally {
      store.close();
    }
  });

  it('persists and restores incremental analysis state via store artifacts', async () => {
    const root = await tempDataRoot('state-persistence');
    const store = await ViewTraceStore.open({ dataRoot: root });

    try {
      await ingestFile(viewtraceFixture('analysis-incremental.jsonl'), { dataRoot: root });
      const runId = 'run-incremental-001';
      const ansId = 'ans-inc-t1';

      // analyzeAnswerWithStats persists state and report
      const res = await analyzeAnswerWithStats(store, runId, ansId);
      assert.ok(res);

      const restoredState = await store.getAnalysisState(runId, ansId);
      assert.ok(restoredState);
      assert.equal(restoredState.scopes[0]?.answerId, ansId);
      assert.equal(restoredState.schema, M3_INCREMENTAL_STATE_SCHEMA);
      assert.ok(restoredState.fold);
      assert.ok(restoredState.cursors.length > 0);

      const restoredReport = await store.getAnalysisReport(runId, ansId);
      assert.ok(restoredReport);
      assert.deepEqual(restoredReport, JSON.parse(JSON.stringify(res.report)));
    } finally {
      store.close();
    }
  });

  it('proves incremental delta processing reuses state, processes only new events, and matches full rebuild', async () => {
    const root = await tempDataRoot('delta-measured-stats');
    const store = await ViewTraceStore.open({ dataRoot: root });
    const runId = 'run-delta-001';
    const ansId = 'ans-delta-001';
    const receiptId = 'rec-delta-001';

    try {
      await store.createRun(runId, { adapterId: 'test', adapterVersion: '1.0.0' });

      const ev1 = makeEvent({
        eventId: 'ev-d1',
        runId,
        type: 'SEARCH',
        sequence: 2,
        source: { sourceId: 'src-1', kind: 'URL', location: 'https://engine.test' },
        provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'tc-1' } },
        payload: { type: 'SEARCH', query: 'find evidence', results: [{ sourceId: 'src-1', title: 'res-1', url: 'https://docs.test/item' }] },
      });

      const ev2 = makeEvent({
        eventId: 'ev-d2',
        runId,
        type: 'READ',
        sequence: 3,
        source: { sourceId: 'src-1', kind: 'URL', location: 'https://docs.test/item' },
        provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'tc-2' } },
        payload: { type: 'READ', sourceId: 'src-1', outcome: 'SUCCESS' },
      });

      const ev3 = makeEvent({
        eventId: 'ev-d3',
        runId,
        type: 'CLAIM',
        sequence: 4,
        source: { sourceId: 'src-1', kind: 'URL', location: 'https://docs.test/item' },
        provenance: { category: 'AGENT_REPORTED' },
        payload: { type: 'CLAIM', text: 'First claim supported', sourceId: 'src-1' },
      });

      const ansReceipt = receipt({
        receiptId,
        runId,
        answerId: ansId,
        sequence: 5,
        eventIds: ['ev-d1', 'ev-d2', 'ev-d3', 'ev-d4', 'ev-d5', 'ev-d6'],
      });

      // Step 1: Append answer receipt, and prefix events (ev1, ev2, ev3)
      await store.appendRecords(runId, [ansReceipt, ev1, ev2, ev3]);

      const res1 = await analyzeAnswerWithStats(store, runId, ansId);
      assert.ok(res1);
      assert.equal(res1.stats.stateLoaded, false, 'First call must fold from scratch');
      assert.equal(res1.stats.deltaEventCount, 3, 'Must examine prefix 3 events');
      assert.equal(res1.stats.mode, 'FULL_FOLD');
      assert.equal(res1.report.claims.length, 1);

      // Step 2: Append delta events (ev4, ev5, ev6)
      const ev4 = makeEvent({
        eventId: 'ev-d4',
        runId,
        type: 'READ',
        sequence: 6,
        source: { sourceId: 'src-2', kind: 'URL', location: 'https://docs.test/item2' },
        provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'tc-3' } },
        payload: { type: 'READ', sourceId: 'src-2', outcome: 'SUCCESS' },
      });

      const ev5 = makeEvent({
        eventId: 'ev-d5',
        runId,
        type: 'CLAIM',
        sequence: 7,
        source: { sourceId: 'src-2', kind: 'URL', location: 'https://docs.test/item2' },
        provenance: { category: 'AGENT_REPORTED' },
        payload: { type: 'CLAIM', text: 'Second claim supported', sourceId: 'src-2' },
      });

      const ev6 = makeEvent({
        eventId: 'ev-d6',
        runId,
        type: 'RECOMMEND',
        sequence: 8,
        source: { sourceId: 'src-2', kind: 'URL', location: 'https://docs.test/item2' },
        provenance: { category: 'AGENT_REPORTED' },
        payload: {
          type: 'RECOMMEND',
          choice: 'item1',
          rationaleEventIds: ['ev-d3', 'ev-d5'],
        },
      });

      await store.appendRecords(runId, [ev4, ev5, ev6]);

      // Step 3: Run incremental analysis
      const res2 = await analyzeAnswerWithStats(store, runId, ansId);
      assert.ok(res2);
      assert.equal(res2.stats.stateLoaded, true, 'Second call must load persisted fold state');
      assert.equal(res2.stats.deltaEventCount, 3, 'Must examine only the 3 new delta events (ev4, ev5, ev6)');
      assert.equal(res2.stats.mode, 'INCREMENTAL_DELTA');

      // Step 4: Full rebuild oracle from scratch
      const rebuild = await rebuildAnalysis(store, runId, ansId);
      assert.ok(rebuild);

      // Incremental output must be bit-for-bit identical to full rebuild!
      assert.deepEqual(res2.report, rebuild);
    } finally {
      store.close();
    }
  });

  it('handles out-of-order sequence regression with honest invalidation and rebuild parity', async () => {
    const root = await tempDataRoot('delta-regression');
    const store = await ViewTraceStore.open({ dataRoot: root });
    const runId = 'run-regression-001';
    const ansId = 'ans-reg-001';

    try {
      await store.createRun(runId, { adapterId: 'test', adapterVersion: '1.0.0' });

      const ev1 = makeEvent({
        eventId: 'ev-r1',
        runId,
        type: 'READ',
        sequence: 1,
        source: { sourceId: 'src-1', kind: 'URL', location: 'https://docs.test/r1' },
        provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 't1' } },
        payload: { type: 'READ', sourceId: 'src-1', outcome: 'SUCCESS' },
      });

      const ev3 = makeEvent({
        eventId: 'ev-r3',
        runId,
        type: 'CLAIM',
        sequence: 3,
        source: { sourceId: 'src-1', kind: 'URL', location: 'https://docs.test/r1' },
        provenance: { category: 'AGENT_REPORTED' },
        payload: { type: 'CLAIM', text: 'Claim at seq 3', sourceId: 'src-1' },
      });

      const ansReceipt = receipt({
        receiptId: 'rec-reg-001',
        runId,
        answerId: ansId,
        sequence: 4,
        eventIds: ['ev-r1', 'ev-r3'],
      });

      await store.appendRecords(runId, [ansReceipt, ev1, ev3]);
      const res1 = await analyzeAnswerWithStats(store, runId, ansId);
      assert.ok(res1);

      // Now ev2 arrives with sequence 2 <= cursor (cursor is at seq 3)
      const ev2 = makeEvent({
        eventId: 'ev-r2',
        runId,
        type: 'SEARCH',
        sequence: 2,
        source: { sourceId: 'src-1', kind: 'URL' },
        provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 't2' } },
        payload: { type: 'SEARCH', query: 'late arriving search', results: [] },
      });

      // Update answer scope to include ev-r2
      const db = (store as any).requireDb();
      db.prepare('INSERT INTO answer_events VALUES (?, ?, ?)').run('rec-reg-001', 'ev-r2', 'own');
      await store.appendRecords(runId, [ev2]);

      const res2 = await analyzeAnswerWithStats(store, runId, ansId);
      assert.ok(res2);
      // Sequence regression was detected and handled
      const rebuild = await rebuildAnalysis(store, runId, ansId);
      assert.deepEqual(res2.report, rebuild);
    } finally {
      store.close();
    }
  });

  it('re-evaluates late references upon arrival and detects cyclic references', async () => {
    const root = await tempDataRoot('late-ref-cycle');
    const store = await ViewTraceStore.open({ dataRoot: root });
    const runId = 'run-ref-001';
    const ansId = 'ans-ref-001';

    try {
      await store.createRun(runId, { adapterId: 'test', adapterVersion: '1.0.0' });

      // ev-1 claims support and declares relation to ev-2 (which hasn't arrived yet!)
      const ev1 = makeEvent({
        eventId: 'ev-ref-1',
        runId,
        type: 'CLAIM',
        sequence: 1,
        source: { sourceId: 'src-x', kind: 'UNKNOWN' },
        provenance: { category: 'AGENT_REPORTED' },
        payload: { type: 'CLAIM', text: 'Claim referencing ev-ref-2' },
        relations: [{ type: 'SUPPORTS', targetEventId: 'ev-ref-2' }],
      });

      const ansReceipt = receipt({
        receiptId: 'rec-ref-001',
        runId,
        answerId: ansId,
        sequence: 3,
        eventIds: ['ev-ref-1', 'ev-ref-2'],
      });

      await store.appendRecords(runId, [ansReceipt, ev1]);
      const res1 = await analyzeAnswer(store, runId, ansId);
      assert.ok(res1);

      // In initial pass, ev-ref-2 is not found: relation to ev-ref-2 is DANGLING
      const dangling = res1.references.find((r) => r.to.eventId === 'ev-ref-2');
      assert.ok(dangling);
      assert.equal(dangling.kind, 'DANGLING');

      // Now ev-ref-2 arrives in delta, AND declares relation back to ev-ref-1 (mutual cycle!)
      const ev2 = makeEvent({
        eventId: 'ev-ref-2',
        runId,
        type: 'CLAIM',
        sequence: 2,
        source: { sourceId: 'src-x', kind: 'UNKNOWN' },
        provenance: { category: 'AGENT_REPORTED' },
        payload: { type: 'CLAIM', text: 'Claim referencing ev-ref-1 back' },
        relations: [{ type: 'SUPPORTS', targetEventId: 'ev-ref-1' }],
      });

      await store.appendRecords(runId, [ev2]);
      const res2 = await analyzeAnswer(store, runId, ansId);
      assert.ok(res2);

      // Cycle was detected between ev-ref-1 and ev-ref-2!
      const cycle = res2.references.find((r) => r.kind === 'CYCLE');
      assert.ok(cycle, 'Must detect cyclic reference between mutually dependent events');
      assert.equal(cycle.kind, 'CYCLE');

      // Parity with full rebuild
      const rebuild = await rebuildAnalysis(store, runId, ansId);
      assert.deepEqual(res2, rebuild);
    } finally {
      store.close();
    }
  });

  it('strictly isolates empty-eventIds receipts (0 pollution, boundary UNKNOWN)', async () => {
    const root = await tempDataRoot('empty-receipt-isolation');
    const store = await ViewTraceStore.open({ dataRoot: root });
    const runId = 'run-multi-turn-001';

    try {
      await store.createRun(runId, { adapterId: 'test', adapterVersion: '1.0.0' });

      const evTurn1 = makeEvent({
        eventId: 'ev-turn1-alpha',
        runId,
        type: 'CLAIM',
        sequence: 1,
        source: { sourceId: 'src-1', kind: 'UNKNOWN' },
        provenance: { category: 'AGENT_REPORTED' },
        payload: { type: 'CLAIM', text: 'Alpha claim from Turn 1' },
      });

      const receipt1 = receipt({
        receiptId: 'rec-turn-1',
        runId,
        answerId: 'ans-turn-1',
        turnId: 'turn-1',
        sequence: 2,
        eventIds: ['ev-turn1-alpha'],
      });

      // Turn 2 receipt has an EXPLICITLY EMPTY eventIds list
      const receipt2 = receipt({
        receiptId: 'rec-turn-2',
        runId,
        answerId: 'ans-turn-2',
        turnId: 'turn-2',
        sequence: 3,
        eventIds: [],
      });

      await store.appendRecords(runId, [receipt1, receipt2, evTurn1]);

      const report1 = await analyzeAnswer(store, runId, 'ans-turn-1');
      assert.ok(report1);
      assert.equal(report1.claims.length, 1);
      assert.ok(report1.claims.some((c) => c.text.includes('Alpha')));

      // Turn 2 analysis MUST NOT inherit turn 1 events or claims!
      const report2 = await analyzeAnswer(store, runId, 'ans-turn-2');
      assert.ok(report2);
      assert.equal(report2.scope.boundary, 'UNKNOWN');
      assert.equal(report2.claims.length, 0, 'Turn 2 with empty eventIds must have 0 claims');
      assert.ok(!report2.claims.some((c) => c.text.includes('Alpha')), 'Turn 2 must NOT be polluted with Turn 1 Alpha claim');
      assert.equal(report2.support.status, 'UNKNOWN');
    } finally {
      store.close();
    }
  });

  it('detects stale cached reports and recomputes fresh analysis upon store changes', async () => {
    const root = await tempDataRoot('report-freshness-staleness');
    const store = await ViewTraceStore.open({ dataRoot: root });
    const runId = 'run-stale-001';
    const ansId = 'ans-stale-001';

    try {
      // Create run in PARTIAL completeness
      await store.createRun(runId, { adapterId: 'test', adapterVersion: '1.0.0' });
      const db = (store as any).requireDb();
      db.prepare("UPDATE runs SET completeness = 'PARTIAL' WHERE run_id = ?").run(runId);

      const evRead = makeEvent({
        eventId: 'ev-s-read',
        runId,
        type: 'READ',
        sequence: 1,
        source: { sourceId: 'src-fresh', kind: 'URL', location: 'https://official.spec/v1' },
        provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 't1' } },
        payload: { type: 'READ', sourceId: 'src-fresh', outcome: 'SUCCESS' },
      });

      const evClaim = makeEvent({
        eventId: 'ev-s-claim',
        runId,
        type: 'CLAIM',
        sequence: 2,
        source: { sourceId: 'src-fresh', kind: 'URL', location: 'https://official.spec/v1' },
        provenance: { category: 'AGENT_REPORTED' },
        payload: { type: 'CLAIM', text: 'Grounded fresh claim', sourceId: 'src-fresh' },
      });

      const ansReceipt = receipt({
        receiptId: 'rec-s-001',
        runId,
        answerId: ansId,
        sequence: 3,
        eventIds: ['ev-s-read', 'ev-s-claim'],
      });

      await store.appendRecords(runId, [ansReceipt, evRead, evClaim]);

      // Initial analysis under PARTIAL completeness:
      const initialReport = await analyzeAnswer(store, runId, ansId);
      assert.ok(initialReport);
      assert.equal(initialReport.support.status, 'PARTIALLY_SUPPORTED');
      assert.ok(initialReport.support.reasonCodes.includes('COLLECTION_NOT_COMPLETE'));

      // Check freshness: immediately after, it is CURRENT
      const { checkAnalysisFreshness } = await import('../src/viewtrace/analyzer/index.js');
      const freshCheck1 = await checkAnalysisFreshness(store, runId, ansId);
      assert.equal(freshCheck1?.status, 'CURRENT');

      // Now change run completeness to COMPLETE:
      db.prepare("UPDATE runs SET completeness = 'COMPLETE' WHERE run_id = ?").run(runId);

      // checkAnalysisFreshness must now detect STALE due to collectionCompleteness change!
      const freshCheck2 = await checkAnalysisFreshness(store, runId, ansId);
      assert.equal(freshCheck2?.status, 'STALE');
      assert.ok(freshCheck2?.reasons.length > 0);

      // answerAnalysisReport must invalidate the stale cached report and recompute
      const { answerAnalysisReport } = await import('../src/viewtrace/report.js');
      const servedReport = await answerAnalysisReport(store, runId, ansId);
      assert.ok(servedReport);
      assert.equal(servedReport.support.status, 'STRONGLY_SUPPORTED', 'Recomputed report must reach STRONGLY_SUPPORTED');
      assert.equal(servedReport.freshness.status, 'CURRENT');
      assert.ok(servedReport.support.reasonCodes.includes('ALL_CORE_CLAIMS_SUPPORTED'));
    } finally {
      store.close();
    }
  });
});
