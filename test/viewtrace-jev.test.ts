import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { viewtraceFixture, tempDataRoot, makeEvent } from './helpers/viewtrace.js';
import { receipt } from './helpers/m2.js';
import { ViewTraceStore } from '../src/viewtrace/store.js';
import { ingestFile } from '../src/viewtrace/ingest.js';
import { analyzeAnswer, analyzeEvents } from '../src/viewtrace/analyzer/index.js';
import {
  evaluateCheckpointLocal,
  evaluateCheckpointGuarded,
  markJevResultStale,
  selectJevCheckpoints,
  DEFAULT_MAX_CHECKPOINTS,
  CONCENTRATION_MIN_READS,
  type JevLabels,
} from '../src/viewtrace/analyzer/jev-selector.js';
import type { JevCheckpointV2 } from '../src/viewtrace/analysis-types.js';

describe('M3 JEV v2 checkpoint selector & advisory evaluator', () => {
  it('selects bounded semantic checkpoints matching jev-checkpoints.oracle.json', async () => {
    const root = await tempDataRoot('jev-checkpoints');
    await ingestFile(viewtraceFixture('jev-checkpoints.jsonl'), { dataRoot: root });
    const oracle = JSON.parse(await readFile(viewtraceFixture('jev-checkpoints.oracle.json'), 'utf8'));

    const store = await ViewTraceStore.open({ dataRoot: root });
    try {
      const report = await analyzeAnswer(store, oracle.runId, oracle.answerId);
      assert.ok(report);

      // Checkpoints were evaluated
      assert.ok(report.jevResults.length > 0);
      assert.ok(report.jevResults.length <= 10, 'Must respect budget limit');

      for (const res of report.jevResults) {
        assert.equal(res.schema, 'viewtrace.jev-result@2');
        assert.equal(res.status, 'SUCCEEDED');
        assert.equal(res.provenance, 'EVALUATOR_REPORTED');
        assert.equal(res.supportEffect, 'NONE'); // Strictly advisory!
      }
    } finally {
      store.close();
    }
  });

  it('isolates evaluator failure from the base report', async () => {
    const root = await tempDataRoot('jev-failure-isolation');
    await ingestFile(viewtraceFixture('jev-checkpoints.jsonl'), { dataRoot: root });
    const store = await ViewTraceStore.open({ dataRoot: root });

    try {
      const report = await analyzeAnswer(store, 'run-jev-checkpoints', 'ans-jev');
      assert.ok(report);

      // Fault injection into evaluator
      const bogusCheckpoint: any = {
        checkpointId: 'ck-fault',
        inputRevision: report.inputRevision,
        delta: null, // Bad delta will trigger catch block
      };

      const result = evaluateCheckpointLocal(bogusCheckpoint, []);
      assert.equal(result.status, 'FAILED');
      assert.equal(result.supportEffect, 'NONE');

      // The base analysis report remains functional and intact
      assert.ok(report.support.status);
      assert.ok(report.claims.length > 0);
    } finally {
      store.close();
    }
  });

  it('matches the oracle trigger selection exactly, including non-selected triggers', async () => {
    const root = await tempDataRoot('jev-oracle-triggers');
    await ingestFile(viewtraceFixture('jev-checkpoints.jsonl'), { dataRoot: root });
    const oracle = JSON.parse(await readFile(viewtraceFixture('jev-checkpoints.oracle.json'), 'utf8'));

    const store = await ViewTraceStore.open({ dataRoot: root });
    try {
      const report = await analyzeAnswer(store, oracle.runId, oracle.answerId);
      assert.ok(report);
      const checkpoints = await store.getJevCheckpoints(oracle.runId);
      assert.ok(checkpoints.length > 0, 'checkpoints must be persisted for the run');

      // Exact ordered match against the oracle: one checkpoint per expected
      // trigger, in the observed sequence order.
      const selected = checkpoints.map((c) => c.triggerReasons[0]);
      assert.deepEqual(selected, oracle.expectedTriggers);

      // Non-selection: this fixture never stalls long enough to fire the
      // no-evidence-gain window, and reads below the concentration minimum
      // must not fire SOURCE_CONCENTRATION_THRESHOLD.
      assert.ok(!checkpoints.some((c) => c.triggerReasons.includes('NO_EVIDENCE_GAIN_WINDOW')));
      assert.ok(
        !checkpoints.some((c) => c.checkpointId.endsWith('-new_branch') && c.budget.ordinal > 1 && c.triggerReasons.length === 1 && c.triggerReasons[0] === 'NEW_BRANCH' && c.delta.toSequenceInclusive !== 1),
        'only the first SEARCH may anchor a NEW_BRANCH checkpoint here',
      );

      // Stable, deduplicated checkpoint ids
      const ids = checkpoints.map((c) => c.checkpointId);
      assert.equal(new Set(ids).size, ids.length, 'checkpoint ids must be unique');
      // Results cover exactly the selected checkpoints — no extra evaluations.
      const resultIds = report.jevResults.map((r) => r.checkpointId);
      assert.deepEqual([...resultIds].sort(), [...ids].sort());
    } finally {
      store.close();
    }
  });

  it('calls a custom evaluator exactly once per selected checkpoint and never for non-selected events', async () => {
    const root = await tempDataRoot('jev-callcount');
    const store = await ViewTraceStore.open({ dataRoot: root });
    try {
      const runId = 'run-jev-callcount';
      await store.createRun(runId, { adapterId: 'viewtrace-reference-jsonl', adapterVersion: '1.0.0' });
      const events = [
        makeEvent({ eventId: 'ev-j1', runId, type: 'SEARCH', sequence: 1, payload: { type: 'SEARCH', query: 'q', results: [] } }),
        makeEvent({ eventId: 'ev-j2', runId, type: 'CLAIM', sequence: 2, provenance: { category: 'AGENT_REPORTED' }, payload: { type: 'CLAIM', text: 'no trigger here' } }),
        makeEvent({ eventId: 'ev-j3', runId, type: 'CLAIM', sequence: 3, provenance: { category: 'AGENT_REPORTED' }, payload: { type: 'CLAIM', text: 'still no trigger' } }),
        makeEvent({ eventId: 'ev-j4', runId, type: 'RECOMMEND', sequence: 4, provenance: { category: 'AGENT_REPORTED' }, payload: { type: 'RECOMMEND', choice: 'a', rationaleEventIds: [] } }),
      ];
      const ansReceipt = receipt({
        receiptId: 'rec-jev-callcount',
        runId,
        answerId: 'ans-callcount',
        sequence: 5,
        eventIds: events.map((e) => e.eventId),
      });
      await store.appendRecords(runId, [ansReceipt, ...events]);

      let calls = 0;
      const evaluator = (): JevLabels => {
        calls++;
        return { evidenceGain: 'UNKNOWN', progress: 'UNKNOWN', rethinkNeeded: 'UNKNOWN' };
      };
      const report = await analyzeAnswer(store, runId, 'ans-callcount', { jev: { evaluator } });
      assert.ok(report);
      // SEARCH (NEW_BRANCH) + the event right before RECOMMEND (PRE_RECOMMENDATION):
      // the two CLAIM events without triggers must never reach the evaluator.
      assert.equal(calls, report.jevResults.length, 'one evaluator call per result');
      assert.equal(calls, 2, 'only the 2 selected checkpoints are evaluated (non-selected: 0 calls)');
      for (const r of report.jevResults) {
        assert.equal(r.status, 'SUCCEEDED');
        assert.equal(r.evaluator.provider, 'custom-injected-evaluator');
      }
    } finally {
      store.close();
    }
  });

  it('skips re-evaluation on replay: a second identical incremental pass makes 0 evaluator calls', async () => {
    const root = await tempDataRoot('jev-replay-dedup');
    await ingestFile(viewtraceFixture('jev-checkpoints.jsonl'), { dataRoot: root });
    const store = await ViewTraceStore.open({ dataRoot: root });
    try {
      let calls = 0;
      const evaluator = (): JevLabels => {
        calls++;
        return { evidenceGain: 'YES', progress: 'YES', rethinkNeeded: 'NO' };
      };
      const first = await analyzeAnswer(store, 'run-jev-checkpoints', 'ans-jev', { jev: { evaluator } });
      assert.ok(first);
      const firstCalls = calls;
      assert.ok(firstCalls > 0);

      const second = await analyzeAnswer(store, 'run-jev-checkpoints', 'ans-jev', { jev: { evaluator } });
      assert.ok(second);
      assert.equal(calls, firstCalls, 're-analysis with no new events must not re-evaluate checkpoints');

      // No duplicated result ids across passes (results are keyed by checkpoint).
      const ids = second.jevResults.map((r) => r.resultId);
      assert.equal(new Set(ids).size, ids.length);
    } finally {
      store.close();
    }
  });

  it('enforces cooldown, budget and the concentration threshold boundary in the selector', () => {
    const scope = {
      runId: 'run-jev-unit',
      answerId: 'ans-jev-unit',
      receiptId: 'rec-jev-unit',
      boundary: 'UNKNOWN' as const,
    };
    const analyzer = { analyzerVersion: 'a', ruleSetVersion: 'r', analyzerId: 'x' };

    // Cooldown + budget: a stream of searches (NEW_BRANCH every event) with a
    // 3-event cooldown and budget 4 selects at most ceil-spaced checkpoints;
    // the total can never exceed maxCheckpoints.
    const searches = Array.from({ length: 20 }, (_, i) =>
      makeEvent({ eventId: `ev-s-${i}`, type: 'SEARCH', sequence: i + 1, payload: { type: 'SEARCH', query: `q${i}`, results: [] } }),
    );
    const selected = selectJevCheckpoints({
      events: searches,
      evidence: [],
      scope,
      analyzer,
      inputRevision: { algorithm: 'sha256-canonical-schema1-records-v1', value: 'v', recordCount: 1 },
      maxCheckpoints: 4,
      cooldownEvents: 3,
    });
    assert.ok(selected.length <= 4, 'budget is an absolute cap');
    assert.ok(selected.length < 20, 'cooldown suppresses trigger spam');
    for (let i = 1; i < selected.length; i++) {
      const gap = selected[i]!.delta.toSequenceInclusive - selected[i - 1]!.delta.toSequenceInclusive;
      assert.ok(gap >= 3, `low-priority checkpoints must respect the cooldown (gap ${gap})`);
    }

    // Concentration threshold boundary: CONCENTRATION_MIN_READS - 1 reads of a
    // single source with a 100% share must NOT fire.
    const below = Array.from({ length: CONCENTRATION_MIN_READS - 1 }, (_, i) =>
      makeEvent({ eventId: `ev-r-${i}`, type: 'READ', sequence: i + 1, source: { sourceId: 'src-only', kind: 'URL' }, provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: `t${i}` } }, payload: { type: 'READ', sourceId: 'src-only', outcome: 'SUCCESS' } }),
    );
    const belowSelected = selectJevCheckpoints({
      events: below,
      evidence: [],
      scope,
      analyzer,
      inputRevision: { algorithm: 'sha256-canonical-schema1-records-v1', value: 'v', recordCount: 1 },
    });
    assert.ok(
      !belowSelected.some((c) => c.triggerReasons.includes('SOURCE_CONCENTRATION_THRESHOLD')),
      'reads below the minimum count never fire the concentration trigger',
    );
  });

  it('keeps high-priority triggers available when low-priority ones exhaust the budget', () => {
    const scope = {
      runId: 'run-jev-prio',
      answerId: 'ans-jev-prio',
      receiptId: 'rec-jev-prio',
      boundary: 'UNKNOWN' as const,
    };
    const analyzer = { analyzerVersion: 'a', ruleSetVersion: 'r', analyzerId: 'x' };

    // Searches fill the low-priority budget; a late CONTRADICTION must still
    // get a checkpoint (reserved capacity), while a late plain SEARCH must not.
    const events = [
      ...Array.from({ length: 8 }, (_, i) =>
        makeEvent({ eventId: `ev-ps-${i}`, type: 'SEARCH', sequence: i + 1, payload: { type: 'SEARCH', query: `q${i}`, results: [] } }),
      ),
      makeEvent({ eventId: 'ev-contr', type: 'CONTRADICTION', sequence: 30, provenance: { category: 'AGENT_REPORTED' }, payload: { type: 'CONTRADICTION', description: 'conflict', conflictingEventIds: [] } }),
      makeEvent({ eventId: 'ev-late-search', type: 'SEARCH', sequence: 40, payload: { type: 'SEARCH', query: 'late', results: [] } }),
    ];
    const selected = selectJevCheckpoints({
      events,
      evidence: [],
      scope,
      analyzer,
      inputRevision: { algorithm: 'sha256-canonical-schema1-records-v1', value: 'v', recordCount: 1 },
      maxCheckpoints: DEFAULT_MAX_CHECKPOINTS,
      cooldownEvents: 0,
    });
    assert.ok(
      selected.some((c) => c.triggerReasons.includes('CONTRADICTION')),
      'high-priority CONTRADICTION keeps reserved budget capacity',
    );
  });

  it('reports TIMED_OUT for slow evaluators without failing the surrounding report', async () => {
    const checkpoint: JevCheckpointV2 = {
      schema: 'viewtrace.jev-checkpoint@2',
      checkpointId: 'ck-slow',
      deduplicationKey: 'ck-slow',
      selectorVersion: '2.1.0',
      analyzer: { analyzerVersion: 'a', ruleSetVersion: 'r', analyzerId: 'x' },
      inputRevision: { algorithm: 'sha256-canonical-schema1-records-v1', value: 'v', recordCount: 1 },
      scope: { runId: 'r', answerId: 'a', receiptId: 'rec', boundary: 'UNKNOWN' },
      triggerReasons: ['CONTRADICTION'],
      delta: { fromSequenceExclusive: 0, toSequenceInclusive: 1, eventIds: ['ev-1'], evidenceIds: [] },
      budget: { ordinal: 1, maxCheckpoints: 10, cooldownEvents: 3 },
    };
    const slow = () => new Promise<JevLabels>((resolve) => setTimeout(() => resolve({ evidenceGain: 'YES', progress: 'YES', rethinkNeeded: 'NO' }), 200));
    const result = await evaluateCheckpointGuarded(checkpoint, [], { evaluator: slow, timeoutMs: 10 });
    assert.equal(result.status, 'TIMED_OUT');
    assert.equal(result.supportEffect, 'NONE');
  });

  it('returns UNAVAILABLE (never fabricated labels) when no evaluator is configured', async () => {
    const checkpoint: JevCheckpointV2 = {
      schema: 'viewtrace.jev-checkpoint@2',
      checkpointId: 'ck-unavail',
      deduplicationKey: 'ck-unavail',
      selectorVersion: '2.1.0',
      analyzer: { analyzerVersion: 'a', ruleSetVersion: 'r', analyzerId: 'x' },
      inputRevision: { algorithm: 'sha256-canonical-schema1-records-v1', value: 'v', recordCount: 1 },
      scope: { runId: 'r', answerId: 'a', receiptId: 'rec', boundary: 'UNKNOWN' },
      triggerReasons: ['PRE_RECOMMENDATION'],
      delta: { fromSequenceExclusive: 0, toSequenceInclusive: 1, eventIds: ['ev-1'], evidenceIds: [] },
      budget: { ordinal: 1, maxCheckpoints: 10, cooldownEvents: 3 },
    };
    const result = await evaluateCheckpointGuarded(checkpoint, [], { unavailable: true });
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.labels, undefined, 'unavailable evaluation must not fabricate labels');
    assert.equal(result.supportEffect, 'NONE');
  });

  it('marks superseded results STALE while preserving history', () => {
    const base = evaluateCheckpointLocal(
      {
        schema: 'viewtrace.jev-checkpoint@2',
        checkpointId: 'ck-stale',
        deduplicationKey: 'ck-stale',
        selectorVersion: '2.1.0',
        analyzer: { analyzerVersion: 'a', ruleSetVersion: 'r', analyzerId: 'x' },
        inputRevision: { algorithm: 'sha256-canonical-schema1-records-v1', value: 'v', recordCount: 1 },
        scope: { runId: 'r', answerId: 'a', receiptId: 'rec', boundary: 'UNKNOWN' },
        triggerReasons: ['NEW_BRANCH'],
        delta: { fromSequenceExclusive: 0, toSequenceInclusive: 1, eventIds: ['ev-1'], evidenceIds: [] },
        budget: { ordinal: 1, maxCheckpoints: 10, cooldownEvents: 3 },
      },
      [],
    );
    assert.equal(base.status, 'SUCCEEDED');
    const stale = markJevResultStale(base, 'input revision changed');
    assert.equal(stale.status, 'STALE');
    assert.ok(stale.limitations.some((l) => l.includes('input revision changed')));
    assert.equal(stale.resultId, base.resultId, 'history preserved: same result identity');
  });

  it('isolates malicious evaluator output that fails the JEV v2 label schema', async () => {
    const checkpoint: JevCheckpointV2 = {
      schema: 'viewtrace.jev-checkpoint@2',
      checkpointId: 'ck-evil',
      deduplicationKey: 'ck-evil',
      selectorVersion: '2.1.0',
      analyzer: { analyzerVersion: 'a', ruleSetVersion: 'r', analyzerId: 'x' },
      inputRevision: { algorithm: 'sha256-canonical-schema1-records-v1', value: 'v', recordCount: 1 },
      scope: { runId: 'r', answerId: 'a', receiptId: 'rec', boundary: 'UNKNOWN' },
      triggerReasons: ['CONTRADICTION'],
      delta: { fromSequenceExclusive: 0, toSequenceInclusive: 1, eventIds: ['ev-1'], evidenceIds: [] },
      budget: { ordinal: 1, maxCheckpoints: 10, cooldownEvents: 3 },
    };

    // Out-of-enum values, wrong types, and extra/foreign keys are all rejected.
    const bad1 = await evaluateCheckpointGuarded(checkpoint, [], {
      evaluator: () => ({ evidenceGain: 'DEFINITELY', progress: 42, rethinkNeeded: null }) as unknown as JevLabels,
    });
    assert.equal(bad1.status, 'FAILED');
    assert.ok(bad1.limitations.some((l) => l.includes('schema')));

    const bad2 = await evaluateCheckpointGuarded(checkpoint, [], {
      evaluator: () => ({ evidenceGain: 'YES', progress: 'YES', rethinkNeeded: 'NO', confidence: 0.99 }) as unknown as JevLabels,
    });
    assert.equal(bad2.status, 'FAILED');

    const bad3 = await evaluateCheckpointGuarded(checkpoint, [], {
      evaluator: () => 'YES' as unknown as JevLabels,
    });
    assert.equal(bad3.status, 'FAILED');

    // A schema-conformant custom evaluator still succeeds.
    const good = await evaluateCheckpointGuarded(checkpoint, [], {
      evaluator: () => ({ evidenceGain: 'UNKNOWN', progress: 'UNKNOWN', rethinkNeeded: 'YES' }),
    });
    assert.equal(good.status, 'SUCCEEDED');
  });

  it('keeps report evidence, claims and support identical with JEV enabled vs disabled', () => {
    const events = [
      makeEvent({ eventId: 'ev-ne0', type: 'SEARCH', sequence: 0, payload: { type: 'SEARCH', query: 'find docs', results: [] } }),
      makeEvent({ eventId: 'ev-ne1', type: 'READ', sequence: 1, source: { sourceId: 'src-ne', kind: 'URL', location: 'https://docs.example/x' }, provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 't1' } }, payload: { type: 'READ', sourceId: 'src-ne', outcome: 'SUCCESS' } }),
      makeEvent({ eventId: 'ev-ne2', type: 'CLAIM', sequence: 2, source: { sourceId: 'src-ne', kind: 'URL', location: 'https://docs.example/x' }, provenance: { category: 'AGENT_REPORTED' }, payload: { type: 'CLAIM', text: 'Grounded claim', sourceId: 'src-ne' } }),
    ];
    const withJev = analyzeEvents(events, { answerId: 'ans-ne', enableJev: true });
    const withoutJev = analyzeEvents(events, { answerId: 'ans-ne', enableJev: false });
    assert.deepEqual(withJev.claims, withoutJev.claims);
    assert.deepEqual(withJev.evidence, withoutJev.evidence);
    assert.deepEqual(withJev.support, withoutJev.support);
    assert.deepEqual(withJev.conflicts, withoutJev.conflicts);
    assert.ok(withJev.jevResults.length > withoutJev.jevResults.length, 'the SEARCH anchor produces at least one advisory checkpoint');
    for (const r of withJev.jevResults) {
      assert.equal(r.supportEffect, 'NONE');
    }
  });
});
