#!/usr/bin/env node
/**
 * ViewTrace CLI: collector lifecycle, explicit reference capture and local
 * answer reveal. Association is resolved from supplied identity, never cwd,
 * latest, timestamps or a standalone answer hash.
 */

import { reveal, reportMutation, reportConnection } from './reveal.js';
import { parseAnswerContext } from './resolver.js';
import { isValidRunId, isValidTimestamp } from './validate.js';
import { answerAnalysisReport } from './report.js';
import { ANALYSIS_MODES, type AnalysisMode, type AnalysisReportV1 } from './analysis-types.js';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { controlRequest, probeService } from './control.js';
import { getAdapter, REFERENCE_ADAPTER_ID } from './adapters.js';
import { ingestFile } from './ingest.js';
import { runCommand } from './run.js';
import {
  liveDir,
  logsDir,
  pidAlive,
  readServiceFile,
  removeServiceFile,
  serviceLockFile,
  writeServiceFile,
} from './servestate.js';
import { ViewTraceStore } from './store.js';
import { listAdapters } from './adapters.js';

const PROGRAM = 'viewtrace';
const PRODUCT = 'ViewTrace AI';
const TAGLINE = 'Trace the evidence behind AI answers.';

const HELP = `${PRODUCT} — ${TAGLINE}

v0.1 traces the research evidence behind AI answers: what was searched,
read, claimed, compared, contradicted, verified and recommended — with the
provenance of every record kept honest (agent-reported / observed / inferred).

Privacy and storage:
  - Local-only. All data lives under the data root (default: ~/.viewtrace):
      viewtrace.db            authoritative SQLite store
      runs/<runId>/trace.jsonl  derived replay export
      live/<runId>/stream.jsonl spool of sanitized producer stdout
      service.json|service.lock collector state (loopback port + token)
      logs/service.log        collector log (never contains the token)
  - The runtime makes ZERO external network requests — no cloud, no
    accounts, no telemetry, no API keys. The control channel binds
    127.0.0.1 only and requires a per-process token.
  - Original agent history files are read-only inputs and are never
    modified. Private reasoning (thinking/analysis payloads) is stripped
    before anything is written to disk. Delete the data root to erase
    everything ViewTrace recorded.

Collector lifecycle:
  viewtrace up [--data-root <dir>] [--report-port <port>] [--json]
      Start (or confirm) the background collector service and wait for
      readiness. Idempotent — safe to run repeatedly.
  viewtrace status [--data-root <dir>] [--json]
      Distinguish a ready collector from stale state (dead pid, dead port,
      identity mismatch). Exit 0 only when actually running.
  viewtrace down [--data-root <dir>]
      Ask the authenticated collector to shut down and wait for the exit.
      Never kills processes by pid; committed events are preserved.

Live runs (M1 supports the reference JSONL adapter only):
  viewtrace run [--adapter <id>] [--json] [--latency-log <file>] \\
                [--data-root <dir>] -- <producer command> [args...]
      Wrap an explicit producer. Producer contract: one ViewTrace JSON
      record per newline-terminated stdout line; human-readable output
      belongs on stderr (stdout chatter counts as input loss and makes the
      run PARTIAL). The producer receives its identity in the environment:
      VIEWTRACE_RUN_ID and VIEWTRACE_DATA_ROOT. Its arguments are passed
      verbatim — there is never a shell in between. Windows .cmd/.bat
      producers are run via cmd.exe with quoted arguments.
      Activity, provenance labels (reported/observed/inferred), warnings
      and the real terminal state are shown live; output is plain text
      with no ANSI escapes (identical when piped).

Batch/query (M0 commands, unchanged):
  viewtrace ingest <file.jsonl> [--data-root <dir>] [--json]
  viewtrace runs [--data-root <dir>] [--json]
  viewtrace replay <runId> [--data-root <dir>] [--json]
  viewtrace adapters [--json]

Analysis (M3, incremental evidence analyzer & JEV v2):
  viewtrace analyze <runId> [--answer <answerId>] [--mode <mode>]
                    [--data-root <dir>] [--json]
      Analyze observable evidence, mode lens, claims, conflicts, and
      bounded advisory JEV v2 checkpoints for an answer. Prints concise
      lanes (obs / rep / inf / ?) and evidence support status.

Reveal (M2, reference adapter only):
  viewtrace [--receipt <id> | --agent <id> --session <id> --turn <id>]
            [--answer-hash <sha256> --hash-version <policy>] [--url-only] [--json]
            [--select <receiptId|runId>] [--data-root <dir>]
      Reveal a saved answer by explicit identity. Context comes only from
      these flags. Hash alone, cwd, timestamps and latest never establish
      a match. Uncertain/mismatch/missing context opens a recent picker.
      Non-TTY prints JSON/candidates or a safe URL. No capture is started.
  viewtrace open latest [--url-only] [--data-root <dir>]
      Open the latest run exploration container; answer association UNKNOWN.
  viewtrace delete <runId> | keep <runId> [--release]
  viewtrace prune --before <ISO timestamp> [--data-root <dir>]
      Authenticated local mutations; active runs cannot be deleted. Default
      retention is indefinite. Keep excludes a run from explicit age pruning.
      Delete removes all receipts and artifacts for that run. The service
      must be ready. The report binds 127.0.0.1:7331 by default; an explicit
      --report-port 0 requests an OS-assigned port for isolated roots.

Exit codes:
  0  success   1  runtime failure / not running / unknown run
  2  usage, unsupported adapter, or collector not running (for run)
  4  producer exited 0 but the collection is PARTIAL/UNKNOWN or unconfirmed
  127 producer could not be spawned
  130/143  cancelled by SIGINT/SIGTERM (a CANCELLED record is committed)
  otherwise the producer's own nonzero exit code is preserved.

Compatibility: the legacy 'agent-pigeon' bin and its commands are unchanged.
`;

function resolveVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', '..', 'package.json'), // repo: dist/src/viewtrace/
    join(here, '..', 'package.json'),
    join(here, '..', '..', 'package.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
        if (typeof pkg.version === 'string') return pkg.version;
      } catch {
        /* try next candidate */
      }
    }
  }
  return '0.0.0-unknown';
}

function defaultDataRoot(): string {
  const override = process.env['VIEWTRACE_DATA_ROOT'];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), '.viewtrace');
}

function usage(error?: string): number {
  if (error !== undefined) process.stderr.write(`${PROGRAM}: ${error}\n`);
  process.stderr.write(`Usage: ${PROGRAM} <command> [options] — try '${PROGRAM} --help'\n`);
  return 2;
}

interface CliArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

const VALUE_FLAGS = new Set([
  '--data-root',
  '--adapter',
  '--latency-log',
  '--report-port',
  '--receipt',
  '--agent',
  '--session',
  '--turn',
  '--answer',
  '--run-id',
  '--answer-hash',
  '--hash-version',
  '--select',
  '--before',
  '--mode',
]);
const BOOLEAN_FLAGS = new Set(['--json', '--url-only', '--release']);

function parseArgs(argv: readonly string[], allowUnknown = false): CliArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (VALUE_FLAGS.has(arg)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        process.stderr.write(`${PROGRAM}: ${arg} requires a value\n`);
        process.exit(2);
      }
      flags.set(arg.slice(2), next);
      i += 1;
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      flags.set(arg.slice(2), true);
      continue;
    }
    if (arg.startsWith('--')) {
      if (!allowUnknown) {
        process.stderr.write(`${PROGRAM}: unknown option ${arg}\n`);
        process.exit(2);
      }
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags };
}

function dataRootOf(flags: CliArgs['flags']): string {
  const value = flags.get('data-root');
  return typeof value === 'string' ? value : defaultDataRoot();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/* ------------------------------------------------------------------ */
/* Collector lifecycle commands                                        */
/* ------------------------------------------------------------------ */

async function ensureRootDirs(dataRoot: string): Promise<void> {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await mkdir(liveDir(dataRoot), { recursive: true, mode: 0o700 });
  await mkdir(logsDir(dataRoot), { recursive: true, mode: 0o700 });
}

async function cmdUp(dataRoot: string, json: boolean, reportPort = 7331): Promise<number> {
  const existing = await readServiceFile(dataRoot);
  if (existing !== null) {
    const probe = await probeService(existing);
    if (probe.state === 'running') {
      try {
        await reportConnection(dataRoot);
      } catch {
        process.stderr.write('viewtrace: collector is running but report is unavailable; use down then up\n');
        return 1;
      }
      // Repair any identity drift in the state file from live health data
      // (best-effort: a concurrent writer or the service heartbeat may
      // already have restored it).
      try {
        await writeServiceFile(dataRoot, {
          ...existing,
          pid: probe.health.pid,
          bootId: probe.health.bootId,
          port: probe.info.port,
        });
      } catch {
        /* repair is cosmetic; the running service heartbeat heals the file */
      }
      if (json) {
        process.stdout.write(
          JSON.stringify({
            running: true,
            alreadyRunning: true,
            pid: probe.health.pid,
            reportUrl: `http://127.0.0.1:${probe.health.reportPort}`,
            dataRoot,
          }) + '\n',
        );
      } else {
        process.stdout.write(`collector already running (pid ${probe.health.pid}) — nothing to do\n`);
      }
      return 0;
    }
  }

  await ensureRootDirs(dataRoot);
  const serviceJs = join(dirname(fileURLToPath(import.meta.url)), 'service.js');
  const child = spawn(
    process.execPath,
    [serviceJs, '--data-root', dataRoot, '--report-port', String(reportPort)],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  let startupFailed = false;
  child.once('exit', (code) => {
    if (code !== 0) startupFailed = true;
  });
  child.unref();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (startupFailed) {
      process.stderr.write(
        'viewtrace: service startup failed; report port may be occupied; see service.log\n',
      );
      return 1;
    }
    const info = await readServiceFile(dataRoot);
    if (info !== null) {
      const probe = await probeService(info);
      if (probe.state === 'running') {
        try {
          await reportConnection(dataRoot);
        } catch {
          await sleep(100);
          continue;
        }
        if (json) {
          process.stdout.write(
            JSON.stringify({
              running: true,
              pid: probe.health.pid,
              reportUrl: `http://127.0.0.1:${probe.health.reportPort}`,
              dataRoot,
            }) + '\n',
          );
        } else {
          process.stdout.write(`collector up: pid ${probe.health.pid} (127.0.0.1:${probe.info.port})\n`);
          process.stdout.write(`  report:    http://127.0.0.1:${probe.health.reportPort}\n`);
          process.stdout.write(`  data root: ${dataRoot}\n`);
          process.stdout.write(`  log:       ${join(logsDir(dataRoot), 'service.log')}\n`);
        }
        return 0;
      }
    }
    await sleep(100);
  }
  process.stderr.write(
    `${PROGRAM}: collector did not become ready within 30s; see ${join(logsDir(dataRoot), 'service.log')}\n`,
  );
  return 1;
}

async function cmdStatus(dataRoot: string, json: boolean): Promise<number> {
  const info = await readServiceFile(dataRoot);
  if (info === null) {
    if (json) process.stdout.write(JSON.stringify({ running: false, reason: 'no-service-state' }) + '\n');
    else process.stdout.write('collector not running (no service state found)\n');
    return 1;
  }
  const probe = await probeService(info);
  if (probe.state !== 'running') {
    if (json)
      process.stdout.write(JSON.stringify({ running: false, reason: 'stale', detail: probe.reason }) + '\n');
    else process.stdout.write(`collector not running (stale state: ${probe.reason})\n`);
    return 1;
  }
  try {
    await reportConnection(dataRoot);
  } catch {
    if (json) process.stdout.write(JSON.stringify({ running: false, reason: 'report-not-ready' }) + '\n');
    else process.stdout.write('collector report not ready (identity or readiness mismatch)\n');
    return 1;
  }
  let runs: { runs?: unknown[] } | null = null;
  try {
    const res = await controlRequest({
      port: probe.info.port,
      token: probe.info.token,
      method: 'GET',
      path: '/runs',
      timeoutMs: 3000,
    });
    runs = res.status === 200 ? (res.json as { runs?: unknown[] }) : null;
  } catch {
    runs = null;
  }
  if (json) {
    process.stdout.write(
      JSON.stringify({
        running: true,
        pid: probe.health.pid,
        uptimeMs: probe.health.uptimeMs,
        boundAddress: probe.health.boundAddress,
        reportReady: probe.health.reportReady ?? false,
        reportUrl: probe.health.reportPort ? `http://127.0.0.1:${probe.health.reportPort}` : null,
        dataRoot,
        runs: runs?.runs ?? null,
      }) + '\n',
    );
  } else {
    process.stdout.write(
      `collector running: pid ${probe.health.pid}, up ${Math.round(probe.health.uptimeMs / 1000)}s\n`,
    );
    process.stdout.write(`  data root: ${dataRoot}\n`);
    const list = Array.isArray(runs?.runs)
      ? (runs?.runs as { runId: string; lifecycle: string; completeness: string; pendingBytes: number }[])
      : [];
    if (list.length === 0) process.stdout.write('  runs: none recorded on this root\n');
    for (const run of list) {
      process.stdout.write(
        `  run ${run.runId}  ${run.lifecycle}  completeness=${run.completeness}  pending=${run.pendingBytes}B\n`,
      );
    }
  }
  return 0;
}

async function cmdDown(dataRoot: string): Promise<number> {
  const info = await readServiceFile(dataRoot);
  if (info === null) {
    await cleanStaleLock(dataRoot);
    process.stdout.write('collector not running — nothing to stop\n');
    return 0;
  }
  const probe = await probeService(info);
  if (probe.state !== 'running') {
    // Stale state: clean the files, never signal a pid.
    await removeServiceFile(dataRoot);
    await cleanStaleLock(dataRoot);
    process.stdout.write(`collector not running (stale state: ${probe.reason}) — cleaned\n`);
    return 0;
  }
  try {
    const res = await controlRequest({
      port: probe.info.port,
      token: probe.info.token,
      method: 'POST',
      path: '/shutdown',
      timeoutMs: 5000,
    });
    if (res.status !== 200) {
      process.stderr.write(`${PROGRAM}: shutdown request failed (HTTP ${res.status})\n`);
      return 1;
    }
  } catch (e) {
    process.stderr.write(
      `${PROGRAM}: shutdown request failed (${e instanceof Error ? e.message : String(e)})\n`,
    );
    return 1;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && pidAlive(info.pid)) {
    await sleep(100);
  }
  if (pidAlive(info.pid)) {
    process.stderr.write(`${PROGRAM}: collector pid ${info.pid} did not exit within 10s\n`);
    return 1;
  }
  await removeServiceFile(dataRoot).catch(() => undefined);
  await cleanStaleLock(dataRoot);
  process.stdout.write('collector stopped; committed runs are preserved\n');
  return 0;
}

async function cleanStaleLock(dataRoot: string): Promise<void> {
  try {
    const text = await readFile(serviceLockFile(dataRoot), 'utf8');
    const pid = Number(text.trim());
    if (Number.isInteger(pid) && pid !== process.pid && !pidAlive(pid)) {
      await rm(serviceLockFile(dataRoot), { force: true });
    }
  } catch {
    /* no lock file */
  }
}

/* ------------------------------------------------------------------ */
/* Query commands (read-only store connections)                        */
/* ------------------------------------------------------------------ */

async function cmdRuns(dataRoot: string, json: boolean): Promise<number> {
  const store = await ViewTraceStore.openQuery(dataRoot);
  try {
    const runs = store === null ? [] : store.listRuns();
    if (json) {
      process.stdout.write(JSON.stringify(runs, null, 2) + '\n');
    } else {
      if (runs.length === 0) process.stdout.write('no stored runs\n');
      for (const run of runs) {
        process.stdout.write(
          `${run.runId}  ${run.lifecycle}  completeness=${run.completeness}  events=${run.eventCount}  adapter=${run.adapterId}@${run.adapterVersion}\n`,
        );
      }
    }
  } finally {
    await store?.close();
  }
  return 0;
}

async function cmdReplay(runId: string | undefined, dataRoot: string, json: boolean): Promise<number> {
  if (runId === undefined) return usage('replay requires a run id');
  const store = await ViewTraceStore.openQuery(dataRoot);
  try {
    const replay = store === null ? null : store.replay(runId);
    if (replay === null) {
      process.stderr.write(`${PROGRAM}: unknown run: ${runId}\n`);
      return 1;
    }
    process.stdout.write(JSON.stringify(replay, null, json ? 2 : 2) + '\n');
  } finally {
    await store?.close();
  }
  return 0;
}

function revealArgs(args: CliArgs, latest = false): Promise<number> {
  const mapping: Record<string, string> = {
    receipt: 'receiptId',
    agent: 'agentId',
    session: 'agentSessionId',
    turn: 'turnId',
    answer: 'answerId',
    'run-id': 'runId',
    'answer-hash': 'answerHash',
    'hash-version': 'hashVersion',
  };
  const raw: Record<string, unknown> = {};
  for (const [flag, key] of Object.entries(mapping))
    if (args.flags.has(flag)) raw[key] = args.flags.get(flag);
  return reveal({
    dataRoot: dataRootOf(args.flags),
    context: parseAnswerContext(raw),
    json: args.flags.get('json') === true,
    urlOnly: args.flags.get('url-only') === true,
    latest,
    select: typeof args.flags.get('select') === 'string' ? (args.flags.get('select') as string) : undefined,
  });
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(argv: readonly string[]): Promise<number> {
  const first = argv[0];

  if (argv.length === 0 || (first?.startsWith('--') && first !== '--help' && first !== '--version'))
    return revealArgs(parseArgs(argv));
  if (first === '--help' || first === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  if (first === '--version' || first === '-V') {
    process.stdout.write(`${resolveVersion()}\n`);
    return 0;
  }

  const command = first as string;
  const rest = argv.slice(1);

  switch (command) {
    case 'up': {
      const args = parseArgs(rest);
      const port = Number(args.flags.get('report-port') ?? 7331);
      if (!Number.isInteger(port) || port < 0 || port > 65535) return usage('invalid report port');
      return cmdUp(dataRootOf(args.flags), args.flags.get('json') === true, port);
    }
    case 'status': {
      const args = parseArgs(rest);
      return cmdStatus(dataRootOf(args.flags), args.flags.get('json') === true);
    }
    case 'down': {
      const args = parseArgs(rest);
      return cmdDown(dataRootOf(args.flags));
    }
    case 'run': {
      const separator = rest.indexOf('--');
      const flagPart = separator === -1 ? rest : rest.slice(0, separator);
      const producerArgv = separator === -1 ? [] : rest.slice(separator + 1);
      const args = parseArgs(flagPart);
      if (producerArgv.length === 0) {
        return usage('run requires a producer: viewtrace run [--options] -- <command> [args...]');
      }
      const adapterId =
        typeof args.flags.get('adapter') === 'string'
          ? (args.flags.get('adapter') as string)
          : REFERENCE_ADAPTER_ID;
      const adapter = getAdapter(adapterId);
      if (adapter === null || adapter.status !== 'REFERENCE') {
        process.stderr.write(
          `${PROGRAM}: unsupported adapter '${adapterId}'. Supported live adapters: ${REFERENCE_ADAPTER_ID}. ` +
            'Real agent research adapters land in M5 (see `viewtrace adapters`).\n',
        );
        return 2;
      }
      return runCommand(producerArgv, {
        dataRoot: dataRootOf(args.flags),
        adapter,
        json: args.flags.get('json') === true,
        latencyLogPath:
          typeof args.flags.get('latency-log') === 'string'
            ? (args.flags.get('latency-log') as string)
            : undefined,
      });
    }
    case 'open': {
      const args = parseArgs(rest);
      const target = args.positional[0] ?? 'latest';
      if (target !== 'latest')
        return usage("open supports only 'latest'; use --receipt or --select for an answer");
      return revealArgs(args, true);
    }
    case 'reveal': {
      return revealArgs(parseArgs(rest));
    }
    case 'delete':
    case 'keep': {
      const args = parseArgs(rest);
      const id = args.positional[0];
      if (!id || !isValidRunId(id)) return usage(`${command} requires a valid run id`);
      const result = await reportMutation(
        dataRootOf(args.flags),
        `/api/runs/${id}${command === 'keep' ? '/keep' : ''}`,
        command === 'delete' ? 'DELETE' : 'POST',
        command === 'keep' ? { keep: args.flags.get('release') !== true } : undefined,
      );
      process.stdout.write(JSON.stringify(result.json) + '\n');
      return 0;
    }
    case 'prune': {
      const args = parseArgs(rest);
      const before = args.flags.get('before');
      if (typeof before !== 'string' || !isValidTimestamp(before))
        return usage('prune requires --before <ISO timestamp>');
      const result = await reportMutation(dataRootOf(args.flags), '/api/retention', 'POST', { before });
      process.stdout.write(JSON.stringify(result.json) + '\n');
      return 0;
    }
    case 'adapters': {
      const args = parseArgs(rest);
      const adapters = listAdapters();
      if (args.flags.get('json') === true) {
        process.stdout.write(JSON.stringify(adapters, null, 2) + '\n');
        return 0;
      }
      for (const adapter of adapters) {
        process.stdout.write(
          `${adapter.adapterId} [${adapter.status}] v${adapter.version} — events:${summarizeEvents(adapter.events)} sourceAnchor:${adapter.sourceAnchor} provenance:${adapter.provenance} liveIngest:${adapter.liveIngest} completion:${adapter.completion}\n`,
        );
        for (const limitation of adapter.limitations) {
          process.stdout.write(`    - ${limitation}\n`);
        }
      }
      return 0;
    }
    case 'ingest': {
      const args = parseArgs(rest);
      const input = args.positional[0];
      if (input === undefined) return usage('ingest requires a trace file path');
      try {
        const outcome = await ingestFile(input, { dataRoot: dataRootOf(args.flags) });
        if (args.flags.get('json') === true) {
          process.stdout.write(JSON.stringify(outcome, null, 2) + '\n');
        } else {
          printIngest(outcome);
        }
        for (const err of outcome.jsonlWriteErrors) {
          process.stderr.write(
            `${PROGRAM}: warning: derived trace.jsonl write failed for run ${err.runId} (${err.message}); database is authoritative and the file will be re-derived on next open\n`,
          );
        }
        const unverified = outcome.replayChecks.filter((c) => !c.verified);
        if (unverified.length > 0) {
          for (const check of unverified) {
            process.stderr.write(
              `${PROGRAM}: replay verification FAILED for ${check.runId}: ${check.mismatch}\n`,
            );
          }
          return 1;
        }
        return outcome.jsonlWriteErrors.length > 0 ? 1 : 0;
      } catch (e) {
        process.stderr.write(`${PROGRAM}: ingest failed: ${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
      }
    }
    case 'runs': {
      const args = parseArgs(rest);
      return cmdRuns(dataRootOf(args.flags), args.flags.get('json') === true);
    }
    case 'replay': {
      const args = parseArgs(rest);
      return cmdReplay(args.positional[0], dataRootOf(args.flags), args.flags.get('json') === true);
    }
    case 'analyze': {
      const args = parseArgs(rest);
      const runId = args.positional[0];
      const answerId = typeof args.flags.get('answer') === 'string' ? (args.flags.get('answer') as string) : undefined;
      const mode = typeof args.flags.get('mode') === 'string' ? (args.flags.get('mode') as string) : undefined;
      return cmdAnalyze(runId, answerId, mode, dataRootOf(args.flags), args.flags.get('json') === true);
    }
    default:
      return usage(`unknown command '${command}'`);
  }
}

async function cmdAnalyze(
  runId: string | undefined,
  answerId: string | undefined,
  overrideMode: string | undefined,
  dataRoot: string,
  json: boolean,
): Promise<number> {
  if (!runId || !isValidRunId(runId)) {
    return usage('analyze requires a valid runId');
  }
  if (overrideMode !== undefined && !ANALYSIS_MODES.includes(overrideMode as AnalysisMode)) {
    return usage(
      `invalid --mode '${overrideMode}'; expected one of ${ANALYSIS_MODES.join(', ')}`,
    );
  }
  const store = await ViewTraceStore.open({ dataRoot });
  try {
    const run = store.getRun(runId);
    if (!run) {
      process.stderr.write(`${PROGRAM}: run '${runId}' not found\n`);
      return 1;
    }
    let targetAnswerId = answerId;
    if (!targetAnswerId) {
      const answers = store.recentAnswers(100).filter((a: { runId: string }) => a.runId === runId);
      targetAnswerId = answers[0]?.answerId;
    }
    if (!targetAnswerId || !store.getAnswer(runId, targetAnswerId)) {
      const available = store
        .recentAnswers(100)
        .filter((a: { runId: string }) => a.runId === runId)
        .map((a: { answerId: string }) => a.answerId);
      if (available.length === 0) {
        process.stderr.write(
          `${PROGRAM}: run '${runId}' has no answer receipts; nothing to analyze (analyze is answer-scoped)\n`,
        );
      } else {
        process.stderr.write(
          `${PROGRAM}: answer '${targetAnswerId}' not found in run '${runId}' (available: ${available.join(', ')})\n`,
        );
      }
      return 1;
    }
    const report = await answerAnalysisReport(store, runId, targetAnswerId, {
      overrideMode: overrideMode as AnalysisMode | undefined,
    });
    if (!report) {
      process.stderr.write(`${PROGRAM}: analysis failed for answer '${targetAnswerId}' in run '${runId}'\n`);
      return 1;
    }
    if (json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return 0;
    }
    printAnalysisReport(report);
    return 0;
  } finally {
    store.close();
  }
}

function printAnalysisReport(report: AnalysisReportV1): void {
  process.stdout.write(`Analysis Report [${report.schema}]\n`);
  process.stdout.write(`  Run: ${report.scope.runId}  Answer: ${report.scope.answerId}\n`);
  process.stdout.write(`  Scope boundary: ${report.scope.boundary}  Freshness: ${report.freshness.status}\n`);
  process.stdout.write(`  Input revision: ${report.inputRevision.value.slice(0, 16)}… (${report.inputRevision.recordCount} events)\n`);
  process.stdout.write(`  Support: ${report.support.status} (${report.support.reasonCodes.join(', ')})\n`);
  process.stdout.write(`  Mode: ${report.lens.currentMode} [${report.lens.revisions[report.lens.revisions.length - 1]?.phase}]\n`);

  let obs = 0, rep = 0, inf = 0, unk = 0;
  for (const e of report.evidence) {
    if (e.effectiveProvenance === 'VIEWTRACE_OBSERVED') obs++;
    else if (e.effectiveProvenance === 'AGENT_REPORTED') rep++;
    else if (e.effectiveProvenance === 'VIEWTRACE_INFERRED') inf++;
    else unk++;
  }
  for (const c of report.claims) {
    if (c.provenance === 'AGENT_REPORTED') rep++;
    else if (c.provenance === 'VIEWTRACE_OBSERVED') obs++;
    else if (c.provenance === 'VIEWTRACE_INFERRED') inf++;
  }
  unk += report.conflicts.filter((c) => c.status === 'DETECTED').length;

  process.stdout.write(`  Lanes: obs:${obs}  rep:${rep}  inf:${inf}  ?:${unk}\n`);
  process.stdout.write(`  Claims: ${report.claims.length} (${report.claims.filter((c) => c.importance === 'CORE').length} core)\n`);
  for (const c of report.claims) {
    process.stdout.write(`    - [${c.support}] ${c.text.slice(0, 70)}\n`);
  }
  if (report.conflicts.length > 0) {
    process.stdout.write(`  Conflicts: ${report.conflicts.length}\n`);
    for (const cf of report.conflicts) {
      process.stdout.write(`    - [${cf.status}] conditionMatch:${cf.conditionMatch}\n`);
    }
  }
  if (report.jevResults.length > 0) {
    process.stdout.write(`  JEV v2 Advisory Checkpoints: ${report.jevResults.length}\n`);
    for (const j of report.jevResults) {
      process.stdout.write(
        `    - ${j.checkpointId}: gain=${j.labels?.evidenceGain ?? 'N/A'} progress=${j.labels?.progress ?? 'N/A'} rethink=${j.labels?.rethinkNeeded ?? 'N/A'}\n`,
      );
    }
  }
}

function printIngest(outcome: Awaited<ReturnType<typeof ingestFile>>): void {
  for (const run of outcome.runs) {
    process.stdout.write(
      `run ${run.runId}: ${run.lifecycle} / ${run.completeness} — events ${run.eventsAccepted} accepted, ${run.eventsRejected} rejected; duplicates ${run.duplicatesIdempotent} idempotent, ${run.duplicatesConflicting} conflicting\n`,
    );
  }
  if (outcome.runs.length === 0) process.stdout.write('no runs found in input\n');
  if (outcome.losses.length === 0) {
    process.stdout.write('input losses: none\n');
  } else {
    process.stdout.write(`input losses: ${outcome.losses.length}\n`);
    for (const loss of outcome.losses) {
      process.stdout.write(
        `  line ${loss.lineIndex} byte ${loss.byteOffset}: ${loss.code}${loss.definitive ? '' : ' (possibly incomplete tail)'}\n`,
      );
    }
  }
  const errors = outcome.diagnostics.filter((d) => d.severity === 'error');
  const warnings = outcome.diagnostics.filter((d) => d.severity !== 'error');
  process.stdout.write(`diagnostics: ${errors.length} error, ${warnings.length} warning/info\n`);
  for (const d of outcome.diagnostics) {
    process.stdout.write(`  [${d.severity}] ${d.code}: ${d.message}\n`);
  }
  process.stdout.write(
    `replay verification: ${outcome.replayChecks.every((c) => c.verified) ? 'OK' : 'FAILED'}\n`,
  );
  process.stdout.write(`data root: ${outcome.dataRoot}\n`);
}

function summarizeEvents(events: Readonly<Record<string, string>>): string {
  return Object.entries(events)
    .map(([type, level]) => `${type}=${level}`)
    .join(',');
}

// process.exit() is deliberately avoided here: it can truncate large
// stdout writes (replay/runs --json) that are still flushing to a pipe.
// Setting exitCode lets the event loop drain pending writes before exit.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`${PROGRAM}: unexpected failure: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
