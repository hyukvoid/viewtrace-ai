/**
 * ViewTrace AI — event, provenance and storage contract (schema version 1).
 *
 * ViewTrace traces the evidence behind AI answers: what was searched, read,
 * claimed, compared, contradicted, verified and recommended — as *observable
 * records*, never reconstructed hidden chain-of-thought.
 *
 * Honesty rules encoded in these types (see docs/MILESTONES.md §3):
 *  - Provenance has three distinct layers: what the agent REPORTED, what
 *    ViewTrace OBSERVED in logs/tool output, and what ViewTrace INFERRED.
 *    A recorded layer is preserved verbatim; nothing is ever promoted to a
 *    "verified" layer it did not claim.
 *  - Missing values stay UNKNOWN. Absent searches, reads or comparisons are
 *    never synthesized.
 *  - Run lifecycle, collection completeness, operation outcome and evidence
 *    support are separate axes; success on one axis never implies another.
 *  - Private reasoning payloads are structurally excluded, not stored.
 */

/** Current contract version. Records with other versions are refused. */
export const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Domain vocabulary                                                   */
/* ------------------------------------------------------------------ */

export const DOMAIN_EVENT_TYPES = [
  'SEARCH',
  'READ',
  'CLAIM',
  'COMPARE',
  'HYPOTHESIS',
  'CONTRADICTION',
  'VERIFY',
  'RECOMMEND',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

/**
 * CLI display names. The contract vocabulary is CONTRADICTION; the terminal
 * shows the friendlier CONFLICT. No semantic difference.
 */
export const DISPLAY_NAMES: Readonly<Record<DomainEventType, string>> = {
  SEARCH: 'SEARCH',
  READ: 'READ',
  CLAIM: 'CLAIM',
  COMPARE: 'COMPARE',
  HYPOTHESIS: 'HYPOTHESIS',
  CONTRADICTION: 'CONFLICT',
  VERIFY: 'VERIFY',
  RECOMMEND: 'RECOMMEND',
};

/* ------------------------------------------------------------------ */
/* Status axes (kept strictly separate — §3.2)                         */
/* ------------------------------------------------------------------ */

/** Run lifecycle: terminal states are *observations* of termination, never
 *  proof that the answer was correct. */
export const RUN_LIFECYCLES = [
  'CREATED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'UNKNOWN',
] as const;
export type RunLifecycle = (typeof RUN_LIFECYCLES)[number];

/** Allowed lifecycle transitions. Re-asserting the current state is a no-op. */
export const RUN_TRANSITIONS: Readonly<Record<RunLifecycle, readonly RunLifecycle[]>> = {
  CREATED: ['CREATED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN'],
  RUNNING: ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN'],
  COMPLETED: ['COMPLETED'],
  FAILED: ['FAILED'],
  CANCELLED: ['CANCELLED'],
  UNKNOWN: ['CREATED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN'],
};

/** Collection completeness: input loss or collector failure is never hidden. */
export const COLLECTION_COMPLETENESS = ['COMPLETE', 'PARTIAL', 'UNKNOWN'] as const;
export type CollectionCompleteness = (typeof COLLECTION_COMPLETENESS)[number];

/** Operation outcome. A start event alone is never SUCCESS. */
export const OPERATION_STATUSES = [
  'SUCCESS',
  'FAILED',
  'PARTIAL',
  'TIMEOUT',
  'CANCELLED',
  'UNKNOWN',
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

/** Evidence support (populated by the M3 analyzer; UNKNOWN until then). */
export const EVIDENCE_SUPPORT = [
  'STRONGLY_SUPPORTED',
  'PARTIALLY_SUPPORTED',
  'INSUFFICIENT_EVIDENCE',
  'CONFLICTING_EVIDENCE',
  'UNKNOWN',
] as const;
export type EvidenceSupport = (typeof EVIDENCE_SUPPORT)[number];

/* ------------------------------------------------------------------ */
/* Provenance                                                          */
/* ------------------------------------------------------------------ */

export const PROVENANCE_CATEGORIES = [
  'AGENT_REPORTED',
  'VIEWTRACE_OBSERVED',
  'VIEWTRACE_INFERRED',
] as const;
export type ProvenanceCategory = (typeof PROVENANCE_CATEGORIES)[number];

/** Where a record was physically observed (log/tool evidence location). */
export interface ObservedLocation {
  readonly file?: string;
  readonly recordId?: string;
  readonly line?: number;
  readonly byteOffset?: number;
  readonly toolCallId?: string;
  readonly toolResultId?: string;
}

/** Every inferred record must carry its inputs and the rule that made it. */
export interface InferenceInfo {
  readonly inputEventIds: readonly string[];
  readonly ruleId?: string;
  readonly ruleVersion?: string;
}

export interface ProvenanceInfo {
  readonly category: ProvenanceCategory;
  /** Present (with at least one locator) for honest VIEWTRACE_OBSERVED records. */
  readonly observed?: ObservedLocation;
  /** Present for VIEWTRACE_INFERRED records. */
  readonly inferred?: InferenceInfo;
}

/* ------------------------------------------------------------------ */
/* Source references                                                   */
/* ------------------------------------------------------------------ */

export const SOURCE_KINDS = ['URL', 'FILE', 'TOOL_RESULT', 'DOCUMENT', 'OTHER', 'UNKNOWN'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * A pointer to where information came from, as *recorded*. ViewTrace never
 * fetches URLs and never verifies that the location still exists or ever
 * existed; a recorded hash is a claim by whoever wrote the record.
 */
export interface SourceReference {
  readonly sourceId: string;
  readonly kind: SourceKind;
  readonly location?: string;
  readonly anchor?: string;
  readonly contentHash?: string;
  readonly accessedAt?: string;
  readonly title?: string;
}

/* ------------------------------------------------------------------ */
/* Event origin                                                        */
/* ------------------------------------------------------------------ */

export interface EventOrigin {
  /** Producing pipeline, e.g. 'viewtrace-reference-jsonl'. */
  readonly producer: string;
  readonly agent?: string;
  readonly tool?: string;
  /** Original file/record location the event was derived from, if any. */
  readonly recordedFrom?: string;
}

/* ------------------------------------------------------------------ */
/* Relations                                                           */
/* ------------------------------------------------------------------ */

export const RELATION_TYPES = [
  'SUPPORTS',
  'REFUTES',
  'VERIFIES',
  'CONTRADICTS',
  'BASED_ON',
  'CITES',
  'COMPARED',
  'RESOLVES',
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export interface EventRelation {
  readonly type: RelationType;
  readonly targetEventId: string;
  /** Defaults to the same run; a different run is preserved as cross-run. */
  readonly targetRunId?: string;
}

/* ------------------------------------------------------------------ */
/* Typed payloads (§3.1)                                               */
/* ------------------------------------------------------------------ */

export interface SearchResultItem {
  readonly sourceId: string;
  readonly title?: string;
  readonly url?: string;
  readonly rank?: number;
}

/** SEARCH = the query and the observed results (possibly none). */
export interface SearchPayload {
  readonly type: 'SEARCH';
  readonly query: string;
  readonly results: readonly SearchResultItem[];
}

/** READ = a source and the actual read outcome; never a synthesized read. */
export interface ReadPayload {
  readonly type: 'READ';
  readonly sourceId: string;
  readonly outcome: OperationStatus;
  readonly summary?: string;
}

/** CLAIM = asserted text with its source/anchor (or explicit absence). */
export interface ClaimPayload {
  readonly type: 'CLAIM';
  readonly text: string;
  readonly sourceId?: string;
  readonly anchor?: string;
}

/** A comparison cell: value null means UNKNOWN; evidence links or none. */
export interface CompareCell {
  readonly candidate: string;
  readonly criterion: string;
  readonly value: string | number | null;
  readonly evidenceEventIds?: readonly string[];
  readonly sourceIds?: readonly string[];
}

/** COMPARE = candidates, criteria and per-cell evidence or UNKNOWN. */
export interface ComparePayload {
  readonly type: 'COMPARE';
  readonly candidates: readonly string[];
  readonly criteria: readonly string[];
  readonly cells: readonly CompareCell[];
}

/** HYPOTHESIS = explicit public judgement or labeled inference only. */
export interface HypothesisPayload {
  readonly type: 'HYPOTHESIS';
  readonly text: string;
  readonly basis?: 'PUBLIC_STATEMENT' | 'LABELED_INFERENCE';
  readonly basedOnEventIds?: readonly string[];
}

/** CONTRADICTION = incompatible claims/evidence under the same conditions. */
export interface ContradictionPayload {
  readonly type: 'CONTRADICTION';
  readonly description: string;
  readonly conflictingEventIds: readonly string[];
  readonly conditions?: readonly string[];
}

export const VERIFY_RESULTS = ['CONFIRMED', 'REFUTED', 'INCONCLUSIVE', 'UNKNOWN'] as const;
export type VerifyResult = (typeof VERIFY_RESULTS)[number];

/** VERIFY = what was checked, how, with which evidence, and the outcome. */
export interface VerifyPayload {
  readonly type: 'VERIFY';
  readonly targetEventId?: string;
  readonly targetClaimText?: string;
  readonly method: string;
  readonly result: VerifyResult;
  readonly evidenceEventIds: readonly string[];
}

/** RECOMMEND = choice, user conditions, rationale and its relation IDs. */
export interface RecommendationPayload {
  readonly type: 'RECOMMEND';
  readonly choice: string;
  readonly alternatives?: readonly string[];
  readonly userConditions?: readonly string[];
  readonly rationale?: readonly string[];
  readonly rationaleEventIds?: readonly string[];
}

export type DomainPayload =
  | SearchPayload
  | ReadPayload
  | ClaimPayload
  | ComparePayload
  | HypothesisPayload
  | ContradictionPayload
  | VerifyPayload
  | RecommendationPayload;

/* ------------------------------------------------------------------ */
/* Trace records (one JSONL line each)                                 */
/* ------------------------------------------------------------------ */

export const RECORD_KINDS = ['event', 'run', 'answer'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export interface ViewTraceEvent {
  readonly recordKind: 'event';
  readonly schemaVersion: number;
  readonly eventId: string;
  readonly runId: string;
  readonly type: DomainEventType;
  /** ISO 8601 with an explicit timezone offset. */
  readonly occurredAt: string;
  /** Collector reception order within the run (assigned by the collector). */
  readonly sequence: number;
  /** Collector reception time (assigned by the collector). */
  readonly receivedAt: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly origin: EventOrigin;
  readonly source: SourceReference;
  readonly provenance: ProvenanceInfo;
  readonly payload: DomainPayload;
  readonly relations?: readonly EventRelation[];
}

/** Run lifecycle observation line (separate from domain events). */
export interface RunRecordLine {
  readonly recordKind: 'run';
  readonly schemaVersion: number;
  readonly runId: string;
  readonly lifecycle: RunLifecycle;
  readonly occurredAt: string;
  readonly sequence: number;
  readonly receivedAt: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly detail?: string;
}

export type TraceRecord = ViewTraceEvent | RunRecordLine | import('./answer.js').AnswerReceipt;

/* ------------------------------------------------------------------ */
/* Diagnostics and ingest results                                      */
/* ------------------------------------------------------------------ */

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/**
 * Sanitized diagnostic. Messages must never contain raw record content or
 * secrets — only codes, paths, counts and positions.
 */
export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly lineIndex?: number;
  readonly byteOffset?: number;
  readonly eventId?: string;
  readonly runId?: string;
}

export type LossCode = 'MALFORMED_JSON' | 'INVALID_UTF8' | 'TRUNCATED_TAIL' | 'OVERSIZED_LINE';

/**
 * A stream-level loss. `definitive: true` means the line was certainly
 * malformed; `false` means it may just be an incomplete tail (the stream
 * ended without a newline before the record was complete).
 */
export interface LossRecord {
  readonly code: LossCode;
  readonly lineIndex: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly definitive: boolean;
}

export type DuplicateKind = 'IDEMPOTENT' | 'CONFLICTING';

export interface DuplicateInfo {
  readonly recordKind: RecordKind;
  readonly recordId: string;
  readonly kind: DuplicateKind;
  readonly firstSequence: number;
  readonly duplicateSequence: number;
  /** Content hash of the re-received payload (collector envelope excluded). */
  readonly payloadHash: string;
}

export interface RunState {
  readonly runId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly lifecycle: RunLifecycle;
  readonly completeness: CollectionCompleteness;
  /** Evidence support is UNKNOWN until the M3 analyzer exists. */
  readonly evidenceSupport: EvidenceSupport;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly eventCount: number;
  readonly jsonlCursor: number;
  readonly jsonlLines: number;
  readonly lifecycleHistory: readonly LifecycleTransition[];
}

export interface LifecycleTransition {
  readonly lifecycle: RunLifecycle;
  readonly at: string;
  readonly sequence: number;
  readonly observed: boolean;
}

export interface StoredRecord {
  readonly runId: string;
  readonly recordKind: RecordKind;
  readonly recordId: string;
  readonly sequence: number;
  readonly payloadHash: string;
  readonly record: TraceRecord;
}

export interface ReplayResult {
  readonly run: RunState;
  /** Accepted records in sequence order (canonical form). */
  readonly records: readonly StoredRecord[];
  readonly diagnostics: readonly Diagnostic[];
  readonly duplicates: readonly DuplicateInfo[];
}

export interface RunIngestReport {
  readonly runId: string;
  readonly lifecycle: RunLifecycle;
  readonly completeness: CollectionCompleteness;
  readonly eventsAccepted: number;
  readonly eventsRejected: number;
  readonly recordsAccepted: number;
  readonly duplicatesIdempotent: number;
  readonly duplicatesConflicting: number;
}

export interface IngestResult {
  readonly dataRoot: string;
  readonly inputBytes: number;
  readonly endedWithNewline: boolean;
  readonly runs: readonly RunIngestReport[];
  readonly losses: readonly LossRecord[];
  readonly diagnostics: readonly Diagnostic[];
}
