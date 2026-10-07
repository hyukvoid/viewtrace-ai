import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startReportServer } from '../src/viewtrace/server.js';
import { ViewTraceStore } from '../src/viewtrace/store.js';
import { ingestFile } from '../src/viewtrace/ingest.js';
import { answerReport } from '../src/viewtrace/report.js';
import { M3_ANALYSIS_REPORT_SCHEMA } from '../src/viewtrace/analysis-types.js';
import { tempDataRoot, viewtraceFixture, cliDist } from './helpers/viewtrace.js';
import { request } from './helpers/m2.js';

const exec = promisify(execFile);

async function runCliBin(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliDist, ...args], {
      env: { ...process.env, ...env },
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
  }
}

describe('M3 Server API & CLI Integration', () => {
  it('serves GET /api/runs/:runId/answers/:answerId/analysis via report server', async () => {
    const root = await tempDataRoot('analysis-server-integration');
    await ingestFile(viewtraceFixture('analysis-5-states.jsonl'), { dataRoot: root });

    const store = await ViewTraceStore.open({ dataRoot: root });
    const server = await startReportServer(store, { port: 0, bootId: 'test-boot-m3' });
    const headers = { authorization: `Bearer ${server.token}` };

    try {
      // 1. Valid request to strong answer
      const res = await request(
        server.port,
        '/api/runs/run-state-strong/answers/ans-strong/analysis',
        { headers },
      );
      assert.equal(res.status, 200);
      const json = res.json as any;
      assert.equal(json.schema, M3_ANALYSIS_REPORT_SCHEMA);
      assert.equal(json.support.status, 'STRONGLY_SUPPORTED');
      assert.equal(json.claims.length, 2);

      // 2. Query param ?mode= override
      const resOverride = await request(
        server.port,
        '/api/runs/run-state-strong/answers/ans-strong/analysis?mode=ASSESS',
        { headers },
      );
      assert.equal(resOverride.status, 200);
      const jsonOverride = resOverride.json as any;
      assert.equal(jsonOverride.lens.currentMode, 'ASSESS');
      assert.equal(jsonOverride.projection.mode, 'ASSESS');
      // Evidence support and claims remain invariant
      assert.equal(jsonOverride.support.status, 'STRONGLY_SUPPORTED');

      // 3. Unauthorized request
      const unauth = await request(
        server.port,
        '/api/runs/run-state-strong/answers/ans-strong/analysis',
      );
      assert.equal(unauth.status, 401);

      // 4. Unknown answer
      const notFound = await request(
        server.port,
        '/api/runs/run-state-strong/answers/ans-nonexistent/analysis',
        { headers },
      );
      assert.equal(notFound.status, 404);
    } finally {
      await server.close();
      store.close();
    }
  });

  it('executes viewtrace analyze CLI command in text and json modes', async () => {
    const root = await tempDataRoot('analysis-cli-integration');
    await ingestFile(viewtraceFixture('analysis-5-states.jsonl'), { dataRoot: root });

    // 1. Text mode CLI analyze
    const { stdout: textOut, code: codeText } = await runCliBin([
      'analyze',
      'run-state-strong',
      '--data-root',
      root,
    ]);
    assert.equal(codeText, 0);
    assert.ok(textOut.includes('Analysis Report'));
    assert.ok(textOut.includes('ans-strong'));
    assert.ok(textOut.includes('STRONGLY_SUPPORTED'));

    // 2. JSON mode CLI analyze
    const { stdout: jsonOut, code: codeJson } = await runCliBin([
      'analyze',
      'run-state-strong',
      '--json',
      '--data-root',
      root,
    ]);
    assert.equal(codeJson, 0);
    const parsed = JSON.parse(jsonOut.trim());
    assert.equal(parsed.schema, M3_ANALYSIS_REPORT_SCHEMA);
    assert.equal(parsed.support.status, 'STRONGLY_SUPPORTED');
  });

  it('updates answerReport evidenceSupport when stored analysis exists', async () => {
    const root = await tempDataRoot('report-evidence-support');
    await ingestFile(viewtraceFixture('analysis-5-states.jsonl'), { dataRoot: root });
    const store = await ViewTraceStore.open({ dataRoot: root });

    try {
      // Prior to analysis report stored:
      const beforeRep = answerReport(store, 'run-state-strong', 'ans-strong');
      assert.ok(beforeRep);

      // Run analyze CLI to store report:
      const { code } = await runCliBin(['analyze', 'run-state-strong', '--data-root', root]);
      assert.equal(code, 0);

      // After analysis stored:
      const afterRep = answerReport(store, 'run-state-strong', 'ans-strong');
      assert.ok(afterRep);
      assert.equal(afterRep.evidenceSupport, 'STRONGLY_SUPPORTED');
    } finally {
      store.close();
    }
  });
});
