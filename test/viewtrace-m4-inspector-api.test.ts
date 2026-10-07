import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ViewTraceStore } from '../src/viewtrace/store.js';
import { ingestFile } from '../src/viewtrace/ingest.js';
import { startReportServer } from '../src/viewtrace/server.js';
import { tempDataRoot, viewtraceFixture } from './helpers/viewtrace.js';
import { request } from './helpers/m2.js';
import type { ViewTraceEvent } from '../src/viewtrace/types.js';

describe('M4 inspector HTTP scope boundary', () => {
  it('looks up only the selected answer own/shared events with the exact report revision', async () => {
    const root = await tempDataRoot('inspector-api');
    await ingestFile(viewtraceFixture('answer-multi-turn.jsonl'), { dataRoot: root });
    const store = await ViewTraceStore.open({ dataRoot: root });
    const server = await startReportServer(store, { port: 0, bootId: 'inspector' });
    const headers = { authorization: `Bearer ${server.token}` };
    const target = '/api/runs/receipt-multi/answers/A1';
    try {
      const detail = await request<{ revision: string }>(server.port, target, { headers });
      for (const eventId of ['e1', 'shared']) {
        const lookup = await request<{ events: ViewTraceEvent[]; revision: string; nextCursor: null }>(
          server.port, `${target}/events?eventId=${eventId}`, { headers },
        );
        assert.equal(lookup.status, 200);
        assert.deepEqual(lookup.json.events.map((e) => e.eventId), [eventId]);
        assert.equal(lookup.json.revision, detail.json.revision);
        assert.equal(lookup.json.nextCursor, null);
      }
      for (const eventId of ['e2', 'missing']) {
        assert.equal((await request(server.port, `${target}/events?eventId=${eventId}`, { headers })).status, 404);
      }
      assert.equal((await request(server.port, `${target}/events?eventId=e1`)).status, 401);
      assert.equal((await request(server.port, `${target}/events?eventId=e1`, {
        headers: { ...headers, Origin: 'https://evil.invalid' },
      })).status, 403);
      for (const query of ['eventId=', 'eventId=e1&eventId=e2', 'eventId=..%2Fsecret', "eventId=x%27%20OR%201%3D1"]) {
        assert.equal((await request(server.port, `${target}/events?${query}`, { headers })).status, 400);
      }
      assert.equal((await request(server.port, `${target}?eventId=e1`, { headers })).status, 400);
    } finally {
      await server.close();
      store.close();
    }
  });
});
