/**
 * Shared helpers for ViewTrace tests: deterministic builders, temp data
 * roots and fixture checksums.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DomainPayload,
  EventRelation,
  ProvenanceInfo,
  RunRecordLine,
  SourceReference,
  ViewTraceEvent,
} from '../../src/viewtrace/types.js';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const viewtraceFixtures = join(repoRoot, 'fixtures', 'viewtrace');
export const cliDist = join(repoRoot, 'dist', 'src', 'viewtrace', 'cli.js');

export function viewtraceFixture(name: string): string {
  return join(viewtraceFixtures, name);
}

/** Deterministic clock — replay equality and dedup tests depend on it. */
export const FIXED_NOW = (): string => '2026-10-06T00:00:00.000Z';

export async function tempDataRoot(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `viewtrace-${label}-`));
}

export const DEFAULT_SOURCE: SourceReference = {
  sourceId: 'src-test',
  kind: 'TOOL_RESULT',
  location: 'tool://test/call-1',
};

export const DEFAULT_PROVENANCE: ProvenanceInfo = {
  category: 'VIEWTRACE_OBSERVED',
  observed: { toolCallId: 'call-1', toolResultId: 'result-1' },
};

export interface MakeEventOverrides {
  eventId?: string;
  runId?: string;
  type?: ViewTraceEvent['type'];
  payload?: DomainPayload;
  occurredAt?: string;
  sequence?: number;
  receivedAt?: string;
  adapterId?: string;
  adapterVersion?: string;
  origin?: ViewTraceEvent['origin'];
  source?: SourceReference;
  provenance?: ProvenanceInfo;
  relations?: EventRelation[];
}

export function makeEvent(overrides: MakeEventOverrides = {}): ViewTraceEvent {
  return {
    recordKind: 'event',
    schemaVersion: 1,
    eventId: overrides.eventId ?? 'evt-test-001',
    runId: overrides.runId ?? 'run-test-001',
    type: overrides.type ?? 'SEARCH',
    occurredAt: overrides.occurredAt ?? '2026-10-06T09:00:00Z',
    sequence: overrides.sequence ?? 1,
    receivedAt: overrides.receivedAt ?? FIXED_NOW(),
    adapterId: overrides.adapterId ?? 'viewtrace-reference-jsonl',
    adapterVersion: overrides.adapterVersion ?? '1.0.0',
    origin: overrides.origin ?? { producer: 'viewtrace-reference-jsonl' },
    source: overrides.source ?? DEFAULT_SOURCE,
    provenance: overrides.provenance ?? DEFAULT_PROVENANCE,
    payload:
      overrides.payload ??
      ({ type: 'SEARCH', query: '테스트 쿼리', results: [] } as DomainPayload),
    relations: overrides.relations,
  };
}

export interface MakeRunOverrides {
  runId?: string;
  lifecycle?: RunRecordLine['lifecycle'];
  occurredAt?: string;
  sequence?: number;
  detail?: string;
}

export function makeRunRecord(overrides: MakeRunOverrides = {}): RunRecordLine {
  return {
    recordKind: 'run',
    schemaVersion: 1,
    runId: overrides.runId ?? 'run-test-001',
    lifecycle: overrides.lifecycle ?? 'RUNNING',
    occurredAt: overrides.occurredAt ?? '2026-10-06T09:00:00Z',
    sequence: overrides.sequence ?? 1,
    receivedAt: FIXED_NOW(),
    adapterId: 'viewtrace-reference-jsonl',
    adapterVersion: '1.0.0',
    detail: overrides.detail,
  };
}

/** Content-only raw record for the validator (JSON-shaped, no envelope). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rawEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recordKind: 'event',
    schemaVersion: 1,
    eventId: 'evt-raw-001',
    runId: 'run-raw-001',
    type: 'SEARCH',
    occurredAt: '2026-10-06T09:00:00Z',
    adapterId: 'viewtrace-reference-jsonl',
    adapterVersion: '1.0.0',
    origin: { producer: 'viewtrace-reference-jsonl' },
    source: { sourceId: 'src-raw', kind: 'TOOL_RESULT', location: 'tool://raw/1' },
    provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'c1' } },
    payload: { type: 'SEARCH', query: '원시 레코드', results: [] },
    ...overrides,
  };
}

export async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/** Snapshot of file digests under a directory (fixture-immutability checks). */
export async function directoryDigests(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile()) out.set(p, await sha256File(p));
    }
  }
  const info = await stat(root);
  if (info.isDirectory()) await walk(root);
  else out.set(root, await sha256File(root));
  return out;
}
