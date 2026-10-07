/**
 * M4 independent verification — browser security and accessibility boundary:
 * stored XSS as text, dangerous URL protocols, credential/private-reasoning
 * sentinels across API/DOM/Raw/console, zero automatic external requests
 * with the explicit source click tested separately, keyboard/focus/labels,
 * 360px narrow screen and axe serious/critical gate.
 */

import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { upService, downService, runBin } from './helpers/m1.js';
import { tempDataRoot, viewtraceFixture } from './helpers/viewtrace.js';
import { readServiceFile } from '../src/viewtrace/servestate.js';
import { request } from './helpers/m2.js';

const SECRET = 'M4_SECRET_9f172a';
const PRIVATE = 'PRIVATE_M4_REASONING_77c3';

interface DomElement {
  id?: string;
  tagName?: string;
  textContent?: string | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  contains(other: unknown): boolean;
}

interface DomDocument {
  activeElement: DomElement | null;
  getElementById(id: string): DomElement | null;
}

declare const document: DomDocument;

interface EventsPage {
  events: { eventId: string }[];
  nextCursor: number | null;
}

describe('M4 independent browser verification — security, sentinels, accessibility', () => {
  let browser: Browser;
  let root: string;
  let base: string;
  let port: number;
  let token: string;

  before(async () => {
    browser = await chromium.launch({ headless: true });
    root = await tempDataRoot('m4-sec');
    const ingest = await runBin(['ingest', viewtraceFixture('m4-verdict.jsonl'), '--data-root', root]);
    assert.equal(ingest.code, 0, ingest.stderr);
    await upService(root);
    const info = (await readServiceFile(root))!;
    port = info.reportPort!;
    token = info.reportToken!;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await browser?.close();
    await downService(root);
  });

  it('stored markup renders as text, dangerous protocols are not clickable, sentinels absent from API/DOM/Raw/console, zero automatic external requests; explicit source click is the only external request', async () => {
    // API sentinel sweep first: the sanitized API itself must not leak the
    // secret value or the private reasoning payload.
    const analysis = await request<Record<string, unknown>>(
      port,
      '/api/runs/run-m4-xss/answers/ans-m4-xss/analysis',
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(analysis.status, 200);
    assert.ok(!analysis.text.includes(SECRET), 'analysis API must not expose the raw secret');
    assert.ok(!analysis.text.includes(PRIVATE), 'analysis API must not expose private reasoning');
    const events1 = await request<EventsPage>(
      port,
      '/api/runs/run-m4-xss/answers/ans-m4-xss/events?limit=50',
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(events1.status, 200);
    assert.equal(events1.json.events.length, 4);
    assert.ok(!events1.text.includes(SECRET), 'events API must not expose the raw secret');
    assert.ok(!events1.text.includes(PRIVATE), 'events API must not expose private reasoning');
    assert.ok(events1.text.includes('[REDACTED]'), 'secret must be visibly redacted, not silently dropped');

    const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
    const page = await context.newPage();
    const external: string[] = [];
    const errors: string[] = [];
    const consoleErrors: string[] = [];
    const consoleMessages: string[] = [];
    context.on('request', (r) => {
      if (!r.url().startsWith(base)) external.push(r.url());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      consoleMessages.push(m.text());
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    try {
      const out = await runBin(['--receipt', 'receipt-m4-xss', '--data-root', root, '--url-only', '--json']);
      assert.equal(out.code, 0, out.stderr);
      await page.goto((JSON.parse(out.stdout) as { url: string }).url);
      await expect(page.getByRole('heading', { name: 'Answer ans-m4-xss', exact: true })).toBeVisible({
        timeout: 15_000,
      });
      // Raw section present and paginated first page only.
      await expect(page.locator('#raw-events').first()).toBeVisible({ timeout: 10_000 });

      // Markup is text, never interpreted.
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('<img src='), 'stored answer markup must render as literal text');
      assert.ok(bodyText.includes('[REDACTED]'), 'redaction marker must be visible where the secret was');
      assert.ok(!bodyText.includes(SECRET), 'secret must not appear anywhere in the DOM');
      assert.ok(!bodyText.includes(PRIVATE), 'private reasoning must not appear anywhere in the DOM');
      assert.ok(!bodyText.includes(token), 'session token must not leak into the page');
      const completeDomText = await page.locator('body').textContent() ?? '';
      for (const forbidden of [SECRET, PRIVATE, token]) {
        assert.ok(!completeDomText.includes(forbidden), 'closed Raw DOM must not contain credentials or private reasoning');
      }
      assert.equal(await page.locator('img, svg[onload]').count(), 0, 'no injected img or svg elements');
      assert.equal(
        await page.locator('script:not([src="/app.js"])').count(),
        0,
        'no injected script elements',
      );
      assert.equal(
        await page.locator('a[href^="javascript:"], a[href^="data:"], a[href^="file:"]').count(),
        0,
        'dangerous URL protocols must never become hrefs',
      );
      const pwned = await page.evaluate(() => Reflect.get(globalThis, 'pwnedM4'));
      assert.equal(pwned, undefined, 'no XSS payload may execute');

      // Inspector also renders raw JSON as text.
      const anyInspectBtn = page.getByRole('button', { name: /^Inspect event / }).first();
      await expect(anyInspectBtn).toBeVisible();
      {
        await anyInspectBtn.click();
        const inspector = page.locator('#event-inspector');
        await expect(inspector).toBeVisible({ timeout: 10_000 });
        const inspectorText = await inspector.innerText();
        assert.ok(!inspectorText.includes(SECRET), 'inspector must show redacted content only');
        assert.ok(!inspectorText.includes(PRIVATE), 'inspector must never show private reasoning');
        await page.getByRole('button', { name: 'Close inspector' }).click();
        await expect(inspector).toBeHidden();
      }

      // Zero automatic external requests so far.
      assert.deepEqual(external, [], 'no automatic external font/script/image/telemetry requests');
      assert.deepEqual(errors, []);
      assert.deepEqual(consoleErrors, []);
      assert.ok(consoleMessages.every((text) => !text.includes(SECRET) && !text.includes(PRIVATE) && !text.includes(token)),
        'all console message levels must remain free of credentials/private reasoning');

      // Explicit source click — separately verified external navigation.
      await context.route('https://external.example/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/plain', body: 'external stub' }),
      );
      const sourceLink = page.getByRole('link', { name: /open recorded source/i }).first();
      await expect(sourceLink).toBeVisible();
      const popupPromise = page.waitForEvent('popup', { timeout: 10_000 });
      await sourceLink.click();
      const popup = await popupPromise;
      assert.equal(popup.url(), 'https://external.example/report');
      assert.deepEqual(
        external,
        ['https://external.example/report'],
        'the only external request must be the explicitly clicked source link',
      );
      await popup.close();
      await context.unroute('https://external.example/**');
      assert.deepEqual(errors, []);
      assert.deepEqual(consoleErrors, []);
      assert.ok(consoleMessages.every((text) => !text.includes(SECRET) && !text.includes(PRIVATE) && !text.includes(token)));
    } finally {
      await context.close();
    }
  });

  it('keyboard-only flow reaches the lens and opens/closes the inspector with focus restoration; semantic labels; axe serious/critical zero at 360px', async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
    const page = await context.newPage();
    try {
      const out = await runBin(['--receipt', 'receipt-m4-decide', '--data-root', root, '--url-only', '--json']);
      assert.equal(out.code, 0, out.stderr);
      await page.goto((JSON.parse(out.stdout) as { url: string }).url);
      await expect(page.getByRole('heading', { name: 'Answer ans-m4-decide', exact: true })).toBeVisible({
        timeout: 15_000,
      });

      // Keyboard: Tab reaches the mode lens (focusable, labelled select).
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab');
        if ((await page.evaluate(() => document.activeElement?.id)) === 'mode-lens') break;
      }
      assert.equal(
        await page.evaluate(() => document.activeElement?.id),
        'mode-lens',
        'keyboard Tab order must reach the mode lens select',
      );
      const lensName = await page.evaluate(() => {
        const el = document.activeElement;
        return el ? el.getAttribute('aria-label') ?? el.textContent ?? '' : '';
      });
      assert.match(lensName, /mode lens/i, 'select must expose the accessible name "Mode lens"');

      // Keyboard: Tab onward to a claim/evidence card and Enter opens the inspector.
      let invoked: { tag: string; attr: string; value: string } | null = null;
      for (let i = 0; i < 60; i++) {
        await page.keyboard.press('Tab');
        const info = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el) return null;
          const attr =
            ['data-claim-id', 'data-evidence-id', 'data-source-id', 'data-event-id'].find((a) =>
              el.hasAttribute(a),
            ) ?? '';
          return { tag: el.tagName?.toLowerCase() ?? '', attr, value: attr ? el.getAttribute(attr) ?? '' : '' };
        });
        if (info && info.attr) {
          invoked = info;
          break;
        }
      }
      assert.ok(invoked, 'keyboard Tab must reach a claim/evidence/source/event card');
      await page.keyboard.press('Enter');
      const inspector = page.locator('#event-inspector');
      await expect(inspector).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole('dialog', { name: 'Evidence inspector' })).toBeVisible();
      const focusInDialog = await page.evaluate(() => {
        const dialog = document.getElementById('event-inspector');
        return dialog ? dialog.contains(document.activeElement) : false;
      });
      assert.ok(focusInDialog, 'focus must move into the inspector dialog');
      await page.getByRole('button', { name: 'Close inspector' }).click();
      await expect(inspector).toBeHidden();
      const restored = await page.evaluate(() => ({
        attr:
          ['data-claim-id', 'data-evidence-id', 'data-source-id', 'data-event-id'].find((a) =>
            document.activeElement?.hasAttribute(a),
          ) ?? '',
        value: document.activeElement?.getAttribute(
          ['data-claim-id', 'data-evidence-id', 'data-source-id', 'data-event-id'].find((a) =>
            document.activeElement?.hasAttribute(a),
          ) ?? '',
        ),
      }));
      assert.ok(
        restored.attr === invoked!.attr && restored.value === invoked!.value,
        `focus must restore to the invoking ${invoked!.attr} element`,
      );

      // Essential information reachable at 360px without hiding.
      for (const hook of ['#answer-summary', '#mode-lens', '#why-answer', '#unresolved-areas']) {
        const el = page.locator(hook).first();
        await expect(el).toBeVisible();
      }
      const graphPreview = page.getByRole('region', { name: 'Graph visual preview', exact: true });
      await graphPreview.focus();
      await expect(graphPreview).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => graphPreview.evaluate((node) =>
        (node as unknown as { scrollLeft: number }).scrollLeft)).toBeGreaterThan(0);

      // axe: serious/critical violations must be zero on the answer page.
      const answerScan = await new AxeBuilder({ page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]['page'] }).analyze();
      const severe = answerScan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      assert.deepEqual(
        severe.map((v) => `${v.id}(${v.impact})`),
        [],
        'axe serious/critical violations must be zero on the answer page',
      );

      // Picker page too (reveal entry surface).
      await page.goto(base + '/');
      await expect(page.getByRole('heading', { name: 'Choose a saved answer or trace' })).toBeVisible({
        timeout: 10_000,
      });
      const pickerScan = await new AxeBuilder({ page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]['page'] }).analyze();
      const severePicker = pickerScan.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );
      assert.deepEqual(
        severePicker.map((v) => `${v.id}(${v.impact})`),
        [],
        'axe serious/critical violations must be zero on the picker page',
      );
    } finally {
      await context.close();
    }
  });

  it('JEV failure display: an UNAVAILABLE advisory in the stored artifact is shown honestly and never elevates support', async () => {
    // Fault injection on the test's own derived artifact (data root is a
    // per-test temp dir): mark the persisted JEV result UNAVAILABLE to
    // exercise the UI honesty path that the always-succeeding local
    // evaluator cannot produce through the public ingest path.
    const { readFile, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    // Ensure the artifact exists in this data root before tampering.
    const primed = await request<unknown>(
      port,
      '/api/runs/run-m4-jev/answers/ans-m4-jev/analysis',
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(primed.status, 200, primed.text);
    const reportFile = join(root, 'artifacts', 'run-m4-jev', 'answers', 'ans-m4-jev', 'analysis-report.json');
    const stored = JSON.parse(await readFile(reportFile, 'utf8')) as {
      jevResults: { status: string; checkpointId: string }[];
      support: { status: string };
    };
    assert.equal(stored.jevResults.length, 3);
    const tampered = JSON.parse(JSON.stringify(stored));
    for (const r of tampered.jevResults as { status: string }[]) r.status = 'UNAVAILABLE';
    await writeFile(reportFile, JSON.stringify(tampered, null, 2) + '\n');

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${base}/runs/run-m4-jev/answers/ans-m4-jev`);
      await expect(page.getByRole('heading', { name: 'Answer ans-m4-jev', exact: true })).toBeVisible({
        timeout: 15_000,
      });
      const advisoryText = await page.locator('#jev-advisory').innerText({ timeout: 10_000 });
      assert.match(advisoryText, /UNAVAILABLE/i, 'JEV UNAVAILABLE must be displayed honestly');
      const summary = await page.locator('#app').innerText();
      assert.ok(
        !/STRONGLY_SUPPORTED|PARTIALLY_SUPPORTED/.test(summary),
        'JEV state must never change evidence support',
      );
      assert.match(summary, /UNKNOWN/);
    } finally {
      await context.close();
      // Restore the artifact so later runs of the suite are unaffected.
      await writeFile(reportFile, JSON.stringify(stored, null, 2) + '\n');
    }
  });
});
