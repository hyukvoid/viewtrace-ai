/**
 * ViewTrace M3 JEV v2 Checkpoint Selector and Local Advisory Evaluator.
 *
 * Implements bounded semantic checkpoint selection (NEW_BRANCH, CONTRADICTION,
 * SOURCE_CONCENTRATION_THRESHOLD, NO_EVIDENCE_GAIN_WINDOW, PRE_RECOMMENDATION),
 * deduplication, cooldown, budget management with reserved capacity for
 * high-priority triggers (CONTRADICTION / PRE_RECOMMENDATION — a stagnation
 * stream must never starve them), and zero-network advisory evaluation.
 * Per docs/MILESTONES.md §8: JEV is advisory (supportEffect: NONE); evaluator
 * failure, timeout, or unavailability never impairs the base analysis report.
 *
 * The selector is a per-event state machine so the incremental engine can
 * resume it from a persisted snapshot; the batch export is a fold over the
 * same machine. The local evaluator is fully deterministic (labels derive
 * from the checkpoint delta and triggers only; no wall-clock measurement is
 * recorded for the local path so incremental and rebuild outputs are
 * byte-identical).
 */

import type {
  AnswerScope,
  AnalyzerIdentity,
  EvidenceItem,
  InputRevision,
  JevCheckpointV2,
  JevResultV2,
  JevTriggerReason,
} from '../analysis-types.js';
import { M3_JEV_CHECKPOINT_SCHEMA, M3_JEV_RESULT_SCHEMA } from '../analysis-types.js';
import type { ViewTraceEvent } from '../types.js';

export const JEV_SELECTOR_VERSION = '2.1.0';
export const JEV_EVALUATOR_VERSION = '2.1.0';
export const DEFAULT_MAX_CHECKPOINTS = 10;
export const DEFAULT_COOLDOWN_EVENTS = 3;
/** Slots reserved for high-priority triggers so low-priority spam cannot exhaust the budget. */
export const DEFAULT_RESERVED_HIGH_PRIORITY = 2;
export const NO_EVIDENCE_GAIN_THRESHOLD = 4;
/** Fires when reads of one canonical source reach this count AND the share threshold. */
export const CONCENTRATION_MIN_READS = 3;
export const CONCENTRATION_THRESHOLD = 0.6;
export const DEFAULT_EVALUATOR_TIMEOUT_MS = 5_000;

export function isHighPriorityTrigger(reasons: readonly JevTriggerReason[]): boolean {
  return reasons.includes('CONTRADICTION') || reasons.includes('PRE_RECOMMENDATION');
}

export interface JevSelectorFold {
  checkpoints: JevCheckpointV2[];
  results: JevResultV2[];
  /** Checkpoints created but not yet evaluated (engine flushes in order). */
  pendingEvaluation: JevCheckpointV2[];
  checkpointKeys: Set<string>;
  lastCheckpointSequence: number;
  lastAdmissibleEvidenceSeq: number;
  /** Fires once per stagnation window; reset when admissible evidence arrives. */
  noGainFired: boolean;
  sourceReadCounts: Map<string, number>;
  totalReads: number;
  lowPrioritySelected: number;
  highPrioritySelected: number;
}

export function createJevSelectorFold(): JevSelectorFold {
  return {
    checkpoints: [],
    results: [],
    pendingEvaluation: [],
    checkpointKeys: new Set(),
    lastCheckpointSequence: -999,
    lastAdmissibleEvidenceSeq: 0,
    noGainFired: false,
    sourceReadCounts: new Map(),
    totalReads: 0,
    lowPrioritySelected: 0,
    highPrioritySelected: 0,
  };
}

export interface JevConsiderInput {
  readonly event: ViewTraceEvent;
  /** The immediately preceding event (PRE_RECOMMENDATION fires when this event is a RECOMMEND). */
  readonly previousEvent?: { readonly eventId: string; readonly sequence: number };
  readonly evidenceForEvent?: EvidenceItem;
  readonly scope: AnswerScope;
  readonly analyzer: AnalyzerIdentity;
  /** Chain input revision as of this event (deterministic in both fold paths). */
  readonly revisionAtEvent: InputRevision;
  readonly maxCheckpoints: number;
  readonly cooldownEvents: number;
  readonly reservedHighPriority: number;
}

/**
 * Considers one event for checkpoint selection, mutating the fold. Mirrors
 * the streaming semantics: PRE_RECOMMENDATION anchors at the event
 * immediately preceding a RECOMMEND.
 */
export function considerJevCheckpoint(fold: JevSelectorFold, input: JevConsiderInput): void {
  const { event: ev, evidenceForEvent } = input;

  // Evidence-gain tracking
  if (evidenceForEvent && evidenceForEvent.admissibility === 'ADMISSIBLE') {
    fold.lastAdmissibleEvidenceSeq = ev.sequence;
    fold.noGainFired = false;
  }

  const triggers: JevTriggerReason[] = [];

  // 1. CONTRADICTION trigger (high priority)
  if (ev.type === 'CONTRADICTION') {
    triggers.push('CONTRADICTION');
  }

  // 2. NEW_BRANCH trigger (new search or new hypothesis)
  if (ev.type === 'SEARCH' || ev.type === 'HYPOTHESIS') {
    triggers.push('NEW_BRANCH');
  }

  // 3. SOURCE_CONCENTRATION_THRESHOLD trigger
  if (ev.type === 'READ') {
    fold.totalReads++;
    const srcId = evidenceForEvent?.sourceId ?? 'unknown';
    const c = (fold.sourceReadCounts.get(srcId) ?? 0) + 1;
    fold.sourceReadCounts.set(srcId, c);
    if (fold.totalReads >= CONCENTRATION_MIN_READS && c / fold.totalReads >= CONCENTRATION_THRESHOLD) {
      triggers.push('SOURCE_CONCENTRATION_THRESHOLD');
    }
  }

  // 4. NO_EVIDENCE_GAIN_WINDOW trigger — fires once per stagnation window
  // (re-firing for every event beyond the window is budget spam).
  if (
    !fold.noGainFired &&
    fold.lastAdmissibleEvidenceSeq > 0 &&
    ev.sequence - fold.lastAdmissibleEvidenceSeq >= NO_EVIDENCE_GAIN_THRESHOLD
  ) {
    triggers.push('NO_EVIDENCE_GAIN_WINDOW');
  }

  // 5. PRE_RECOMMENDATION trigger (high priority): anchored at the event
  // right before a RECOMMEND.
  if (ev.type === 'RECOMMEND' && input.previousEvent) {
    triggers.push('PRE_RECOMMENDATION');
  }

  if (triggers.length === 0) return;

  const highPriority = isHighPriorityTrigger(triggers);
  const totalSelected = fold.lowPrioritySelected + fold.highPrioritySelected;

  // Budget: total cap always applies; low-priority additionally capped at
  // (max - reserved) so high-priority triggers keep reserved capacity.
  if (totalSelected >= input.maxCheckpoints) return;
  if (!highPriority && fold.lowPrioritySelected >= Math.max(0, input.maxCheckpoints - input.reservedHighPriority)) {
    return;
  }

  // Checkpoint anchor: the event itself, except PRE_RECOMMENDATION which
  // anchors at the preceding event (the "직전" moment).
  const anchor = triggers.includes('PRE_RECOMMENDATION') && input.previousEvent
    ? { eventId: input.previousEvent.eventId, sequence: input.previousEvent.sequence }
    : { eventId: ev.eventId, sequence: ev.sequence };

  // Cooldown (low-priority only; high priority bypasses)
  if (!highPriority && anchor.sequence - fold.lastCheckpointSequence < input.cooldownEvents) {
    return;
  }

  // Deduplication: the same trigger at the same anchor is one checkpoint.
  const deduplicationKey = `jev-ck-${input.scope.runId}-${triggers[0]}-${anchor.sequence}`;
  if (fold.checkpointKeys.has(deduplicationKey)) return;

  const fromSeq = Math.max(0, fold.lastCheckpointSequence);
  const deltaEvents = [anchor.eventId];

  if (triggers.includes('NO_EVIDENCE_GAIN_WINDOW')) {
    fold.noGainFired = true;
  }

  const checkpoint: JevCheckpointV2 = {
    schema: M3_JEV_CHECKPOINT_SCHEMA,
    checkpointId: `jev-ck-${input.scope.answerId}-${anchor.sequence}-${triggers[0]!.toLowerCase()}`,
    deduplicationKey,
    selectorVersion: JEV_SELECTOR_VERSION,
    analyzer: input.analyzer,
    inputRevision: input.revisionAtEvent,
    scope: input.scope,
    triggerReasons: triggers,
    delta: {
      fromSequenceExclusive: fromSeq,
      toSequenceInclusive: anchor.sequence,
      eventIds: deltaEvents,
      evidenceIds: evidenceForEvent ? [evidenceForEvent.evidenceId] : [],
    },
    budget: {
      ordinal: totalSelected + 1,
      maxCheckpoints: input.maxCheckpoints,
      cooldownEvents: input.cooldownEvents,
    },
  };

  fold.checkpoints.push(checkpoint);
  fold.checkpointKeys.add(deduplicationKey);
  fold.pendingEvaluation.push(checkpoint);
  if (highPriority) fold.highPrioritySelected++;
  else fold.lowPrioritySelected++;
  fold.lastCheckpointSequence = anchor.sequence;
}

export interface SelectCheckpointsInput {
  readonly events: readonly ViewTraceEvent[];
  readonly evidence: readonly EvidenceItem[];
  readonly scope: AnswerScope;
  readonly analyzer: AnalyzerIdentity;
  readonly inputRevision: InputRevision;
  readonly maxCheckpoints?: number;
  readonly cooldownEvents?: number;
  readonly reservedHighPriority?: number;
}

/** Batch fold over the per-event selector machine (delta events must be sequence-sorted). */
export function selectJevCheckpoints(input: SelectCheckpointsInput): readonly JevCheckpointV2[] {
  const fold = createJevSelectorFold();
  const evidenceMap = new Map<string, EvidenceItem>();
  for (const e of input.evidence) {
    evidenceMap.set(e.eventId, e);
  }
  const analyzer = input.analyzer;
  const sorted = [...input.events].sort((a, b) => a.sequence - b.sequence);
  let previous: { eventId: string; sequence: number } | undefined;
  for (const ev of sorted) {
    considerJevCheckpoint(fold, {
      event: ev,
      previousEvent: previous,
      evidenceForEvent: evidenceMap.get(ev.eventId),
      scope: input.scope,
      analyzer,
      revisionAtEvent: input.inputRevision,
      maxCheckpoints: input.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS,
      cooldownEvents: input.cooldownEvents ?? DEFAULT_COOLDOWN_EVENTS,
      reservedHighPriority: input.reservedHighPriority ?? DEFAULT_RESERVED_HIGH_PRIORITY,
    });
    previous = { eventId: ev.eventId, sequence: ev.sequence };
  }
  return fold.checkpoints;
}

export type JevLabels = {
  readonly evidenceGain: 'YES' | 'NO' | 'UNKNOWN';
  readonly progress: 'YES' | 'NO' | 'UNKNOWN';
  readonly rethinkNeeded: 'YES' | 'NO' | 'UNKNOWN';
};

/**
 * Synchronous local evaluator. Deterministic: labels derive from the
 * checkpoint's recorded delta and triggers only. Any structural defect in
 * the checkpoint yields FAILED, isolating evaluator faults from the report.
 */
export function evaluateCheckpointLocal(
  checkpoint: JevCheckpointV2,
  evidenceItems: readonly EvidenceItem[],
): JevResultV2 {
  try {
    const evidenceMap = new Map<string, EvidenceItem>();
    for (const e of evidenceItems) {
      evidenceMap.set(e.evidenceId, e);
    }

    let hasAdmissible = false;
    for (const eid of checkpoint.delta.evidenceIds) {
      const item = evidenceMap.get(eid);
      if (item && item.admissibility === 'ADMISSIBLE') {
        hasAdmissible = true;
        break;
      }
    }

    const hasContradiction = checkpoint.triggerReasons.includes('CONTRADICTION');
    const isConcentrationExcess = checkpoint.triggerReasons.includes('SOURCE_CONCENTRATION_THRESHOLD');
    const isNoGain = checkpoint.triggerReasons.includes('NO_EVIDENCE_GAIN_WINDOW');

    const evidenceGain: JevLabels['evidenceGain'] = hasAdmissible ? 'YES' : 'NO';
    const progress: JevLabels['progress'] = hasAdmissible && !hasContradiction ? 'YES' : 'NO';
    const rethinkNeeded: JevLabels['rethinkNeeded'] =
      hasContradiction || (isConcentrationExcess && isNoGain) ? 'YES' : 'NO';

    return {
      schema: M3_JEV_RESULT_SCHEMA,
      resultId: `jev-res-${checkpoint.checkpointId}`,
      checkpointId: checkpoint.checkpointId,
      inputRevision: checkpoint.inputRevision,
      evaluator: {
        provider: 'local-deterministic-stub',
        evaluatorVersion: JEV_EVALUATOR_VERSION,
      },
      status: 'SUCCEEDED',
      labels: {
        evidenceGain,
        progress,
        rethinkNeeded,
      },
      provenance: 'EVALUATOR_REPORTED',
      supportEffect: 'NONE',
      limitations: [
        'Advisory JEV v2 checkpoint evaluation computed locally without external LLM inference.',
        'Labels indicate observable delta gain and do not alter authoritative evidence support.',
        'Local evaluation records no wall-clock measurement so that incremental and rebuild outputs stay identical; engine-level latency is measured externally by the caller.',
      ],
    };
  } catch (err) {
    return failedResult(checkpoint, `Evaluator failed: ${String(err)}`);
  }
}

function baseResult(checkpoint: JevCheckpointV2): Pick<JevResultV2, 'schema' | 'resultId' | 'checkpointId' | 'inputRevision' | 'evaluator' | 'provenance' | 'supportEffect'> {
  return {
    schema: M3_JEV_RESULT_SCHEMA,
    resultId: `jev-res-${checkpoint.checkpointId}`,
    checkpointId: checkpoint.checkpointId,
    inputRevision: checkpoint.inputRevision,
    evaluator: {
      provider: 'local-deterministic-stub',
      evaluatorVersion: JEV_EVALUATOR_VERSION,
    },
    provenance: 'EVALUATOR_REPORTED',
    supportEffect: 'NONE',
  };
}

function failedResult(checkpoint: JevCheckpointV2, message: string): JevResultV2 {
  return {
    ...baseResult(checkpoint),
    status: 'FAILED',
    limitations: [message],
  };
}

export type JevEvaluatorFn = (checkpoint: JevCheckpointV2, deltaEvidence: readonly EvidenceItem[]) => JevLabels | Promise<JevLabels>;

export interface JevEvaluationOptions {
  /** Custom evaluator; defaults to the local deterministic stub. */
  readonly evaluator?: JevEvaluatorFn;
  /** Per-checkpoint evaluation timeout (guarded even for async evaluators). */
  readonly timeoutMs?: number;
  /** Explicitly marked unavailable (e.g. opt-in external evaluator not configured). */
  readonly unavailable?: boolean;
  readonly provider?: string;
}

const LABEL_VALUES = new Set(['YES', 'NO', 'UNKNOWN']);

/**
 * Runtime schema check for evaluator output: an injected evaluator is an
 * untrusted boundary, so its labels are only trusted after passing the same
 * shape the local evaluator guarantees (exactly the three label keys, each
 * within the allowed enum). Anything else is isolated as FAILED.
 */
export function isValidJevLabels(labels: unknown): labels is JevLabels {
  if (typeof labels !== 'object' || labels === null) return false;
  const keys = Object.keys(labels);
  if (keys.length !== 3) return false;
  const l = labels as Record<string, unknown>;
  return (
    keys.includes('evidenceGain') &&
    keys.includes('progress') &&
    keys.includes('rethinkNeeded') &&
    LABEL_VALUES.has(String(l.evidenceGain)) &&
    LABEL_VALUES.has(String(l.progress)) &&
    LABEL_VALUES.has(String(l.rethinkNeeded))
  );
}

function resultFromLabels(
  checkpoint: JevCheckpointV2,
  labels: JevLabels,
  provider: string,
): JevResultV2 {
  return {
    ...baseResult(checkpoint),
    evaluator: { provider, evaluatorVersion: JEV_EVALUATOR_VERSION },
    status: 'SUCCEEDED',
    labels,
    limitations: [
      'Advisory JEV v2 evaluation; labels never alter authoritative evidence support.',
    ],
  };
}

/**
 * Evaluates one checkpoint with failure isolation: UNAVAILABLE when the
 * evaluator is explicitly not configured, TIMED_OUT past the budget, FAILED
 * on evaluator error — the base report stays intact in every case.
 */
export async function evaluateCheckpointGuarded(
  checkpoint: JevCheckpointV2,
  deltaEvidence: readonly EvidenceItem[],
  options: JevEvaluationOptions = {},
): Promise<JevResultV2> {
  if (options.unavailable) {
    return {
      ...baseResult(checkpoint),
      evaluator: options.provider
        ? { provider: options.provider, evaluatorVersion: JEV_EVALUATOR_VERSION }
        : baseResult(checkpoint).evaluator,
      status: 'UNAVAILABLE',
      limitations: ['No JEV evaluator is configured; the evaluation was not run.'],
    };
  }
  const evaluator = options.evaluator;
  if (!evaluator) {
    return evaluateCheckpointLocal(checkpoint, deltaEvidence);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_EVALUATOR_TIMEOUT_MS;
  try {
    const labels = await Promise.race([
      Promise.resolve(evaluator(checkpoint, deltaEvidence)),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error(`JEV evaluation timed out after ${timeoutMs}ms`)), timeoutMs);
        if (typeof t === 'object' && t && 'unref' in t) t.unref();
      }),
    ]);
    if (!isValidJevLabels(labels)) {
      return failedResult(
        checkpoint,
        `Evaluator returned labels that fail the JEV v2 output schema: ${JSON.stringify(labels)}`,
      );
    }
    return resultFromLabels(checkpoint, labels, options.provider ?? 'custom-injected-evaluator');
  } catch (err) {
    const message = String(err);
    if (message.includes('timed out')) {
      return {
        ...baseResult(checkpoint),
        status: 'TIMED_OUT',
        limitations: [message],
      };
    }
    return failedResult(checkpoint, `Evaluator failed: ${message}`);
  }
}

/** Marks persisted results whose checkpoint delta was invalidated as STALE (kept for history, never trusted). */
export function markJevResultStale(result: JevResultV2, reason: string): JevResultV2 {
  return {
    ...result,
    status: 'STALE',
    limitations: [...result.limitations, `Superseded: ${reason}`],
  };
}
