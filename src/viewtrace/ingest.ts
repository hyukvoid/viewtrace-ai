/**
 * One-shot batch ingestion: reference JSONL file → validate → SQLite store
 * → close → reopen → replay → verify equality.
 *
 * This is the M0 acceptance pipeline (docs/MILESTONES.md §5 완료 조건).
 * It is deliberately batch-only: live watching, agent spawn and control
 * services are M1 scope.
 *
 * Honesty rules:
 *  - Losses (malformed/truncated/oversized lines) and rejected records make
 *    every run in the input PARTIAL — never hidden, never downgraded to a
 *    clean success.
 *  - Non-fatal validation warnings do NOT degrade completeness.
 *  - Relation diagnostics (dangling/cross-run/cyclic) are computed after all
 *    records are stored and preserved as pending/unresolved.
 */

import { ViewTraceStore } from './store.js';
import { parseJsonlFile } from './jsonl.js';
import { validateRecord } from './validate.js';
import { canonicalize } from './canonical.js';
import type {
  CollectionCompleteness,
  Diagnostic,
  DuplicateInfo,
  IngestResult,
  ReplayResult,
  RunIngestReport,
  StoredRecord,
  TraceRecord,
  ViewTraceEvent,
} from './types.js';

export interface IngestOptions {
  readonly dataRoot: string;
  readonly now?: () => string;
  readonly maxLineBytes?: number;
}

export interface ReplayCheck {
  readonly runId: string;
  readonly verified: boolean;
  readonly mismatch?: string;
}

export interface IngestOutcome extends IngestResult {
  readonly replayChecks: readonly ReplayCheck[];
  readonly jsonlWriteErrors: readonly { runId: string; message: string }[];
}

interface RunAccumulator {
  runId: string;
  adapterId: string;
  adapterVersion: string;
  acceptedInput: TraceRecord[];
  storedRecords: StoredRecord[];
  duplicates: DuplicateInfo[];
  diagnostics: Diagnostic[];
  completeness: CollectionCompleteness;
}

export async function ingestFile(inputPath: string, options: IngestOptions): Promise<IngestOutcome> {
  const now = options.now ?? (() => new Date().toISOString());
  const receivedAt = now();

  const parsed = await parseJsonlFile(inputPath, { maxLineBytes: options.maxLineBytes });

  const streamDiagnostics: Diagnostic[] = [];
  for (const loss of parsed.losses) {
    streamDiagnostics.push({
      code: `LOSS_${loss.code}`,
      severity: 'error',
      message: `input loss (${loss.code}) at line ${loss.lineIndex}, byte offset ${loss.byteOffset}, ~${loss.byteLength} bytes${loss.definitive ? '' : ' (tail may be incomplete)'}`,
      lineIndex: loss.lineIndex,
      byteOffset: loss.byteOffset,
    });
  }

  const runs = new Map<string, RunAccumulator>();
  let rejectedCount = 0;

  for (const line of parsed.lines) {
    const outcome = validateRecord(line.value);
    if (!outcome.ok) {
      rejectedCount += 1;
      for (const error of outcome.errors) {
        streamDiagnostics.push({
          ...error,
          lineIndex: line.lineIndex,
          byteOffset: line.byteOffset,
        });
      }
      continue;
    }
    const record = outcome.record;
    let acc = runs.get(record.runId);
    if (acc === undefined) {
      acc = {
        runId: record.runId,
        adapterId: record.adapterId,
        adapterVersion: record.adapterVersion,
        acceptedInput: [],
        storedRecords: [],
        duplicates: [],
        diagnostics: [],
        completeness: 'UNKNOWN',
      };
      runs.set(record.runId, acc);
    }

    const assignedSequence = acc.acceptedInput.length + 1;
    const stamped: TraceRecord = {
      ...record,
      sequence: assignedSequence,
      receivedAt: record.receivedAt === '' ? receivedAt : record.receivedAt,
    } as TraceRecord;
    if (record.sequence !== -1 && record.sequence !== assignedSequence) {
      acc.diagnostics.push({
        code: 'SEQUENCE_MISMATCH',
        severity: 'warning',
        message: 'declared sequence does not match collector reception order; collector order wins',
        lineIndex: line.lineIndex,
        eventId: stamped.recordKind === 'event' ? stamped.eventId : undefined,
        runId: acc.runId,
      });
    }
    for (const warning of outcome.warnings) {
      acc.diagnostics.push({
        ...warning,
        lineIndex: line.lineIndex,
        eventId: stamped.recordKind === 'event' ? stamped.eventId : undefined,
        runId: acc.runId,
      });
    }
    acc.acceptedInput.push(stamped);
  }

  // Completeness: stream losses or rejected records degrade EVERY run in the
  // file — the loss cannot be attributed to a single run honestly.
  const completeness = parsed.losses.length === 0 && rejectedCount === 0 ? 'COMPLETE' : 'PARTIAL';

  const store = await ViewTraceStore.open({ dataRoot: options.dataRoot, now });
  const jsonlWriteErrors: { runId: string; message: string }[] = [];
  try {
    for (const acc of runs.values()) {
      await store.createRun(acc.runId, {
        adapterId: acc.adapterId,
        adapterVersion: acc.adapterVersion,
      });
      // File-level errors (validation rejections, stream losses) are stored on
      // every run in the file — they cannot be attributed to one run honestly.
      const fileErrors = streamDiagnostics.map((d) => ({ ...d, runId: acc.runId }));
      const result = await store.appendRecords(
        acc.runId,
        acc.acceptedInput,
        [...fileErrors, ...acc.diagnostics],
        parsed.totalBytes,
      );
      acc.storedRecords = [...result.accepted];
      acc.duplicates = [...result.duplicates];
      if (result.jsonlWriteError !== undefined) {
        jsonlWriteErrors.push({ runId: acc.runId, message: result.jsonlWriteError.message });
      }

      const relationDiagnostics = analyzeRelations(acc.runId, acc.acceptedInput);
      if (relationDiagnostics.length > 0) {
        await store.appendRecords(acc.runId, [], relationDiagnostics, parsed.totalBytes);
      }
      // Receipt rejections arise in the transactional store, after structural
      // validation. Preserve their loss status in batch and replay as well.
      const receiptConflict = store
        .listDiagnostics(acc.runId)
        .some(
          (d) =>
            d.code === 'RECEIPT_ID_CONFLICT' ||
            (d.code === 'DUPLICATE_CONFLICTING' && d.severity === 'error'),
        );
      acc.completeness = receiptConflict ? 'PARTIAL' : completeness;
      await store.setCompleteness(acc.runId, acc.completeness);
      // The stored view (including store-generated diagnostics like
      // DUPLICATE_CONFLICTING and RUN_TRANSITION_INVALID) is the replay
      // comparison baseline.
      acc.diagnostics = store.listDiagnostics(acc.runId);
    }
  } finally {
    await store.close();
  }

  // Reopen and verify the M0 acceptance contract: replay is identical.
  const reopened = await ViewTraceStore.open({ dataRoot: options.dataRoot, now });
  const replayChecks: ReplayCheck[] = [];
  const runReports: RunIngestReport[] = [];
  const storedDiagnostics: Diagnostic[] = [];
  try {
    for (const acc of runs.values()) {
      const replay = reopened.replay(acc.runId);
      if (replay === null) {
        replayChecks.push({ runId: acc.runId, verified: false, mismatch: 'run missing after reopen' });
        continue;
      }
      const mismatch = compareReplay(acc, replay, acc.completeness);
      replayChecks.push({ runId: acc.runId, verified: mismatch === undefined, mismatch });
      runReports.push({
        runId: acc.runId,
        lifecycle: replay.run.lifecycle,
        completeness: replay.run.completeness,
        eventsAccepted: acc.storedRecords.filter((r) => r.recordKind === 'event').length,
        eventsRejected: rejectedCount,
        recordsAccepted: acc.storedRecords.length,
        duplicatesIdempotent: acc.duplicates.filter((d) => d.kind === 'IDEMPOTENT').length,
        duplicatesConflicting: acc.duplicates.filter((d) => d.kind === 'CONFLICTING').length,
      });
      storedDiagnostics.push(...replay.diagnostics);
    }
  } finally {
    await reopened.close();
  }

  return {
    dataRoot: options.dataRoot,
    inputBytes: parsed.totalBytes,
    endedWithNewline: parsed.endedWithNewline,
    runs: runReports,
    losses: parsed.losses,
    diagnostics: storedDiagnostics,
    replayChecks,
    jsonlWriteErrors,
  };
}

/**
 * Post-append relation analysis. Late/cross-run references stay pending and
 * are reported as unresolved — never dropped, never invented.
 */
function analyzeRelations(runId: string, records: readonly TraceRecord[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const eventIds = new Set<string>();
  for (const record of records) {
    if (record.recordKind === 'event') eventIds.add(record.eventId);
  }
  const edges = new Map<string, string[]>();
  for (const record of records) {
    if (record.recordKind !== 'event' || record.relations === undefined) continue;
    for (const relation of record.relations) {
      if (relation.targetRunId !== undefined && relation.targetRunId !== runId) {
        diagnostics.push({
          code: 'CROSS_RUN_RELATION',
          severity: 'warning',
          message: `relation targets run ${relation.targetRunId}; cross-run links stay pending and unresolved in M0`,
          eventId: record.eventId,
          runId,
        });
        continue;
      }
      if (!eventIds.has(relation.targetEventId)) {
        diagnostics.push({
          code: 'DANGLING_RELATION',
          severity: 'warning',
          message: `relation target ${relation.targetEventId} is not present in this run; preserved as pending/unresolved`,
          eventId: record.eventId,
          runId,
        });
        continue;
      }
      const list = edges.get(record.eventId) ?? [];
      list.push(relation.targetEventId);
      edges.set(record.eventId, list);
    }
  }
  // Cycle detection (same-run relation graph).
  const visiting = new Set<string>();
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (node: string): boolean => {
    if (done.has(node)) return false;
    if (visiting.has(node)) {
      const cycleStart = path.indexOf(node);
      const cycle = [...path.slice(cycleStart >= 0 ? cycleStart : 0), node];
      diagnostics.push({
        code: 'CYCLE_RELATION',
        severity: 'warning',
        message: `relation cycle detected: ${cycle.join(' -> ')}`,
        eventId: node,
        runId,
      });
      return true;
    }
    visiting.add(node);
    path.push(node);
    for (const next of edges.get(node) ?? []) {
      if (visit(next)) {
        path.pop();
        visiting.delete(node);
        return true;
      }
    }
    path.pop();
    visiting.delete(node);
    done.add(node);
    return false;
  };
  for (const node of eventIds) {
    if (visit(node)) break;
  }
  return diagnostics;
}

/**
 * Verifies the M0 replay-equality contract: events, relations, warnings and
 * statuses must be identical after close/reopen.
 */
function compareReplay(
  acc: RunAccumulator,
  replay: ReplayResult,
  expectedCompleteness: string,
): string | undefined {
  const expected = acc.storedRecords.map((r) => r.record);
  if (expected.length !== replay.records.length) {
    return `record count mismatch: expected ${expected.length}, replayed ${replay.records.length}`;
  }
  for (let i = 0; i < expected.length; i++) {
    if (canonicalize(expected[i]) !== canonicalize(replay.records[i]?.record)) {
      return `record ${i} differs after reopen`;
    }
  }
  const diagShape = (d: Diagnostic): unknown => ({
    code: d.code,
    severity: d.severity,
    message: d.message,
    eventId: d.eventId,
  });
  if (canonicalize(acc.diagnostics.map(diagShape)) !== canonicalize(replay.diagnostics.map(diagShape))) {
    return 'diagnostics differ after reopen';
  }
  const dupShape = (d: DuplicateInfo): unknown => ({
    recordKind: d.recordKind,
    recordId: d.recordId,
    kind: d.kind,
    firstSequence: d.firstSequence,
    duplicateSequence: d.duplicateSequence,
  });
  if (canonicalize(acc.duplicates.map(dupShape)) !== canonicalize(replay.duplicates.map(dupShape))) {
    return 'duplicates differ after reopen';
  }
  if (replay.run.completeness !== expectedCompleteness) {
    return `completeness mismatch: expected ${expectedCompleteness}, replayed ${replay.run.completeness}`;
  }
  return undefined;
}
