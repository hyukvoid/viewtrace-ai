import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize } from './canonical.js';
import type { ViewTraceStore } from './store.js';
import { analyzeAnswer, checkAnalysisFreshness } from './analyzer/index.js';
import { defaultAnalyzerIdentity, scopeIdsHash } from './analyzer/incremental.js';
import type { AnalysisInputSignature, AnalysisMode, AnalysisReportV1 } from './analysis-types.js';
import type { CollectionCompleteness } from './types.js';

export const PAGE_LIMIT = 100;
export function revision(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

/** Sync input signature mirroring the analyzer's, for the M2 answer report. */
function syncInputSignature(
  store: ViewTraceStore,
  runId: string,
  receiptId?: string,
  scopeIds?: readonly string[],
): AnalysisInputSignature | null {
  const run = store.getRun(runId);
  if (!run) return null;
  const stats = store.scopedEventStats(runId, scopeIds ? receiptId : undefined);
  const completeness: CollectionCompleteness = run.completeness;
  return {
    scopeEventCount: stats.count,
    maxSequence: stats.maxSequence,
    scopeIdsHash: scopeIdsHash(scopeIds),
    collectionCompleteness: completeness,
  };
}

/**
 * Best-effort synchronous support read for the M2 answer report: the stored
 * value is surfaced only while it is still fresh (scope extent, completeness
 * and analyzer identity match); a stale or corrupt artifact reads UNKNOWN
 * rather than serving an outdated judgement as current.
 */
function storedSupportIfFresh(store: ViewTraceStore, runId: string, answerId: string): string {
  try {
    const receipt = store.getAnswer(runId, answerId);
    if (!receipt) return 'UNKNOWN';
    const stateFile = join(store.dataRoot, 'artifacts', runId, 'answers', answerId, 'analysis-state.json');
    const reportFile = join(store.dataRoot, 'artifacts', runId, 'answers', answerId, 'analysis-report.json');
    if (!existsSync(stateFile) || !existsSync(reportFile)) return 'UNKNOWN';
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as {
      analyzer?: { analyzerVersion?: string; ruleSetVersion?: string };
      inputSignature?: AnalysisInputSignature;
    };
    const report = JSON.parse(readFileSync(reportFile, 'utf8')) as { support?: { status?: string } };
    const analyzer = defaultAnalyzerIdentity();
    if (
      state.analyzer?.analyzerVersion !== analyzer.analyzerVersion ||
      state.analyzer?.ruleSetVersion !== analyzer.ruleSetVersion
    ) {
      return 'UNKNOWN';
    }
    const exact = Array.isArray(receipt.eventIds);
    const scopeIds = exact
      ? Array.from(new Set([...receipt.eventIds!, ...(receipt.sharedEventIds ?? [])]))
      : undefined;
    const current = syncInputSignature(store, runId, receipt.receiptId, scopeIds);
    const prev = state.inputSignature;
    if (
      !current ||
      !prev ||
      prev.scopeEventCount !== current.scopeEventCount ||
      prev.maxSequence !== current.maxSequence ||
      prev.scopeIdsHash !== current.scopeIdsHash ||
      prev.collectionCompleteness !== current.collectionCompleteness
    ) {
      return 'UNKNOWN';
    }
    return report.support?.status ?? 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

export function runReport(store: ViewTraceStore, runId: string) {
  const run = store.getRun(runId);
  if (!run) return null;
  const data = {
    run: {
      ...run,
      lifecycleHistory: run.lifecycleHistory.slice(-100),
      lifecycleTransitionCount: run.lifecycleHistory.length,
    },
    kept: store.isKept(runId),
    association: 'UNKNOWN',
    diagnostics: store.pageDiagnostics(runId),
    diagnosticCount: store.countDiagnostics(runId),
  };
  return { ...data, revision: revision(data) };
}

export function answerReport(store: ViewTraceStore, runId: string, answerId: string, selectionId?: number) {
  const receipt = store.getAnswer(runId, answerId);
  const container = runReport(store, runId);
  if (!receipt || !container) return null;
  const explicitSelection =
    selectionId === undefined ? false : store.hasSelection(selectionId, receipt.receiptId, runId);
  const scope = store.answerScope(receipt);
  // Omit unbounded ID arrays on detail endpoints; events are paginated in SQL.
  const { eventIds, sharedEventIds, ...identity } = receipt;
  const data = {
    receipt: identity,
    run: container.run,
    kept: container.kept,
    association: {
      status: explicitSelection ? 'explicit-selection' : 'explicit-link',
      currentAnswerMatch: 'UNKNOWN',
      basis: explicitSelection ? 'user-selected' : 'answer-identity',
    },
    receiptIntegrity: store.receiptConflicted(receipt) ? 'CONFLICTED' : 'STORED',
    associationCapability: receipt.agentSessionId && receipt.turnId ? 'YES' : 'PARTIAL',
    scope: {
      ...scope,
      ownDeclared: eventIds?.length ?? null,
      sharedDeclared: sharedEventIds?.length ?? 0,
    },
    evidenceSupport: storedSupportIfFresh(store, runId, answerId),
    diagnostics: container.diagnostics,
    diagnosticCount: container.diagnosticCount,
  };
  return { ...data, revision: revision(data) };
}

/**
 * Freshness-aware analysis serving: returns the stored report only while it
 * is current (scope extent, completeness and analyzer identity unchanged);
 * otherwise the incremental engine recomputes from the delta and the fresh
 * report replaces the stale artifact. Override-mode requests recompute the
 * projection only and are never persisted.
 */
export async function answerAnalysisReport(
  store: ViewTraceStore,
  runId: string,
  answerId: string,
  options?: { overrideMode?: AnalysisMode },
): Promise<AnalysisReportV1 | null> {
  if (!options?.overrideMode) {
    const freshness = await checkAnalysisFreshness(store, runId, answerId);
    if (freshness?.status === 'CURRENT') {
      const loaded = await store.loadAnalysisReport(runId, answerId);
      if (loaded.kind === 'ok') return loaded.report;
    }
  }
  return analyzeAnswer(store, runId, answerId, options);
}

export function eventPage(
  store: ViewTraceStore,
  runId: string,
  after: number,
  limit: number,
  answerId?: string,
  selectionId?: number,
  eventId?: string,
) {
  const report =
    answerId === undefined ? runReport(store, runId) : answerReport(store, runId, answerId, selectionId);
  if (!report) return null;
  const receipt = answerId === undefined ? undefined : store.getAnswer(runId, answerId);
  // An inspector lookup is constrained to the same explicit answer scope as
  // pagination. A missing scope never grants access to another turn's events.
  if (
    eventId !== undefined && receipt &&
    ![...(receipt.eventIds ?? []), ...(receipt.sharedEventIds ?? [])].includes(eventId)
  ) return null;
  const page = eventId === undefined
    ? store.pageRecords(runId, after, limit, receipt?.receiptId)
    : { records: store.getEventsByIds(runId, [eventId]), nextCursor: null };
  if (eventId !== undefined && page.records.length === 0) return null;
  return {
    events: page.records,
    nextCursor: page.nextCursor,
    revision: report.revision,
  };
}

export function pickerPage(store: ViewTraceStore, offset = 0, limit = 50) {
  const answers = store.recentAnswers(limit + 1, offset);
  const runs = store.recentRuns(limit + 1, offset);
  return {
    answers: answers.slice(0, limit).map((r) => ({
      receiptId: r.receiptId,
      runId: r.runId,
      answerId: r.answerId,
      agentId: r.agentId,
      agentSessionId: r.agentSessionId ?? null,
      turnId: r.turnId ?? null,
      timestamp: r.timestamp,
      questionSummary: r.questionSummary ?? null,
      lifecycle: store.getRun(r.runId)?.lifecycle,
      completeness: store.getRun(r.runId)?.completeness,
      scope: store.answerScope(r).status,
    })),
    runs: runs.slice(0, limit).map((r) => ({
      runId: r.runId,
      timestamp: r.updatedAt,
      agentId: null,
      questionSummary: null,
      lifecycle: r.lifecycle,
      completeness: r.completeness,
      association: 'UNKNOWN',
    })),
    nextOffset: answers.length > limit || runs.length > limit ? offset + limit : null,
  };
}
