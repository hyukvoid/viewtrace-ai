/**
 * Shared helpers for M1 (live CLI trace) tests: bin subprocess execution,
 * condition waits, producer fixtures and service lifecycle via the public
 * CLI — everything runs against the real built artifacts.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { repoRoot, tempDataRoot } from './viewtrace.js';

export const cliDist = join(repoRoot, 'dist', 'src', 'viewtrace', 'cli.js');

export interface BinResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface RunBinOptions {
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

/** Runs the public bin as a real subprocess and captures its output. */
export function runBin(args: readonly string[], options: RunBinOptions = {}): Promise<BinResult> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliDist, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env } as NodeJS.ProcessEnv,
      cwd: options.cwd,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGKILL');
        settle({ stdout, stderr: `${stderr}\n[TIMED OUT after ${timeoutMs}ms]`, code: -1 });
      }
    }, timeoutMs);
    const settle = (value: BinResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(value);
    };
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (e) => {
      settle({ stdout, stderr: `${stderr}\n[SPAWN ERROR ${String(e)}]`, code: -1 });
    });
    child.on('exit', (code) => {
      settle({ stdout, stderr, code: code ?? -1 });
    });
  });
}

/** Spawns the bin without capturing, for tests that need to signal it. */
export function spawnBin(
  args: readonly string[],
  options: RunBinOptions = {},
): { child: ChildProcess; done: Promise<BinResult>; stdoutSoFar(): string; stderrSoFar(): string } {
  const child = spawn(process.execPath, [cliDist, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env } as NodeJS.ProcessEnv,
    cwd: options.cwd,
    windowsHide: true,
  });
  let stdoutText = '';
  let stderrText = '';
  child.stdout.on('data', (c: Buffer) => {
    stdoutText += c.toString('utf8');
  });
  child.stderr.on('data', (c: Buffer) => {
    stderrText += c.toString('utf8');
  });
  const done = new Promise<BinResult>((resolveDone) => {
    child.on('exit', (code) => resolveDone({ stdout: stdoutText, stderr: stderrText, code: code ?? -1 }));
    child.on('error', () => resolveDone({ stdout: stdoutText, stderr: stderrText, code: -1 }));
  });
  return {
    child,
    done,
    stdoutSoFar: () => stdoutText,
    stderrSoFar: () => stderrText,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** File contents, or null when the file does not exist. */
export async function readFileAsString(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export interface RunListEntry {
  runId: string;
  lifecycle: string;
  completeness: string;
  eventCount: number;
  updatedAt: string;
}

/**
 * Latest run by store updatedAt (NOT list order — run ids in the same
 * second do not sort chronologically because of the random suffix).
 */
export async function latestRun(dataRoot: string, pred?: (r: RunListEntry) => boolean): Promise<RunListEntry | null> {
  const result = await runBin(['runs', '--data-root', dataRoot, '--json']);
  const runs = JSON.parse(result.stdout) as RunListEntry[];
  const eligible = pred !== undefined ? runs.filter(pred) : runs;
  let best: RunListEntry | null = null;
  for (const run of eligible) {
    if (best === null || run.updatedAt > best.updatedAt || (run.updatedAt === best.updatedAt && run.runId > best.runId)) {
      best = run;
    }
  }
  return best;
}

export async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 20_000,
  stepMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = undefined;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, stepMs));
  }
  assert.fail(`condition not met within ${timeoutMs}ms${lastError !== undefined ? ` (last error: ${String(lastError)})` : ''}`);
}

export async function upService(dataRoot: string): Promise<BinResult> {
  const result = await runBin(['up', '--data-root', dataRoot], { timeoutMs: 60_000 });
  assert.equal(result.code, 0, `up failed: ${result.stderr}`);
  return result;
}

export async function downService(dataRoot: string): Promise<BinResult> {
  const result = await runBin(['down', '--data-root', dataRoot], { timeoutMs: 30_000 });
  assert.equal(result.code, 0, `down failed: ${result.stderr}`);
  return result;
}

export interface ServiceFile {
  protocolVersion: number;
  pid: number;
  bootId: string;
  port: number;
  token: string;
  startedAt: string;
}

export async function readServiceFile(dataRoot: string): Promise<ServiceFile | null> {
  try {
    const text = await readFile(join(dataRoot, 'service.json'), 'utf8');
    return JSON.parse(text) as ServiceFile;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function waitForPidExit(pid: number, timeoutMs = 15_000): Promise<void> {
  await waitFor(() => !pidAlive(pid), timeoutMs, 100);
}

/** Writes a producer script and returns its path (spawned via node). */
export async function writeProducer(dir: string, name: string, code: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, code, 'utf8');
  return path;
}

/**
 * Producer body helper: emits ViewTrace reference JSONL records using the
 * run identity passed through the environment.
 */
export function producerHeader(): string {
  return `
const runId = process.env.VIEWTRACE_RUN_ID;
const now = () => new Date().toISOString();
const base = { schemaVersion: 1, runId, occurredAt: now(), adapterId: 'viewtrace-reference-jsonl', adapterVersion: '1.1.0' };
const rec = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const event = (eventId, type, payload, extra = {}) => rec({
  ...base, recordKind: 'event', eventId, type,
  origin: { producer: 'viewtrace-reference-jsonl' },
  source: { sourceId: 'src-' + eventId, kind: 'TOOL_RESULT', location: 'tool://test/' + eventId },
  provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'call-' + eventId } },
  payload, ...extra,
});
const run = (lifecycle, detail) => rec({ ...base, recordKind: 'run', lifecycle, detail });
`;
}

/** Parsed `run --json` output: activity lines plus the final summary line. */
export interface RunJsonOutput {
  readonly activities: unknown[];
  readonly summary: Record<string, unknown> | null;
}

export function parseRunJson(stdout: string): RunJsonOutput {
  const activities: unknown[] = [];
  let summary: Record<string, unknown> | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed['type'] === 'summary') summary = parsed;
      else activities.push(parsed);
    } catch {
      /* ignore stray non-JSON lines */
    }
  }
  return { activities, summary };
}

export { tempDataRoot };

export function tmp(): Promise<string> {
  return tempDataRoot('m1');
}
