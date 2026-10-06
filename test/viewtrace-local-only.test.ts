import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { promisify } from 'node:util';

import { cliDist, viewtraceFixture, repoRoot } from './helpers/viewtrace.js';

const exec = promisify(execFile);

// --import resolves its argument as a URL; a bare Windows path is rejected
// with ERR_UNSUPPORTED_ESM_URL_SCHEME, so always pass a file:// URL.
const sentinelPreload = pathToFileURL(
  join(repoRoot, 'test', 'helpers', 'net-sentinel.mjs'),
).href;

interface SentinelReport {
  violations: { kind: string; target: string }[];
  exitCode: number;
}

async function runWithSentinel(
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; report: SentinelReport | null; code: number }> {
  const reportPath = join(await mkdtemp(join(tmpdir(), 'vt-sentinel-')), 'report.json');
  try {
    const { stdout, stderr } = await exec(
      process.execPath,
      ['--import', sentinelPreload, cliDist, ...args],
      { env: { ...env, NET_SENTINEL_REPORT: reportPath } },
    );
    const report = existsSync(reportPath)
      ? (JSON.parse(await readFile(reportPath, 'utf8')) as SentinelReport)
      : null;
    return { stdout, stderr, report, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    const report = existsSync(reportPath)
      ? (JSON.parse(await readFile(reportPath, 'utf8')) as SentinelReport)
      : null;
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      report,
      code: err.code ?? 1,
    };
  }
}

describe('viewtrace local-only boundary (subprocess + network sentinel)', () => {
  it('ingests without any outbound network attempt, HOME pollution or stray writes', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'vt-local-'));
    const fakeHome = join(sandbox, 'home');
    const cwdSandbox = join(sandbox, 'cwd');
    const dataRoot = join(sandbox, 'data');
    await mkdir(fakeHome, { recursive: true });
    await mkdir(cwdSandbox, { recursive: true });
    const canary = join(cwdSandbox, 'canary.txt');
    await writeFile(canary, 'untouched');

    // os.homedir() reads HOME on POSIX and USERPROFILE on Windows; both are
    // set so the faked home is honored on either platform.
    const homeEnv = {
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      PATH: process.env['PATH'] ?? '',
    };

    const ingest = await runWithSentinel(
      ['ingest', viewtraceFixture('research-normal.jsonl'), '--data-root', dataRoot],
      { ...homeEnv, TMPDIR: sandbox },
    );
    assert.equal(ingest.code, 0, `ingest failed: ${ingest.stderr}`);
    assert.ok(ingest.report !== null);
    assert.deepEqual(ingest.report.violations, [], 'zero outbound network attempts');
    assert.ok(existsSync(join(dataRoot, 'viewtrace.db')), 'data landed inside the explicit data root');
    assert.ok(!existsSync(join(fakeHome, '.viewtrace')), 'HOME must not be polluted when --data-root is explicit');

    const runs = await runWithSentinel(
      ['runs', '--data-root', dataRoot, '--json'],
      homeEnv,
    );
    assert.equal(runs.code, 0);
    assert.ok(runs.report === null || runs.report.violations.length === 0);
    assert.ok(runs.stdout.includes('research-normal-001'));

    const replay = await runWithSentinel(
      ['replay', 'research-normal-001', '--data-root', dataRoot, '--json'],
      homeEnv,
    );
    assert.equal(replay.code, 0);
    assert.ok(replay.stdout.includes('evt-recommend-001'));

    // The working directory and the input fixture stay untouched.
    assert.deepEqual(await readdir(cwdSandbox), ['canary.txt']);
    assert.equal(await readFile(canary, 'utf8'), 'untouched');
  });

  it('defaults the data root to $HOME/.viewtrace when no flag is given', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'vt-defhome-'));
    const fakeHome = join(sandbox, 'home');
    await mkdir(fakeHome, { recursive: true });
    const result = await runWithSentinel(
      ['ingest', viewtraceFixture('research-normal.jsonl')],
      {
        HOME: fakeHome,
        USERPROFILE: fakeHome, // os.homedir() on Windows reads USERPROFILE, not HOME
        PATH: process.env['PATH'] ?? '',
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.ok(existsSync(join(fakeHome, '.viewtrace', 'viewtrace.db')));
    assert.ok(result.report !== null && result.report.violations.length === 0);
  });
});
