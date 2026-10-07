import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ViewTraceStore } from '../src/viewtrace/store.js';
import { runBin, upService, downService } from './helpers/m1.js';
import { tempDataRoot, viewtraceFixture, makeEvent, makeRunRecord } from './helpers/viewtrace.js';
import { receipt } from './helpers/m2.js';

describe('M4 answer-scoped analysis reconnect and inspector state', () => {
  let browser: Browser;
  before(async () => { browser = await chromium.launch({ headless: true }); });
  after(async () => { await browser?.close(); });

  it('a real late scoped event between analysis and detail never labels mixed counts CURRENT', { timeout: 30000 }, async () => {
    const root = await tempDataRoot('m4-snapshot-race');
    const runId = 'run-snapshot-race';
    const input = join(root, 'initial.jsonl');
    await writeFile(input, [makeRunRecord({ runId }), makeEvent({ runId, eventId: 'race-e1' }),
      receipt({ runId, answerId: 'race-answer', receiptId: 'race-receipt',
        sequence: 3, receivedAt: '2026-10-07T00:00:00Z', eventIds: ['race-e1', 'race-e2'] }),
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');
    const ingested = await runBin(['ingest', input, '--data-root', root]);
    assert.equal(ingested.code, 0, ingested.stderr);
    await upService(root);
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    let injected = false;
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.route('**/api/runs/run-snapshot-race/answers/race-answer/analysis*', async (route) => {
        const response = await route.fetch();
        if (!injected) {
          injected = true;
          const store = await ViewTraceStore.open({ dataRoot: root });
          try {
            const run = store.getRun(runId)!;
            await store.appendRecords(runId, [makeEvent({ runId, eventId: 'race-e2', sequence: run.jsonlLines + 1 })], [], 0);
          } finally { store.close(); }
        }
        await route.fulfill({ response });
      });
      // Incomplete receipt scope correctly degrades automatic resolution to
      // a picker. Choose it explicitly to exercise this partial saved answer.
      const reveal = await runBin(['--select', 'race-receipt', '--url-only', '--json', '--data-root', root]);
      assert.equal(reveal.code, 0, reveal.stderr);
      const url = (JSON.parse(reveal.stdout) as { url: string }).url;
      await page.goto(url);
      await expect(page.locator('#connection')).toContainText('STALE', { timeout: 5000 });
      await expect(page.locator('#connection')).toContainText('matching snapshot');
      await expect(page.locator('#analysis-revision')).toHaveCount(0);
      await expect(page.locator('#raw-events article')).toHaveCount(2);
      await expect(page.getByRole('heading', { name: 'Answer race-answer', exact: true })).toBeVisible();
      await expect(page.locator('#analysis-revision')).toContainText('2 records', { timeout: 8000 });
      await expect(page.locator('#connection')).toContainText('Stored snapshot');
      await expect(page.locator('#raw-events article')).toHaveCount(2);
      assert.equal(page.url(), url);
      // Preserve the existing M3 distinction: explicit empty scope uses
      // zero events even when the same run contains observed events.
      const store = await ViewTraceStore.open({ dataRoot: root });
      try {
        await store.appendRecords(runId, [receipt({
          runId, receiptId: 'race-empty-receipt', answerId: 'race-empty-answer',
          agentSessionId: 'empty-session', turnId: 'empty-turn', eventIds: [],
          sequence: store.getRun(runId)!.jsonlLines + 1, receivedAt: '2026-10-07T00:00:00Z',
        })], [], 0);
      } finally { store.close(); }
      const emptyReveal = await runBin(['--receipt', 'race-empty-receipt', '--url-only', '--json', '--data-root', root]);
      assert.equal(emptyReveal.code, 0, emptyReveal.stderr);
      await page.goto((JSON.parse(emptyReveal.stdout) as { url: string }).url);
      await expect(page.locator('#analysis-revision')).toContainText('0 records');
      await expect(page.locator('#connection')).toContainText('Stored snapshot');
      await expect(page.getByRole('heading', { name: 'Answer race-empty-answer', exact: true })).toBeVisible();
      await expect(page.locator('#raw-events article')).toHaveCount(0);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await downService(root);
    }
  });

  it('analysis-only outage stays STALE; Raw collapse and Inspector focus survive a real revision update', { timeout: 45000 }, async () => {
    const root = await tempDataRoot('m4-reconnect');
    assert.equal((await runBin(['ingest', viewtraceFixture('answer-multi-turn.jsonl'), '--data-root', root])).code, 0);
    await upService(root);
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      const reveal = await runBin(['--receipt', 'receipt-A2', '--url-only', '--json', '--data-root', root]);
      assert.equal(reveal.code, 0, reveal.stderr);
      const url = (JSON.parse(reveal.stdout) as { url: string }).url;
      await page.route('**/api/runs/receipt-multi/answers/A2/analysis*', (route) => route.abort());
      await page.goto(url);
      // Analysis can be unavailable on the first visit too: fetch the saved
      // answer as fallback, keep its exact scope, then recover on the same URL.
      await expect(page.locator('#connection')).toContainText('STALE', { timeout: 8000 });
      await expect(page.getByRole('heading', { name: 'Answer A2', exact: true })).toBeVisible();
      await expect(page.locator('#analysis-revision')).toHaveCount(0);
      await expect(page.locator('#raw-events article')).toHaveCount(2);
      assert.equal(page.url(), url);
      await page.unroute('**/api/runs/receipt-multi/answers/A2/analysis*');
      await expect(page.locator('#analysis-revision')).toContainText('2 records', { timeout: 8000 });
      await expect(page.locator('#connection')).toContainText('Stored snapshot');
      const raw = page.locator('#raw-details-e2');
      assert.equal(await raw.getAttribute('open'), null);
      await raw.locator('summary').click();
      await expect(raw).toHaveAttribute('open', '');

      await page.route('**/api/runs/receipt-multi/answers/A2/analysis*', (route) => route.abort());
      await expect(page.locator('#connection')).toContainText('STALE', { timeout: 8000 });
      await expect(page.getByRole('heading', { name: 'Answer A2', exact: true })).toBeVisible();
      assert.equal(page.url(), url);
      await page.unroute('**/api/runs/receipt-multi/answers/A2/analysis*');
      await expect(page.locator('#connection')).toContainText('Stored snapshot', { timeout: 8000 });

      const trigger = page.locator('#evidence-cards button[data-event-id="e2"]');
      await trigger.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Evidence inspector' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('e2');
      assert.equal((await runBin(['keep', 'receipt-multi', '--data-root', root])).code, 0);
      // The page is inert while its native modal is open. Verify the
      // refreshed stored state in the DOM without bypassing that modality.
      await expect(page.locator('button').filter({ hasText: /^Release keep$/ })).toBeAttached({ timeout: 8000 });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Close inspector' }).click();
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      await expect(raw).toHaveAttribute('open', '');
      await expect(page.locator('#raw-events article')).toHaveCount(2);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await downService(root);
    }
  });
});
