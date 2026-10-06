import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateRecord, isValidRunId, isValidTimestamp, MAX_RECORD_BYTES } from '../src/viewtrace/validate.js';
import { rawEvent } from './helpers/viewtrace.js';
import type { DomainPayload } from '../src/viewtrace/types.js';

const VALID_PAYLOADS: DomainPayload[] = [
  { type: 'SEARCH', query: 'Node.js SQLite', results: [{ sourceId: 's1', title: '문서', url: 'https://example.com', rank: 1 }] },
  { type: 'READ', sourceId: 's1', outcome: 'SUCCESS', summary: '읽음' },
  { type: 'CLAIM', text: '어떤 주장', sourceId: 's1', anchor: '#sec' },
  { type: 'COMPARE', candidates: ['a', 'b'], criteria: ['가격'], cells: [{ candidate: 'a', criterion: '가격', value: 100, evidenceEventIds: ['e1'] }, { candidate: 'b', criterion: '가격', value: null }] },
  { type: 'HYPOTHESIS', text: '공개 판단', basis: 'PUBLIC_STATEMENT', basedOnEventIds: ['e1'] },
  { type: 'CONTRADICTION', description: '상충', conflictingEventIds: ['e1', 'e2'], conditions: ['동일 조건'] },
  { type: 'VERIFY', targetEventId: 'e1', method: '재확인', result: 'CONFIRMED', evidenceEventIds: ['e2'] },
  { type: 'RECOMMEND', choice: 'a', alternatives: ['b'], userConditions: ['조건'], rationale: ['이유'], rationaleEventIds: ['e1'] },
];

function codes(outcome: { ok: boolean; errors?: readonly { code: string }[] }): string[] {
  return (outcome.errors ?? []).map((e) => e.code);
}

describe('viewtrace validator: acceptance', () => {
  it('accepts a valid record for each of the 8 domain event types', () => {
    for (const payload of VALID_PAYLOADS) {
      const outcome = validateRecord(rawEvent({ type: payload.type, payload }));
      assert.equal(outcome.ok, true, payload.type);
    }
  });

  it('accepts a valid run record', () => {
    const outcome = validateRecord({
      recordKind: 'run', schemaVersion: 1, runId: 'run-1', lifecycle: 'COMPLETED',
      occurredAt: '2026-10-06T09:00:00+09:00', adapterId: 'viewtrace-reference-jsonl', adapterVersion: '1.0.0',
    });
    assert.equal(outcome.ok, true);
  });

  it('accepts timestamps with Z, offset and fractional seconds; rejects naive, bad offsets and impossible dates', () => {
    assert.equal(isValidTimestamp('2026-10-06T09:00:00Z'), true);
    assert.equal(isValidTimestamp('2026-10-06T09:00:00.123456Z'), true);
    assert.equal(isValidTimestamp('2026-10-06T09:00:00+09:00'), true);
    assert.equal(isValidTimestamp('2026-10-06T09:00:00-05:30'), true);
    assert.equal(isValidTimestamp('2026-10-06T09:00:00'), false, 'no timezone');
    assert.equal(isValidTimestamp('2026-10-06 09:00:00Z'), false, 'space separator');
    assert.equal(isValidTimestamp('2026-10-06'), false, 'date only');
    assert.equal(isValidTimestamp('2026-10-06T09:00:00+25:00'), false, 'offset hours out of range');
    assert.equal(isValidTimestamp('2026-10-06T09:00:70Z'), false, 'seconds out of range');
    assert.equal(isValidTimestamp('2026-02-30T09:00:00Z'), false, 'impossible calendar date');
    assert.equal(isValidTimestamp('2026-13-01T09:00:00Z'), false, 'month out of range');
  });

  it('accepts filesystem-safe run ids and rejects traversal/reserved/Windows-hostile ids', () => {
    assert.equal(isValidRunId('research-normal-001'), true);
    assert.equal(isValidRunId('Run_01.2026'), true);
    assert.equal(isValidRunId('../escape'), false);
    assert.equal(isValidRunId('a/b'), false);
    assert.equal(isValidRunId('.hidden'), false, 'must start alphanumeric');
    assert.equal(isValidRunId('CON'), false, 'Windows reserved');
    assert.equal(isValidRunId('com1'), false, 'Windows reserved (case-insensitive)');
    assert.equal(isValidRunId('trailing.'), false, 'Windows trailing dot');
    assert.equal(isValidRunId('trailing '), false, 'Windows trailing space');
    assert.equal(isValidRunId(''), false);
  });
});

describe('viewtrace validator: rejection', () => {
  it('rejects non-object records', () => {
    assert.equal(validateRecord(null).ok, false);
    assert.equal(validateRecord('x').ok, false);
    assert.equal(validateRecord([1, 2]).ok, false);
  });

  it('rejects missing required common fields with per-field codes', () => {
    for (const key of ['recordKind', 'schemaVersion', 'eventId', 'runId', 'type', 'occurredAt', 'adapterId', 'adapterVersion', 'origin', 'source', 'provenance', 'payload']) {
      const raw = rawEvent();
      delete raw[key];
      const outcome = validateRecord(raw);
      assert.equal(outcome.ok, false, `missing ${key}`);
    }
  });

  it('rejects future and unsupported schema versions distinctly', () => {
    const future = validateRecord(rawEvent({ schemaVersion: 2 }));
    assert.equal(future.ok, false);
    assert.ok(codes(future).includes('FUTURE_SCHEMA_VERSION'));
    const past = validateRecord(rawEvent({ schemaVersion: 0 }));
    assert.equal(past.ok, false);
    assert.ok(codes(past).includes('UNSUPPORTED_SCHEMA_VERSION'));
    const stringVersion = validateRecord(rawEvent({ schemaVersion: '1' }));
    assert.equal(stringVersion.ok, false);
    assert.ok(codes(stringVersion).includes('INVALID_SCHEMA_VERSION'));
  });

  it('rejects empty ids and malformed ids', () => {
    const emptyId = validateRecord(rawEvent({ eventId: '' }));
    assert.ok(codes(emptyId).includes('EMPTY_ID'));
    const badId = validateRecord(rawEvent({ eventId: 'has/slash' }));
    assert.ok(codes(badId).includes('INVALID_ID'));
    const badRun = validateRecord(rawEvent({ runId: 'CON' }));
    assert.ok(codes(badRun).includes('INVALID_RUN_ID'));
    const emptyAdapter = validateRecord(rawEvent({ adapterId: '' }));
    assert.ok(codes(emptyAdapter).includes('EMPTY_ID'));
  });

  it('rejects invalid sequence values including NaN and Infinity (programmatic input)', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3']) {
      const outcome = validateRecord(rawEvent({ sequence: bad }));
      assert.equal(outcome.ok, false, `sequence=${String(bad)}`);
      assert.ok(codes(outcome).includes('INVALID_SEQUENCE'), `sequence=${String(bad)}`);
    }
    assert.equal(validateRecord(rawEvent({ sequence: 0 })).ok, true, 'sequence 0 is valid');
  });

  it('rejects oversized records', () => {
    const outcome = validateRecord(
      rawEvent({ payload: { type: 'SEARCH', query: 'x'.repeat(MAX_RECORD_BYTES), results: [] } }),
    );
    assert.equal(outcome.ok, false);
    assert.ok(codes(outcome).includes('OVERSIZED_RECORD'));
  });

  it('rejects payload/type mismatches and unknown types/kinds', () => {
    const mismatch = validateRecord(rawEvent({ type: 'SEARCH', payload: { type: 'READ', sourceId: 's', outcome: 'SUCCESS' } }));
    assert.equal(mismatch.ok, false);
    const unknownType = validateRecord(rawEvent({ type: 'FOO' }));
    assert.equal(unknownType.ok, false);
    const unknownKind = validateRecord(rawEvent({ recordKind: 'banana' }));
    assert.equal(unknownKind.ok, false);
  });

  it('rejects malformed provenance categories, source kinds, relation types and run lifecycles', () => {
    assert.equal(validateRecord(rawEvent({ provenance: { category: 'VERIFIED' } })).ok, false);
    assert.equal(validateRecord(rawEvent({ source: { sourceId: 's', kind: 'MAGIC' } })).ok, false);
    assert.equal(
      validateRecord(rawEvent({ relations: [{ type: 'LIKES', targetEventId: 'e1' }] })).ok,
      false,
    );
    assert.equal(
      validateRecord({ recordKind: 'run', schemaVersion: 1, runId: 'run-1', lifecycle: 'PAUSED', occurredAt: '2026-10-06T09:00:00Z', adapterId: 'a', adapterVersion: '1' }).ok,
      false,
    );
  });

  it('rejects non-finite numbers in compare cells (programmatic input)', () => {
    const payload = { type: 'COMPARE', candidates: ['a'], criteria: ['c'], cells: [{ candidate: 'a', criterion: 'c', value: Number.POSITIVE_INFINITY }] };
    const outcome = validateRecord(rawEvent({ type: 'COMPARE', payload }));
    assert.equal(outcome.ok, false);
  });
});

describe('viewtrace validator: honesty rules', () => {
  it('structurally strips declared private-reasoning fields and never echoes their values', () => {
    const outcome = validateRecord(
      rawEvent({
        thinking: '비공개 추론 내용 SENTINEL-A',
        analysis: { chain_of_thought: 'SENTINEL-B' },
        encrypted_content: 'SENTINEL-C',
        payload: { type: 'SEARCH', query: '정상 쿼리', results: [], reasoning: 'SENTINEL-D' },
      }),
    );
    assert.equal(outcome.ok, true, 'record itself remains valid');
    assert.deepEqual([...outcome.redactedFields].sort(), [
      'analysis',
      'encrypted_content',
      'payload.reasoning',
      'thinking',
    ]);
    const messages = [...outcome.warnings.map((w) => w.message)].join(' ');
    assert.ok(!messages.includes('SENTINEL'), 'warning messages must not contain redacted values');
    const serialized = JSON.stringify(outcome.record);
    for (const sentinel of ['SENTINEL-A', 'SENTINEL-B', 'SENTINEL-C', 'SENTINEL-D']) {
      assert.ok(!serialized.includes(sentinel), `${sentinel} must not survive in the normalized record`);
    }
  });

  it('keeps a claimed VIEWTRACE_OBSERVED label but flags the missing observation location', () => {
    const outcome = validateRecord(rawEvent({ provenance: { category: 'VIEWTRACE_OBSERVED' } }));
    assert.equal(outcome.ok, true);
    assert.equal(outcome.record.recordKind === 'event' && outcome.record.provenance.category, 'VIEWTRACE_OBSERVED');
    assert.ok(outcome.warnings.some((w) => w.code === 'OBSERVED_WITHOUT_LOCATION'));
  });

  it('flags VIEWTRACE_INFERRED records without input ids, keeping the label', () => {
    const outcome = validateRecord(rawEvent({
      type: 'HYPOTHESIS',
      provenance: { category: 'VIEWTRACE_INFERRED', inferred: { inputEventIds: [] } },
      payload: { type: 'HYPOTHESIS', text: '빈 입력 추론' },
    }));
    assert.equal(outcome.ok, true);
    assert.ok(outcome.warnings.some((w) => w.code === 'INFERRED_WITHOUT_INPUTS'));
  });

  it('preserves inferred inputs and rule versions', () => {
    const outcome = validateRecord(rawEvent({
      type: 'HYPOTHESIS',
      provenance: { category: 'VIEWTRACE_INFERRED', inferred: { inputEventIds: ['e-in-1', 'e-in-2'], ruleId: 'rule-x', ruleVersion: '0.4.1' } },
      payload: { type: 'HYPOTHESIS', text: '추론', basis: 'LABELED_INFERENCE' },
    }));
    assert.equal(outcome.ok, true);
    if (outcome.record.recordKind === 'event') {
      assert.deepEqual(outcome.record.provenance.inferred?.inputEventIds, ['e-in-1', 'e-in-2']);
      assert.equal(outcome.record.provenance.inferred?.ruleVersion, '0.4.1');
    }
  });

  it('drops unknown fields by name only (values never echoed)', () => {
    const outcome = validateRecord(rawEvent({ surprise: 'SECRET-VALUE-99', payload: { type: 'SEARCH', query: 'q', results: [], extra: 'SECRET-VALUE-98' } }));
    assert.equal(outcome.ok, true);
    const dropped = outcome.warnings.find((w) => w.code === 'UNKNOWN_FIELD_DROPPED');
    assert.ok(dropped !== undefined);
    assert.ok(dropped.message.includes('surprise') && dropped.message.includes('payload.extra'));
    assert.ok(!dropped.message.includes('SECRET-VALUE'));
    assert.ok(!JSON.stringify(outcome.record).includes('SECRET-VALUE'));
  });

  it('warns on READ events whose source has no recorded location', () => {
    const outcome = validateRecord(rawEvent({
      type: 'READ',
      source: { sourceId: 'src-noloc', kind: 'URL' },
      payload: { type: 'READ', sourceId: 'src-noloc', outcome: 'SUCCESS' },
    }));
    assert.equal(outcome.ok, true);
    assert.ok(outcome.warnings.some((w) => w.code === 'SOURCE_LOCATION_MISSING'));
  });

  it('warns on VERIFY records without target or evidence, but keeps them', () => {
    const outcome = validateRecord(rawEvent({
      type: 'VERIFY',
      payload: { type: 'VERIFY', method: '확인 시도', result: 'INCONCLUSIVE', evidenceEventIds: [] },
    }));
    assert.equal(outcome.ok, true);
    assert.ok(outcome.warnings.some((w) => w.code === 'VERIFY_TARGET_UNSPECIFIED'));
    assert.ok(outcome.warnings.some((w) => w.code === 'VERIFY_WITHOUT_EVIDENCE'));
  });

  it('normalizes the record deterministically (canonical key order)', () => {
    const a = validateRecord(rawEvent());
    const b = validateRecord(rawEvent());
    assert.ok(a.ok && b.ok);
    assert.equal(JSON.stringify(a.record), JSON.stringify(b.record));
  });
});
