/**
 * M4 independent verification — browser DOM assertions for the seven-mode
 * lens, Why→claim→evidence→source→inspector chain, exploration graph
 * provenance, conflict ledgers and JEV advisory honesty.
 *
 * Expected values come from fixtures/viewtrace/m4-verdict.oracle.json
 * (derived by hand from docs/MILESTONES.md §3/§8/§9 before the M4 UI was
 * read). The served analysis JSON is only cross-checked for ID linkage,
 * never used as the source of expected values.
 */

import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import type { Browser, Locator, Page } from '@playwright/test';
import { upService, downService, runBin } from './helpers/m1.js';
import { tempDataRoot, viewtraceFixture } from './helpers/viewtrace.js';
import { readServiceFile } from '../src/viewtrace/servestate.js';
import { request } from './helpers/m2.js';
import type { AnalysisReportV1 } from '../src/viewtrace/analysis-types.js';

interface DomElement {
  dataset: Record<string, string | undefined>;
  innerText?: string;
  textContent?: string | null;
  id?: string;
  className?: string;
  tagName?: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  contains(other: unknown): boolean;
}

interface DomDocument {
  activeElement: DomElement | null;
  getElementById(id: string): DomElement | null;
}

declare const document: DomDocument;

const TOLERANT_CONFIRM = /OBSERVED_CONFIRMATION|confirmation/i;
const TOLERANT_CORRECTION = /OBSERVED_CORRECTION|correction/i;
const TOLERANT_OVERRIDE = /EXPLICIT_OVERRIDE|override/i;

async function receiptUrl(root: string, receiptId: string): Promise<string> {
  const out = await runBin(['--receipt', receiptId, '--data-root', root, '--url-only', '--json']);
  assert.equal(out.code, 0, out.stderr);
  return (JSON.parse(out.stdout) as { url: string }).url;
}

async function appText(page: Page): Promise<string> {
  return page.locator('#app').innerText({ timeout: 10_000 });
}

function dataIds(scope: Locator, attr: 'claim-id' | 'evidence-id' | 'source-id' | 'node-id' | 'relation-id' | 'event-id'): Promise<string[]> {
  return scope.locator(`[data-${attr}]`).evaluateAll((nodes, attribute) =>
    nodes.map((n) => (n as unknown as DomElement).dataset[attribute] ?? ''),
    attr.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()),
  );
}

/** Served analysis JSON — ID linkage cross-check only. */
async function servedAnalysis(
  port: number,
  token: string,
  runId: string,
  answerId: string,
  mode?: string,
): Promise<AnalysisReportV1> {
  const res = await request<AnalysisReportV1>(
    port,
    `/api/runs/${runId}/answers/${answerId}/analysis${mode ? `?mode=${mode}` : ''}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  assert.equal(res.status, 200, res.text);
  return res.json;
}

describe('M4 independent browser verification — lens, why chain, graph, conflicts, JEV', () => {
  let browser: Browser;
  let root: string;
  let base: string;
  let port: number;
  let token: string;

  before(async () => {
    browser = await chromium.launch({ headless: true });
    root = await tempDataRoot('m4-verdict');
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

  it('DECIDE lens: confirmation history, Why chain to claim/evidence/source/inspector, Why-not B/C shows missing evidence, override preserves identity', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(await receiptUrl(root, 'receipt-m4-decide'));
      await expect(page.getByRole('heading', { name: 'Answer ans-m4-decide', exact: true })).toBeVisible({
        timeout: 15_000,
      });

      // Default lens equals the observed mode; history shows hypothesis + confirmation.
      const lens = page.locator('#mode-lens');
      await expect(lens).toBeVisible();
      assert.equal(
        await page.getByRole('combobox', { name: 'Mode lens' }).count() >= 1,
        true,
        '#mode-lens must be a labelled select (accessible name "Mode lens")',
      );
      assert.equal(await lens.inputValue(), 'DECIDE');
      const history0 = await page.locator('#mode-history').innerText();
      assert.match(history0, TOLERANT_CONFIRM);
      assert.ok(!TOLERANT_CORRECTION.test(history0), 'DECIDE confirmation must not be labelled a correction');

      // Support stays on the oracle value on the default screen.
      const summary0 = await appText(page);
      assert.match(summary0, /STRONGLY_SUPPORTED/);
      assert.ok(
        !/PARTIALLY_SUPPORTED|INSUFFICIENT_EVIDENCE|CONFLICTING_EVIDENCE/.test(summary0),
        'oracle support is STRONGLY_SUPPORTED; weaker statuses must not appear',
      );

      // Why this answer → grounded claim → evidence → source, with stable ids.
      const why = page.locator('#why-answer');
      await expect(why).toBeVisible();
      const whyClaim = why.locator('[data-claim-id="claim-m4d-claim"]');
      await expect(whyClaim).toBeVisible();
      const evidenceCard = page.locator('#evidence-cards [data-evidence-id="ev-m4d-read"]');
      await expect(evidenceCard.first()).toBeVisible();
      const ledgerCard = page.locator('#source-ledger [data-source-id="src-m4-edge"]');
      await expect(ledgerCard).toBeVisible();
      const lanes = await appText(page);
      assert.match(lanes, /\bobs\b|\brep\b|\binf\b/, 'provenance lanes obs/rep/inf must be disclosed');

      // Why not B/C: alternatives appear with missing evidence, and no
      // fabricated rationale is attributed to them.
      const body = await appText(page);
      assert.match(body, /RocksDB/);
      assert.match(body, /TiKV/);
      const decideTexts = await page
        .locator('#app')
        .locator('[data-claim-id]')
        .allInnerTexts();
      const fabricated = decideTexts.filter((t) => /RocksDB|TiKV/.test(t));
      assert.deepEqual(fabricated, [], 'no claim card may attribute observed rationale to RocksDB/TiKV');
      const missingMarker = await page
        .locator('#app')
        .evaluate((el) => {
          const text = (el as unknown as DomElement).innerText ?? '';
          const altZone = text.slice(Math.min(...['RocksDB', 'TiKV'].map((n) => (text.includes(n) ? text.indexOf(n) : text.length))));
          return /unknown|missing|insufficient|no (observed|recorded|comparison)|비교 근거 부족/i.test(altZone);
        });
      assert.equal(missingMarker, true, 'rejected options must disclose missing comparison evidence');

      // Inspector chain: open from the evidence card, close, focus restores.
      const inspectBtn = evidenceCard.first().getByRole('button', { name: /^Inspect event / });
      await inspectBtn.click();
      const inspector = page.locator('#event-inspector');
      await expect(inspector).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole('dialog', { name: 'Evidence inspector' })).toBeVisible();
      const dialogText = await inspector.innerText();
      assert.match(dialogText, /m4d-read/);
      assert.ok(
        !/m4d-search|m4d-claim|m4d-recommend/.test(dialogText),
        'inspector must show the single scoped event, not the whole raw trace',
      );
      await page.getByRole('button', { name: 'Close inspector' }).click();
      await expect(inspector).toBeHidden();
      const focused = await page.evaluate(() => ({
        id: document.activeElement?.id ?? '',
        dataEvent: document.activeElement?.getAttribute('data-event-id') ?? '',
      }));
      assert.equal(
        focused.dataEvent,
        'm4d-read',
        'focus must return to the invoking element after the inspector closes',
      );

      // Explicit override: history gains the override revision, identity does not change.
      const evidenceBefore = await dataIds(page.locator('#app'), 'evidence-id');
      const claimsBefore = await dataIds(page.locator('#app'), 'claim-id');
      await lens.selectOption('VERIFY');
      await expect(page.locator('#mode-history')).toContainText('OVERRIDE', { timeout: 10_000 });
      const history1 = await page.locator('#mode-history').innerText();
      assert.match(history1, TOLERANT_OVERRIDE);
      assert.match(history1, /VERIFY/);
      await expect(page.locator('#mode-lens')).toHaveValue('VERIFY', { timeout: 10_000 });
      const evidenceAfter = await dataIds(page.locator('#app'), 'evidence-id');
      const claimsAfter = await dataIds(page.locator('#app'), 'claim-id');
      assert.deepEqual(
        [...new Set(evidenceAfter)].sort(),
        [...new Set(evidenceBefore)].sort(),
        'lens override must preserve evidence identity',
      );
      assert.ok(
        claimsAfter.every((c) => claimsBefore.includes(c)),
        'lens override must not add fabricated claims',
      );
      const summary1 = await appText(page);
      assert.match(summary1, /STRONGLY_SUPPORTED/, 'override must not change support');

      // Switching back restores the analyzer's own lens without persisting the override.
      await page.locator('#mode-lens').selectOption('DECIDE');
      await expect(page.locator('#mode-lens')).toHaveValue('DECIDE', { timeout: 10_000 });
      const served = await servedAnalysis(port, token, 'run-m4-decide', 'ans-m4-decide');
      assert.equal(served.lens.currentMode, 'DECIDE', 'served default lens must stay DECIDE (override transient)');
      assert.equal(served.lens.revisions.length, 2, 'override must not be persisted');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it('COMPARE correction: EXPLAIN hypothesis corrected by observed COMPARE; matrix values/evidence; override keeps identity', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(await receiptUrl(root, 'receipt-m4-correct'));
      await expect(page.getByRole('heading', { name: 'Answer ans-m4-correct', exact: true })).toBeVisible({
        timeout: 15_000,
      });
      const lens = page.locator('#mode-lens');
      await expect(lens).toBeVisible();
      assert.equal(await lens.inputValue(), 'COMPARE');
      const history = await page.locator('#mode-history').innerText();
      assert.match(history, /EXPLAIN/, 'initial hypothesis EXPLAIN must stay visible after correction');
      assert.match(history, TOLERANT_CORRECTION);
      assert.ok(!TOLERANT_CONFIRM.test(history), 'EXPLAIN→COMPARE must be labelled a correction, not a confirmation');

      // COMPARE matrix cells carry the recorded values and per-cell evidence.
      const body = await appText(page);
      assert.match(body, /ReplicatedQueue/);
      assert.match(body, /LocalQueue/);
      assert.match(body, /12ms/);
      assert.match(body, /1ms/);
      assert.ok(
        (await dataIds(page.locator('#app'), 'evidence-id')).includes('ev-m4c-read-a') &&
          (await dataIds(page.locator('#app'), 'evidence-id')).includes('ev-m4c-read-b'),
        'matrix cells must link their recorded read evidence',
      );

      // Override identity: same evidence set under a different lens.
      const before = [...new Set(await dataIds(page.locator('#app'), 'evidence-id'))].sort();
      await lens.selectOption('EXPLAIN');
      await expect(page.locator('#mode-history')).toContainText('OVERRIDE', { timeout: 10_000 });
      const history2 = await page.locator('#mode-history').innerText();
      assert.match(history2, TOLERANT_OVERRIDE);
      const after = [...new Set(await dataIds(page.locator('#app'), 'evidence-id'))].sort();
      assert.deepEqual(after, before, 'lens override must preserve evidence identity');
      const served = await servedAnalysis(port, token, 'run-m4-correction', 'ans-m4-correct', 'EXPLAIN');
      assert.equal(served.lens.currentMode, 'EXPLAIN');
      assert.equal(served.lens.revisions.at(-1)?.phase, 'EXPLICIT_OVERRIDE');
      assert.equal(served.projection.mode, 'EXPLAIN');
      // Analyzer-side identity check: same claims/evidence as the default lens.
      const servedDefault = await servedAnalysis(port, token, 'run-m4-correction', 'ans-m4-correct');
      assert.deepEqual(
        servedDefault.evidence.map((e) => e.evidenceId).sort(),
        served.evidence.map((e) => e.evidenceId).sort(),
      );
      assert.equal(served.support.status, servedDefault.support.status);
    } finally {
      await context.close();
    }
  });

  it('Conflicts: unresolved DETECTED stays conflicting and visible; resolved keeps history and empties unresolved areas', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(await receiptUrl(root, 'receipt-m4-conflict'));
      await expect(page.getByRole('heading', { name: 'Answer ans-m4-conflict', exact: true })).toBeVisible({
        timeout: 15_000,
      });
      const unresolvedText = await appText(page);
      assert.match(unresolvedText, /CONFLICTING_EVIDENCE/);
      assert.ok(!/STRONGLY_SUPPORTED/.test(unresolvedText), 'unresolved conflict must not read as strongly supported');
      const unresolvedAreas = page.locator('#unresolved-areas');
      await expect(unresolvedAreas).toBeVisible();
      assert.match(
        await unresolvedAreas.innerText(),
        /conflict-m4f-contra|Vendor latency claim contradicts/,
        'unresolved areas must list the detected conflict',
      );
      const health = await page.locator('#health-ledger').innerText();
      assert.match(health, /conflict-m4f-contra/);
      assert.match(health, /Status:\s*DETECTED/i, 'unresolved conflict status must be DETECTED');
      assert.ok(
        !/\bStatus:\s*RESOLVED\b/i.test(health),
        'unresolved conflict status must never be RESOLVED',
      );

      // Resolved twin: resolution shown with its VERIFY event, history kept, unresolved areas empty.
      await page.goto(await receiptUrl(root, 'receipt-m4-resolved'));
      await expect(page.getByRole('heading', { name: 'Answer ans-m4-resolved', exact: true })).toBeVisible({
        timeout: 15_000,
      });
      const resolvedText = await appText(page);
      assert.match(resolvedText, /STRONGLY_SUPPORTED/);
      const health2 = await page.locator('#health-ledger').innerText();
      assert.match(health2, /conflict-m4r-contra/);
      assert.match(health2, /\bRESOLVED\b|resolved\b/i);
      assert.match(health2, /REFUTED/i);
      assert.match(health2, /m4r-verify/);
      const areas2 = await page.locator('#unresolved-areas').innerText();
      assert.ok(
        !/conflict-m4r-contra/.test(areas2),
        'a resolved conflict must not remain in the unresolved areas list',
      );
      // DETECTED→RESOLVED history preserved: both phases visible.
      const histDetails = page.locator('#details-conflict-hist-conflict-m4r-contra');
      await histDetails.locator('summary').click();
      const histText = await histDetails.innerText();
      assert.match(histText, /DETECTED/i, 'conflict history must preserve the detection');
      assert.match(histText, /RESOLVED/i, 'conflict history must show the resolution');
    } finally {
      await context.close();
    }
  });

  it('JEV advisory: labels shown, support never elevated; IDEATE branch statuses honest; baseless recommendation reads INSUFFICIENT', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(await receiptUrl(root, 'receipt-m4-jev'));
      await expect(page.getByRole('heading', { name: 'Answer ans-m4-jev', exact: true })).toBeVisible({
        timeout: 15_000,
      });
      const advisory = page.locator('#jev-advisory');
      await expect(advisory).toBeVisible();
      const advisoryText = await advisory.innerText();
      assert.match(advisoryText, /YES|NO|UNKNOWN/, 'JEV labels must be visible');
      const summary = await appText(page);
      assert.match(summary, /UNKNOWN/, 'answer with no claims keeps support UNKNOWN');
      assert.ok(
        !/STRONGLY_SUPPORTED|PARTIALLY_SUPPORTED/.test(summary),
        'JEV progress labels must never elevate evidence support',
      );
      // IDEATE branches: only the branch holding the latest event is ACTIVE.
      assert.match(summary, /branch-m4j-s1|branch/i);
      const graphText = await page.locator('#exploration-graph').innerText();
      for (const id of ['branch-m4j-s1', 'branch-m4j-s4']) {
        assert.ok(
          graphText.includes(id) || (await dataIds(page.locator('#exploration-graph'), 'node-id')).some((n) => n.includes(id)),
          `IDEATE branch ${id} must be visible`,
        );
      }
      assert.match(graphText, /UNKNOWN/i, 'non-final branches stay UNKNOWN');
      assert.match(graphText, /ACTIVE/i);
      assert.ok(!/DROPPED/i.test(graphText), 'branches without discard evidence must not be shown as dropped');

      // Baseless recommendation answer in the same run.
      await page.goto(await receiptUrl(root, 'receipt-m4-jevrec'));
      await expect(page.getByRole('heading', { name: 'Answer ans-m4-jev-rec', exact: true })).toBeVisible({
        timeout: 15_000,
      });
      const recText = await appText(page);
      assert.match(recText, /INSUFFICIENT_EVIDENCE/);
      const whyText = await page.locator('#why-answer').innerText();
      assert.ok(
        !/sub-millisecond|benchmark/i.test(whyText) || !whyText.includes('ev-m4j-vread'),
        'rationale must not be fabricated from the unlinked read',
      );
      const served = await servedAnalysis(port, token, 'run-m4-jev', 'ans-m4-jev');
      assert.equal(served.support.status, 'UNKNOWN');
      assert.equal(served.jevResults.length, 3);
      assert.ok(served.jevResults.every((r) => r.status === 'SUCCEEDED'));
      assert.ok(served.jevResults.every((r) => r.supportEffect === 'NONE'));
    } finally {
      await context.close();
    }
  });

  it('ASSESS freshness stays UNKNOWN without recorded publication dates', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(await receiptUrl(root, 'receipt-m4-assess'));
      await expect(page.getByRole('heading', { name: 'Answer ans-m4-assess', exact: true })).toBeVisible({
        timeout: 15_000,
      });
      const text = await appText(page);
      assert.match(
        text,
        /Freshness assessment:\s*UNKNOWN/i,
        'freshness assessment must be disclosed as UNKNOWN',
      );
      assert.ok(
        !/Freshness assessment:\s*(CURRENT|STALE)/i.test(text),
        'no publication dates were recorded: CURRENT/STALE would be fabricated',
      );
      const served = await servedAnalysis(port, token, 'run-m4-assess', 'ans-m4-assess');
      if (served.projection.mode !== 'ASSESS') assert.fail('expected ASSESS projection');
      assert.equal(served.projection.freshness, 'UNKNOWN');
    } finally {
      await context.close();
    }
  });

  it('Exploration graph: node/relation ids match the analyzer contract, provenance disclosed per relation, inferred dashed vs observed solid, selection works', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(await receiptUrl(root, 'receipt-m4-decide'));
      await expect(page.locator('#exploration-graph')).toBeVisible({ timeout: 15_000 });
      const nodeIds = await dataIds(page.locator('#exploration-graph'), 'node-id');
      for (const expected of ['node-activity-search', 'node-activity-read', 'node-query-m4d-search', 'node-branch-1-m4d-search']) {
        assert.ok(nodeIds.includes(expected), `graph must contain node ${expected}; got ${nodeIds.join(',')}`);
      }
      const relationEls = page.locator('#exploration-graph [data-relation-id]');
      const relationCount = await relationEls.count();
      assert.ok(relationCount > 0, 'graph must render relations with data-relation-id');

      // Cross-check every rendered relation's provenance against the served report.
      const served = await servedAnalysis(port, token, 'run-m4-decide', 'ans-m4-decide');
      const provenanceById = new Map<string, string>();
      for (const r of served.relations) provenanceById.set(r.relationId, r.provenance);
      for (const e of served.topology.edges) {
        provenanceById.set(e.edgeId, e.kind === 'INFERRED_BRANCH' ? 'VIEWTRACE_INFERRED' : 'VIEWTRACE_OBSERVED');
      }
      const laneOf = (p: string): string =>
        p === 'VIEWTRACE_OBSERVED' ? 'obs' : p === 'AGENT_REPORTED' ? 'rep' : p === 'VIEWTRACE_INFERRED' ? 'inf' : '?';
      let sawObserved = false;
      let sawInferred = false;
      const rendered = await relationEls.all();
      for (const el of rendered) {
        const rid = (await el.getAttribute('data-relation-id')) ?? '';
        const declared = (await el.getAttribute('data-provenance')) ?? '';
        const expected = provenanceById.get(rid);
        assert.ok(expected !== undefined, `rendered relation ${rid} must exist in the analyzer output`);
        assert.equal(declared, expected, `relation ${rid} data-provenance must equal the analyzer provenance`);
        const text = await el.innerText();
        assert.ok(
          text.toLowerCase().includes(laneOf(expected)),
          `relation ${rid} text must disclose its ${laneOf(expected)} lane`,
        );
        const styleHint = `${el.getAttribute('class') ?? ''}|${(await el.getAttribute('style')) ?? ''}`;
        const dashed = /dashed|dotted/i.test(styleHint) || /dashed|dotted/i.test(text);
        if (expected === 'VIEWTRACE_INFERRED') {
          assert.ok(dashed, `inferred relation ${rid} must be visually dashed`);
          sawInferred = true;
        } else {
          assert.ok(!dashed, `observed/reported relation ${rid} must not render as dashed`);
          if (expected === 'VIEWTRACE_OBSERVED') sawObserved = true;
        }
      }
      assert.ok(sawObserved && sawInferred, 'fixture must exercise both observed and inferred relations');

      // Selection: clicking a node marks exactly that node as selected.
      const target = page.locator('#exploration-graph [data-node-id="node-query-m4d-search"]');
      const markerBefore = await target.evaluate((n) => JSON.stringify({ ...(n as unknown as DomElement).dataset, cls: (n as unknown as DomElement).className }));
      await target.click();
      const markerAfter = await target.evaluate((n) => JSON.stringify({ ...(n as unknown as DomElement).dataset, cls: (n as unknown as DomElement).className }));
      assert.notEqual(markerBefore, markerAfter, 'clicking a graph node must select it (visible state change)');
    } finally {
      await context.close();
    }
  });

  it('answer switch isolation: two answers in one run never leak each other scoped content', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${base}/runs/run-m4-jev/answers/ans-m4-jev`);
      await expect(page.getByRole('heading', { name: 'Answer ans-m4-jev', exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator('#raw-events article, #raw-events [data-event-id]').first()).toBeVisible({
        timeout: 10_000,
      });
      const aEventIds = await dataIds(page.locator('#raw-events'), 'event-id');
      assert.ok(aEventIds.includes('m4j-s1') && aEventIds.includes('m4j-r3'), 'A scope must list its own 7 events');
      assert.ok(!aEventIds.includes('m4j-vread'), 'A scope must not include B-only events');

      await page.goto(`${base}/runs/run-m4-jev/answers/ans-m4-jev-rec`);
      await expect(page.getByRole('heading', { name: 'Answer ans-m4-jev-rec', exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator('#raw-events article, #raw-events [data-event-id]').first()).toBeVisible({
        timeout: 10_000,
      });
      const bEventIds = await dataIds(page.locator('#raw-events'), 'event-id');
      assert.deepEqual(
        bEventIds.filter((id) => id.startsWith('m4j-')).sort(),
        ['m4j-rec', 'm4j-vread'],
        'B scope must list exactly its own 2 events',
      );
      const bEvidence = await dataIds(page.locator('#app'), 'evidence-id');
      assert.ok(!bEvidence.includes('ev-m4j-s1'), 'switching answers must not leak the previous answer evidence');

      // And back again — A still complete.
      await page.goto(`${base}/runs/run-m4-jev/answers/ans-m4-jev`);
      await expect(page.getByRole('heading', { name: 'Answer ans-m4-jev', exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator('#raw-events article, #raw-events [data-event-id]').first()).toBeVisible({
        timeout: 10_000,
      });
      const aAgain = await dataIds(page.locator('#raw-events'), 'event-id');
      assert.deepEqual(
        aAgain.filter((id) => id.startsWith('m4j-')).sort(),
        ['m4j-r1', 'm4j-r2', 'm4j-r3', 'm4j-s1', 'm4j-s2', 'm4j-s3', 'm4j-s4'],
        'returning to A must restore its exact scope',
      );
    } finally {
      await context.close();
    }
  });
});
