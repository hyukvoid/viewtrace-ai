import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ingestFile } from '../src/viewtrace/ingest.js';
import { ViewTraceStore } from '../src/viewtrace/store.js';
import {
  FIXED_NOW,
  directoryDigests,
  tempDataRoot,
  viewtraceFixture,
} from './helpers/viewtrace.js';

let fixtureDigestsBefore: Map<string, string>;

before(async () => {
  fixtureDigestsBefore = await directoryDigests(viewtraceFixture('.'));
});

after(async () => {
  const after = await directoryDigests(viewtraceFixture('.'));
  assert.deepEqual(
    [...after.entries()].map(([k, v]) => [k.replace(viewtraceFixture('.'), ''), v]).sort(),
    [...fixtureDigestsBefore.entries()].map(([k, v]) => [k.replace(viewtraceFixture('.'), ''), v]).sort(),
    'fixture files must never be modified by ingestion',
  );
});

describe('viewtrace ingest: research-normal fixture oracle', () => {
  it('stores all 8 domain event types and replays identically after reopen', async () => {
    const root = await tempDataRoot('normal');
    const outcome = await ingestFile(viewtraceFixture('research-normal.jsonl'), {
      dataRoot: root,
      now: FIXED_NOW,
    });

    assert.equal(outcome.losses.length, 0);
    assert.equal(outcome.runs.length, 1);
    const run = outcome.runs[0];
    assert.equal(run?.runId, 'research-normal-001');
    assert.equal(run?.lifecycle, 'COMPLETED');
    assert.equal(run?.completeness, 'COMPLETE');
    assert.equal(run?.eventsAccepted, 10);
    assert.equal(run?.recordsAccepted, 12);
    assert.equal(run?.duplicatesIdempotent, 0);
    assert.equal(run?.duplicatesConflicting, 0);
    assert.ok(outcome.replayChecks.every((c) => c.verified), 'replay equality is the M0 acceptance contract');

    const store = await ViewTraceStore.open({ dataRoot: root, now: FIXED_NOW });
    const events = store.listEvents('research-normal-001');
    const types = new Set(events.map((e) => e.type));
    for (const expected of ['SEARCH', 'READ', 'CLAIM', 'COMPARE', 'HYPOTHESIS', 'CONTRADICTION', 'VERIFY', 'RECOMMEND']) {
      assert.ok(types.has(expected as never), `missing ${expected}`);
    }
    assert.equal(store.listDiagnostics('research-normal-001').filter((d) => d.severity === 'error').length, 0);
    // Failure axis preserved: one READ explicitly FAILED and stays FAILED.
    const failedRead = events.find((e) => e.eventId === 'evt-read-002');
    assert.ok(failedRead !== undefined);
    if (failedRead.payload.type === 'READ') assert.equal(failedRead.payload.outcome, 'FAILED');
    await store.close();
  });

  it('is deterministic: two independent ingests produce identical replays', async () => {
    const rootA = await tempDataRoot('det-a');
    const rootB = await tempDataRoot('det-b');
    await ingestFile(viewtraceFixture('research-normal.jsonl'), { dataRoot: rootA, now: FIXED_NOW });
    await ingestFile(viewtraceFixture('research-normal.jsonl'), { dataRoot: rootB, now: FIXED_NOW });
    const storeA = await ViewTraceStore.open({ dataRoot: rootA, now: FIXED_NOW });
    const storeB = await ViewTraceStore.open({ dataRoot: rootB, now: FIXED_NOW });
    assert.equal(
      JSON.stringify(storeA.replay('research-normal-001')),
      JSON.stringify(storeB.replay('research-normal-001')),
    );
    assert.equal(
      await storeA.readTraceJsonl('research-normal-001'),
      await storeB.readTraceJsonl('research-normal-001'),
    );
    await storeA.close();
    await storeB.close();
  });
});

describe('viewtrace ingest: partial stream fixture oracle', () => {
  it('preserves loss counts/positions and never reports COMPLETE', async () => {
    const root = await tempDataRoot('partial');
    const outcome = await ingestFile(viewtraceFixture('research-partial.jsonl'), {
      dataRoot: root,
      now: FIXED_NOW,
    });

    assert.equal(outcome.endedWithNewline, false);
    assert.equal(outcome.losses.length, 2);
    const malformed = outcome.losses.find((l) => l.code === 'MALFORMED_JSON');
    const truncated = outcome.losses.find((l) => l.code === 'TRUNCATED_TAIL');
    assert.ok(malformed !== undefined);
    assert.equal(malformed.definitive, true);
    assert.equal(malformed.lineIndex, 3);
    assert.ok(truncated !== undefined);
    assert.equal(truncated.definitive, false, 'tail without newline may just be incomplete');
    assert.equal(truncated.lineIndex, 4);

    const run = outcome.runs[0];
    assert.equal(run?.completeness, 'PARTIAL', 'losses must downgrade completeness');
    assert.notEqual(run?.completeness, 'COMPLETE');
    assert.equal(run?.lifecycle, 'RUNNING', 'only the first run record was accepted');
    assert.equal(run?.eventsAccepted, 1);
    assert.equal(run?.recordsAccepted, 2);
    assert.ok(outcome.replayChecks.every((c) => c.verified));
  });
});

describe('viewtrace ingest: duplicates and relations fixture oracle', () => {
  it('dedupes idempotently, isolates conflicts and reports relation problems', async () => {
    const root = await tempDataRoot('dupes');
    const outcome = await ingestFile(viewtraceFixture('dupes-relations.jsonl'), {
      dataRoot: root,
      now: FIXED_NOW,
    });
    assert.equal(outcome.runs.length, 2);
    const a = outcome.runs.find((r) => r.runId === 'dupes-run-a');
    const b = outcome.runs.find((r) => r.runId === 'dupes-run-b');
    assert.ok(a !== undefined && b !== undefined);

    assert.equal(a.eventsAccepted, 6, 'unique events stored (two receipts were duplicates)');
    assert.equal(a.recordsAccepted, 7, '6 events + 1 run record');
    assert.equal(a.duplicatesIdempotent, 1);
    assert.equal(a.duplicatesConflicting, 1);
    assert.equal(a.lifecycle, 'RUNNING', 'run A never observed termination');

    assert.equal(b.eventsAccepted, 1);
    assert.equal(b.recordsAccepted, 2);
    assert.equal(b.lifecycle, 'COMPLETED');
    assert.equal(b.duplicatesIdempotent, 0, 'same event id in another run is not a duplicate');

    const store = await ViewTraceStore.open({ dataRoot: root, now: FIXED_NOW });
    const diagnostics = store.listDiagnostics('dupes-run-a');
    const codes = new Set(diagnostics.map((d) => d.code));
    assert.ok(codes.has('DUPLICATE_CONFLICTING'));
    assert.ok(codes.has('DANGLING_RELATION'), 'missing relation target stays pending');
    assert.ok(codes.has('CYCLE_RELATION'), 'relation cycles are diagnosed');
    assert.ok(codes.has('CROSS_RUN_RELATION'), 'cross-run references stay pending');
    // The conflicting overwrite attempt must not have replaced the original.
    const dup2 = store.listEvents('dupes-run-a').find((e) => e.eventId === 'evt-dup-2');
    assert.ok(dup2 !== undefined);
    if (dup2.payload.type === 'READ') assert.equal(dup2.payload.outcome, 'SUCCESS');
    await store.close();

    assert.ok(outcome.replayChecks.every((c) => c.verified));
  });
});

describe('viewtrace ingest: forged provenance fixture oracle', () => {
  it('keeps provenance labels as claimed and excludes private payloads everywhere', async () => {
    const root = await tempDataRoot('forged');
    const outcome = await ingestFile(viewtraceFixture('forged-provenance.jsonl'), {
      dataRoot: root,
      now: FIXED_NOW,
    });
    assert.equal(outcome.runs.length, 1);
    const run = outcome.runs[0];
    assert.equal(run?.eventsAccepted, 5);
    assert.equal(run?.completeness, 'COMPLETE', 'warnings alone do not downgrade completeness');
    assert.ok(outcome.replayChecks.every((c) => c.verified));

    const store = await ViewTraceStore.open({ dataRoot: root, now: FIXED_NOW });
    const events = store.listEvents('forged-provenance-001');

    const observed = events.find((e) => e.eventId === 'evt-observed-noloc');
    assert.equal(observed?.provenance.category, 'VIEWTRACE_OBSERVED', 'label preserved as claimed');
    assert.ok(store.listDiagnostics('forged-provenance-001').some((d) => d.code === 'OBSERVED_WITHOUT_LOCATION'));

    const reported = events.find((e) => e.eventId === 'evt-reported-claim');
    assert.equal(reported?.provenance.category, 'AGENT_REPORTED', 'reported stays reported');

    const inferred = events.find((e) => e.eventId === 'evt-inferred');
    assert.equal(inferred?.provenance.category, 'VIEWTRACE_INFERRED');
    assert.deepEqual(inferred?.provenance.inferred?.inputEventIds, ['evt-observed-noloc', 'evt-reported-claim']);
    assert.equal(inferred?.provenance.inferred?.ruleVersion, '0.1.0');

    const recommendation = events.find((e) => e.eventId === 'evt-recommend-reported');
    assert.equal(recommendation?.provenance.category, 'AGENT_REPORTED', 'rationale is never promoted');

    // Private sentinels must be absent from every persistence layer.
    const sentinels = [
      'SENTINEL-PRIVATE-REASONING-9f3a',
      'SENTINEL-TOP-LEVEL-COT-77c1',
      'SENTINEL-ENCRYPTED-5b2d',
    ];
    const replayJson = JSON.stringify(store.replay('forged-provenance-001'));
    const jsonl = await store.readTraceJsonl('forged-provenance-001');
    const dbBytes = await readFile(join(root, 'viewtrace.db'), 'utf8');
    const diagnosticsJson = JSON.stringify(store.listDiagnostics('forged-provenance-001'));
    for (const layer of [replayJson, jsonl, dbBytes, diagnosticsJson, JSON.stringify(outcome)]) {
      for (const sentinel of sentinels) {
        assert.ok(!layer.includes(sentinel), `${sentinel} leaked into a persistence layer`);
      }
    }
    assert.ok(!replayJson.includes('"verified"'), 'no verified concept exists in M0');
    await store.close();
  });
});

describe('viewtrace ingest: invalid records fixture oracle', () => {
  it('rejects bad records, keeps the good one and downgrades completeness', async () => {
    const root = await tempDataRoot('invalid');
    const outcome = await ingestFile(viewtraceFixture('invalid-records.jsonl'), {
      dataRoot: root,
      now: FIXED_NOW,
    });
    assert.equal(outcome.runs.length, 1);
    const run = outcome.runs[0];
    assert.equal(run?.runId, 'invalid-records-001');
    assert.equal(run?.eventsAccepted, 1);
    assert.equal(run?.eventsRejected, 7);
    assert.equal(run?.completeness, 'PARTIAL');
    assert.equal(run?.lifecycle, 'UNKNOWN', 'no run records were valid — lifecycle stays UNKNOWN');

    const errorCodes = new Set(
      outcome.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code),
    );
    for (const code of [
      'FUTURE_SCHEMA_VERSION',
      'MISSING_FIELD',
      'INVALID_TIME',
      'EMPTY_ID',
      'INVALID_FIELD',
    ]) {
      assert.ok(errorCodes.has(code), `expected rejection code ${code}`);
    }
    assert.ok(outcome.replayChecks.every((c) => c.verified));
  });
});

describe('viewtrace ingest: lifecycle fixture oracle', () => {
  it('refuses terminal->running regression while storing the observation', async () => {
    const root = await tempDataRoot('life');
    const outcome = await ingestFile(viewtraceFixture('lifecycle-invalid.jsonl'), {
      dataRoot: root,
      now: FIXED_NOW,
    });
    const run = outcome.runs[0];
    assert.equal(run?.lifecycle, 'COMPLETED');
    assert.notEqual(run?.lifecycle, 'RUNNING');
    assert.equal(run?.recordsAccepted, 4);
    assert.ok(
      outcome.diagnostics.some((d) => d.code === 'RUN_TRANSITION_INVALID'),
    );
    assert.ok(outcome.replayChecks.every((c) => c.verified));
  });
});

describe('viewtrace ingest: empty input', () => {
  it('handles a fixture with only blank lines without creating runs', async () => {
    const root = await tempDataRoot('empty');
    const outcome = await ingestFile(viewtraceFixture('empty.jsonl'), {
      dataRoot: root,
      now: FIXED_NOW,
    });
    assert.equal(outcome.runs.length, 0);
    assert.equal(outcome.losses.length, 0);
  });
});
