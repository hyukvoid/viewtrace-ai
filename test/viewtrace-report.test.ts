import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { cpus, totalmem } from 'node:os';
import { startReportServer } from '../src/viewtrace/server.js';
import { ViewTraceStore } from '../src/viewtrace/store.js';
import { ingestFile } from '../src/viewtrace/ingest.js';
import { answerReport } from '../src/viewtrace/report.js';
import { answerHash, ANSWER_HASH_VERSION } from '../src/viewtrace/answer.js';
import { tempDataRoot, viewtraceFixture, makeEvent } from './helpers/viewtrace.js';
import { receipt, request } from './helpers/m2.js';

async function setup() {
  const root = await tempDataRoot('report');
  await ingestFile(viewtraceFixture('answer-multi-turn.jsonl'), {
    dataRoot: root,
  });
  const store = await ViewTraceStore.open({ dataRoot: root });
  const server = await startReportServer(store, {
    port: 0,
    bootId: 'test-boot',
  });
  const headers = { authorization: `Bearer ${server.token}` };
  return { root, store, server, headers };
}

describe('M2 actual report HTTP boundaries', () => {
  it('binds IPv4 loopback; protects every read with token/cookie plus Host, Origin and Fetch Metadata', async () => {
    const { store, server, headers } = await setup();
    try {
      assert.equal(server.boundAddress, '127.0.0.1');
      assert.equal((await request(server.port, '/health', { headers })).json['service'], 'viewtrace-report');
      await assert.rejects(() => request(server.port, '/health', { headers, host: '::1' }));
      for (const path of [
        '/health',
        '/api/runs',
        '/api/runs/receipt-multi',
        '/api/runs/receipt-multi/events',
        '/api/adapters',
        '/api/picker',
        '/api/resolve',
        '/api/receipts/receipt-A1',
      ])
        assert.equal((await request(server.port, path)).status, 401, path);
      for (const extra of [
        { Host: 'attacker.test' },
        { Host: `127.0.0.1:${server.port + 1}` },
        { Origin: 'https://evil.test' },
        { Origin: 'null' },
        { 'Sec-Fetch-Site': 'cross-site' },
      ] as Record<string, string>[]) {
        const res = await request(server.port, '/api/runs', {
          headers: { ...headers, ...extra },
        });
        assert.equal(res.status, 403);
        assert.equal(res.headers['access-control-allow-origin'], undefined);
      }
      assert.equal(
        (
          await request(server.port, '/', {
            headers: { Origin: 'https://evil.test' },
          })
        ).status,
        403,
        'no cookie bootstrap from foreign Origin',
      );
      const page = await request(server.port, '/runs/receipt-multi/answers/A1');
      assert.equal(page.status, 200);
      assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);
      assert.match(String(page.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
      assert.ok(!page.text.includes(server.token));
      const cookie = (page.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
      assert.equal((await request(server.port, '/api/runs', { headers: { cookie } })).status, 200);
      assert.equal(
        (
          await request(server.port, '/api/select', {
            method: 'POST',
            headers: { cookie },
            body: '{"runId":"receipt-multi"}',
          })
        ).status,
        403,
        'browser writes require same Origin',
      );
      assert.equal(
        (
          await request(server.port, '/api/runs', {
            method: 'OPTIONS',
            headers: { ...headers, Origin: 'https://evil.test' },
          })
        ).status,
        403,
      );
    } finally {
      await server.close();
      await store.close();
    }
  });

  it('shares resolver oracle, paginates scope in collector order, preserves revision/UNKNOWN and explicit selection', async () => {
    const { store, server, headers } = await setup();
    try {
      for (let i = 1; i <= 3; i++) {
        const response = await request<{
          receipt: { answerId: string };
          status: string;
        }>(server.port, `/api/resolve?agentId=reference-agent&agentSessionId=session-1&turnId=turn-${i}`, {
          headers,
        });
        assert.equal(response.json.status, 'matched');
        assert.equal(response.json.receipt.answerId, `A${i}`);
        const report = await request<NonNullable<ReturnType<typeof answerReport>>>(
          server.port,
          `/api/runs/receipt-multi/answers/A${i}`,
          { headers },
        );
        assert.equal(report.json.receipt.answerId, `A${i}`);
        assert.equal(report.json.run.lifecycle, 'COMPLETED');
        assert.equal(report.json.evidenceSupport, 'UNKNOWN');
        assert.equal(report.json.scope.eventCount, 2);
        const first = await request<{
          events: { eventId: string }[];
          nextCursor: number;
          revision: string;
        }>(server.port, `/api/runs/receipt-multi/answers/A${i}/events?limit=1`, { headers });
        assert.deepEqual(
          first.json.events.map((e) => e.eventId),
          ['shared'],
        );
        assert.equal(first.json.revision, report.json.revision);
        const second = await request<{
          events: { eventId: string }[];
          nextCursor: null;
        }>(
          server.port,
          `/api/runs/receipt-multi/answers/A${i}/events?limit=1&cursor=${first.json.nextCursor}`,
          { headers },
        );
        assert.deepEqual(
          second.json.events.map((e) => e.eventId),
          [`e${i}`],
        );
        assert.equal(second.json.nextCursor, null);
      }
      const a = store.getReceipt('receipt-A1')!;
      assert.equal(
        (
          await request(server.port, `/api/resolve?answerHash=${a.answerHash}&hashVersion=${a.hashVersion}`, {
            headers,
          })
        ).json['status'],
        'uncertain',
      );
      assert.equal(
        (await request(server.port, '/api/resolve?receiptId=receipt-A1&turnId=turn-2', { headers })).json[
          'status'
        ],
        'mismatch',
      );
      const choice = await request<{
        path: string;
        selectionId: number;
        association: string;
      }>(server.port, '/api/select', {
        method: 'POST',
        headers,
        body: JSON.stringify({ runId: a.runId, receiptId: a.receiptId }),
      });
      assert.equal(choice.json.association, 'explicit-selection');
      assert.match(choice.json.path, /\/answers\/A1\?selection=\d+$/);
      const selected = await request<NonNullable<ReturnType<typeof answerReport>>>(
        server.port,
        `/api/runs/${a.runId}/answers/${a.answerId}?selection=${choice.json.selectionId}`,
        { headers },
      );
      assert.equal(selected.json.association.status, 'explicit-selection');
      assert.equal(selected.json.association.currentAnswerMatch, 'UNKNOWN');
      const old = selected.json.revision;
      await store.appendRecords(
        a.runId,
        [],
        [
          {
            code: 'PARTIAL_SENTINEL',
            message: 'collection loss remains visible',
            severity: 'error',
          },
        ],
        123,
      );
      const changed = await request<NonNullable<ReturnType<typeof answerReport>>>(
        server.port,
        `/api/runs/${a.runId}/answers/${a.answerId}?selection=${choice.json.selectionId}`,
        { headers },
      );
      assert.notEqual(changed.json.revision, old);
      assert.equal(changed.json.diagnosticCount, 1);
      await store.setCompleteness(a.runId, 'PARTIAL');
      assert.equal(
        (
          await request<NonNullable<ReturnType<typeof answerReport>>>(
            server.port,
            `/api/runs/${a.runId}/answers/${a.answerId}`,
            { headers },
          )
        ).json.run.completeness,
        'PARTIAL',
      );
    } finally {
      await server.close();
      await store.close();
    }
  });

  it('rejects traversal, SQL-looking ids, oversize/invalid bodies and cursors; static symlinks and errors expose no paths', async () => {
    const { root, store, server, headers } = await setup();
    try {
      for (const path of [
        '/api/runs/receipt-multi?path=/etc/passwd',
        '/api/runs/x%27%20OR%201%3D1',
        '/api/runs/..%2F..%2Fetc%2Fpasswd',
        '/api/runs/%5Cwindows',
        '/%2e%2e/secret',
        '/app.js/../secret',
        '/%ZZ',
        '/api/runs/receipt-multi/events?limit=101',
        '/api/runs/receipt-multi/events?cursor=-1',
        '/api/runs/receipt-multi/events?limit=2&limit=3',
      ])
        assert.equal((await request(server.port, path, { headers })).status, 400, path);
      assert.equal((await request(server.port, '/api/runs/unknown', { headers })).status, 404);
      assert.equal(
        (
          await request(server.port, '/api/select', {
            method: 'POST',
            headers: { ...headers, 'Content-Length': '5000' },
            body: 'x'.repeat(5000),
          })
        ).status,
        413,
      );
      assert.equal(
        (
          await request(server.port, '/api/select', {
            method: 'POST',
            headers,
            body: '{broken',
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(server.port, '/api/select', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              runId: 'receipt-multi',
              receiptId: 'missing',
            }),
          })
        ).status,
        404,
      );
      assert.equal((await request(server.port, '/api/runs', { method: 'PUT', headers })).status, 405);
      assert.equal(
        (
          await request(server.port, '/api/runs/receipt-multi', {
            method: 'POST',
            headers,
          })
        ).status,
        405,
      );
      assert.equal(
        (
          await request(server.port, '/api/retention', {
            method: 'POST',
            headers,
            body: JSON.stringify({ before: '2026-01-01' }),
          })
        ).status,
        400,
      );
      const assets = join(root, 'assets');
      await mkdir(assets);
      const outside = await tempDataRoot('asset-outside');
      await writeFile(join(outside, 'secret'), 'STATIC_SECRET');
      await symlink(
        join(outside, 'secret'),
        join(assets, 'app.js'),
        process.platform === 'win32' ? 'file' : undefined,
      );
      const unsafe = await startReportServer(store, {
        port: 0,
        bootId: 'unsafe',
        assetRoot: assets,
      });
      try {
        const res = await request(unsafe.port, '/app.js');
        assert.equal(res.status, 500);
        assert.ok(!res.text.includes(outside));
        assert.ok(!res.text.includes('STATIC_SECRET'));
      } finally {
        await unsafe.close();
      }
    } finally {
      await server.close();
      await store.close();
    }
  });

  it('authenticates delete/keep/prune, isolates targets and does not replace a deleted answer with latest', async () => {
    const { store, server, headers } = await setup();
    try {
      const keepPath = '/api/runs/receipt-multi/keep';
      assert.equal(
        (
          await request(server.port, keepPath, {
            method: 'POST',
            body: '{"keep":true}',
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await request(server.port, keepPath, {
            method: 'POST',
            headers,
            body: '{"keep":true}',
          })
        ).status,
        200,
      );
      assert.deepEqual(
        (
          await request(server.port, '/api/retention', {
            method: 'POST',
            headers,
            body: '{"before":"9999-01-01T00:00:00Z"}',
          })
        ).json['deleted'],
        [],
      );
      await store.createRun('unrelated', {
        adapterId: 'a',
        adapterVersion: '1',
      });
      await store.appendRecords('unrelated', [
        receipt({
          runId: 'unrelated',
          receiptId: 'unrelated-receipt',
          answerId: 'other',
          sequence: 1,
        }),
      ]);
      assert.equal(
        (
          await request(server.port, '/api/runs/receipt-multi', {
            method: 'DELETE',
            headers: { ...headers, Origin: 'https://evil.test' },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await request(server.port, '/api/runs/receipt-multi', {
            method: 'DELETE',
            headers,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await request(server.port, '/api/runs/receipt-multi/answers/A1', {
            headers,
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await request(server.port, '/api/resolve?receiptId=receipt-A1', {
            headers,
          })
        ).json['status'],
        'missing',
      );
      assert.ok(store.getReceipt('unrelated-receipt'));
    } finally {
      await server.close();
      await store.close();
    }
  });
});

describe('M2 10k-event actual HTTP latency', () => {
  it('warmup + 20 samples per bounded detail/event endpoint have p95 <= 2 seconds and exact counts', async () => {
    const root = await tempDataRoot('api-perf');
    const store = await ViewTraceStore.open({ dataRoot: root });
    await store.createRun('run-answers', {
      adapterId: 'reference',
      adapterVersion: '1',
    });
    const records = Array.from({ length: 10000 }, (_, i) =>
      makeEvent({ eventId: `e${i}`, runId: 'run-answers', sequence: i + 1 }),
    );
    await store.appendRecords('run-answers', [
      ...records,
      receipt({ sequence: 10001, eventIds: records.map((e) => e.eventId) }),
    ]);
    const server = await startReportServer(store, { port: 0, bootId: 'perf' });
    const headers = { authorization: `Bearer ${server.token}` };
    try {
      const measurements: Record<string, number> = {};
      for (const path of [
        '/api/runs/run-answers',
        '/api/runs/run-answers/answers/a1',
        '/api/runs/run-answers/events?limit=100',
        '/api/runs/run-answers/answers/a1/events?limit=100',
      ]) {
        await request(server.port, path, { headers });
        const times: number[] = [];
        for (let i = 0; i < 20; i++) {
          const start = performance.now();
          const res = await request(server.port, path, { headers });
          times.push(performance.now() - start);
          assert.equal(res.status, 200);
          assert.ok(Buffer.byteLength(res.text) < 1024 * 1024);
        }
        const p95 = times.sort((a, b) => a - b)[18]!;
        measurements[path] = p95;
        assert.ok(p95 <= 2000, `${path}: p95=${p95}`);
      }
      const detail = await request<NonNullable<ReturnType<typeof answerReport>>>(
        server.port,
        '/api/runs/run-answers/answers/a1',
        { headers },
      );
      assert.equal(detail.json.scope.eventCount, 10000);
      assert.equal(detail.json.run.eventCount, 10000);
      process.stdout.write(
        JSON.stringify({
          M2_API_PERF: {
            node: process.version,
            platform: process.platform,
            cpus: cpus().length,
            totalmem: totalmem(),
            samples: 20,
            p95ms: measurements,
          },
        }) + '\n',
      );
    } finally {
      await server.close();
      await store.close();
    }
  });
});
