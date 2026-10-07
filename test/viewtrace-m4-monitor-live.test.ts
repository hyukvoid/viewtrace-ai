import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnBin, waitFor, upService, downService } from './helpers/m1.js';
import { ViewTraceStore } from '../src/viewtrace/store.js';
import { tempDataRoot, makeEvent, makeRunRecord } from './helpers/viewtrace.js';
import { receipt } from './helpers/m2.js';

describe('M4 public monitor with real incremental input', () => {
  it('grows and collapses the pinned answer tree while a later receipt cannot switch it', { timeout: 45000 }, async () => {
    const root = await tempDataRoot('monitor-live');
    // The public wrapper assigns run identity to its real producer.
    const runId = 'run-producer-placeholder';
    const event = (id: string) => makeEvent({ runId, eventId: id });
    const firstSearch = makeEvent({
      runId, eventId: 'search-1',
      payload: { type: 'SEARCH', query: 'public monitor \u009b2J\u009downed-title', results: [] },
    });
    const firstClaim = makeEvent({
      runId, eventId: 'claim-1', type: 'CLAIM',
      provenance: { category: 'AGENT_REPORTED' },
      payload: { type: 'CLAIM', text: 'Latency is low.' },
    });
    const secondClaim = makeEvent({
      runId, eventId: 'claim-2', type: 'CLAIM',
      provenance: { category: 'AGENT_REPORTED' },
      payload: { type: 'CLAIM', text: 'Latency is high.' },
    });
    const contradiction = makeEvent({
      runId, eventId: 'conflict-1', type: 'CONTRADICTION',
      payload: {
        type: 'CONTRADICTION', description: 'Unresolved latency measurements.',
        conflictingEventIds: ['claim-1', 'claim-2'], conditions: ['workload=same'],
      },
    });
    const phases = [[
      makeRunRecord({ runId, lifecycle: 'RUNNING' }), firstSearch, firstClaim,
      receipt({
        runId, receiptId: 'receipt-monitor-1', answerId: 'answer-monitor-1',
        timestamp: '2026-10-07T00:00:00Z',
        sequence: 4, receivedAt: '2026-10-07T00:00:00Z',
        eventIds: ['search-1', 'claim-1', 'claim-2', 'conflict-1', 'search-2'],
      }),
    ], [secondClaim, contradiction], [
      event('search-2'),
      receipt({
        runId, receiptId: 'receipt-monitor-2', answerId: 'answer-monitor-2',
        timestamp: '2026-10-07T00:00:10Z', eventIds: [],
        sequence: 8, receivedAt: '2026-10-07T00:00:10Z',
        answer: 'OTHER_TURN_MONITOR_SENTINEL',
      }),
      makeRunRecord({ runId, lifecycle: 'COMPLETED' }),
    ]].map((phase) => phase.map(({ sequence: _sequence, receivedAt: _receivedAt, ...raw }) => raw));
    const producer = join(root, 'live-producer.mjs');
    const identityFile = join(root, 'run-id');
    const nextPhase2 = join(root, 'next-phase2');
    const nextPhase3 = join(root, 'next-phase3');
    await writeFile(producer, `
import { access, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const phases = ${JSON.stringify(phases)};
const gates = [null, ${JSON.stringify(nextPhase2)}, ${JSON.stringify(nextPhase3)}];
await writeFile(${JSON.stringify(identityFile)}, process.env.VIEWTRACE_RUN_ID);
for (let index = 0; index < phases.length; index++) {
  if (gates[index]) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try { await access(gates[index]); break; } catch { await delay(20); }
    }
    if (Date.now() >= deadline) throw new Error('phase gate timeout');
  }
  for (const raw of phases[index]) {
    process.stdout.write(JSON.stringify({ ...raw, runId: process.env.VIEWTRACE_RUN_ID }) + '\\n');
  }
}
`);
    await upService(root);
    const capture = spawnBin(['run', '--data-root', root, '--', process.execPath, producer]);
    let monitor: ReturnType<typeof spawnBin> | undefined;
    try {
      await waitFor(async () => {
        const assigned = await readFile(identityFile, 'utf8');
        const store = await ViewTraceStore.openQuery(root);
        if (!store) return false;
        try { return store.getAnswer(assigned, 'answer-monitor-1') !== null; }
        finally { store.close(); }
      }, 15000);
      const assignedRunId = await readFile(identityFile, 'utf8');
      monitor = spawnBin([
        'monitor', assignedRunId, '--interval', '30', '--max-wait', '30000', '--data-root', root,
      ]);
      const liveMonitor = monitor;
      await waitFor(() => liveMonitor.stdoutSoFar().includes('exploration tree'), 15000);
      assert.match(monitor.stdoutSoFar(), /answer answer-monitor-1/);
      await writeFile(nextPhase2, 'continue');
      await waitFor(() => liveMonitor.stdoutSoFar().includes('rail CONFLICT'), 15000);
      const middle = monitor.stdoutSoFar();
      assert.match(middle, /branch node-branch-1-search-1 collapsed at 4 events/);
      assert.match(middle, /rail CONFLICT conflict-conflict-1/);
      assert.match(middle, /unresolved/);
      await writeFile(nextPhase3, 'continue');
      const captured = await capture.done;
      assert.equal(captured.code, 0, captured.stderr);
      const result = await monitor.done;
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /node-branch-2-search-2/);
      assert.match(result.stdout, /still monitoring answer-monitor-1/);
      assert.ok(!result.stdout.includes('OTHER_TURN_MONITOR_SENTINEL'));
      assert.equal((result.stdout.match(/exploration tree \[run/g) ?? []).length, 1);
      assert.equal((result.stdout.match(/rail CONFLICT conflict-conflict-1/g) ?? []).length, 1);
      assert.match(result.stdout, /COMPLETED \/ completeness=COMPLETE events=5/);
      assert.match(result.stdout, /terminal and stable/);
      assert.ok(!/[\u001b\u0007\u009b\u009d]/.test(result.stdout));
    } finally {
      if (monitor) {
        if (monitor.child.exitCode === null && monitor.child.signalCode === null) monitor.child.kill('SIGKILL');
        await monitor.done;
      }
      if (capture.child.exitCode === null && capture.child.signalCode === null) capture.child.kill('SIGTERM');
      await capture.done;
      await downService(root);
    }
  });
});
