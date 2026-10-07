/**
 * M4 optional live monitor (`viewtrace monitor`, docs/MILESTONES.md §9).
 *
 * A separate, selectable screen: it polls the *existing* incremental
 * analyzer through the same serving path as `viewtrace analyze`
 * (`answerAnalysisReport`) and renders deltas — never a re-derivation. All
 * tree structure comes from AnalysisReportV1; the monitor only tracks what
 * has already been shown (dedup, collapse state) scoped per answer.
 *
 * Timers are injected so tests can drive deterministic poll sequences; the
 * CLI wires real timers. Output contains zero ANSI escapes and is identical
 * on a TTY and a pipe (M1 display contract).
 */

import type { AnalysisMode, AnalysisReportV1 } from '../analysis-types.js';
import type { ViewTraceStore } from '../store.js';
import type { RunLifecycle } from '../types.js';
import { sanitizeForTerminal } from '../display.js';
import { answerAnalysisReport } from '../report.js';
import {
  buildCollectionStatus,
  type CollectionStatusInput,
} from './report-view.js';
import { TreeTracker } from './tree.js';

const TERMINAL_LIFECYCLES: readonly RunLifecycle[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export interface MonitorOptions {
  readonly runId: string;
  readonly answerId?: string;
  readonly overrideMode?: AnalysisMode;
  readonly intervalMs: number;
  readonly maxWaitMs: number;
  readonly json: boolean;
  readonly dataRoot: string;
}

export interface MonitorIo {
  readonly emit: (line: string) => void;
  readonly emitJson: (value: unknown) => void;
  readonly fail: (message: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly cancelled?: () => boolean;
}

function isTerminal(lifecycle: RunLifecycle): boolean {
  return TERMINAL_LIFECYCLES.includes(lifecycle);
}

interface StatusSnapshot {
  readonly lifecycle: RunLifecycle;
  readonly completeness: string;
  readonly eventCount: number;
  readonly maxSequence: number;
  readonly scopedCount: number;
  readonly errors: number;
  readonly losses: number;
  readonly diagnosticsTotal: number;
  readonly jsonlLines: number;
  readonly jsonlCursor: number;
}

function snapshotOf(status: CollectionStatusInput): StatusSnapshot {
  return {
    lifecycle: status.run.lifecycle,
    completeness: status.run.completeness,
    eventCount: status.run.eventCount,
    maxSequence: status.scoped.maxSequence,
    scopedCount: status.scoped.count,
    errors: status.errorDiagnostics,
    losses: status.lossDiagnostics,
    diagnosticsTotal: status.diagnosticsTotal,
    jsonlLines: status.run.jsonlLines,
    jsonlCursor: status.run.jsonlCursor,
  };
}

function snapshotKey(s: StatusSnapshot): string {
  return JSON.stringify(s);
}

function emitStatus(io: MonitorIo, json: boolean, status: CollectionStatusInput): void {
  const snapshot = snapshotOf(status);
  if (json) {
    io.emitJson({ type: 'monitor-status', at: new Date().toISOString(), status: snapshot });
    return;
  }
  io.emit(`status: run ${sanitizeForTerminal(status.run.runId)} ${status.run.lifecycle} / completeness=${status.run.completeness} events=${status.run.eventCount}`);
  io.emit(`  sequence: max=${snapshot.maxSequence} scoped records=${snapshot.scopedCount} errors>=${snapshot.errors} losses>=${snapshot.losses} diagnostics=${snapshot.diagnosticsTotal}`);
  io.emit(`  replay: trace.jsonl lines=${snapshot.jsonlLines} cursor=${snapshot.jsonlCursor} (derived; db authoritative)  storage: ${sanitizeForTerminal(status.dataRoot)}`);
}

/**
 * Poll loop. Stop conditions (checked in this order):
 *  1. cancelled via io.cancelled()             -> exit 130
 *  2. terminal lifecycle + report seen + 2 stable polls -> exit 0
 *  3. answer missing on a terminal run         -> exit 1 (nothing to analyze)
 *  4. maxWaitMs elapsed                        -> exit 0 (honest note) or 1
 *     if no report was ever produced for an existing answer
 */
export async function runMonitor(
  store: ViewTraceStore,
  options: MonitorOptions,
  io: MonitorIo,
): Promise<number> {
  const run0 = store.getRun(options.runId);
  if (run0 === null) {
    io.fail(`viewtrace: unknown run: ${sanitizeForTerminal(options.runId)}`);
    return 1;
  }

  // Answer resolution mirrors `analyze`: explicit id, else the most recent
  // receipt in this run. The default is always labeled as such — it is an
  // analysis convenience, never an exact reveal match.
  let answerId = options.answerId;
  let association: string;
  if (answerId !== undefined) {
    association = 'explicit answer identity within this run';
  } else {
    const candidates = store
      .recentAnswers(100)
      .filter((a: { runId: string }) => a.runId === options.runId);
    answerId = candidates[0]?.answerId;
    association = 'latest receipt in run (auto-selected for analysis; not an exact reveal match)';
  }
  if (answerId !== undefined && store.getAnswer(options.runId, answerId) === null) {
    const available = store
      .recentAnswers(100)
      .filter((a: { runId: string }) => a.runId === options.runId)
      .map((a: { answerId: string }) => a.answerId);
    io.fail(
      available.length === 0
        ? `viewtrace: run '${sanitizeForTerminal(options.runId)}' has no answer receipts; nothing to monitor (analysis is answer-scoped)`
        : `viewtrace: answer '${sanitizeForTerminal(answerId)}' not found in run '${sanitizeForTerminal(options.runId)}' (available: ${available.map((a) => sanitizeForTerminal(a)).join(', ')})`,
    );
    return 1;
  }

  const tracker = new TreeTracker();
  const json = options.json;
  if (json) {
    io.emitJson({
      type: 'monitor-start',
      runId: options.runId,
      answerId: answerId ?? null,
      overrideMode: options.overrideMode ?? null,
      association,
      intervalMs: options.intervalMs,
      maxWaitMs: options.maxWaitMs,
      dataRoot: options.dataRoot,
    });
  } else {
    io.emit(
      `monitor: run ${sanitizeForTerminal(options.runId)}${answerId !== undefined ? ` answer ${sanitizeForTerminal(answerId)}` : ' (no answer recorded yet)'}`,
    );
    io.emit(`  association: ${association}`);
    io.emit('  tree grows from the incremental analyzer; collapsing hides only repeated event ids');
  }

  const deadline = io.now() + options.maxWaitMs;
  let lastStatusKey: string | null = null;
  let answerAbsentNoted = false;
  let everReported = false;
  let lastReportKey: string | null = null;
  let stablePolls = 0;
  let polls = 0;
  let treeLineCount = 0;
  // Explicit --answer is sticky by construction; a default-resolved answer
  // sticks to the FIRST receipt seen so a later receipt never silently
  // switches the monitored answer mid-run (switch isolation).
  let stickyAnswerId = answerId;

  for (;;) {
    polls += 1;
    const run = store.getRun(options.runId);
    if (run === null) {
      io.fail(`viewtrace: run disappeared during monitoring: ${sanitizeForTerminal(options.runId)}`);
      return 1;
    }

    if (stickyAnswerId === undefined) {
      const latest = store
        .recentAnswers(100)
        .filter((a: { runId: string }) => a.runId === options.runId)[0];
      if (latest !== undefined) {
        stickyAnswerId = latest.answerId;
        if (json)
          io.emitJson({ type: 'monitor-answer', at: new Date().toISOString(), state: 'resolved', answerId: stickyAnswerId });
        else
          io.emit(`answer: receipt ${sanitizeForTerminal(stickyAnswerId)} recorded — monitoring it (later receipts never switch automatically)`);
      }
    } else if (options.answerId === undefined) {
      const latest = store
        .recentAnswers(100)
        .filter((a: { runId: string }) => a.runId === options.runId)[0];
      if (latest !== undefined && latest.answerId !== stickyAnswerId) {
        if (json)
          io.emitJson({ type: 'monitor-answer', at: new Date().toISOString(), state: 'later-receipt-ignored', answerId: latest.answerId, monitoring: stickyAnswerId });
        else
          io.emit(`answer: later receipt ${sanitizeForTerminal(latest.answerId)} appeared; still monitoring ${sanitizeForTerminal(stickyAnswerId)} (start another monitor to switch)`);
      }
    }

    const receipt =
      stickyAnswerId !== undefined ? store.getAnswer(options.runId, stickyAnswerId) : null;
    const status = buildCollectionStatus(
      store,
      options.runId,
      options.dataRoot,
      receipt?.receiptId,
    );
    if (status !== null) {
      const key = snapshotKey(snapshotOf(status));
      if (key !== lastStatusKey) {
        lastStatusKey = key;
        emitStatus(io, json, status);
      }
    }

    if (stickyAnswerId === undefined || receipt === null) {
      if (!answerAbsentNoted) {
        answerAbsentNoted = true;
        if (json) io.emitJson({ type: 'monitor-answer', at: new Date().toISOString(), state: 'none-recorded' });
        else io.emit('answer: none recorded yet — association UNKNOWN; no tree derived (nothing is invented)');
      }
      if (isTerminal(run.lifecycle)) {
        io.fail(
          `viewtrace: run '${sanitizeForTerminal(options.runId)}' ended with no answer receipts; nothing to monitor (analysis is answer-scoped)`,
        );
        return 1;
      }
    } else {
      let report: AnalysisReportV1 | null = null;
      try {
        report = await answerAnalysisReport(store, options.runId, stickyAnswerId, {
          overrideMode: options.overrideMode,
        });
      } catch (e) {
        if (json)
          io.emitJson({
            type: 'monitor-answer',
            at: new Date().toISOString(),
            state: 'analysis-error',
            message: sanitizeForTerminal(e instanceof Error ? e.message : String(e)),
          });
        else io.emit(`analysis: failed this poll (${sanitizeForTerminal(e instanceof Error ? e.message : String(e))}) — treated as UNKNOWN, prior output kept`);
      }
      if (report !== null) {
        everReported = true;
        const lines = tracker.update(report);
        if (lines.length > 0) {
          treeLineCount += lines.length;
          if (json) io.emitJson({ type: 'monitor-tree', at: new Date().toISOString(), lines });
          else for (const line of lines) io.emit(line);
        }
        const reportKey = `${report.inputRevision.value}:${report.stateRevision}`;
        const changed = reportKey !== lastReportKey || lines.length > 0;
        lastReportKey = reportKey;
        stablePolls = changed ? 0 : stablePolls + 1;
        if (isTerminal(run.lifecycle) && stablePolls >= 2) {
          emitFinal(io, json, 'terminal and stable', polls, treeLineCount, stickyAnswerId);
          return 0;
        }
      } else {
        if (json) io.emitJson({ type: 'monitor-answer', at: new Date().toISOString(), state: 'analysis-unavailable' });
        else io.emit('analysis: unavailable this poll (UNKNOWN); retrying');
      }
    }

    if (io.cancelled?.() === true) {
      emitFinal(io, json, 'cancelled', polls, treeLineCount, stickyAnswerId);
      return 130;
    }
    if (io.now() >= deadline) {
      if (!everReported && answerId !== undefined) {
        emitFinal(io, json, `max-wait reached; run still ${run.lifecycle}; no analysis produced`, polls, treeLineCount, stickyAnswerId);
        return 1;
      }
      emitFinal(io, json, `max-wait reached; run still ${run.lifecycle}`, polls, treeLineCount, stickyAnswerId);
      return 0;
    }
    await io.sleep(options.intervalMs);
  }
}

function emitFinal(
  io: MonitorIo,
  json: boolean,
  reason: string,
  polls: number,
  treeLineCount: number,
  answerId?: string,
): void {
  if (json) {
    io.emitJson({
      type: 'monitor-final',
      reason,
      answerId: answerId !== undefined ? sanitizeForTerminal(answerId) : null,
      polls,
      treeLines: treeLineCount,
    });
    return;
  }
  const answerSuffix = answerId !== undefined ? ` for answer ${sanitizeForTerminal(answerId)}` : '';
  io.emit(`monitor: stopped (${reason})${answerSuffix} — ${polls} polls, ${treeLineCount} tree lines emitted`);
}
