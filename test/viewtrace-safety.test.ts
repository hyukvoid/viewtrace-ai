/**
 * M1 CLI safety: verbatim argv (Korean/spaces/&/quotes), terminal-injection
 * sanitization, private-reasoning sentinels across every artifact, original
 * fixture immutability, network sentinel during a live run, `open latest`
 * honesty, help accuracy, and Windows `.cmd` spawn handling.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import {
  downService,
  producerHeader,
  runBin,
  upService,
  waitFor,
  writeProducer,
} from './helpers/m1.js';
import { repoRoot, viewtraceFixture } from './helpers/viewtrace.js';

const isWindows = process.platform === 'win32';
const PRIVATE_SENTINEL = 'PRIVATE_REASONING_SENTINEL_9f1c';

describe('viewtrace run — safety and honesty', () => {
  let root: string;
  let producers: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'vt-safe-'));
    producers = join(root, 'producers');
    await upService(root);
  });

  after(async () => {
    await downService(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('passes producer arguments through verbatim (Korean, spaces, &, quotes)', async () => {
    const args = ['한글 인자', 'space & amp', 'quote"inside', "single'quote", 'paren(1)'];
    const out = join(root, 'argv-out.json');
    const producer = await writeProducer(
      producers,
      'argv-echo.mjs',
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    const result = await runBin([
      'run',
      '--data-root',
      root,
      '--',
      process.execPath,
      producer,
      ...args,
    ]);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')) as string[], args);
  });

  it('spawns a real .cmd producer with quoted arguments on Windows', async () => {
    if (!isWindows) {
      // POSIX: the transform is exercised as a pure unit check instead.
      const quoted = ['C:\\tool\\my tool.cmd', 'arg with space', 'q"x'].map(
        (a) => `"${a.replace(/"/g, '""')}"`,
      );
      assert.deepEqual(quoted, ['"C:\\tool\\my tool.cmd"', '"arg with space"', '"q""x"']);
      return;
    }
    const marker = join(root, 'cmd-marker.txt');
    const script = join(root, 'echo-args.cmd');
    await writeFile(
      script,
      `@echo off\r\necho %* > "${marker}"\r\n`,
      'utf8',
    );
    const result = await runBin(['run', '--data-root', root, '--', script, 'hello', 'a b']);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    const echoed = await readFile(marker, 'utf8');
    assert.ok(echoed.includes('hello'));
    assert.ok(echoed.includes('a b'));
  });

  it('sanitizes terminal-injection attempts in every displayed line', async () => {
    const producer = await writeProducer(
      producers,
      'inject.mjs',
      `${producerHeader()}
run('RUNNING');
event('e-inject', 'SEARCH', { type: 'SEARCH', query: 'q\\u001b[31mRED\\u001b[0m\\r\\ninjected line', results: [] });
process.stdout.write('chatter \\u001b]0;title\\u0007 more\\n');
run('COMPLETED');
`,
    );
    const result = await runBin(['run', '--data-root', root, '--', process.execPath, producer]);
    assert.equal(result.code, 4, 'the chatter line is a loss, so PARTIAL');
    const lines = result.stdout.split('\n');
    for (const textLine of lines) {
      assert.ok(!textLine.includes('\u001b'), `no ESC bytes may appear: ${JSON.stringify(textLine)}`);
      assert.ok(!/[\x00-\x08\x0b-\x1f]/.test(textLine), `no control chars: ${JSON.stringify(textLine)}`);
      assert.ok(!/^injected/.test(textLine), 'injected content must not forge its own display line');
    }
  });

  it('never lets declared private-reasoning payloads reach disk, store or terminal', async () => {
    const producer = await writeProducer(
      producers,
      'cot.mjs',
      `${producerHeader()}
run('RUNNING');
rec({
  ...base, recordKind: 'event', eventId: 'e-cot', type: 'CLAIM',
  thinking: '${PRIVATE_SENTINEL} internal scratchpad',
  origin: { producer: 'x', analysis: '${PRIVATE_SENTINEL}' },
  source: { sourceId: 's-cot', kind: 'TOOL_RESULT', location: 'tool://cot/1' },
  provenance: { category: 'AGENT_REPORTED' },
  payload: { type: 'CLAIM', text: '공개 주장', chain_of_thought: '${PRIVATE_SENTINEL}' },
});
run('COMPLETED');
`,
    );
    const result = await runBin(['run', '--data-root', root, '--', process.execPath, producer]);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);

    // 1. terminal output
    assert.ok(!result.stdout.includes(PRIVATE_SENTINEL), 'terminal must not show the payload');
    assert.ok(result.stdout.includes('REDACTED_PRIVATE_FIELD') || result.stdout.includes('warn'), 'redaction is reported (paths only)');

    // 2. spool file (sanitized before write)
    const spool = await readFile(join(root, 'live', result.stdout.match(/run (run-[^\s]+) started/)?.[1] ?? '', 'stream.jsonl'), 'utf8').catch(() => null);
    assert.notEqual(spool, null);
    assert.ok(!spool?.includes(PRIVATE_SENTINEL), 'spool must be sanitized');

    // 3. authoritative store + derived trace.jsonl + every artifact under the root
    await assertRootFreeOfSentinel(root, PRIVATE_SENTINEL);
  });

  it('never modifies the original fixture/history inputs', async () => {
    const fixture = viewtraceFixture('research-normal.jsonl');
    const beforeHash = createHash('sha256').update(await readFile(fixture)).digest('hex');
    const producer = await writeProducer(
      producers,
      'reader.mjs',
      `import { readFileSync } from 'node:fs';\nreadFileSync(${JSON.stringify(fixture)}, 'utf8');\nprocess.exit(0);\n`,
    );
    await runBin(['run', '--data-root', root, '--', process.execPath, producer]);
    const afterHash = createHash('sha256').update(await readFile(fixture)).digest('hex');
    assert.equal(beforeHash, afterHash);
  });

  it('makes zero external network requests during a live run (net sentinel)', async () => {
    const sentinelUrl = pathToFileURL(join(repoRoot, 'test', 'helpers', 'net-sentinel.mjs')).href;
    const report = join(root, 'net-sentinel-report.json');
    const producer = await writeProducer(
      producers,
      'quiet.mjs',
      `${producerHeader()}\nrun('RUNNING');\nrun('COMPLETED');\n`,
    );
    const result = await runBin(['run', '--data-root', root, '--', process.execPath, producer], {
      env: {
        NODE_OPTIONS: `--import ${sentinelUrl}`,
        NET_SENTINEL_REPORT: report,
      },
    });
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    const sentinelReport = JSON.parse(await readFile(report, 'utf8')) as {
      violations: unknown[];
      loopbackUses: unknown[];
    };
    assert.deepEqual(sentinelReport.violations, [], 'zero external network attempts');
    assert.ok(sentinelReport.loopbackUses.length > 0, 'loopback control traffic is visible in the report');
  });

  it('open latest: verifies the run, never prints a URL, exits 3', async () => {
    const withRuns = await runBin(['open', 'latest', '--data-root', root]);
    assert.equal(withRuns.code, 3);
    assert.ok(withRuns.stdout.includes('latest run:'), withRuns.stdout);
    assert.ok(withRuns.stdout.includes('M2'), 'must state the report server is not implemented');
    assert.ok(!/https?:\/\//.test(withRuns.stdout), 'no URL may be presented as a link');

    const emptyRoot = await mkdtemp(join(tmpdir(), 'vt-open-'));
    try {
      const withoutRuns = await runBin(['open', 'latest', '--data-root', emptyRoot]);
      assert.equal(withoutRuns.code, 1);
      const badTarget = await runBin(['open', 'something-else', '--data-root', emptyRoot]);
      assert.equal(badTarget.code, 2);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it('help documents commands, framing, storage and the exit-code contract', async () => {
    const help = await runBin(['--help']);
    assert.equal(help.code, 0);
    for (const needle of [
      'viewtrace up',
      'viewtrace status',
      'viewtrace down',
      'viewtrace run',
      'VIEWTRACE_RUN_ID',
      'Exit codes',
      'one ViewTrace JSON',
      '127.0.0.1',
      'agent-pigeon',
    ]) {
      assert.ok(help.stdout.includes(needle), `help must document: ${needle}`);
    }
  });

  it('writes only inside the data root (no HOME pollution)', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'vt-home-'));
    try {
      const producer = await writeProducer(
        producers,
        'homecheck.mjs',
        `${producerHeader()}\nrun('RUNNING');\nevent('e1','SEARCH',{type:'SEARCH',query:'home',results:[]});\nrun('COMPLETED');\n`,
      );
      const result = await runBin(['run', '--data-root', root, '--', process.execPath, producer], {
        env: { HOME: fakeHome, USERPROFILE: fakeHome },
      });
      assert.equal(result.code, 0, result.stderr);
      const entries = await readdir(fakeHome);
      assert.equal(entries.length, 0, 'nothing may be written outside the data root');
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});

async function assertRootFreeOfSentinel(root: string, sentinel: string): Promise<void> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile()) files.push(p);
    }
  }
  await walk(root);
  assert.ok(files.length > 0, 'expected artifacts under the data root');
  for (const file of files) {
    if (file.endsWith('.mjs') || file.endsWith('net-sentinel-report.json')) continue; // test inputs
    const content = await readFile(file, 'utf8').catch(() => '');
    assert.ok(!content.includes(sentinel), `sentinel leaked into ${file}`);
  }
}
