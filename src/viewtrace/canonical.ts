/**
 * Canonical JSON serialization for ViewTrace records.
 *
 * Determinism contract: the same logical record always serializes to the
 * same bytes (recursively sorted object keys), which makes
 *  - duplicate detection stable across processes and reopens,
 *  - replay byte-comparable,
 *  - hashes meaningful.
 */

import { createHash } from 'node:crypto';
import type { TraceRecord } from './types.js';

export function canonicalize(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => serialize(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`).join(',')}}`;
}

/**
 * Content hash for duplicate detection. Collector envelope fields
 * (`sequence`, `receivedAt`) are excluded: a genuine re-receipt of the same
 * payload with a new reception stamp must be idempotent, not a conflict.
 */
export function contentHash(record: TraceRecord): string {
  const { sequence: _sequence, receivedAt: _receivedAt, ...content } = record;
  return createHash('sha256').update(canonicalize(content), 'utf8').digest('hex');
}

/** Hash of the full canonical record (used as the stored row identity). */
export function recordHash(record: TraceRecord): string {
  return createHash('sha256').update(canonicalize(record), 'utf8').digest('hex');
}
