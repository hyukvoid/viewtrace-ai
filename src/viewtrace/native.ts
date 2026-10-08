/** Native public-output boundary. Raw packets, prompts and thinking never reach the spool. */
import { createHash } from 'node:crypto';
import { ANSWER_HASH_VERSION, answerHash, normalizedAnswer } from './answer.js';
import { redactSecrets } from './privacy.js';
import type { Diagnostic, OperationStatus } from './types.js';

export type NativeAdapterId = 'codex' | 'claude-code';
export const NATIVE_VERSION = '1.0.0';
export function isNativeAdapter(id: string): id is NativeAdapterId {
  return id === 'codex' || id === 'claude-code';
}
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? redactSecrets(value) : undefined;
}
export function nativeId(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40);
}

const GAP_MESSAGES = {
  NATIVE_MALFORMED: 'Native input was malformed or oversized; its contents were discarded.',
  NATIVE_DRIFT: 'Native format/version is outside the verified contract; collection is partial.',
  NATIVE_UNKNOWN_TOOL: 'An unsupported native tool/action was omitted; no research event was invented.',
  NATIVE_NESTED: 'Nested-agent output was excluded from the main answer scope.',
  NATIVE_MISSING_RESULT: 'A native call has no corresponding result; its outcome is UNKNOWN.',
  NATIVE_ORPHAN_RESULT: 'A result has no corresponding native call; no source/query was invented.',
  NATIVE_BOUNDARY: 'The native turn boundary or final answer identity is missing or conflicting.',
  NATIVE_FAILED: 'The native agent reported an unsuccessful result; no final receipt was issued.',
} as const;
export type NativeGapCode = keyof typeof GAP_MESSAGES;
export function nativeGap(runId: string, adapterId: NativeAdapterId, code: NativeGapCode) {
  return { recordKind: 'capture-diagnostic', runId, adapterId, code };
}
/** A control envelope, never a TraceRecord. Only fixed codes survive the boundary. */
export function captureDiagnostic(value: unknown, runId: string, adapterId: string): Diagnostic | null {
  const packet = object(value);
  if (!isNativeAdapter(adapterId) || packet.recordKind !== 'capture-diagnostic' ||
      packet.runId !== runId || packet.adapterId !== adapterId ||
      typeof packet.code !== 'string' || !Object.hasOwn(GAP_MESSAGES, packet.code)) return null;
  return { runId, code: packet.code, severity: 'error', message: GAP_MESSAGES[packet.code as NativeGapCode] };
}

interface Call { id: string; kind: 'SEARCH' | 'READ'; query?: string; location?: string; }
interface Result { id: string; content?: string; failed: boolean; links: { title?: string; url: string }[]; }
function linksFrom(value: unknown): { title?: string; url: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(v => {
    const r = object(v), url = text(r.url);
    return url && /^https?:\/\//i.test(url) ? [{ url, title: text(r.title) }] : [];
  });
}
function resultText(value: unknown): string | undefined {
  if (typeof value === 'string') return text(value)?.slice(0, 16_000);
  if (Array.isArray(value)) return value.flatMap(v => {
    const block = object(v);
    return block.type === 'text' && typeof block.text === 'string' ? [redactSecrets(block.text)] : [];
  }).join('\n').slice(0, 16_000) || undefined;
  return undefined;
}
/** Claude's verified WebSearch result embeds a JSON Links array. Prose URLs are not search results. */
function claudeLinks(content: string | undefined) {
  const match = /^Links:\s*(\[[^\n]*\])/m.exec(content ?? '');
  if (!match) return [];
  try { return linksFrom(JSON.parse(match[1]!)); } catch { return []; }
}

export interface NativeCaptureOptions {
  adapterId: NativeAdapterId;
  runId: string;
  now?: () => string;
  agentVersion?: string;
}

/** Stateful matching uses provider call IDs, never arrival adjacency or model prose. */
export class NativeCapture {
  private readonly calls = new Map<string, Call>();
  private readonly results = new Map<string, Result>();
  private readonly completed = new Set<string>();
  private readonly seen = new Map<string, string>();
  private scope: string[] = [];
  private boundary = false;
  private session?: string;
  private candidate?: { id: string; answer: string };
  private gaps = new Set<NativeGapCode>();
  private started = false;
  private terminal = false;
  private failed = false;
  private turnNumber = 0;
  private out: unknown[] = [];
  readonly adapterId: NativeAdapterId;
  readonly runId: string;
  private readonly now: () => string;

  constructor(options: NativeCaptureOptions) {
    this.adapterId = options.adapterId; this.runId = options.runId;
    this.now = options.now ?? (() => new Date().toISOString());
    if (this.adapterId === 'codex' && options.agentVersion !== '0.160.1') this.warn('NATIVE_DRIFT');
  }
  private base() {
    return { schemaVersion: 1, runId: this.runId, occurredAt: this.now(),
      adapterId: this.adapterId, adapterVersion: NATIVE_VERSION };
  }
  gap(code: NativeGapCode): unknown[] {
    this.warn(code);
    return this.take();
  }
  private warn(code: NativeGapCode) {
    if (!this.gaps.has(code)) { this.gaps.add(code); this.out.push(nativeGap(this.runId, this.adapterId, code)); }
  }
  private take(): unknown[] { const out = this.out; this.out = []; return out; }
  private begin(session: unknown) {
    const next = text(session);
    if (this.session && next && this.session !== next) { this.warn('NATIVE_BOUNDARY'); this.boundary = false; }
    this.session = next ?? this.session;
    if (!this.started) { this.started = true; this.out.push({ ...this.base(), recordKind: 'run', lifecycle: 'RUNNING' }); }
  }
  private beginTurn() {
    if (this.boundary) this.warn('NATIVE_BOUNDARY');
    this.flushMissing(); this.scope = []; this.candidate = undefined;
    this.calls.clear(); this.results.clear(); this.completed.clear(); this.seen.clear();
    this.boundary = true; this.terminal = false; this.turnNumber++;
  }
  private emit(call: Call, result?: Result) {
    if (this.completed.has(call.id)) return;
    this.completed.add(call.id);
    const eventId = `native-${nativeId(this.runId, String(this.turnNumber), call.id)}`;
    const sourceId = `source-${nativeId(call.location ?? `${this.adapterId}:${call.id}`)}`;
    const outcome: OperationStatus = !result ? 'UNKNOWN' : result.failed ? 'FAILED' : 'SUCCESS';
    this.scope.push(eventId);
    this.out.push({ ...this.base(), recordKind: 'event', eventId, type: call.kind,
      origin: { producer: `${this.adapterId}-public-stream`, agent: this.adapterId, tool: call.kind === 'SEARCH' ? 'web-search' : 'read' },
      source: { sourceId, kind: call.location?.startsWith('http') ? 'URL' : call.location ? 'FILE' : 'TOOL_RESULT', location: call.location },
      provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: call.id, toolResultId: result?.id } },
      payload: call.kind === 'SEARCH'
        ? { type: 'SEARCH', query: call.query ?? '', results: result?.failed ? [] : (result?.links ?? []).map((r, i) => ({ sourceId: `source-${nativeId(r.url)}`, ...r, rank: i + 1 })) }
        : { type: 'READ', sourceId, outcome, summary: result?.content },
    });
    if (!result) this.warn('NATIVE_MISSING_RESULT');
  }
  private match(id: string) {
    const call = this.calls.get(id), result = this.results.get(id);
    if (call && result) this.emit(call, result);
  }
  private flushMissing() {
    for (const call of this.calls.values()) if (!this.completed.has(call.id)) this.emit(call);
    for (const id of this.results.keys()) if (!this.calls.has(id)) this.warn('NATIVE_ORPHAN_RESULT');
  }
  private final(id: string | undefined, answer: string | undefined) {
    this.flushMissing();
    if (!id || !answer) { this.warn('NATIVE_BOUNDARY'); return; }
    const localId = nativeId(this.runId, String(this.turnNumber), id);
    const occurredAt = this.now(), answerId = `answer-${localId}`;
    // Public prose is one opaque reported CLAIM; it is never parsed into VERIFY/COMPARE/etc.
    const eventId = `claim-${localId}`;
    this.scope.push(eventId);
    this.out.push({ ...this.base(), occurredAt, recordKind: 'event', eventId, type: 'CLAIM',
      origin: { producer: `${this.adapterId}-public-stream`, agent: this.adapterId },
      source: { sourceId: `answer-${nativeId(id)}`, kind: 'UNKNOWN' },
      provenance: { category: 'AGENT_REPORTED' }, payload: { type: 'CLAIM', text: answer },
    });
    this.out.push({ ...this.base(), occurredAt, recordKind: 'answer', receiptVersion: 1,
      receiptId: `receipt-${localId}`, agentId: this.adapterId,
      agentSessionId: this.session, answerId, answer, answerHash: answerHash(answer),
      hashVersion: ANSWER_HASH_VERSION, final: true, timestamp: occurredAt,
      // Exec/stream-json do not expose a provider turnID. Never synthesize one.
      eventIds: this.boundary ? [...this.scope] : undefined,
    });
  }
  consume(value: unknown): unknown[] {
    const p = object(value);
    if (typeof p.type !== 'string') return this.gap('NATIVE_MALFORMED');
    const startsTurn = this.adapterId === 'codex'
      ? p.type === 'turn.started' || p.type === 'thread.started'
      : p.type === 'system' && p.subtype === 'init';
    if (this.terminal && !startsTurn) return this.gap('NATIVE_BOUNDARY');
    if (this.adapterId === 'codex') this.codex(p); else this.claude(p);
    return this.take();
  }
  private codex(p: Record<string, unknown>) {
    if (p.type === 'thread.started') { this.begin(p.thread_id); return; }
    if (p.type === 'turn.started') { this.begin(undefined); this.beginTurn(); return; }
    if (p.type === 'turn.failed' || p.type === 'error') { this.failed = true; this.warn('NATIVE_FAILED'); return; }
    if (p.type === 'turn.completed') {
      if (this.terminal || this.failed) { this.warn('NATIVE_BOUNDARY'); return; }
      this.final(this.candidate?.id, this.candidate?.answer); this.boundary = false; this.terminal = true; return;
    }
    if (!['item.started', 'item.updated', 'item.completed'].includes(String(p.type))) { this.warn('NATIVE_DRIFT'); return; }
    const item = object(p.item), id = text(item.id);
    if (item.type === 'reasoning') return;
    if (!id) { this.warn('NATIVE_DRIFT'); return; }
    if (item.type === 'agent_message') {
      if (p.type === 'item.completed' && text(item.text)) this.candidate = { id, answer: normalizedAnswer(text(item.text)!) };
      return;
    }
    if (item.type !== 'web_search') { this.warn('NATIVE_UNKNOWN_TOOL'); return; }
    // started packets may contain action.other placeholders. Mapping waits for the result.
    if (p.type !== 'item.completed') { this.seen.set(id, 'pending'); return; }
    const action = object(item.action), query = text(action.query ?? item.query);
    let call: Call;
    if (action.type === 'search' && query) call = { id, kind: 'SEARCH', query };
    else if (action.type === 'open_page' && text(action.url)) call = { id, kind: 'READ', location: text(action.url) };
    else { this.warn('NATIVE_UNKNOWN_TOOL'); this.seen.delete(id); return; }
    const priorCall = this.calls.get(id);
    if (priorCall && JSON.stringify(priorCall) !== JSON.stringify(call)) { this.warn('NATIVE_BOUNDARY'); return; }
    this.calls.set(id, call); this.seen.delete(id);
    if (!Array.isArray(item.results)) { this.warn('NATIVE_MISSING_RESULT'); return; }
    const failed = item.results.some(r => object(r).title === 'Internal Error');
    const result = { id, failed, links: linksFrom(item.results),
      content: item.results.flatMap(r => text(object(r).snippet) ?? []).join('\n').slice(0, 16_000) };
    const priorResult = this.results.get(id);
    if (priorResult && JSON.stringify(priorResult) !== JSON.stringify(result)) { this.warn('NATIVE_BOUNDARY'); return; }
    this.results.set(id, result);
    this.match(id);
  }
  private claude(p: Record<string, unknown>) {
    if (p.type === 'system') {
      if (p.subtype === 'init') {
        this.begin(p.session_id); this.beginTurn();
        if (p.claude_code_version !== '2.1.121') this.warn('NATIVE_DRIFT');
      } else this.warn('NATIVE_DRIFT');
      return;
    }
    if (p.parent_tool_use_id !== undefined && p.parent_tool_use_id !== null) { this.warn('NATIVE_NESTED'); return; }
    if (p.session_id && this.session && p.session_id !== this.session) { this.warn('NATIVE_BOUNDARY'); return; }
    if (p.type === 'result') {
      if (this.terminal) { this.warn('NATIVE_BOUNDARY'); return; }
      if (p.is_error !== false || p.subtype !== 'success') { this.failed = true; this.warn('NATIVE_FAILED'); }
      else this.final(text(p.uuid), text(p.result));
      this.boundary = false; this.terminal = true; return;
    }
    if (p.type !== 'assistant' && p.type !== 'user') { this.warn('NATIVE_DRIFT'); return; }
    const blocks = object(p.message).content;
    if (!Array.isArray(blocks)) { this.warn('NATIVE_DRIFT'); return; }
    for (const raw of blocks) {
      const b = object(raw);
      if (b.type === 'thinking' || b.type === 'redacted_thinking' || b.type === 'text') continue;
      if (p.type === 'assistant' && b.type === 'tool_use') {
        const id = text(b.id), input = object(b.input);
        if (!id) { this.warn('NATIVE_DRIFT'); continue; }
        let call: Call;
        if (b.name === 'WebSearch' && text(input.query)) call = { id, kind: 'SEARCH', query: text(input.query) };
        else if (b.name === 'WebFetch' && text(input.url)) call = { id, kind: 'READ', location: text(input.url) };
        else if (b.name === 'Read' && text(input.file_path)) call = { id, kind: 'READ', location: text(input.file_path) };
        else { this.warn('NATIVE_UNKNOWN_TOOL'); continue; }
        const prior = this.calls.get(id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(call)) { this.warn('NATIVE_BOUNDARY'); continue; }
        this.calls.set(id, call); this.match(id);
      } else if (p.type === 'user' && b.type === 'tool_result') {
        const id = text(b.tool_use_id), content = resultText(b.content);
        if (!id) { this.warn('NATIVE_DRIFT'); continue; }
        const result = { id, content, failed: b.is_error === true, links: claudeLinks(content) };
        const prior = this.results.get(id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(result)) { this.warn('NATIVE_BOUNDARY'); continue; }
        this.results.set(id, result); this.match(id);
      } else this.warn('NATIVE_DRIFT');
    }
  }
  /** Called at EOF, including cancellation. Partial prose never becomes a final answer. */
  finish(): unknown[] {
    this.begin(undefined); this.flushMissing();
    if (this.seen.size > 0) this.warn('NATIVE_MISSING_RESULT');
    if (!this.terminal) this.warn('NATIVE_BOUNDARY');
    return this.take();
  }
  get unsuccessful(): boolean { return this.failed; }
  get lifecycle(): 'FAILED' | 'COMPLETED' | 'UNKNOWN' {
    return this.failed ? 'FAILED' : this.terminal ? 'COMPLETED' : 'UNKNOWN';
  }
}
