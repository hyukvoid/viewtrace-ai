import { it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringifyForTerminal } from '../src/viewtrace/display.js';
import { ViewTraceStore } from '../src/viewtrace/store.js';
import { answerAnalysisReport } from '../src/viewtrace/report.js';
import { runBin } from './helpers/m1.js';
import { makeEvent, makeRunRecord, tempDataRoot } from './helpers/viewtrace.js';
import { receipt } from './helpers/m2.js';

it('M4 terminal JSON escapes C1 while preserving every decoded M3 report value', async () => {
  const controlled = { text: '한글\u009b2J\u009dtitle\u009c\u001b[31m' };
  const encoded = stringifyForTerminal(controlled);
  assert.ok(!/[\u001b\u007f-\u009f]/.test(encoded));
  assert.deepEqual(JSON.parse(encoded), controlled);
  const invalidMode = await runBin(['monitor', 'run-terminal-json', '--mode', '\u009b2JINVALID\u001b[31m']);
  assert.equal(invalidMode.code, 2);
  assert.match(invalidMode.stderr, /invalid --mode/);
  assert.ok(!/[\u001b\u007f-\u009f]/.test(invalidMode.stderr));

  const root = await tempDataRoot('terminal-json');
  const runId = 'run-terminal-json';
  const search = makeEvent({ runId, eventId: 'json-search',
    payload: { type: 'SEARCH', query: 'Search \u009b2Junicode \u009dtitle\u009c', results: [] },
  });
  const input = join(root, 'terminal.jsonl');
  await writeFile(input, [makeRunRecord({ runId }), search,
    receipt({ runId, receiptId: 'json-receipt', answerId: 'json-answer', eventIds: [search.eventId],
      sequence: 3, receivedAt: '2026-10-07T00:00:00Z' }),
    makeRunRecord({ runId, lifecycle: 'COMPLETED' }),
  ].map((record) => JSON.stringify(record)).join('\n') + '\n');
  const ingest = await runBin(['ingest', input, '--data-root', root]);
  assert.equal(ingest.code, 0, ingest.stderr);
  const analyzed = await runBin(['analyze', runId, '--answer', 'json-answer', '--json', '--data-root', root]);
  assert.equal(analyzed.code, 0, analyzed.stderr);
  assert.ok(!/[\u001b\u007f-\u009f]/.test(analyzed.stdout));
  const store = await ViewTraceStore.open({ dataRoot: root });
  try {
    const authoritative = await answerAnalysisReport(store, runId, 'json-answer');
    assert.deepEqual(JSON.parse(analyzed.stdout), authoritative, 'JSON escaping preserves the authoritative analyzer contract');
  } finally {
    store.close();
  }
});
