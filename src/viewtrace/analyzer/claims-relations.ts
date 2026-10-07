/**
 * ViewTrace M3 Claim Extraction, Conditions, Evidence Admissibility and Relations Engine.
 *
 * Implements claim extraction with provenance, condition dimensional
 * decomposition (preserving the raw dimension token so per-dimension value
 * agreement can be judged), evidence admissibility adjudication (forged
 * observed, missing anchors, reported-only claims), source-content grounding
 * classification, and the relational link graph.
 *
 * Admissibility honesty (§8): an event can be ADMISSIBLE evidence that an
 * activity happened while being ACTIVITY_ONLY for direct claim support. Only
 * successful READ records (observed source content) carry
 * grounding=SOURCE_CONTENT; agent-declared SUPPORTS edges to non-grounding
 * events never count as direct support.
 */

import { createHash } from 'node:crypto';
import type {
  AnalysisAnchor,
  AnalysisRelation,
  ClaimAnalysis,
  Condition,
  ConditionDimension,
  ConditionOperator,
  EvidenceExtensionV1,
  EvidenceItem,
  ProvenanceIntegrity,
  SourceLedgerEntry,
} from '../analysis-types.js';
import type {
  ClaimPayload,
  ComparePayload,
  DomainPayload,
  ProvenanceCategory,
  ReadPayload,
  RecommendationPayload,
  ViewTraceEvent,
} from '../types.js';

/** Parsed condition plus the raw dimension token used for equality grouping. */
export interface ParsedCondition {
  readonly condition: Condition;
  readonly dimensionKey: string;
}

const DIMENSION_TOKEN_MAP: readonly [readonly string[], ConditionDimension][] = [
  [['TIME', 'DATE', 'YEAR', 'PERIOD'], 'TIME'],
  [['REGION', 'COUNTRY', 'LOC', 'GEO'], 'REGION'],
  [['VERSION', 'VER'], 'VERSION'],
  [['ENV', 'OS', 'PLATFORM'], 'ENVIRONMENT'],
  [['USER', 'REQ'], 'USER_REQUIREMENT'],
  [['POP', 'SAMPLE'], 'POPULATION'],
  [['SUBJ', 'TARGET'], 'SUBJECT'],
];

export function parseConditionDetailed(
  raw: string,
  anchor: AnalysisAnchor,
  provenance: ProvenanceCategory,
): ParsedCondition {
  const trimmed = raw.trim();
  let dimension: ConditionDimension = 'OTHER';
  let operator: ConditionOperator = 'EQ';
  let value = trimmed;
  let rawDim = '';

  // Simple parsing of standard patterns: "dim:val", "dim=val", "dim>=val"
  const m = /^([a-zA-Z_-]+)\s*(==|=|!=|>=|<=|>|<|in|before|after|at)\s*(.+)$/i.exec(trimmed);
  if (m) {
    rawDim = m[1]!.toLowerCase();
    const rawDimUpper = m[1]!.toUpperCase();
    const rawOp = m[2]!.toLowerCase();
    value = m[3]!.trim();
    dimension = 'OTHER';
    for (const [tokens, dim] of DIMENSION_TOKEN_MAP) {
      if (tokens.some((t) => rawDimUpper.includes(t))) {
        dimension = dim;
        break;
      }
    }

    if (rawOp === '=' || rawOp === '==') operator = 'EQ';
    else if (rawOp === '!=') operator = 'NEQ';
    else if (rawOp === 'in') operator = 'IN';
    else if (rawOp === 'before' || rawOp === '<' || rawOp === '<=') operator = 'BEFORE';
    else if (rawOp === 'after' || rawOp === '>' || rawOp === '>=') operator = 'AFTER';
    else if (rawOp === 'at') operator = 'AT';
  } else {
    // Check keywords in text
    const lower = trimmed.toLowerCase();
    const prefixMap: readonly [readonly string[], ConditionDimension][] = [
      [['time:', 'year:', 'date:'], 'TIME'],
      [['env:', 'os:'], 'ENVIRONMENT'],
      [['ver:', 'version:'], 'VERSION'],
      [['region:', 'geo:'], 'REGION'],
      [['user:', 'req:'], 'USER_REQUIREMENT'],
    ];
    for (const [prefixes, dim] of prefixMap) {
      if (prefixes.some((p) => lower.startsWith(p))) {
        dimension = dim;
        rawDim = lower.slice(0, lower.indexOf(':'));
        value = trimmed.replace(/^[^:]+:\s*/, '');
        break;
      }
    }
  }

  // The dimension key preserves the raw token for OTHER dimensions so that
  // "workload=standard" and "workload=high" group together while
  // "workload=standard" and "concurrency=100" stay independent conditions.
  const dimensionKey =
    dimension === 'OTHER' && rawDim ? `other:${rawDim}` : dimension.toLowerCase();

  const hash = createHash('sha256').update(`${dimensionKey}:${operator}:${value}`).digest('hex').slice(0, 12);
  const conditionId = `cond-${dimensionKey.replace(/[^a-z0-9-]/g, '-')}-${hash}`;

  const condition: Condition = {
    conditionId,
    dimension,
    operator,
    value,
    provenance,
    anchors: [anchor],
    basis:
      provenance === 'VIEWTRACE_INFERRED'
        ? {
            ruleId: 'condition-extraction-v1',
            ruleVersion: '1.0.0',
            inputAnchors: [anchor],
            limitations: ['Condition dimension parsed from raw constraint token.'],
          }
        : undefined,
  };
  return { condition, dimensionKey };
}

export function parseConditionString(
  raw: string,
  anchor: AnalysisAnchor,
  provenance: ProvenanceCategory,
): Condition {
  return parseConditionDetailed(raw, anchor, provenance).condition;
}

export interface ExtractedClaimsAndEvidence {
  readonly conditions: readonly Condition[];
  readonly evidence: readonly EvidenceItem[];
  readonly claims: readonly ClaimAnalysis[];
  readonly relations: readonly AnalysisRelation[];
  readonly userRequiredConditionIds: readonly string[];
}

/**
 * Adjudicates one event into an EvidenceItem. `sourceEntryKnown` tells
 * whether the event's source could be resolved against the ledger *at this
 * point*; a READ whose source registers later is re-adjudicated by the
 * incremental engine (dependency invalidation), which is why UNKNOWN is an
 * honest intermediate state.
 */
export function adjudicateEvidenceItem(
  ev: ViewTraceEvent,
  resolveCanonicalSource: (ev: ViewTraceEvent) => { canonicalId?: string; entry?: SourceLedgerEntry },
): EvidenceItem {
  const claimedProv = ev.provenance.category;
  let effectiveProv = claimedProv;
  let integrity: ProvenanceIntegrity = 'ACCEPTED';
  const limitations: string[] = [];

  const hasObservedLocation =
    ev.provenance.observed &&
    (ev.provenance.observed.file ||
      ev.provenance.observed.toolCallId ||
      ev.provenance.observed.toolResultId ||
      ev.provenance.observed.recordId);

  if (claimedProv === 'VIEWTRACE_OBSERVED' && !hasObservedLocation) {
    integrity = 'FORGED_OBSERVED';
    effectiveProv = 'VIEWTRACE_INFERRED';
    limitations.push('Claimed VIEWTRACE_OBSERVED without tool/file observation locator.');
  } else if (claimedProv === 'AGENT_REPORTED') {
    integrity = 'REPORTED_ONLY';
    limitations.push('Agent-reported statement; not independently observed by ViewTrace.');
  }

  const { canonicalId: sourceId, entry: sourceEntry } = resolveCanonicalSource(ev);

  let sourceResolved = true;
  if (ev.type === 'READ' && !sourceEntry) {
    integrity = integrity === 'ACCEPTED' ? 'MISSING_ANCHOR' : integrity;
    sourceResolved = false;
    limitations.push('Referenced source not found in captured source references.');
  } else if (sourceEntry && sourceEntry.identityStatus === 'SPOOF_SUSPECTED') {
    limitations.push('Associated source is marked SPOOF_SUSPECTED.');
  }

  let admissibility: 'ADMISSIBLE' | 'INADMISSIBLE' | 'UNKNOWN' = 'ADMISSIBLE';
  if (integrity === 'FORGED_OBSERVED' || integrity === 'MISSING_ANCHOR') {
    admissibility = 'INADMISSIBLE';
  } else if (sourceEntry && sourceEntry.identityStatus === 'SPOOF_SUSPECTED') {
    admissibility = 'INADMISSIBLE';
  } else if (ev.type === 'READ') {
    const rp = ev.payload as ReadPayload;
    if (rp.outcome === 'FAILED' || rp.outcome === 'CANCELLED') {
      admissibility = 'INADMISSIBLE';
      limitations.push(`Read outcome is ${rp.outcome}.`);
    }
  } else if (ev.type === 'CLAIM' || ev.type === 'RECOMMEND') {
    if (claimedProv === 'AGENT_REPORTED') {
      admissibility = 'INADMISSIBLE';
      limitations.push('Agent-reported declarations do not constitute independent admissible evidence.');
    }
  }

  // Grounding: only a successful (admissible) READ of a captured source
  // carries source content usable as *direct* claim support.
  let grounding: EvidenceItem['grounding'] = 'ACTIVITY_ONLY';
  if (ev.type === 'READ') {
    if (!sourceResolved) grounding = 'UNKNOWN';
    else grounding = admissibility === 'ADMISSIBLE' ? 'SOURCE_CONTENT' : 'ACTIVITY_ONLY';
  }

  const itemConditions: string[] = [];
  if (ev.type === 'CONTRADICTION') {
    const cp = ev.payload as { conditions?: readonly string[] };
    for (const cond of cp.conditions ?? []) {
      itemConditions.push(
        parseConditionDetailed(cond, { runId: ev.runId, eventId: ev.eventId }, ev.provenance.category)
          .condition.conditionId,
      );
    }
  }

  return {
    evidenceId: `ev-${ev.eventId}`,
    eventId: ev.eventId,
    sourceId,
    claimedProvenance: claimedProv,
    effectiveProvenance: effectiveProv,
    provenanceIntegrity: integrity,
    conditionIds: itemConditions,
    admissibility,
    grounding,
    limitations,
  };
}

/** Registers conditions declared by a RECOMMEND payload as user requirements. */
export function userConditionIdsFromRecommend(
  rec: ViewTraceEvent,
  register: (raw: string, anchor: AnalysisAnchor, prov: ProvenanceCategory) => string,
): string[] {
  const rp = rec.payload as RecommendationPayload;
  const ids: string[] = [];
  for (const cond of rp.userConditions ?? []) {
    ids.push(register(cond, { runId: rec.runId, eventId: rec.eventId }, rec.provenance.category));
  }
  return ids;
}

/**
 * Batch wrapper over the per-event extraction rules. The incremental engine
 * applies the same per-event functions with a growing ledger; this function
 * is kept for direct unit use with a precomputed ledger.
 */
export function extractClaimsAndRelations(
  events: readonly ViewTraceEvent[],
  sources: readonly SourceLedgerEntry[],
  extensions: readonly EvidenceExtensionV1[] = [],
): ExtractedClaimsAndEvidence {
  const conditionsMap = new Map<string, Condition>();
  const userRequiredConditionIds = new Set<string>();
  const sourceByCapturedId = new Map<string, SourceLedgerEntry>();
  for (const s of sources) {
    for (const cid of s.capturedSourceIds) {
      sourceByCapturedId.set(cid, s);
    }
  }

  const extensionMap = new Map<string, EvidenceExtensionV1>();
  for (const ext of extensions) {
    extensionMap.set(ext.eventId, ext);
    if (ext.conditions) {
      for (const c of ext.conditions) {
        conditionsMap.set(c.conditionId, c);
      }
    }
  }

  function registerCondition(raw: string, anchor: AnalysisAnchor, prov: ProvenanceCategory): string {
    const c = parseConditionDetailed(raw, anchor, prov).condition;
    if (!conditionsMap.has(c.conditionId)) {
      conditionsMap.set(c.conditionId, c);
    }
    return c.conditionId;
  }

  // 1. Evidence Items
  const evidenceItems: EvidenceItem[] = [];
  const evidenceByEventId = new Map<string, EvidenceItem>();
  const resolveCanonicalSource = (ev: ViewTraceEvent) => {
    let sourceId: string | undefined = undefined;
    if (ev.source?.sourceId) {
      sourceId = sourceByCapturedId.get(ev.source.sourceId)?.canonicalSourceId ?? ev.source.sourceId;
    } else if (ev.type === 'READ') {
      const rp = ev.payload as ReadPayload;
      sourceId = sourceByCapturedId.get(rp.sourceId)?.canonicalSourceId ?? rp.sourceId;
    }
    return {
      canonicalId: sourceId,
      entry: sourceId ? sources.find((s) => s.canonicalSourceId === sourceId) : undefined,
    };
  };

  for (const ev of events) {
    let item = adjudicateEvidenceItem(ev, resolveCanonicalSource);
    const ext = extensionMap.get(ev.eventId);
    if (ext?.conditions && ext.conditions.length > 0) {
      const extIds = ext.conditions.map((c) => {
        if (!conditionsMap.has(c.conditionId)) conditionsMap.set(c.conditionId, c);
        return c.conditionId;
      });
      item = { ...item, conditionIds: [...item.conditionIds, ...extIds] };
    }
    evidenceItems.push(item);
    evidenceByEventId.set(ev.eventId, item);
  }

  // 2. Claim Extraction
  const claims: ClaimAnalysis[] = [];
  const relations: AnalysisRelation[] = [];

  const rationaleEventIds = new Set<string>();
  const recommendEvents = events.filter((e) => e.type === 'RECOMMEND');
  for (const rec of recommendEvents) {
    const rp = rec.payload as RecommendationPayload;
    for (const eid of rp.rationaleEventIds ?? []) {
      rationaleEventIds.add(eid);
    }
    for (const id of userConditionIdsFromRecommend(rec, registerCondition)) {
      userRequiredConditionIds.add(id);
    }
  }

  // Grounding evidence per canonical source (re-reads deduplicated: first read wins)
  const readEvidenceByCanonical = new Map<string, string>();
  for (const ev of events) {
    if (ev.type === 'READ') {
      const rp = ev.payload as ReadPayload;
      const eItem = evidenceByEventId.get(ev.eventId);
      if (!eItem || eItem.admissibility !== 'ADMISSIBLE' || eItem.grounding !== 'SOURCE_CONTENT') continue;
      const canonical = eItem.sourceId;
      if (canonical && !readEvidenceByCanonical.has(canonical)) {
        readEvidenceByCanonical.set(canonical, eItem.evidenceId);
      }
    }
  }

  const claimsByEventId = new Map<string, ClaimAnalysis[]>();

  function pushClaim(claim: ClaimAnalysis, eventId: string): void {
    claims.push(claim);
    const list = claimsByEventId.get(eventId) ?? [];
    list.push(claim);
    claimsByEventId.set(eventId, list);
  }

  for (const ev of events) {
    const anchor: AnalysisAnchor = { runId: ev.runId, eventId: ev.eventId };

    if (ev.type === 'CLAIM') {
      const cp = ev.payload as ClaimPayload;
      const claimId = `claim-${ev.eventId}`;
      const isCore = rationaleEventIds.has(ev.eventId) || recommendEvents.length === 0;

      const claimConditions: string[] = [];
      const supportingEvidence: string[] = [];

      // Direct source grounding (deduplicated per canonical source)
      const canonical = cp.sourceId
        ? sourceByCapturedId.get(cp.sourceId)?.canonicalSourceId ?? cp.sourceId
        : undefined;
      if (canonical) {
        const matching = readEvidenceByCanonical.get(canonical);
        if (matching) supportingEvidence.push(matching);
      }

      // Declared SUPPORTS relations only count when the target is
      // source-content grounded and admissible.
      if (ev.relations) {
        for (const rel of ev.relations) {
          const targetItem = evidenceByEventId.get(rel.targetEventId);
          if (
            rel.type === 'SUPPORTS' &&
            targetItem &&
            targetItem.admissibility === 'ADMISSIBLE' &&
            targetItem.grounding === 'SOURCE_CONTENT'
          ) {
            supportingEvidence.push(targetItem.evidenceId);
          }
        }
      }

      pushClaim(
        {
          claimId,
          text: cp.text,
          importance: isCore ? 'CORE' : 'SUPPORTING',
          provenance: ev.provenance.category,
          anchors: [anchor],
          conditionIds: claimConditions,
          support: 'UNKNOWN',
          supportingEvidenceIds: Array.from(new Set(supportingEvidence)),
          opposingEvidenceIds: [],
          unresolvedReasonIds: [],
          basis: {
            ruleId: 'claim-extraction-v1',
            ruleVersion: '1.0.0',
            inputAnchors: [anchor],
            limitations: ['Extracted from schema-1 CLAIM event payload.'],
          },
        },
        ev.eventId,
      );

      if (canonical) {
        relations.push({
          relationId: `rel-${claimId}-${canonical}-cites`,
          type: 'CITES',
          fromId: claimId,
          toId: canonical,
          evidenceIds: supportingEvidence,
          conditionIds: claimConditions,
          provenance: ev.provenance.category,
        });
      }
    } else if (ev.type === 'COMPARE') {
      const cmp = ev.payload as ComparePayload;
      for (const cell of cmp.cells) {
        if (cell.value !== null && cell.value !== undefined) {
          const cellClaimId = `claim-${ev.eventId}-${cell.candidate}-${cell.criterion}`;
          const cellEvIds: string[] = [];
          for (const eid of cell.evidenceEventIds ?? []) {
            const eItem = evidenceByEventId.get(eid);
            if (
              eItem &&
              eItem.admissibility === 'ADMISSIBLE' &&
              eItem.grounding === 'SOURCE_CONTENT'
            ) {
              cellEvIds.push(eItem.evidenceId);
            }
          }

          pushClaim(
            {
              claimId: cellClaimId,
              text: `${cell.candidate} [${cell.criterion}]: ${cell.value}`,
              importance: recommendEvents.length === 0 ? 'CORE' : 'SUPPORTING',
              provenance: ev.provenance.category,
              anchors: [anchor],
              conditionIds: [],
              support: 'UNKNOWN',
              supportingEvidenceIds: cellEvIds,
              opposingEvidenceIds: [],
              unresolvedReasonIds: [],
              basis: {
                ruleId: 'claim-extraction-v1',
                ruleVersion: '1.0.0',
                inputAnchors: [anchor],
                limitations: ['Extracted from schema-1 COMPARE cell; value is the recorded observation.'],
              },
            },
            ev.eventId,
          );

          relations.push({
            relationId: `rel-${cellClaimId}-compared`,
            type: 'COMPARED',
            fromId: cell.candidate,
            toId: cell.criterion,
            evidenceIds: cellEvIds,
            conditionIds: [],
            provenance: ev.provenance.category,
          });
        }
      }
    } else if (ev.type === 'RECOMMEND') {
      const rp = ev.payload as RecommendationPayload;
      const recClaimId = `claim-${ev.eventId}-recommendation`;
      const userCondIds = userConditionIdsFromRecommend(ev, registerCondition);
      pushClaim(
        {
          claimId: recClaimId,
          text: `Recommended: ${rp.choice}`,
          importance: 'CORE',
          provenance: ev.provenance.category,
          anchors: [anchor],
          conditionIds: userCondIds,
          support: 'UNKNOWN',
          supportingEvidenceIds: [],
          opposingEvidenceIds: [],
          unresolvedReasonIds: [],
          basis: {
            ruleId: 'claim-extraction-v1',
            ruleVersion: '1.0.0',
            inputAnchors: [anchor],
            limitations: ['Extracted from schema-1 RECOMMEND event payload.'],
          },
        },
        ev.eventId,
      );
    }

    // Preserve declared event relations
    if (ev.relations) {
      for (const r of ev.relations) {
        relations.push({
          relationId: `rel-${ev.eventId}-${r.targetEventId}-${r.type.toLowerCase()}`,
          type: r.type,
          fromId: ev.eventId,
          toId: r.targetEventId,
          evidenceIds: [`ev-${ev.eventId}`],
          conditionIds: [],
          provenance: ev.provenance.category,
        });
      }
    }
  }

  return {
    conditions: Array.from(conditionsMap.values()),
    evidence: evidenceItems,
    claims,
    relations,
    userRequiredConditionIds: Array.from(userRequiredConditionIds),
  };
}
