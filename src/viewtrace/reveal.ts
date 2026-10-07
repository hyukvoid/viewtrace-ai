import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { controlRequest, probeService } from './control.js';
import { readServiceFile } from './servestate.js';
import { ViewTraceStore } from './store.js';
import { parseAnswerContext, resolveAnswer } from './resolver.js';
import { pickerPage } from './report.js';
import { sanitizeForTerminal } from './display.js';
import type { AnswerContext } from './answer.js';

export async function reportConnection(dataRoot: string) {
  const info = await readServiceFile(dataRoot);
  if (!info || !info.reportPort || !info.reportToken)
    throw new Error('report service is not ready; run viewtrace up');
  const probe = await probeService(info);
  if (
    probe.state !== 'running' ||
    probe.health.reportPort !== info.reportPort ||
    probe.health.reportReady !== true
  )
    throw new Error('report service identity is stale; run viewtrace up');
  const health = await controlRequest({
    port: info.reportPort,
    token: info.reportToken,
    method: 'GET',
    path: '/health',
  });
  const data = health.json as { service?: string; bootId?: string } | null;
  if (health.status !== 200 || data?.service !== 'viewtrace-report' || data.bootId !== info.bootId)
    throw new Error('report port is unavailable or identity differs');
  return {
    port: info.reportPort,
    token: info.reportToken,
    url: `http://127.0.0.1:${info.reportPort}`,
  };
}

export function launchBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const command = platform === 'win32' ? 'rundll32.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 5000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

interface RevealOptions {
  dataRoot: string;
  context: AnswerContext;
  json: boolean;
  urlOnly: boolean;
  latest?: boolean;
  select?: string;
}
export async function reveal(options: RevealOptions): Promise<number> {
  parseAnswerContext(options.context as Record<string, unknown>);
  const store = await ViewTraceStore.openQuery(options.dataRoot);
  let path = '/';
  let resolution = resolveAnswer(store, options.context);
  let selection: { receiptId?: string; runId: string } | undefined;
  let candidates = store ? pickerPage(store) : { answers: [], runs: [], nextOffset: null };
  try {
    if (options.latest) {
      const run = store?.recentRuns(1)[0];
      if (!run) {
        process.stdout.write(
          options.json
            ? JSON.stringify({
                status: 'missing',
                reason: 'NO_STORED_TRACES',
              }) + '\n'
            : 'no runs recorded yet — nothing to open\n',
        );
        return 1;
      }
      path = `/runs/${run.runId}`;
      resolution = {
        status: 'uncertain',
        reason: 'EXPLICIT_LATEST_RUN_EXPLORATION',
        basis: 'none',
      };
    } else if (options.select) {
      const receipt = store?.getReceipt(options.select);
      const run = receipt ? store?.getRun(receipt.runId) : store?.getRun(options.select);
      if (!run) {
        process.stdout.write(JSON.stringify({ status: 'missing', reason: 'SELECTION_NOT_FOUND' }) + '\n');
        return 1;
      }
      selection = { runId: run.runId, receiptId: receipt?.receiptId };
    } else if (resolution.status === 'matched' && resolution.receipt) {
      path = `/runs/${resolution.receipt.runId}/answers/${resolution.receipt.answerId}`;
    } else if (
      process.stdin.isTTY &&
      !options.json &&
      !options.urlOnly &&
      candidates.answers.length + candidates.runs.length > 0
    ) {
      process.stdout.write(`association ${resolution.status}: ${resolution.reason}\n`);
      const rows = [
        ...candidates.answers.map((a) => ({
          label: `Answer ${a.answerId} · ${a.timestamp} · ${a.questionSummary ?? 'question UNKNOWN'} · ${a.agentId} / ${a.agentSessionId ?? 'UNKNOWN'} / ${a.turnId ?? 'UNKNOWN'} · ${a.lifecycle} / ${a.completeness}`,
          runId: a.runId,
          receiptId: a.receiptId,
        })),
        ...candidates.runs.map((r) => ({
          label: `Run ${r.runId} · ${r.timestamp} · ${r.lifecycle} / ${r.completeness} · association UNKNOWN`,
          runId: r.runId,
          receiptId: undefined,
        })),
      ];
      for (let i = 0; i < rows.length; i++)
        process.stdout.write(`${i + 1}. ${sanitizeForTerminal(rows[i]!.label, 700)}\n`);
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      let choice = '';
      try {
        choice = await rl.question('Select number, or Enter to cancel: ');
      } finally {
        rl.close();
      }
      if (choice === '') {
        process.stdout.write('Reveal cancelled.\n');
        return 0;
      }
      const row = /^\d+$/.test(choice) ? rows[Number(choice) - 1] : undefined;
      if (!row) {
        process.stderr.write('invalid selection\n');
        return 2;
      }
      selection = { runId: row.runId, receiptId: row.receiptId };
    } else if (!candidates.answers.length && !candidates.runs.length) {
      process.stdout.write(JSON.stringify({ resolution, candidates }) + '\n');
      return 1;
    }
  } finally {
    await store?.close();
  }
  // JSON is also useful without an active service; it never claims readiness.
  let connection;
  try {
    connection = await reportConnection(options.dataRoot);
  } catch (e) {
    process.stdout.write(
      JSON.stringify({
        resolution,
        candidates,
        ready: false,
        explicitSelectionPath: 'viewtrace --select <receiptId|runId> --url-only',
      }) + '\n',
    );
    process.stderr.write(`viewtrace: ${e instanceof Error ? e.message : 'report unavailable'}\n`);
    return 1;
  }
  if (selection) {
    const res = await reportMutation(options.dataRoot, '/api/select', 'POST', selection);
    const result = res.json as { path: string };
    path = result.path;
  }
  const url = connection.url + path;
  const output = {
    resolution: selection
      ? {
          status: 'explicit-selection',
          reason: 'USER_SELECTED',
          basis: 'user-selected',
        }
      : resolution,
    candidates: resolution.status === 'matched' || selection || options.latest ? undefined : candidates,
    url,
    ready: true,
  };
  if (options.json) process.stdout.write(JSON.stringify(output) + '\n');
  else {
    process.stdout.write(
      options.latest
        ? 'latest run: exploration container; answer association UNKNOWN\n'
        : selection
          ? 'association explicit-selection (user-selected; not an automatic match)\n'
          : `association ${resolution.status}: ${resolution.reason}\n`,
    );
    process.stdout.write(url + '\n');
    if (!options.latest && !selection && resolution.status !== 'matched')
      process.stdout.write(
        'Choose a candidate in the picker, or viewtrace --select <receiptId|runId> --url-only\n',
      );
  }
  const headless =
    !process.stdout.isTTY ||
    (!process.env['DISPLAY'] && !process.env['WAYLAND_DISPLAY'] && process.platform === 'linux');
  if (!options.urlOnly && !options.json && !headless) {
    if (!(await launchBrowser(url))) process.stderr.write(`browser launch failed; open ${url}\n`);
  }
  return 0;
}

export async function reportMutation(dataRoot: string, path: string, method: string, data?: unknown) {
  const connection = await reportConnection(dataRoot);
  // The control client shares strict loopback transport; no token goes in URLs.
  const result = await controlRequest({
    port: connection.port,
    token: connection.token,
    method,
    path,
    body: data,
  });
  if (result.status !== 200) throw new Error(`local request failed (HTTP ${result.status})`);
  return result;
}
