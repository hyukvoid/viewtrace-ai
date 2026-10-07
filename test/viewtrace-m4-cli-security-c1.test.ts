/**
 * M4 CLI tests for C1 control character sanitation, live monitor delta updates,
 * and presentation boundary integrity (docs/MILESTONES.md §9).
 *
 * Verifies:
 *  - C1 CSI (\u009b) and OSC (\u009d) sequences as well as all C1 controls
 *    (\u0080-\u009f) are thoroughly stripped or sanitized.
 *  - Live monitor shows authoritative support, lens, concentration, source,
 *    and JEV updates as they occur.
 *  - Terminal report includes actual selected answer identity.
 *  - Piped non-TTY output remains clean, deterministic, and injection-free.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { sanitizeForTerminal } from '../src/viewtrace/display.js';
import { ExplorationTreeSession } from '../src/viewtrace/presentation/tree.js';
import { runMonitor } from '../src/viewtrace/presentation/monitor.js';
import { ViewTraceStore } from '../src/viewtrace/store.js';
import { ingestFile } from '../src/viewtrace/ingest.js';
import { cliDist } from './helpers/viewtrace.js';
import type { AnalysisReportV1, TopologyNode } from '../src/viewtrace/analysis-types.js';

const exec = promisify(execFile);
const C0_C1_ESCAPE_PATTERN = /[\u001b\u0007\u009b\u009d\u0080-\u009f]/;

async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliDist, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
  }
}

function makeSyntheticReport(overrides: Partial<AnalysisReportV1> = {}): AnalysisReportV1 {
  const basis = { ruleId: 'r1', ruleVersion: '1.0', inputAnchors: [], limitations: [] };
  return {
    schema: 'viewtrace.analysis-report@1',
    captureSchemaVersion: 1,
    analyzer: { analyzerId: 'a1', analyzerVersion: '1.0', ruleSetVersion: '1.0' },
    inputRevision: { algorithm: 'sha256-canonical-schema1-records-v1', value: 'rev-001', recordCount: 3 },
    stateRevision: 'state-001',
    freshness: { status: 'CURRENT', reasons: [] },
    scope: { runId: 'run-sec', answerId: 'ans-sec', receiptId: 'rec-sec', boundary: 'EXACT' },
    lens: { revisions: [], currentRevisionId: 'none', currentMode: 'UNKNOWN', temporal: 'NONE' },
    projection: { mode: 'UNKNOWN', overviewClaimIds: [], unresolvedReasonIds: [] },
    conditions: [],
    sources: [],
    evidence: [],
    claims: [],
    relations: [],
    conflicts: [],
    verifications: [],
    support: {
      status: 'UNKNOWN',
      collectionCompleteness: 'COMPLETE',
      coreClaimIds: [],
      evaluatedClaimIds: [],
      missingRequiredConditionIds: [],
      unresolvedConflictIds: [],
      reasonCodes: ['TARGET_UNKNOWN'],
      basis,
    },
    topology: {
      nodes: [],
      edges: [],
      frontierStatus: 'OBSERVED',
      currentFrontierNodeIds: [],
      activityConcentration: [
        { numerator: 1, denominator: 2, excluded: 0, unit: 'EVENTS', meaning: 'OBSERVED_ACTIVITY_SHARE' },
      ],
      sourceConcentration: [
        { numerator: 1, denominator: 1, excluded: 0, unit: 'SOURCES', meaning: 'SOURCE_SHARE' },
      ],
      limitations: [],
    },
    references: [],
    jevResults: [],
    ...overrides,
  };
}

describe('M4 CLI: C1 control character sanitization', () => {
  it('strips C1 CSI (U+009B) and C1 OSC (U+009D) control sequences', () => {
    const csi = 'hello \u009b2Jworld';
    assert.equal(sanitizeForTerminal(csi), 'hello world');

    const osc = 'status \u009d0;malicious-title\u0007ok';
    assert.equal(sanitizeForTerminal(osc), 'status ok');

    const rawC1 = 'item \u0085 next \u009b31mred\u009b0m text';
    const sanitized = sanitizeForTerminal(rawC1);
    assert.ok(!C0_C1_ESCAPE_PATTERN.test(sanitized), `no C0/C1 bytes left: ${sanitized}`);
    assert.equal(sanitized, 'item next red text');
  });

  it('preserves valid unicode content (Korean, accented text) while removing C1 controls', () => {
    const korean = '리서치 \u009b2J근거와 \u009dtitle\u0007추적';
    const sanitized = sanitizeForTerminal(korean);
    assert.equal(sanitized, '리서치 근거와 추적');
    assert.ok(!C0_C1_ESCAPE_PATTERN.test(sanitized));
  });

  it('sanitizes planted C1 controls through the public bin in analyze and monitor commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vt-m4-c1-'));
    const runId = 'run-c1-test';
    const fixture = join(root, 'c1-input.jsonl');
    const records = [
      {
        schemaVersion: 1,
        recordKind: 'run',
        runId,
        lifecycle: 'RUNNING',
        occurredAt: '2026-10-07T04:00:00Z',
        adapterId: 'viewtrace-reference-jsonl',
        adapterVersion: '1.0.0',
      },
      {
        schemaVersion: 1,
        recordKind: 'event',
        eventId: 's1',
        runId,
        type: 'SEARCH',
        occurredAt: '2026-10-07T04:00:01Z',
        adapterId: 'viewtrace-reference-jsonl',
        adapterVersion: '1.0.0',
        origin: { producer: 'c1-producer' },
        source: { sourceId: 'src-1', kind: 'URL', location: 'https://example.test' },
        provenance: { category: 'VIEWTRACE_OBSERVED' },
        payload: {
          type: 'SEARCH',
          query: 'search \u009b2Jinject\u009dtitle\u0007 test',
          results: [],
        },
      },
      {
        schemaVersion: 1,
        recordKind: 'answer',
        receiptVersion: 1,
        receiptId: 'rec-c1',
        runId,
        agentId: 'ref-agent',
        answerId: 'ans-c1',
        answer: 'Final answer with \u009b1mBOLD\u009b0m text.',
        final: true,
        timestamp: '2026-10-07T04:00:02Z',
        occurredAt: '2026-10-07T04:00:02Z',
        adapterId: 'viewtrace-reference-jsonl',
        adapterVersion: '1.0.0',
        eventIds: ['s1'],
      },
      {
        schemaVersion: 1,
        recordKind: 'run',
        runId,
        lifecycle: 'COMPLETED',
        occurredAt: '2026-10-07T04:00:03Z',
        adapterId: 'viewtrace-reference-jsonl',
        adapterVersion: '1.0.0',
      },
    ];

    await writeFile(fixture, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const ingest = await runCli(['ingest', fixture, '--data-root', root]);
    assert.equal(ingest.code, 0, ingest.stderr);

    const analyze = await runCli(['analyze', runId, '--data-root', root]);
    assert.equal(analyze.code, 0, analyze.stderr);
    assert.ok(!C0_C1_ESCAPE_PATTERN.test(analyze.stdout), 'analyze output contains no C0/C1/escape chars');
    assert.ok(analyze.stdout.includes('Final answer with BOLD text'));

    const monitor = await runCli([
      'monitor', runId, '--interval', '20', '--max-wait', '4000', '--data-root', root,
    ]);
    assert.equal(monitor.code, 0, monitor.stderr);
    assert.ok(!C0_C1_ESCAPE_PATTERN.test(monitor.stdout), 'monitor output contains no C0/C1/escape chars');
    assert.match(monitor.stdout, /monitor: stopped \(terminal and stable\) for answer ans-c1/);
  });
});

describe('M4 CLI: Live monitor delta reporting', () => {
  it('emits authoritative support, lens, concentration, and JEV updates in live tree sessions', () => {
    const session = new ExplorationTreeSession({ runId: 'run-sec', answerId: 'ans-sec' });
    const initial = makeSyntheticReport({
      support: {
        status: 'STRONGLY_SUPPORTED',
        collectionCompleteness: 'COMPLETE',
        coreClaimIds: ['c1'],
        evaluatedClaimIds: ['c1'],
        missingRequiredConditionIds: [],
        unresolvedConflictIds: [],
        reasonCodes: ['ALL_CORE_CLAIMS_SUPPORTED'],
        basis: { ruleId: 'r1', ruleVersion: '1.0', inputAnchors: [], limitations: [] },
      },
      lens: {
        revisions: [{ revisionId: 'rev-1', mode: 'DECIDE', phase: 'OBSERVED_CONFIRMATION', source: 'OBSERVED_EVENTS', basis: { ruleId: 'r', ruleVersion: '1', inputAnchors: [], limitations: [] } }],
        currentRevisionId: 'rev-1',
        currentMode: 'DECIDE',
        temporal: 'NONE',
      },
      jevResults: [
        {
          schema: 'viewtrace.jev-result@2',
          resultId: 'jev-1',
          checkpointId: 'ck-branch-1',
          inputRevision: { algorithm: 'sha256-canonical-schema1-records-v1', value: 'rev-001', recordCount: 3 },
          evaluator: { provider: 'local-stub', evaluatorVersion: '2.0' },
          status: 'SUCCEEDED',
          labels: { evidenceGain: 'YES', progress: 'YES', rethinkNeeded: 'NO' },
          provenance: 'EVALUATOR_REPORTED',
          supportEffect: 'NONE',
          limitations: [],
        },
      ],
      sources: [
        {
          canonicalSourceId: 'src-alpha',
          capturedSourceIds: ['src-alpha'],
          kind: 'URL',
          identityStatus: 'MATCHED',
          location: 'https://example.test',
          roles: [],
          queries: [],
          anchors: [],
        },
      ],
    });

    const lines = session.update(initial);
    const text = lines.join('\n');
    assert.ok(text.includes('support: STRONGLY_SUPPORTED (ALL_CORE_CLAIMS_SUPPORTED)'), 'authoritative support reported');
    assert.ok(text.includes('mode lens: DECIDE [OBSERVED_CONFIRMATION]'), 'mode lens reported');
    assert.ok(text.includes('activity share: 1/2 unit=EVENTS'), 'activity concentration reported');
    assert.ok(text.includes('+ source src-alpha [URL] identity=MATCHED'), 'source addition reported');
    assert.ok(text.includes('JEV ck-branch-1 [SUCCEEDED] evidenceGain=YES progress=YES rethinkNeeded=NO (advisory)'), 'JEV advisory reported');

    // Re-delivering exact same report emits NOTHING (dedup)
    const duplicate = session.update(initial);
    assert.deepEqual(duplicate, []);

    // Updating support status emits an updated support line
    const updated = session.update(
      makeSyntheticReport({
        inputRevision: { algorithm: 'sha256-canonical-schema1-records-v1', value: 'rev-002', recordCount: 4 },
        support: {
          status: 'CONFLICTING_EVIDENCE',
          collectionCompleteness: 'COMPLETE',
          coreClaimIds: ['c1'],
          evaluatedClaimIds: ['c1'],
          missingRequiredConditionIds: [],
          unresolvedConflictIds: ['conf-1'],
          reasonCodes: ['UNRESOLVED_CORE_CONFLICT'],
          basis: { ruleId: 'r1', ruleVersion: '1.0', inputAnchors: [], limitations: [] },
        },
      }),
    );
    assert.ok(
      updated.some((l) => l.includes('support updated: CONFLICTING_EVIDENCE (UNRESOLVED_CORE_CONFLICT)')),
      'support update emitted on change',
    );
  });

  it('includes selected answer identity in monitor completion output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vt-m4-ans-id-'));
    const runId = 'run-ans-identity';
    const fixture = join(root, 'ans-id.jsonl');
    const records = [
      {
        schemaVersion: 1,
        recordKind: 'run',
        runId,
        lifecycle: 'RUNNING',
        occurredAt: '2026-10-07T05:00:00Z',
        adapterId: 'viewtrace-reference-jsonl',
        adapterVersion: '1.0.0',
      },
      {
        schemaVersion: 1,
        recordKind: 'answer',
        receiptVersion: 1,
        receiptId: 'rec-pinned-1',
        runId,
        agentId: 'ref-agent',
        answerId: 'ans-pinned-first',
        answer: 'Pinned answer.',
        final: true,
        timestamp: '2026-10-07T05:00:01Z',
        occurredAt: '2026-10-07T05:00:01Z',
        adapterId: 'viewtrace-reference-jsonl',
        adapterVersion: '1.0.0',
        eventIds: [],
      },
      {
        schemaVersion: 1,
        recordKind: 'run',
        runId,
        lifecycle: 'COMPLETED',
        occurredAt: '2026-10-07T05:00:02Z',
        adapterId: 'viewtrace-reference-jsonl',
        adapterVersion: '1.0.0',
      },
    ];

    await writeFile(fixture, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const ingest = await runCli(['ingest', fixture, '--data-root', root]);
    assert.equal(ingest.code, 0, ingest.stderr);

    const monitor = await runCli([
      'monitor', runId, '--interval', '20', '--max-wait', '4000', '--data-root', root,
    ]);
    assert.equal(monitor.code, 0, monitor.stderr);
    assert.match(monitor.stdout, /monitor: stopped \(terminal and stable\) for answer ans-pinned-first/);

    const monitorJson = await runCli([
      'monitor', runId, '--interval', '20', '--max-wait', '4000', '--json', '--data-root', root,
    ]);
    assert.equal(monitorJson.code, 0, monitorJson.stderr);
    const finalEvent = monitorJson.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((e) => e.type === 'monitor-final');
    assert.ok(finalEvent !== undefined);
    assert.equal(finalEvent.answerId, 'ans-pinned-first');
  });
});
