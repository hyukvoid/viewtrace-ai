/**
 * Live spool collector (M1).
 *
 * The `viewtrace run` wrapper tees sanitized producer stdout into
 * `<dataRoot>/live/<runId>/stream.jsonl`. This collector tails those spools
 * incrementally and is the ONLY writer to the SQLite store (single-writer
 * rule), so concurrent runs and CLI readers never fight over the database.
 *
 * Honesty rules:
 *  - The committed byte cursor always sits on a *complete line boundary*,
 *    so a crash/restart re-reads at most the partial tail — never a loss,
 *    never a duplicate (dedup by (runId, recordId) + content hash).
 *  - Truncation/rotation is a NEW source generation: cursor resets, the
 *    event is recorded as a diagnostic, and the run can never end up
 *    COMPLETE over a broken stream.
 *  - A run finalizes (completeness COMPLETE/PARTIAL) only after an explicit
 *    terminal run record AND full drain. No terminal record ⇒ lifecycle and
 *    completeness honestly stay RUNNING/UNKNOWN — file mtime is never used
 *    as a completion signal.
 *  - Reads are chunked and bounded; oversized lines are discarded by the
 *    parser without buffering. There is no unbounded in-memory queue: the
 *    spool file itself is the durable buffer.
 */

import { open, readdir, readFile, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { JsonlChunkParser } from './jsonl.js';
import { validateRecord } from './validate.js';
import { captureDiagnostic } from './native.js';
import { liveDir } from './servestate.js';
import type { ViewTraceStore } from './store.js';
import type {
  CollectionCompleteness,
  Diagnostic,
  LossRecord,
  RunLifecycle,
  TraceRecord,
} from './types.js';

const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_READS_PER_TICK = 64;

export const TERMINAL_LIFECYCLES: readonly RunLifecycle[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export function isTerminal(lifecycle: RunLifecycle | undefined): boolean {
  return lifecycle !== undefined && TERMINAL_LIFECYCLES.includes(lifecycle);
}

export interface LiveRunSnapshot {
  readonly runId: string;
  readonly lifecycle: RunLifecycle;
  readonly completeness: CollectionCompleteness;
  readonly eventCount: number;
  readonly committedCursor: number;
  readonly spoolBytes: number;
  readonly pendingBytes: number;
  readonly terminalSeen: boolean;
  readonly finalized: boolean;
  readonly lastError: string | null;
}

interface Watch {
  readonly runId: string;
  readonly adapterId: string;
  readonly streamPath: string;
  parser: JsonlChunkParser;
  /** Absolute file offset that parser offsets are relative to. */
  resumeBase: number;
  readPosition: number;
  committedCursor: number;
  nextSequence: number;
  fileKey: string | null;
  generation: number;
  terminalSeen: boolean;
  finalized: boolean;
  lastError: string | null;
}

interface RunMeta {
  readonly runId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
}

async function readMeta(dir: string): Promise<RunMeta | null> {
  let text: string;
  try {
    text = await readFile(join(dir, 'meta.json'), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Partial<RunMeta>;
    if (
      typeof parsed.runId !== 'string' || typeof parsed.adapterId !== 'string' ||
      typeof parsed.adapterVersion !== 'string' || parsed.runId.length === 0
    ) {
      return null;
    }
    return { runId: parsed.runId, adapterId: parsed.adapterId, adapterVersion: parsed.adapterVersion };
  } catch {
    return null;
  }
}

function fileKeyOf(info: { dev: number; ino: number }): string {
  return `${info.dev}:${info.ino}`;
}
function keyHasIdentity(key: string): boolean {
  const ino = Number(key.split(':')[1]);
  return Number.isInteger(ino) && ino !== 0;
}

function lossDiagnostic(loss: LossRecord): Diagnostic {
  return {
    code: `LOSS_${loss.code}`,
    severity: 'error',
    message: `input loss (${loss.code}) at line ${loss.lineIndex}, byte offset ${loss.byteOffset}, ~${loss.byteLength} bytes${loss.definitive ? '' : ' (tail may be incomplete)'}`,
    lineIndex: loss.lineIndex,
    byteOffset: loss.byteOffset,
  };
}

export class LiveCollector {
  private readonly watches = new Map<string, Watch>();
  private readonly log: (message: string) => void;

  constructor(
    private readonly store: ViewTraceStore,
    private readonly dataRoot: string,
    options: { now?: () => string; log?: (message: string) => void } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.log = options.log ?? (() => undefined);
  }

  private readonly now: () => string;

  /* ---------------------------------------------------------------- */
  /* Discovery / restart resume                                        */
  /* ---------------------------------------------------------------- */

  async scanAndResume(): Promise<void> {
    const root = liveDir(this.dataRoot);
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return; // no live dir yet — nothing to watch
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runId = entry.name;
      if (this.watches.has(runId)) continue;
      const dir = join(root, runId);
      const meta = await readMeta(dir);
      if (meta === null || meta.runId !== runId) continue;

      await this.store.createRun(runId, {
        adapterId: meta.adapterId,
        adapterVersion: meta.adapterVersion,
      });
      const state = this.store.getRun(runId);
      const cursor = state?.jsonlCursor ?? 0;

      let nextSequence = 1;
      for (const record of this.store.listRecords(runId)) {
        nextSequence = Math.max(nextSequence, record.sequence + 1);
      }
      for (const duplicate of this.store.listDuplicates(runId)) {
        nextSequence = Math.max(nextSequence, duplicate.duplicateSequence + 1);
      }

      const watch: Watch = {
        runId,
        adapterId: meta.adapterId,
        streamPath: join(dir, 'stream.jsonl'),
        parser: new JsonlChunkParser(),
        resumeBase: cursor,
        readPosition: cursor,
        committedCursor: cursor,
        nextSequence,
        fileKey: null,
        generation: 1,
        terminalSeen: isTerminal(state?.lifecycle),
        finalized: false,
        lastError: null,
      };
      this.watches.set(runId, watch);
      this.log(`watching run ${runId} (resume cursor ${cursor}, next sequence ${nextSequence})`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Pump                                                              */
  /* ---------------------------------------------------------------- */

  async tick(): Promise<void> {
    await this.scanAndResume();
    for (const watch of [...this.watches.values()]) {
      if (watch.finalized) continue;
      try {
        await this.pump(watch);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message !== watch.lastError) {
          watch.lastError = message;
          this.log(`collector error on run ${watch.runId}: ${message}`);
        }
      }
    }
  }

  private async pump(watch: Watch): Promise<void> {
    let info = await stat(watch.streamPath).catch(() => null);
    if (info === null) return;
    if (!info.isFile()) {
      watch.lastError = 'stream path is not a regular file';
      return;
    }
    const key = fileKeyOf(info);
    if (watch.fileKey === null) {
      watch.fileKey = key;
    } else if (key !== watch.fileKey && keyHasIdentity(key) && keyHasIdentity(watch.fileKey)) {
      // Rotation: a different file now lives at the spool path.
      await this.resetGeneration(watch, 'SOURCE_ROTATED');
      info = (await stat(watch.streamPath).catch(() => null)) ?? info;
    }
    if (info.size < watch.committedCursor) {
      // Truncation: the stream got shorter than what we already committed.
      await this.resetGeneration(watch, 'SOURCE_TRUNCATED');
      info = (await stat(watch.streamPath).catch(() => null)) ?? info;
    }

    let handle: FileHandle | null = null;
    try {
      let reads = 0;
      while (watch.readPosition < info.size && reads < MAX_READS_PER_TICK) {
        reads += 1;
        if (handle === null) handle = await open(watch.streamPath, 'r');
        const end = Math.min(info.size, watch.readPosition + READ_CHUNK_BYTES);
        const length = end - watch.readPosition;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, watch.readPosition);
        watch.readPosition = end;
        watch.parser.push(buffer);

        const batch = watch.parser.take();
        await this.commitBatch(watch, batch.lines, batch.losses);
      }
    } finally {
      if (handle !== null) await handle.close();
    }

    // Finalization: explicit terminal record + every byte drained (through
    // the final newline — an unterminated tail stays buffered, honestly
    // unfinalized until a newline or a truncation proves otherwise).
    const sizeNow = (await stat(watch.streamPath).catch(() => null))?.size;
    if (
      watch.terminalSeen &&
      sizeNow !== undefined &&
      watch.readPosition >= sizeNow &&
      !watch.parser.discarding &&
      watch.parser.bufferedBytes === 0
    ) {
      const finished = watch.parser.finish();
      if (finished.losses.length > 0) {
        await this.commitBatch(watch, [], finished.losses);
      }
      await this.finalize(watch);
    }
  }

  private async commitBatch(
    watch: Watch,
    lines: readonly { lineIndex: number; byteOffset: number; value: unknown }[],
    losses: readonly LossRecord[],
  ): Promise<void> {
    const diagnostics: Diagnostic[] = [];
    for (const loss of losses) diagnostics.push(lossDiagnostic(loss));

    const accepted: TraceRecord[] = [];
    for (const line of lines) {
      const captureGap = captureDiagnostic(line.value, watch.runId, watch.adapterId);
      if (captureGap) {
        diagnostics.push({ ...captureGap, lineIndex: line.lineIndex, byteOffset: line.byteOffset });
        continue;
      }
      const outcome = validateRecord(line.value);
      if (!outcome.ok) {
        for (const error of outcome.errors) {
          diagnostics.push({ ...error, lineIndex: line.lineIndex, byteOffset: line.byteOffset });
        }
        continue;
      }
      const record = outcome.record;
      if (record.runId !== watch.runId) {
        diagnostics.push({
          code: 'RUN_ID_MISMATCH',
          severity: 'error',
          message: `record targets run ${record.runId} but the spool belongs to ${watch.runId}; rejected`,
          lineIndex: line.lineIndex,
          byteOffset: line.byteOffset,
          runId: record.runId,
        });
        continue;
      }
      const sequence = watch.nextSequence;
      watch.nextSequence += 1;
      const stamped = {
        ...record,
        sequence,
        receivedAt: record.receivedAt === '' ? this.now() : record.receivedAt,
      } as TraceRecord;
      if (record.sequence !== -1 && record.sequence !== sequence) {
        diagnostics.push({
          code: 'SEQUENCE_MISMATCH',
          severity: 'warning',
          message: 'declared sequence does not match collector reception order; collector order wins',
          lineIndex: line.lineIndex,
          eventId: record.recordKind === 'event' ? record.eventId : undefined,
          runId: watch.runId,
        });
      }
      for (const warning of outcome.warnings) {
        diagnostics.push({
          ...warning,
          lineIndex: line.lineIndex,
          eventId: record.recordKind === 'event' ? record.eventId : undefined,
          runId: watch.runId,
        });
      }
      accepted.push(stamped);
      if (record.recordKind === 'run' && isTerminal(record.lifecycle)) {
        watch.terminalSeen = true;
      }
    }

    const cursor = watch.resumeBase + watch.parser.consumedOffset;
    if (accepted.length > 0 || diagnostics.length > 0 || cursor > watch.committedCursor) {
      await this.store.appendRecords(watch.runId, accepted, diagnostics, cursor);
      watch.committedCursor = cursor;
      watch.lastError = null;
    }
  }

  private async resetGeneration(
    watch: Watch,
    code: 'SOURCE_TRUNCATED' | 'SOURCE_ROTATED',
  ): Promise<void> {
    watch.generation += 1;
    watch.parser = new JsonlChunkParser();
    watch.resumeBase = 0;
    watch.readPosition = 0;
    watch.committedCursor = 0;
    watch.fileKey = null;
    this.log(`run ${watch.runId}: ${code.toLowerCase().replace('_', ' ')} — new source generation ${watch.generation}`);
    await this.store.appendRecords(
      watch.runId,
      [],
      [
        {
          code,
          severity: 'warning',
          message: `spool ${code === 'SOURCE_TRUNCATED' ? 'shrank below the committed cursor' : 'was replaced (rotation)'}; treating this as a new source generation and re-reading from byte 0 (dedup keeps this idempotent)`,
          runId: watch.runId,
        },
      ],
      0,
    );
  }

  /**
   * Computes completeness from the durable diagnostics history so it is
   * idempotent across restarts: any loss, rejection or generation reset
   * keeps the run PARTIAL forever.
   */
  private async finalize(watch: Watch): Promise<void> {
    const diagnostics = this.store.listDiagnostics(watch.runId);
    const losses = diagnostics.filter((d) => d.code.startsWith('LOSS_')).length;
    const rejects = diagnostics.filter((d) => d.severity === 'error' && !d.code.startsWith('LOSS_')).length;
    const generationReset = diagnostics.some(
      (d) => d.code === 'SOURCE_TRUNCATED' || d.code === 'SOURCE_ROTATED',
    );
    const completeness = losses + rejects > 0 || generationReset ? 'PARTIAL' : 'COMPLETE';
    await this.store.setCompleteness(watch.runId, completeness);
    watch.finalized = true;
    this.log(
      `run ${watch.runId} finalized: completeness ${completeness} (${losses} losses, ${rejects} rejections)`,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Snapshot for the control API                                      */
  /* ---------------------------------------------------------------- */

  async snapshot(): Promise<readonly LiveRunSnapshot[]> {
    const out: LiveRunSnapshot[] = [];
    for (const watch of this.watches.values()) {
      const size = (await stat(watch.streamPath).catch(() => null))?.size ?? watch.committedCursor;
      // Read SQLite and the watch together, after asynchronous I/O. A tick
      // can finalize during stat; reading SQLite before it mixed the old
      // UNKNOWN completeness with finalized=true in the control response.
      const state = this.store.getRun(watch.runId);
      out.push({
        runId: watch.runId,
        lifecycle: state?.lifecycle ?? 'UNKNOWN',
        completeness: state?.completeness ?? 'UNKNOWN',
        eventCount: state?.eventCount ?? 0,
        committedCursor: watch.committedCursor,
        spoolBytes: size,
        pendingBytes: Math.max(0, size - watch.committedCursor),
        terminalSeen: watch.terminalSeen,
        finalized: watch.finalized,
        lastError: watch.lastError,
      });
    }
    return out.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  }
}
