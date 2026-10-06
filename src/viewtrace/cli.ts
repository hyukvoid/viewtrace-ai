#!/usr/bin/env node
/**
 * viewtrace — CLI entry point for ViewTrace AI (M1: live CLI trace).
 *
 * M0 provided batch ingest of reference JSONL traces; M1 adds the collector
 * lifecycle (up/status/down), wrapped reference-producer runs with live
 * terminal activity, and honest exit codes. The local report server (`open`)
 * is still M2 — `open latest` verifies the run but never prints a URL.
 */

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
  viewtrace up [--data-root <dir>] [--json]
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

Report (M2 scope):
  viewtrace open latest
      Confirms the latest run exists and where it is stored. The local
      report server itself ships in M2 — this intentionally opens nothing
      and exits 3 until then.

Exit codes:
  0  success   1  runtime failure / not running / unknown run
  2  usage, unsupported adapter, or collector not running (for run)
  3  feature not implemented yet (report server)
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

const VALUE_FLAGS = new Set(['--data-root', '--adapter', '--latency-log']);
const BOOLEAN_FLAGS = new Set(['--json']);

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

async function cmdUp(dataRoot: string, json: boolean): Promise<number> {
  const existing = await readServiceFile(dataRoot);
  if (existing !== null) {
    const probe = await probeService(existing);
    if (probe.state === 'running') {
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
          JSON.stringify({ running: true, alreadyRunning: true, pid: probe.health.pid, dataRoot }) + '\n',
        );
      } else {
        process.stdout.write(`collector already running (pid ${probe.health.pid}) — nothing to do\n`);
      }
      return 0;
    }
  }

  await ensureRootDirs(dataRoot);
  const serviceJs = join(dirname(fileURLToPath(import.meta.url)), 'service.js');
  const child = spawn(process.execPath, [serviceJs, '--data-root', dataRoot], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const info = await readServiceFile(dataRoot);
    if (info !== null) {
      const probe = await probeService(info);
      if (probe.state === 'running') {
        if (json) {
          process.stdout.write(JSON.stringify({ running: true, pid: probe.health.pid, dataRoot }) + '\n');
        } else {
          process.stdout.write(`collector up: pid ${probe.health.pid} (127.0.0.1:${probe.info.port})\n`);
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
    if (json) process.stdout.write(JSON.stringify({ running: false, reason: 'stale', detail: probe.reason }) + '\n');
    else process.stdout.write(`collector not running (stale state: ${probe.reason})\n`);
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
        dataRoot,
        runs: runs?.runs ?? null,
      }) + '\n',
    );
  } else {
    process.stdout.write(`collector running: pid ${probe.health.pid}, up ${Math.round(probe.health.uptimeMs / 1000)}s\n`);
    process.stdout.write(`  data root: ${dataRoot}\n`);
    const list = Array.isArray(runs?.runs) ? (runs?.runs as { runId: string; lifecycle: string; completeness: string; pendingBytes: number }[]) : [];
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
    process.stderr.write(`${PROGRAM}: shutdown request failed (${e instanceof Error ? e.message : String(e)})\n`);
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

async function cmdOpenLatest(dataRoot: string): Promise<number> {
  const store = await ViewTraceStore.openQuery(dataRoot);
  try {
    const runs = store === null ? [] : store.listRuns();
    if (runs.length === 0) {
      process.stdout.write('no runs recorded yet — nothing to open\n');
      return 1;
    }
    let latest = runs[0] as (typeof runs)[number];
    for (const run of runs) {
      if (run.updatedAt > latest.updatedAt || (run.updatedAt === latest.updatedAt && run.runId > latest.runId)) {
        latest = run;
      }
    }
    process.stdout.write(`latest run: ${latest.runId} (${latest.lifecycle} / ${latest.completeness}, ${latest.eventCount} events)\n`);
    process.stdout.write(`stored at:  ${dataRoot} (runs/${latest.runId}/trace.jsonl)\n`);
    process.stdout.write(
      'local report server: not implemented yet (planned for M2) — no URL is opened.\n',
    );
    return 3;
  } finally {
    await store?.close();
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(argv: readonly string[]): Promise<number> {
  const first = argv[0];

  if (argv.length === 0) return usage('no command given');
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
      return cmdUp(dataRootOf(args.flags), args.flags.get('json') === true);
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
      const adapterId = typeof args.flags.get('adapter') === 'string' ? (args.flags.get('adapter') as string) : REFERENCE_ADAPTER_ID;
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
          typeof args.flags.get('latency-log') === 'string' ? (args.flags.get('latency-log') as string) : undefined,
      });
    }
    case 'open': {
      const args = parseArgs(rest);
      const target = args.positional[0] ?? 'latest';
      if (target !== 'latest') return usage("only 'open latest' exists in M1 (report server is M2 scope)");
      return cmdOpenLatest(dataRootOf(args.flags));
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
            process.stderr.write(`${PROGRAM}: replay verification FAILED for ${check.runId}: ${check.mismatch}\n`);
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
    default:
      return usage(`unknown command '${command}'`);
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
  process.stdout.write(`replay verification: ${outcome.replayChecks.every((c) => c.verified) ? 'OK' : 'FAILED'}\n`);
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
