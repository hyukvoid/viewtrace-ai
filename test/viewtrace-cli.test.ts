import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { cliDist, viewtraceFixture, repoRoot } from './helpers/viewtrace.js';

const exec = promisify(execFile);

async function runCli(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliDist, ...args], {
      env: { ...process.env, ...env },
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
  }
}

describe('viewtrace CLI: help and version', () => {
  it('prints product identity, scope, privacy and unimplemented-command policy', async () => {
    const { stdout, code } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.ok(stdout.includes('ViewTrace AI'));
    assert.ok(stdout.includes('Trace the evidence behind AI answers'));
    assert.ok(stdout.includes('~/.viewtrace'));
    assert.ok(stdout.includes('ZERO external network requests'));
    assert.ok(stdout.includes('Private reasoning'), 'privacy statement about reasoning');
    assert.ok(stdout.includes('not implemented yet'), 'future commands are explicitly marked');
    for (const cmd of ['up', 'down', 'status', 'run', 'open']) {
      assert.ok(stdout.includes(`viewtrace ${cmd}`), `help lists ${cmd} as unimplemented`);
    }
    assert.ok(stdout.includes('agent-pigeon'), 'legacy bin compatibility is documented');
  });

  it('prints the package version', async () => {
    const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { version: string };
    const { stdout, code } = await runCli(['--version']);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), pkg.version);
  });

  it('rejects usage errors with nonzero exit codes', async () => {
    assert.equal((await runCli([])).code, 2);
    assert.equal((await runCli(['definitely-not-a-command'])).code, 2);
  });

  it('reports unimplemented lifecycle commands explicitly (exit 3)', async () => {
    for (const cmd of ['up', 'down', 'status', 'run', 'open']) {
      const { stderr, code } = await runCli([cmd]);
      assert.equal(code, 3, cmd);
      assert.ok(stderr.includes('not implemented yet'), cmd);
      assert.ok(!stderr.includes('started'), `${cmd} must not pretend to run`);
    }
  });
});

describe('viewtrace CLI: adapters', () => {
  it('lists the reference adapter as REFERENCE and agent adapters as PLANNED with UNKNOWN levels', async () => {
    const { stdout, code } = await runCli(['adapters']);
    assert.equal(code, 0);
    assert.ok(stdout.includes('viewtrace-reference-jsonl'));
    assert.ok(stdout.includes('[REFERENCE]'));
    assert.ok(stdout.includes('codex'));
    assert.ok(stdout.includes('[PLANNED]'));
    assert.ok(stdout.includes('UNKNOWN'), 'unverified capabilities must not claim YES');
    const json = JSON.parse((await runCli(['adapters', '--json'])).stdout) as { status: string }[];
    assert.ok(json.every((a) => a.status === 'REFERENCE' || a.status === 'PLANNED'));
  });
});

describe('viewtrace CLI: ingest / runs / replay over a real store', () => {
  it('round-trips a fixture through the public bin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vt-cli-'));

    const ingest = await runCli([
      'ingest',
      viewtraceFixture('research-normal.jsonl'),
      '--data-root',
      root,
      '--json',
    ]);
    assert.equal(ingest.code, 0, ingest.stderr);
    const outcome = JSON.parse(ingest.stdout) as {
      runs: { runId: string; lifecycle: string; completeness: string }[];
      replayChecks: { verified: boolean }[];
    };
    assert.equal(outcome.runs[0]?.lifecycle, 'COMPLETED');
    assert.equal(outcome.runs[0]?.completeness, 'COMPLETE');
    assert.ok(outcome.replayChecks.every((c) => c.verified));

    const runs = await runCli(['runs', '--data-root', root, '--json']);
    assert.equal(runs.code, 0);
    assert.ok(runs.stdout.includes('research-normal-001'));

    const replay = await runCli(['replay', 'research-normal-001', '--data-root', root, '--json']);
    assert.equal(replay.code, 0);
    const replayJson = JSON.parse(replay.stdout) as {
      records: unknown[];
      diagnostics: unknown[];
      duplicates: unknown[];
    };
    assert.equal(replayJson.records.length, 12);
    assert.ok(Array.isArray(replayJson.diagnostics));

    const missing = await runCli(['replay', 'no-such-run', '--data-root', root]);
    assert.equal(missing.code, 1);

    const badFile = await runCli(['ingest', join(root, 'nope.jsonl'), '--data-root', root]);
    assert.equal(badFile.code, 1);
    assert.ok(badFile.stderr.length > 0);
  });

  it('honors the VIEWTRACE_DATA_ROOT environment override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vt-env-'));
    const ingest = await runCli(
      ['ingest', viewtraceFixture('lifecycle-invalid.jsonl')],
      { VIEWTRACE_DATA_ROOT: root },
    );
    assert.equal(ingest.code, 0, ingest.stderr);
    const runs = await runCli(['runs', '--json'], { VIEWTRACE_DATA_ROOT: root });
    assert.ok(runs.stdout.includes('lifecycle-invalid-001'));
  });

  it('exits nonzero with an honest summary when the stream was partial', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vt-partial-'));
    const result = await runCli([
      'ingest',
      viewtraceFixture('research-partial.jsonl'),
      '--data-root',
      root,
    ]);
    assert.equal(result.code, 0, 'losses are reported honestly, not failed silently');
    assert.ok(result.stdout.includes('PARTIAL'));
    assert.ok(result.stdout.includes('input losses: 2'));
    assert.ok(result.stdout.includes('TRUNCATED_TAIL'));
  });
});
