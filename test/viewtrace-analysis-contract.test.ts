import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  M3_ANALYSIS_REPORT_SCHEMA,
  M3_INCREMENTAL_STATE_SCHEMA,
  M3_JEV_CHECKPOINT_SCHEMA,
  M3_JEV_RESULT_SCHEMA,
} from '../src/viewtrace/analysis-types.js';
import {
  validateAnalysisReport,
  validateIncrementalState,
  validateJevCheckpoint,
  validateJevResult,
} from '../src/viewtrace/analyzer/validate-m3.js';
import { analyzeEvents } from '../src/viewtrace/analyzer/index.js';
import type { ViewTraceEvent } from '../src/viewtrace/types.js';

describe('M3 analysis contract & schema validation', () => {
  const minimalEvent: ViewTraceEvent = {
    recordKind: 'event',
    schemaVersion: 1,
    eventId: 'ev-test-1',
    runId: 'run-contract-1',
    type: 'CLAIM',
    occurredAt: '2026-10-07T10:00:00Z',
    sequence: 1,
    receivedAt: '2026-10-07T10:00:00Z',
    adapterId: 'viewtrace-reference-jsonl',
    adapterVersion: '1.0.0',
    origin: { producer: 'test' },
    source: { sourceId: 'src-contract', kind: 'UNKNOWN' },
    provenance: { category: 'AGENT_REPORTED' },
    payload: { type: 'CLAIM', text: 'Contract test claim.' },
  };

  it('validates a conformant AnalysisReportV1', () => {
    const report = analyzeEvents([minimalEvent], { answerId: 'ans-1' });
    const outcome = validateAnalysisReport(report);
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(outcome.value?.schema, M3_ANALYSIS_REPORT_SCHEMA);
    assert.equal(outcome.value?.captureSchemaVersion, 1);
  });

  it('strictly rejects foreign fields on AnalysisReportV1', () => {
    const report = analyzeEvents([minimalEvent], { answerId: 'ans-1' }) as any;
    const dirty = { ...report, uninvitedProperty: 'exploit' };
    const outcome = validateAnalysisReport(dirty);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? '', /Disallowed foreign field "uninvitedProperty"/);
  });

  it('strictly rejects invalid schema versions', () => {
    const report = analyzeEvents([minimalEvent], { answerId: 'ans-1' }) as any;
    const dirty = { ...report, schema: 'viewtrace.analysis-report@999' };
    const outcome = validateAnalysisReport(dirty);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? '', /Invalid schema/);
  });

  it('validates IncrementalAnalysisStateV1 and rejects foreign fields', () => {
    const validState = {
      schema: M3_INCREMENTAL_STATE_SCHEMA,
      captureSchemaVersion: 1,
      analyzer: {
        analyzerId: 'test',
        analyzerVersion: '1.0.0',
        ruleSetVersion: '1.0.0',
      },
      inputRevision: {
        algorithm: 'sha256-canonical-schema1-records-v1',
        value: 'a'.repeat(64),
        recordCount: 1,
      },
      stateRevision: 'b'.repeat(64),
      cursors: [{ runId: 'run-1', processedThroughSequence: 1, processedRecordCount: 1 }],
      scopes: [],
      dependencies: [],
      pendingReferences: [],
      invalidations: [],
      selectedCheckpointIds: [],
      completedJevResultIds: [],
    };
    assert.equal(validateIncrementalState(validState).ok, true);

    const dirtyState = { ...validState, rogueField: true };
    assert.equal(validateIncrementalState(dirtyState).ok, false);
  });

  it('validates JevCheckpointV2 and JevResultV2 boundaries', () => {
    const checkpoint = {
      schema: M3_JEV_CHECKPOINT_SCHEMA,
      checkpointId: 'ck-1',
      deduplicationKey: 'dedup-1',
      selectorVersion: '2.0.0',
      analyzer: {
        analyzerId: 'test',
        analyzerVersion: '1.0.0',
        ruleSetVersion: '1.0.0',
      },
      inputRevision: {
        algorithm: 'sha256-canonical-schema1-records-v1',
        value: 'a'.repeat(64),
        recordCount: 1,
      },
      scope: {
        runId: 'r1',
        answerId: 'a1',
        receiptId: 'rec-1',
        boundary: 'EXACT',
      },
      triggerReasons: ['NEW_BRANCH'],
      delta: {
        fromSequenceExclusive: 0,
        toSequenceInclusive: 1,
        eventIds: ['ev-1'],
        evidenceIds: ['ev-1'],
      },
      budget: {
        ordinal: 1,
        maxCheckpoints: 10,
        cooldownEvents: 3,
      },
    };
    assert.equal(validateJevCheckpoint(checkpoint).ok, true);

    const result = {
      schema: M3_JEV_RESULT_SCHEMA,
      resultId: 'res-1',
      checkpointId: 'ck-1',
      inputRevision: {
        algorithm: 'sha256-canonical-schema1-records-v1',
        value: 'a'.repeat(64),
        recordCount: 1,
      },
      evaluator: {
        provider: 'local-test',
        evaluatorVersion: '2.0.0',
      },
      status: 'SUCCEEDED',
      labels: {
        evidenceGain: 'YES',
        progress: 'YES',
        rethinkNeeded: 'NO',
      },
      provenance: 'EVALUATOR_REPORTED',
      supportEffect: 'NONE',
      limitations: ['test'],
    };
    assert.equal(validateJevResult(result).ok, true);

    // Reject supportEffect other than NONE
    const invalidResult = { ...result, supportEffect: 'ELEVATES_SUPPORT' };
    assert.equal(validateJevResult(invalidResult).ok, false);
  });
});
