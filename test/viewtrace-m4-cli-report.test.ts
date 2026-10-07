/**
 * M4 CLI integration tests over the public bin and a real SQLite store
 * (docs/MILESTONES.md §9): the answer analyze rendering, lens selection,
 * honest absence, the optional monitor, and terminal-injection safety when
 * piped (non-TTY). All fixtures are synthetic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { cliDist, viewtraceFixture } from './helpers/viewtrace.js';

const exec = promisify(execFile);
const ESC = /[\u001b\u0007]/;
const CONTROLS = /[\x00-\x08\x0b-\x1f]/;

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliDist, ...args], {
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
  }
}

async function seededRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vt-m4-report-'));
  for (const fixture of ['analysis-5-states.jsonl', 'analysis-7-modes.jsonl', 'jev-checkpoints.jsonl', 'research-normal.jsonl']) {
    const ingest = await runCli(['ingest', viewtraceFixture(fixture), '--data-root', root]);
    assert.equal(ingest.code, 0, ingest.stderr);
  }
  return root;
}

function assertNoTerminalInjection(out: string, label: string): void {
  for (const line of out.split('\n')) {
    assert.ok(!ESC.test(line), `${label}: no ESC/bel bytes may appear: ${JSON.stringify(line)}`);
    assert.ok(!CONTROLS.test(line), `${label}: no control chars: ${JSON.stringify(line)}`);
  }
}

describe('M4 CLI: analyze renders the answer-first report over real SQLite', () => {
  it('prints support, lanes, rail, concentration denominators/units, source ledger, JEV and collection status', async () => {
    const root = await seededRoot();
    const { stdout, code } = await runCli(['analyze', 'run-state-conflicting', '--data-root', root]);
    assert.equal(code, 0);
    assert.ok(stdout.includes('Analysis Report [viewtrace.analysis-report@1]'));
    assert.ok(stdout.includes('Answer: ans-conflicting'));
    assert.ok(stdout.includes('Support: CONFLICTING_EVIDENCE (UNRESOLVED_CORE_CONFLICT)'));
    assert.match(stdout, /Lanes: obs:\d+  rep:\d+  inf:\d+  \?:\d+/);
    assert.ok(stdout.includes('rail CONFLICT conflict-ev-conf-contra [DETECTED] conditionMatch=SAME'), 'rail prints the conflict');
    assert.ok(stdout.includes('? unresolved'), 'unresolved conflict carries the ? deficit marker');
    assert.match(stdout, /activity share: \d+\/\d+ unit=EVENTS \(OBSERVED_ACTIVITY_SHARE; excluded \d+/);
    assert.match(stdout, /source share: \d+\/\d+ unit=SOURCES \(SOURCE_SHARE/);
    assert.ok(stdout.includes('Source Ledger:'));
    assert.ok(stdout.includes('identity=MATCHED'), 'source identity status is shown');
    assert.ok(stdout.includes('published=UNKNOWN'), 'absent publication dates stay UNKNOWN');
    assert.ok(stdout.includes('JEV v2 advisory checkpoints:'), 'JEV advisory section present');
    assert.ok(stdout.includes('advisory only — never an input to evidence support'));
    assert.ok(stdout.includes('collection: lifecycle=COMPLETED completeness=COMPLETE'));
    assert.match(stdout, /sequence: max=\d+ accepted events=\d+ \(answer-scoped: \d+ records\)/);
    assert.match(stdout, /rejected\/validation errors: \d+ losses: \d+ diagnostics total: \d+/);
    assert.match(stdout, /replay: trace\.jsonl lines=\d+ cursor=\d+ \(derived export; database is authoritative\)/);
    assert.ok(stdout.includes(`storage: ${root}`), 'storage line names the data root');
    assert.match(stdout, /Latency: observed span \d+ms \(CAPTURED_EVENT_TIMESTAMPS/);
    assert.ok(stdout.includes('frontier [OBSERVED]:'), 'honest frontier line');
    assert.ok(stdout.includes('not agent intent'));
    assert.ok(stdout.includes('not hidden reasoning'));
    assertNoTerminalInjection(stdout, 'analyze text');
  });

  it('is deterministic and ANSI-free when piped (non-TTY output is the same contract)', async () => {
    const root = await seededRoot();
    const first = await runCli(['analyze', 'run-state-conflicting', '--data-root', root]);
    const second = await runCli(['analyze', 'run-state-conflicting', '--data-root', root]);
    assert.equal(first.code, 0);
    assert.equal(second.code, 0);
    assert.equal(first.stdout, second.stdout, 'piped output is stable across runs');
    assert.ok(!first.stdout.includes('\u001b['), 'no ANSI escapes in piped output');
  });

  it('exposes lens selection via --mode: override changes the projection, never the evidence', async () => {
    const root = await seededRoot();
    const baseline = await runCli(['analyze', 'run-mode-explain', '--data-root', root, '--json']);
    assert.equal(baseline.code, 0);
    const baselineJson = JSON.parse(baseline.stdout) as {
      lens: { currentMode: string; revisions: { phase: string }[] };
      projection: { mode: string };
      support: { status: string };
      claims: { claimId: string }[];
      evidence: { evidenceId: string }[];
    };
    assert.equal(baselineJson.lens.currentMode, 'EXPLAIN');

    const overridden = await runCli([
      'analyze', 'run-mode-explain', '--mode', 'ASSESS', '--data-root', root, '--json',
    ]);
    assert.equal(overridden.code, 0);
    const overrideJson = JSON.parse(overridden.stdout) as typeof baselineJson;
    assert.equal(overrideJson.lens.currentMode, 'ASSESS');
    assert.equal(overrideJson.projection.mode, 'ASSESS');
    assert.equal(
      overrideJson.support.status,
      baselineJson.support.status,
      'lens override must not change evidence support',
    );
    assert.deepEqual(overrideJson.claims, baselineJson.claims, 'claims and evidence identity are preserved');
    assert.deepEqual(overrideJson.evidence, baselineJson.evidence);

    const text = await runCli(['analyze', 'run-mode-explain', '--mode', 'ASSESS', '--data-root', root]);
    assert.equal(text.code, 0);
    assert.ok(text.stdout.includes('Mode: ASSESS [EXPLICIT_OVERRIDE]'));
    assert.ok(text.stdout.includes('explicit override: lens selection only — evidence, scope and provenance unchanged'));
    assertNoTerminalInjection(text.stdout, 'analyze override text');
  });

  it('reports honest absence for a run without answer receipts', async () => {
    const root = await seededRoot();
    const missing = await runCli(['analyze', 'research-normal-001', '--data-root', root]);
    assert.equal(missing.code, 1);
    assert.ok(missing.stderr.includes('no answer receipts'), 'absent answer is explained, not invented');
    assert.ok(missing.stdout.length === 0, 'no report is printed without an answer');
  });
});

describe('M4 CLI: optional live monitor over the public bin', () => {
  it('renders tree deltas and stops on a terminal, stable run', async () => {
    const root = await seededRoot();
    const { stdout, code } = await runCli([
      'monitor', 'run-mode-ideate', '--interval', '20', '--max-wait', '8000', '--data-root', root,
    ]);
    assert.equal(code, 0);
    assert.ok(stdout.includes('association: latest receipt in run (auto-selected for analysis; not an exact reveal match)'));
    assert.ok(stdout.includes('exploration tree [run run-mode-ideate answer ans-mode-ideate]'));
    assert.ok(stdout.includes('+-- [inf] branch node-branch-4-ev-id-s4'), 'branch nodes render');
    assert.ok(stdout.includes('lane=inf dashed'), 'relation lines carry lanes and style');
    assert.ok(stdout.includes('frontier [OBSERVED]: node-activity-search, node-branch-4-ev-id-s4'));
    assert.ok(stdout.includes('monitor: stopped (terminal and stable)'));
    assert.ok(stdout.includes('status: run run-mode-ideate COMPLETED / completeness=COMPLETE'));
    assertNoTerminalInjection(stdout, 'monitor text');
  });

  it('emits parseable JSON lines with deduped status and a final record', async () => {
    const root = await seededRoot();
    const { stdout, code } = await runCli([
      'monitor', 'run-mode-ideate', '--interval', '20', '--max-wait', '8000', '--json', '--data-root', root,
    ]);
    assert.equal(code, 0);
    const events = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; lines?: string[] });
    assert.ok(events.some((e) => e.type === 'monitor-start'));
    const statusEvents = events.filter((e) => e.type === 'monitor-status');
    assert.equal(statusEvents.length, 1, 'status is emitted once for a static run (dedup)');
    const tree = events.filter((e) => e.type === 'monitor-tree');
    assert.equal(tree.length, 1, 'tree is emitted once for a static run');
    assert.ok((tree[0]?.lines ?? []).some((l) => l.includes('node-branch-4-ev-id-s4')));
    const final = events.at(-1);
    assert.equal(final?.type, 'monitor-final');
    for (const e of events) {
      for (const line of e.lines ?? []) {
        assert.ok(!ESC.test(line), `json tree lines are sanitized: ${JSON.stringify(line)}`);
      }
    }
  });

  it('validates usage and unknown runs like the other query commands', async () => {
    const root = await seededRoot();
    assert.equal((await runCli(['monitor', 'no-such-run', '--data-root', root])).code, 1);
    assert.equal((await runCli(['monitor', 'run-mode-ideate', '--interval', '5', '--data-root', root])).code, 2);
    assert.equal((await runCli(['monitor', 'run-mode-ideate', '--mode', 'NOPE', '--data-root', root])).code, 2);
    assert.equal((await runCli(['monitor', '--data-root', root])).code, 2);
  });
});

describe('M4 CLI: terminal injection through stored producer content', () => {
  it('sanitizes escape sequences planted in queries, claims and answer summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vt-m4-inject-'));
    const runId = 'run-inject';
    const base = {
      schemaVersion: 1,
      runId,
      occurredAt: '2026-10-07T02:00:00Z',
      adapterId: 'viewtrace-reference-jsonl',
      adapterVersion: '1.0.0',
      origin: { producer: 'synthetic-injector' },
    };
    const lines = [
      JSON.stringify({ ...base, recordKind: 'run', lifecycle: 'RUNNING' }),
      JSON.stringify({
        ...base,
        recordKind: 'event',
        eventId: 'ev-inj-search',
        type: 'SEARCH',
        source: { sourceId: 'src-inj', kind: 'URL', location: 'https://example.test/inject' },
        provenance: { category: 'VIEWTRACE_OBSERVED', observed: { toolCallId: 'c1' } },
        payload: { type: 'SEARCH', query: 'q\u001b[31mRED\u001b[0m\u0007\r\ninject search', results: [] },
      }),
      JSON.stringify({
        ...base,
        recordKind: 'event',
        eventId: 'ev-inj-claim',
        type: 'CLAIM',
        source: { sourceId: 'src-inj', kind: 'URL', location: 'https://example.test/inject' },
        provenance: { category: 'AGENT_REPORTED' },
        payload: { type: 'CLAIM', text: 'claim\u001b]0;owned-title\u0007 with escape' },
      }),
      JSON.stringify({
        ...base,
        recordKind: 'answer',
        receiptVersion: 1,
        receiptId: 'rec-inject',
        agentId: 'reference-agent',
        answerId: 'ans-inject',
        answer: 'Answer.',
        final: true,
        timestamp: '2026-10-07T02:00:01Z',
        questionSummary: 'injected\u001b[31mQ\u001b[0m',
      }),
      JSON.stringify({ ...base, recordKind: 'run', lifecycle: 'COMPLETED' }),
    ];
    const fixture = join(root, 'inject.jsonl');
    await writeFile(fixture, lines.join('\n') + '\n', 'utf8');
    const ingest = await runCli(['ingest', fixture, '--data-root', root]);
    assert.equal(ingest.code, 0, ingest.stderr);

    const analyze = await runCli(['analyze', runId, '--data-root', root]);
    assert.equal(analyze.code, 0, analyze.stderr);
    assert.ok(analyze.stdout.includes('RED'), 'sanitized query content stays visible');
    assertNoTerminalInjection(analyze.stdout, 'analyze over injected fixture');
    assert.ok(
      !analyze.stdout.split('\n').some((l) => /^inject search/.test(l)),
      'injected content must not forge its own display line',
    );

    const monitor = await runCli([
      'monitor', runId, '--interval', '20', '--max-wait', '8000', '--data-root', root,
    ]);
    assert.equal(monitor.code, 0, monitor.stderr);
    assertNoTerminalInjection(monitor.stdout, 'monitor over injected fixture');
  });
});
