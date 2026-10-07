/**
 * ViewTrace M3 incremental analysis fold — the delta engine core.
 *
 * The fold is the single source of analytical truth: every derived fact
 * (source ledger, evidence adjudication, claims and their dependency
 * linkage, conditions, conflicts, verifications, JEV checkpoints, topology
 * counters, reference lifecycle) is produced by applying events one at a
 * time in sequence order.
 *
 * Two execution paths share these rules:
 *  - INCREMENTAL: restore the persisted snapshot, apply only `sequence >
 *    cursor` (or not-yet-processed scope members), re-evaluate only dirty
 *    claims, then finalize.
 *  - REBUILD: fold from an empty state over the full scoped input, then
 *    finalize.
 *
 * Determinism contract (§8 완료 조건): for identical scoped input, analyzer
 * identity and run completeness, both paths produce identical reports. That
 * holds because every cached value in the snapshot is a pure function of
 * already-applied events, and every dependency change marks its claim dirty
 * for re-evaluation.
 */

import { canonicalize } from '../canonical.js';
import type {
  AnalysisAnchor,
  AnalysisFoldSnapshot,
  AnalysisMode,
  AnalysisRelation,
  AnalysisReportV1,
  AnalysisRunStats,
  AnalyzerIdentity,
  AnswerScope,
  ClaimAnalysis,
  Condition,
  ConflictAnalysis,
  EvidenceExtensionV1,
  EvidenceItem,
  InvalidationEntry,
  InputRevision,
  RawClaimSnapshot,
  ReferenceDiagnostic,
  SourceAccumulatorSnapshot,
  SourceLedgerEntry,
  TopologyFoldSnapshot,
  VerifyAssessment,
} from '../analysis-types.js';
import { M3_ANALYSIS_REPORT_SCHEMA } from '../analysis-types.js';
import type { CollectionCompleteness, ProvenanceCategory, ViewTraceEvent } from '../types.js';
import {
  adjudicateEvidenceItem,
  parseConditionDetailed,
  type ParsedCondition,
} from './claims-relations.js';
import {
  createLedgerFold,
  finalizeLedgerEntries,
  restoreLedger,
  snapshotLedger,
  type LedgerAccumulator,
  type LedgerFold,
} from './source-ledger.js';
import {
  buildConflictFromContradiction,
  buildVerifyAssessment,
} from './verification.js';
import { aggregateAnswerSupport, evaluateClaimSupport } from './support-rules.js';
import {
  buildModeLensFromProfile,
  buildProjection,
  assessTemporalFreshness,
  type ProjectionInputs,
} from './mode-lens.js';
import {
  buildTopologyFromSnapshot,
  createTopologyFold,
  restoreTopologyFold,
  type TopologyFold,
} from './topology.js';
import {
  DEFAULT_COOLDOWN_EVENTS,
  DEFAULT_MAX_CHECKPOINTS,
  DEFAULT_RESERVED_HIGH_PRIORITY,
  JEV_EVALUATOR_VERSION,
  considerJevCheckpoint,
  createJevSelectorFold,
  evaluateCheckpointGuarded,
  evaluateCheckpointLocal,
  type JevEvaluationOptions,
  type JevSelectorFold,
} from './jev-selector.js';
import { chainGenesis, chainStep, computeStateRevision, scopeIdsHash } from './incremental.js';
import { validateAnalysisReport } from './validate-m3.js';
import { M3_JEV_RESULT_SCHEMA } from '../analysis-types.js';

export interface FoldEngineOptions {
  readonly scope: AnswerScope;
  readonly analyzer: AnalyzerIdentity;
  readonly extensions?: readonly EvidenceExtensionV1[];
  readonly enableJev?: boolean;
  readonly maxJevCheckpoints?: number;
  readonly cooldownEvents?: number;
  readonly reservedHighPriority?: number;
}

interface RawClaim {
  claimId: string;
  kind: 'CLAIM' | 'COMPARE_CELL' | 'RECOMMENDATION';
  eventId: string;
  text: string;
  provenance: ProvenanceCategory;
  anchors: AnalysisAnchor[];
  conditionIds: string[];
  /** Raw payload sourceIds; canonicalization happens at evaluation time. */
  citedSourceIds: string[];
  cellEvidenceEventIds?: string[];
  rationaleEventIds?: string[];
  alternatives?: string[];
  candidate?: string;
  criterion?: string;
  value?: string;
  evaluated?: ClaimAnalysis;
  dirty: boolean;
}

interface PendingRefBuild {
  referenceId: string;
  from: AnalysisAnchor;
  targetRunId: string;
  targetEventId: string;
  firstSeenRevisionValue: string;
  firstSeenRevisionCount: number;
}

export class AnalysisFold {
  readonly runId: string;
  readonly options: FoldEngineOptions;
  ledger: LedgerFold;
  topology: TopologyFold;
  readonly jev: JevSelectorFold;

  processedEventIds: string[] = [];
  inputChainValue = chainGenesis();
  inputChainCount = 0;
  lastEvent?: { eventId: string; type: string; sequence: number };

  evidence: EvidenceItem[] = [];
  rawClaims: RawClaim[] = [];
  relations: AnalysisRelation[] = [];
  conditions: Condition[] = [];
  userRequiredConditionIds: string[] = [];
  conflicts: ConflictAnalysis[] = [];
  verifications: VerifyAssessment[] = [];
  comparePayloads: (AnalysisFoldSnapshot['comparePayloads'][number])[] = [];
  recommendPayloads: (AnalysisFoldSnapshot['recommendPayloads'][number])[] = [];
  rationaleEventIds: string[] = [];
  pendingSourceReads: string[] = [];
  pendingReadEvents: ViewTraceEvent[] = [];
  resolvedLateReferenceIds: string[] = [];
  invalidations: InvalidationEntry[] = [];

  evidenceByEventId = new Map<string, EvidenceItem>();
  conditionsMap = new Map<string, Condition>();
  claimsById = new Map<string, RawClaim>();
  claimsByEventId = new Map<string, string[]>();
  readEvidenceByCanonicalSource = new Map<string, string>();
  claimDepsBySource = new Map<string, Set<string>>();
  pendingEvidenceRequestors = new Map<string, Set<string>>();
  /** Recommendation claims depending on a rationale event id's evaluation. */
  recClaimDepsByRationaleEvent = new Map<string, Set<string>>();
  conflictsByConflictingEventId = new Map<string, string[]>();
  validVerifyTargetKeys = new Map<string, string>();
  verifyByEventId = new Map<string, VerifyAssessment>();
  verifyPayloads = new Map<
    string,
    { targetEventId?: string; targetClaimText?: string; method: string; result: string; evidenceEventIds: string[] }
  >();
  pendingVerifyByTarget = new Map<string, string[]>();
  declaredRelationsByEventId = new Map<
    string,
    { targetEventId: string; targetRunId?: string; type: string }[]
  >();
  pendingReferences = new Map<string, PendingRefBuild>();
  pendingRefsByTargetEvent = new Map<string, Set<string>>();
  processedIdSet = new Set<string>();
  extensionMap = new Map<string, EvidenceExtensionV1>();

  stats: { eventsApplied: number; claimsEvaluated: number; claimsReused: number; checkpointsEvaluated: number } = {
    eventsApplied: 0,
    claimsEvaluated: 0,
    claimsReused: 0,
    checkpointsEvaluated: 0,
  };

  private constructor(runId: string, options: FoldEngineOptions) {
    this.runId = runId;
    this.options = options;
    this.ledger = createLedgerFold();
    this.topology = createTopologyFold();
    this.jev = createJevSelectorFold();
    if (options.extensions) {
      for (const ext of options.extensions) {
        this.extensionMap.set(ext.eventId, ext);
      }
    }
  }

  static create(options: FoldEngineOptions): AnalysisFold {
    return new AnalysisFold(options.scope.runId, options);
  }

  static restore(snapshot: AnalysisFoldSnapshot, options: FoldEngineOptions): AnalysisFold {
    const fold = new AnalysisFold(snapshot.runId, options);
    fold.processedEventIds = [...snapshot.processedEventIds];
    fold.processedIdSet = new Set(snapshot.processedEventIds);
    fold.inputChainValue = snapshot.inputChain.value;
    fold.inputChainCount = snapshot.inputChain.recordCount;
    fold.lastEvent = snapshot.lastEvent ? { ...snapshot.lastEvent } : undefined;
    fold.evidence = snapshot.evidence.map((e) => ({ ...e }));
    fold.rawClaims = snapshot.rawClaims.map((c) => ({
      ...c,
      dirty: false,
      anchors: [...c.anchors],
      conditionIds: [...c.conditionIds],
      citedSourceIds: [...c.citedSourceIds],
      cellEvidenceEventIds: c.cellEvidenceEventIds ? [...c.cellEvidenceEventIds] : undefined,
      rationaleEventIds: c.rationaleEventIds ? [...c.rationaleEventIds] : undefined,
      alternatives: c.alternatives ? [...c.alternatives] : undefined,
    }));
    fold.relations = snapshot.relations.map((r) => ({ ...r }));
    fold.conditions = snapshot.conditions.map((c) => ({ ...c }));
    fold.userRequiredConditionIds = [...snapshot.userRequiredConditionIds];
    fold.conflicts = snapshot.conflicts.map((c) => ({ ...c }));
    fold.verifications = snapshot.verifications.map((v) => ({ ...v }));
    fold.comparePayloads = snapshot.comparePayloads.map((c) => ({
      ...c,
      candidates: [...c.candidates],
      criteria: [...c.criteria],
      cells: c.cells.map((x) => ({ ...x, evidenceEventIds: x.evidenceEventIds ? [...x.evidenceEventIds] : undefined })),
    }));
    fold.recommendPayloads = snapshot.recommendPayloads.map((r) => ({
      ...r,
      alternatives: r.alternatives ? [...r.alternatives] : undefined,
      rationaleEventIds: r.rationaleEventIds ? [...r.rationaleEventIds] : undefined,
    }));
    fold.rationaleEventIds = [...snapshot.rationaleEventIds];
    fold.pendingSourceReads = [...snapshot.pendingSourceReads];
    fold.pendingReadEvents = snapshot.pendingReadEvents.map((e) => ({ ...(e as ViewTraceEvent) }));
    fold.resolvedLateReferenceIds = [...snapshot.resolvedLateReferenceIds];
    fold.invalidations = snapshot.invalidations.map((i) => ({ ...i }));

    for (const s of snapshot.sources as readonly SourceAccumulatorSnapshot[]) {
      const single = restoreLedger([s]);
      const acc = single.get(s.canonicalKey);
      if (acc) fold.ledger.accs.set(s.canonicalKey, acc);
    }
    fold.topology = restoreTopologyFold(snapshot.topology as TopologyFoldSnapshot);

    fold.jev.checkpoints = snapshot.jev.checkpoints.map((c) => ({ ...c }));
    fold.jev.results = snapshot.jev.results.map((r) => ({ ...r }));
    fold.jev.checkpointKeys = new Set(snapshot.jev.checkpointKeys);
    fold.jev.lastCheckpointSequence = snapshot.jev.lastCheckpointSequence;
    fold.jev.lastAdmissibleEvidenceSeq = snapshot.jev.lastAdmissibleEvidenceSeq;
    fold.jev.noGainFired = snapshot.jev.noGainFired;
    fold.jev.sourceReadCounts = new Map(snapshot.jev.sourceReadCounts.map((s) => [s.sourceId, s.count]));
    fold.jev.totalReads = snapshot.jev.totalReads;
    fold.jev.lowPrioritySelected = snapshot.jev.lowPrioritySelected;
    fold.jev.highPrioritySelected = snapshot.jev.highPrioritySelected;

    // Rebuild derived indexes
    for (const e of fold.evidence) fold.evidenceByEventId.set(e.eventId, e);
    for (const c of fold.conditions) fold.conditionsMap.set(c.conditionId, c);
    for (const c of fold.rawClaims) {
      fold.claimsById.set(c.claimId, c);
      const list = fold.claimsByEventId.get(c.eventId) ?? [];
      list.push(c.claimId);
      fold.claimsByEventId.set(c.eventId, list);
      for (const src of c.citedSourceIds) {
        const set = fold.claimDepsBySource.get(src) ?? new Set<string>();
        set.add(c.claimId);
        fold.claimDepsBySource.set(src, set);
      }
      if (c.evaluated) fold.stats.claimsReused++;
    }
    for (const entry of snapshot.readEvidenceByCanonicalSource) {
      const first = entry.evidenceIds[0];
      if (first) fold.readEvidenceByCanonicalSource.set(entry.canonicalSourceId, first);
    }
    for (const entry of snapshot.claimDepsBySource) {
      fold.claimDepsBySource.set(entry.canonicalSourceId, new Set(entry.claimIds));
    }
    for (const entry of snapshot.claimsByEventId) {
      fold.claimsByEventId.set(entry.eventId, [...entry.claimIds]);
    }
    for (const entry of snapshot.validVerifyTargetKeys) {
      fold.validVerifyTargetKeys.set(entry.targetKey, entry.verifyEventId);
    }
    for (const entry of snapshot.verifyPayloads) {
      fold.verifyPayloads.set(entry.eventId, {
        targetEventId: entry.targetEventId,
        targetClaimText: entry.targetClaimText,
        method: entry.method,
        result: entry.result,
        evidenceEventIds: [...entry.evidenceEventIds],
      });
    }
    for (const entry of snapshot.pendingVerifyByTarget) {
      fold.pendingVerifyByTarget.set(entry.targetEventId, [...entry.verifyEventIds]);
    }
    for (const entry of snapshot.declaredRelationsByEventId) {
      fold.declaredRelationsByEventId.set(entry.eventId, entry.relations.map((r) => ({ ...r })));
    }
    for (const entry of snapshot.pendingReferences) {
      fold.pendingReferences.set(entry.referenceId, { ...entry });
      const set = fold.pendingRefsByTargetEvent.get(entry.targetEventId) ?? new Set<string>();
      set.add(entry.referenceId);
      fold.pendingRefsByTargetEvent.set(entry.targetEventId, set);
    }
    for (const entry of snapshot.pendingEvidenceRequestors) {
      fold.pendingEvidenceRequestors.set(entry.targetEventId, new Set(entry.claimIds));
    }
    for (const entry of snapshot.recClaimDepsByRationaleEvent) {
      fold.recClaimDepsByRationaleEvent.set(entry.rationaleEventId, new Set(entry.claimIds));
    }
    for (const entry of snapshot.conflictsByConflictingEventId) {
      fold.conflictsByConflictingEventId.set(entry.eventId, [...entry.conflictIds]);
    }
    return fold;
  }

  get cursor(): number {
    return this.lastEvent?.sequence ?? 0;
  }

  private canonicalForSource(sourceId: string): string {
    for (const acc of this.ledger.accs.values()) {
      if (acc.capturedSourceIds.has(sourceId)) return acc.canonicalSourceId;
    }
    return sourceId.startsWith('src-') ? sourceId : `src-${sourceId}`;
  }

  private accumulatorForCanonical(canonicalId: string): LedgerAccumulator | undefined {
    for (const acc of this.ledger.accs.values()) {
      if (acc.canonicalSourceId === canonicalId) return acc;
    }
    return undefined;
  }

  private resolveCanonicalSource(ev: ViewTraceEvent): { canonicalId?: string; entry?: SourceLedgerEntry } {
    let sourceId: string | undefined;
    if (ev.source?.sourceId) {
      sourceId = this.canonicalForSource(ev.source.sourceId);
    } else if (ev.type === 'READ') {
      const rp = ev.payload as { sourceId?: string };
      sourceId = rp.sourceId ? this.canonicalForSource(rp.sourceId) : undefined;
    }
    if (!sourceId) return {};
    const acc = this.accumulatorForCanonical(sourceId);
    if (!acc) return { canonicalId: sourceId };
    const entry: SourceLedgerEntry = {
      canonicalSourceId: acc.canonicalSourceId,
      capturedSourceIds: Array.from(acc.capturedSourceIds),
      kind: acc.kind,
      location: acc.location,
      title: acc.title,
      edition: acc.edition,
      publicationDate: acc.publicationDate,
      accessedDate: acc.accessedDate,
      roles: Array.from(acc.roles.values()),
      queries: Array.from(acc.queries.values()),
      identityStatus: acc.isSpoofSuspected ? 'SPOOF_SUSPECTED' : 'MATCHED',
      anchors: acc.anchors,
    };
    return { canonicalId: sourceId, entry };
  }

  private registerCondition(parsed: ParsedCondition): string {
    if (!this.conditionsMap.has(parsed.condition.conditionId)) {
      this.conditions.push(parsed.condition);
      this.conditionsMap.set(parsed.condition.conditionId, parsed.condition);
    }
    return parsed.condition.conditionId;
  }

  private markDirty(claimId: string): void {
    const claim = this.claimsById.get(claimId);
    if (claim) claim.dirty = true;
  }

  private markDependentsOfSource(canonicalSourceId: string): void {
    const deps = this.claimDepsBySource.get(canonicalSourceId);
    if (deps) for (const id of deps) this.markDirty(id);
  }

  /** Applies one event. Events MUST be applied in ascending sequence order. */
  applyEvent(ev: ViewTraceEvent): void {
    // Chain input revision (deterministic in both execution paths).
    this.inputChainValue = chainStep(this.inputChainValue, canonicalize(ev));
    this.inputChainCount++;
    const revisionAtEvent: InputRevision = {
      algorithm: 'sha256-canonical-schema1-records-v1',
      value: this.inputChainValue,
      recordCount: this.inputChainCount,
    };

    // Late reference resolution: pending relations targeting this event resolve now.
    const knownBefore = this.processedIdSet;
    const pendingRefIds = this.pendingRefsByTargetEvent.get(ev.eventId);
    if (pendingRefIds && pendingRefIds.size > 0) {
      for (const refId of Array.from(pendingRefIds)) {
        const ref = this.pendingReferences.get(refId);
        if (ref && ref.targetRunId === ev.runId) {
          this.resolvedLateReferenceIds.push(refId);
          this.pendingReferences.delete(refId);
          pendingRefIds.delete(refId);
          this.invalidations.push({
            cause: 'LATE_REFERENCE',
            inputIds: [ev.eventId],
            invalidatedIds: [ref.from.eventId ?? ''],
          });
          const requestors = this.pendingEvidenceRequestors.get(ev.eventId);
          if (requestors) {
            for (const claimId of requestors) this.markDirty(claimId);
          }
        }
      }
    }

    // Source ledger fold first so evidence adjudication can resolve sources.
    const ext = this.extensionMap.get(ev.eventId);
    this.ledger.apply(ev, ext);

    // Evidence item
    let item = adjudicateEvidenceItem(ev, (e) => this.resolveCanonicalSource(e));
    if (ext?.conditions && ext.conditions.length > 0) {
      const extIds = ext.conditions.map((c) => {
        if (!this.conditionsMap.has(c.conditionId)) {
          this.conditions.push(c);
          this.conditionsMap.set(c.conditionId, c);
        }
        return c.conditionId;
      });
      item = { ...item, conditionIds: [...item.conditionIds, ...extIds] };
    }
    if (ev.type === 'READ' && item.grounding === 'UNKNOWN') {
      this.pendingSourceReads.push(ev.eventId);
      this.pendingReadEvents.push(ev);
    }
    this.evidence.push(item);
    this.evidenceByEventId.set(ev.eventId, item);

    // Register CONTRADICTION payload conditions as Condition objects
    if (ev.type === 'CONTRADICTION') {
      const cp = ev.payload as { conditions?: readonly string[] };
      for (const raw of cp.conditions ?? []) {
        this.registerCondition(
          parseConditionDetailed(raw, { runId: ev.runId, eventId: ev.eventId }, ev.provenance.category),
        );
      }
    }

    // Type-specific derivation
    this.applyTypedEvent(ev, item, revisionAtEvent, knownBefore);

    // Topology
    this.topology.addEvent(ev, ev.type === 'READ' ? item.sourceId : undefined);

    // JEV consideration (needs this event's evidence item + previous event)
    if (this.options.enableJev !== false) {
      considerJevCheckpoint(this.jev, {
        event: ev,
        previousEvent: this.lastEvent
          ? { eventId: this.lastEvent.eventId, sequence: this.lastEvent.sequence }
          : undefined,
        evidenceForEvent: item,
        scope: this.options.scope,
        analyzer: this.options.analyzer,
        revisionAtEvent,
        maxCheckpoints: this.options.maxJevCheckpoints ?? DEFAULT_MAX_CHECKPOINTS,
        cooldownEvents: this.options.cooldownEvents ?? DEFAULT_COOLDOWN_EVENTS,
        reservedHighPriority: this.options.reservedHighPriority ?? DEFAULT_RESERVED_HIGH_PRIORITY,
      });
    }

    // Track declared relations for diagnostics + cycles
    if (ev.relations) {
      this.declaredRelationsByEventId.set(
        ev.eventId,
        ev.relations.map((r) => ({ targetEventId: r.targetEventId, targetRunId: r.targetRunId, type: r.type })),
      );
      for (const r of ev.relations) {
        this.relations.push({
          relationId: `rel-${ev.eventId}-${r.targetEventId}-${r.type.toLowerCase()}`,
          type: r.type,
          fromId: ev.eventId,
          toId: r.targetEventId,
          evidenceIds: [`ev-${ev.eventId}`],
          conditionIds: [],
          provenance: ev.provenance.category,
        });
        const isCrossRun = !!r.targetRunId && r.targetRunId !== ev.runId;
        if (!isCrossRun && !knownBefore.has(r.targetEventId) && r.targetEventId !== ev.eventId) {
          const refId = `pend-${ev.eventId}-${r.targetEventId}`;
          if (!this.pendingReferences.has(refId)) {
            this.pendingReferences.set(refId, {
              referenceId: refId,
              from: { runId: ev.runId, eventId: ev.eventId },
              targetRunId: r.targetRunId ?? ev.runId,
              targetEventId: r.targetEventId,
              firstSeenRevisionValue: revisionAtEvent.value,
              firstSeenRevisionCount: revisionAtEvent.recordCount,
            });
            const set = this.pendingRefsByTargetEvent.get(r.targetEventId) ?? new Set<string>();
            set.add(refId);
            this.pendingRefsByTargetEvent.set(r.targetEventId, set);
          }
        }
      }
    }

    // A late-arriving event may resolve pending VERIFY targets.
    if (this.pendingVerifyByTarget.has(ev.eventId)) {
      const verifyIds = this.pendingVerifyByTarget.get(ev.eventId)!;
      this.pendingVerifyByTarget.delete(ev.eventId);
      for (const vid of verifyIds) {
        this.reassessVerification(vid, revisionAtEvent);
      }
    }

    this.processedEventIds.push(ev.eventId);
    this.processedIdSet.add(ev.eventId);
    this.lastEvent = { eventId: ev.eventId, type: ev.type, sequence: ev.sequence };
    this.stats.eventsApplied++;
  }

  private applyTypedEvent(
    ev: ViewTraceEvent,
    item: EvidenceItem,
    revisionAtEvent: InputRevision,
    knownBefore: ReadonlySet<string>,
  ): void {
    const anchor: AnalysisAnchor = { runId: ev.runId, eventId: ev.eventId };

    if (ev.type === 'READ') {
      const canonical = item.sourceId;
      if (canonical && item.grounding === 'SOURCE_CONTENT') {
        if (!this.readEvidenceByCanonicalSource.has(canonical)) {
          this.readEvidenceByCanonicalSource.set(canonical, item.evidenceId);
        }
      }
      // Dependency invalidation is keyed by the raw sourceIds the claim
      // cited (canonicalization happens at evaluation time).
      const rawIds = new Set<string>();
      if (ev.source?.sourceId) rawIds.add(ev.source.sourceId);
      const rp = ev.payload as { sourceId?: string };
      if (rp.sourceId) rawIds.add(rp.sourceId);
      for (const rawId of rawIds) this.markDependentsOfSource(rawId);
      if (canonical) this.markDependentsOfSource(canonical);
      // A late-arriving source may resolve pending reads; re-adjudicate them.
      this.retryPendingSourceReads();
    }

    if (ev.type === 'CLAIM') {
      const cp = ev.payload as { text: string; sourceId?: string };
      const claimId = `claim-${ev.eventId}`;
      const ext = this.extensionMap.get(ev.eventId);
      const conditionIds: string[] = [];
      for (const c of ext?.conditions ?? []) {
        if (!this.conditionsMap.has(c.conditionId)) {
          this.conditions.push(c);
          this.conditionsMap.set(c.conditionId, c);
        }
        conditionIds.push(c.conditionId);
      }
      const raw: RawClaim = {
        claimId,
        kind: 'CLAIM',
        eventId: ev.eventId,
        text: cp.text,
        provenance: ev.provenance.category,
        anchors: [anchor],
        conditionIds,
        citedSourceIds: cp.sourceId ? [cp.sourceId] : [],
        dirty: true,
      };
      this.rawClaims.push(raw);
      this.claimsById.set(claimId, raw);
      const list = this.claimsByEventId.get(ev.eventId) ?? [];
      list.push(claimId);
      this.claimsByEventId.set(ev.eventId, list);
      if (cp.sourceId) {
        const set = this.claimDepsBySource.get(cp.sourceId) ?? new Set<string>();
        set.add(claimId);
        this.claimDepsBySource.set(cp.sourceId, set);
        const canonical = this.canonicalForSource(cp.sourceId);
        this.relations.push({
          relationId: `rel-${claimId}-${canonical}-cites`,
          type: 'CITES',
          fromId: claimId,
          toId: canonical,
          evidenceIds: [],
          conditionIds,
          provenance: ev.provenance.category,
        });
      }
      // Attach to existing conflicts that reference this event (late claim).
      const conflictIds = this.conflictsByConflictingEventId.get(ev.eventId);
      if (conflictIds) {
        for (let i = 0; i < this.conflicts.length; i++) {
          const cf = this.conflicts[i]!;
          if (conflictIds.includes(cf.conflictId) && !cf.claimIds.includes(claimId)) {
            this.conflicts[i] = { ...cf, claimIds: [...cf.claimIds, claimId] };
            raw.dirty = true;
          }
        }
      }
    } else if (ev.type === 'COMPARE') {
      const cp = ev.payload as {
        candidates: readonly string[];
        criteria: readonly string[];
        cells: readonly {
          candidate: string;
          criterion: string;
          value?: string | number | null;
          evidenceEventIds?: readonly string[];
        }[];
      };
      this.comparePayloads.push({
        eventId: ev.eventId,
        candidates: cp.candidates,
        criteria: cp.criteria,
        cells: cp.cells.map((cell) => ({
          candidate: cell.candidate,
          criterion: cell.criterion,
          value: cell.value !== null && cell.value !== undefined ? String(cell.value) : undefined,
          evidenceEventIds: cell.evidenceEventIds,
        })),
      });
      for (const cell of cp.cells) {
        if (cell.value === null || cell.value === undefined) continue;
        const claimId = `claim-${ev.eventId}-${cell.candidate}-${cell.criterion}`;
        const raw: RawClaim = {
          claimId,
          kind: 'COMPARE_CELL',
          eventId: ev.eventId,
          text: `${cell.candidate} [${cell.criterion}]: ${cell.value}`,
          provenance: ev.provenance.category,
          anchors: [anchor],
          conditionIds: [],
          citedSourceIds: [],
          cellEvidenceEventIds: [...(cell.evidenceEventIds ?? [])],
          candidate: cell.candidate,
          criterion: cell.criterion,
          value: String(cell.value),
          dirty: true,
        };
        this.rawClaims.push(raw);
        this.claimsById.set(claimId, raw);
        const list = this.claimsByEventId.get(ev.eventId) ?? [];
        list.push(claimId);
        this.claimsByEventId.set(ev.eventId, list);
        for (const eid of cell.evidenceEventIds ?? []) {
          if (!knownBefore.has(eid)) {
            const set = this.pendingEvidenceRequestors.get(eid) ?? new Set<string>();
            set.add(claimId);
            this.pendingEvidenceRequestors.set(eid, set);
          }
        }
      }
    } else if (ev.type === 'RECOMMEND') {
      const rp = ev.payload as {
        choice: string;
        alternatives?: readonly string[];
        userConditions?: readonly string[];
        rationaleEventIds?: readonly string[];
      };
      this.recommendPayloads.push({
        eventId: ev.eventId,
        choice: rp.choice,
        alternatives: rp.alternatives,
        rationaleEventIds: rp.rationaleEventIds,
      });
      const claimId = `claim-${ev.eventId}-recommendation`;
      for (const eid of rp.rationaleEventIds ?? []) {
        if (!this.rationaleEventIds.includes(eid)) this.rationaleEventIds.push(eid);
        const set = this.recClaimDepsByRationaleEvent.get(eid) ?? new Set<string>();
        set.add(claimId);
        this.recClaimDepsByRationaleEvent.set(eid, set);
        if (!knownBefore.has(eid)) {
          const reqSet = this.pendingEvidenceRequestors.get(eid) ?? new Set<string>();
          reqSet.add(claimId);
          this.pendingEvidenceRequestors.set(eid, reqSet);
        }
      }
      const userCondIds: string[] = [];
      for (const rawCond of rp.userConditions ?? []) {
        const id = this.registerCondition(
          parseConditionDetailed(rawCond, anchor, ev.provenance.category),
        );
        userCondIds.push(id);
        if (!this.userRequiredConditionIds.includes(id)) this.userRequiredConditionIds.push(id);
      }
      const raw: RawClaim = {
        claimId,
        kind: 'RECOMMENDATION',
        eventId: ev.eventId,
        text: `Recommended: ${rp.choice}`,
        provenance: ev.provenance.category,
        anchors: [anchor],
        conditionIds: userCondIds,
        citedSourceIds: [],
        rationaleEventIds: [...(rp.rationaleEventIds ?? [])],
        alternatives: rp.alternatives ? [...rp.alternatives] : undefined,
        dirty: true,
      };
      this.rawClaims.push(raw);
      this.claimsById.set(claimId, raw);
      const list = this.claimsByEventId.get(ev.eventId) ?? [];
      list.push(claimId);
      this.claimsByEventId.set(ev.eventId, list);
      // Importance is a function of rationale membership and the presence of
      // recommendations — recompute every claim.
      for (const c of this.rawClaims) c.dirty = true;
    } else if (ev.type === 'CONTRADICTION') {
      const conflict = buildConflictFromContradiction(
        ev,
        (eventId) => this.claimsByEventId.get(eventId) ?? [],
        this.validVerifyTargetKeysProxy(),
        revisionAtEvent,
      );
      this.conflicts.push(conflict);
      const cp = ev.payload as { conflictingEventIds?: readonly string[] };
      for (const ceid of cp.conflictingEventIds ?? []) {
        const list = this.conflictsByConflictingEventId.get(ceid) ?? [];
        list.push(conflict.conflictId);
        this.conflictsByConflictingEventId.set(ceid, list);
        for (const cid of this.claimsByEventId.get(ceid) ?? []) this.markDirty(cid);
      }
    } else if (ev.type === 'VERIFY') {
      this.applyVerifyEvent(ev, revisionAtEvent);
    }
  }

  private validVerifyTargetKeysProxy(): Map<string, VerifyAssessment> {
    const map = new Map<string, VerifyAssessment>();
    for (const [targetKey, verifyEventId] of this.validVerifyTargetKeys) {
      const assessment = this.verifyByEventId.get(verifyEventId);
      if (assessment) map.set(targetKey, assessment);
    }
    return map;
  }

  private claimStubs(): ClaimAnalysis[] {
    return this.rawClaims.map((c) => ({
      claimId: c.claimId,
      text: c.text,
      importance: 'SUPPORTING',
      provenance: c.provenance,
      anchors: c.anchors,
      conditionIds: c.conditionIds,
      support: 'UNKNOWN',
      supportingEvidenceIds: [],
      opposingEvidenceIds: [],
      unresolvedReasonIds: [],
    }));
  }

  private applyVerifyEvent(ev: ViewTraceEvent, revisionAtEvent: InputRevision): void {
    const known = new Set(this.processedEventIds);
    const evidenceMap = new Map<string, EvidenceItem>();
    for (const e of this.evidence) {
      evidenceMap.set(e.eventId, e);
      evidenceMap.set(e.evidenceId, e);
    }
    const vp = ev.payload as {
      targetEventId?: string;
      targetClaimText?: string;
      method: string;
      result: string;
      evidenceEventIds: readonly string[];
    };
    this.verifyPayloads.set(ev.eventId, {
      targetEventId: vp.targetEventId,
      targetClaimText: vp.targetClaimText,
      method: vp.method,
      result: vp.result,
      evidenceEventIds: [...(vp.evidenceEventIds ?? [])],
    });
    const assessment = buildVerifyAssessment(ev, known, this.claimStubs(), evidenceMap);
    this.verifications.push(assessment);
    this.verifyByEventId.set(ev.eventId, assessment);

    const targetKey =
      assessment.target.kind === 'EVENT' ? assessment.target.eventId : assessment.target.claimId;

    if (assessment.targetResolution === 'MATCHED' && assessment.correctness === 'VALID') {
      this.validVerifyTargetKeys.set(targetKey, ev.eventId);
      // A VALID verification resolves any open conflict on its target.
      this.resolveConflictsForTarget(targetKey, revisionAtEvent);
    } else if (assessment.targetResolution === 'MISSING' && vp.targetEventId) {
      const list = this.pendingVerifyByTarget.get(vp.targetEventId) ?? [];
      list.push(ev.eventId);
      this.pendingVerifyByTarget.set(vp.targetEventId, list);
    }
  }

  /** Re-runs a deferred verification whose target has now arrived. */
  private reassessVerification(verifyEventId: string, revisionAtEvent: InputRevision): void {
    const meta = this.verifyPayloads.get(verifyEventId);
    if (!meta) return;
    const stub: ViewTraceEvent = {
      recordKind: 'event',
      schemaVersion: 1,
      eventId: verifyEventId,
      runId: this.runId,
      type: 'VERIFY',
      occurredAt: '1970-01-01T00:00:00Z',
      sequence: 0,
      receivedAt: '1970-01-01T00:00:00Z',
      adapterId: '',
      adapterVersion: '',
      origin: { producer: 'viewtrace-analyzer-reassessment' },
      source: { sourceId: '', kind: 'UNKNOWN' },
      provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'reassess' } },
      payload: {
        type: 'VERIFY',
        targetEventId: meta.targetEventId,
        targetClaimText: meta.targetClaimText,
        method: meta.method,
        result: meta.result as never,
        evidenceEventIds: meta.evidenceEventIds,
      },
    };
    const evidenceMap = new Map<string, EvidenceItem>();
    for (const e of this.evidence) {
      evidenceMap.set(e.eventId, e);
      evidenceMap.set(e.evidenceId, e);
    }
    const assessment = buildVerifyAssessment(stub, this.processedIdSet, this.claimStubs(), evidenceMap);
    const idx = this.verifications.findIndex((v) => v.verifyEventId === verifyEventId);
    if (idx >= 0) this.verifications[idx] = assessment;
    this.verifyByEventId.set(verifyEventId, assessment);

    const targetKey =
      assessment.target.kind === 'EVENT' ? assessment.target.eventId : assessment.target.claimId;
    if (assessment.targetResolution === 'MATCHED' && assessment.correctness === 'VALID') {
      this.validVerifyTargetKeys.set(targetKey, verifyEventId);
      this.resolveConflictsForTarget(targetKey, revisionAtEvent);
    }
  }

  /** Re-adjudicates READ events whose source registered after the read. */
  private retryPendingSourceReads(): void {
    if (this.pendingReadEvents.length === 0) return;
    const still: ViewTraceEvent[] = [];
    for (const readEv of this.pendingReadEvents) {
      const resolved = this.resolveCanonicalSource(readEv);
      if (!resolved.entry) {
        still.push(readEv);
        continue;
      }
      const reAdjudicated = adjudicateEvidenceItem(readEv, () => resolved);
      const idx = this.evidence.findIndex((e) => e.eventId === readEv.eventId);
      if (idx >= 0) this.evidence[idx] = reAdjudicated;
      this.evidenceByEventId.set(readEv.eventId, reAdjudicated);
      this.invalidations.push({
        cause: 'LATE_REFERENCE',
        inputIds: [readEv.eventId],
        invalidatedIds: [`ev-${readEv.eventId}`],
      });
      if (reAdjudicated.grounding === 'SOURCE_CONTENT' && reAdjudicated.sourceId) {
        const canonical = reAdjudicated.sourceId;
        if (!this.readEvidenceByCanonicalSource.has(canonical)) {
          this.readEvidenceByCanonicalSource.set(canonical, reAdjudicated.evidenceId);
        }
        const rp = readEv.payload as { sourceId?: string };
        for (const rawId of [readEv.source?.sourceId, rp.sourceId, canonical]) {
          if (rawId) this.markDependentsOfSource(rawId);
        }
      }
    }
    this.pendingReadEvents = still;
    this.pendingSourceReads = still.map((e) => e.eventId);
  }

  private resolveConflictsForTarget(targetKey: string, revisionAtEvent: InputRevision): void {
    const conflictIds = this.conflictsByConflictingEventId.get(targetKey) ?? [];
    for (let i = 0; i < this.conflicts.length; i++) {
      const cf = this.conflicts[i]!;
      if (!conflictIds.includes(cf.conflictId)) continue;
      if (cf.status === 'RESOLVED') continue;
      const resolver = this.verifyByEventId.get(this.validVerifyTargetKeys.get(targetKey) ?? '');
      if (!resolver) continue;
      const resolution = {
        verifyEventId: resolver.verifyEventId,
        targetClaimIds: [...cf.claimIds],
        result: (resolver.result === 'REFUTED' ? 'REFUTED' : 'CONFIRMED') as 'REFUTED' | 'CONFIRMED',
        resolverEvidenceIds: [...resolver.resolverEvidenceIds],
        conditionIds: [...resolver.conditionIds],
      };
      const historyEntry = {
        status: 'RESOLVED' as const,
        inputRevision: revisionAtEvent,
        anchors: [{ runId: this.runId, eventId: resolver.verifyEventId }],
        basis: {
          ruleId: 'contradiction-resolution-v1',
          ruleVersion: '1.0.0',
          inputAnchors: [{ runId: this.runId, eventId: resolver.verifyEventId }],
          limitations: ['Resolved by explicit VERIFY event with admissible source-content resolver evidence.'],
        },
      };
      this.conflicts[i] = {
        ...cf,
        status: 'RESOLVED',
        resolution,
        history: [...cf.history, historyEntry],
      };
      for (const cid of cf.claimIds) this.markDirty(cid);
    }
  }

  /** Evaluates all dirty claims (dependency order: sources/cells, then recommendations). */
  evaluateDirtyClaims(): void {
    const evidenceMap = new Map<string, EvidenceItem>();
    for (const e of this.evidence) {
      evidenceMap.set(e.evidenceId, e);
      evidenceMap.set(e.eventId, e);
    }

    // Propagate dirtiness to recommendation claims whose rationale claims
    // must be re-evaluated (their support is derived from rationale support).
    for (const raw of this.rawClaims) {
      if (!raw.dirty || raw.kind === 'RECOMMENDATION') continue;
      const deps = this.recClaimDepsByRationaleEvent.get(raw.eventId);
      if (deps) for (const claimId of deps) this.markDirty(claimId);
    }

    const evaluateOne = (raw: RawClaim): void => {
      const supporting: string[] = [];
      const opposing: string[] = [];

      if (raw.kind === 'CLAIM') {
        for (const rawSourceId of raw.citedSourceIds) {
          const canonical = this.canonicalForSource(rawSourceId);
          if (!canonical) continue;
          const first = this.readEvidenceByCanonicalSource.get(canonical);
          if (first && !supporting.includes(first)) supporting.push(first);
        }
        const rels = this.declaredRelationsByEventId.get(raw.eventId) ?? [];
        for (const r of rels) {
          const target = this.evidenceByEventId.get(r.targetEventId);
          if (!target) continue;
          if (
            r.type === 'SUPPORTS' &&
            target.admissibility === 'ADMISSIBLE' &&
            target.grounding === 'SOURCE_CONTENT' &&
            !supporting.includes(target.evidenceId)
          ) {
            supporting.push(target.evidenceId);
          } else if (
            r.type === 'CONTRADICTS' &&
            target.admissibility === 'ADMISSIBLE' &&
            !opposing.includes(target.evidenceId)
          ) {
            opposing.push(target.evidenceId);
          }
        }
      } else if (raw.kind === 'COMPARE_CELL') {
        const seenCanonicals = new Set<string>();
        for (const eid of raw.cellEvidenceEventIds ?? []) {
          const target = this.evidenceByEventId.get(eid);
          if (!target || target.admissibility !== 'ADMISSIBLE' || target.grounding !== 'SOURCE_CONTENT') continue;
          const canonical = target.sourceId;
          if (canonical) {
            if (seenCanonicals.has(canonical)) continue; // re-read dedup
            seenCanonicals.add(canonical);
          }
          supporting.push(target.evidenceId);
        }
      } else if (raw.kind === 'RECOMMENDATION') {
        for (const eid of raw.rationaleEventIds ?? []) {
          const target = this.evidenceByEventId.get(eid);
          if (
            target &&
            target.admissibility === 'ADMISSIBLE' &&
            target.grounding === 'SOURCE_CONTENT' &&
            !supporting.includes(target.evidenceId)
          ) {
            supporting.push(target.evidenceId);
          }
          for (const cid of this.claimsByEventId.get(eid) ?? []) {
            const dep = this.claimsById.get(cid);
            if (dep?.evaluated) {
              for (const sid of dep.evaluated.supportingEvidenceIds) {
                if (!supporting.includes(sid)) supporting.push(sid);
              }
            }
          }
        }
      }

      const isCore = this.rationaleEventIds.includes(raw.eventId) || this.recommendPayloads.length === 0;

      const draft: ClaimAnalysis = {
        claimId: raw.claimId,
        text: raw.text,
        importance: isCore ? 'CORE' : 'SUPPORTING',
        provenance: raw.provenance,
        anchors: raw.anchors,
        conditionIds: [...raw.conditionIds],
        support: 'UNKNOWN',
        supportingEvidenceIds: supporting,
        opposingEvidenceIds: opposing,
        unresolvedReasonIds: [],
        basis: {
          ruleId:
            raw.kind === 'CLAIM'
              ? 'claim-extraction-v1'
              : `claim-extraction-${raw.kind.toLowerCase().replace('_', '-')}-v1`,
          ruleVersion: '1.0.0',
          inputAnchors: raw.anchors,
          limitations:
            raw.kind === 'COMPARE_CELL'
              ? ['Extracted from schema-1 COMPARE cell; value is the recorded observation.']
              : raw.kind === 'RECOMMENDATION'
                ? ['Extracted from schema-1 RECOMMEND event payload.']
                : ['Extracted from schema-1 CLAIM event payload.'],
        },
      };

      raw.evaluated = evaluateClaimSupport(draft, evidenceMap, this.conflicts);
      raw.dirty = false;
      this.stats.claimsEvaluated++;
    };

    // Non-recommendation claims first so recommendations can reuse their evidence.
    for (const raw of this.rawClaims) {
      if (raw.dirty && raw.kind !== 'RECOMMENDATION') evaluateOne(raw);
      else if (!raw.dirty && raw.evaluated) this.stats.claimsReused++;
    }
    for (const raw of this.rawClaims) {
      if (raw.dirty && raw.kind === 'RECOMMENDATION') evaluateOne(raw);
    }
  }

  /** Flushes JEV checkpoints created by the applied events (bounded, in order). */
  async flushJev(jevOptions?: JevEvaluationOptions): Promise<void> {
    while (this.jev.pendingEvaluation.length > 0) {
      const ck = this.jev.pendingEvaluation.shift()!;
      const evidenceMap = new Map<string, EvidenceItem>();
      for (const e of this.evidence) evidenceMap.set(e.evidenceId, e);
      const deltaEvidence = ck.delta.evidenceIds
        .map((id) => evidenceMap.get(id))
        .filter((e): e is EvidenceItem => !!e);
      const result = await evaluateCheckpointGuarded(ck, deltaEvidence, jevOptions);
      this.jev.results.push(result);
      this.stats.checkpointsEvaluated++;
    }
  }

  /** Synchronous flush for the pure/batch path: local deterministic evaluator only. */
  flushJevSync(unavailable?: boolean): void {
    const guard: JevEvaluationOptions = unavailable ? { unavailable: true } : {};
    while (this.jev.pendingEvaluation.length > 0) {
      const ck = this.jev.pendingEvaluation.shift()!;
      const evidenceMap = new Map<string, EvidenceItem>();
      for (const e of this.evidence) evidenceMap.set(e.evidenceId, e);
      const deltaEvidence = ck.delta.evidenceIds
        .map((id) => evidenceMap.get(id))
        .filter((e): e is EvidenceItem => !!e);
      const result = unavailable
        ? {
            schema: M3_JEV_RESULT_SCHEMA,
            resultId: `jev-res-${ck.checkpointId}`,
            checkpointId: ck.checkpointId,
            inputRevision: ck.inputRevision,
            evaluator: { provider: 'local-deterministic-stub', evaluatorVersion: JEV_EVALUATOR_VERSION },
            status: 'UNAVAILABLE' as const,
            provenance: 'EVALUATOR_REPORTED' as const,
            supportEffect: 'NONE' as const,
            limitations: ['No JEV evaluator is configured; the evaluation was not run.'],
          }
        : evaluateCheckpointLocal(ck, deltaEvidence);
      void guard;
      this.jev.results.push(result);
      this.stats.checkpointsEvaluated++;
    }
  }

  snapshot(): AnalysisFoldSnapshot {
    const rawClaimSnaps: RawClaimSnapshot[] = this.rawClaims.map((c) => ({
      claimId: c.claimId,
      kind: c.kind,
      eventId: c.eventId,
      text: c.text,
      provenance: c.provenance,
      anchors: c.anchors,
      conditionIds: c.conditionIds,
      citedSourceIds: c.citedSourceIds,
      cellEvidenceEventIds: c.cellEvidenceEventIds,
      rationaleEventIds: c.rationaleEventIds,
      alternatives: c.alternatives,
      candidate: c.candidate,
      criterion: c.criterion,
      value: c.value,
      evaluated: c.evaluated,
      dirty: c.dirty,
    }));
    return {
      snapshotVersion: 1,
      runId: this.runId,
      processedEventCount: this.processedEventIds.length,
      processedEventIds: this.processedEventIds,
      inputChain: { value: this.inputChainValue, recordCount: this.inputChainCount },
      lastEvent: this.lastEvent ? { ...this.lastEvent } : undefined,
      sources: snapshotLedger(this.ledger.accs),
      evidence: this.evidence,
      rawClaims: rawClaimSnaps,
      relations: this.relations,
      conditions: this.conditions,
      userRequiredConditionIds: this.userRequiredConditionIds,
      conflicts: this.conflicts,
      verifications: this.verifications,
      validVerifyTargetKeys: Array.from(this.validVerifyTargetKeys.entries()).map(([targetKey, verifyEventId]) => ({
        targetKey,
        verifyEventId,
      })),
      verifyPayloads: Array.from(this.verifyPayloads.entries()).map(([eventId, meta]) => ({
        eventId,
        targetEventId: meta.targetEventId,
        targetClaimText: meta.targetClaimText,
        method: meta.method,
        result: meta.result,
        evidenceEventIds: meta.evidenceEventIds,
      })),
      pendingVerifyByTarget: Array.from(this.pendingVerifyByTarget.entries()).map(([targetEventId, verifyEventIds]) => ({
        targetEventId,
        verifyEventIds: [...verifyEventIds],
      })),
      declaredRelationsByEventId: Array.from(this.declaredRelationsByEventId.entries()).map(([eventId, relations]) => ({
        eventId,
        relations: relations.map((r) => ({ ...r })),
      })),
      pendingReferences: Array.from(this.pendingReferences.values()).map((p) => ({
        referenceId: p.referenceId,
        from: p.from,
        targetRunId: p.targetRunId,
        targetEventId: p.targetEventId,
        firstSeenRevisionValue: p.firstSeenRevisionValue,
        firstSeenRevisionCount: p.firstSeenRevisionCount,
      })),
      pendingEvidenceRequestors: Array.from(this.pendingEvidenceRequestors.entries()).map(([targetEventId, claimIds]) => ({
        targetEventId,
        claimIds: Array.from(claimIds),
      })),
      recClaimDepsByRationaleEvent: Array.from(this.recClaimDepsByRationaleEvent.entries()).map(
        ([rationaleEventId, claimIds]) => ({ rationaleEventId, claimIds: Array.from(claimIds) }),
      ),
      conflictsByConflictingEventId: Array.from(this.conflictsByConflictingEventId.entries()).map(
        ([eventId, conflictIds]) => ({ eventId, conflictIds: [...conflictIds] }),
      ),
      comparePayloads: this.comparePayloads,
      recommendPayloads: this.recommendPayloads,
      rationaleEventIds: this.rationaleEventIds,
      pendingSourceReads: this.pendingSourceReads,
      pendingReadEvents: this.pendingReadEvents,
      readEvidenceByCanonicalSource: Array.from(this.readEvidenceByCanonicalSource.entries()).map(
        ([canonicalSourceId, evidenceId]) => ({ canonicalSourceId, evidenceIds: [evidenceId] }),
      ),
      claimDepsBySource: Array.from(this.claimDepsBySource.entries()).map(([canonicalSourceId, claimIds]) => ({
        canonicalSourceId,
        claimIds: Array.from(claimIds),
      })),
      claimsByEventId: Array.from(this.claimsByEventId.entries()).map(([eventId, claimIds]) => ({
        eventId,
        claimIds: [...claimIds],
      })),
      invalidations: this.invalidations,
      topology: this.topology.snapshot(),
      jev: {
        checkpoints: this.jev.checkpoints,
        results: this.jev.results,
        checkpointKeys: Array.from(this.jev.checkpointKeys),
        lastCheckpointSequence: this.jev.lastCheckpointSequence,
        lastAdmissibleEvidenceSeq: this.jev.lastAdmissibleEvidenceSeq,
        noGainFired: this.jev.noGainFired,
        sourceReadCounts: Array.from(this.jev.sourceReadCounts.entries()).map(([sourceId, count]) => ({
          sourceId,
          count,
        })),
        totalReads: this.jev.totalReads,
        lowPrioritySelected: this.jev.lowPrioritySelected,
        highPrioritySelected: this.jev.highPrioritySelected,
      },
      resolvedLateReferenceIds: this.resolvedLateReferenceIds,
    };
  }
}

export interface CycleEdge {
  readonly fromEventId: string;
  readonly toEventId: string;
}

/** Finds relation edges that participate in cycles within the scope. */
export function detectCycleEdges(
  declaredRelationsByEventId: ReadonlyMap<string, readonly { targetEventId: string; targetRunId?: string }[]>,
  knownEventIds: ReadonlySet<string>,
): readonly CycleEdge[] {
  const graph = new Map<string, string[]>();
  for (const [eventId, rels] of declaredRelationsByEventId) {
    const targets = rels
      .filter((r) => !r.targetRunId && knownEventIds.has(r.targetEventId))
      .map((r) => r.targetEventId);
    if (targets.length > 0) graph.set(eventId, targets);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const cycleEdges: CycleEdge[] = [];
  const stack: { nodeId: string; iter: number }[] = [];

  for (const start of graph.keys()) {
    if (color.get(start) !== undefined) continue;
    color.set(start, GRAY);
    stack.push({ nodeId: start, iter: 0 });
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const targets = graph.get(top.nodeId) ?? [];
      if (top.iter < targets.length) {
        const next = targets[top.iter]!;
        top.iter++;
        const c = color.get(next) ?? WHITE;
        if (c === GRAY) {
          cycleEdges.push({ fromEventId: top.nodeId, toEventId: next });
        } else if (c === WHITE) {
          color.set(next, GRAY);
          stack.push({ nodeId: next, iter: 0 });
        }
      } else {
        color.set(top.nodeId, BLACK);
        stack.pop();
      }
    }
  }
  return cycleEdges;
}

export interface FoldFinalizeOptions {
  readonly questionSummary?: string;
  readonly overrideMode?: AnalysisMode;
  readonly domain?: string;
  readonly collectionCompleteness: CollectionCompleteness;
}

export interface FoldFinalizeResult {
  readonly report: AnalysisReportV1;
  readonly evaluatedClaims: readonly ClaimAnalysis[];
  readonly sources: readonly SourceLedgerEntry[];
  readonly userRequiredConditionIds: readonly string[];
}

/** Builds the final AnalysisReportV1 from the fold state. */
export function finalizeFoldReport(fold: AnalysisFold, finalize: FoldFinalizeOptions): FoldFinalizeResult {
  const sources = finalizeLedgerEntries(fold.ledger.accs);
  fold.evaluateDirtyClaims();

  const evaluatedClaims = fold.rawClaims.map((c) => c.evaluated!);
  const topoSnap = fold.topology.snapshot();

  // Mode lens from the observed profile (finalize-time; override never
  // touches evidence).
  const claimTexts = fold.rawClaims.map((c) => c.text);
  const lens = buildModeLensFromProfile(
    {
      compareCount: fold.comparePayloads.length,
      recommendCount: fold.recommendPayloads.length,
      verifyCount: fold.verifications.length,
      contradictionCount: fold.conflicts.length,
      searchCount: topoSnap.queryClusters.length,
      claimTexts,
      hasClaimOrRead:
        fold.rawClaims.some((c) => c.kind === 'CLAIM') ||
        topoSnap.eventsByType.some((e) => e.type === 'READ'),
    },
    topoSnap.queryClusters.map((q) => q.query).join(' '),
    {
      questionSummary: finalize.questionSummary,
      overrideMode: finalize.overrideMode,
      domain: finalize.domain,
      inputAnchors: fold.evidence.map((e) => ({ runId: fold.runId, eventId: e.eventId })),
    },
  );

  const projectionInputs: ProjectionInputs = {
    eventIndex: topoSnap.eventIndex,
    searchQueries: topoSnap.queryClusters,
    comparePayloads: fold.comparePayloads,
    recommendPayloads: fold.recommendPayloads,
    claims: evaluatedClaims,
    relations: fold.relations,
    conflicts: fold.conflicts,
    verifications: fold.verifications,
    options: {
      sources,
      temporal: lens.temporal,
      referenceDate: topoSnap.lastEvent?.occurredAt,
    },
  };
  const projection = buildProjection(lens.currentMode, projectionInputs);

  // CITES relations carry the evaluated claim's grounded supporting evidence
  // (deterministic in both execution paths since it derives from the claims).
  const claimById = new Map(evaluatedClaims.map((c) => [c.claimId, c]));
  const relations = fold.relations.map((r) =>
    r.type === 'CITES' && claimById.has(r.fromId)
      ? { ...r, evidenceIds: [...(claimById.get(r.fromId)!.supportingEvidenceIds)] }
      : r,
  );

  const topology = buildTopologyFromSnapshot(topoSnap, sources);

  // Answer support aggregation (5-rule judge)
  const aggregation = aggregateAnswerSupport({
    answerExists: true,
    collectionCompleteness: finalize.collectionCompleteness,
    claims: evaluatedClaims,
    conflicts: fold.conflicts,
    conditions: fold.conditions,
    userRequiredConditionIds: fold.userRequiredConditionIds,
    evidence: fold.evidence,
  });

  // Reference diagnostics: dangling / cross-run / late-resolved / cycle
  const references: ReferenceDiagnostic[] = [];
  const known = new Set(fold.processedEventIds);
  const resolvedLate = new Set(fold.resolvedLateReferenceIds);
  for (const [eventId, rels] of fold.declaredRelationsByEventId) {
    for (const r of rels) {
      const isCrossRun = !!r.targetRunId && r.targetRunId !== fold.runId;
      if (isCrossRun) {
        references.push({
          referenceId: `diag-${eventId}-${r.targetEventId}`,
          kind: 'CROSS_RUN',
          from: { runId: fold.runId, eventId },
          to: { runId: r.targetRunId!, eventId: r.targetEventId },
          status: 'PENDING',
        });
        continue;
      }
      if (known.has(r.targetEventId)) {
        const refId = `pend-${eventId}-${r.targetEventId}`;
        if (resolvedLate.has(refId)) {
          references.push({
            referenceId: `diag-${eventId}-${r.targetEventId}`,
            kind: 'LATE_RESOLVED',
            from: { runId: fold.runId, eventId },
            to: { runId: fold.runId, eventId: r.targetEventId },
            status: 'RESOLVED',
          });
        }
        continue;
      }
      references.push({
        referenceId: `diag-${eventId}-${r.targetEventId}`,
        kind: 'DANGLING',
        from: { runId: fold.runId, eventId },
        to: { runId: r.targetRunId ?? fold.runId, eventId: r.targetEventId },
        status: 'PENDING',
      });
    }
  }
  for (const edge of detectCycleEdges(fold.declaredRelationsByEventId, known)) {
    references.push({
      referenceId: `diag-cycle-${edge.fromEventId}-${edge.toEventId}`,
      kind: 'CYCLE',
      from: { runId: fold.runId, eventId: edge.fromEventId },
      to: { runId: fold.runId, eventId: edge.toEventId },
      status: 'PENDING',
    });
  }

  const inputRevision: InputRevision = {
    algorithm: 'sha256-canonical-schema1-records-v1',
    value: fold.inputChainValue,
    recordCount: fold.inputChainCount,
  };
  const stateRevision = computeStateRevision({
    inputRevision,
    analyzer: fold.options.analyzer,
    cursors: [
      {
        runId: fold.runId,
        processedThroughSequence: fold.cursor,
        processedRecordCount: fold.processedEventIds.length,
      },
    ],
    collectionCompleteness: finalize.collectionCompleteness,
    scopeIdsHash: scopeIdsHash(fold.options.scope.ownEventIds),
  });

  const report: AnalysisReportV1 = {
    schema: M3_ANALYSIS_REPORT_SCHEMA,
    captureSchemaVersion: 1,
    analyzer: fold.options.analyzer,
    inputRevision,
    stateRevision,
    freshness: { status: 'CURRENT', reasons: [] },
    scope: fold.options.scope,
    lens,
    projection,
    conditions: fold.conditions,
    sources,
    evidence: fold.evidence,
    claims: evaluatedClaims,
    relations,
    conflicts: fold.conflicts,
    verifications: fold.verifications,
    support: {
      status: aggregation.status,
      collectionCompleteness: finalize.collectionCompleteness,
      coreClaimIds: aggregation.coreClaimIds,
      evaluatedClaimIds: evaluatedClaims.map((c) => c.claimId),
      missingRequiredConditionIds: aggregation.missingRequiredConditionIds,
      unresolvedConflictIds: aggregation.unresolvedConflictIds,
      reasonCodes: aggregation.reasonCodes,
      basis: {
        ruleId: 'five-rule-support-judge-v1',
        ruleVersion: '1.0.0',
        inputAnchors: fold.evidence.map((e) => ({ runId: fold.runId, eventId: e.eventId })),
        limitations: [
          'Evidence support judged against recorded schema-1 events under closed-world local trace evidence.',
          'Process exit 0 and agent-reported declarations do not elevate support status.',
          'Direct support requires admissible source-content (READ) evidence; activity-only records such as searches never ground a claim.',
          'User-required conditions are grounded only by admissible evidence carrying the identical parsed condition.',
        ],
      },
    },
    topology,
    references,
    jevResults: fold.jev.results,
  };

  const validation = validateAnalysisReport(report);
  if (!validation.ok) {
    throw new Error(`Constructed AnalysisReportV1 violates contract: ${validation.error}`);
  }

  return { report, evaluatedClaims, sources, userRequiredConditionIds: fold.userRequiredConditionIds };
}

export function assessTemporalFreshnessForTest(
  sources: readonly SourceLedgerEntry[],
  temporal: 'NONE' | 'FRESHNESS_SENSITIVE' | 'UNKNOWN',
  referenceDate?: string,
): ReturnType<typeof assessTemporalFreshness> {
  return assessTemporalFreshness(sources, temporal, referenceDate);
}

export function runStatsOf(
  fold: AnalysisFold,
  mode: AnalysisRunStats['mode'],
  deltaEventCount: number,
  stateLoaded: boolean,
): AnalysisRunStats {
  return {
    mode,
    eventsExamined: fold.stats.eventsApplied,
    deltaEventCount,
    claimsEvaluated: fold.stats.claimsEvaluated,
    claimsReusedFromCache: fold.stats.claimsReused,
    jevCheckpointsEvaluated: fold.stats.checkpointsEvaluated,
    stateLoaded,
    invalidationsRecorded: fold.invalidations.length,
  };
}
