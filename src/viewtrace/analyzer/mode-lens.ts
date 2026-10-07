/**
 * ViewTrace M3 Mode Lens and 7 Projection Projections.
 *
 * Implements inferred-first revision chain (Question hypothesis -> Observed confirmation/correction
 * -> Explicit override) and project views for EXPLAIN, COMPARE, DECIDE, ASSESS, VERIFY, IDEATE, and UNKNOWN.
 * Per docs/MILESTONES.md §8: mode override changes projection only, never evidence or provenance.
 *
 * Honesty rules:
 *  - ASSESS temporal freshness is derived from recorded source publication
 *    dates against the latest observed event time (never a wall clock), and
 *    is UNKNOWN when no publication dates were recorded.
 *  - DECIDE rejected options carry rationale links only when observed
 *    comparison/claim evidence exists; otherwise the fields stay absent
 *    ("비교 근거 부족"), never synthesized.
 *  - IDEATE branch statuses other than ACTIVE are UNKNOWN unless discard
 *    evidence was observed; issuing several distinct queries is what makes
 *    diversity OBSERVED.
 */

import type {
  AnalysisAnchor,
  AnalysisMode,
  AnalysisRelation,
  AssessProjection,
  ClaimAnalysis,
  CompareProjection,
  ConflictAnalysis,
  DecideProjection,
  DerivedBasis,
  ExplainProjection,
  IdeateProjection,
  ModeLens,
  ModeProjection,
  ModeRevision,
  SourceLedgerEntry,
  UnknownProjection,
  VerifyAssessment,
  VerifyProjection,
} from '../analysis-types.js';
import type { ComparePayload, RecommendationPayload, ViewTraceEvent } from '../types.js';

export interface BuildModeLensOptions {
  readonly questionSummary?: string;
  readonly overrideMode?: AnalysisMode;
  readonly domain?: string;
  readonly inputAnchors: readonly AnalysisAnchor[];
}

/** Publication dates older than this (relative to the latest observed event) read as STALE. */
export const ASSESS_STALENESS_DAYS = 3 * 366;

export function inferHypothesisFromQuestion(question?: string): AnalysisMode {
  if (!question) return 'UNKNOWN';
  const q = question.toLowerCase();
  if (/\b(vs|compare|comparison|difference|differences|versus)\b/.test(q)) {
    return 'COMPARE';
  }
  if (/\b(recommend|recommendation|should i choose|best choice|which one|pick)\b/.test(q)) {
    return 'DECIDE';
  }
  if (/\b(verify|is it true|fact check|factcheck|check if|validate|true or false)\b/.test(q)) {
    return 'VERIFY';
  }
  if (/\b(risk|risks|assess|assessment|feasibility|freshness|security posture)\b/.test(q)) {
    return 'ASSESS';
  }
  if (/\b(brainstorm|ideas|alternatives|options|ideate|explore variants)\b/.test(q)) {
    return 'IDEATE';
  }
  if (/\b(why|how does|explain|architecture|mechanism|cause)\b/.test(q)) {
    return 'EXPLAIN';
  }
  return 'UNKNOWN';
}

export function inferObservedModeFromEvents(events: readonly ViewTraceEvent[]): AnalysisMode {
  return inferObservedModeFromProfile({
    compareCount: events.filter((e) => e.type === 'COMPARE').length,
    recommendCount: events.filter((e) => e.type === 'RECOMMEND').length,
    verifyCount: events.filter((e) => e.type === 'VERIFY').length,
    contradictionCount: events.filter((e) => e.type === 'CONTRADICTION').length,
    searchCount: events.filter((e) => e.type === 'SEARCH').length,
    claimTexts: events.filter((e) => e.type === 'CLAIM').map((e) => (e.payload as { text?: string }).text ?? ''),
    hasClaimOrRead: events.some((e) => e.type === 'CLAIM' || e.type === 'READ'),
  });
}

export interface ObservedModeProfile {
  readonly compareCount: number;
  readonly recommendCount: number;
  readonly verifyCount: number;
  readonly contradictionCount: number;
  readonly searchCount: number;
  readonly claimTexts: readonly string[];
  readonly hasClaimOrRead: boolean;
}

export function inferObservedModeFromProfile(profile: ObservedModeProfile): AnalysisMode {
  if (profile.compareCount > 0) return 'COMPARE';
  if (profile.verifyCount > 0 || profile.contradictionCount > 0) return 'VERIFY';
  if (profile.recommendCount > 0) return 'DECIDE';
  if (profile.searchCount >= 4) return 'IDEATE';
  const hasAssessmentClaim = profile.claimTexts.some((text) =>
    /\b(risk|assess|assessment|posture|freshness|vulnerability|vulnerabilities|benchmark)\b/.test(
      String(text).toLowerCase(),
    ),
  );
  if (hasAssessmentClaim) return 'ASSESS';
  if (profile.hasClaimOrRead) return 'EXPLAIN';
  return 'UNKNOWN';
}

export function buildModeLens(
  events: readonly ViewTraceEvent[],
  options: BuildModeLensOptions,
): ModeLens {
  return buildModeLensFromProfile(
    {
      compareCount: events.filter((e) => e.type === 'COMPARE').length,
      recommendCount: events.filter((e) => e.type === 'RECOMMEND').length,
      verifyCount: events.filter((e) => e.type === 'VERIFY').length,
      contradictionCount: events.filter((e) => e.type === 'CONTRADICTION').length,
      searchCount: events.filter((e) => e.type === 'SEARCH').length,
      claimTexts: events.filter((e) => e.type === 'CLAIM').map((e) => (e.payload as { text?: string }).text ?? ''),
      hasClaimOrRead: events.some((e) => e.type === 'CLAIM' || e.type === 'READ'),
    },
    events
      .filter((e) => e.type === 'SEARCH')
      .map((e) => (e.payload as { query?: string }).query ?? '')
      .join(' '),
    options,
  );
}

export function buildModeLensFromProfile(
  profile: ObservedModeProfile,
  searchText: string,
  options: BuildModeLensOptions,
): ModeLens {
  const revisions: ModeRevision[] = [];
  const basis: DerivedBasis = {
    ruleId: 'mode-lens-inferred-chain-v1',
    ruleVersion: '1.0.0',
    inputAnchors: options.inputAnchors,
    limitations: ['Mode lens derived from question heuristics and observable activity profile.'],
  };

  // Step 1: Initial Hypothesis
  const hypothesisMode = inferHypothesisFromQuestion(options.questionSummary);
  revisions.push({
    revisionId: 'rev-1-hypothesis',
    phase: 'INITIAL_HYPOTHESIS',
    mode: hypothesisMode,
    source: 'QUESTION',
    basis,
  });

  // Step 2: Observed Confirmation or Correction
  const observedMode = inferObservedModeFromProfile(profile);
  let effectiveMode = hypothesisMode;

  if (observedMode !== 'UNKNOWN') {
    revisions.push({
      revisionId: 'rev-2-observed',
      phase: observedMode === hypothesisMode ? 'OBSERVED_CONFIRMATION' : 'OBSERVED_CORRECTION',
      mode: observedMode,
      source: 'OBSERVED_EVENTS',
      basis,
    });
    effectiveMode = observedMode;
  } else if (hypothesisMode === 'UNKNOWN') {
    // Both unknown
    effectiveMode = 'UNKNOWN';
  }

  // Step 3: Explicit Override
  if (options.overrideMode && options.overrideMode !== effectiveMode) {
    revisions.push({
      revisionId: 'rev-3-override',
      phase: 'EXPLICIT_OVERRIDE',
      mode: options.overrideMode,
      source: 'USER_OVERRIDE',
      basis,
    });
    effectiveMode = options.overrideMode;
  }

  const currentRevisionId = revisions[revisions.length - 1]!.revisionId;

  // Temporal check
  let temporal: 'NONE' | 'FRESHNESS_SENSITIVE' | 'UNKNOWN' = 'NONE';
  const textToCheck = `${options.questionSummary ?? ''} ${searchText}`;
  if (effectiveMode === 'ASSESS' || /\b(202\d|latest|recent|current|today|fresh)\b/i.test(textToCheck)) {
    temporal = 'FRESHNESS_SENSITIVE';
  }

  return {
    revisions,
    currentRevisionId,
    currentMode: effectiveMode,
    domain: options.domain,
    temporal,
  };
}

/**
 * Temporal freshness from recorded publication dates only. The reference
 * point is the latest observed event time — never the analyzer's wall clock,
 * so the judgement is deterministic and replayable. Absent publication dates
 * stay UNKNOWN; non-freshness-sensitive lenses are NOT_APPLICABLE.
 */
export function assessTemporalFreshness(
  sources: readonly SourceLedgerEntry[],
  temporal: ModeLens['temporal'],
  referenceDate?: string,
): AssessProjection['freshness'] {
  const dates = sources
    .map((s) => s.publicationDate?.value)
    .filter((v): v is string => !!v)
    .map((v) => Date.parse(v))
    .filter((t) => !isNaN(t));
  if (dates.length === 0) {
    return temporal === 'FRESHNESS_SENSITIVE' ? 'UNKNOWN' : 'NOT_APPLICABLE';
  }
  const refRaw = referenceDate ? Date.parse(referenceDate) : NaN;
  if (isNaN(refRaw)) return 'UNKNOWN';
  const oldest = Math.min(...dates);
  const ageDays = (refRaw - oldest) / 86_400_000;
  return ageDays > ASSESS_STALENESS_DAYS ? 'STALE' : 'CURRENT';
}

export interface BuildProjectionOptions {
  readonly sources?: readonly SourceLedgerEntry[];
  readonly temporal?: ModeLens['temporal'];
  readonly referenceDate?: string;
}

/** Lightweight per-event facts the projections are derived from. */
export interface ProjectionEventIndexEntry {
  readonly eventId: string;
  readonly type: string;
  readonly sequence: number;
}

export interface ProjectionCompareSnapshot {
  readonly eventId: string;
  readonly candidates: readonly string[];
  readonly criteria: readonly string[];
  readonly cells: readonly {
    readonly candidate: string;
    readonly criterion: string;
    readonly value?: string;
    readonly evidenceEventIds?: readonly string[];
  }[];
}

export interface ProjectionRecommendSnapshot {
  readonly eventId: string;
  readonly choice: string;
  readonly alternatives?: readonly string[];
  readonly rationaleEventIds?: readonly string[];
}

export interface ProjectionInputs {
  readonly eventIndex: readonly ProjectionEventIndexEntry[];
  readonly searchQueries: readonly { readonly eventId: string; readonly query: string }[];
  readonly comparePayloads: readonly ProjectionCompareSnapshot[];
  readonly recommendPayloads: readonly ProjectionRecommendSnapshot[];
  readonly claims: readonly ClaimAnalysis[];
  readonly relations: readonly AnalysisRelation[];
  readonly conflicts: readonly ConflictAnalysis[];
  readonly verifications: readonly VerifyAssessment[];
  readonly options?: BuildProjectionOptions;
}

export function projectionInputsFromEvents(
  events: readonly ViewTraceEvent[],
  claims: readonly ClaimAnalysis[],
  relations: readonly AnalysisRelation[],
  conflicts: readonly ConflictAnalysis[],
  verifications: readonly VerifyAssessment[],
  options: BuildProjectionOptions = {},
): ProjectionInputs {
  return {
    eventIndex: events.map((e) => ({ eventId: e.eventId, type: e.type, sequence: e.sequence })),
    searchQueries: events
      .filter((e) => e.type === 'SEARCH')
      .map((e) => ({ eventId: e.eventId, query: (e.payload as { query?: string }).query ?? '' })),
    comparePayloads: events
      .filter((e): e is ViewTraceEvent & { payload: ComparePayload } => e.type === 'COMPARE')
      .map((e) => {
        const cp = e.payload as ComparePayload;
        return {
          eventId: e.eventId,
          candidates: cp.candidates,
          criteria: cp.criteria,
          cells: cp.cells.map((cell) => ({
            candidate: cell.candidate,
            criterion: cell.criterion,
            value: cell.value !== null && cell.value !== undefined ? String(cell.value) : undefined,
            evidenceEventIds: cell.evidenceEventIds,
          })),
        };
      }),
    recommendPayloads: events
      .filter((e) => e.type === 'RECOMMEND')
      .map((e) => {
        const rp = e.payload as RecommendationPayload;
        return {
          eventId: e.eventId,
          choice: rp.choice,
          alternatives: rp.alternatives,
          rationaleEventIds: rp.rationaleEventIds,
        };
      }),
    claims,
    relations,
    conflicts,
    verifications,
    options,
  };
}

export function buildProjection(mode: AnalysisMode, inputs: ProjectionInputs): ModeProjection {
  const { claims, relations, conflicts, verifications } = inputs;
  const options = inputs.options ?? {};
  switch (mode) {
    case 'EXPLAIN': {
      const structureClaimIds: string[] = [];
      const causalClaimIds: string[] = [];
      for (const c of claims) {
        if (/how|structure|architecture|contain|consist|build/i.test(c.text)) {
          structureClaimIds.push(c.claimId);
        } else {
          causalClaimIds.push(c.claimId);
        }
      }
      return {
        mode: 'EXPLAIN',
        structureClaimIds,
        causalClaimIds,
        relationIds: relations.map((r) => r.relationId),
      };
    }
    case 'COMPARE': {
      const candidatesSet = new Set<string>();
      const criteriaSet = new Set<string>();
      const cells: CompareProjection['cells'][number][] = [];

      const claimIdSet = new Set(claims.map((c) => c.claimId));
      for (const cp of inputs.comparePayloads) {
        for (const cand of cp.candidates) candidatesSet.add(cand);
        for (const crit of cp.criteria) criteriaSet.add(crit);
        for (const cell of cp.cells) {
          const cellClaimId = `claim-${cp.eventId}-${cell.candidate}-${cell.criterion}`;
          const matchedClaimIds = claimIdSet.has(cellClaimId) ? [cellClaimId] : [];
          cells.push({
            candidate: cell.candidate,
            criterion: cell.criterion,
            claimIds: matchedClaimIds,
            evidenceIds: cell.evidenceEventIds ? cell.evidenceEventIds.map((e) => `ev-${e}`) : [],
            conditionIds: [],
            value: cell.value,
          });
        }
      }

      return {
        mode: 'COMPARE',
        candidates: Array.from(candidatesSet),
        criteria: Array.from(criteriaSet),
        cells,
      };
    }
    case 'DECIDE': {
      let selectedCandidate: string | undefined = undefined;
      const recommendationClaimIds: string[] = [];
      const rationaleEvidenceIds: string[] = [];
      const rejectedOptions: DecideProjection['rejectedOptions'][number][] = [];

      const claimById = new Map(claims.map((c) => [c.claimId, c]));

      for (const rp of inputs.recommendPayloads) {
        selectedCandidate = rp.choice;
        recommendationClaimIds.push(`claim-${rp.eventId}-recommendation`);
        // Rationale evidence = the recommendation claim's direct grounded
        // support (evaluated), not raw references to possibly-inadmissible
        // rationale events.
        const recClaim = claimById.get(`claim-${rp.eventId}-recommendation`);
        for (const eid of recClaim?.supportingEvidenceIds ?? []) rationaleEvidenceIds.push(eid);
        if (rp.alternatives) {
          for (const alt of rp.alternatives) {
            // Link observed rejection rationale: comparison cells (or any
            // claim) that actually evaluated this alternative. Absent
            // observed grounding stays absent — never synthesized.
            const altClaimIds = claims
              .filter((c) => c.claimId.includes(`-${alt}-`) || c.text.toLowerCase().includes(alt.toLowerCase()))
              .filter((c) => c.supportingEvidenceIds.length > 0)
              .map((c) => c.claimId);
            const altEvidenceIds = Array.from(
              new Set(altClaimIds.flatMap((cid) => claimById.get(cid)?.supportingEvidenceIds ?? [])),
            );
            rejectedOptions.push({
              candidate: alt,
              rationaleClaimIds: altClaimIds.length > 0 ? altClaimIds : undefined,
              evidenceIds: altEvidenceIds.length > 0 ? altEvidenceIds : undefined,
            });
          }
        }
      }

      return {
        mode: 'DECIDE',
        selectedCandidate,
        recommendationClaimIds,
        rationaleEvidenceIds,
        rejectedOptions,
      };
    }
    case 'ASSESS': {
      const feasibilityClaimIds: string[] = [];
      const riskClaimIds: string[] = [];
      for (const c of claims) {
        if (/risk|fail|vulnerability|threat|flaw/i.test(c.text)) {
          riskClaimIds.push(c.claimId);
        } else {
          feasibilityClaimIds.push(c.claimId);
        }
      }
      return {
        mode: 'ASSESS',
        feasibilityClaimIds,
        riskClaimIds,
        conditionIds: [],
        freshness: assessTemporalFreshness(options.sources ?? [], options.temporal ?? 'NONE', options.referenceDate),
      };
    }
    case 'VERIFY': {
      return {
        mode: 'VERIFY',
        verifyEventIds: verifications.map((v) => v.verifyEventId),
        conflictIds: conflicts.map((c) => c.conflictId),
      };
    }
    case 'IDEATE': {
      // Branch topology is inferred from observed SEARCH boundaries. Only
      // the branch containing the latest observed event is ACTIVE; every
      // other branch is UNKNOWN unless discard evidence was observed —
      // dropping is not inferred from position alone.
      const branches: IdeateProjection['branches'][number][] = [];
      const searchIndex = inputs.eventIndex.filter((e) => e.type === 'SEARCH');
      if (searchIndex.length === 0) {
        branches.push({
          branchId: 'branch-main',
          eventIds: inputs.eventIndex.map((e) => e.eventId),
          status: 'ACTIVE',
        });
      } else {
        searchIndex.forEach((s, idx) => {
          const next = searchIndex[idx + 1];
          const inBranch = inputs.eventIndex.filter((e) =>
            next ? e.sequence >= s.sequence && e.sequence < next.sequence : e.sequence >= s.sequence,
          );
          branches.push({
            branchId: `branch-${s.eventId}`,
            eventIds: inBranch.map((e) => e.eventId),
            status: next ? 'UNKNOWN' : 'ACTIVE',
          });
        });
      }
      return {
        mode: 'IDEATE',
        branches,
        diversityStatus:
          inputs.searchQueries.length > 1 &&
          new Set(inputs.searchQueries.map((q) => q.query.trim().toLowerCase())).size > 1
            ? 'OBSERVED'
            : 'UNKNOWN',
      };
    }
    case 'UNKNOWN':
    default: {
      return {
        mode: 'UNKNOWN',
        overviewClaimIds: claims.map((c) => c.claimId),
        unresolvedReasonIds: conflicts.filter((c) => c.status !== 'RESOLVED').map((c) => c.conflictId),
      };
    }
  }
}
