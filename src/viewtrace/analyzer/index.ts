/**
 * ViewTrace M3 Incremental Evidence Analyzer & JEV v2 Orchestrator.
 *
 * Two genuinely distinct execution paths share the fold rules
 * (see ./fold.ts):
 *
 *  - `analyzeAnswer` (INCREMENTAL): loads the persisted per-(run, answer)
 *    analysis state, fetches only unprocessed scoped events from the store,
 *    folds the delta, re-evaluates only dependency-invalidated claims, and
 *    persists the updated state + report. Measured stats are returned so
 *    delta scope (events examined, claims re-evaluated, JEV calls) can be
 *    asserted, not assumed.
 *  - `rebuildAnalysis` (FULL REBUILD): ignores persisted state, folds the
 *    complete scoped input from scratch, and does not persist. Identical
 *    inputs must yield an identical report — the acceptance oracle compares
 *    these two paths.
 *
 * `analyzeEvents` is the pure in-memory entry (fresh fold, no persistence).
 *
 * Freshness (§8 "report stale 표시"): `checkAnalysisFreshness` compares the
 * persisted input signature (scoped event extent + completeness + analyzer
 * identity) against the store; serving paths recompute instead of serving
 * stale bodies.
 */

import type {
  AnalysisInputSignature,
  AnalysisMode,
  AnalysisReportV1,
  AnalysisRunStats,
  AnswerScope,
  EvidenceExtensionV1,
  IncrementalAnalysisStateV1,
  ReportFreshness,
} from '../analysis-types.js';
import { M3_INCREMENTAL_STATE_SCHEMA } from '../analysis-types.js';
import type { CollectionCompleteness, ViewTraceEvent } from '../types.js';
import type { ViewTraceStore } from '../store.js';
import type { JevEvaluationOptions } from './jev-selector.js';
import {
  AnalysisFold,
  finalizeFoldReport,
  runStatsOf,
  type FoldEngineOptions,
} from './fold.js';
import {
  checkScopeCompatibility,
  computeInputRevision,
  computeStateRevision,
  defaultAnalyzerIdentity,
  scopeIdsHash,
  signatureMatches,
} from './incremental.js';

export interface AnalyzeOptions {
  readonly answerId?: string;
  readonly receiptId?: string;
  readonly questionSummary?: string;
  readonly overrideMode?: AnalysisMode;
  readonly domain?: string;
  readonly collectionCompleteness?: CollectionCompleteness;
  readonly extensions?: readonly EvidenceExtensionV1[];
  readonly enableJev?: boolean;
  readonly maxJevCheckpoints?: number;
  readonly ownEventIds?: readonly string[];
  readonly sharedEventIds?: readonly string[];
  /** JEV evaluator configuration (guarded evaluation, timeouts, unavailability). */
  readonly jev?: JevEvaluationOptions;
}

export interface AnalyzeResult {
  readonly report: AnalysisReportV1;
  readonly stats: AnalysisRunStats;
}

/** Pure in-memory analysis: fresh fold over the given events, no persistence. */
export function analyzeEvents(
  events: readonly ViewTraceEvent[],
  options: AnalyzeOptions = {},
): AnalysisReportV1 {
  const analyzer = defaultAnalyzerIdentity();
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  const runId = sorted[0]?.runId ?? 'run-unknown';
  const answerId = options.answerId ?? 'ans-default';
  const receiptId = options.receiptId ?? `rec-${answerId}`;

  const scope: AnswerScope = {
    runId,
    answerId,
    receiptId,
    boundary: options.ownEventIds ? 'EXACT' : 'UNKNOWN',
    ownEventIds: options.ownEventIds,
    sharedEventIds: options.sharedEventIds,
  };

  const fold = AnalysisFold.create({
    scope,
    analyzer,
    extensions: options.extensions,
    enableJev: options.enableJev,
    maxJevCheckpoints: options.maxJevCheckpoints,
  } satisfies FoldEngineOptions);
  for (const ev of sorted) fold.applyEvent(ev);
  fold.flushJevSync(options.jev?.unavailable === true);

  const { report } = finalizeFoldReport(fold, {
    questionSummary: options.questionSummary,
    overrideMode: options.overrideMode,
    domain: options.domain,
    collectionCompleteness: options.collectionCompleteness ?? 'COMPLETE',
  });
  return report;
}

function buildAnswerScope(
  runId: string,
  answerId: string,
  receipt: { receiptId: string; eventIds?: readonly string[]; sharedEventIds?: readonly string[] },
): { scope: AnswerScope; scopeIds: string[] | undefined; exact: boolean } {
  const exact = Array.isArray(receipt.eventIds);
  const scopeIds = exact
    ? Array.from(new Set([...receipt.eventIds!, ...(receipt.sharedEventIds ?? [])]))
    : undefined;
  return {
    scope: {
      runId,
      answerId,
      receiptId: receipt.receiptId,
      // An explicitly empty eventIds list means "no observed events in this
      // turn's scope" — never a fall-back to the whole run container.
      boundary: exact && receipt.eventIds!.length > 0 ? 'EXACT' : 'UNKNOWN',
      ownEventIds: exact ? receipt.eventIds : undefined,
      sharedEventIds: receipt.sharedEventIds,
    },
    scopeIds,
    exact,
  };
}

function stateFor(
  fold: AnalysisFold,
  inputSignature: AnalysisInputSignature,
  invalidations: readonly import('../analysis-types.js').InvalidationEntry[],
): IncrementalAnalysisStateV1 {
  const snapshot = fold.snapshot();
  const inputRevision = {
    algorithm: 'sha256-canonical-schema1-records-v1' as const,
    value: snapshot.inputChain.value,
    recordCount: snapshot.inputChain.recordCount,
  };
  return {
    schema: M3_INCREMENTAL_STATE_SCHEMA,
    captureSchemaVersion: 1,
    analyzer: fold.options.analyzer,
    inputRevision,
    stateRevision: computeStateRevision({
      inputRevision,
      analyzer: fold.options.analyzer,
      cursors: [
        {
          runId: fold.runId,
          processedThroughSequence: fold.cursor,
          processedRecordCount: fold.processedEventIds.length,
        },
      ],
      collectionCompleteness: inputSignature.collectionCompleteness,
      scopeIdsHash: scopeIdsHash(fold.options.scope.ownEventIds),
    }),
    cursors: [
      {
        runId: fold.runId,
        processedThroughSequence: fold.cursor,
        processedRecordCount: fold.processedEventIds.length,
      },
    ],
    scopes: [fold.options.scope],
    dependencies: Array.from(fold.claimsByEventId.entries()).map(([inputId, claimIds]) => ({
      inputId,
      dependentIds: claimIds,
    })),
    pendingReferences: Array.from(fold.pendingReferences.values()).map((p) => ({
      referenceId: p.referenceId,
      from: p.from,
      targetRunId: p.targetRunId,
      targetEventId: p.targetEventId,
      firstSeenRevision: {
        algorithm: 'sha256-canonical-schema1-records-v1' as const,
        value: p.firstSeenRevisionValue,
        recordCount: p.firstSeenRevisionCount,
      },
    })),
    invalidations: fold.invalidations.length > 0 ? fold.invalidations : [...invalidations],
    selectedCheckpointIds: fold.jev.checkpoints.map((c) => c.checkpointId),
    completedJevResultIds: fold.jev.results.map((r) => r.resultId),
    processedEventIds: fold.processedEventIds,
    inputSignature,
    fold: snapshot,
    lastRunStats: undefined,
  };
}

/**
 * Incremental analysis of one stored answer. Loads the persisted fold,
 * fetches and applies only the unprocessed scoped events, and persists the
 * updated state and report (unless an override mode is requested, which
 * changes the projection only and is never persisted).
 */
export async function analyzeAnswerWithStats(
  store: ViewTraceStore,
  runId: string,
  answerId: string,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult | null> {
  const receipt = store.getAnswer(runId, answerId);
  const run = store.getRun(runId);
  if (!run || !receipt) return null;

  const analyzer = defaultAnalyzerIdentity();
  const { scope, scopeIds, exact } = buildAnswerScope(runId, answerId, {
    receiptId: receipt.receiptId,
    eventIds: receipt.eventIds,
    sharedEventIds: receipt.sharedEventIds,
  });

  const completeness: CollectionCompleteness = run.completeness;
  const engineOptions: FoldEngineOptions = {
    scope,
    analyzer,
    extensions: options.extensions,
    enableJev: options.enableJev,
    maxJevCheckpoints: options.maxJevCheckpoints,
  };

  const persisted = await store.getAnalysisState(runId, answerId);
  const compat = persisted?.fold
    ? checkScopeCompatibility(
        persisted.scopes[0]?.ownEventIds,
        boundaryWasExact(persisted),
        scopeIds,
        exact,
      )
    : { compatible: false };

  let fold: AnalysisFold;
  let stateLoaded = false;
  const extraInvalidations: import('../analysis-types.js').InvalidationEntry[] = [];
  if (persisted?.fold && compat.compatible) {
    fold = AnalysisFold.restore(persisted.fold, engineOptions);
    stateLoaded = true;
  } else {
    fold = AnalysisFold.create(engineOptions);
    if (persisted) {
      extraInvalidations.push({
        cause: 'ANSWER_SCOPE_CHANGE',
        inputIds: [answerId],
        invalidatedIds: ['*'],
      });
    }
  }

  // Fetch only the delta. EXACT scopes fetch by unprocessed ids; container
  // scopes page forward from the persisted cursor.
  let delta: ViewTraceEvent[];
  if (exact && scopeIds) {
    const processed = fold.processedIdSet;
    const missing = scopeIds.filter((id) => !processed.has(id));
    delta = store.getEventsByIds(runId, missing);
  } else {
    delta = store.listRunEvents(runId).filter((e) => e.sequence > fold.cursor);
  }
  delta = [...delta].sort((a, b) => a.sequence - b.sequence);

  // Sequence regression within the delta means the persisted cursor is not a
  // valid prefix (out-of-order arrival): fall back to a full re-fold and
  // record the invalidation honestly.
  if (delta.some((e) => e.sequence <= fold.cursor)) {
    const offenders = delta.filter((e) => e.sequence <= fold.cursor).map((e) => e.eventId);
    fold = AnalysisFold.create(engineOptions);
    extraInvalidations.push({ cause: 'NEW_INPUT', inputIds: offenders, invalidatedIds: ['*'] });
    delta = exact && scopeIds
      ? store.getEventsByIds(runId, scopeIds)
      : store.listRunEvents(runId);
    delta = [...delta].sort((a, b) => a.sequence - b.sequence);
  }

  if (delta.length > 0) {
    fold.invalidations.push({
      cause: 'NEW_INPUT',
      inputIds: delta.map((e) => e.eventId),
      invalidatedIds: fold.rawClaims.filter((c) => c.dirty).map((c) => c.claimId),
    });
  }
  for (const ev of delta) fold.applyEvent(ev);
  await fold.flushJev(options.jev);

  const { report } = finalizeFoldReport(fold, {
    questionSummary: options.questionSummary ?? receipt.questionSummary,
    overrideMode: options.overrideMode,
    domain: options.domain,
    collectionCompleteness: completeness,
  });

  const stats = runStatsOf(fold, stateLoaded ? 'INCREMENTAL_DELTA' : 'FULL_FOLD', delta.length, stateLoaded);

  if (!options.overrideMode) {
    const signature = currentInputSignature(store, runId, receipt.receiptId, scopeIds, completeness);
    const state = stateFor(fold, signature, extraInvalidations);
    const stateWithStats: IncrementalAnalysisStateV1 = { ...state, lastRunStats: stats };
    await store.saveAnalysisState(stateWithStats);
    await store.saveAnalysisReport(report);
    // Run-level record of selected checkpoints and their advisory results
    // (audit trail for the bounded JEV v2 budget/dedup contract).
    await store.saveJevCheckpoints(runId, fold.jev.checkpoints);
    await store.saveJevResults(runId, fold.jev.results);
  }

  return { report, stats };
}

function boundaryWasExact(state: IncrementalAnalysisStateV1): boolean {
  return state.scopes[0]?.boundary === 'EXACT';
}

export async function analyzeAnswer(
  store: ViewTraceStore,
  runId: string,
  answerId: string,
  options: AnalyzeOptions = {},
): Promise<AnalysisReportV1 | null> {
  const result = await analyzeAnswerWithStats(store, runId, answerId, options);
  return result?.report ?? null;
}

/**
 * Deterministic full rebuild from the store: ignores any persisted analysis
 * state, folds the complete scoped input from scratch, and does not persist.
 * This is the independent oracle the incremental path is compared against.
 */
export async function rebuildAnalysis(
  store: ViewTraceStore,
  runId: string,
  answerId: string,
  options: AnalyzeOptions = {},
): Promise<AnalysisReportV1 | null> {
  const receipt = store.getAnswer(runId, answerId);
  const run = store.getRun(runId);
  if (!run || !receipt) return null;

  const analyzer = defaultAnalyzerIdentity();
  const { scope, scopeIds, exact } = buildAnswerScope(runId, answerId, {
    receiptId: receipt.receiptId,
    eventIds: receipt.eventIds,
    sharedEventIds: receipt.sharedEventIds,
  });

  const events = (
    exact && scopeIds ? store.getEventsByIds(runId, scopeIds) : store.listRunEvents(runId)
  ).slice()
    .sort((a, b) => a.sequence - b.sequence);

  const fold = AnalysisFold.create({
    scope,
    analyzer,
    extensions: options.extensions,
    enableJev: options.enableJev,
    maxJevCheckpoints: options.maxJevCheckpoints,
  } satisfies FoldEngineOptions);
  for (const ev of events) fold.applyEvent(ev);
  await fold.flushJev(options.jev);

  const { report } = finalizeFoldReport(fold, {
    questionSummary: options.questionSummary ?? receipt.questionSummary,
    overrideMode: options.overrideMode,
    domain: options.domain,
    collectionCompleteness: run.completeness,
  });
  return report;
}

function currentInputSignature(
  store: ViewTraceStore,
  runId: string,
  receiptId: string,
  scopeIds: readonly string[] | undefined,
  completeness: CollectionCompleteness,
): AnalysisInputSignature {
  const stats = store.scopedEventStats(runId, scopeIds ? receiptId : undefined);
  return {
    scopeEventCount: stats.count,
    maxSequence: stats.maxSequence,
    scopeIdsHash: scopeIdsHash(scopeIds),
    collectionCompleteness: completeness,
  };
}

export interface FreshnessCheck {
  readonly status: ReportFreshness['status'];
  readonly reasons: ReportFreshness['reasons'];
}

/**
 * Cheap staleness check for a stored analysis: compares the persisted input
 * signature and analyzer identity against the store without re-reading the
 * event prefix. Never-analyzed inputs yield null.
 */
export async function checkAnalysisFreshness(
  store: ViewTraceStore,
  runId: string,
  answerId: string,
): Promise<FreshnessCheck | null> {
  const receipt = store.getAnswer(runId, answerId);
  const run = store.getRun(runId);
  if (!run || !receipt) return null;

  const state = await store.getAnalysisState(runId, answerId);
  const loaded = await store.loadAnalysisReport(runId, answerId);
  if (!state && loaded.kind === 'missing') return null;

  const reasons: ReportFreshness['reasons'][number][] = [];
  const analyzer = defaultAnalyzerIdentity();

  if (loaded.kind === 'corrupt') {
    reasons.push('STATE_INVALIDATED');
  }
  if (state) {
    if (state.analyzer.analyzerVersion !== analyzer.analyzerVersion) reasons.push('ANALYZER_VERSION_CHANGED');
    if (state.analyzer.ruleSetVersion !== analyzer.ruleSetVersion) reasons.push('RULE_SET_CHANGED');
  } else {
    reasons.push('STATE_INVALIDATED');
  }

  const exact = Array.isArray(receipt.eventIds);
  const scopeIds = exact
    ? Array.from(new Set([...receipt.eventIds!, ...(receipt.sharedEventIds ?? [])]))
    : undefined;
  const current = currentInputSignature(store, runId, receipt.receiptId, scopeIds, run.completeness);
  if (state && !signatureMatches(state.inputSignature, current)) {
    const prev = state.inputSignature;
    if (
      prev &&
      (prev.scopeEventCount !== current.scopeEventCount || prev.maxSequence !== current.maxSequence)
    ) {
      reasons.push('INPUT_REVISION_CHANGED');
    } else {
      reasons.push('STATE_INVALIDATED');
    }
  }

  if (reasons.length === 0) return { status: 'CURRENT', reasons: [] };
  return { status: 'STALE', reasons: Array.from(new Set(reasons)) };
}

export { computeInputRevision };
