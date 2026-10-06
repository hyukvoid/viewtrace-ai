/**
 * M1 `viewtrace run` E2E via the public bin and real producers: all eight
 * domain events, framing (chatter/stderr), exit-code contract, failure and
 * cancellation preservation, concurrency, and collector-death honesty.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  downService,
  latestRun,
  parseRunJson,
  producerHeader,
  readFileAsString,
  runBin,
  sleep,
  spawnBin,
  upService,
  waitFor,
  waitForPidExit,
  writeProducer,
} from './helpers/m1.js';

const isWindows = process.platform === 'win32';

describe('viewtrace run — reference producer E2E', () => {
  let root: string;
  let producers: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'vt-run-'));
    producers = join(root, 'producers');
    await upService(root);
  });

  after(async () => {
    await downService(root).catch(() => undefined);
    if (process.env['VT_KEEP_ROOTS'] !== '1') {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('streams all eight domain event types with provenance labels and exits 0', async () => {
    const producer = await writeProducer(
      producers,
      'all8.mjs',
      `${producerHeader()}
run('RUNNING');
event('e-search', 'SEARCH', { type: 'SEARCH', query: '그래프 데이터베이스 비교', results: [{ sourceId: 'src-e-search', title: 'A', url: 'https://example.com/a' }] });
event('e-read', 'READ', { type: 'READ', sourceId: 'src-e-search', outcome: 'SUCCESS' });
event('e-claim', 'CLAIM', { type: 'CLAIM', text: 'A는 오픈소스다', sourceId: 'src-e-search', anchor: '#license' });
event('e-compare', 'COMPARE', { type: 'COMPARE', candidates: ['A', 'B'], criteria: ['price'], cells: [{ candidate: 'A', criterion: 'price', value: 0 }, { candidate: 'B', criterion: 'price', value: null }] });
event('e-hyp', 'HYPOTHESIS', { type: 'HYPOTHESIS', text: 'A가 B보다 적합할 것', basis: 'PUBLIC_STATEMENT' }, { provenance: { category: 'AGENT_REPORTED' } });
event('e-contra', 'CONTRADICTION', { type: 'CONTRADICTION', description: '가격 정보가 상충한다', conflictingEventIds: ['e-claim', 'e-compare'] });
event('e-verify', 'VERIFY', { type: 'VERIFY', method: '문서 대조', result: 'CONFIRMED', evidenceEventIds: ['e-read'] });
event('e-rec', 'RECOMMEND', { type: 'RECOMMEND', choice: 'A', rationale: ['무료다'], rationaleEventIds: ['e-compare'] }, { provenance: { category: 'AGENT_REPORTED' } });
run('COMPLETED');
`,
    );
    const result = await runBin(['run', '--data-root', root, '--', process.execPath, producer]);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    for (const label of ['SEARCH', 'READ', 'CLAIM', 'COMPARE', 'HYPOTHESIS', 'CONFLICT', 'VERIFY', 'RECOMMEND']) {
      assert.ok(result.stdout.includes(label), `display must show ${label}`);
    }
    assert.ok(result.stdout.includes('(observed)'));
    assert.ok(result.stdout.includes('(reported)'), 'HYPOTHESIS/RECOMMEND provenance must be labelled');
    assert.ok(result.stdout.includes('COMPLETED / COMPLETE'), `${result.stdout}`);
    assert.ok(result.stdout.includes('8 accepted, 0 rejected'));
    assert.ok(result.stdout.includes('run-'), 'run id must be printed');
    assert.ok(!result.stdout.includes('\\u001b'), 'no ANSI escapes');
  });

  it('keeps stdout chatter and stderr visible but marks the run PARTIAL (exit 4)', async () => {
    const producer = await writeProducer(
      producers,
      'chatter.mjs',
      `${producerHeader()}
run('RUNNING');
process.stderr.write('agent: searching the web...\\n');
process.stdout.write('human readable noise\\n');
event('e1', 'SEARCH', { type: 'SEARCH', query: '쿼리', results: [] });
run('COMPLETED');
`,
    );
    const result = await runBin(['run', '--data-root', root, '--', process.execPath, producer]);
    assert.equal(result.code, 4, 'child exit 0 + corrupt input must not be a clean success');
    assert.ok(result.stdout.includes('chatter'), `${result.stdout}`);
    assert.ok(result.stdout.includes('PARTIAL'), result.stdout);
    assert.ok(result.stderr.includes('[agent] agent: searching the web...'), 'stderr passthrough');
    assert.ok(result.stdout.includes('losses: 1'), result.stdout);
    const summary = parseRunJson((await runBin(['run', '--data-root', root, '--json', '--', process.execPath, producer])).stdout).summary;
    assert.equal(summary?.['completeness'], 'PARTIAL');
    assert.equal(summary?.['losses'], 1);
  });

  it('preserves the child exit code and marks FAILED (not success)', async () => {
    const producer = await writeProducer(
      producers,
      'exit1.mjs',
      `${producerHeader()}
run('RUNNING');
event('e1', 'SEARCH', { type: 'SEARCH', query: 'q', results: [] });
process.exit(1);
`,
    );
    const result = await runBin(['run', '--data-root', root, '--', process.execPath, producer]);
    assert.equal(result.code, 1, 'child exit code must be preserved');
    assert.ok(result.stdout.includes('FAILED'), result.stdout);
    assert.ok(result.stdout.includes('producer exited 1'), result.stdout);
  });

  it('keeps a RECOMMEND-before-failure run FAILED with the recommend event intact', async () => {
    const producer = await writeProducer(
      producers,
      'rec-fail.mjs',
      `${producerHeader()}
run('RUNNING');
event('e-rec', 'RECOMMEND', { type: 'RECOMMEND', choice: 'B' });
process.exit(1);
`,
    );
    const result = await runBin(['run', '--data-root', root, '--', process.execPath, producer]);
    assert.equal(result.code, 1);
    assert.ok(result.stdout.includes('FAILED'));
    const recRun = await latestRun(root, (r) => r.eventCount >= 1 && r.runId.startsWith('run-'));
    assert.notEqual(recRun, null);
    assert.equal(recRun?.lifecycle, 'FAILED', 'recommend + crash must never read as success');
    const replay = await runBin(['replay', String(recRun?.runId), '--data-root', root, '--json']);
    assert.ok(replay.stdout.includes('e-rec'), 'the recommend event must be preserved');
  });

  it('handles the empty stream and the started-only stream honestly', async () => {
    const empty = await writeProducer(producers, 'empty.mjs', `process.exit(0);\n`);
    const r1 = await runBin(['run', '--data-root', root, '--', process.execPath, empty]);
    assert.equal(r1.code, 0);
    assert.ok(r1.stdout.includes('COMPLETED / COMPLETE'), r1.stdout);
    assert.ok(r1.stdout.includes('0 accepted'));

    const startedOnly = await writeProducer(
      producers,
      'started.mjs',
      `${producerHeader()}
run('RUNNING');
await new Promise((r) => setTimeout(r, 300));
`,
    );
    const r2 = await runBin(['run', '--data-root', root, '--', process.execPath, startedOnly]);
    assert.equal(r2.code, 0);
    assert.ok(r2.stdout.includes('COMPLETED / COMPLETE'));
    const startedRunId = /run (run-[a-z0-9-]+):/.exec(r2.stdout)?.[1];
    assert.ok(startedRunId !== undefined, r2.stdout);
    // lifecycle history keeps both observations: producer RUNNING + wrapper COMPLETED.
    const replay = await runBin(['replay', startedRunId, '--data-root', root, '--json']);
    assert.ok(replay.stdout.includes('RUNNING'), 'producer RUNNING observation preserved');
    assert.ok(replay.stdout.includes('COMPLETED'), 'wrapper termination observation preserved');
  });

  it('treats an all-malformed stream as COMPLETED + PARTIAL, never clean success', async () => {
    const producer = await writeProducer(
      producers,
      'garbage.mjs',
      `process.stdout.write('not json at all\\n');\nprocess.stdout.write('{broken json\\n');\nprocess.exit(0);\n`,
    );
    const result = await runBin(['run', '--data-root', root, '--', process.execPath, producer]);
    assert.equal(result.code, 4);
    assert.ok(result.stdout.includes('PARTIAL'));
    assert.ok(result.stdout.includes('losses: 2'), result.stdout);
  });

  it('rejects records that target a foreign run id without creating that run', async () => {
    const producer = await writeProducer(
      producers,
      'foreign.mjs',
      `${producerHeader()}
run('RUNNING');
rec({ ...base, recordKind: 'event', eventId: 'x1', type: 'SEARCH', runId: 'someone-elses-run',
  origin: { producer: 'x' }, source: { sourceId: 's', kind: 'TOOL_RESULT' },
  provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'c' } },
  payload: { type: 'SEARCH', query: 'foreign', results: [] } });
run('COMPLETED');
`,
    );
    const result = await runBin(['run', '--data-root', root, '--', process.execPath, producer]);
    assert.equal(result.code, 4);
    const runs = JSON.parse((await runBin(['runs', '--data-root', root, '--json'])).stdout) as { runId: string }[];
    assert.ok(!runs.some((r) => r.runId === 'someone-elses-run'), 'foreign run must not be created');
  });

  it('refuses unsupported adapters and a missing service before spawning anything', async () => {
    const marker = join(root, 'spawn-marker.txt');
    const producer = await writeProducer(
      producers,
      'marker.mjs',
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`,
    );
    const badAdapter = await runBin([
      'run',
      '--data-root',
      root,
      '--adapter',
      'generic-jsonl',
      '--',
      process.execPath,
      producer,
    ]);
    assert.equal(badAdapter.code, 2);
    assert.ok(badAdapter.stderr.includes('unsupported adapter'));
    assert.equal(
      await readFileAsString(marker),
      null,
      'the producer must not run for an unsupported adapter',
    );

    const otherRoot = await mkdtemp(join(tmpdir(), 'vt-nosvc-'));
    try {
      const noService = await runBin(['run', '--data-root', otherRoot, '--', process.execPath, producer]);
      assert.equal(noService.code, 2);
      assert.ok(noService.stderr.includes('not running'));
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('reports spawn failures as exit 127 with an honest FAILED record', async () => {
    const result = await runBin([
      'run',
      '--data-root',
      root,
      '--',
      'definitely-not-a-command-xyz',
      '--flag',
    ]);
    assert.equal(result.code, 127);
    assert.ok(result.stdout.includes('FAILED') || result.stderr.includes('spawn'), `${result.stdout}${result.stderr}`);
    const last = await latestRun(root, (r) => r.runId.startsWith('run-'));
    assert.equal(last?.lifecycle, 'FAILED');
    assert.equal(last?.eventCount, 0);
  });

  it('cancel path: SIGINT commits CANCELLED and exits 130 (POSIX signal semantics)', async () => {
    const producer = await writeProducer(
      producers,
      'sleepy.mjs',
      `${producerHeader()}
run('RUNNING');
event('e1', 'SEARCH', { type: 'SEARCH', query: 'long', results: [] });
setInterval(() => undefined, 1 << 30);
await new Promise(() => undefined);
`,
    );
    const spawnArgs = ['run', '--data-root', root, '--', process.execPath, producer] as const;
    if (!isWindows) {
      const spawned = spawnBin([...spawnArgs], { env: { VIEWTRACE_DRAIN_TIMEOUT_MS: '20000' } });
      await waitFor(() => spawned.stdoutSoFar().includes('SEARCH'), 20_000, 100);
      spawned.child.kill('SIGINT');
      const result = await spawned.done;
      assert.equal(result.code, 130, `SIGINT must map to 130: got ${result.code}\n${result.stdout}`);
      assert.ok(result.stdout.includes('CANCELLED'), result.stdout);
      const last = await latestRun(root, (r) => r.runId.startsWith('run-'));
      assert.equal(last?.lifecycle, 'CANCELLED');
      assert.equal(last?.eventCount, 1, 'the pre-cancel event is committed');
    } else {
      // Windows cannot deliver catchable SIGINT from another process; the
      // honest equivalent is observing an externally killed producer.
      const spawned = spawnBin([...spawnArgs], { env: { VIEWTRACE_DRAIN_TIMEOUT_MS: '20000' } });
      await waitFor(() => spawned.stdoutSoFar().includes('SEARCH'), 20_000, 100);
      spawned.child.kill(); // hard termination of the wrapper's child on win32
      const result = await spawned.done;
      assert.notEqual(result.code, 0);
      assert.ok(result.stdout.includes('FAILED') || result.stdout.includes('CANCELLED'), result.stdout);
    }
  });

  it('a SIGKILLed wrapper leaves the run unfinalized (UNKNOWN, never COMPLETED)', async () => {
    const producer = await writeProducer(
      producers,
      'sleepy2.mjs',
      `${producerHeader()}
run('RUNNING');
event('e1', 'SEARCH', { type: 'SEARCH', query: 'orphan', results: [] });
setInterval(() => undefined, 1 << 30);
await new Promise(() => undefined);
`,
    );
    const spawned = spawnBin(['run', '--data-root', root, '--', process.execPath, producer]);
    // The producer keeps the stream open; identify THIS wrapper's run from
    // its header line before killing the wrapper.
    await waitFor(() => spawned.stdoutSoFar().includes('started'), 20_000, 50);
    const runId = /run (run-[a-z0-9-]+) started/.exec(spawned.stdoutSoFar())?.[1];
    assert.ok(runId !== undefined, spawned.stdoutSoFar());
    await waitFor(async () => {
      const run = await latestRun(root, (r) => r.runId === runId);
      return (run?.eventCount ?? 0) >= 1;
    }, 30_000);
    spawned.child.kill('SIGKILL');
    await spawned.done;
    // No terminal record can ever arrive now: the run must stay unfinalized.
    await sleep(1500);
    const orphan = await latestRun(root, (r) => r.runId === runId);
    assert.notEqual(orphan, undefined, 'missing explicit termination must stay UNKNOWN');
    assert.notEqual(orphan?.completeness, 'COMPLETE');
    assert.notEqual(orphan?.lifecycle, 'COMPLETED');
  });

  it('collects two concurrent runs in isolation', async () => {
    const producerA = await writeProducer(
      producers,
      'con-a.mjs',
      `${producerHeader()}
run('RUNNING');
for (let i = 0; i < 20; i++) event('a' + i, 'SEARCH', { type: 'SEARCH', query: 'A' + i, results: [] });
await new Promise((r) => setTimeout(r, 800));
run('COMPLETED');
`,
    );
    const producerB = await writeProducer(
      producers,
      'con-b.mjs',
      `${producerHeader()}
run('RUNNING');
for (let i = 0; i < 15; i++) event('b' + i, 'READ', { type: 'READ', sourceId: 's-b' + i, outcome: 'SUCCESS' });
await new Promise((r) => setTimeout(r, 400));
run('COMPLETED');
`,
    );
    const [ra, rb] = await Promise.all([
      runBin(['run', '--data-root', root, '--', process.execPath, producerA]),
      runBin(['run', '--data-root', root, '--', process.execPath, producerB]),
    ]);
    assert.equal(ra.code, 0, ra.stdout + ra.stderr);
    assert.equal(rb.code, 0, rb.stdout + rb.stderr);
    assert.ok(ra.stdout.includes('20 accepted'));
    assert.ok(rb.stdout.includes('15 accepted'));
    const runs = JSON.parse((await runBin(['runs', '--data-root', root, '--json'])).stdout) as { runId: string; eventCount: number; completeness: string }[];
    const pair = runs.filter((r) => r.eventCount === 20 || r.eventCount === 15);
    assert.equal(pair.length, 2, 'both runs recorded separately');
    assert.ok(pair.every((r) => r.completeness === 'COMPLETE'));
  });

  it('surfaces collector death honestly: exit 4, spool retained, next up drains with 0 loss', async () => {
    const producer = await writeProducer(
      producers,
      'slowdrain.mjs',
      `${producerHeader()}
run('RUNNING');
for (let i = 0; i < 10; i++) event('d' + i, 'SEARCH', { type: 'SEARCH', query: 'drain' + i, results: [] });
await new Promise((r) => setTimeout(r, 1500));
run('COMPLETED');
`,
    );
    const spawnRun = spawnBin(['run', '--data-root', root, '--', process.execPath, producer], {
      env: { VIEWTRACE_DRAIN_TIMEOUT_MS: '3000' },
    });
    const info = JSON.parse(
      (await readFileAsString(join(root, 'service.json'))) ?? '{}',
    ) as { pid: number; port: number };
    assert.ok(Number.isInteger(info.pid));
    await waitFor(() => spawnRun.stdoutSoFar().includes('started'), 20_000, 50);
    const drainRunId = /run (run-[a-z0-9-]+) started/.exec(spawnRun.stdoutSoFar())?.[1];
    assert.ok(drainRunId !== undefined);
    await waitFor(async () => {
      const run = await latestRun(root, (r) => r.runId === drainRunId);
      return (run?.eventCount ?? 0) >= 5;
    }, 30_000);
    process.kill(info.pid, 'SIGKILL');
    await waitForPidExit(info.pid);

    const result = await spawnRun.done;
    assert.equal(result.code, 4, `unconfirmed collection must not exit 0: ${result.stdout}\n${result.stderr}`);
    assert.ok(result.stderr.includes('unconfirmed') || result.stderr.includes('WARNING'), result.stderr);

    // Restart the collector: the spool drains completely from byte 0.
    await upService(root);
    await waitFor(async () => {
      const run = await latestRun(root, (r) => r.runId === drainRunId);
      return run?.completeness === 'COMPLETE' && run.eventCount === 10;
    }, 30_000);
    const target = await latestRun(root, (r) => r.runId === drainRunId);
    assert.equal(target?.completeness, 'COMPLETE', 'post-restart drain must lose nothing');
  });

  it('refuses to run a producer without execute permission (POSIX)', async () => {
    if (isWindows) return; // permission model differs; covered by M5 real-env gate
    const producer = await writeProducer(
      producers,
      'noexec.mjs',
      `#!/usr/bin/env node\nprocess.exit(0);\n`,
    );
    await chmod(producer, 0o644);
    const result = await runBin(['run', '--data-root', root, '--', producer]);
    assert.equal(result.code, 127, result.stderr);
  });
});
