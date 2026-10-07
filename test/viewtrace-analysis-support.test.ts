import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { viewtraceFixture, tempDataRoot } from './helpers/viewtrace.js';
import { ViewTraceStore } from '../src/viewtrace/store.js';
import { ingestFile } from '../src/viewtrace/ingest.js';
import { analyzeAnswer } from '../src/viewtrace/analyzer/index.js';

describe('M3 5-rule evidence support judge & state oracle verification', () => {
  it('strictly validates all 5 evidence support states against analysis-5-states.jsonl and oracle', async () => {
    const root = await tempDataRoot('support-5-states');
    const fixturePath = viewtraceFixture('analysis-5-states.jsonl');
    const oraclePath = viewtraceFixture('analysis-5-states.oracle.json');

    // Ingest the fixture
    const ingestOutcome = await ingestFile(fixturePath, { dataRoot: root });
    assert.equal(ingestOutcome.runs.length, 5);

    const oracle = JSON.parse(await readFile(oraclePath, 'utf8'));
    const store = await ViewTraceStore.open({ dataRoot: root });

    try {
      for (const [answerId, expected] of Object.entries(oracle.answers) as [string, any][]) {
        const report = await analyzeAnswer(store, expected.runId, answerId);
        assert.ok(report, `Report must be generated for ${answerId}`);

        // Support state assertion
        assert.equal(
          report.support.status,
          expected.expectedSupport,
          `Answer ${answerId} expected support ${expected.expectedSupport}, got ${report.support.status}`,
        );

        // Reason codes assertion
        for (const code of expected.expectedReasonCodes) {
          assert.ok(
            report.support.reasonCodes.includes(code),
            `Answer ${answerId} must include reason code ${code}; got ${report.support.reasonCodes.join(', ')}`,
          );
        }

        // Claim count assertion
        assert.equal(
          report.claims.length,
          expected.claimsCount,
          `Answer ${answerId} claims count mismatch`,
        );

        // Unresolved conflicts assertion
        const detectedConflicts = report.conflicts.filter((c) => c.status === 'DETECTED');
        assert.equal(
          detectedConflicts.length,
          expected.unresolvedConflicts,
          `Answer ${answerId} unresolved conflicts mismatch`,
        );
      }
    } finally {
      store.close();
    }
  });

  it('proves negative assertion: exit 0, RECOMMEND, and reported-only claims never elevate support', async () => {
    const root = await tempDataRoot('support-negative-elevation');
    const store = await ViewTraceStore.open({ dataRoot: root });
    try {
      // Ingest insufficient run
      const fixturePath = viewtraceFixture('analysis-5-states.jsonl');
      await ingestFile(fixturePath, { dataRoot: root });

      const report = await analyzeAnswer(store, 'run-state-insufficient', 'ans-insufficient');
      assert.ok(report);

      // Even though lifecycle is COMPLETED (exit 0 equivalent) and RECOMMEND event exists:
      assert.equal(report.support.status, 'INSUFFICIENT_EVIDENCE');
      assert.notEqual(report.support.status, 'STRONGLY_SUPPORTED');
      assert.notEqual(report.support.status, 'PARTIALLY_SUPPORTED');
    } finally {
      store.close();
    }
  });

  it('proves negative assertion: majority source count never offsets a contradiction under same conditions', async () => {
    const root = await tempDataRoot('support-negative-majority');
    const store = await ViewTraceStore.open({ dataRoot: root });
    try {
      const fixturePath = viewtraceFixture('analysis-5-states.jsonl');
      await ingestFile(fixturePath, { dataRoot: root });

      const report = await analyzeAnswer(store, 'run-state-conflicting', 'ans-conflicting');
      assert.ok(report);

      // Must strictly be CONFLICTING_EVIDENCE
      assert.equal(report.support.status, 'CONFLICTING_EVIDENCE');
      assert.ok(report.support.reasonCodes.includes('UNRESOLVED_CORE_CONFLICT'));
    } finally {
      store.close();
    }
  });
});
