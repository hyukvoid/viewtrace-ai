/**
 * ViewTrace M3 derived-analysis contracts.
 *
 * These artifacts are sidecars over immutable schema-1 capture records. They
 * are not TraceRecord variants and must never be written into trace.jsonl.
 * Missing optional facts stay absent; UNKNOWN is used only where an explicit
 * judgement is required by the derived artifact.
 */

import type { CollectionCompleteness, EvidenceSupport, ProvenanceCategory, SourceKind, ViewTraceEvent } from './types.js';

export const M3_ANALYSIS_REPORT_SCHEMA = 'viewtrace.analysis-report@1' as const;
export const M3_INCREMENTAL_STATE_SCHEMA = 'viewtrace.analysis-state@1' as const;
export const M3_EVIDENCE_EXTENSION_SCHEMA = 'viewtrace.evidence-extension@1' as const;
export const M3_JEV_CHECKPOINT_SCHEMA = 'viewtrace.jev-checkpoint@2' as const;
export const M3_JEV_RESULT_SCHEMA = 'viewtrace.jev-result@2' as const;

export const M3_SUPPORTED_SCHEMAS = [
  M3_ANALYSIS_REPORT_SCHEMA,
  M3_INCREMENTAL_STATE_SCHEMA,
  M3_EVIDENCE_EXTENSION_SCHEMA,
  M3_JEV_CHECKPOINT_SCHEMA,
  M3_JEV_RESULT_SCHEMA,
] as const;

export type M3Schema = (typeof M3_SUPPORTED_SCHEMAS)[number];

export const ANALYSIS_MODES = ['EXPLAIN', 'COMPARE', 'DECIDE', 'ASSESS', 'VERIFY', 'IDEATE', 'UNKNOWN'] as const;
export type AnalysisMode = (typeof ANALYSIS_MODES)[number];

export const CONDITION_DIMENSIONS = [
  'TIME',
  'REGION',
  'SUBJECT',
  'POPULATION',
  'VERSION',
  'ENVIRONMENT',
  'USER_REQUIREMENT',
  'OTHER',
] as const;
export type ConditionDimension = (typeof CONDITION_DIMENSIONS)[number];

export const CONDITION_OPERATORS = ['EQ', 'NEQ', 'IN', 'RANGE', 'BEFORE', 'AFTER', 'AT', 'UNKNOWN'] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export interface AnalysisAnchor {
  readonly runId: string;
  readonly eventId?: string;
  readonly answerId?: string;
  readonly sourceId?: string;
}

/** Required on every analyzer-created semantic conclusion. */
export interface DerivedBasis {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly inputAnchors: readonly AnalysisAnchor[];
  /** Explicit epistemic limits; use a bounded, public explanation, never CoT. */
  readonly limitations: readonly string[];
}

export interface InputRevision {
  readonly algorithm: 'sha256-canonical-schema1-records-v1';
  readonly value: string;
  readonly recordCount: number;
}

export interface AnalyzerIdentity {
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly ruleSetVersion: string;
}

export interface Condition {
  readonly conditionId: string;
  readonly dimension: ConditionDimension;
  readonly operator: ConditionOperator;
  readonly value: string;
  readonly unit?: string;
  readonly provenance: ProvenanceCategory;
  readonly anchors: readonly AnalysisAnchor[];
  /** Mandatory exactly when provenance is VIEWTRACE_INFERRED. */
  readonly basis?: DerivedBasis;
}

export const SOURCE_ROLES = ['PRIMARY', 'OFFICIAL', 'COMMUNITY', 'SECONDARY', 'UNKNOWN'] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];

export interface SourcedRole {
  readonly role: SourceRole;
  readonly provenance: Exclude<ProvenanceCategory, 'VIEWTRACE_INFERRED'>;
  readonly anchors: readonly AnalysisAnchor[];
}

export interface EvidenceDate {
  readonly value: string;
  readonly precision: 'DAY' | 'MONTH' | 'YEAR' | 'TIMESTAMP';
  readonly provenance: Exclude<ProvenanceCategory, 'VIEWTRACE_INFERRED'>;
  readonly anchors: readonly AnalysisAnchor[];
}

export interface SourceEdition {
  readonly label: string;
  readonly identifier?: string;
  readonly provenance: Exclude<ProvenanceCategory, 'VIEWTRACE_INFERRED'>;
  readonly anchors: readonly AnalysisAnchor[];
}

export interface MeaningfulQuery {
  readonly query: string;
  readonly eventId: string;
}

export interface SourceLedgerEntry {
  readonly canonicalSourceId: string;
  readonly capturedSourceIds: readonly string[];
  readonly kind: SourceKind;
  readonly location?: string;
  readonly title?: string;
  readonly edition?: SourceEdition;
  readonly publicationDate?: EvidenceDate;
  readonly accessedDate?: EvidenceDate;
  readonly roles: readonly SourcedRole[];
  readonly queries: readonly MeaningfulQuery[];
  readonly identityStatus: 'MATCHED' | 'POSSIBLE_MIRROR' | 'SPOOF_SUSPECTED' | 'UNKNOWN';
  readonly mirrorOfCanonicalSourceId?: string;
  readonly anchors: readonly AnalysisAnchor[];
  readonly basis?: DerivedBasis;
}

export const PROVENANCE_INTEGRITY = [
  'ACCEPTED',
  'REPORTED_ONLY',
  'FORGED_OBSERVED',
  'MISSING_ANCHOR',
  'UNKNOWN',
] as const;
export type ProvenanceIntegrity = (typeof PROVENANCE_INTEGRITY)[number];

export interface EvidenceItem {
  readonly evidenceId: string;
  readonly eventId: string;
  readonly sourceId?: string;
  readonly claimedProvenance: ProvenanceCategory;
  readonly effectiveProvenance: ProvenanceCategory;
  readonly provenanceIntegrity: ProvenanceIntegrity;
  readonly conditionIds: readonly string[];
  readonly admissibility: 'ADMISSIBLE' | 'INADMISSIBLE' | 'UNKNOWN';
  /**
   * Whether the record carries actual source content usable as *direct*
   * claim support. SEARCH activity is admissible evidence that a search
   * happened, but it is ACTIVITY_ONLY: an agent-declared SUPPORTS edge to a
   * search must never ground a factual claim (§8 Rule 4 "직접적" support).
   */
  readonly grounding: 'SOURCE_CONTENT' | 'ACTIVITY_ONLY' | 'UNKNOWN';
  readonly limitations: readonly string[];
}

export interface ClaimAnalysis {
  readonly claimId: string;
  readonly text: string;
  readonly importance: 'CORE' | 'SUPPORTING' | 'UNKNOWN';
  readonly provenance: ProvenanceCategory;
  readonly anchors: readonly AnalysisAnchor[];
  readonly basis?: DerivedBasis;
  readonly conditionIds: readonly string[];
  readonly support: EvidenceSupport;
  readonly supportingEvidenceIds: readonly string[];
  readonly opposingEvidenceIds: readonly string[];
  readonly unresolvedReasonIds: readonly string[];
}

export interface AnalysisRelation {
  readonly relationId: string;
  readonly type: 'SUPPORTS' | 'REFUTES' | 'CONTRADICTS' | 'VERIFIES' | 'RESOLVES' | 'BASED_ON' | 'CITES' | 'COMPARED';
  readonly fromId: string;
  readonly toId: string;
  readonly evidenceIds: readonly string[];
  readonly conditionIds: readonly string[];
  readonly provenance: ProvenanceCategory;
  readonly basis?: DerivedBasis;
}

export interface ConflictHistoryEntry {
  readonly status: 'DETECTED' | 'POSSIBLE' | 'RESOLVED' | 'REOPENED';
  readonly inputRevision: InputRevision;
  readonly anchors: readonly AnalysisAnchor[];
  readonly basis: DerivedBasis;
}

export interface ConflictResolution {
  readonly verifyEventId: string;
  readonly targetClaimIds: readonly string[];
  readonly result: 'CONFIRMED' | 'REFUTED';
  readonly resolverEvidenceIds: readonly string[];
  readonly conditionIds: readonly string[];
}

export interface ConflictAnalysis {
  readonly conflictId: string;
  readonly status: 'DETECTED' | 'POSSIBLE' | 'RESOLVED' | 'UNKNOWN';
  readonly claimIds: readonly string[];
  readonly conditionMatch: 'SAME' | 'DIFFERENT' | 'AMBIGUOUS' | 'UNKNOWN';
  readonly history: readonly ConflictHistoryEntry[];
  readonly resolution?: ConflictResolution;
  readonly limitations: readonly string[];
}

export interface VerifyAssessment {
  readonly verifyEventId: string;
  readonly target:
    | { readonly kind: 'CLAIM'; readonly claimId: string }
    | { readonly kind: 'EVENT'; readonly eventId: string };
  readonly targetResolution: 'MATCHED' | 'MISMATCHED' | 'MISSING' | 'AMBIGUOUS';
  readonly result: 'CONFIRMED' | 'REFUTED' | 'INCONCLUSIVE' | 'UNKNOWN';
  readonly resolverEvidenceIds: readonly string[];
  readonly conditionIds: readonly string[];
  readonly correctness: 'VALID' | 'INVALID' | 'UNKNOWN';
  readonly limitations: readonly string[];
}

export interface AnswerSupportAnalysis {
  readonly status: EvidenceSupport;
  readonly collectionCompleteness: CollectionCompleteness;
  readonly coreClaimIds: readonly string[];
  readonly evaluatedClaimIds: readonly string[];
  readonly missingRequiredConditionIds: readonly string[];
  readonly unresolvedConflictIds: readonly string[];
  readonly reasonCodes: readonly (
    | 'TARGET_UNKNOWN'
    | 'PROVENANCE_UNKNOWN'
    | 'NO_ADMISSIBLE_SUPPORT'
    | 'PARTIAL_CLAIM_SUPPORT'
    | 'MISSING_REQUIRED_CONDITION'
    | 'UNRESOLVED_CORE_CONFLICT'
    | 'COLLECTION_NOT_COMPLETE'
    | 'ALL_CORE_CLAIMS_SUPPORTED'
  )[];
  readonly basis: DerivedBasis;
}

export interface ModeRevision {
  readonly revisionId: string;
  readonly phase: 'INITIAL_HYPOTHESIS' | 'OBSERVED_CONFIRMATION' | 'OBSERVED_CORRECTION' | 'EXPLICIT_OVERRIDE';
  readonly mode: AnalysisMode;
  readonly source: 'QUESTION' | 'OBSERVED_EVENTS' | 'USER_OVERRIDE';
  readonly basis: DerivedBasis;
}

export interface ModeLens {
  readonly revisions: readonly ModeRevision[];
  readonly currentRevisionId: string;
  readonly currentMode: AnalysisMode;
  readonly domain?: string;
  readonly temporal: 'NONE' | 'FRESHNESS_SENSITIVE' | 'UNKNOWN';
}

export interface ExplainProjection {
  readonly mode: 'EXPLAIN';
  readonly structureClaimIds: readonly string[];
  readonly causalClaimIds: readonly string[];
  readonly relationIds: readonly string[];
}
export interface CompareProjection {
  readonly mode: 'COMPARE';
  readonly candidates: readonly string[];
  readonly criteria: readonly string[];
  readonly cells: readonly {
    readonly candidate: string;
    readonly criterion: string;
    readonly claimIds: readonly string[];
    readonly evidenceIds: readonly string[];
    readonly conditionIds: readonly string[];
    readonly value?: string;
  }[];
}
export interface DecideProjection {
  readonly mode: 'DECIDE';
  readonly selectedCandidate?: string;
  readonly recommendationClaimIds: readonly string[];
  readonly rationaleEvidenceIds: readonly string[];
  readonly rejectedOptions: readonly {
    readonly candidate: string;
    /** Absent means no observed/reported rejection rationale exists. */
    readonly rationaleClaimIds?: readonly string[];
    readonly evidenceIds?: readonly string[];
  }[];
}
export interface AssessProjection {
  readonly mode: 'ASSESS';
  readonly feasibilityClaimIds: readonly string[];
  readonly riskClaimIds: readonly string[];
  readonly conditionIds: readonly string[];
  readonly freshness: 'CURRENT' | 'STALE' | 'UNKNOWN' | 'NOT_APPLICABLE';
}
export interface VerifyProjection {
  readonly mode: 'VERIFY';
  readonly verifyEventIds: readonly string[];
  readonly conflictIds: readonly string[];
}
export interface IdeateProjection {
  readonly mode: 'IDEATE';
  readonly branches: readonly {
    readonly branchId: string;
    readonly eventIds: readonly string[];
    readonly status: 'ACTIVE' | 'DROPPED' | 'STALLED' | 'UNKNOWN';
    readonly discardEvidenceIds?: readonly string[];
  }[];
  readonly diversityStatus: 'OBSERVED' | 'INFERRED' | 'UNKNOWN';
}
export interface UnknownProjection {
  readonly mode: 'UNKNOWN';
  readonly overviewClaimIds: readonly string[];
  readonly unresolvedReasonIds: readonly string[];
}
export type ModeProjection =
  | ExplainProjection
  | CompareProjection
  | DecideProjection
  | AssessProjection
  | VerifyProjection
  | IdeateProjection
  | UnknownProjection;

export interface TopologyNode {
  readonly nodeId: string;
  readonly kind: 'FACET' | 'QUERY_CLUSTER' | 'BRANCH' | 'ACTIVITY';
  readonly label: string;
  readonly eventIds: readonly string[];
  readonly provenance: ProvenanceCategory;
  readonly basis?: DerivedBasis;
}
export interface TopologyEdge {
  readonly edgeId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly kind: 'OBSERVED_SEQUENCE' | 'SHARED_SOURCE' | 'INFERRED_BRANCH';
  readonly eventIds: readonly string[];
  readonly basis?: DerivedBasis;
}
export interface ConcentrationMetric {
  readonly numerator: number;
  readonly denominator: number;
  readonly excluded: number;
  readonly unit: 'EVENTS' | 'OPERATIONS' | 'SOURCES';
  readonly meaning: 'OBSERVED_ACTIVITY_SHARE' | 'SOURCE_SHARE';
}
export interface ObservedDuration {
  readonly milliseconds: number;
  readonly startEventId: string;
  readonly endEventId: string;
  readonly measurement: 'CAPTURED_EVENT_TIMESTAMPS';
}
export interface TopologyAnalysis {
  readonly nodes: readonly TopologyNode[];
  readonly edges: readonly TopologyEdge[];
  readonly frontierStatus: 'OBSERVED' | 'INFERRED' | 'UNKNOWN';
  readonly currentFrontierNodeIds?: readonly string[];
  readonly activityConcentration: readonly ConcentrationMetric[];
  readonly sourceConcentration: readonly ConcentrationMetric[];
  readonly observedDuration?: ObservedDuration;
  readonly limitations: readonly string[];
}

export interface ReferenceDiagnostic {
  readonly referenceId: string;
  readonly kind: 'DANGLING' | 'LATE_RESOLVED' | 'CROSS_RUN' | 'CYCLE';
  readonly from: AnalysisAnchor;
  readonly to: AnalysisAnchor;
  readonly status: 'PENDING' | 'RESOLVED' | 'REJECTED';
}

export interface AnswerScope {
  readonly runId: string;
  readonly answerId: string;
  readonly receiptId: string;
  readonly boundary: 'EXACT' | 'PARTIAL' | 'UNKNOWN';
  readonly ownEventIds?: readonly string[];
  readonly sharedEventIds?: readonly string[];
}

export interface ReportFreshness {
  readonly status: 'CURRENT' | 'STALE';
  readonly reasons: readonly ('INPUT_REVISION_CHANGED' | 'ANALYZER_VERSION_CHANGED' | 'RULE_SET_CHANGED' | 'STATE_INVALIDATED')[];
}

export interface AnalysisReportV1 {
  readonly schema: typeof M3_ANALYSIS_REPORT_SCHEMA;
  readonly captureSchemaVersion: 1;
  readonly analyzer: AnalyzerIdentity;
  readonly inputRevision: InputRevision;
  readonly stateRevision: string;
  readonly freshness: ReportFreshness;
  readonly scope: AnswerScope;
  readonly lens: ModeLens;
  readonly projection: ModeProjection;
  readonly conditions: readonly Condition[];
  readonly sources: readonly SourceLedgerEntry[];
  readonly evidence: readonly EvidenceItem[];
  readonly claims: readonly ClaimAnalysis[];
  readonly relations: readonly AnalysisRelation[];
  readonly conflicts: readonly ConflictAnalysis[];
  readonly verifications: readonly VerifyAssessment[];
  readonly support: AnswerSupportAnalysis;
  readonly topology: TopologyAnalysis;
  readonly references: readonly ReferenceDiagnostic[];
  readonly jevResults: readonly JevResultV2[];
}

/** Optional structured enrichment; it references but never replaces a schema-1 event. */
export interface EvidenceExtensionV1 {
  readonly schema: typeof M3_EVIDENCE_EXTENSION_SCHEMA;
  readonly captureSchemaVersion: 1;
  readonly runId: string;
  readonly eventId: string;
  readonly capturedRecordDigest: string;
  readonly sourceMetadata?: {
    readonly meaningfulQuery?: string;
    readonly edition?: SourceEdition;
    readonly publicationDate?: EvidenceDate;
    readonly accessedDate?: EvidenceDate;
    readonly roles?: readonly SourcedRole[];
  };
  readonly conditions?: readonly Condition[];
  readonly provenanceAssessment?: {
    readonly claimed: ProvenanceCategory;
    readonly effective: ProvenanceCategory;
    readonly integrity: ProvenanceIntegrity;
    readonly anchors: readonly AnalysisAnchor[];
  };
}

export interface IncrementalCursor {
  readonly runId: string;
  readonly processedThroughSequence: number;
  readonly processedRecordCount: number;
}
export interface DependencyEntry {
  readonly inputId: string;
  readonly dependentIds: readonly string[];
}
export interface PendingReference {
  readonly referenceId: string;
  readonly from: AnalysisAnchor;
  readonly targetRunId: string;
  readonly targetEventId: string;
  readonly firstSeenRevision: InputRevision;
}
export interface InvalidationEntry {
  readonly cause: 'NEW_INPUT' | 'LATE_REFERENCE' | 'DELETION' | 'RULE_CHANGE' | 'ANSWER_SCOPE_CHANGE';
  readonly inputIds: readonly string[];
  readonly invalidatedIds: readonly string[];
}
/**
 * Cheap, fully determined signature of the analyzer's *inputs* (scoped event
 * extent + run completeness + analyzer identity). Stored alongside the fold
 * snapshot so a serving path can detect staleness without re-reading the
 * whole event prefix. Records are immutable and append-only in the store,
 * so (count, maxSequence, scope identity) pins the scoped input set.
 */
export interface AnalysisInputSignature {
  readonly scopeEventCount: number;
  readonly maxSequence: number;
  readonly scopeIdsHash: string;
  readonly collectionCompleteness: CollectionCompleteness;
}
/** Delta work actually performed by one analyze invocation (measured, not estimated). */
export interface AnalysisRunStats {
  readonly mode: 'INCREMENTAL_DELTA' | 'FULL_FOLD';
  readonly eventsExamined: number;
  readonly deltaEventCount: number;
  readonly claimsEvaluated: number;
  readonly claimsReusedFromCache: number;
  readonly jevCheckpointsEvaluated: number;
  readonly stateLoaded: boolean;
  readonly invalidationsRecorded: number;
}
export interface IncrementalAnalysisStateV1 {
  readonly schema: typeof M3_INCREMENTAL_STATE_SCHEMA;
  readonly captureSchemaVersion: 1;
  readonly analyzer: AnalyzerIdentity;
  readonly inputRevision: InputRevision;
  readonly stateRevision: string;
  readonly cursors: readonly IncrementalCursor[];
  readonly scopes: readonly AnswerScope[];
  readonly dependencies: readonly DependencyEntry[];
  readonly pendingReferences: readonly PendingReference[];
  readonly invalidations: readonly InvalidationEntry[];
  readonly selectedCheckpointIds: readonly string[];
  readonly completedJevResultIds: readonly string[];
  /** Event IDs already folded into `fold` (scope membership, not just sequence). */
  readonly processedEventIds?: readonly string[];
  /** Input signature the persisted fold was last consistent with. */
  readonly inputSignature?: AnalysisInputSignature;
  /** Serializable fold accumulator enabling true delta processing on resume. */
  readonly fold?: AnalysisFoldSnapshot;
  /** Last run's measured delta work (honesty: measured, never extrapolated). */
  readonly lastRunStats?: AnalysisRunStats;
}

/**
 * Serializable snapshot of the analysis fold — everything needed to continue
 * deriving from new events without re-folding the processed prefix. Field
 * semantics are internal to the analyzer; arrays preserve fold (insertion)
 * order so that resume === single-pass determinism.
 */
export interface AnalysisFoldSnapshot {
  readonly snapshotVersion: 1;
  readonly runId: string;
  readonly processedEventCount: number;
  readonly inputChain: { readonly value: string; readonly recordCount: number };
  readonly lastEvent?: { readonly eventId: string; readonly type: string; readonly occurredAt?: string; readonly sequence: number };
  readonly sources: readonly SourceAccumulatorSnapshot[];
  readonly evidence: readonly EvidenceItem[];
  readonly rawClaims: readonly RawClaimSnapshot[];
  readonly relations: readonly AnalysisRelation[];
  readonly conditions: readonly Condition[];
  readonly userRequiredConditionIds: readonly string[];
  readonly conflicts: readonly ConflictAnalysis[];
  readonly verifications: readonly VerifyAssessment[];
  readonly validVerifyTargetKeys: readonly { readonly targetKey: string; readonly verifyEventId: string }[];
  readonly pendingVerifyByTarget: readonly { readonly targetEventId: string; readonly verifyEventIds: readonly string[] }[];
  readonly verifyPayloads: readonly { readonly eventId: string; readonly targetEventId?: string; readonly targetClaimText?: string; readonly method: string; readonly result: string; readonly evidenceEventIds: readonly string[] }[];
  readonly declaredRelationsByEventId: readonly { readonly eventId: string; readonly relations: readonly { readonly targetEventId: string; readonly targetRunId?: string; readonly type: string }[] }[];
  readonly pendingReferences: readonly { readonly referenceId: string; readonly from: AnalysisAnchor; readonly targetRunId: string; readonly targetEventId: string; readonly firstSeenRevisionValue: string; readonly firstSeenRevisionCount: number }[];
  readonly pendingEvidenceRequestors: readonly { readonly targetEventId: string; readonly claimIds: readonly string[] }[];
  readonly recClaimDepsByRationaleEvent: readonly { readonly rationaleEventId: string; readonly claimIds: readonly string[] }[];
  readonly conflictsByConflictingEventId: readonly { readonly eventId: string; readonly conflictIds: readonly string[] }[];
  readonly comparePayloads: readonly { readonly eventId: string; readonly candidates: readonly string[]; readonly criteria: readonly string[]; readonly cells: readonly { readonly candidate: string; readonly criterion: string; readonly value?: string; readonly evidenceEventIds?: readonly string[] }[] }[];
  readonly recommendPayloads: readonly { readonly eventId: string; readonly choice: string; readonly alternatives?: readonly string[]; readonly rationaleEventIds?: readonly string[] }[];
  readonly rationaleEventIds: readonly string[];
  readonly pendingSourceReads: readonly string[];
  /** READ events whose source had not registered yet (re-adjudicated when it does). */
  readonly pendingReadEvents: readonly ViewTraceEvent[];
  readonly readEvidenceByCanonicalSource: readonly { readonly canonicalSourceId: string; readonly evidenceIds: readonly string[] }[];
  readonly claimDepsBySource: readonly { readonly canonicalSourceId: string; readonly claimIds: readonly string[] }[];
  readonly claimsByEventId: readonly { readonly eventId: string; readonly claimIds: readonly string[] }[];
  readonly invalidations: readonly InvalidationEntry[];
  readonly topology: TopologyFoldSnapshot;
  readonly jev: JevFoldSnapshot;
  readonly resolvedLateReferenceIds: readonly string[];
  /** Event ids in fold (sequence) order — scope membership for delta fetches. */
  readonly processedEventIds: readonly string[];
}

export interface SourceAccumulatorSnapshot {
  readonly canonicalKey: string;
  readonly canonicalSourceId: string;
  readonly capturedSourceIds: readonly string[];
  readonly kind: SourceKind;
  readonly location?: string;
  readonly normalizedLocation?: string;
  readonly title?: string;
  readonly contentHashes: readonly string[];
  readonly edition?: SourceEdition;
  readonly publicationDate?: EvidenceDate;
  readonly accessedDate?: EvidenceDate;
  readonly roles: readonly SourcedRole[];
  readonly queries: readonly MeaningfulQuery[];
  readonly anchors: readonly AnalysisAnchor[];
  readonly isSpoofSuspected: boolean;
}

/** Un-evaluated claim plus dependency linkage; evaluation is cached in place. */
export interface RawClaimSnapshot {
  readonly claimId: string;
  readonly kind: 'CLAIM' | 'COMPARE_CELL' | 'RECOMMENDATION';
  readonly eventId: string;
  readonly text: string;
  readonly provenance: ProvenanceCategory;
  readonly anchors: readonly AnalysisAnchor[];
  readonly conditionIds: readonly string[];
  /** Raw payload sourceIds; canonicalization happens at evaluation time. */
  readonly citedSourceIds: readonly string[];
  readonly cellEvidenceEventIds?: readonly string[];
  readonly rationaleEventIds?: readonly string[];
  readonly alternatives?: readonly string[];
  readonly candidate?: string;
  readonly criterion?: string;
  readonly value?: string;
  readonly evaluated?: ClaimAnalysis;
  readonly dirty: boolean;
}

export interface TopologyFoldSnapshot {
  readonly eventIndex: readonly { readonly eventId: string; readonly type: string; readonly sequence: number }[];
  readonly eventsByType: readonly { readonly type: string; readonly eventIds: readonly string[] }[];
  readonly queryClusters: readonly { readonly eventId: string; readonly query: string }[];
  readonly firstEvent?: { readonly eventId: string; readonly occurredAt: string };
  readonly lastEvent?: { readonly eventId: string; readonly occurredAt: string };
  readonly sequencePairs: readonly { readonly fromEventId: string; readonly toEventId: string; readonly fromType: string; readonly toType: string }[];
  readonly readCountsByCanonicalSource: readonly { readonly canonicalSourceId: string; readonly count: number }[];
}

export interface JevFoldSnapshot {
  readonly checkpoints: readonly JevCheckpointV2[];
  readonly results: readonly JevResultV2[];
  readonly checkpointKeys: readonly string[];
  readonly lastCheckpointSequence: number;
  readonly lastAdmissibleEvidenceSeq: number;
  readonly noGainFired: boolean;
  readonly sourceReadCounts: readonly { readonly sourceId: string; readonly count: number }[];
  readonly totalReads: number;
  readonly lowPrioritySelected: number;
  readonly highPrioritySelected: number;
}

export const JEV_TRIGGER_REASONS = [
  'NEW_BRANCH',
  'CONTRADICTION',
  'SOURCE_CONCENTRATION_THRESHOLD',
  'NO_EVIDENCE_GAIN_WINDOW',
  'PRE_RECOMMENDATION',
] as const;
export type JevTriggerReason = (typeof JEV_TRIGGER_REASONS)[number];

export interface JevCheckpointV2 {
  readonly schema: typeof M3_JEV_CHECKPOINT_SCHEMA;
  readonly checkpointId: string;
  readonly deduplicationKey: string;
  readonly selectorVersion: string;
  readonly analyzer: AnalyzerIdentity;
  readonly inputRevision: InputRevision;
  readonly scope: AnswerScope;
  readonly triggerReasons: readonly JevTriggerReason[];
  readonly delta: {
    readonly fromSequenceExclusive: number;
    readonly toSequenceInclusive: number;
    readonly eventIds: readonly string[];
    readonly evidenceIds: readonly string[];
  };
  readonly budget: {
    readonly ordinal: number;
    readonly maxCheckpoints: number;
    readonly cooldownEvents: number;
  };
}

export interface JevResultV2 {
  readonly schema: typeof M3_JEV_RESULT_SCHEMA;
  readonly resultId: string;
  readonly checkpointId: string;
  readonly inputRevision: InputRevision;
  readonly evaluator: {
    readonly provider: string;
    readonly evaluatorVersion: string;
    readonly model?: string;
  };
  readonly status: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'UNAVAILABLE' | 'REJECTED' | 'STALE';
  readonly labels?: {
    readonly evidenceGain: 'YES' | 'NO' | 'UNKNOWN';
    readonly progress: 'YES' | 'NO' | 'UNKNOWN';
    readonly rethinkNeeded: 'YES' | 'NO' | 'UNKNOWN';
  };
  readonly provenance: 'EVALUATOR_REPORTED';
  /** JEV is advisory and is never an input to evidence support. */
  readonly supportEffect: 'NONE';
  readonly limitations: readonly string[];
  readonly measurement?: {
    readonly latencyMs?: number;
    readonly tokenUsage?: { readonly input: number; readonly output: number };
    readonly basis: 'OBSERVED_PROVIDER_METADATA' | 'OBSERVED_MONOTONIC_CLOCK';
  };
}

export type M3Artifact =
  | AnalysisReportV1
  | IncrementalAnalysisStateV1
  | EvidenceExtensionV1
  | JevCheckpointV2
  | JevResultV2;

