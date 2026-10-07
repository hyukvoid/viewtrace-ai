import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { upService, downService, runBin } from './helpers/m1.js';
import { tempDataRoot, viewtraceFixture } from './helpers/viewtrace.js';
import { readServiceFile } from '../src/viewtrace/servestate.js';
import { request } from './helpers/m2.js';

describe('M2 real Chromium DOM reveal', () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  it('A1/A2/A3 deep links survive refresh; picker explicit select/cancel and legacy preserve identity/status/revision', async () => {
    const root = await tempDataRoot('browser-reveal');
    assert.equal(
      (await runBin(['ingest', viewtraceFixture('answer-multi-turn.jsonl'), '--data-root', root])).code,
      0,
    );
    assert.equal(
      (await runBin(['ingest', viewtraceFixture('research-normal.jsonl'), '--data-root', root])).code,
      0,
    );
    await upService(root);
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    const external: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (!r.url().startsWith('http://127.0.0.1:')) external.push(r.url());
    });
    try {
      const info = (await readServiceFile(root))!;
      const base = `http://127.0.0.1:${info.reportPort}`;
      for (let i = 1; i <= 3; i++) {
        const output = await runBin([
          '--receipt',
          `receipt-A${i}`,
          '--data-root',
          root,
          '--url-only',
          '--json',
        ]);
        const url = JSON.parse(output.stdout).url as string;
        await page.goto(url);
        await expect(page.getByRole('heading', { name: `Answer A${i}`, exact: true })).toBeVisible();
        await expect(page.locator('#status')).toContainText('Collection COMPLETE');
        await expect(page.locator('#status')).toContainText('Evidence support UNKNOWN');
        await expect(page.getByRole('heading', { name: `CLAIM · e${i}` })).toBeVisible();
        assert.equal(await page.locator('article').count(), 2);
        await page.reload();
        await expect(page.getByRole('heading', { name: `Answer A${i}`, exact: true })).toBeVisible();
        assert.ok(page.url().endsWith(`/answers/A${i}`));
        const api = await request<{
          receipt: { answerId: string };
          revision: string;
        }>(info.reportPort!, `/api/runs/receipt-multi/answers/A${i}`, {
          headers: { authorization: `Bearer ${info.reportToken}` },
        });
        assert.equal(api.json.receipt.answerId, `A${i}`);
        await expect(page.locator('#revision')).toHaveText(`Revision ${api.json.revision}`);
      }
      await page.goto(base);
      await expect(page.getByRole('heading', { name: 'Choose a saved answer or trace' })).toBeVisible();
      await expect(
        page.getByText('Current answer association is UNKNOWN.', {
          exact: false,
        }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.getByText('Reveal cancelled. No answer was opened.')).toBeVisible();
      assert.equal(new URL(page.url()).pathname, '/');
      await page.reload();
      await page.getByRole('button', { name: 'Select answer A2', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Answer A2', exact: true })).toBeVisible();
      await expect(page.getByText('Association explicit-selection', { exact: false })).toBeVisible();
      await expect(page.locator('article')).toHaveCount(2);
      assert.ok(new URL(page.url()).pathname.endsWith('/answers/A2'));
      await page.reload();
      await expect(page.getByText('Association explicit-selection', { exact: false })).toBeVisible();
      await expect(page.locator('article')).toHaveCount(2);
      await page.route('**/api/runs/receipt-multi/answers/A2*', (route) => route.abort());
      await expect(page.locator('#connection')).toContainText('STALE', {
        timeout: 6000,
      });
      await expect(page.getByRole('heading', { name: 'Answer A2', exact: true })).toBeVisible();
      await page.unroute('**/api/runs/receipt-multi/answers/A2*');
      await expect(page.locator('#connection')).toContainText('Stored snapshot', { timeout: 6000 });
      await expect(page.locator('article')).toHaveCount(2);
      await page.goto(base);
      await page
        .getByRole('button', {
          name: 'Select run research-normal-001',
          exact: true,
        })
        .click();
      await expect(
        page.getByRole('heading', {
          name: 'Run research-normal-001',
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByText('Run exploration container. Answer association UNKNOWN.')).toBeVisible();
      assert.ok(!page.url().includes('/answers/'));
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
    } finally {
      await context.close();
      await downService(root);
    }
  });

  it('renders stored XSS as text, refuses dangerous source links, leaks no credential/CoT and deletion never falls back to latest', async () => {
    const root = await tempDataRoot('browser-xss');
    const rows = (await readFile(viewtraceFixture('answer-multi-turn.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s) as Record<string, unknown>);
    for (const row of rows) {
      if (row['recordKind'] === 'answer' && row['answerId'] === 'A1')
        Object.assign(row, {
          answer:
            '<img src="https://evil.invalid/x" onerror="globalThis.pwned=1"> api_key=CREDENTIAL_BROWSER_SENTINEL',
          analysis: 'PRIVATE_BROWSER_SENTINEL',
        });
      if (row['recordKind'] === 'event' && row['eventId'] === 'e1')
        row['source'] = {
          sourceId: 'xss',
          kind: 'URL',
          location: 'javascript:globalThis.pwned=2',
        };
    }
    const input = join(root, 'xss.jsonl');
    await writeFile(input, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    assert.equal((await runBin(['ingest', input, '--data-root', root])).code, 0);
    await upService(root);
    const context = await browser.newContext({
      viewport: { width: 360, height: 780 },
    });
    const page = await context.newPage();
    const external: string[] = [];
    const errors: string[] = [];
    page.on('request', (r) => {
      if (!r.url().startsWith('http://127.0.0.1:')) external.push(r.url());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      const info = (await readServiceFile(root))!;
      const base = `http://127.0.0.1:${info.reportPort}`;
      const url = base + '/runs/receipt-multi/answers/A1';
      await page.goto(url);
      await expect(page.getByRole('heading', { name: 'Answer A1', exact: true })).toBeVisible();
      await expect(page.locator('article')).toHaveCount(2);
      const text = await page.locator('body').innerText();
      assert.ok(text.includes('<img src='));
      assert.ok(!/CREDENTIAL_BROWSER_SENTINEL|PRIVATE_BROWSER_SENTINEL/.test(text));
      assert.ok(!text.includes(info.reportToken!));
      assert.equal(await page.locator('img').count(), 0);
      assert.equal(await page.locator('a[href^="javascript:"],a[href^="data:"],a[href^="file:"]').count(), 0);
      assert.equal(await page.evaluate(() => Reflect.get(globalThis, 'pwned')), undefined);
      await page.getByRole('button', { name: 'Keep run', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Release keep', exact: true })).toBeVisible();
      await runBin(['ingest', viewtraceFixture('research-normal.jsonl'), '--data-root', root]);
      assert.equal((await runBin(['delete', 'receipt-multi', '--data-root', root])).code, 0);
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Trace unavailable' })).toBeVisible();
      assert.equal(page.url(), url);
      await expect(
        page.getByText('Saved answer/trace is missing or deleted. Choose a trace explicitly.'),
      ).toBeVisible();
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await downService(root);
    }
  });
});
