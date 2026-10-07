import { createHash } from 'node:crypto';
import { canonicalize } from './canonical.js';
import type { ViewTraceStore } from './store.js';

export const PAGE_LIMIT = 100;
export function revision(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
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
    evidenceSupport: 'UNKNOWN',
    diagnostics: container.diagnostics,
    diagnosticCount: container.diagnosticCount,
  };
  return { ...data, revision: revision(data) };
}

export function eventPage(
  store: ViewTraceStore,
  runId: string,
  after: number,
  limit: number,
  answerId?: string,
  selectionId?: number,
) {
  const report =
    answerId === undefined ? runReport(store, runId) : answerReport(store, runId, answerId, selectionId);
  if (!report) return null;
  const receipt = answerId === undefined ? undefined : store.getAnswer(runId, answerId);
  const page = store.pageRecords(runId, after, limit, receipt?.receiptId);
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
