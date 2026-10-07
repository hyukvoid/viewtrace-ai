/**
 * ViewTrace M3 5-Rule Evidence Support Judge.
 *
 * Implements the normative evidence support rules from docs/MILESTONES.md §8:
 *  1. Target or provenance unclear -> UNKNOWN; target exists with no admissible support -> INSUFFICIENT_EVIDENCE.
 *  2. Unresolved core conflicts under the SAME conditions -> CONFLICTING_EVIDENCE (majority vote cannot
 *     override). Different-condition conflicts stay POSSIBLE and do not block.
 *  3. Partial claim support, missing user-required conditions, or collection PARTIAL/UNKNOWN ->
 *     at most PARTIALLY_SUPPORTED.
 *  4. STRONGLY_SUPPORTED requires all core claims AND user-required conditions supported by direct,
 *     condition-matched, admissible source-content evidence, zero unresolved blocking conflicts, and
 *     collection completeness COMPLETE.
 *  5. Honest basis & reason codes; process exit 0, RECOMMEND, reported 'verified', mode/JEV progress
 *     cannot elevate support.
 */

import type {
  AnalysisAnchor,
  AnswerSupportAnalysis,
  ClaimAnalysis,
  Condition,
  ConflictAnalysis,
  DerivedBasis,
  EvidenceItem,
} from '../analysis-types.js';
import type { CollectionCompleteness, EvidenceSupport } from '../types.js';
import { conflictBlocksSupport } from './verification.js';

export interface EvaluateSupportInput {
  readonly answerExists: boolean;
  readonly collectionCompleteness: CollectionCompleteness;
  readonly claims: readonly ClaimAnalysis[];
  readonly evidence: readonly EvidenceItem[];
  readonly conflicts: readonly ConflictAnalysis[];
  readonly conditions: readonly Condition[];
  /** Condition IDs the agent declared as user requirements on the answer. */
  readonly userRequiredConditionIds?: readonly string[];
  readonly inputAnchors: readonly AnalysisAnchor[];
}

export function evaluateClaimSupport(
  claim: ClaimAnalysis,
  evidenceMap: Map<string, EvidenceItem>,
  conflicts: readonly ConflictAnalysis[],
): ClaimAnalysis {
  // Only same-condition (or condition-ambiguous) unresolved conflicts make
  // the claim itself conflicting; different-condition conflicts stay recorded
  // as POSSIBLE without poisoning the claim.
  const relevantConflicts = conflicts.filter(
    (cf) => cf.claimIds.includes(claim.claimId) && conflictBlocksSupport(cf),
  );

  if (relevantConflicts.length > 0) {
    return {
      ...claim,
      support: 'CONFLICTING_EVIDENCE',
      unresolvedReasonIds: relevantConflicts.map((c) => c.conflictId),
    };
  }

  // Direct support must be admissible AND source-content grounded; the
  // extraction stage already filters agent-declared SUPPORTS edges to
  // non-grounding events, this re-checks the persisted evidence itself.
  const admissibleSupport = claim.supportingEvidenceIds.filter((eid) => {
    const item = evidenceMap.get(eid);
    return item && item.admissibility === 'ADMISSIBLE' && item.grounding === 'SOURCE_CONTENT';
  });

  if (admissibleSupport.length === 0) {
    return {
      ...claim,
      support: 'INSUFFICIENT_EVIDENCE',
      unresolvedReasonIds: ['no-admissible-source-content-evidence'],
    };
  }

  const opposing = claim.opposingEvidenceIds.filter((eid) => {
    const item = evidenceMap.get(eid);
    return item && item.admissibility === 'ADMISSIBLE' && item.grounding === 'SOURCE_CONTENT';
  });

  if (opposing.length > 0) {
    return {
      ...claim,
      support: 'CONFLICTING_EVIDENCE',
      unresolvedReasonIds: ['opposing-evidence-present'],
    };
  }

  return {
    ...claim,
    support: 'STRONGLY_SUPPORTED',
  };
}

export interface AnswerSupportAggregation {
  readonly status: EvidenceSupport;
  readonly reasonCodes: AnswerSupportAnalysis['reasonCodes'][number][];
  readonly missingRequiredConditionIds: readonly string[];
  readonly unresolvedConflictIds: readonly string[];
  readonly coreClaimIds: readonly string[];
}

/**
 * Grounds user-required conditions: a declared condition is grounded only
 * when some admissible evidence item carries the same parsed condition.
 * Semantic equivalence beyond identical parsed conditions is not inferred.
 */
export function findMissingRequiredConditions(
  userRequiredConditionIds: readonly string[],
  conditions: readonly Condition[],
  evidence: readonly EvidenceItem[],
): readonly string[] {
  if (userRequiredConditionIds.length === 0) return [];
  const grounded = new Set<string>();
  for (const item of evidence) {
    if (item.admissibility !== 'ADMISSIBLE') continue;
    for (const cid of item.conditionIds) grounded.add(cid);
  }
  const known = new Set(conditions.map((c) => c.conditionId));
  return userRequiredConditionIds.filter((id) => !grounded.has(id) || !known.has(id));
}

export function aggregateAnswerSupport(input: {
  readonly answerExists: boolean;
  readonly collectionCompleteness: CollectionCompleteness;
  readonly claims: readonly ClaimAnalysis[];
  readonly conflicts: readonly ConflictAnalysis[];
  readonly conditions: readonly Condition[];
  readonly userRequiredConditionIds: readonly string[];
  readonly evidence: readonly EvidenceItem[];
}): AnswerSupportAggregation {
  const evaluatedClaims = input.claims;
  const coreClaims = evaluatedClaims.filter((c) => c.importance === 'CORE');
  const coreClaimIds = coreClaims.map((c) => c.claimId);

  const unresolvedCoreConflicts = input.conflicts.filter(
    (cf) =>
      conflictBlocksSupport(cf) &&
      cf.claimIds.some((cid) => coreClaimIds.includes(cid) || coreClaimIds.length === 0),
  );
  const unresolvedConflictIds = unresolvedCoreConflicts.map((c) => c.conflictId);

  const missingRequiredConditionIds = findMissingRequiredConditions(
    input.userRequiredConditionIds,
    input.conditions,
    input.evidence,
  );

  const reasonCodes: AnswerSupportAnalysis['reasonCodes'][number][] = [];
  let status: EvidenceSupport = 'UNKNOWN';

  // Rule 1: Target unknown or no target
  if (!input.answerExists || evaluatedClaims.length === 0) {
    status = 'UNKNOWN';
    reasonCodes.push('TARGET_UNKNOWN');
    return { status, reasonCodes, missingRequiredConditionIds, unresolvedConflictIds, coreClaimIds };
  }

  // Rule 2: Unresolved core conflict under same conditions -> CONFLICTING_EVIDENCE
  if (unresolvedCoreConflicts.length > 0) {
    status = 'CONFLICTING_EVIDENCE';
    reasonCodes.push('UNRESOLVED_CORE_CONFLICT');
    return { status, reasonCodes, missingRequiredConditionIds, unresolvedConflictIds, coreClaimIds };
  }

  const allClaimsInsufficient = evaluatedClaims.every((c) => c.support === 'INSUFFICIENT_EVIDENCE');
  const effectiveCoreClaims = coreClaims.length > 0 ? coreClaims : evaluatedClaims;
  const allCoreStrong =
    effectiveCoreClaims.length > 0 && effectiveCoreClaims.every((c) => c.support === 'STRONGLY_SUPPORTED');

  if (allClaimsInsufficient) {
    // Rule 1b: target exists but zero admissible (grounded) support
    status = 'INSUFFICIENT_EVIDENCE';
    reasonCodes.push('NO_ADMISSIBLE_SUPPORT');
  } else if (!allCoreStrong) {
    // Rule 3a: some claims supported only partially
    status = 'PARTIALLY_SUPPORTED';
    reasonCodes.push('PARTIAL_CLAIM_SUPPORT');
    if (input.collectionCompleteness !== 'COMPLETE') {
      reasonCodes.push('COLLECTION_NOT_COMPLETE');
    }
  } else if (missingRequiredConditionIds.length > 0) {
    // Rule 3b: important user-required conditions remain ungrounded
    status = 'PARTIALLY_SUPPORTED';
    reasonCodes.push('MISSING_REQUIRED_CONDITION');
    reasonCodes.push('PARTIAL_CLAIM_SUPPORT');
  } else if (input.collectionCompleteness === 'COMPLETE') {
    // Rule 4: All core claims and user conditions supported
    status = 'STRONGLY_SUPPORTED';
    reasonCodes.push('ALL_CORE_CLAIMS_SUPPORTED');
  } else {
    // Rule 3c: Collection is PARTIAL or UNKNOWN -> cannot be STRONGLY_SUPPORTED
    status = 'PARTIALLY_SUPPORTED';
    reasonCodes.push('COLLECTION_NOT_COMPLETE');
    reasonCodes.push('ALL_CORE_CLAIMS_SUPPORTED');
  }

  return { status, reasonCodes, missingRequiredConditionIds, unresolvedConflictIds, coreClaimIds };
}

export function evaluateAnswerSupport(input: EvaluateSupportInput): {
  readonly evaluatedClaims: readonly ClaimAnalysis[];
  readonly supportAnalysis: AnswerSupportAnalysis;
} {
  const evidenceMap = new Map<string, EvidenceItem>();
  for (const e of input.evidence) {
    evidenceMap.set(e.evidenceId, e);
    evidenceMap.set(e.eventId, e);
  }

  // 1. Evaluate individual claims
  const evaluatedClaims = input.claims.map((c) =>
    evaluateClaimSupport(c, evidenceMap, input.conflicts),
  );

  const aggregation = aggregateAnswerSupport({
    answerExists: input.answerExists,
    collectionCompleteness: input.collectionCompleteness,
    claims: evaluatedClaims,
    conflicts: input.conflicts,
    conditions: input.conditions,
    userRequiredConditionIds: input.userRequiredConditionIds ?? [],
    evidence: input.evidence,
  });

  const basis: DerivedBasis = {
    ruleId: 'five-rule-support-judge-v1',
    ruleVersion: '1.0.0',
    inputAnchors: input.inputAnchors,
    limitations: [
      'Evidence support judged against recorded schema-1 events under closed-world local trace evidence.',
      'Process exit 0 and agent-reported declarations do not elevate support status.',
      'Direct support requires admissible source-content (READ) evidence; activity-only records such as searches never ground a claim.',
      'User-required conditions are grounded only by admissible evidence carrying the identical parsed condition.',
    ],
  };

  return {
    evaluatedClaims,
    supportAnalysis: {
      status: aggregation.status,
      collectionCompleteness: input.collectionCompleteness,
      coreClaimIds: aggregation.coreClaimIds,
      evaluatedClaimIds: evaluatedClaims.map((c) => c.claimId),
      missingRequiredConditionIds: aggregation.missingRequiredConditionIds,
      unresolvedConflictIds: aggregation.unresolvedConflictIds,
      reasonCodes: aggregation.reasonCodes,
      basis,
    },
  };
}
