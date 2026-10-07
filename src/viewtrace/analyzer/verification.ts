/**
 * ViewTrace M3 Verification Assessment and Conflict Resolution Engine.
 *
 * Implements strict target resolution, validation of resolver evidence
 * (which must be source-content grounded), condition-dimensional conflict
 * matching, conflict history preservation, and explicit VERIFY resolution
 * adjudication.
 *
 * Condition matching (§8): a CONTRADICTION whose recorded conditions agree
 * per dimension (each dimension carries at most one value) is a SAME-condition
 * conflict (DETECTED). Same dimension with incompatible values (time/region/
 * subject differences) is DIFFERENT — a possible conflict only, never a
 * same-condition contradiction. Conditions that cannot be parsed into
 * dimensions are AMBIGUOUS (possible conflict, conservative).
 */

import type {
  AnalysisAnchor,
  ClaimAnalysis,
  Condition,
  ConflictAnalysis,
  ConflictHistoryEntry,
  ConflictResolution,
  DerivedBasis,
  EvidenceItem,
  InputRevision,
  VerifyAssessment,
} from '../analysis-types.js';
import type { ContradictionPayload, ProvenanceCategory, VerifyPayload, ViewTraceEvent } from '../types.js';
import { parseConditionDetailed } from './claims-relations.js';

export interface AssessVerificationOptions {
  readonly inputRevision: InputRevision;
}

export type ConditionMatch = 'SAME' | 'DIFFERENT' | 'AMBIGUOUS' | 'UNKNOWN';

export interface ConditionMatchResult {
  readonly conditionMatch: ConditionMatch;
  readonly conditions: readonly Condition[];
  readonly limitation?: string;
}

/**
 * Judges whether a contradiction's recorded conditions describe one and the
 * same circumstance. Grouping is per raw dimension token (see
 * parseConditionDetailed), so `workload=standard` + `concurrency=100` are
 * two independent dimensions (SAME) while `year=2024` + `year=2026` disagree
 * on TIME (DIFFERENT).
 */
export function matchContradictionConditions(
  condStrings: readonly string[],
  anchor: AnalysisAnchor,
  provenance: ProvenanceCategory,
): ConditionMatchResult {
  if (condStrings.length === 0) {
    // The schema-1 CONTRADICTION payload asserts incompatible evidence
    // "under the same conditions"; with no conditions recorded we honor the
    // event's own same-condition assertion.
    return { conditionMatch: 'SAME', conditions: [] };
  }

  const parsed = condStrings.map((raw) => parseConditionDetailed(raw, anchor, provenance));
  const byDimension = new Map<string, typeof parsed>();
  let unparsed = 0;
  for (const p of parsed) {
    if (p.dimensionKey === 'other' && p.condition.operator === 'EQ' && !p.condition.value.includes('=')) {
      // Free-text token that never parsed into dim(+op)+value structure.
      unparsed++;
    }
    const list = byDimension.get(p.dimensionKey) ?? [];
    list.push(p);
    byDimension.set(p.dimensionKey, list);
  }

  const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ');

  for (const [, list] of byDimension) {
    if (list.length < 2) continue;
    const operators = new Set(list.map((p) => p.condition.operator));
    if (operators.size > 1) {
      // e.g. year=2024 vs year>=2026: comparability is not decidable.
      return {
        conditionMatch: 'UNKNOWN',
        conditions: parsed.map((p) => p.condition),
        limitation: 'Condition operators are not mutually comparable; condition equality is indeterminate.',
      };
    }
    const values = new Set(list.map((p) => norm(p.condition.value)));
    if (values.size > 1) {
      return {
        conditionMatch: 'DIFFERENT',
        conditions: parsed.map((p) => p.condition),
        limitation: `Dimension "${list[0]!.dimensionKey}" carries incompatible values (${Array.from(values).join(' vs ')}); evidence may describe different circumstances.`,
      };
    }
  }

  if (unparsed >= 2) {
    return {
      conditionMatch: 'AMBIGUOUS',
      conditions: parsed.map((p) => p.condition),
      limitation: 'Multiple recorded conditions could not be parsed into comparable dimensions.',
    };
  }

  return { conditionMatch: 'SAME', conditions: parsed.map((p) => p.condition) };
}

/** Conflicts that block strong support / force CONFLICTING_EVIDENCE. */
export function conflictBlocksSupport(conflict: ConflictAnalysis): boolean {
  if (conflict.status === 'RESOLVED') return false;
  // DETECTED asserts same-condition incompatibility; AMBIGUOUS/UNKNOWN
  // condition equality is undecidable so we stay conservative. DIFFERENT-
  // condition conflicts remain recorded as POSSIBLE without blocking.
  return conflict.conditionMatch === 'SAME' || conflict.conditionMatch === 'AMBIGUOUS' || conflict.conditionMatch === 'UNKNOWN';
}

export function buildVerifyAssessment(
  ev: ViewTraceEvent,
  knownEventIds: ReadonlySet<string>,
  claims: readonly ClaimAnalysis[],
  evidenceMap: Map<string, EvidenceItem>,
): VerifyAssessment {
  const vp = ev.payload as VerifyPayload;

  let target:
    | { readonly kind: 'CLAIM'; readonly claimId: string }
    | { readonly kind: 'EVENT'; readonly eventId: string } = {
    kind: 'EVENT',
    eventId: vp.targetEventId ?? 'unknown',
  };

  let targetResolution: 'MATCHED' | 'MISMATCHED' | 'MISSING' | 'AMBIGUOUS' = 'MISSING';
  const limitations: string[] = [];

  if (vp.targetEventId) {
    if (knownEventIds.has(vp.targetEventId)) {
      target = { kind: 'EVENT', eventId: vp.targetEventId };
      targetResolution = 'MATCHED';
    } else {
      targetResolution = 'MISSING';
      limitations.push(`Target event ID "${vp.targetEventId}" not found in captured run events.`);
    }
  } else if (vp.targetClaimText) {
    // Find matching claim
    const needle = vp.targetClaimText.toLowerCase();
    const matched = claims.filter((c) => c.text.toLowerCase().includes(needle));
    if (matched.length === 1) {
      target = { kind: 'CLAIM', claimId: matched[0]!.claimId };
      targetResolution = 'MATCHED';
    } else if (matched.length > 1) {
      targetResolution = 'AMBIGUOUS';
      limitations.push(`Target claim text "${vp.targetClaimText}" matched ${matched.length} claims ambiguously.`);
    } else {
      targetResolution = 'MISMATCHED';
      limitations.push(`Target claim text "${vp.targetClaimText}" did not match any extracted claims.`);
    }
  } else {
    targetResolution = 'MISSING';
    limitations.push('VERIFY event specifies neither targetEventId nor targetClaimText.');
  }

  // Resolver evidence items must be admissible AND source-content grounded:
  // a VERIFY citing a bare search activity did not observe any content.
  const resolverEvIds: string[] = [];
  let hasAdmissibleResolver = false;
  for (const eid of vp.evidenceEventIds ?? []) {
    const item = evidenceMap.get(eid);
    if (item) {
      resolverEvIds.push(item.evidenceId);
      if (item.admissibility === 'ADMISSIBLE' && item.grounding === 'SOURCE_CONTENT') {
        hasAdmissibleResolver = true;
      }
    } else {
      limitations.push(`Resolver evidence event "${eid}" not found.`);
    }
  }

  let correctness: 'VALID' | 'INVALID' | 'UNKNOWN' = 'UNKNOWN';
  if (targetResolution === 'MATCHED' && hasAdmissibleResolver && (vp.result === 'CONFIRMED' || vp.result === 'REFUTED')) {
    correctness = 'VALID';
  } else {
    correctness = 'INVALID';
    if (!hasAdmissibleResolver) {
      limitations.push('No admissible source-content resolver evidence provided to support verification.');
    }
    if (vp.result === 'INCONCLUSIVE' || vp.result === 'UNKNOWN') {
      limitations.push(`Verification outcome is ${vp.result}.`);
    }
  }

  return {
    verifyEventId: ev.eventId,
    target,
    targetResolution,
    result: vp.result,
    resolverEvidenceIds: resolverEvIds,
    conditionIds: [],
    correctness,
    limitations,
  };
}

export function buildConflictFromContradiction(
  ev: ViewTraceEvent,
  resolveClaimIds: (eventId: string) => string[],
  validVerificationsByTarget: Map<string, VerifyAssessment>,
  inputRevision: InputRevision,
): ConflictAnalysis {
  const cp = ev.payload as ContradictionPayload;
  const conflictId = `conflict-${ev.eventId}`;
  const conflictingEventIds = cp.conflictingEventIds ?? [];
  const limitations: string[] = [];

  const conflictingClaimIds: string[] = [];
  for (const ceid of conflictingEventIds) {
    for (const cid of resolveClaimIds(ceid)) {
      conflictingClaimIds.push(cid);
    }
  }

  const match = matchContradictionConditions(
    cp.conditions ?? [],
    { runId: ev.runId, eventId: ev.eventId },
    ev.provenance.category,
  );
  const conditionMatch = match.conditionMatch;
  if (match.limitation) limitations.push(match.limitation);

  const initialStatus: ConflictHistoryEntry['status'] =
    conditionMatch === 'SAME' ? 'DETECTED' : 'POSSIBLE';
  const history: ConflictHistoryEntry[] = [
    {
      status: initialStatus,
      inputRevision,
      anchors: [{ runId: ev.runId, eventId: ev.eventId }],
      basis: {
        ruleId: 'contradiction-detection-v1',
        ruleVersion: '1.0.0',
        inputAnchors: [{ runId: ev.runId, eventId: ev.eventId }],
        limitations: [
          'Contradiction asserted under recorded event condition sets; per-dimension condition equality was judged from recorded condition tokens only.',
        ],
      },
    },
  ];

  // Check if any valid verification resolves this conflict
  let resolution: ConflictResolution | undefined = undefined;
  let finalStatus: 'DETECTED' | 'POSSIBLE' | 'RESOLVED' | 'UNKNOWN' =
    conditionMatch === 'SAME' ? 'DETECTED' : 'POSSIBLE';

  for (const ceid of conflictingEventIds) {
    const resolver = validVerificationsByTarget.get(ceid);
    if (resolver) {
      resolution = {
        verifyEventId: resolver.verifyEventId,
        targetClaimIds: conflictingClaimIds,
        result: resolver.result === 'REFUTED' ? 'REFUTED' : 'CONFIRMED',
        resolverEvidenceIds: resolver.resolverEvidenceIds,
        conditionIds: resolver.conditionIds,
      };
      finalStatus = 'RESOLVED';
      history.push({
        status: 'RESOLVED',
        inputRevision,
        anchors: [{ runId: ev.runId, eventId: resolver.verifyEventId }],
        basis: {
          ruleId: 'contradiction-resolution-v1',
          ruleVersion: '1.0.0',
          inputAnchors: [{ runId: ev.runId, eventId: resolver.verifyEventId }],
          limitations: ['Resolved by explicit VERIFY event with admissible source-content resolver evidence.'],
        },
      });
      break;
    }
  }

  if (!resolution) {
    limitations.push('No valid VERIFY event resolved this contradiction; remains unresolved.');
  }

  return {
    conflictId,
    status: finalStatus,
    claimIds: conflictingClaimIds.length > 0 ? conflictingClaimIds : conflictingEventIds,
    conditionMatch,
    history,
    resolution,
    limitations,
  };
}

export function assessVerificationsAndConflicts(
  events: readonly ViewTraceEvent[],
  claims: readonly ClaimAnalysis[],
  evidenceItems: readonly EvidenceItem[],
  conditions: readonly Condition[],
  options: AssessVerificationOptions,
): {
  readonly verifications: readonly VerifyAssessment[];
  readonly conflicts: readonly ConflictAnalysis[];
} {
  void conditions;
  const knownEventIds = new Set<string>();
  for (const ev of events) {
    knownEventIds.add(ev.eventId);
  }
  const evidenceMap = new Map<string, EvidenceItem>();
  for (const e of evidenceItems) {
    evidenceMap.set(e.eventId, e);
    evidenceMap.set(e.evidenceId, e);
  }

  // 1. Process VERIFY events
  const verifications: VerifyAssessment[] = [];
  const validVerificationsByTarget = new Map<string, VerifyAssessment>();

  for (const ev of events) {
    if (ev.type !== 'VERIFY') continue;
    const assessment = buildVerifyAssessment(ev, knownEventIds, claims, evidenceMap);
    verifications.push(assessment);

    if (assessment.correctness === 'VALID') {
      const targetKey =
        assessment.target.kind === 'EVENT' ? assessment.target.eventId : assessment.target.claimId;
      validVerificationsByTarget.set(targetKey, assessment);
    }
  }

  // 2. Process Contradictions and Conflicts
  const claimsByEventId = new Map<string, string[]>();
  for (const c of claims) {
    for (const a of c.anchors) {
      if (a.eventId) {
        const list = claimsByEventId.get(a.eventId) ?? [];
        list.push(c.claimId);
        claimsByEventId.set(a.eventId, list);
      }
    }
  }

  const conflicts: ConflictAnalysis[] = [];
  for (const ev of events) {
    if (ev.type !== 'CONTRADICTION') continue;
    conflicts.push(
      buildConflictFromContradiction(
        ev,
        (eventId) => claimsByEventId.get(eventId) ?? [],
        validVerificationsByTarget,
        options.inputRevision,
      ),
    );
  }

  return {
    verifications,
    conflicts,
  };
}
