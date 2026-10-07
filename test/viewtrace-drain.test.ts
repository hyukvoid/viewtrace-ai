/** Public CLI drain confirmation over the actual authenticated control API. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { LiveCollector } from '../src/viewtrace/collector.js';
import type { LiveRunSnapshot } from '../src/viewtrace/collector.js';
import { startControlServer } from '../src/viewtrace/control.js';
import { SERVICE_PROTOCOL_VERSION, writeServiceFile } from '../src/viewtrace/servestate.js';
import { ViewTraceStore } from '../src/viewtrace/store.js';
import { parseRunJson, runBin } from './helpers/m1.js';
import { tempDataRoot } from './helpers/viewtrace.js';

describe('viewtrace run: drain confirmation consistency', () => {
  for (const completeness of ['COMPLETE', 'PARTIAL'] as const) {
    it(`waits for terminal, fully drained ${completeness} instead of trusting finalized alone`, async () => {
      const root = await tempDataRoot('drain');
      const store = await ViewTraceStore.open({ dataRoot: root });
      const collector = new LiveCollector(store, root);
      const bootId = 'drain-regression';
      let requests = 0;
      // Replay the contradictory snapshot seen in Windows CI, then other
      // unfinished states. Only the last response is confirmation. Every
      // response otherwise comes from the real spool/SQLite collector.
      const unfinished: Partial<LiveRunSnapshot>[] = [
        { completeness: 'UNKNOWN' },
        { pendingBytes: 1 },
        { lifecycle: 'RUNNING' },
        { finalized: false },
      ];
      const server = await startControlServer(async ({ pathname }) => {
        if (pathname === '/health') {
          return { status: 200, body: {
            ok: true, service: 'viewtrace-collector', protocolVersion: SERVICE_PROTOCOL_VERSION,
            pid: process.pid, bootId,
          } };
        }
        if (pathname.startsWith('/runs/')) {
          await collector.tick();
          const runId = pathname.slice('/runs/'.length);
          const run = (await collector.snapshot()).find((r) => r.runId === runId);
          assert.ok(run);
          assert.equal(run.completeness, completeness);
          const override = unfinished[requests++];
          return { status: 200, body: {
            run: { ...run, ...override },
            diagnostics: store.listDiagnostics(runId), duplicates: store.listDuplicates(runId),
          } };
        }
        return { status: 404, body: {} };
      });
      try {
        await writeServiceFile(root, {
          protocolVersion: SERVICE_PROTOCOL_VERSION, pid: process.pid, bootId,
          port: server.port, token: server.token, startedAt: new Date().toISOString(),
        });
        const producer = completeness === 'PARTIAL'
          ? "process.stdout.write('{ broken\\n')"
          : 'process.exit(0)';
        const result = await runBin(['run', '--data-root', root, '--json', '--', process.execPath, '-e', producer]);
        assert.equal(requests, unfinished.length + 1, result.stdout + result.stderr);
        assert.equal(result.code, completeness === 'COMPLETE' ? 0 : 4, result.stdout + result.stderr);
        const summary = parseRunJson(result.stdout).summary;
        assert.ok(summary);
        assert.deepEqual(summary['child'], { exitCode: 0, signal: null });
        assert.equal(summary['lifecycle'], 'COMPLETED');
        assert.equal(summary['completeness'], completeness);
        assert.equal(summary['drained'], true);
        assert.equal(summary['losses'], completeness === 'PARTIAL' ? 1 : 0);
        assert.equal(summary['eventsAccepted'], 0);
      } finally {
        await server.close();
        await store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
