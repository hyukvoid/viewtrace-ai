import { it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { runBin, upService, downService } from './helpers/m1.js';
import { tempDataRoot, makeEvent, makeRunRecord } from './helpers/viewtrace.js';
import { receipt } from './helpers/m2.js';

it('M4 deep claim→evidence→source→Inspector reaches an allowed event beyond page 250 with bounded cards', { timeout: 45000 }, async () => {
  const root = await tempDataRoot('inspector-depth');
  const runId = 'run-inspector-depth';
  const reads = Array.from({ length: 320 }, (_, index) => {
    const id = `depth-read-${index + 1}`;
    const sourceId = `src-depth-${index + 1}`;
    return makeEvent({
      runId, eventId: id, type: 'READ',
      source: { sourceId, kind: 'TOOL_RESULT', location: `tool://depth/${index + 1}` },
      provenance: { category: 'VIEWTRACE_OBSERVED', observed: {
        toolCallId: `depth-call-${index + 1}`, toolResultId: `depth-result-${index + 1}`,
      } },
      payload: { type: 'READ', sourceId, outcome: 'SUCCESS', summary: `Recorded material ${index + 1}.` },
    });
  });
  const claim = makeEvent({
    runId, eventId: 'depth-claim', type: 'CLAIM',
    provenance: { category: 'AGENT_REPORTED' },
    payload: { type: 'CLAIM', text: 'A claim anchored to the late recorded material.' },
    relations: [{ type: 'SUPPORTS', targetEventId: 'depth-read-300' }],
  });
  const input = join(root, 'depth.jsonl');
  await writeFile(input, [
    makeRunRecord({ runId, lifecycle: 'RUNNING' }), ...reads, claim,
    receipt({ runId, receiptId: 'receipt-depth', answerId: 'answer-depth', sequence: 323,
      receivedAt: '2026-10-07T00:00:00Z', eventIds: [...reads.map((r) => r.eventId), claim.eventId] }),
    makeRunRecord({ runId, lifecycle: 'COMPLETED' }),
  ].map((record) => JSON.stringify(record)).join('\n') + '\n');
  const ingested = await runBin(['ingest', input, '--data-root', root]);
  assert.equal(ingested.code, 0, ingested.stderr);
  await upService(root);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  const lookups: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('eventId=')) lookups.push(request.url());
  });
  try {
    const reveal = await runBin(['--receipt', 'receipt-depth', '--url-only', '--json', '--data-root', root]);
    assert.equal(reveal.code, 0, reveal.stderr);
    await page.goto((JSON.parse(reveal.stdout) as { url: string }).url);
    await expect(page.locator('#raw-events article')).toHaveCount(50);
    await expect(page.locator('#evidence-cards .evidence-card')).toHaveCount(20);
    await page.locator('#why-answer button[data-evidence-id="ev-depth-read-300"]').click();
    const card = page.locator('#evidence-cards .evidence-card[data-evidence-id="ev-depth-read-300"]');
    await expect(card).toBeVisible();
    await expect(page.locator('#evidence-cards .evidence-card')).toHaveCount(21);
    await card.getByRole('button', { name: 'Jump to Source src-depth-300', exact: true }).click();
    const source = page.locator('#source-ledger .source-card[data-source-id="src-depth-300"]');
    await expect(source).toBeVisible();
    await expect(page.locator('#source-ledger .source-card')).toHaveCount(21);
    await source.getByRole('button', { name: 'Inspect anchor depth-read-300', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Evidence inspector' });
    await expect(dialog).toContainText('Recorded material 300.');
    await expect(dialog).toContainText('VIEWTRACE_OBSERVED');
    const revision = (await page.locator('#revision').innerText()).replace(/^Revision /, '');
    await expect(dialog.locator('#inspector-revision')).toHaveText(`Snapshot revision: ${revision}`);
    assert.ok(lookups.some((url) => url.includes('eventId=depth-read-300')), 'Inspector uses exact scoped lookup beyond the loaded Raw page');
    await dialog.getByRole('button', { name: 'Close inspector' }).click();
    await expect(source.getByRole('button', { name: 'Inspect anchor depth-read-300', exact: true })).toBeFocused();
    await expect(page.locator('#raw-events article')).toHaveCount(50);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await downService(root);
  }
});
