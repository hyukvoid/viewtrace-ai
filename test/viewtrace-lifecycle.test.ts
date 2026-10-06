/**
 * M1 collector lifecycle: up readiness, idempotent and concurrent up,
 * status stale-vs-running discrimination, down safety (never kills by pid),
 * abrupt-crash recovery via cursor resume, repeated cycles, leaked
 * process count 0.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  downService,
  parseRunJson,
  pidAlive,
  producerHeader,
  readServiceFile,
  runBin,
  spawnBin,
  upService,
  waitFor,
  waitForPidExit,
  writeProducer,
} from './helpers/m1.js';
import { viewtraceFixture } from './helpers/viewtrace.js';

describe('viewtrace up/status/down lifecycle', () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'vt-life-'));
  });

  after(async () => {
    await downService(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('starts ready, is idempotent, and status tells running from nothing', async () => {
    const emptyStatus = await runBin(['status', '--data-root', root]);
    assert.equal(emptyStatus.code, 1);
    assert.ok(emptyStatus.stdout.includes('not running'));

    const first = await upService(root);
    assert.ok(first.stdout.includes('collector up'));

    const info = await readServiceFile(root);
    assert.notEqual(info, null);

    const again = await runBin(['up', '--data-root', root]);
    assert.equal(again.code, 0);
    assert.ok(again.stdout.includes('already running'));

    const status = await runBin(['status', '--data-root', root]);
    assert.equal(status.code, 0);
    assert.ok(status.stdout.includes(`pid ${info?.pid}`));

    const statusJson = await runBin(['status', '--data-root', root, '--json']);
    assert.equal(statusJson.code, 0);
    const parsed = JSON.parse(statusJson.stdout) as { running: boolean; pid: number };
    assert.equal(parsed.running, true);
    assert.equal(parsed.pid, info?.pid);
  });

  it('concurrent up commands converge on exactly one service', async () => {
    const results = await Promise.all([
      runBin(['up', '--data-root', root], { timeoutMs: 60_000 }),
      runBin(['up', '--data-root', root], { timeoutMs: 60_000 }),
      runBin(['up', '--data-root', root], { timeoutMs: 60_000 }),
    ]);
    for (const r of results) {
      assert.equal(r.code, 0, r.stderr);
    }
    const info = await readServiceFile(root);
    assert.notEqual(info, null);
    assert.ok(pidAlive(info?.pid ?? -1), 'exactly one live service pid must be recorded');
    await waitFor(async () => {
      const status = await runBin(['status', '--data-root', root, '--json']);
      if (status.code !== 0) return false;
      const parsed = JSON.parse(status.stdout) as { pid: number };
      return parsed.pid === info?.pid;
    });
  });

  it('status distinguishes a dead pid from a running service (no blind kills)', async () => {
    // Fabricate a stale service.json pointing at a dead pid and dead port.
    const stale = {
      protocolVersion: 1,
      pid: 999999,
      bootId: 'deadbeefdeadbeef',
      port: 1,
      token: 't'.repeat(64),
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    await writeFile(join(root, 'service.json'), JSON.stringify(stale), 'utf8');
    const status = await runBin(['status', '--data-root', root]);
    assert.equal(status.code, 1);
    assert.ok(status.stdout.includes('stale'), `must explain staleness: ${status.stdout}`);

    // `up` must recover from the stale state without killing pid 999999.
    const up = await upService(root);
    assert.ok(up.stdout.includes('collector up'));
    const info = await readServiceFile(root);
    assert.notEqual(info, null);
    assert.notEqual(info?.pid, 999999);
  });

  it('repairs a service.json whose identity does not match the live listener', async () => {
    const info = await readServiceFile(root);
    assert.notEqual(info, null);
    // Corrupt the pid to a live-but-wrong process (this test runner).
    await writeFile(
      join(root, 'service.json'),
      JSON.stringify({ ...info, pid: process.pid, bootId: 'wrongboot!' }),
      'utf8',
    );
    const up = await runBin(['up', '--data-root', root]);
    assert.equal(up.code, 0, `up must reconcile with the healthy listener: ${up.stderr}`);
    const repaired = await readServiceFile(root);
    assert.notEqual(repaired, null);
    assert.equal(repaired?.pid, info?.pid, 'identity must be restored from live health data');
    assert.equal(repaired?.bootId, info?.bootId);
  });

  it('down is idempotent, cleans stale files, and preserves committed runs', async () => {
    const ingest = await runBin(['ingest', viewtraceFixture('research-normal.jsonl'), '--data-root', root]);
    assert.equal(ingest.code, 0, ingest.stderr);

    await downService(root);
    const info = await readServiceFile(root);
    assert.equal(info, null, 'service.json removed after down');

    const downAgain = await runBin(['down', '--data-root', root]);
    assert.equal(downAgain.code, 0);
    assert.ok(downAgain.stdout.includes('nothing to stop'));

    const runs = await runBin(['runs', '--data-root', root]);
    assert.ok(runs.stdout.includes('research-normal-001'), 'committed runs survive down');

    // up → run → down → up keeps data intact (completion-condition flow).
    await upService(root);
    const runsAfterUp = await runBin(['runs', '--data-root', root]);
    assert.ok(runsAfterUp.stdout.includes('research-normal-001'));
  });

  it('recovers from SIGKILL: restart resumes the stream cursor with 0 loss', async () => {
    const producer = await writeProducer(join(root, 'producers'), 'slow.mjs', `${producerHeader()}
run('RUNNING');
event('e1', 'SEARCH', { type: 'SEARCH', query: 'cursor-recovery', results: [] });
await new Promise((r) => setTimeout(r, 4000));
event('e2', 'READ', { type: 'READ', sourceId: 'src-e2', outcome: 'SUCCESS' });
run('COMPLETED');
`);
    const runSpawn = spawnBin(['run', '--data-root', root, '--json', '--', process.execPath, producer], {
      env: { VIEWTRACE_DRAIN_TIMEOUT_MS: '20000' },
    });
    // Wait until the first event is committed, then SIGKILL the service.
    await waitFor(async () => {
      const status = await runBin(['status', '--data-root', root, '--json']);
      if (status.code !== 0) return false;
      const parsed = JSON.parse(status.stdout) as { runs?: { eventCount: number }[] };
      return (parsed.runs ?? []).some((r) => r.eventCount >= 1);
    }, 30_000);
    const info = await readServiceFile(root);
    if (info === null) assert.fail('service.json missing');
    process.kill(info.pid, 'SIGKILL');
    await waitForPidExit(info.pid);

    // Restart: the spool drains from the committed cursor.
    await upService(root);
    const result = await runSpawn.done;
    assert.equal(result.code, 0, `wrapper must finish cleanly after service restart: ${result.stderr}\n${result.stdout}`);
    const summary = parseRunJson(result.stdout).summary;
    assert.equal(summary?.['completeness'], 'COMPLETE');
    assert.equal(summary?.['eventsAccepted'], 2);
    assert.equal(summary?.['losses'], 0);

    const runsJson = await runBin(['runs', '--data-root', root, '--json']);
    const runs = JSON.parse(runsJson.stdout) as { runId: string; lifecycle: string; completeness: string; eventCount: number }[];
    const liveRun = runs.find((r) => r.runId.startsWith('run-'));
    assert.notEqual(liveRun, undefined);
    assert.equal(liveRun?.lifecycle, 'COMPLETED');
    assert.equal(liveRun?.completeness, 'COMPLETE');
    assert.equal(liveRun?.eventCount, 2);
  });

  it('repeated up/down cycles stay clean (no leaked processes or state files)', async () => {
    for (let i = 0; i < 3; i++) {
      const info = await readServiceFile(root);
      assert.notEqual(info, null);
      await downService(root);
      await waitForPidExit(info?.pid ?? -1);
      assert.equal(await readServiceFile(root), null);
      await upService(root);
    }
    const lockText = await readFile(join(root, 'service.lock'), 'utf8').catch(() => '');
    const lockPid = Number(lockText.trim());
    const info = await readServiceFile(root);
    assert.equal(lockPid, info?.pid, 'lock file must track the live service');
    assert.ok(pidAlive(lockPid));
  });
});
