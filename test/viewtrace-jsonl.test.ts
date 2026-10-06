import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JsonlChunkParser, chunkBytes, parseJsonlFile } from '../src/viewtrace/jsonl.js';
import { viewtraceFixture } from './helpers/viewtrace.js';

const encoder = new TextEncoder();

function parseBytes(bytes: Uint8Array, opts?: { maxLineBytes?: number }) {
  const parser = new JsonlChunkParser(opts?.maxLineBytes);
  parser.push(bytes);
  return parser.finish();
}

describe('viewtrace jsonl reader: line handling', () => {
  it('parses LF-separated records with correct line indexes and byte offsets', () => {
    const bytes = encoder.encode('{"a":1}\n{"b":2}\n');
    const result = parseBytes(bytes);
    assert.equal(result.lines.length, 2);
    assert.equal(result.lines[0]?.lineIndex, 1);
    assert.equal(result.lines[0]?.byteOffset, 0);
    assert.equal(result.lines[1]?.lineIndex, 2);
    assert.equal(result.lines[1]?.byteOffset, 8);
    assert.equal(result.endedWithNewline, true);
    assert.equal(result.losses.length, 0);
  });

  it('strips a trailing CR (CRLF) and treats interior CR as JSON whitespace', () => {
    const crlf = parseBytes(encoder.encode('{"a":1}\r\n{"b":2}\r\n'));
    assert.deepEqual(crlf.lines.map((l) => l.value), [{ a: 1 }, { b: 2 }]);
    assert.equal(crlf.losses.length, 0);
    // A CR that is not immediately before LF is JSON whitespace (RFC 8259)
    // and therefore parses — it is only a CR directly before LF that is stripped.
    const interiorCr = parseBytes(encoder.encode('{"bad":\rtrue}\n'));
    assert.equal(interiorCr.lines.length, 1);
    assert.deepEqual(interiorCr.lines[0]?.value, { bad: true });
    const crOnlyLine = parseBytes(encoder.encode('{"a":1}\n\r\n'));
    assert.deepEqual(crOnlyLine.blankLines, [2], 'a CR-only line is blank');
  });

  it('skips blank and whitespace-only lines without counting them as losses', () => {
    const result = parseBytes(encoder.encode('\n{"a":1}\n   \n\n{"b":2}\n'));
    assert.equal(result.lines.length, 2);
    assert.deepEqual(result.blankLines, [1, 3, 4]);
    assert.equal(result.losses.length, 0);
  });

  it('accepts a complete final record without trailing newline', () => {
    const result = parseBytes(encoder.encode('{"a":1}\n{"b":2}'));
    assert.equal(result.lines.length, 2);
    assert.equal(result.endedWithNewline, false);
    assert.equal(result.losses.length, 0);
  });

  it('reports an incomplete final record as a non-definitive truncated tail', () => {
    const result = parseBytes(encoder.encode('{"a":1}\n{"recordKind":"eve'));
    assert.equal(result.lines.length, 1);
    assert.equal(result.losses.length, 1);
    const loss = result.losses[0];
    assert.equal(loss?.code, 'TRUNCATED_TAIL');
    assert.equal(loss?.definitive, false);
    assert.equal(loss?.lineIndex, 2);
    assert.equal(loss?.byteOffset, 8);
  });

  it('reports a definitively malformed middle line and keeps parsing later lines', () => {
    const result = parseBytes(encoder.encode('{"a":1}\n{"broken": tru\n{"c":3}\n'));
    assert.equal(result.lines.length, 2);
    assert.deepEqual(result.lines.map((l) => l.value), [{ a: 1 }, { c: 3 }]);
    const loss = result.losses[0];
    assert.equal(loss?.code, 'MALFORMED_JSON');
    assert.equal(loss?.definitive, true);
    assert.equal(loss?.lineIndex, 2);
    assert.equal(loss?.byteOffset, 8);
  });

  it('reports invalid UTF-8 in a complete line as definitive, in a tail as truncated', () => {
    const mid = parseBytes(new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0xfe, 0x7d, 0x0a]));
    assert.equal(mid.losses[0]?.code, 'INVALID_UTF8');
    assert.equal(mid.losses[0]?.definitive, true);
    const tail = parseBytes(new Uint8Array([0x7b, 0x22, 0xec, 0x9c]));
    assert.equal(tail.losses[0]?.code, 'TRUNCATED_TAIL');
    assert.equal(tail.losses[0]?.definitive, false);
  });

  it('strips a UTF-8 BOM at the start of the stream once', () => {
    const withBom = new Uint8Array([...encoder.encode('\uFEFF'), ...encoder.encode('{"a":1}\n')]);
    const result = parseBytes(withBom);
    assert.equal(result.lines.length, 1);
    assert.deepEqual(result.lines[0]?.value, { a: 1 });
    assert.equal(result.lines[0]?.byteOffset, 3, 'offsets count the skipped BOM bytes');
  });

  it('discards oversized lines without buffering them and keeps later lines', () => {
    const long = 'x'.repeat(200);
    const bytes = encoder.encode(`{"a":1}\n{"pad":"${long}"}\n{"b":2}\n`);
    const result = parseBytes(bytes, { maxLineBytes: 64 });
    assert.deepEqual(result.lines.map((l) => l.value), [{ a: 1 }, { b: 2 }]);
    assert.equal(result.losses.length, 1);
    assert.equal(result.losses[0]?.code, 'OVERSIZED_LINE');
    assert.equal(result.losses[0]?.definitive, true);
    assert.equal(result.losses[0]?.lineIndex, 2);
  });

  it('reports an oversized tail without a terminating newline as non-definitive', () => {
    const bytes = encoder.encode('{"a":1}\n{"pad":"' + 'y'.repeat(300) + '"}');
    const result = parseBytes(bytes, { maxLineBytes: 64 });
    assert.equal(result.lines.length, 1);
    assert.equal(result.losses[0]?.code, 'OVERSIZED_LINE');
    assert.equal(result.losses[0]?.definitive, false);
  });
});

describe('viewtrace jsonl reader: chunk boundaries', () => {
  const sample = encoder.encode(
    '{"query":"한글 멀티바이트 쿼리 🚀","결과":["노드 제이에스","SQLite"]}\n' +
      '{"recordKind":"run","runId":"경계-테스트"}\n' +
      '{"broken":\n' +
      '{"tail":"마지막"}',
  );

  it('produces identical results for every chunk size 1..16 (Korean/emoji split boundaries)', () => {
    const whole = parseBytes(sample);
    for (let size = 1; size <= 16; size++) {
      const parser = new JsonlChunkParser();
      for (const chunk of chunkBytes(sample, size)) parser.push(chunk);
      const chunked = parser.finish();
      assert.deepEqual(
        chunked.lines,
        whole.lines,
        `chunk size ${size}: lines differ`,
      );
      assert.deepEqual(
        chunked.losses,
        whole.losses,
        `chunk size ${size}: losses differ`,
      );
      assert.equal(chunked.endedWithNewline, whole.endedWithNewline);
      assert.equal(chunked.totalBytes, whole.totalBytes);
    }
  });

  it('feeds the real fixture one byte at a time without corruption', async () => {
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(viewtraceFixture('research-normal.jsonl'));
    const whole = parseBytes(bytes);
    assert.ok(whole.lines.length > 0);
    assert.equal(whole.losses.length, 0);
    const parser = new JsonlChunkParser();
    for (const chunk of chunkBytes(bytes, 1)) parser.push(chunk);
    const oneByte = parser.finish();
    assert.deepEqual(oneByte.lines, whole.lines);
    assert.equal(oneByte.losses.length, 0);
  });
});

describe('viewtrace jsonl reader: honesty of loss reporting', () => {
  it('never includes record content in loss records or messages', async () => {
    const bytes = encoder.encode('{"secret":"TOKEN-ABC-123"}\n{"broken":\n');
    const result = parseBytes(bytes);
    const serialized = JSON.stringify(result.losses);
    assert.ok(!serialized.includes('TOKEN-ABC-123'));
    assert.ok(!serialized.includes('secret'));
  });
});
