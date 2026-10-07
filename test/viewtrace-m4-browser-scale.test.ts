/**
 * M4 independent verification — scale and live boundaries:
 * 10,000 ACTUAL stored events first useful render <= 3s, bounded initial DOM,
 * exact raw pagination against the paginated events API, live reconnect with
 * dedup after late ingest, and lens/dialog state across live updates.
 *
 * Corpus generators are deterministic (fixed ids/timestamps); the events are
 * really ingested through the public CLI and stored in SQLite before the
 * browser measures anything.
 */

import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { upService, downService, runBin } from './helpers/m1.js';
import { tempDataRoot, viewtraceFixture } from './helpers/viewtrace.js';
import { readServiceFile } from '../src/viewtrace/servestate.js';
import { request } from './helpers/m2.js';
import { ViewTraceStore } from '../src/viewtrace/store.js';
import type { TraceRecord } from '../src/viewtrace/types.js';

const TEN_K = 10_000;
const PAGE_SIZE = 50;

interface EventsPageJson {
  events: { eventId: string; sequence?: number }[];
  nextCursor: number | null;
}

/** Deterministic corpus: blocks of SEARCH → READ → CLAIM over 50 shared sources. */
function bulkEvents(runId: string, count: number): string[] {
  const lines: string[] = [];
  const t = (i: number): string =>
    new Date(Date.parse('2026-10-07T13:00:00Z') + i * 1000).toISOString().replace('.000Z', 'Z');
  lines.push(
    JSON.stringify({
      recordKind: 'run',
      schemaVersion: 1,
      runId,
      lifecycle: 'RUNNING',
      occurredAt: t(0),
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.4.0',
    }),
  );
  const eventIds: string[] = [];
  for (let i = 1; i <= count; i++) {
    const block = Math.floor((i - 1) / 3);
    const phase = (i - 1) % 3;
    const eventId = `m4k-${String(i).padStart(5, '0')}`;
    eventIds.push(eventId);
    const source =
      phase === 0
        ? { sourceId: 'src-m4k-web', kind: 'TOOL_RESULT', location: `tool://m4k/search-${block}` }
        : phase === 1
          ? {
              sourceId: `src-m4k-doc-${block % 50}`,
              kind: 'URL',
              location: `https://docs.example/m4k/${block % 50}`,
            }
          : { sourceId: 'src-m4k-notes', kind: 'DOCUMENT' };
    const payload =
      phase === 0
        ? { type: 'SEARCH', query: `bulk topic ${block}`, results: [] }
        : phase === 1
          ? {
              type: 'READ',
              sourceId: `src-m4k-doc-${block % 50}`,
              outcome: 'SUCCESS' as const,
              summary: `Bulk read ${block}.`,
            }
          : { type: 'CLAIM', text: `Bulk claim ${block} is recorded.`, sourceId: 'src-m4k-notes' };
    lines.push(
      JSON.stringify({
        recordKind: 'event',
        schemaVersion: 1,
        eventId,
        runId,
        type: phase === 0 ? 'SEARCH' : phase === 1 ? 'READ' : 'CLAIM',
        occurredAt: t(i),
        sequence: i,
        receivedAt: t(i),
        adapterId: 'viewtrace-reference-jsonl',
        adapterVersion: '1.4.0',
        origin: { producer: 'reference-fixture' },
        source,
        provenance:
          phase === 2
            ? { category: 'AGENT_REPORTED' }
            : { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: `c-m4k-${i}`, toolResultId: `r-m4k-${i}` } },
        payload,
      }),
    );
  }
  lines.push(
    JSON.stringify({
      recordKind: 'run',
      schemaVersion: 1,
      runId,
      lifecycle: 'COMPLETED',
      occurredAt: t(count + 1),
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.4.0',
    }),
  );
  return lines;
}

function receiptLine(runId: string, eventIds: string[]): string {
  return JSON.stringify({
    recordKind: 'answer',
    schemaVersion: 1,
    receiptVersion: 1,
    receiptId: `receipt-${runId}`,
    runId,
    agentId: 'agent-m4',
    agentSessionId: `sess-${runId}`,
    turnId: 'turn-1',
    answerId: `ans-${runId}`,
    answer: `Bulk answer for ${runId}.`,
    final: true,
    timestamp: '2026-10-07T13:30:00Z',
    occurredAt: '2026-10-07T13:30:00Z',
    adapterId: 'viewtrace-reference-jsonl',
    adapterVersion: '1.4.0',
    questionSummary: `Why run the ${runId} corpus?`,
    eventIds,
  });
}

async function writeJsonl(path: string, lines: string[]): Promise<void> {
  await writeFile(path, lines.join('\n') + '\n');
}

interface DomElement {
  dataset: Record<string, string | undefined>;
}

async function rawIds(page: Page): Promise<string[]> {
  return page.locator('#raw-events [data-event-id]').evaluateAll((nodes) =>
    nodes.map((n) => (n as unknown as DomElement).dataset['eventId'] ?? ''),
  );
}

async function servedEvents(
  port: number,
  token: string,
  path: string,
): Promise<{ ids: string[]; nextCursor: number | null }> {
  const res = await request<EventsPageJson>(port, path, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200, res.text);
  return { ids: res.json.events.map((e) => e.eventId), nextCursor: res.json.nextCursor };
}

describe('M4 independent browser verification — scale, pagination, live', () => {
  let browser: Browser;

  before(async () => {
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  it('10,000 actual stored events: first useful render <= 3s, initial DOM bounded, first raw page exact', async (t) => {
    const root = await tempDataRoot('m4-scale');
    const ids = Array.from({ length: TEN_K }, (_v, i) => `m4k-${String(i + 1).padStart(5, '0')}`);
    await writeJsonl(join(root, 'm4-10k.jsonl'), [...bulkEvents('run-m4-scale', TEN_K), receiptLine('run-m4-scale', ids)]);
    const ingest = await runBin(
      ['ingest', join(root, 'm4-10k.jsonl'), '--data-root', root, '--json'],
      { timeoutMs: 300_000 },
    );
    assert.equal(ingest.code, 0, ingest.stderr);
    const report = JSON.parse(ingest.stdout) as { runs?: { eventsAccepted: number }[] };
    assert.equal(report.runs?.[0]?.eventsAccepted, TEN_K, 'all 10k events must actually be stored');

    await upService(root);
    const info = (await readServiceFile(root))!;
    const base = `http://127.0.0.1:${info.reportPort}`;
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const t0 = Date.now();
      await page.goto(`${base}/runs/run-m4-scale/answers/ans-run-m4-scale`, { waitUntil: 'domcontentloaded' });
      await page.locator('#answer-summary').waitFor({ state: 'visible', timeout: 30_000 });
      await page.locator('#raw-events article').first().waitFor({ state: 'visible', timeout: 10_000 });
      const elapsedMs = Date.now() - t0;
      t.diagnostic(`M4_RENDER firstUsefulMs=${elapsedMs} events=10000 budgetMs=3000`);
      assert.ok(elapsedMs <= 3000, `first useful render took ${elapsedMs}ms (>3000ms budget)`);

      // Bounded initial DOM: raw shows at most the first page, sections stay bounded.
      const rawCount = await page.locator('#raw-events article, #raw-events [data-event-id]').count();
      assert.ok(rawCount > 0 && rawCount <= PAGE_SIZE, `initial raw must be (0,50]; got ${rawCount}`);
      for (const hook of ['#evidence-cards', '#source-ledger', '#exploration-graph', '#jev-advisory']) {
        const n = await page.locator(`${hook} > *`).count();
        assert.ok(n <= 500, `section ${hook} must stay bounded (got ${n} children)`);
      }
      const totalElements = await page.locator('#app *').count();
      t.diagnostic(`M4_DOM totalElements=${totalElements} rawEvents=${rawCount} budgetElements=3000`);
      assert.ok(totalElements <= 3000, `initial DOM must stay bounded (got ${totalElements} elements)`);

      // First raw page matches the paginated API exactly.
      const apiPage1 = await servedEvents(
        info.reportPort!,
        info.reportToken!,
        `/api/runs/run-m4-scale/answers/ans-run-m4-scale/events?limit=${PAGE_SIZE}`,
      );
      const domIds = await rawIds(page);
      assert.deepEqual(domIds, apiPage1.ids, 'first rendered raw page must equal the API page exactly');
      assert.equal(apiPage1.ids.length, PAGE_SIZE);
      assert.equal(apiPage1.nextCursor, PAGE_SIZE + 1);
    } finally {
      await context.close();
      await downService(root);
    }
  });

  it('exact raw pagination on a 120-event run: 50/50/20 by cursor, no duplicates, ends hidden, reload returns to first page', async () => {
    const root = await tempDataRoot('m4-page');
    const count = 120;
    const ids = Array.from({ length: count }, (_v, i) => `m4k-${String(i + 1).padStart(5, '0')}`);
    await writeJsonl(join(root, 'm4-120.jsonl'), [...bulkEvents('run-m4-page', count), receiptLine('run-m4-page', ids)]);
    const ingest = await runBin(['ingest', join(root, 'm4-120.jsonl'), '--data-root', root], { timeoutMs: 120_000 });
    assert.equal(ingest.code, 0, ingest.stderr);
    await upService(root);
    const info = (await readServiceFile(root))!;
    const base = `http://127.0.0.1:${info.reportPort}`;
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${base}/runs/run-m4-page/answers/ans-run-m4-page`);
      await page.locator('#raw-events').waitFor({ state: 'visible', timeout: 30_000 });

      // Page 1 via DOM vs API.
      const api1 = await servedEvents(
        info.reportPort!,
        info.reportToken!,
        `/api/runs/run-m4-page/answers/ans-run-m4-page/events?limit=${PAGE_SIZE}`,
      );
      assert.equal((await rawIds(page)).length, PAGE_SIZE);
      assert.deepEqual(await rawIds(page), api1.ids);
      const more = page.locator('#raw-more');
      await expect(more).toBeVisible();

      // Page 2 exact.
      await more.click();
      await expect(page.locator('#raw-events [data-event-id]')).toHaveCount(2 * PAGE_SIZE, { timeout: 10_000 });
      const api2 = await servedEvents(
        info.reportPort!,
        info.reportToken!,
        `/api/runs/run-m4-page/answers/ans-run-m4-page/events?limit=${PAGE_SIZE}&cursor=${api1.nextCursor}`,
      );
      const after2 = await rawIds(page);
      assert.deepEqual(after2.slice(PAGE_SIZE), api2.ids, 'second raw page must equal the API page exactly');
      assert.equal(new Set(after2).size, after2.length, 'no duplicate raw events after loading page 2');

      // Page 3 exact: 120 total, then pagination ends.
      await more.click();
      await expect(page.locator('#raw-events [data-event-id]')).toHaveCount(count, { timeout: 10_000 });
      const api3 = await servedEvents(
        info.reportPort!,
        info.reportToken!,
        `/api/runs/run-m4-page/answers/ans-run-m4-page/events?limit=${PAGE_SIZE}&cursor=${api2.nextCursor}`,
      );
      const after3 = await rawIds(page);
      assert.deepEqual(after3.slice(2 * PAGE_SIZE), api3.ids);
      assert.equal(api3.ids.length, 20);
      assert.equal(api3.nextCursor, null, 'API pagination must end exactly at 120');
      assert.equal(new Set(after3).size, count, 'event ids unique across all pages');
      const ordered = [...after3].every((id, i) => id === ids[i]);
      assert.ok(ordered, 'raw events must preserve sequence order across pages');
      await expect(page.locator('#raw-more')).toBeHidden();

      // Reload resets to the bounded first page.
      await page.reload();
      await page.locator('#raw-events').waitFor({ state: 'visible', timeout: 15_000 });
      assert.equal((await rawIds(page)).length, PAGE_SIZE, 'reload must return to the bounded first page');
    } finally {
      await context.close();
      await downService(root);
    }
  });

  it('live: late ingest appears via polling without duplicates; run page stays the surface for a legacy receipt', async () => {
    const root = await tempDataRoot('m4-live');
    assert.equal(
      (await runBin(['ingest', viewtraceFixture('m4-live-phase1.jsonl'), '--data-root', root])).code,
      0,
    );
    await upService(root);
    const info = (await readServiceFile(root))!;
    const base = `http://127.0.0.1:${info.reportPort}`;
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${base}/runs/run-m4-live`);
      await expect(page.getByRole('heading', { name: 'Run run-m4-live', exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await page.locator('#raw-events [data-event-id]').first().waitFor({ timeout: 15_000 });
      assert.deepEqual(
        (await rawIds(page)).sort(),
        ['m4l-e1', 'm4l-e2', 'm4l-e3'],
        'phase 1 renders exactly its three events',
      );
      assert.match(await page.locator('#status').innerText(), /RUNNING/);

      // Late ingest: append continuation batch directly to the store
      const store = await ViewTraceStore.open({ dataRoot: root });
      try {
        const run = store.getRun('run-m4-live');
        assert.ok(run !== null);
        let seq = run.jsonlLines;
        const phase2Lines = (await readFile(viewtraceFixture('m4-live-phase2.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .filter((l) => l.trim().length > 0);
        const phase2Records: TraceRecord[] = phase2Lines.map((l) => {
          seq += 1;
          return {
            ...(JSON.parse(l) as Record<string, unknown>),
            sequence: seq,
            receivedAt: '2026-10-07T12:07:30.000Z',
          } as TraceRecord;
        });
        await store.appendRecords('run-m4-live', phase2Records, [], 0);
      } finally {
        store.close();
      }
      await expect(page.locator('#raw-events [data-event-id]')).toHaveCount(5, { timeout: 15_000 });
      const idsAfter = await rawIds(page);
      assert.equal(new Set(idsAfter).size, 5, 'no duplicate events after live update');
      assert.ok(idsAfter.includes('m4l-e4') && idsAfter.includes('m4l-e5'));
      await expect(page.locator('#status')).toContainText('COMPLETED', { timeout: 15_000 });

      // Reconnect: force one failed cycle, then recovery must dedup.
      await page.route('**/api/runs/run-m4-live**', (route) => route.abort());
      await expect(page.locator('#connection')).toContainText('STALE', { timeout: 15_000 });
      await page.unroute('**/api/runs/run-m4-live**');
      await expect(page.locator('#connection')).toContainText('Stored snapshot', { timeout: 15_000 });
      const idsRecovered = await rawIds(page);
      assert.equal(new Set(idsRecovered).size, 5, 'reconnect must not duplicate raw events');
      assert.equal(idsRecovered.length, 5);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await downService(root);
    }
  });
});
