/**
 * Structural validator for ViewTrace trace records (schema version 1).
 *
 * Hand-rolled, zero dependencies, in the house style of pigeon/validate.ts.
 * Every record entering the store passes through here first.
 *
 * Honesty rules enforced by this validator:
 *  - Provenance labels are preserved exactly as claimed. A record claiming
 *    VIEWTRACE_OBSERVED without an observable location is KEPT but flagged
 *    (OBSERVED_WITHOUT_LOCATION); it is never promoted, never demoted.
 *  - Declared private-reasoning fields are structurally removed and only
 *    their field *paths* are reported — never their values.
 *  - Times must be ISO 8601 with an explicit timezone. IDs must be non-empty
 *    and filesystem-safe (run IDs become directory names).
 *  - Unknown fields are dropped (names reported, values never echoed).
 *  - Nothing is invented: absent optional facts simply stay absent.
 */

import {
  DOMAIN_EVENT_TYPES,
  OPERATION_STATUSES,
  PROVENANCE_CATEGORIES,
  RECORD_KINDS,
  RELATION_TYPES,
  RUN_LIFECYCLES,
  SCHEMA_VERSION,
  SOURCE_KINDS,
  VERIFY_RESULTS,
} from './types.js';
import type {
  Diagnostic,
  DomainEventType,
  EventOrigin,
  EventRelation,
  ObservedLocation,
  ProvenanceInfo,
  RecordKind,
  RunLifecycle,
  RunRecordLine,
  SourceReference,
  TraceRecord,
  ViewTraceEvent,
} from './types.js';
import { ANSWER_HASH_VERSION, answerHash, normalizedAnswer } from './answer.js';
import { redactSecrets, SECRET_FIELDS } from './privacy.js';
import { canonicalize } from './canonical.js';

export const MAX_RECORD_BYTES = 1024 * 1024;

/**
 * Structurally private field names. Any object key inside a record matching
 * one of these (case-insensitive) is removed before the record is normalized,
 * stored or echoed anywhere. This is structural exclusion of declared fields,
 * not free-text keyword guessing — free text is never treated as safe or
 * unsafe based on keywords.
 */
const PRIVATE_FIELD_NAMES = new Set([
  'reasoning',
  'reasoning_content',
  'reasoning_text',
  'thinking',
  'thinking_delta',
  'thought',
  'thoughts',
  'analysis',
  'analysis_content',
  'private_reasoning',
  'internal_monologue',
  'encrypted_content',
  'encrypted_reasoning',
  'cot',
  'chain_of_thought',
  'signature',
]);

/** Windows reserved device names — run IDs become directory names. */
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export interface ValidationOk {
  ok: true;
  record: TraceRecord;
  warnings: readonly Diagnostic[];
  redactedFields: readonly string[];
}
export interface ValidationFail {
  ok: false;
  errors: readonly Diagnostic[];
  warnings: readonly Diagnostic[];
  redactedFields: readonly string[];
}
export type ValidationOutcome = ValidationOk | ValidationFail;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function err(code: string, message: string): Diagnostic {
  return { code, severity: 'error', message };
}
function warn(code: string, message: string): Diagnostic {
  return { code, severity: 'warning', message };
}
function info(code: string, message: string): Diagnostic {
  return { code, severity: 'info', message };
}

export function isValidTimestamp(value: string): boolean {
  const m = TIMESTAMP_PATTERN.exec(value);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const offset = m[8] ?? '';
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offset !== 'Z') {
    const oh = Number(offset.slice(1, 3));
    const om = Number(offset.slice(4, 6));
    if (oh > 23 || om > 59) return false;
  }
  // Reject impossible calendar dates (e.g. Feb 30) via round-trip.
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return false;
  return year >= 1970 && year <= 9999;
}

export function isValidRunId(value: string): boolean {
  if (!RUN_ID_PATTERN.test(value)) return false;
  const lower = value.toLowerCase();
  if (RESERVED_NAMES.has(lower)) return false;
  if (value.endsWith('.') || value.endsWith(' ')) return false;
  return true;
}

export function isValidEventId(value: string): boolean {
  return EVENT_ID_PATTERN.test(value);
}

/** Recursively strip declared private fields; returns the cleaned copy. */
function stripPrivateFields(value: unknown, path: string, removed: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((v, i) => stripPrivateFields(v, `${path}[${i}]`, removed));
  }
  if (typeof value === 'string') return redactSecrets(value);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (PRIVATE_FIELD_NAMES.has(key.toLowerCase()) || SECRET_FIELDS.has(key.toLowerCase())) {
      removed.push(path ? `${path}.${key}` : key);
      continue;
    }
    out[key] = stripPrivateFields(v, path ? `${path}.${key}` : key, removed);
  }
  return out;
}

/**
 * Pre-storage sanitization used by the live wrapper before bytes ever reach
 * a spool file: the same structural field list the validator enforces, so
 * declared private-reasoning payloads never land anywhere on disk.
 */
export function stripPrivateReasoningFields(value: unknown): {
  value: unknown;
  removed: readonly string[];
} {
  const removed: string[] = [];
  const cleaned = stripPrivateFields(value, '', removed);
  return { value: cleaned, removed };
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  label: string,
  errors: Diagnostic[],
): string | undefined {
  const v = obj[key];
  if (typeof v !== 'string') {
    errors.push(err('MISSING_FIELD', `${label} must be a string`));
    return undefined;
  }
  if (v.length === 0) {
    errors.push(err('EMPTY_ID', `${label} must be a non-empty string`));
    return undefined;
  }
  return v;
}

function optionalString(obj: Record<string, unknown>, key: string, errors: Diagnostic[]): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    errors.push(err('INVALID_FIELD', `${key} must be a string when present`));
    return undefined;
  }
  return v;
}

function optionalStringArray(
  obj: Record<string, unknown>,
  key: string,
  errors: Diagnostic[],
): readonly string[] | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.length > 0)) {
    errors.push(err('INVALID_FIELD', `${key} must be an array of non-empty strings`));
    return undefined;
  }
  return v as readonly string[];
}

function validateEventIdField(
  obj: Record<string, unknown>,
  key: string,
  label: string,
  errors: Diagnostic[],
): string | undefined {
  const v = requireString(obj, key, label, errors);
  if (v === undefined) return undefined;
  if (!isValidEventId(v)) {
    errors.push(err('INVALID_ID', `${label} is not a valid event-scoped id`));
    return undefined;
  }
  return v;
}

function validateRunIdField(
  obj: Record<string, unknown>,
  key: string,
  label: string,
  errors: Diagnostic[],
): string | undefined {
  const v = requireString(obj, key, label, errors);
  if (v === undefined) return undefined;
  if (!isValidRunId(v)) {
    errors.push(err('INVALID_RUN_ID', `${label} is not a valid run id (filesystem-safe, non-reserved)`));
    return undefined;
  }
  return v;
}

function validateTimestampField(
  obj: Record<string, unknown>,
  key: string,
  errors: Diagnostic[],
  required: boolean,
): string | undefined {
  const v = obj[key];
  if (v === undefined) {
    if (required) errors.push(err('MISSING_FIELD', `${key} is required`));
    return undefined;
  }
  if (typeof v !== 'string' || !isValidTimestamp(v)) {
    errors.push(err('INVALID_TIME', `${key} must be ISO 8601 with an explicit timezone`));
    return undefined;
  }
  return v;
}

function validateSequence(obj: Record<string, unknown>, errors: Diagnostic[]): number | undefined {
  const v = obj['sequence'];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    errors.push(err('INVALID_SEQUENCE', 'sequence must be a non-negative integer'));
    return undefined;
  }
  return v;
}

/* ------------------------------------------------------------------ */
/* Sub-object validation                                               */
/* ------------------------------------------------------------------ */

const KNOWN_ORIGIN_FIELDS = new Set(['producer', 'agent', 'tool', 'recordedFrom']);

function validateOrigin(
  raw: unknown,
  errors: Diagnostic[],
  unknownFields: string[],
): EventOrigin | undefined {
  if (!isPlainObject(raw)) {
    errors.push(err('INVALID_FIELD', 'origin must be an object'));
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_ORIGIN_FIELDS.has(key)) unknownFields.push(`origin.${key}`);
  }
  const producer = requireString(raw, 'producer', 'origin.producer', errors);
  const agent = optionalString(raw, 'agent', errors);
  const tool = optionalString(raw, 'tool', errors);
  const recordedFrom = optionalString(raw, 'recordedFrom', errors);
  if (producer === undefined) return undefined;
  return { producer, agent, tool, recordedFrom };
}

const KNOWN_SOURCE_FIELDS = new Set([
  'sourceId',
  'kind',
  'location',
  'anchor',
  'contentHash',
  'accessedAt',
  'title',
]);

function validateSource(
  raw: unknown,
  errors: Diagnostic[],
  warnings: Diagnostic[],
  unknownFields: string[],
): SourceReference | undefined {
  if (!isPlainObject(raw)) {
    errors.push(err('INVALID_FIELD', 'source must be an object'));
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_SOURCE_FIELDS.has(key)) unknownFields.push(`source.${key}`);
  }
  const sourceId = validateEventIdField(raw, 'sourceId', 'source.sourceId', errors);
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !SOURCE_KINDS.includes(kind as never)) {
    errors.push(err('INVALID_FIELD', `source.kind must be one of ${SOURCE_KINDS.join('|')}`));
    return undefined;
  }
  const sourceKind = kind as SourceReference['kind'];
  const location = optionalString(raw, 'location', errors);
  const anchor = optionalString(raw, 'anchor', errors);
  const contentHash = optionalString(raw, 'contentHash', errors);
  const accessedAt = validateTimestampField(raw, 'accessedAt', errors, false);
  const title = optionalString(raw, 'title', errors);
  if (sourceId === undefined) return undefined;
  const source: SourceReference = {
    sourceId,
    kind: sourceKind,
    location,
    anchor,
    contentHash,
    accessedAt,
    title,
  };
  if (location === undefined && sourceKind !== 'UNKNOWN' && sourceKind !== 'TOOL_RESULT') {
    warnings.push(warn('SOURCE_LOCATION_MISSING', `source ${sourceId} has no recorded location`));
  }
  return source;
}

const KNOWN_PROVENANCE_FIELDS = new Set(['category', 'observed', 'inferred']);

function validateProvenance(
  raw: unknown,
  warnings: Diagnostic[],
  errors: Diagnostic[],
  unknownFields: string[],
): ProvenanceInfo | undefined {
  if (!isPlainObject(raw)) {
    errors.push(err('INVALID_FIELD', 'provenance must be an object'));
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_PROVENANCE_FIELDS.has(key)) unknownFields.push(`provenance.${key}`);
  }
  const category = raw['category'];
  if (typeof category !== 'string' || !PROVENANCE_CATEGORIES.includes(category as never)) {
    errors.push(
      err('INVALID_FIELD', `provenance.category must be one of ${PROVENANCE_CATEGORIES.join('|')}`),
    );
    return undefined;
  }
  const categoryValue = category as ProvenanceInfo['category'];
  let observed: ObservedLocation | undefined;
  const rawObserved = raw['observed'];
  if (rawObserved !== undefined) {
    if (!isPlainObject(rawObserved)) {
      errors.push(err('INVALID_FIELD', 'provenance.observed must be an object'));
    } else {
      observed = {
        file: optionalString(rawObserved, 'file', errors),
        recordId: optionalString(rawObserved, 'recordId', errors),
        line:
          typeof rawObserved['line'] === 'number' && Number.isInteger(rawObserved['line'])
            ? rawObserved['line']
            : undefined,
        byteOffset:
          typeof rawObserved['byteOffset'] === 'number' && Number.isInteger(rawObserved['byteOffset'])
            ? rawObserved['byteOffset']
            : undefined,
        toolCallId: optionalString(rawObserved, 'toolCallId', errors),
        toolResultId: optionalString(rawObserved, 'toolResultId', errors),
      };
      observed = Object.fromEntries(
        Object.entries(observed).filter(([, v]) => v !== undefined),
      ) as ObservedLocation;
    }
  }
  let inferred: ProvenanceInfo['inferred'] | undefined;
  const rawInferred = raw['inferred'];
  if (rawInferred !== undefined) {
    if (!isPlainObject(rawInferred)) {
      errors.push(err('INVALID_FIELD', 'provenance.inferred must be an object'));
    } else {
      const inputEventIds = optionalStringArray(rawInferred, 'inputEventIds', errors);
      const ruleId = optionalString(rawInferred, 'ruleId', errors);
      const ruleVersion = optionalString(rawInferred, 'ruleVersion', errors);
      inferred = { inputEventIds: inputEventIds ?? [], ruleId, ruleVersion };
    }
  }
  // Honesty checks: labels are kept as claimed, gaps are flagged, never filled.
  if (categoryValue === 'VIEWTRACE_OBSERVED') {
    const hasLocator =
      observed !== undefined &&
      (observed.file !== undefined ||
        observed.recordId !== undefined ||
        observed.line !== undefined ||
        observed.byteOffset !== undefined ||
        observed.toolCallId !== undefined ||
        observed.toolResultId !== undefined);
    if (!hasLocator) {
      warnings.push(
        warn(
          'OBSERVED_WITHOUT_LOCATION',
          'record claims VIEWTRACE_OBSERVED but carries no observable location; label preserved as claimed, not verified',
        ),
      );
    }
  }
  if (categoryValue === 'VIEWTRACE_INFERRED') {
    if (inferred === undefined || inferred.inputEventIds.length === 0) {
      warnings.push(
        warn(
          'INFERRED_WITHOUT_INPUTS',
          'record claims VIEWTRACE_INFERRED without input event ids; label preserved as claimed',
        ),
      );
    }
  }
  return { category: categoryValue, observed, inferred };
}

function validateRelations(
  raw: unknown,
  errors: Diagnostic[],
  unknownFields: string[],
): readonly EventRelation[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(err('INVALID_FIELD', 'relations must be an array'));
    return undefined;
  }
  const out: EventRelation[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isPlainObject(item)) {
      errors.push(err('INVALID_FIELD', `relations[${i}] must be an object`));
      continue;
    }
    for (const key of Object.keys(item)) {
      if (key !== 'type' && key !== 'targetEventId' && key !== 'targetRunId') {
        unknownFields.push(`relations[${i}].${key}`);
      }
    }
    const type = item['type'];
    if (typeof type !== 'string' || !RELATION_TYPES.includes(type as never)) {
      errors.push(err('INVALID_FIELD', `relations[${i}].type must be one of ${RELATION_TYPES.join('|')}`));
      continue;
    }
    const relationType = type as EventRelation['type'];
    const targetEventId = item['targetEventId'];
    if (typeof targetEventId !== 'string' || !isValidEventId(targetEventId)) {
      errors.push(err('INVALID_FIELD', `relations[${i}].targetEventId must be a valid event id`));
      continue;
    }
    const targetRunId = item['targetRunId'];
    if (targetRunId !== undefined && (typeof targetRunId !== 'string' || !isValidRunId(targetRunId))) {
      errors.push(err('INVALID_FIELD', `relations[${i}].targetRunId must be a valid run id`));
      continue;
    }
    out.push({ type: relationType, targetEventId, targetRunId });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Payload validation                                                  */
/* ------------------------------------------------------------------ */

function validatePayload(
  type: DomainEventType,
  raw: unknown,
  errors: Diagnostic[],
  warnings: Diagnostic[],
  unknownFields: string[],
): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) {
    errors.push(err('INVALID_FIELD', 'payload must be an object'));
    return undefined;
  }
  const known = payloadFields(type);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) unknownFields.push(`payload.${key}`);
  }
  switch (type) {
    case 'SEARCH': {
      const query = requireString(raw, 'query', 'payload.query', errors);
      const results = raw['results'];
      if (results === undefined) {
        errors.push(err('MISSING_FIELD', 'payload.results is required (may be empty)'));
      } else if (!Array.isArray(results)) {
        errors.push(err('INVALID_FIELD', 'payload.results must be an array'));
      } else {
        for (let i = 0; i < results.length; i++) {
          const item = results[i];
          if (!isPlainObject(item)) {
            errors.push(err('INVALID_FIELD', `payload.results[${i}] must be an object`));
            continue;
          }
          for (const key of Object.keys(item)) {
            if (!['sourceId', 'title', 'url', 'rank'].includes(key))
              unknownFields.push(`payload.results[${i}].${key}`);
          }
          const sid = item['sourceId'];
          if (typeof sid !== 'string' || !isValidEventId(sid)) {
            errors.push(err('INVALID_FIELD', `payload.results[${i}].sourceId must be a valid source id`));
          }
          const rank = item['rank'];
          if (rank !== undefined && (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 1)) {
            errors.push(err('INVALID_FIELD', `payload.results[${i}].rank must be a positive integer`));
          }
        }
      }
      if (query === undefined) return undefined;
      return { type, query, results: Array.isArray(results) ? results : [] };
    }
    case 'READ': {
      const sourceId = validateEventIdField(raw, 'sourceId', 'payload.sourceId', errors);
      const outcome = raw['outcome'];
      if (typeof outcome !== 'string' || !OPERATION_STATUSES.includes(outcome as never)) {
        errors.push(err('INVALID_FIELD', `payload.outcome must be one of ${OPERATION_STATUSES.join('|')}`));
      }
      const summary = optionalString(raw, 'summary', errors);
      if (sourceId === undefined) return undefined;
      return {
        type,
        sourceId,
        outcome: OPERATION_STATUSES.includes(outcome as never) ? outcome : 'UNKNOWN',
        summary,
      };
    }
    case 'CLAIM': {
      const text = requireString(raw, 'text', 'payload.text', errors);
      const rawSourceId = raw['sourceId'];
      const sourceId =
        rawSourceId === undefined ? undefined : validateEventIdField(raw, 'sourceId', 'sourceId', errors);
      const anchor = optionalString(raw, 'anchor', errors);
      if (text === undefined) return undefined;
      return { type, text, sourceId, anchor };
    }
    case 'COMPARE': {
      const candidates = optionalStringArray(raw, 'candidates', errors);
      const criteria = optionalStringArray(raw, 'criteria', errors);
      const cellsRaw = raw['cells'];
      if (candidates === undefined || candidates.length === 0) {
        errors.push(err('INVALID_FIELD', 'payload.candidates must be a non-empty string array'));
      }
      if (criteria === undefined || criteria.length === 0) {
        errors.push(err('INVALID_FIELD', 'payload.criteria must be a non-empty string array'));
      }
      const cells: Record<string, unknown>[] = [];
      if (!Array.isArray(cellsRaw)) {
        errors.push(err('INVALID_FIELD', 'payload.cells must be an array'));
      } else {
        for (let i = 0; i < cellsRaw.length; i++) {
          const cell = cellsRaw[i];
          if (!isPlainObject(cell)) {
            errors.push(err('INVALID_FIELD', `payload.cells[${i}] must be an object`));
            continue;
          }
          for (const key of Object.keys(cell)) {
            if (!['candidate', 'criterion', 'value', 'evidenceEventIds', 'sourceIds'].includes(key)) {
              unknownFields.push(`payload.cells[${i}].${key}`);
            }
          }
          const candidate = cell['candidate'];
          const criterion = cell['criterion'];
          const value = cell['value'];
          if (typeof candidate !== 'string' || candidate.length === 0) {
            errors.push(err('INVALID_FIELD', `payload.cells[${i}].candidate must be a non-empty string`));
            continue;
          }
          if (typeof criterion !== 'string' || criterion.length === 0) {
            errors.push(err('INVALID_FIELD', `payload.cells[${i}].criterion must be a non-empty string`));
            continue;
          }
          if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
            errors.push(
              err('INVALID_FIELD', `payload.cells[${i}].value must be a string, number or null (UNKNOWN)`),
            );
            continue;
          }
          if (typeof value === 'number' && !Number.isFinite(value)) {
            errors.push(err('INVALID_FIELD', `payload.cells[${i}].value must be finite`));
            continue;
          }
          const evidenceEventIds = optionalStringArray(cell, 'evidenceEventIds', errors);
          const sourceIds = optionalStringArray(cell, 'sourceIds', errors);
          if (candidates !== undefined && !candidates.includes(candidate)) {
            warnings.push(warn('CELL_TARGET_UNKNOWN', `cell references unknown candidate`));
          }
          if (criteria !== undefined && !criteria.includes(criterion)) {
            warnings.push(warn('CELL_TARGET_UNKNOWN', `cell references unknown criterion`));
          }
          cells.push({ candidate, criterion, value, evidenceEventIds, sourceIds });
        }
      }
      return { type, candidates: candidates ?? [], criteria: criteria ?? [], cells };
    }
    case 'HYPOTHESIS': {
      const text = requireString(raw, 'text', 'payload.text', errors);
      const basis = raw['basis'];
      if (
        basis !== undefined &&
        basis !== null &&
        basis !== 'PUBLIC_STATEMENT' &&
        basis !== 'LABELED_INFERENCE'
      ) {
        errors.push(err('INVALID_FIELD', 'payload.basis must be PUBLIC_STATEMENT or LABELED_INFERENCE'));
      }
      const basedOnEventIds = optionalStringArray(raw, 'basedOnEventIds', errors);
      if (text === undefined) return undefined;
      return { type, text, basis: basis ?? undefined, basedOnEventIds };
    }
    case 'CONTRADICTION': {
      const description = requireString(raw, 'description', 'payload.description', errors);
      const conflictingEventIds = optionalStringArray(raw, 'conflictingEventIds', errors);
      if (conflictingEventIds === undefined || conflictingEventIds.length === 0) {
        errors.push(err('INVALID_FIELD', 'payload.conflictingEventIds must be a non-empty string array'));
      } else if (conflictingEventIds.length < 2) {
        warnings.push(warn('CONTRADICTION_SINGLE_REF', 'contradiction references fewer than two events'));
      }
      const conditions = optionalStringArray(raw, 'conditions', errors);
      if (description === undefined) return undefined;
      return { type, description, conflictingEventIds: conflictingEventIds ?? [], conditions };
    }
    case 'VERIFY': {
      const rawTargetEventId = raw['targetEventId'];
      const targetEventId =
        rawTargetEventId === undefined
          ? undefined
          : validateEventIdField(raw, 'targetEventId', 'targetEventId', errors);
      const targetClaimText = optionalString(raw, 'targetClaimText', errors);
      const method = requireString(raw, 'method', 'payload.method', errors);
      const result = raw['result'];
      if (typeof result !== 'string' || !VERIFY_RESULTS.includes(result as never)) {
        errors.push(err('INVALID_FIELD', `payload.result must be one of ${VERIFY_RESULTS.join('|')}`));
      }
      const evidenceEventIds = optionalStringArray(raw, 'evidenceEventIds', errors);
      if (targetEventId === undefined && targetClaimText === undefined) {
        warnings.push(
          warn('VERIFY_TARGET_UNSPECIFIED', 'verify record has no target event id or claim text'),
        );
      }
      if (evidenceEventIds === undefined || evidenceEventIds.length === 0) {
        warnings.push(warn('VERIFY_WITHOUT_EVIDENCE', 'verify record lists no evidence events'));
      }
      if (method === undefined) return undefined;
      return {
        type,
        targetEventId,
        targetClaimText,
        method,
        result: VERIFY_RESULTS.includes(result as never) ? result : 'UNKNOWN',
        evidenceEventIds: evidenceEventIds ?? [],
      };
    }
    case 'RECOMMEND': {
      const choice = requireString(raw, 'choice', 'payload.choice', errors);
      const alternatives = optionalStringArray(raw, 'alternatives', errors);
      const userConditions = optionalStringArray(raw, 'userConditions', errors);
      const rationale = optionalStringArray(raw, 'rationale', errors);
      const rationaleEventIds = optionalStringArray(raw, 'rationaleEventIds', errors);
      if (choice === undefined) return undefined;
      return { type, choice, alternatives, userConditions, rationale, rationaleEventIds };
    }
  }
}

function payloadFields(type: DomainEventType): Set<string> {
  switch (type) {
    case 'SEARCH':
      return new Set(['type', 'query', 'results']);
    case 'READ':
      return new Set(['type', 'sourceId', 'outcome', 'summary']);
    case 'CLAIM':
      return new Set(['type', 'text', 'sourceId', 'anchor']);
    case 'COMPARE':
      return new Set(['type', 'candidates', 'criteria', 'cells']);
    case 'HYPOTHESIS':
      return new Set(['type', 'text', 'basis', 'basedOnEventIds']);
    case 'CONTRADICTION':
      return new Set(['type', 'description', 'conflictingEventIds', 'conditions']);
    case 'VERIFY':
      return new Set(['type', 'targetEventId', 'targetClaimText', 'method', 'result', 'evidenceEventIds']);
    case 'RECOMMEND':
      return new Set(['type', 'choice', 'alternatives', 'userConditions', 'rationale', 'rationaleEventIds']);
  }
}

/* ------------------------------------------------------------------ */
/* Record validation                                                   */
/* ------------------------------------------------------------------ */

const KNOWN_EVENT_FIELDS = new Set([
  'recordKind',
  'schemaVersion',
  'eventId',
  'runId',
  'type',
  'occurredAt',
  'sequence',
  'receivedAt',
  'adapterId',
  'adapterVersion',
  'origin',
  'source',
  'provenance',
  'payload',
  'relations',
]);
const KNOWN_RUN_FIELDS = new Set([
  'recordKind',
  'schemaVersion',
  'runId',
  'lifecycle',
  'occurredAt',
  'sequence',
  'receivedAt',
  'adapterId',
  'adapterVersion',
  'detail',
]);

export function validateRecord(rawInput: unknown): ValidationOutcome {
  const redactedFields: string[] = [];
  const raw = stripPrivateFields(rawInput, '', redactedFields);
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const unknownFields: string[] = [];

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: [err('INVALID_RECORD', 'record must be a JSON object')],
      warnings,
      redactedFields,
    };
  }

  const schemaVersion = raw['schemaVersion'];
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    errors.push(err('INVALID_SCHEMA_VERSION', 'schemaVersion must be an integer'));
  } else if (schemaVersion > SCHEMA_VERSION) {
    errors.push(
      err(
        'FUTURE_SCHEMA_VERSION',
        `schemaVersion ${schemaVersion} is newer than supported ${SCHEMA_VERSION}`,
      ),
    );
  } else if (schemaVersion !== SCHEMA_VERSION) {
    errors.push(err('UNSUPPORTED_SCHEMA_VERSION', `schemaVersion must be ${SCHEMA_VERSION}`));
  }

  const recordKind = raw['recordKind'];
  if (typeof recordKind !== 'string' || !RECORD_KINDS.includes(recordKind as never)) {
    errors.push(err('INVALID_FIELD', `recordKind must be one of ${RECORD_KINDS.join('|')}`));
    return finish(errors, warnings, unknownFields, redactedFields);
  }

  const runId = validateRunIdField(raw, 'runId', 'runId', errors);
  const occurredAt = validateTimestampField(raw, 'occurredAt', errors, true);
  const receivedAt = validateTimestampField(raw, 'receivedAt', errors, false);
  const sequence = validateSequence(raw, errors);
  const adapterId = validateEventIdField(raw, 'adapterId', 'adapterId', errors);
  const adapterVersion = requireString(raw, 'adapterVersion', 'adapterVersion', errors);

  let record: TraceRecord | undefined;
  if (recordKind === 'event') {
    for (const key of Object.keys(raw)) {
      if (!KNOWN_EVENT_FIELDS.has(key)) unknownFields.push(key);
    }
    const eventId = validateEventIdField(raw, 'eventId', 'eventId', errors);
    const type = raw['type'];
    if (typeof type !== 'string' || !DOMAIN_EVENT_TYPES.includes(type as never)) {
      errors.push(err('INVALID_FIELD', `type must be one of ${DOMAIN_EVENT_TYPES.join('|')}`));
    }
    const provenance = validateProvenance(raw['provenance'], warnings, errors, unknownFields);
    const origin = validateOrigin(raw['origin'], errors, unknownFields);
    const source = validateSource(raw['source'], errors, warnings, unknownFields);
    const relations = validateRelations(raw['relations'], errors, unknownFields);
    let payload: Record<string, unknown> | undefined;
    if (typeof type === 'string' && DOMAIN_EVENT_TYPES.includes(type as never)) {
      payload = validatePayload(type as DomainEventType, raw['payload'], errors, warnings, unknownFields);
    } else if (raw['payload'] === undefined) {
      errors.push(err('MISSING_FIELD', 'payload is required'));
    }
    if (
      eventId !== undefined &&
      runId !== undefined &&
      occurredAt !== undefined &&
      adapterId !== undefined &&
      adapterVersion !== undefined &&
      origin !== undefined &&
      source !== undefined &&
      provenance !== undefined &&
      payload !== undefined &&
      DOMAIN_EVENT_TYPES.includes(type as never)
    ) {
      const event: ViewTraceEvent = {
        recordKind: 'event',
        schemaVersion: SCHEMA_VERSION,
        eventId,
        runId,
        type: type as DomainEventType,
        occurredAt,
        sequence: sequence ?? -1,
        receivedAt: receivedAt ?? '',
        adapterId,
        adapterVersion,
        origin,
        source,
        provenance,
        payload: payload as unknown as ViewTraceEvent['payload'],
        relations: relations && relations.length > 0 ? relations : undefined,
      };
      record = event;
    }
  } else if (recordKind === 'answer') {
    record = validateAnswer(raw, errors, unknownFields, {
      runId,
      occurredAt,
      receivedAt,
      sequence,
      adapterId,
      adapterVersion,
    });
  } else {
    for (const key of Object.keys(raw)) {
      if (!KNOWN_RUN_FIELDS.has(key)) unknownFields.push(key);
    }
    const lifecycle = raw['lifecycle'];
    if (typeof lifecycle !== 'string' || !RUN_LIFECYCLES.includes(lifecycle as never)) {
      errors.push(err('INVALID_FIELD', `lifecycle must be one of ${RUN_LIFECYCLES.join('|')}`));
    }
    const detail = optionalString(raw, 'detail', errors);
    if (
      runId !== undefined &&
      occurredAt !== undefined &&
      adapterId !== undefined &&
      adapterVersion !== undefined &&
      RUN_LIFECYCLES.includes(lifecycle as never)
    ) {
      record = {
        recordKind: 'run',
        schemaVersion: SCHEMA_VERSION,
        runId,
        lifecycle: lifecycle as RunLifecycle,
        occurredAt,
        sequence: sequence ?? -1,
        receivedAt: receivedAt ?? '',
        adapterId,
        adapterVersion,
        detail,
      };
    }
  }

  if (record !== undefined && errors.length === 0) {
    const canonical = canonicalize(record);
    if (Buffer.byteLength(canonical, 'utf8') > MAX_RECORD_BYTES) {
      errors.push(err('OVERSIZED_RECORD', `record exceeds ${MAX_RECORD_BYTES} bytes when canonicalized`));
    }
  }

  return finish(errors, warnings, unknownFields, redactedFields, record);
}

function finish(
  errors: Diagnostic[],
  warnings: Diagnostic[],
  unknownFields: string[],
  redactedFields: readonly string[],
  record?: TraceRecord,
): ValidationOutcome {
  if (unknownFields.length > 0) {
    warnings.push(
      info(
        'UNKNOWN_FIELD_DROPPED',
        `dropped unknown fields: ${[...new Set(unknownFields)].sort().join(', ')}`,
      ),
    );
  }
  if (redactedFields.length > 0) {
    warnings.push(
      info(
        'REDACTED_PRIVATE_FIELD',
        `removed ${redactedFields.length} private-reasoning field(s): ${redactedFields.join(', ')}`,
      ),
    );
  }
  if (errors.length > 0 || record === undefined) {
    if (errors.length === 0) errors.push(err('INVALID_RECORD', 'record could not be normalized'));
    return { ok: false, errors, warnings, redactedFields };
  }
  return { ok: true, record, warnings, redactedFields };
}

function validateAnswer(
  raw: Record<string, unknown>,
  errors: Diagnostic[],
  unknown: string[],
  envelope: {
    runId?: string;
    occurredAt?: string;
    receivedAt?: string;
    sequence?: number;
    adapterId?: string;
    adapterVersion?: string;
  },
): TraceRecord | undefined {
  const known = new Set([
    'recordKind',
    'schemaVersion',
    'receiptVersion',
    'receiptId',
    'runId',
    'agentId',
    'agentSessionId',
    'turnId',
    'answerId',
    'answer',
    'answerHash',
    'hashVersion',
    'final',
    'timestamp',
    'occurredAt',
    'receivedAt',
    'sequence',
    'adapterId',
    'adapterVersion',
    'questionSummary',
    'eventIds',
    'sharedEventIds',
  ]);
  for (const key of Object.keys(raw)) if (!known.has(key)) unknown.push(key);
  const receiptId = validateEventIdField(raw, 'receiptId', 'receiptId', errors);
  const answerId = validateEventIdField(raw, 'answerId', 'answerId', errors);
  const agentId = validateEventIdField(raw, 'agentId', 'agentId', errors);
  const identity = (key: string): string | undefined =>
    raw[key] === undefined ? undefined : validateEventIdField(raw, key, key, errors);
  const agentSessionId = identity('agentSessionId');
  const turnId = identity('turnId');
  const answer = requireString(raw, 'answer', 'answer', errors);
  const timestamp = validateTimestampField(raw, 'timestamp', errors, true);
  const questionSummary = optionalString(raw, 'questionSummary', errors);
  if (questionSummary !== undefined && questionSummary.length > 500)
    errors.push(err('INVALID_FIELD', 'questionSummary exceeds 500 characters'));
  if (raw['receiptVersion'] !== 1) errors.push(err('INVALID_RECEIPT_VERSION', 'receiptVersion must be 1'));
  if (raw['final'] !== true)
    errors.push(err('ANSWER_NOT_FINAL', 'only finalized public answers are accepted'));
  if (raw['hashVersion'] !== undefined && raw['hashVersion'] !== ANSWER_HASH_VERSION)
    errors.push(err('INVALID_HASH_VERSION', 'unsupported answer hash policy'));
  const ids = (key: string): readonly string[] | undefined => {
    const values = optionalStringArray(raw, key, errors);
    if (
      values !== undefined &&
      (values.length > 10000 || !values.every(isValidEventId) || new Set(values).size !== values.length)
    )
      errors.push(err('INVALID_SCOPE', 'scope ids must be unique same-run event ids, at most 10000'));
    return values;
  };
  const eventIds = ids('eventIds');
  const sharedEventIds = ids('sharedEventIds');
  const own = new Set(eventIds);
  if (sharedEventIds?.some((id) => own.has(id)))
    errors.push(err('INVALID_SCOPE', 'own and shared scopes must be disjoint'));
  const hash = answer === undefined ? '' : answerHash(answer);
  if (raw['answerHash'] !== undefined && raw['answerHash'] !== hash)
    errors.push(err('ANSWER_HASH_MISMATCH', 'answer hash disagrees with sanitized finalized answer'));
  if (
    !receiptId ||
    !answerId ||
    !agentId ||
    answer === undefined ||
    !timestamp ||
    !envelope.runId ||
    !envelope.occurredAt ||
    !envelope.adapterId ||
    !envelope.adapterVersion
  )
    return undefined;
  return {
    recordKind: 'answer',
    schemaVersion: SCHEMA_VERSION,
    receiptVersion: 1,
    receiptId,
    answerId,
    agentId,
    agentSessionId,
    turnId,
    answer: normalizedAnswer(answer),
    answerHash: hash,
    hashVersion: ANSWER_HASH_VERSION,
    final: true,
    timestamp,
    questionSummary,
    eventIds,
    sharedEventIds,
    runId: envelope.runId,
    occurredAt: envelope.occurredAt,
    adapterId: envelope.adapterId,
    adapterVersion: envelope.adapterVersion,
    receivedAt: envelope.receivedAt ?? '',
    sequence: envelope.sequence ?? -1,
  };
}
