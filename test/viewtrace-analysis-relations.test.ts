import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractClaimsAndRelations } from '../src/viewtrace/analyzer/claims-relations.js';
import { assessVerificationsAndConflicts } from '../src/viewtrace/analyzer/verification.js';
import { buildSourceLedger } from '../src/viewtrace/analyzer/source-ledger.js';
import type { ViewTraceEvent } from '../src/viewtrace/types.js';

describe('M3 claims, relations and verification conflict engine', () => {
  it('detects forged observed provenance and marks evidence inadmissible', () => {
    const forgedEv: ViewTraceEvent = {
      recordKind: 'event',
      schemaVersion: 1,
      eventId: 'ev-forged',
      runId: 'run-f',
      type: 'READ',
      occurredAt: '2026-10-07T10:00:00Z',
      sequence: 1,
      receivedAt: '2026-10-07T10:00:00Z',
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.0.0',
      origin: { producer: 'test' },
      source: { sourceId: 'src-1', kind: 'URL', location: 'https://example.com' },
      provenance: { category: 'VIEWTRACE_OBSERVED' }, // No observed locator!
      payload: { type: 'READ', sourceId: 'src-1', outcome: 'SUCCESS' },
    };

    const sources = buildSourceLedger([forgedEv]);
    const extracted = extractClaimsAndRelations([forgedEv], sources);

    assert.equal(extracted.evidence.length, 1);
    const item = extracted.evidence[0]!;
    assert.equal(item.provenanceIntegrity, 'FORGED_OBSERVED');
    assert.equal(item.effectiveProvenance, 'VIEWTRACE_INFERRED');
    assert.equal(item.admissibility, 'INADMISSIBLE');
  });

  it('detects contradiction under same conditions and preserves conflict history upon resolution', () => {
    const readEv: ViewTraceEvent = {
      recordKind: 'event',
      schemaVersion: 1,
      eventId: 'ev-r',
      runId: 'run-c',
      type: 'READ',
      occurredAt: '2026-10-07T10:00:00Z',
      sequence: 1,
      receivedAt: '2026-10-07T10:00:00Z',
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.0.0',
      origin: { producer: 'test' },
      source: { sourceId: 'src-truth', kind: 'URL', location: 'https://official.spec/v1' },
      provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'c1' } },
      payload: { type: 'READ', sourceId: 'src-truth', outcome: 'SUCCESS' },
    };

    const claim1: ViewTraceEvent = {
      recordKind: 'event',
      schemaVersion: 1,
      eventId: 'ev-c1',
      runId: 'run-c',
      type: 'CLAIM',
      occurredAt: '2026-10-07T10:00:05Z',
      sequence: 2,
      receivedAt: '2026-10-07T10:00:05Z',
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.0.0',
      origin: { producer: 'test' },
      source: { sourceId: 'src-truth', kind: 'URL', location: 'https://official.spec/v1' },
      provenance: { category: 'AGENT_REPORTED' },
      payload: { type: 'CLAIM', text: 'Value is TRUE' },
    };

    const claim2: ViewTraceEvent = {
      recordKind: 'event',
      schemaVersion: 1,
      eventId: 'ev-c2',
      runId: 'run-c',
      type: 'CLAIM',
      occurredAt: '2026-10-07T10:00:10Z',
      sequence: 3,
      receivedAt: '2026-10-07T10:00:10Z',
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.0.0',
      origin: { producer: 'test' },
      source: { sourceId: 'src-truth', kind: 'URL', location: 'https://official.spec/v1' },
      provenance: { category: 'AGENT_REPORTED' },
      payload: { type: 'CLAIM', text: 'Value is FALSE' },
    };

    const contraEv: ViewTraceEvent = {
      recordKind: 'event',
      schemaVersion: 1,
      eventId: 'ev-contra',
      runId: 'run-c',
      type: 'CONTRADICTION',
      occurredAt: '2026-10-07T10:00:15Z',
      sequence: 4,
      receivedAt: '2026-10-07T10:00:15Z',
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.0.0',
      origin: { producer: 'test' },
      source: { sourceId: 'src-truth', kind: 'URL', location: 'https://official.spec/v1' },
      provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'c2' } },
      payload: {
        type: 'CONTRADICTION',
        description: 'Value conflict under identical conditions',
        conflictingEventIds: ['ev-c1', 'ev-c2'],
        conditions: ['env=prod'],
      },
    };

    const inputRev = {
      algorithm: 'sha256-canonical-schema1-records-v1' as const,
      value: '1'.repeat(64),
      recordCount: 4,
    };

    // Phase 1: Unresolved conflict
    const eventsPhase1 = [readEv, claim1, claim2, contraEv];
    const sources1 = buildSourceLedger(eventsPhase1);
    const ext1 = extractClaimsAndRelations(eventsPhase1, sources1);
    const assessment1 = assessVerificationsAndConflicts(
      eventsPhase1,
      ext1.claims,
      ext1.evidence,
      ext1.conditions,
      { inputRevision: inputRev },
    );

    assert.equal(assessment1.conflicts.length, 1);
    assert.equal(assessment1.conflicts[0]!.status, 'DETECTED');
    assert.equal(assessment1.conflicts[0]!.conditionMatch, 'SAME');
    assert.equal(assessment1.conflicts[0]!.history.length, 1);
    assert.equal(assessment1.conflicts[0]!.resolution, undefined);

    // Phase 2: Explicit VERIFY resolves the conflict
    const verifyEv: ViewTraceEvent = {
      recordKind: 'event',
      schemaVersion: 1,
      eventId: 'ev-v',
      runId: 'run-c',
      type: 'VERIFY',
      occurredAt: '2026-10-07T10:00:20Z',
      sequence: 5,
      receivedAt: '2026-10-07T10:00:20Z',
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.0.0',
      origin: { producer: 'test' },
      source: { sourceId: 'src-truth', kind: 'URL', location: 'https://official.spec/v1' },
      provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'c3' } },
      payload: {
        type: 'VERIFY',
        targetEventId: 'ev-c1',
        method: 'Official spec cross-check',
        result: 'CONFIRMED',
        evidenceEventIds: ['ev-r'],
      },
    };

    const eventsPhase2 = [...eventsPhase1, verifyEv];
    const sources2 = buildSourceLedger(eventsPhase2);
    const ext2 = extractClaimsAndRelations(eventsPhase2, sources2);
    const assessment2 = assessVerificationsAndConflicts(
      eventsPhase2,
      ext2.claims,
      ext2.evidence,
      ext2.conditions,
      { inputRevision: inputRev },
    );

    assert.equal(assessment2.verifications.length, 1);
    assert.equal(assessment2.verifications[0]!.correctness, 'VALID');

    assert.equal(assessment2.conflicts.length, 1);
    assert.equal(assessment2.conflicts[0]!.status, 'RESOLVED');
    assert.ok(assessment2.conflicts[0]!.resolution);
    assert.equal(assessment2.conflicts[0]!.resolution?.result, 'CONFIRMED');

    // Crucial check: History is preserved (both DETECTED and RESOLVED entries exist)
    assert.equal(assessment2.conflicts[0]!.history.length, 2);
    assert.equal(assessment2.conflicts[0]!.history[0]!.status, 'DETECTED');
    assert.equal(assessment2.conflicts[0]!.history[1]!.status, 'RESOLVED');
  });

  it('refuses to resolve conflict if VERIFY target is mismatched or missing resolver evidence', () => {
    const contraEv: ViewTraceEvent = {
      recordKind: 'event',
      schemaVersion: 1,
      eventId: 'ev-contra-only',
      runId: 'run-bad-v',
      type: 'CONTRADICTION',
      occurredAt: '2026-10-07T10:00:00Z',
      sequence: 1,
      receivedAt: '2026-10-07T10:00:00Z',
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.0.0',
      origin: { producer: 'test' },
      source: { sourceId: 'src-dummy', kind: 'UNKNOWN' },
      provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'c1' } },
      payload: {
        type: 'CONTRADICTION',
        description: 'Conflict',
        conflictingEventIds: ['ev-nonexistent-1', 'ev-nonexistent-2'],
      },
    };

    const bogusVerify: ViewTraceEvent = {
      recordKind: 'event',
      schemaVersion: 1,
      eventId: 'ev-bogus-v',
      runId: 'run-bad-v',
      type: 'VERIFY',
      occurredAt: '2026-10-07T10:00:05Z',
      sequence: 2,
      receivedAt: '2026-10-07T10:00:05Z',
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.0.0',
      origin: { producer: 'test' },
      source: { sourceId: 'src-dummy', kind: 'UNKNOWN' },
      provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'c2' } },
      payload: {
        type: 'VERIFY',
        targetEventId: 'ev-missing',
        method: 'Blind assertion',
        result: 'CONFIRMED',
        evidenceEventIds: [], // Empty resolver evidence!
      },
    };

    const evs = [contraEv, bogusVerify];
    const assessment = assessVerificationsAndConflicts(evs, [], [], [], {
      inputRevision: {
        algorithm: 'sha256-canonical-schema1-records-v1',
        value: '0'.repeat(64),
        recordCount: 2,
      },
    });

    assert.equal(assessment.verifications[0]!.correctness, 'INVALID');
    assert.equal(assessment.conflicts[0]!.status, 'DETECTED');
  });
});
