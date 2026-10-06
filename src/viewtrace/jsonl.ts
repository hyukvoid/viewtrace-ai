/**
 * Reference JSONL reader for ViewTrace — byte-level, incremental, loss-honest.
 *
 * Policies (fixed for schema version 1):
 *  - Lines are separated by LF (0x0A). A CR immediately before LF is stripped
 *    (CRLF tolerance); a lone CR is line *content* and will fail JSON parsing.
 *  - A UTF-8 BOM at the very start of the stream is skipped once.
 *  - A final line without a newline is accepted if it is complete, valid
 *    JSON; if it is not, it is reported as TRUNCATED_TAIL with
 *    definitive:false — the stream may simply have been cut mid-record.
 *  - A complete line (terminated by LF) that fails UTF-8 decoding or JSON
 *    parsing is a definitive loss (INVALID_UTF8 / MALFORMED_JSON).
 *  - Lines longer than maxLineBytes are discarded (OVERSIZED_LINE) without
 *    buffering them — memory stays bounded regardless of input.
 *  - Loss records carry only codes, positions and lengths — never content.
 */

import { readFile } from 'node:fs/promises';
import type { LossRecord } from './types.js';

export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export interface ParsedLine {
  readonly lineIndex: number;
  readonly byteOffset: number;
  readonly value: unknown;
}

export interface JsonlParseResult {
  readonly lines: readonly ParsedLine[];
  readonly losses: readonly LossRecord[];
  readonly blankLines: readonly number[];
  readonly totalBytes: number;
  readonly endedWithNewline: boolean;
}

interface MutableLoss {
  code: LossRecord['code'];
  lineIndex: number;
  byteOffset: number;
  byteLength: number;
  definitive: boolean;
}

export class JsonlChunkParser {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private buffer: number[] = [];
  private bufferStartOffset = 0;
  private offset = 0;
  private lineIndex = 1;
  private lines: ParsedLine[] = [];
  private losses: MutableLoss[] = [];
  private blankLines: number[] = [];
  private discardMode = false;
  private oversizedLossIndex = -1;
  private bomPending: number[] | null = [];

  constructor(private readonly maxLineBytes: number = MAX_LINE_BYTES) {}

  /**
   * Byte offset of the last complete line boundary (start of the currently
   * buffered, not-yet-terminated line). Persisting THIS offset (not the raw
   * read offset) lets a live collector restart safely in the middle of a
   * split line: only the small partial tail is re-read after a reboot.
   */
  get consumedOffset(): number {
    return this.bufferStartOffset;
  }

  /** Bytes of the current, not-yet-terminated line held in memory. */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  /** True while an oversized line is being discarded (up to its newline). */
  get discarding(): boolean {
    return this.discardMode;
  }

  /**
   * Incremental consumption for live tailing: returns everything parsed
   * since the last take() and clears the accumulator so memory stays
   * bounded no matter how long the stream runs.
   */
  take(): JsonlParseResult {
    const out: JsonlParseResult = {
      lines: this.lines,
      losses: this.losses,
      blankLines: this.blankLines,
      totalBytes: this.offset,
      endedWithNewline: this.buffer.length === 0 && !this.discardMode,
    };
    this.lines = [];
    this.losses = [];
    this.blankLines = [];
    return out;
  }

  push(chunk: Uint8Array): void {
    for (let i = 0; i < chunk.length; i++) {
      this.offset += 1;
      this.handleByte(chunk[i] as number);
    }
  }

  private handleByte(byte: number): void {
    if (this.bomPending !== null) {
      this.bomPending.push(byte);
      if (this.bomPending.length === 3) {
        const pending = this.bomPending;
        this.bomPending = null;
        const isBom = pending[0] === 0xef && pending[1] === 0xbb && pending[2] === 0xbf;
        if (isBom) {
          // Skipped: offsets keep counting the BOM bytes.
          this.bufferStartOffset = this.offset;
        } else {
          for (const b of pending) this.handleByte(b);
        }
      }
      return;
    }
    if (byte === 0x0a) {
      this.endLine(true);
      return;
    }
    this.handleContentByte(byte);
  }

  private handleContentByte(byte: number): void {
    if (this.discardMode) return;
    if (this.buffer.length >= this.maxLineBytes) {
      this.oversizedLossIndex = this.losses.length;
      this.losses.push({
        code: 'OVERSIZED_LINE',
        lineIndex: this.lineIndex,
        byteOffset: this.bufferStartOffset,
        byteLength: 0,
        definitive: true,
      });
      this.discardMode = true;
      this.buffer = [];
      return;
    }
    this.buffer.push(byte);
  }

  private endLine(hadNewline: boolean): void {
    const lineIndex = this.lineIndex;
    const startOffset = this.bufferStartOffset;

    if (this.discardMode) {
      const loss = this.losses[this.oversizedLossIndex];
      if (loss !== undefined) {
        loss.byteLength = hadNewline ? this.offset - 1 - startOffset : this.offset - startOffset;
        loss.definitive = hadNewline;
      }
      this.discardMode = false;
    } else {
      // Strip a trailing CR (CRLF tolerance).
      if (this.buffer.length > 0 && this.buffer[this.buffer.length - 1] === 0x0d) {
        this.buffer.pop();
      }
      if (this.buffer.length === 0) {
        this.blankLines.push(lineIndex);
      } else {
        this.decodeAndParse(this.buffer, lineIndex, startOffset, hadNewline);
      }
    }
    this.buffer = [];
    this.lineIndex += 1;
    this.bufferStartOffset = this.offset;
  }

  private decodeAndParse(
    bytes: readonly number[],
    lineIndex: number,
    startOffset: number,
    hadNewline: boolean,
  ): void {
    const view = new Uint8Array(bytes);
    let text: string;
    try {
      text = this.decoder.decode(view);
    } catch {
      this.losses.push({
        code: hadNewline ? 'INVALID_UTF8' : 'TRUNCATED_TAIL',
        lineIndex,
        byteOffset: startOffset,
        byteLength: bytes.length,
        definitive: hadNewline,
      });
      return;
    }
    if (text.trim().length === 0) {
      // Whitespace-only lines are treated as blank, not as malformed records.
      this.blankLines.push(lineIndex);
      return;
    }
    try {
      const value: unknown = JSON.parse(text);
      this.lines.push({ lineIndex, byteOffset: startOffset, value });
    } catch {
      this.losses.push({
        code: hadNewline ? 'MALFORMED_JSON' : 'TRUNCATED_TAIL',
        lineIndex,
        byteOffset: startOffset,
        byteLength: bytes.length,
        definitive: hadNewline,
      });
    }
  }

  finish(): JsonlParseResult {
    if (this.bomPending !== null) {
      const pending = this.bomPending;
      this.bomPending = null;
      for (const b of pending) this.handleByte(b);
    }
    const endedWithNewline = this.buffer.length === 0 && !this.discardMode;
    if (this.discardMode) {
      // Oversized tail that never met a newline.
      const loss = this.losses[this.oversizedLossIndex];
      if (loss !== undefined) {
        loss.byteLength = this.offset - this.bufferStartOffset;
        loss.definitive = false;
      }
      this.discardMode = false;
      this.lineIndex += 1;
    } else if (this.buffer.length > 0) {
      this.endLine(false);
    }
    return {
      lines: this.lines,
      losses: this.losses,
      blankLines: this.blankLines,
      totalBytes: this.offset,
      endedWithNewline,
    };
  }
}

export async function parseJsonlFile(
  path: string,
  opts?: { maxLineBytes?: number },
): Promise<JsonlParseResult> {
  const bytes = await readFile(path);
  const parser = new JsonlChunkParser(opts?.maxLineBytes);
  parser.push(bytes);
  return parser.finish();
}

/** Split a buffer into chunks of exactly `size` bytes (test/perf helper). */
export function chunkBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(bytes.slice(i, i + size));
  }
  return out;
}
