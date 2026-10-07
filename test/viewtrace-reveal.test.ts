import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runBin, upService, downService, writeProducer, producerHeader, parseRunJson } from './helpers/m1.js';
import { tempDataRoot, viewtraceFixture, sha256File, repoRoot, cliDist } from './helpers/viewtrace.js';
import { request } from './helpers/m2.js';
import { readServiceFile } from '../src/viewtrace/servestate.js';
import { launchBrowser } from '../src/viewtrace/reveal.js';

const exec = promisify(execFile);
describe('M2 public bin -> receipt -> reveal -> actual HTTP -> down', () => {
  it('captures finalized reference A1/A2/A3; context/hash mismatch/legacy use picker; selected target never becomes latest', async () => {
    const root = await tempDataRoot('reveal-e2e');
    const checksum = await sha256File(viewtraceFixture('answer-multi-turn.jsonl'));
    await upService(root);
    try {
      const records = (await readFile(viewtraceFixture('answer-multi-turn.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const producer = await writeProducer(
        root,
        'multi.mjs',
        `const records=${JSON.stringify(records)};for(const record of records){record.runId=process.env.VIEWTRACE_RUN_ID;process.stdout.write(JSON.stringify(record)+'\\n');}`,
      );
      const capture = await runBin(['run', '--data-root', root, '--json', '--', process.execPath, producer]);
      assert.equal(capture.code, 0, capture.stderr);
      const summary = parseRunJson(capture.stdout).summary!;
      assert.equal(summary['eventsAccepted'], 4);
      const info = (await readServiceFile(root))!;
      const headers = { authorization: `Bearer ${info.reportToken}` };
      for (let i = 1; i <= 3; i++) {
        const result = await runBin([
          '--agent',
          'reference-agent',
          '--session',
          'session-1',
          '--turn',
          `turn-${i}`,
          '--data-root',
          root,
          '--json',
          '--url-only',
        ]);
        assert.equal(result.code, 0, result.stderr);
        const reveal = JSON.parse(result.stdout) as {
          url: string;
          resolution: {
            status: string;
            receipt: { answerId: string; runId: string };
          };
        };
        assert.equal(reveal.resolution.status, 'matched');
        assert.equal(reveal.resolution.receipt.answerId, `A${i}`);
        const url = new URL(reveal.url);
        assert.ok(url.pathname.endsWith(`/answers/A${i}`));
        const detail = await request<{
          receipt: { answerId: string };
          scope: { eventCount: number };
        }>(info.reportPort!, `/api${url.pathname}`, { headers });
        assert.equal(detail.json.receipt.answerId, `A${i}`);
        assert.equal(detail.json.scope.eventCount, 2);
      }
      const noContext = JSON.parse(
        (
          await runBin(['--data-root', root, '--json', '--url-only'], {
            cwd: root,
          })
        ).stdout,
      ) as {
        url: string;
        resolution: { status: string };
        candidates: { answers: unknown[] };
      };
      assert.equal(new URL(noContext.url).pathname, '/');
      assert.equal(noContext.resolution.status, 'uncertain');
      assert.equal(noContext.candidates.answers.length, 3);
      const bad = JSON.parse(
        (await runBin(['--receipt', 'receipt-A1', '--turn', 'turn-2', '--data-root', root, '--json'])).stdout,
      ) as { url: string; resolution: { status: string } };
      assert.equal(bad.resolution.status, 'mismatch');
      assert.equal(new URL(bad.url).pathname, '/');
      await runBin(['ingest', viewtraceFixture('research-normal.jsonl'), '--data-root', root]);
      const selected = await runBin(['--select', 'receipt-A1', '--data-root', root, '--json', '--url-only']);
      const selectedJson = JSON.parse(selected.stdout) as {
        url: string;
        resolution: { status: string };
      };
      assert.equal(selectedJson.resolution.status, 'explicit-selection');
      assert.ok(new URL(selectedJson.url).pathname.endsWith('/answers/A1'));
      const latest = JSON.parse(
        (await runBin(['open', 'latest', '--data-root', root, '--json', '--url-only'])).stdout,
      ) as { url: string; resolution: { reason: string } };
      assert.ok(!latest.url.includes('/answers/'));
      assert.equal(latest.resolution.reason, 'EXPLICIT_LATEST_RUN_EXPLORATION');
      const legacy = JSON.parse(
        (await runBin(['--select', 'research-normal-001', '--data-root', root, '--json'])).stdout,
      ) as { url: string; resolution: { status: string } };
      assert.ok(legacy.url.endsWith('/runs/research-normal-001'));
      assert.equal(legacy.resolution.status, 'explicit-selection');
      const conflictProducer = await writeProducer(
        root,
        'conflict.mjs',
        producerHeader() +
          `
const final = {...base,recordKind:'answer',receiptVersion:1,receiptId:'conflict-receipt',agentId:'reference',answerId:'conflict-answer',answer:'Original public answer.',final:true,timestamp:now(),eventIds:[]};
rec(final);rec({...final,answer:'Conflicting public answer.'});run('COMPLETED');
`,
      );
      const conflictCapture = await runBin([
        'run',
        '--data-root',
        root,
        '--json',
        '--',
        process.execPath,
        conflictProducer,
      ]);
      assert.equal(conflictCapture.code, 4, conflictCapture.stderr);
      assert.equal(parseRunJson(conflictCapture.stdout).summary?.['completeness'], 'PARTIAL');
      const conflictReveal = JSON.parse(
        (await runBin(['--receipt', 'conflict-receipt', '--data-root', root, '--json'])).stdout,
      ) as { url: string; resolution: { status: string } };
      assert.equal(conflictReveal.resolution.status, 'mismatch');
      assert.equal(new URL(conflictReveal.url).pathname, '/');
      await runBin(['delete', String(summary['runId']), '--data-root', root]);
      const deleted = JSON.parse(
        (await runBin(['--receipt', 'receipt-A1', '--data-root', root, '--json'])).stdout,
      ) as { url: string; resolution: { status: string } };
      assert.equal(deleted.resolution.status, 'missing');
      assert.equal(new URL(deleted.url).pathname, '/');
      assert.equal((await runBin(['--select', 'receipt-A1', '--data-root', root, '--json'])).code, 1);
      assert.equal(await sha256File(viewtraceFixture('answer-multi-turn.jsonl')), checksum);
    } finally {
      await downService(root);
    }
    assert.equal((await runBin(['status', '--data-root', root])).code, 1);
  });

  it('bare empty reveal writes nothing; ready picker, cancellation and explicit CLI keep/prune work', async () => {
    const root = await tempDataRoot('empty-reveal');
    assert.equal((await runBin([], { env: { VIEWTRACE_DATA_ROOT: root } })).code, 1);
    assert.equal((await runBin(['--data-root', root, '--json'])).code, 1);
    assert.deepEqual(await readdir(root), []);
    await runBin(['ingest', viewtraceFixture('answer-multi-turn.jsonl'), '--data-root', root]);
    await upService(root);
    try {
      assert.equal((await runBin(['keep', 'receipt-multi', '--data-root', root])).code, 0);
      assert.deepEqual(
        JSON.parse((await runBin(['prune', '--before', '9999-01-01T00:00:00Z', '--data-root', root])).stdout)
          .deleted,
        [],
      );
      if (process.platform === 'linux') {
        const script = `import os,pty,select,sys,time\npid,fd=pty.fork()\nif pid==0:\n os.environ.pop('DISPLAY',None);os.environ.pop('WAYLAND_DISPLAY',None);os.execv(sys.argv[1],[sys.argv[1],sys.argv[2],'--data-root',sys.argv[3]])\nbuf=b'';sent=False;deadline=time.time()+15\nwhile time.time()<deadline:\n ready,_,_=select.select([fd],[],[],0.1)\n if ready:\n  try: chunk=os.read(fd,65536)\n  except OSError: break\n  if not chunk: break\n  buf+=chunk\n  if not sent and b'Select number' in buf: os.write(fd,b'\\n');sent=True\n if os.waitpid(pid,os.WNOHANG)[0]: break\nif not sent: os.kill(pid,9);raise Exception('TTY picker did not prompt')\nsys.stdout.write(buf.decode())`;
        const result = await exec('python3', ['-c', script, process.execPath, cliDist, root], {
          timeout: 20000,
        });
        assert.match(result.stdout, /Reveal cancelled/);
        assert.ok(!result.stdout.includes('/answers/'));
      }
      assert.equal((await runBin(['keep', 'receipt-multi', '--release', '--data-root', root])).code, 0);
      assert.deepEqual(
        JSON.parse((await runBin(['prune', '--before', '9999-01-01T00:00:00Z', '--data-root', root])).stdout)
          .deleted,
        ['receipt-multi'],
      );
    } finally {
      await downService(root);
    }
  });

  it('occupied report port refuses readiness, never opens the foreign listener, cleans lock/state', async () => {
    const foreign = http.createServer((_req, res) => res.end('foreign'));
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
    const address = foreign.address();
    assert.ok(address && typeof address !== 'string');
    const root = await tempDataRoot('port-collision');
    try {
      const up = await runBin(['up', '--data-root', root, '--report-port', String(address.port), '--json'], {
        timeoutMs: 10000,
      });
      assert.equal(up.code, 1, up.stderr);
      assert.equal(await readServiceFile(root), null);
      await assert.rejects(() => stat(join(root, 'service.lock')), {
        code: 'ENOENT',
      });
      const reveal = await runBin(['--data-root', root, '--url-only']);
      assert.ok(!reveal.stdout.includes(`:${address.port}`));
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
      await downService(root);
    }
  });

  it('browser launcher uses literal argv and fails safely; credentials/CoT never persist in live answer artifacts', async () => {
    const root = await tempDataRoot('reveal-private');
    const tools = join(root, 'tools');
    await mkdir(tools);
    if (process.platform !== 'win32') {
      const argvFile = join(root, 'opener-argv');
      const opener = join(tools, 'xdg-open');
      await writeFile(opener, '#!/bin/sh\nprintf "%s" "$1" > "$OPENER_ARGV"\nexit 1\n', { mode: 0o700 });
      const oldPath = process.env['PATH'],
        oldFile = process.env['OPENER_ARGV'];
      process.env['PATH'] = tools;
      process.env['OPENER_ARGV'] = argvFile;
      try {
        const url = 'http://127.0.0.1:7331/runs/test?literal=$(do-not-execute)&x=1';
        assert.equal(await launchBrowser(url, 'linux'), false);
        assert.equal(await readFile(argvFile, 'utf8'), url);
      } finally {
        process.env['PATH'] = oldPath;
        if (oldFile === undefined) delete process.env['OPENER_ARGV'];
        else process.env['OPENER_ARGV'] = oldFile;
      }
    }
    const home = join(root, 'fake-home');
    await mkdir(home);
    const sentinel = join(repoRoot, 'test', 'helpers', 'net-sentinel.mjs');
    const reportFile = join(root, 'network.json');
    const env = {
      HOME: home,
      USERPROFILE: home,
      NODE_OPTIONS: `--import=${pathToFileURL(sentinel).href}`,
      NET_SENTINEL_REPORT: reportFile,
    };
    assert.equal((await runBin(['up', '--data-root', root, '--report-port', '0'], { env })).code, 0);
    try {
      const code =
        producerHeader() +
        `rec({...base,recordKind:'answer',receiptVersion:1,receiptId:'private-receipt',agentId:'reference',answerId:'public',answer:'api_key=CREDENTIAL_SENTINEL_72',final:true,timestamp:now(),eventIds:[],thinking:'PRIVATE_COT_SENTINEL_72',credentials:{token:'TOKEN_SENTINEL_72'}});run('COMPLETED');`;
      const file = await writeProducer(root, 'private.mjs', code);
      const run = await runBin(['run', '--data-root', root, '--json', '--', process.execPath, file], { env });
      assert.equal(run.code, 0, run.stderr);
      const reveal = await runBin(
        ['--receipt', 'private-receipt', '--data-root', root, '--json', '--url-only'],
        { env },
      );
      assert.equal(reveal.code, 0, reveal.stderr);
      assert.ok(!/CREDENTIAL_SENTINEL|PRIVATE_COT_SENTINEL|TOKEN_SENTINEL/.test(reveal.stdout + run.stdout));
      const replay = await runBin(
        ['replay', String(parseRunJson(run.stdout).summary?.['runId']), '--data-root', root, '--json'],
        { env },
      );
      assert.ok(!/CREDENTIAL_SENTINEL|PRIVATE_COT_SENTINEL|TOKEN_SENTINEL/.test(replay.stdout));
      const info = (await readServiceFile(root))!;
      const api = await request(info.reportPort!, '/api/receipts/private-receipt', {
        headers: { authorization: `Bearer ${info.reportToken}` },
      });
      assert.ok(!/CREDENTIAL_SENTINEL|PRIVATE_COT_SENTINEL|TOKEN_SENTINEL/.test(api.text));
    } finally {
      await runBin(['down', '--data-root', root], { env });
    }
    for (const area of ['runs', 'live', 'logs']) {
      async function check(path: string): Promise<void> {
        for (const file of await readdir(path, { withFileTypes: true })) {
          const p = join(path, file.name);
          if (file.isDirectory()) await check(p);
          else
            assert.ok(
              !/CREDENTIAL_SENTINEL|PRIVATE_COT_SENTINEL|TOKEN_SENTINEL/.test(await readFile(p, 'utf8')),
              p,
            );
        }
      }
      await check(join(root, area));
    }
    assert.ok(
      !/CREDENTIAL_SENTINEL|PRIVATE_COT_SENTINEL|TOKEN_SENTINEL/.test(
        (await readFile(join(root, 'viewtrace.db'))).toString('utf8'),
      ),
    );
    assert.deepEqual(await readdir(home), []);
    assert.deepEqual(JSON.parse(await readFile(reportFile, 'utf8')).violations, []);
  });
});
