import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSourceLedger, normalizeLocation } from '../src/viewtrace/analyzer/source-ledger.js';
import type { ViewTraceEvent } from '../src/viewtrace/types.js';

describe('M3 source normalization, ledger and mirror deduplication', () => {
  it('normalizes URLs: removes tracking params, sorts queries, normalizes ports and slashes', () => {
    const raw = 'HTTPS://Docs.Nodejs.org:443/api/sqlite.html?utm_source=twitter&b=2&a=1#section';
    const norm = normalizeLocation(raw, 'URL');
    assert.equal(norm, 'https://docs.nodejs.org/api/sqlite.html?a=1&b=2');
  });

  it('deduplicates re-reads without inflating evidence count', () => {
    const ev1: ViewTraceEvent = {
      recordKind: 'event',
      schemaVersion: 1,
      eventId: 'ev-r1',
      runId: 'run-r',
      type: 'READ',
      occurredAt: '2026-10-07T10:00:00Z',
      sequence: 1,
      receivedAt: '2026-10-07T10:00:00Z',
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.0.0',
      origin: { producer: 'test' },
      source: {
        sourceId: 'src-doc-1',
        kind: 'URL',
        location: 'https://example.com/spec?utm_medium=email',
      },
      provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'c1' } },
      payload: { type: 'READ', sourceId: 'src-doc-1', outcome: 'SUCCESS' },
    };
    const ev2: ViewTraceEvent = {
      ...ev1,
      eventId: 'ev-r2',
      sequence: 2,
      source: {
        sourceId: 'src-doc-1-dup',
        kind: 'URL',
        location: 'https://example.com/spec', // identical normalized URL
      },
    };

    const ledger = buildSourceLedger([ev1, ev2]);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.capturedSourceIds.length, 2);
    assert.ok(ledger[0]!.capturedSourceIds.includes('src-doc-1'));
    assert.ok(ledger[0]!.capturedSourceIds.includes('src-doc-1-dup'));
  });

  it('detects mirrors via archive.org and contentHash matching', () => {
    const evOriginal: ViewTraceEvent = {
      recordKind: 'event',
      schemaVersion: 1,
      eventId: 'ev-orig',
      runId: 'run-m',
      type: 'READ',
      occurredAt: '2026-10-07T10:00:00Z',
      sequence: 1,
      receivedAt: '2026-10-07T10:00:00Z',
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.0.0',
      origin: { producer: 'test' },
      source: {
        sourceId: 'src-primary',
        kind: 'URL',
        location: 'https://original.org/paper.pdf',
        contentHash: 'hash-abc-123',
      },
      provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'c1' } },
      payload: { type: 'READ', sourceId: 'src-primary', outcome: 'SUCCESS' },
    };

    const evMirror: ViewTraceEvent = {
      recordKind: 'event',
      schemaVersion: 1,
      eventId: 'ev-mirr',
      runId: 'run-m',
      type: 'READ',
      occurredAt: '2026-10-07T10:00:10Z',
      sequence: 2,
      receivedAt: '2026-10-07T10:00:10Z',
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.0.0',
      origin: { producer: 'test' },
      source: {
        sourceId: 'src-archive-mirror',
        kind: 'URL',
        location: 'https://web.archive.org/web/2024/https://original.org/paper.pdf',
        contentHash: 'hash-abc-123',
      },
      provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'c2' } },
      payload: { type: 'READ', sourceId: 'src-archive-mirror', outcome: 'SUCCESS' },
    };

    const ledger = buildSourceLedger([evOriginal, evMirror]);
    assert.equal(ledger.length, 2);
    const mirrorEntry = ledger.find((e) => e.capturedSourceIds.includes('src-archive-mirror'));
    assert.ok(mirrorEntry);
    assert.equal(mirrorEntry.identityStatus, 'POSSIBLE_MIRROR');
    assert.equal(mirrorEntry.mirrorOfCanonicalSourceId, ledger[0]!.canonicalSourceId);
  });

  it('detects spoof-suspected sources asserting official identity on suspicious hosts', () => {
    const evSpoof: ViewTraceEvent = {
      recordKind: 'event',
      schemaVersion: 1,
      eventId: 'ev-sp',
      runId: 'run-sp',
      type: 'READ',
      occurredAt: '2026-10-07T10:00:00Z',
      sequence: 1,
      receivedAt: '2026-10-07T10:00:00Z',
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.0.0',
      origin: { producer: 'test' },
      source: {
        sourceId: 'src-fake',
        kind: 'URL',
        location: 'http://198.51.100.22/node-docs',
        title: 'Official Node.js Canonical Documentation',
      },
      provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'c1' } },
      payload: { type: 'READ', sourceId: 'src-fake', outcome: 'SUCCESS' },
    };

    const ledger = buildSourceLedger([evSpoof]);
    assert.equal(ledger[0]!.identityStatus, 'SPOOF_SUSPECTED');
  });

  it('keeps absent publication and access dates absent without synthesis', () => {
    const ev: ViewTraceEvent = {
      recordKind: 'event',
      schemaVersion: 1,
      eventId: 'ev-nodate',
      runId: 'run-nd',
      type: 'READ',
      occurredAt: '2026-10-07T10:00:00Z',
      sequence: 1,
      receivedAt: '2026-10-07T10:00:00Z',
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.0.0',
      origin: { producer: 'test' },
      source: {
        sourceId: 'src-nodate',
        kind: 'URL',
        location: 'https://example.com/page',
      },
      provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'c1' } },
      payload: { type: 'READ', sourceId: 'src-nodate', outcome: 'SUCCESS' },
    };

    const ledger = buildSourceLedger([ev]);
    assert.equal(ledger[0]!.publicationDate, undefined);
    assert.equal(ledger[0]!.accessedDate, undefined);
  });
});
