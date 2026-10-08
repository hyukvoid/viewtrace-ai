/** Project-owned Claude settings opt-in. No global configuration or original history is edited. */
import { mkdir, readFile, writeFile, rm, open, rmdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { assertLocalPath } from './paths.js';
import { liveDir } from './servestate.js';
import { NativeCapture, nativeId, nativeGap, object, NATIVE_VERSION } from './native.js';
import { normalizedAnswer, answerHash, ANSWER_HASH_VERSION } from './answer.js';

const SETTINGS = 'claude.settings.json';
const LAUNCHER = 'claude-hook.cjs';
const MANIFEST = 'install.json';
const EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SessionEnd'];
interface Install { version: 1; project: string; dataRoot: string; files: Record<string, string>; }

export async function installHooks(projectPath: string, dataRootPath: string, windowsAgentOnWsl = false): Promise<string> {
  const project = resolve(projectPath), dataRoot = resolve(dataRootPath), dir = join(project, '.viewtrace');
  const distro = process.env['WSL_DISTRO_NAME'];
  if (windowsAgentOnWsl && (process.platform !== 'linux' || !distro || !/^[A-Za-z0-9._-]+$/.test(distro) || /[%!"\r\n]/.test(project + process.execPath)))
    throw new Error('UNSUPPORTED_WSL_HOOK_CONTEXT');
  await assertLocalPath(project, dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const launcher = `// ViewTrace owned project hook. No agent settings/history are modified.\n` +
    `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{input+=c;if(input.length>4194304)process.exit(1)});\n` +
    `process.stdin.on('end',async()=>{try{const m=await import(${JSON.stringify(new URL('./hooks.js', import.meta.url).href)});await m.captureHook(JSON.parse(input),${JSON.stringify(project)},${JSON.stringify(dataRoot)},${JSON.stringify(windowsAgentOnWsl ? distro : undefined)});}catch{process.stderr.write('viewtrace hook: capture failed; collection may be incomplete\\n');process.exitCode=1;}});\n`;
  // Pin the installing runtime. A Windows npm launcher on WSL can otherwise
  // resolve `node` to node.exe and misinterpret Linux file URLs/data paths.
  const runtime = process.platform === 'win32' ? `"${process.execPath}"` : `'${process.execPath.replace(/'/g, "'\\''")}'`;
  const command = windowsAgentOnWsl
    ? `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl.exe --distribution "${distro}" --cd "${project}" --exec "${process.execPath}" "${join(dir, LAUNCHER)}"`
    : `${runtime} .viewtrace/claude-hook.cjs`;
  const settings = JSON.stringify({ hooks: Object.fromEntries(EVENTS.map(event => [event, [{
    hooks: [{ type: 'command', command, timeout: 10 }],
  }]])) }, null, 2) + '\n';
  const files = { [SETTINGS]: settings, [LAUNCHER]: launcher };
  const installed: string[] = [];
  try {
    for (const [name, content] of Object.entries(files)) {
      await assertLocalPath(project, join(dir, name));
      await writeFile(join(dir, name), content, { flag: 'wx', mode: 0o600 }); installed.push(name);
    }
    const manifest: Install = { version: 1, project, dataRoot, files: Object.fromEntries(Object.entries(files).map(([n, c]) => [n, nativeId(c)])) };
    await writeFile(join(dir, MANIFEST), JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o600 });
    return join(dir, SETTINGS);
  } catch (error) {
    for (const name of installed) await rm(join(dir, name));
    throw error;
  }
}
export async function uninstallHooks(projectPath: string): Promise<void> {
  const project = resolve(projectPath), dir = join(project, '.viewtrace');
  await assertLocalPath(project, join(dir, MANIFEST));
  const manifest = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')) as Install;
  if (manifest.version !== 1 || manifest.project !== project) throw new Error('INVALID_HOOK_INSTALL');
  for (const name of [SETTINGS, LAUNCHER]) {
    await assertLocalPath(project, join(dir, name));
    const contents = await readFile(join(dir, name), 'utf8');
    if (nativeId(contents) !== manifest.files[name]) throw new Error('HOOK_FILE_CHANGED: preserve user edits; restore the owned file before removal');
  }
  for (const name of [SETTINGS, LAUNCHER, MANIFEST]) await rm(join(dir, name));
  await rmdir(dir).catch(() => {}); // unrelated project files stay intact
}

interface HookState {
  turn: number; events: string[]; calls: Record<string, { name: string; query?: string; url?: string; file_path?: string }>;
  seen: string[]; stopped: boolean; failed?: boolean;
}
export async function captureHook(input: unknown, projectPath: string, dataRootPath: string, wslDistro?: string): Promise<void> {
  const p = object(input), project = resolve(projectPath), dataRoot = resolve(dataRootPath);
  let cwd = typeof p.cwd === 'string' ? p.cwd : '';
  if (wslDistro) {
    const unc = /^\/\/wsl\.(?:localhost|\$)\/([^/]+)(\/.*)$/i.exec(cwd.replace(/\\/g, '/'));
    if (unc && unc[1]?.toLowerCase() === wslDistro.toLowerCase()) cwd = unc[2]!;
  }
  const sameProject = process.platform === 'win32' ? resolve(cwd).toLowerCase() === project.toLowerCase() : resolve(cwd) === project;
  if (typeof p.session_id !== 'string' || !p.session_id || !cwd || !sameProject ||
      typeof p.hook_event_name !== 'string' || !EVENTS.includes(p.hook_event_name)) throw new Error('INVALID_HOOK_INPUT');
  const runId = `run-claude-hook-${nativeId(p.session_id)}`, dir = join(liveDir(dataRoot), runId);
  await assertLocalPath(dataRoot, dir); await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'hook.lock');
  await assertLocalPath(dataRoot, lock);
  let locked = false;
  for (let i = 0; i < 200; i++) {
    try { await mkdir(lock, { mode: 0o700 }); locked = true; break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    await new Promise(r => setTimeout(r, 10));
  }
  if (!locked) throw new Error('HOOK_BUSY');
  try {
    for (const name of ['meta.json', 'hook-state.json', 'stream.jsonl']) await assertLocalPath(dataRoot, join(dir, name));
    const statePath = join(dir, 'hook-state.json');
    let state: HookState;
    try { state = JSON.parse(await readFile(statePath, 'utf8')) as HookState; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      state = { turn: 1, events: [], calls: {}, seen: [], stopped: false };
    }
    const now = new Date().toISOString();
    const base = { schemaVersion: 1, runId, occurredAt: now, adapterId: 'claude-code', adapterVersion: NATIVE_VERSION };
    const records: unknown[] = [];
    if (p.hook_event_name === 'SessionStart') {
      await writeFile(join(dir, 'meta.json'), JSON.stringify({ runId, adapterId: 'claude-code', adapterVersion: NATIVE_VERSION, producerCommand: ['claude', '[project hook]'] }) + '\n', { mode: 0o600 });
      records.push({ ...base, recordKind: 'run', lifecycle: 'RUNNING' });
    } else {
      // An absent SessionStart is an honest capture gap, never an implicitly complete session.
      try { await readFile(join(dir, 'meta.json')); }
      catch {
        await writeFile(join(dir, 'meta.json'), JSON.stringify({ runId, adapterId: 'claude-code', adapterVersion: NATIVE_VERSION }) + '\n', { mode: 0o600 });
        records.push({ ...base, recordKind: 'run', lifecycle: 'RUNNING' }, nativeGap(runId, 'claude-code', 'NATIVE_BOUNDARY'));
      }
    }
    if (p.agent_id !== undefined) records.push(nativeGap(runId, 'claude-code', 'NATIVE_NESTED'));
    else if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(p.hook_event_name)) {
      if (state.stopped || state.failed) {
        state.turn++; state.events = []; state.calls = {}; state.seen = [];
        state.stopped = false; state.failed = false;
      }
      const callId = typeof p.tool_use_id === 'string' ? normalizedAnswer(p.tool_use_id) : undefined;
      const tool = object(p.tool_input), name = String(p.tool_name);
      if (!callId) records.push(nativeGap(runId, 'claude-code', 'NATIVE_DRIFT'));
      else if (!['WebSearch', 'WebFetch', 'Read'].includes(name)) records.push(nativeGap(runId, 'claude-code', 'NATIVE_UNKNOWN_TOOL'));
      else if (p.hook_event_name === 'PreToolUse') {
        Object.defineProperty(state.calls, callId, { enumerable: true, configurable: true, writable: true, value: { name,
          query: typeof tool.query === 'string' ? normalizedAnswer(tool.query) : undefined,
          url: typeof tool.url === 'string' ? normalizedAnswer(tool.url) : undefined,
          file_path: typeof tool.file_path === 'string' ? normalizedAnswer(tool.file_path) : undefined } });
      } else if (!state.seen.includes(callId)) {
        const capture = new NativeCapture({ adapterId: 'claude-code', runId, now: () => now });
        const call = Object.hasOwn(state.calls, callId) ? state.calls[callId] : undefined;
        // A PostToolUse result supplies its actual input even if PreToolUse was lost.
        const inputFields = call ?? { query: tool.query, url: tool.url, file_path: tool.file_path };
        records.push(...capture.consume({ type: 'assistant', message: { content: [{ type: 'tool_use', id: callId, name, input: inputFields }] } }));
        const response = object(p.tool_response);
        const content = typeof p.tool_response === 'string' || Array.isArray(p.tool_response) ? p.tool_response :
          name === 'WebFetch' ? response.result : name === 'Read' ? object(response.file).content : undefined;
        // Structured WebSearch Output has verified search result groups, not arbitrary prose URLs.
        let result = content;
        if (name === 'WebSearch' && Array.isArray(response.results)) {
          const links = response.results.flatMap(group => Array.isArray(object(group).content) ? object(group).content as unknown[] : []);
          result = 'Links: ' + JSON.stringify(links.flatMap(v => {
            const r = object(v); return typeof r.url === 'string' ? [{ title: r.title, url: r.url }] : [];
          }));
        }
        if (result === undefined && p.hook_event_name !== 'PostToolUseFailure') records.push(nativeGap(runId, 'claude-code', 'NATIVE_DRIFT'));
        else {
          records.push(...capture.consume({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: callId,
            content: result ?? 'Native tool failure', is_error: p.hook_event_name === 'PostToolUseFailure' }] } }).map(record => {
              const r = object(record);
              return r.recordKind === 'event' ? { ...r, eventId: `native-${nativeId(runId, String(state.turn), callId)}` } : record;
            }));
          state.seen.push(callId); delete state.calls[callId];
        }
      }
    } else if (p.hook_event_name === 'Stop') {
      for (const callId of Object.keys(state.calls)) records.push(nativeGap(runId, 'claude-code', 'NATIVE_MISSING_RESULT'));
      state.calls = {};
      if (p.stop_hook_active === true || state.failed || typeof p.last_assistant_message !== 'string' || !p.last_assistant_message) records.push(nativeGap(runId, 'claude-code', 'NATIVE_BOUNDARY'));
      else {
        if (state.stopped) { state.turn++; state.events = []; }
        const answer = normalizedAnswer(p.last_assistant_message), id = nativeId(runId, String(state.turn));
        const eventId = `claim-${id}`;
        records.push({ ...base, recordKind: 'event', eventId, type: 'CLAIM', origin: { producer: 'claude-project-hook' },
          source: { sourceId: `answer-${id}`, kind: 'UNKNOWN' }, provenance: { category: 'AGENT_REPORTED' }, payload: { type: 'CLAIM', text: answer } });
        records.push({ ...base, recordKind: 'answer', receiptVersion: 1, receiptId: `receipt-${id}`, agentId: 'claude-code',
          agentSessionId: normalizedAnswer(p.session_id), answerId: `answer-${id}`, answer, answerHash: answerHash(answer), hashVersion: ANSWER_HASH_VERSION,
          final: true, timestamp: now, eventIds: [...state.events, eventId] });
        state.stopped = true;
      }
    } else if (p.hook_event_name === 'StopFailure') {
      state.failed = true; state.stopped = false;
      records.push(nativeGap(runId, 'claude-code', 'NATIVE_FAILED'));
    } else if (p.hook_event_name === 'SessionEnd') {
      if (!state.stopped || Object.keys(state.calls).length) records.push(nativeGap(runId, 'claude-code', 'NATIVE_BOUNDARY'));
      // SessionEnd proves exit, not answer correctness. A cancelled turn never gains a receipt here.
      records.push({ ...base, recordKind: 'run', lifecycle: state.failed ? 'FAILED' : state.stopped ? 'COMPLETED' : 'CANCELLED', detail: 'native SessionEnd hook' });
    }
    for (const record of records) {
      const r = object(record);
      if (r.recordKind === 'event' && r.type !== 'CLAIM') state.events.push(String(r.eventId));
    }
    const spool = await open(join(dir, 'stream.jsonl'), 'a', 0o600);
    try { if (records.length) await spool.write(records.map(r => JSON.stringify(r)).join('\n') + '\n'); await spool.sync(); }
    finally { await spool.close(); }
    await writeFile(statePath, JSON.stringify(state) + '\n', { mode: 0o600 });
  } finally { await rm(lock, { recursive: true }); }
}
