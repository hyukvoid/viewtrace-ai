/**
 * `viewtrace run` — explicit reference or native public-JSON producer wrapper.
 *
 * Pipeline: spawn producer (no shell) → sanitize stdout lines (declared
 * private-reasoning fields are stripped BEFORE anything touches disk) →
 * tee into the live spool → display activity lines as they are parsed →
 * observe the child's real exit → append an explicit terminal run record →
 * wait for the collector service to confirm the commit → print an honest
 * summary.
 *
 * Framing rule (fixed here): the producer contract is one JSON record per
 * newline-terminated stdout line; human-readable output belongs on stderr.
 * The wrapper completes the framing of a final unterminated line, so a
 * mid-write fragment becomes an honest MALFORMED_JSON loss — never a silent
 * merge into the terminal record.
 *
 * Exit-code contract (documented in --help):
 *   0    child exited 0 AND the collector committed a COMPLETE stream
 *   1    unexpected wrapper failure / unknown run state
 *   2    usage, unsupported adapter, or collector service not running
 *   4    child exited 0 but the collection is PARTIAL/UNKNOWN or unconfirmed
 *   127  producer could not be spawned
 *   130/143  wrapper cancelled by SIGINT/SIGTERM (child gets the signal
 *            forwarded; a CANCELLED record is committed)
 *   otherwise the child's own nonzero exit code is preserved.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, basename } from 'node:path';

import { controlRequest, probeService } from './control.js';
import {
  activityJson,
  formatChatter,
  formatEventLine,
  formatRejected,
  formatRunLine,
  formatWarning,
  runTransitionJson,
  sanitizeForTerminal,
} from './display.js';
import { liveDir, readServiceFile } from './servestate.js';
import { isTerminal } from './collector.js';
import type { LiveRunSnapshot } from './collector.js';
import { validateRecord, stripPrivateReasoningFields } from './validate.js';
import type { AdapterCapability } from './adapters.js';
import type { Diagnostic, DuplicateInfo, RunLifecycle } from './types.js';
import { isNativeAdapter, NativeCapture } from './native.js';
import type { NativeAdapterId } from './native.js';
import { JsonlChunkParser } from './jsonl.js';

const DRAIN_TIMEOUT_MS = Number(process.env['VIEWTRACE_DRAIN_TIMEOUT_MS'] ?? 30_000);
const DRAIN_POLL_MS = 150;
const LINE_HARD_CAP_BYTES = 8 * 1024 * 1024;
const SIGNAL_NUMBERS: Readonly<Record<string, number>> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGQUIT: 3 };

export interface RunCommandOptions {
  readonly dataRoot: string;
  readonly adapter: AdapterCapability;
  readonly json: boolean;
  readonly latencyLogPath?: string;
  readonly nativeAgentVersion?: string;
}

interface LatencyEntry {
  readonly eventId: string;
  readonly eventType: string;
  readonly teedAt: number;
  readonly displayedAt: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function utcStamp(date = new Date()): string {
  return `${date.toISOString().slice(0, 10).replace(/-/g, '')}-${date.toISOString().slice(11, 19).replace(/:/g, '')}`;
}

function generateRunId(): string {
  return `run-${utcStamp()}-${randomBytes(2).toString('hex')}`;
}

/**
 * Windows .cmd/.bat producers need cmd.exe; everything else is spawned
 * directly with an argument array — there is never a shell on the path, so
 * producer arguments cannot be interpolated. For .cmd, each argument is
 * passed as its own argv entry and Node applies its standard Windows
 * quoting; metacharacter interpretation inside the .cmd script itself is
 * the script's own semantics (documented residual risk of cmd formats).
 */
function buildSpawn(
  command: string,
  args: readonly string[],
): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    if ([command, ...args].some(s => /[%!\r\n]/.test(s))) throw new Error('CMD_ARG_UNSUPPORTED');
    const protect = (value: string) => value.replace(/[()\[\]^"<>&| ]/g, c => `^${c}`);
    const npmShim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(command);
    const quoted = args.map(value => {
      const literal = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
      const escaped = protect(literal); return npmShim ? protect(escaped) : escaped;
    });
    return { file: process.env['ComSpec'] ?? 'cmd.exe', args: ['/d', '/s', '/v:off', '/c', `"${protect(command)} ${quoted.join(' ')}"`], windowsVerbatimArguments: true };
  }
  return { file: command, args: [...args] };
}

function terminalRecord(
  runId: string,
  adapter: AdapterCapability,
  lifecycle: RunLifecycle,
  detail: string,
): Record<string, unknown> {
  return {
    recordKind: 'run',
    schemaVersion: 1,
    runId,
    lifecycle,
    occurredAt: new Date().toISOString(),
    adapterId: adapter.adapterId,
    adapterVersion: adapter.version,
    detail,
  };
}

async function nativeAgentVersion(command: string, adapterId: NativeAdapterId): Promise<string | undefined> {
  const spec = buildSpawn(command, ['--version']);
  return new Promise(resolveVersion => {
    const probe = spawn(spec.file, spec.args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments });
    let output = '';
    const timer = setTimeout(() => { probe.kill(); resolveVersion(undefined); }, 5000);
    probe.stdout.on('data', (b: Buffer) => { if (output.length < 256) output += b.toString('utf8').slice(0, 256); });
    probe.on('error', () => { clearTimeout(timer); resolveVersion(undefined); });
    probe.on('close', code => {
      clearTimeout(timer);
      const match = adapterId === 'codex' ? /^codex-cli (\d+\.\d+\.\d+)/.exec(output.trim()) : /^(\d+\.\d+\.\d+) \(Claude Code\)/.exec(output.trim());
      resolveVersion(code === 0 ? match?.[1] : undefined);
    });
  });
}

export async function runCommand(
  producerArgv: readonly string[],
  options: RunCommandOptions,
): Promise<number> {
  const emit = (line: string): void => {
    process.stdout.write(line + '\n');
  };
  const emitJson = (value: unknown): void => {
    process.stdout.write(JSON.stringify(value) + '\n');
  };

  const serviceInfo = await readServiceFile(options.dataRoot);
  if (serviceInfo === null) {
    process.stderr.write(
      'viewtrace: the collector service is not running on this data root; start it with `viewtrace up` first\n',
    );
    return 2;
  }
  const probe = await probeService(serviceInfo);
  if (probe.state !== 'running') {
    process.stderr.write(
      `viewtrace: the collector service is not running (stale state: ${probe.reason}); start it with \`viewtrace up\`\n`,
    );
    return 2;
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(producerArgv[0] ?? '') && producerArgv.some(s => /[%!\r\n]/.test(s))) {
    process.stderr.write('viewtrace: Windows .cmd/.bat argv containing %, ! or newlines is unsupported; invoke its JavaScript entrypoint with node to preserve literal argv\n');
    return 2;
  }

  const liveRoot = liveDir(options.dataRoot);
  let runId = generateRunId();
  for (let attempt = 0; attempt < 5 && existsSync(join(liveRoot, runId)); attempt++) {
    runId = generateRunId();
  }
  const runDirPath = join(liveRoot, runId);
  const native = isNativeAdapter(options.adapter.adapterId);
  if (isNativeAdapter(options.adapter.adapterId)) options = { ...options,
    nativeAgentVersion: await nativeAgentVersion(producerArgv[0] ?? '', options.adapter.adapterId) };
  // Native argv often contains the user's prompt. Pass it to the child, never persist/echo it.
  const publicProducer = native ? [basename(producerArgv[0] ?? ''), '[arguments omitted]'] : producerArgv;
  const spoolPath = join(runDirPath, 'stream.jsonl');
  await mkdir(runDirPath, { recursive: true, mode: 0o700 });
  await writeFile(
    join(runDirPath, 'meta.json'),
    JSON.stringify(
      {
        runId,
        adapterId: options.adapter.adapterId,
        adapterVersion: options.adapter.version,
        producerCommand: publicProducer,
        nativeAgentVersion: options.nativeAgentVersion,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  const spool = await open(spoolPath, 'a', 0o600);

  if (options.json) {
    emitJson({
      type: 'run-started',
      runId,
      adapter: `${options.adapter.adapterId}@${options.adapter.version}`,
      producer: publicProducer,
      dataRoot: options.dataRoot,
      servicePid: probe.health.pid,
    });
  } else {
    emit(`run ${runId} started`);
    emit(`  adapter:    ${options.adapter.adapterId}@${options.adapter.version}`);
    emit(`  producer:   ${publicProducer.join(' ')}`);
    emit(`  data root:  ${options.dataRoot}`);
    emit(`  collector:  pid ${probe.health.pid} (127.0.0.1:${probe.info.port})`);
    emit(`  spool:      ${spoolPath}`);
  }

  const latencies: LatencyEntry[] = [];
  let cancelling = false;
  let cancelSignal: string | null = null;

  const command = producerArgv[0] ?? '';
  const rest = producerArgv.slice(1);
  const spawnSpec = buildSpawn(command, rest);
  let child: ChildProcess;
  try {
    child = spawn(spawnSpec.file, spawnSpec.args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
      // Own a POSIX process group so cancellation includes descendants.
      // Windows keeps the real console and uses taskkill's process-tree boundary.
      detached: process.platform !== 'win32',
      // The producer learns its identity through the environment — the
      // wrapper never rewrites record contents.
      env: {
        ...process.env,
        VIEWTRACE_RUN_ID: runId,
        VIEWTRACE_DATA_ROOT: options.dataRoot,
      },
    });
  } catch (e) {
    await finishFailed(options, spool, runId, `spawn failed: ${e instanceof Error ? e.message : String(e)}`);
    process.stderr.write('viewtrace: producer could not be spawned\n');
    return 127;
  }

  let treeCleanup: Promise<void> | undefined;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const signalGroup = (signal: NodeJS.Signals): void => {
    try { if (child.pid) process.kill(-child.pid, signal); } catch { /* group already gone */ }
  };
  const onSignal = (signal: string): void => {
    if (cancelling) return;
    cancelling = true;
    cancelSignal = signal;
    if (process.platform === 'win32') {
      treeCleanup = new Promise(resolveCleanup => {
        if (!child.pid) { resolveCleanup(); return; }
        const killer = spawn(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        killer.on('error', () => { child.kill(); resolveCleanup(); });
        killer.on('close', () => { child.kill(); resolveCleanup(); });
      });
    } else {
      signalGroup(signal as NodeJS.Signals);
      forceKillTimer = setTimeout(() => signalGroup('SIGKILL'), 5000);
      forceKillTimer.unref();
    }
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  let spawnError: string | null = null;
  child.on('error', (e) => {
    spawnError = e.message;
  });

  const stdoutDone = pumpStdout(child, spool, runId, options, emit, emitJson, latencies);
  const stderrDone = pumpStderr(child, native);

  const exitInfo = await new Promise<{ code: number | null; signal: string | null }>((resolveExit) => {
    let settled = false;
    const settle = (value: { code: number | null; signal: string | null }): void => {
      if (!settled) {
        settled = true;
        resolveExit(value);
      }
    };
    child.on('exit', (code, signal) => settle({ code, signal }));
    // A spawn that never starts (ENOENT/EACCES) may never emit 'exit'.
    child.on('error', () => settle({ code: null, signal: null }));
  });
  // Once the producer exits, stop remaining descendants before waiting for
  // their inherited pipe handles. Otherwise a grandchild can hold capture open.
  if (cancelling && process.platform !== 'win32') signalGroup('SIGKILL');
  await treeCleanup;
  const [nativeFailed] = await Promise.all([stdoutDone, stderrDone]);
  if (forceKillTimer) clearTimeout(forceKillTimer);

  let lifecycle: RunLifecycle;
  let detail: string;
  let exitCode: number;
  if (spawnError !== null) {
    lifecycle = 'FAILED';
    detail = `producer spawn failed: ${spawnError}`;
    exitCode = 127;
  } else if (cancelling) {
    lifecycle = 'CANCELLED';
    detail = `wrapper received ${cancelSignal}; producer was signalled`;
    exitCode = 128 + (SIGNAL_NUMBERS[cancelSignal ?? ''] ?? 0);
  } else if (exitInfo.signal !== null) {
    lifecycle = 'FAILED';
    detail = `producer terminated by signal ${exitInfo.signal}`;
    const num = SIGNAL_NUMBERS[exitInfo.signal] ?? 0;
    exitCode = process.platform === 'win32' ? 1 : num > 0 ? 128 + num : 1;
  } else if (nativeFailed) {
    lifecycle = 'FAILED';
    detail = 'native agent reported failure';
    exitCode = exitInfo.code || 4;
  } else if (exitInfo.code === 0) {
    lifecycle = 'COMPLETED';
    detail = 'producer exited 0';
    exitCode = 0; // refined after drain below
  } else {
    lifecycle = 'FAILED';
    detail = `producer exited ${exitInfo.code ?? 'unknown'}`;
    exitCode = exitInfo.code ?? 1;
  }

  await spool.write(Buffer.from(JSON.stringify(terminalRecord(runId, options.adapter, lifecycle, detail)) + '\n'));
  await spool.sync();
  await spool.close();

  const drain = await waitForDrain(options.dataRoot, runId);
  if (exitCode === 0 && !(drain !== null && drain.run.completeness === 'COMPLETE')) {
    exitCode = 4; // child succeeded but the collection is partial or unconfirmed
  }
  printSummary(options, drain, runId, spoolPath, lifecycle, detail, exitInfo, emit, emitJson);
  await writeLatencyLog(options, latencies, runId, drain);
  return exitCode;
}

async function finishFailed(
  options: RunCommandOptions,
  spool: FileHandle,
  runId: string,
  detail: string,
): Promise<void> {
  await spool.write(Buffer.from(JSON.stringify(terminalRecord(runId, options.adapter, 'FAILED', detail)) + '\n'));
  await spool.sync();
  await spool.close();
}

/* ------------------------------------------------------------------ */
/* stdout: sanitize → spool → display                                  */
/* ------------------------------------------------------------------ */

type EmitFn = (line: string) => void;
type EmitJsonFn = (value: unknown) => void;

async function pumpStdout(
  child: ChildProcess,
  spool: FileHandle,
  runId: string,
  options: RunCommandOptions,
  emit: EmitFn,
  emitJson: EmitJsonFn,
  latencies: LatencyEntry[],
): Promise<boolean> {
  const stdout = child.stdout;
  if (stdout === null) return false;
  if (isNativeAdapter(options.adapter.adapterId)) {
    return pumpNativeStdout(child, spool, runId, options.adapter.adapterId, options, emit, emitJson, latencies);
  }
  let carry: Buffer = Buffer.alloc(0);
  let oversizedReported = false;

  const processLine = async (line: Buffer): Promise<void> => {
    const text = line.toString('utf8');
    let parsed: unknown;
    let isObject = false;
    try {
      parsed = JSON.parse(text);
      isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    } catch {
      parsed = undefined;
    }
    // Spool write: declared private-reasoning fields never reach disk.
    const toSpool = isObject
      ? Buffer.from(JSON.stringify(stripPrivateReasoningFields(parsed).value))
      : line;
    await spool.write(toSpool);
    await spool.write(Buffer.from('\n'));
    const teedAt = Date.now();

    if (parsed === undefined) {
      if (options.json) {
        emitJson({ type: 'activity', kind: 'chatter', at: new Date().toISOString(), text: text.slice(0, 120) });
      } else {
        emit(formatChatter(text));
      }
      return;
    }
    const outcome = validateRecord(parsed);
    if (!outcome.ok) {
      const first = outcome.errors[0];
      if (options.json) {
        emitJson({ type: 'activity', kind: 'rejected', at: new Date().toISOString(), code: first?.code ?? 'INVALID' });
      } else {
        emit(formatRejected(first?.code ?? 'INVALID'));
      }
      return;
    }
    const record = outcome.record;
    if (record.runId !== runId) {
      if (options.json) {
        emitJson({ type: 'activity', kind: 'rejected', at: new Date().toISOString(), code: 'RUN_ID_MISMATCH' });
      } else {
        emit(formatRejected('RUN_ID_MISMATCH'));
      }
      return;
    }
    for (const warning of outcome.warnings) {
      if (options.json) {
        emitJson({ type: 'activity', kind: 'warning', at: new Date().toISOString(), code: warning.code });
      } else {
        emit(formatWarning(warning));
      }
    }
    if (record.recordKind === 'run') {
      if (options.json) emitJson(runTransitionJson(record.lifecycle, record.detail));
      else emit(formatRunLine(record.lifecycle, record.detail));
      return;
    }
    if (record.recordKind === 'answer') {
      if (options.json) emitJson({ type: 'answer', receiptId: record.receiptId, answerId: record.answerId, runId: record.runId, associationCapability: record.agentSessionId && record.turnId ? 'YES' : 'PARTIAL' });
      else emit(`ANSWER ${record.answerId} — receipt ${record.receiptId}`);
      return;
    }
    if (options.json) emitJson(activityJson(record));
    else emit(formatEventLine(record));
    latencies.push({
      eventId: record.eventId,
      eventType: record.type,
      teedAt,
      displayedAt: Date.now(),
    });
  };

  for await (const chunkOrString of stdout) {
    const chunk = Buffer.isBuffer(chunkOrString) ? chunkOrString : Buffer.from(String(chunkOrString));
    let buffer = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] === 0x0a) {
        await processLine(buffer.subarray(start, i));
        start = i + 1;
      }
    }
    carry = buffer.subarray(start);
    buffer = Buffer.alloc(0);
    if (carry.length > LINE_HARD_CAP_BYTES) {
      // Colossal unterminated line: flush raw bytes (bounded memory) — the
      // collector's line cap will discard it as an honest OVERSIZED_LINE.
      await spool.write(carry);
      carry = Buffer.alloc(0);
      if (!oversizedReported) {
        oversizedReported = true;
        if (options.json) emitJson({ type: 'activity', kind: 'oversized', at: new Date().toISOString() });
        else emit('  · oversized stdout line flushed raw; it will be discarded by the collector');
      }
    }
  }
  if (carry.length > 0) {
    // Framing completion: the producer's final line lacked its newline.
    await processLine(carry);
  }
  return false;
}

async function pumpNativeStdout(
  child: ChildProcess, spool: FileHandle, runId: string, adapterId: NativeAdapterId,
  options: RunCommandOptions, emit: EmitFn, emitJson: EmitJsonFn, latencies: LatencyEntry[],
): Promise<boolean> {
  const parser = new JsonlChunkParser();
  const capture = new NativeCapture({ adapterId, runId, agentVersion: options.nativeAgentVersion });
  const write = async (records: unknown[]) => {
    for (const value of records) {
      await spool.write(JSON.stringify(value) + '\n');
      const outcome = validateRecord(value);
      if (!outcome.ok) {
        const code = (value as { code?: string }).code ?? 'NATIVE_MALFORMED';
        if (options.json) emitJson({ type: 'activity', kind: 'warning', code });
        else emit(`  · ${code}: collection is partial`);
        continue;
      }
      const r = outcome.record;
      if (r.recordKind === 'event') {
        if (options.json) emitJson(activityJson(r)); else emit(formatEventLine(r));
        latencies.push({ eventId: r.eventId, eventType: r.type, teedAt: Date.now(), displayedAt: Date.now() });
      } else if (r.recordKind === 'answer') {
        if (options.json) emitJson({ type: 'answer', receiptId: r.receiptId, answerId: r.answerId, runId, associationCapability: 'PARTIAL' });
        else emit(`ANSWER ${r.answerId} — receipt ${r.receiptId}; provider turn identity unavailable`);
      } else {
        if (options.json) emitJson(runTransitionJson(r.lifecycle, r.detail)); else emit(formatRunLine(r.lifecycle, r.detail));
      }
    }
  };
  const flush = async () => {
    const parsed = parser.take();
    for (const _loss of parsed.losses) await write(capture.gap('NATIVE_MALFORMED'));
    for (const line of parsed.lines) await write(capture.consume(line.value));
  };
  for await (const chunk of child.stdout!) { parser.push(chunk); await flush(); }
  parser.finish(); await flush(); await write(capture.finish());
  return capture.unsuccessful;
}

async function pumpStderr(child: ChildProcess, native = false): Promise<void> {
  const stderr = child.stderr;
  if (stderr === null) return;
  if (native) {
    // stderr has no public/secret field contract. Count and discard it rather than echo prompts/debug dumps.
    let bytes = 0;
    for await (const chunk of stderr) bytes += Buffer.byteLength(chunk);
    if (bytes > 0) process.stderr.write(`[agent] ${bytes} stderr bytes omitted by native privacy boundary\n`);
    return;
  }
  let carry: Buffer = Buffer.alloc(0);
  const write = (text: string): void => {
    // Sanitized passthrough: the agent's own diagnostics, escape-free.
    process.stderr.write(`[agent] ${sanitizeForTerminal(text, 1000)}\n`);
  };
  for await (const chunkOrString of stderr) {
    const chunk = Buffer.isBuffer(chunkOrString) ? chunkOrString : Buffer.from(String(chunkOrString));
    let buffer = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] === 0x0a) {
        write(buffer.subarray(start, i).toString('utf8'));
        start = i + 1;
      }
    }
    carry = buffer.subarray(start);
    buffer = Buffer.alloc(0);
    if (carry.length > LINE_HARD_CAP_BYTES) {
      write(carry.toString('utf8'));
      carry = Buffer.alloc(0);
    }
  }
  if (carry.length > 0) write(carry.toString('utf8'));
}

/* ------------------------------------------------------------------ */
/* Drain confirmation and summary                                      */
/* ------------------------------------------------------------------ */

export interface DrainResult {
  readonly run: LiveRunSnapshot;
  readonly diagnostics: readonly Diagnostic[];
  readonly duplicates: readonly DuplicateInfo[];
}

async function waitForDrain(dataRoot: string, runId: string): Promise<DrainResult | null> {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const info = await readServiceFile(dataRoot);
    if (info !== null) {
      try {
        const res = await controlRequest({
          port: info.port,
          token: info.token,
          method: 'GET',
          path: `/runs/${runId}`,
          timeoutMs: 3000,
        });
        if (res.status === 200) {
          const body = res.json as { run?: LiveRunSnapshot; diagnostics?: Diagnostic[]; duplicates?: DuplicateInfo[] };
          const run = body.run;
          if (
            run !== undefined &&
            run.finalized &&
            isTerminal(run.lifecycle) &&
            run.pendingBytes === 0 &&
            run.completeness !== 'UNKNOWN'
          ) {
            return { run, diagnostics: body.diagnostics ?? [], duplicates: body.duplicates ?? [] };
          }
        }
      } catch {
        /* service gone mid-drain — keep polling until the deadline */
      }
    }
    await sleep(DRAIN_POLL_MS);
  }
  return null;
}

function printSummary(
  options: RunCommandOptions,
  drain: DrainResult | null,
  runId: string,
  spoolPath: string,
  lifecycle: RunLifecycle,
  detail: string,
  exitInfo: { code: number | null; signal: string | null },
  emit: EmitFn,
  emitJson: EmitJsonFn,
): void {
  const child = {
    exitCode: exitInfo.code,
    signal: exitInfo.signal,
  };
  if (drain === null) {
    const summary = {
      type: 'summary',
      runId,
      child,
      lifecycle,
      completeness: 'UNKNOWN',
      drained: false,
      spoolPath,
      dataRoot: options.dataRoot,
      note: 'collector did not confirm the commit; events remain spooled and will be ingested by the next `viewtrace up`',
    };
    if (options.json) emitJson(summary);
    else {
      emit(`run ${runId}: ${lifecycle} — collector did NOT confirm the commit`);
      emit(`  producer: ${detail}`);
      emit(`  events remain spooled at ${spoolPath}`);
      emit(`  start \`viewtrace up\` to drain the spool into the store`);
    }
    process.stderr.write('viewtrace: WARNING: collection unconfirmed (spool retained, nothing lost)\n');
    return;
  }
  const run = drain.run;
  const losses = drain.diagnostics.filter((d) => d.code.startsWith('LOSS_')).length;
  const rejected = drain.diagnostics.filter((d) => d.severity === 'error' && !d.code.startsWith('LOSS_')).length;
  const warnings = drain.diagnostics.filter((d) => d.severity !== 'error').length;
  const dupIdempotent = drain.duplicates.filter((d) => d.kind === 'IDEMPOTENT').length;
  const dupConflicting = drain.duplicates.filter((d) => d.kind === 'CONFLICTING').length;
  if (options.json) {
    emitJson({
      type: 'summary',
      runId,
      child,
      lifecycle: run.lifecycle,
      completeness: run.completeness,
      drained: true,
      eventsAccepted: run.eventCount,
      eventsRejected: rejected,
      losses,
      warnings,
      duplicatesIdempotent: dupIdempotent,
      duplicatesConflicting: dupConflicting,
      collectorError: run.lastError,
      spoolPath,
      dataRoot: options.dataRoot,
    });
    return;
  }
  emit(`run ${runId}: ${run.lifecycle} / ${run.completeness} — ${detail}`);
  emit(`  events: ${run.eventCount} accepted, ${rejected} rejected · losses: ${losses} · warnings: ${warnings}`);
  emit(`  duplicates: ${dupIdempotent} idempotent, ${dupConflicting} conflicting`);
  if (run.lastError !== null) emit(`  collector error: ${run.lastError}`);
  emit(`  stored: ${options.dataRoot} (runs/${runId}/trace.jsonl)`);
}

async function writeLatencyLog(
  options: RunCommandOptions,
  latencies: readonly LatencyEntry[],
  runId: string,
  drain: DrainResult | null,
): Promise<void> {
  if (options.latencyLogPath === undefined) return;
  const lines = [
    JSON.stringify({ type: 'latency-log', runId, platform: process.platform, node: process.version }),
    ...latencies.map((e) => JSON.stringify(e)),
    JSON.stringify({
      type: 'latency-summary',
      count: latencies.length,
      drained: drain !== null,
      completeness: drain?.run.completeness ?? 'UNKNOWN',
    }),
  ];
  await writeFile(options.latencyLogPath, lines.join('\n') + '\n', { mode: 0o600 });
}
