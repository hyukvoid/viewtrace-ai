import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { viewtraceFixture, tempDataRoot } from './helpers/viewtrace.js';
import { ViewTraceStore } from '../src/viewtrace/store.js';
import { ingestFile } from '../src/viewtrace/ingest.js';
import { analyzeAnswer } from '../src/viewtrace/analyzer/index.js';

describe('M3 mode lens and 7 projection calibrations', () => {
  it('calibrates all 7 modes against analysis-7-modes.jsonl and oracle', async () => {
    const root = await tempDataRoot('modes-7');
    const fixturePath = viewtraceFixture('analysis-7-modes.jsonl');
    const oraclePath = viewtraceFixture('analysis-7-modes.oracle.json');

    await ingestFile(fixturePath, { dataRoot: root });
    const oracle = JSON.parse(await readFile(oraclePath, 'utf8'));
    const store = await ViewTraceStore.open({ dataRoot: root });

    try {
      for (const [answerId, expected] of Object.entries(oracle.answers) as [string, any][]) {
        const report = await analyzeAnswer(store, expected.runId, answerId);
        assert.ok(report, `Report must be generated for ${answerId}`);

        // Current mode check
        assert.equal(
          report.lens.currentMode,
          expected.expectedMode,
          `Answer ${answerId} expected mode ${expected.expectedMode}, got ${report.lens.currentMode}`,
        );

        // Initial hypothesis check
        const rev1 = report.lens.revisions[0];
        assert.equal(
          rev1?.mode,
          expected.initialHypothesis,
          `Answer ${answerId} initial hypothesis mismatch`,
        );

        // Observed phase check
        const rev2 = report.lens.revisions[1];
        assert.equal(
          rev2?.phase,
          expected.observedPhase,
          `Answer ${answerId} observed phase mismatch`,
        );

        // Projection mode check
        assert.equal(report.projection.mode, expected.expectedMode);
      }
    } finally {
      store.close();
    }
  });

  it('demonstrates observed correction: question hypothesis overridden by observed activity', async () => {
    const root = await tempDataRoot('mode-correction');
    const store = await ViewTraceStore.open({ dataRoot: root });
    try {
      await ingestFile(viewtraceFixture('analysis-7-modes.jsonl'), { dataRoot: root });
      const report = await analyzeAnswer(store, 'run-mode-correction', 'ans-mode-correction');
      assert.ok(report);

      assert.equal(report.lens.revisions.length, 2);
      assert.equal(report.lens.revisions[0]!.phase, 'INITIAL_HYPOTHESIS');
      assert.equal(report.lens.revisions[0]!.mode, 'EXPLAIN');

      assert.equal(report.lens.revisions[1]!.phase, 'OBSERVED_CORRECTION');
      assert.equal(report.lens.revisions[1]!.mode, 'COMPARE');

      assert.equal(report.lens.currentMode, 'COMPARE');
      assert.equal(report.projection.mode, 'COMPARE');
    } finally {
      store.close();
    }
  });

  it('proves explicit override changes projection only, never evidence or claims provenance', async () => {
    const root = await tempDataRoot('mode-override-invariance');
    const store = await ViewTraceStore.open({ dataRoot: root });
    try {
      await ingestFile(viewtraceFixture('analysis-7-modes.jsonl'), { dataRoot: root });

      const baseReport = await analyzeAnswer(store, 'run-mode-explain', 'ans-mode-explain');
      const overriddenReport = await analyzeAnswer(store, 'run-mode-explain', 'ans-mode-explain', {
        overrideMode: 'ASSESS',
      });

      assert.ok(baseReport);
      assert.ok(overriddenReport);

      // Lens mode and projection changed
      assert.equal(baseReport.lens.currentMode, 'EXPLAIN');
      assert.equal(overriddenReport.lens.currentMode, 'ASSESS');
      assert.equal(overriddenReport.projection.mode, 'ASSESS');

      // Evidence items, claims, and support status MUST remain strictly identical
      assert.deepEqual(baseReport.evidence, overriddenReport.evidence);
      assert.deepEqual(baseReport.claims, overriddenReport.claims);
      assert.deepEqual(baseReport.support, overriddenReport.support);
    } finally {
      store.close();
    }
  });
});
