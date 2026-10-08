import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NativeCapture, captureDiagnostic, nativeId } from '../src/viewtrace/native.js';
import { captureHook, installHooks, uninstallHooks } from '../src/viewtrace/hooks.js';
import type { NativeAdapterId } from '../src/viewtrace/native.js';
import { validateRecord } from '../src/viewtrace/validate.js';
import { ingestFile } from '../src/viewtrace/ingest.js';
import { ViewTraceStore } from '../src/viewtrace/store.js';
import { answerReport, answerAnalysisReport } from '../src/viewtrace/report.js';
import { resolveAnswer } from '../src/viewtrace/resolver.js';
import { FIXED_NOW, repoRoot, tempDataRoot } from './helpers/viewtrace.js';
import type { AnswerReceipt } from '../src/viewtrace/answer.js';
import { upService, downService, runBin, writeProducer } from './helpers/m1.js';

const nativeRoot = join(repoRoot, 'fixtures/viewtrace/native');
const init = { type: 'system', subtype: 'init', session_id: 'native-session', claude_code_version: '2.1.121' };
const call = (id: string, name: string, input: unknown) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, content: unknown, is_error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
const final = { type: 'result', subtype: 'success', is_error: false, session_id: 'native-session', uuid: 'native-result', result: 'Public answer' };

function mapped(adapterId: NativeAdapterId, packets: unknown[]) {
  const capture = new NativeCapture({ adapterId, runId: 'run-native-test', now: FIXED_NOW, agentVersion: adapterId === 'codex' ? '0.160.1' : undefined });
  const output = [...packets.flatMap(p => capture.consume(p)), ...capture.finish()];
  const diagnostics = output.flatMap(p => captureDiagnostic(p, 'run-native-test', adapterId) ?? []);
  const records = output.filter(p => !captureDiagnostic(p, 'run-native-test', adapterId)).map(p => {
    const v = validateRecord(p); assert.equal(v.ok, true, JSON.stringify(v));
    if (!v.ok) throw new Error('invalid mapping'); return v.record;
  });
  return { records, diagnostics, output };
}

describe('M5 native public capture contracts', () => {
  it('matches parallel out-of-order results by native ID and preserves failed READ', () => {
    const m = mapped('claude-code', [init,
      result('two', 'Request failed', true), call('one', 'WebFetch', { url: 'https://example.org/one' }),
      call('two', 'WebFetch', { url: 'https://example.org/two' }), result('one', 'Actual public read'), final]);
    const reads = m.records.flatMap(r => r.recordKind === 'event' && r.payload.type === 'READ' ? [r.payload.outcome] : []);
    assert.equal(reads.length, 2);
    assert.equal(reads[0], 'FAILED');
    assert.equal(reads[1], 'SUCCESS');
    assert.equal(m.diagnostics.length, 0);
    const receipt = m.records.find(r => r.recordKind === 'answer')! as AnswerReceipt;
    assert.equal(receipt.agentSessionId, 'native-session'); assert.equal(receipt.turnId, undefined);
    assert.equal(receipt.eventIds?.length, 3);
  });
  it('call-only, unknown, nested, version drift, missing boundary and error subtype never become fabricated success', () => {
    const missing = mapped('claude-code', [init, call('read-only', 'Read', { file_path: 'public.txt' }), final]);
    const read = missing.records.find(r => r.recordKind === 'event' && r.type === 'READ');
    assert.equal(read?.recordKind === 'event' && read.payload.type === 'READ' && read.payload.outcome, 'UNKNOWN');
    assert.ok(missing.diagnostics.some(d => d.code === 'NATIVE_MISSING_RESULT'));
    const m = mapped('claude-code', [{ ...init, claude_code_version: '99.0.0' },
      call('unknown', 'VerifyEverything', { reasoning: 'PRIVATE_MARKER' }),
      { ...call('nested', 'WebSearch', { query: 'nested' }), parent_tool_use_id: 'parent' },
      { ...final, is_error: true, result: 'Not logged in' }]);
    assert.equal(m.records.filter(r => r.recordKind === 'answer' || r.recordKind === 'event').length, 0);
    for (const code of ['NATIVE_DRIFT', 'NATIVE_UNKNOWN_TOOL', 'NATIVE_NESTED', 'NATIVE_FAILED']) assert.ok(m.diagnostics.some(d => d.code === code));
    const orphan = mapped('claude-code', [result('absent', 'public'), final]);
    assert.ok(orphan.diagnostics.some(d => d.code === 'NATIVE_ORPHAN_RESULT'));
    assert.equal((orphan.records.find(r => r.recordKind === 'answer') as AnswerReceipt).eventIds, undefined);
  });
  it('Codex progress, reasoning and cancelled/missing final output create no receipt; repeated answers keep separate turn scopes', () => {
    const prefix = [{ type: 'thread.started', thread_id: 'native-thread' }, { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'thinking', type: 'reasoning', text: 'PRIVATE_MARKER' } },
      { type: 'item.completed', item: { id: 'progress', type: 'agent_message', text: 'Starting research' } }];
    assert.equal(mapped('codex', prefix).records.filter(r => r.recordKind === 'answer').length, 0);
    const answer = (id: string) => ({ type: 'item.completed', item: { id, type: 'agent_message', text: 'Same answer' } });
    const m = mapped('codex', [...prefix, answer('first-final'), { type: 'turn.completed' },
      { type: 'turn.started' }, answer('second-final'), { type: 'turn.completed' }]);
    const receipts = m.records.filter(r => r.recordKind === 'answer');
    assert.equal(receipts.length, 2); assert.notEqual(receipts[0]?.receiptId, receipts[1]?.receiptId);
    assert.equal(receipts[0]?.answerHash, receipts[1]?.answerHash);
    assert.notDeepEqual(receipts[0]?.eventIds, receipts[1]?.eventIds);
    assert.ok(!JSON.stringify(m.output).includes('PRIVATE_MARKER'));
    assert.ok(m.records.every(r => r.recordKind !== 'event' || r.type === 'CLAIM'));
  });
  it('whitelists text blocks and sanitizes secrets without retaining prompt/debug metadata', () => {
    const m = mapped('claude-code', [
      { ...init, api_key: 'SECRET_MARKER', prompt: 'PROMPT_MARKER' },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'PRIVATE_MARKER', signature: 'PRIVATE_MARKER' }] } },
      call('r', 'WebFetch', { url: 'https://example.org/', prompt: 'PROMPT_MARKER' }),
      result('r', [{ type: 'thinking', thinking: 'PRIVATE_MARKER' }, { type: 'text', text: 'api_key=SECRET_MARKER public' }]),
      { ...final, result: 'Bearer secret1234567890 public answer' },
    ]);
    const s = JSON.stringify(m.output);
    for (const marker of ['PRIVATE_MARKER', 'PROMPT_MARKER', 'SECRET_MARKER', 'secret1234567890']) assert.ok(!s.includes(marker), marker);
    assert.ok(s.includes('[REDACTED]'));
  });
  it('reused Codex item IDs stay distinct across turns and conflicting results remain partial', () => {
    const start = { type: 'turn.started' }, end = { type: 'turn.completed' };
    const answer = { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Same answer' } };
    const m = mapped('codex', [{ type: 'thread.started', thread_id: 'thread' }, start, answer, end, start, answer, end]);
    const receipts = m.records.filter(r => r.recordKind === 'answer');
    assert.equal(receipts.length, 2);
    assert.notEqual(receipts[0]?.receiptId, receipts[1]?.receiptId);
    assert.notDeepEqual(receipts[0]?.eventIds, receipts[1]?.eventIds);
    const search = { type: 'item.completed', item: { id: 'search', type: 'web_search', action: { type: 'search', query: 'public' }, results: [{ url: 'https://example.org/one' }] } };
    const conflict = mapped('codex', [start, search, { ...search, item: { ...search.item, results: [{ url: 'https://example.org/two' }] } }, answer, end]);
    assert.ok(conflict.diagnostics.some(d => d.code === 'NATIVE_BOUNDARY'));
    assert.equal(conflict.records.filter(r => r.recordKind === 'event' && r.type === 'SEARCH').length, 1);
  });
  it('late results after a final boundary cannot extend the saved answer scope', () => {
    const m = mapped('claude-code', [init, final, call('late', 'Read', { file_path: 'public.txt' }), result('late', 'Late read')]);
    assert.ok(m.diagnostics.some(d => d.code === 'NATIVE_BOUNDARY'));
    assert.equal(m.records.filter(r => r.recordKind === 'event' && r.type === 'READ').length, 0);
    assert.equal(m.records.filter(r => r.recordKind === 'answer').length, 1);
  });
});

describe('M5 project opt-in hook contracts', () => {
  it('preserves existing config and refuses removing user edits to owned files', async () => {
    const project = await tempDataRoot('hook-project'), data = await tempDataRoot('hook-data');
    await mkdir(join(project, '.claude'));
    const existing = '{"permissions":{"allow":[]}}\r\n';
    await writeFile(join(project, '.claude', 'settings.local.json'), existing);
    const settings = await installHooks(project, data);
    const original = await readFile(settings, 'utf8');
    await writeFile(settings, original + ' ');
    await assert.rejects(uninstallHooks(project), /HOOK_FILE_CHANGED/);
    assert.equal(await readFile(settings, 'utf8'), original + ' ');
    await writeFile(settings, original);
    await uninstallHooks(project);
    assert.equal(await readFile(join(project, '.claude', 'settings.local.json'), 'utf8'), existing);
    await assert.rejects(stat(settings), { code: 'ENOENT' });
  });
  it('captures separate multi-turn scopes with reused call IDs without storing thinking or prompts', async () => {
    const project = await tempDataRoot('hook-turns'), data = await tempDataRoot('hook-turns-data');
    const session_id = 'hook-session', runId = `run-claude-hook-${nativeId(session_id)}`;
    const send = (hook_event_name: string, extra = {}) => captureHook({ session_id, cwd: project, hook_event_name,
      prompt: 'PROMPT_MARKER', thinking: 'PRIVATE_MARKER', ...extra }, project, data);
    await send('SessionStart');
    for (const url of ['https://example.org/one', 'https://example.org/two']) {
      await send('PreToolUse', { tool_use_id: '__proto__', tool_name: 'WebFetch', tool_input: { url } });
      await send('PostToolUse', { tool_use_id: '__proto__', tool_name: 'WebFetch', tool_input: { url }, tool_response: { result: 'Public read' } });
      await send('Stop', { last_assistant_message: 'Same public answer', stop_hook_active: false });
    }
    await send('SessionEnd');
    const path = join(data, 'live', runId, 'stream.jsonl'), raw = await readFile(path, 'utf8');
    const records = raw.trim().split('\n').map(line => {
      const validated = validateRecord(JSON.parse(line));
      assert.equal(validated.ok, true, JSON.stringify(validated));
      if (!validated.ok) throw new Error('invalid hook output'); return validated.record;
    });
    const receipts = records.filter(r => r.recordKind === 'answer');
    assert.equal(receipts.length, 2); assert.notEqual(receipts[0]?.receiptId, receipts[1]?.receiptId);
    assert.ok(receipts.every(r => r.turnId === undefined && r.eventIds?.length === 2));
    assert.ok(receipts[0]?.eventIds?.every(id => !receipts[1]?.eventIds?.includes(id)));
    assert.equal(records.filter(r => r.recordKind === 'event' && r.type === 'READ').length, 2);
    const replayRoot = await tempDataRoot('hook-replay');
    const outcome = await ingestFile(path, { dataRoot: replayRoot });
    assert.equal(outcome.runs[0]?.completeness, 'COMPLETE'); assert.equal(outcome.runs[0]?.eventsAccepted, 4);
    const state = await readFile(join(data, 'live', runId, 'hook-state.json'), 'utf8');
    for (const marker of ['PROMPT_MARKER', 'PRIVATE_MARKER']) assert.ok(!(raw + state).includes(marker));
  });
  it('failed or interrupted hooks do not issue final receipts', async () => {
    const project = await tempDataRoot('hook-failure'), data = await tempDataRoot('hook-failure-data');
    const session_id = 'hook-failed', runId = `run-claude-hook-${nativeId(session_id)}`;
    for (const hook_event_name of ['SessionStart', 'StopFailure', 'Stop', 'SessionEnd'])
      await captureHook({ session_id, cwd: project, hook_event_name, last_assistant_message: 'Unfinished answer' }, project, data);
    const raw = await readFile(join(data, 'live', runId, 'stream.jsonl'), 'utf8');
    assert.ok(!raw.includes('"recordKind":"answer"')); assert.match(raw, /NATIVE_FAILED/); assert.match(raw, /"lifecycle":"FAILED"/);
  });
});

describe('M5 real minimized fixtures: immutable input → SQLite → analysis → receipt resolver', () => {
  const oracles: Record<string, { events: number; receipts: number; completeness: string; reads: string[] }> = {
    'codex-normal.jsonl': { events: 4, receipts: 1, completeness: 'PARTIAL', reads: ['FAILED', 'SUCCESS'] },
    'codex-compare.jsonl': { events: 4, receipts: 1, completeness: 'PARTIAL', reads: ['FAILED', 'SUCCESS'] },
    'codex-cancel.jsonl': { events: 0, receipts: 0, completeness: 'PARTIAL', reads: [] },
    'claude-normal-user.jsonl': { events: 4, receipts: 1, completeness: 'COMPLETE', reads: ['FAILED', 'SUCCESS'] },
    'claude-compare.jsonl': { events: 3, receipts: 1, completeness: 'COMPLETE', reads: [] },
    'claude-normal.jsonl': { events: 0, receipts: 0, completeness: 'PARTIAL', reads: [] },
  };
  for (const [file, oracle] of Object.entries(oracles)) it(file, async () => {
    const manifest = JSON.parse(await readFile(join(nativeRoot, 'manifest.json'), 'utf8')) as { fixtures: { file: string; sha256: string; adapterId: NativeAdapterId }[] };
    const entry = manifest.fixtures.find(f => f.file === file)!;
    const path = join(nativeRoot, file), before = await readFile(path), root = await tempDataRoot('m5-native');
    assert.equal(createHash('sha256').update(before).digest('hex'), entry.sha256);
    const outcome = await ingestFile(path, { dataRoot: root, adapterId: entry.adapterId, runId: 'run-native-fixture', now: FIXED_NOW });
    assert.equal(outcome.runs[0]?.eventsAccepted, oracle.events);
    assert.equal(outcome.runs[0]?.completeness, oracle.completeness);
    assert.ok(outcome.replayChecks.every(r => r.verified));
    const store = await ViewTraceStore.open({ dataRoot: root });
    try {
      const replay = store.replay('run-native-fixture')!;
      const records = replay.records.map(r => r.record);
      const receipts = records.filter(r => r.recordKind === 'answer');
      assert.equal(receipts.length, oracle.receipts);
      assert.deepEqual(records.flatMap(r => r.recordKind === 'event' && r.payload.type === 'READ' ? [r.payload.outcome] : []), oracle.reads);
      for (const r of records) if (r.recordKind === 'event') assert.ok(['SEARCH', 'READ', 'CLAIM'].includes(r.type));
      for (const receipt of receipts) {
        assert.equal(receipt.turnId, undefined);
        assert.equal(resolveAnswer(store, { agentId: entry.adapterId, agentSessionId: receipt.agentSessionId }).status, 'uncertain');
        assert.equal(resolveAnswer(store, { receiptId: receipt.receiptId }).status, 'matched');
        const report = await answerAnalysisReport(store, receipt.runId, receipt.answerId);
        assert.equal(report?.inputRevision.recordCount, oracle.events);
        assert.notEqual(report?.support.status, 'STRONGLY_SUPPORTED');
      }
    } finally { await store.close(); }
    assert.deepEqual(await readFile(path), before, 'original native history is read-only');
  });
  it('invalidates the small support cache on changed/corrupt/deleted artifacts and changed completeness', async () => {
    const root = await tempDataRoot('m5-summary-cache');
    await ingestFile(join(nativeRoot, 'claude-normal-user.jsonl'), { dataRoot: root, adapterId: 'claude-code', runId: 'run-cache' });
    const store = await ViewTraceStore.open({ dataRoot: root });
    try {
      const receipt = store.recentAnswers(1)[0]!;
      const report = await answerAnalysisReport(store, receipt.runId, receipt.answerId);
      assert.equal(answerReport(store, receipt.runId, receipt.answerId)?.evidenceSupport, report?.support.status);
      const file = join(root, 'artifacts', receipt.runId, 'answers', receipt.answerId, 'analysis-report.json');
      const original = await readFile(file, 'utf8');
      await writeFile(file, '{corrupt');
      assert.equal(answerReport(store, receipt.runId, receipt.answerId)?.evidenceSupport, 'UNKNOWN');
      await writeFile(file, original);
      await store.setCompleteness(receipt.runId, 'PARTIAL');
      assert.equal(answerReport(store, receipt.runId, receipt.answerId)?.evidenceSupport, 'UNKNOWN');
      await store.deleteRun(receipt.runId);
      assert.equal(answerReport(store, receipt.runId, receipt.answerId), null);
    } finally { await store.close(); }
  });
});

describe('M5 native wrapper public-bin privacy and gap persistence', () => {
  it('passes actual argv, discards stderr and malformed/private native bytes before spool/SQLite', async () => {
    const root = await tempDataRoot('m5-wrapper'); await upService(root);
    try {
      const producer = await writeProducer(root, 'native.mjs', `
process.stderr.write('PRIVATE_MARKER SECRET_MARKER');
console.log('malformed PRIVATE_MARKER');
console.log(JSON.stringify({type:'thread.started',thread_id:'thread'}));
console.log(JSON.stringify({type:'turn.started'}));
console.log(JSON.stringify({type:'item.completed',item:{id:'thinking',type:'reasoning',text:'PRIVATE_MARKER'}}));
console.log(JSON.stringify({type:'item.completed',item:{id:'final',type:'agent_message',text:'Public answer'}}));
console.log(JSON.stringify({type:'turn.completed'}));
`);
      const r = await runBin(['run', '--adapter', 'codex', '--data-root', root, '--json', '--', process.execPath, producer, 'PROMPT_MARKER']);
      assert.equal(r.code, 4, r.stderr);
      const packets = r.stdout.trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
      const summary = packets.find(p => p.type === 'summary')!, runId = String(summary.runId);
      assert.equal(summary.completeness, 'PARTIAL');
      const spool = await readFile(join(root, 'live', runId, 'stream.jsonl'), 'utf8');
      const meta = await readFile(join(root, 'live', runId, 'meta.json'), 'utf8');
      const replay = await runBin(['replay', runId, '--data-root', root, '--json']);
      for (const marker of ['PRIVATE_MARKER', 'SECRET_MARKER', 'PROMPT_MARKER']) assert.ok(![r.stdout, r.stderr, spool, meta, replay.stdout].join('\n').includes(marker), marker);
      assert.match(replay.stdout, /NATIVE_MALFORMED/);
      if (process.platform !== 'win32') assert.equal((await stat(join(root, 'live', runId, 'stream.jsonl'))).mode & 0o777, 0o600);
    } finally { await downService(root); }
  });
});
