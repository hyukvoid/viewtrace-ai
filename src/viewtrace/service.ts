#!/usr/bin/env node
/**
 * viewtrace collector service (M1) — spawned detached by `viewtrace up`.
 *
 * Owns the ONLY read-write connection to the store, tails live spools
 * (LiveCollector) and serves the loopback control API (§3 boundaries).
 * Graceful shutdown on POST /shutdown, SIGTERM or SIGINT: final drain,
 * store close, state-file cleanup. SIGKILL is survived via cursor resume.
 */

import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { startReportServer } from './server.js';
import type { ReportServer } from './server.js';
import { LiveCollector } from './collector.js';
import { startControlServer } from './control.js';
import type { ControlResponse, ControlServer } from './control.js';
import {
  SERVICE_PROTOCOL_VERSION,
  acquireServiceLock,
  liveDir,
  logsDir,
  readServiceFile,
  releaseServiceLock,
  removeServiceFile,
  serviceLog,
  writeServiceFile,
} from './servestate.js';
import { ViewTraceStore } from './store.js';
import type { LiveRunSnapshot } from './collector.js';

const POLL_MS = 250;
const MAX_LOG_BYTES = 1024 * 1024;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function parseDataRootArg(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-root' && typeof argv[i + 1] === 'string') return argv[i + 1] as string;
  }
  return null;
}

async function log(dataRoot: string, message: string): Promise<void> {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    const info = await stat(serviceLog(dataRoot)).catch(() => null);
    if (info !== null && info.size > MAX_LOG_BYTES) {
      await rename(serviceLog(dataRoot), `${serviceLog(dataRoot)}.old`);
    }
    await appendFile(serviceLog(dataRoot), line);
  } catch {
    /* logging must never take the service down */
  }
}

async function main(): Promise<void> {
  const dataRoot = parseDataRootArg(process.argv.slice(2));
  if (dataRoot === null || dataRoot.length === 0) {
    process.stderr.write('viewtrace-service: --data-root is required\n');
    process.exit(2);
  }

  // Files this process creates (db side files, logs, spools) stay private.
  try {
    process.umask(0o077);
  } catch {
    /* not supported on this platform */
  }

  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await mkdir(liveDir(dataRoot), { recursive: true, mode: 0o700 });
  await mkdir(logsDir(dataRoot), { recursive: true, mode: 0o700 });

  const lock = await acquireServiceLock(dataRoot);
  if (lock === 'busy') {
    // Either a healthy sibling is already running (fine — `up` will find it)
    // or a foreign process holds the lock file; either way we must not start.
    await log(dataRoot, `boot refused: service.lock is held by a live process (pid file present)`);
    process.exit(0);
  }

  const bootId = randomBytes(8).toString('hex');
  const startedAtMs = Date.now();

  const store = await ViewTraceStore.open({ dataRoot });
  const collector = new LiveCollector(store, dataRoot, {
    log: (message) => void log(dataRoot, message),
  });
  await collector.scanAndResume();

  let shuttingDown = false;
  let timer: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let controlRef: ControlServer | null = null;
  let reportRef: ReportServer | null = null;

  const graceful = async (reason: string, code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (timer !== null) clearInterval(timer);
    if (heartbeat !== null) clearInterval(heartbeat);
    try {
      await collector.tick(); // best-effort final drain of pending bytes
    } catch {
      /* committed state stays consistent; next boot resumes from the cursor */
    }
    if (reportRef !== null) await reportRef.close();
    if (controlRef !== null) {
      try {
        await controlRef.close();
      } catch {
        /* already closed */
      }
    }
    try {
      await store.close();
    } catch {
      /* already closed */
    }
    await removeServiceFile(dataRoot);
    await releaseServiceLock(dataRoot);
    await log(dataRoot, `shutdown (${reason})`);
    process.exit(code);
  };

  const portIndex = process.argv.indexOf('--report-port');
  const reportPort = portIndex < 0 ? 7331 : Number(process.argv[portIndex + 1]);
  if (!Number.isInteger(reportPort) || reportPort < 0 || reportPort > 65535) {
    await graceful('invalid-report-port', 1);
    return;
  }
  try {
    reportRef = await startReportServer(store, { port: reportPort, bootId });
  } catch {
    await log(dataRoot, 'boot refused: report port unavailable or report startup failed');
    await graceful('report-startup-failed', 1);
    return;
  }

  const control = await startControlServer(
    ({ method, pathname }): ControlResponse | Promise<ControlResponse> => {
      if (pathname === '/health') {
        if (method !== 'GET') return { status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } };
        return {
          status: 200,
          body: {
            ok: true,
            service: 'viewtrace-collector',
            protocolVersion: SERVICE_PROTOCOL_VERSION,
            pid: process.pid,
            bootId,
            boundAddress: controlRef?.boundAddress ?? '127.0.0.1',
            port: controlRef?.port ?? 0,
            reportPort: reportRef?.port,
            reportReady: reportRef !== null,
            uptimeMs: Date.now() - startedAtMs,
          },
        };
      }
      if (pathname === '/runs') {
        if (method !== 'GET') return { status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } };
        // Snapshot only (never blocks on a drain): the poll loop keeps it fresh.
        return collector.snapshot().then((runs) => ({ status: 200, body: { runs } }));
      }
      const runMatch = /^\/runs\/([^/]+)$/.exec(pathname);
      if (runMatch !== null) {
        if (method !== 'GET') return { status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } };
        const runId = decodeURIComponent(runMatch[1] ?? '');
        if (!RUN_ID_PATTERN.test(runId)) return { status: 404, body: { error: { code: 'NOT_FOUND' } } };
        const snapshot = collector.snapshot().then((runs) => runs.find((r) => r.runId === runId));
        return snapshot.then((run) => {
          if (run === undefined) return { status: 404, body: { error: { code: 'NOT_FOUND' } } };
          const diagnostics = store.listDiagnostics(runId).slice(-50);
          const duplicates = store.listDuplicates(runId);
          return { status: 200, body: { run, diagnostics, duplicates } };
        });
      }
      if (pathname === '/shutdown') {
        if (method !== 'POST') return { status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } };
        queueMicrotask(() => void graceful('api', 0));
        return { status: 200, body: { ok: true, shuttingDown: true } };
      }
      return { status: 404, body: { error: { code: 'NOT_FOUND' } } };
    },
  );

  controlRef = control;

  const serviceInfo = {
    protocolVersion: SERVICE_PROTOCOL_VERSION,
    pid: process.pid,
    bootId,
    port: control.port,
    reportPort: reportRef.port,
    reportToken: reportRef.token,
    token: control.token,
    startedAt: new Date(startedAtMs).toISOString(),
  };
  await writeServiceFile(dataRoot, serviceInfo);
  // If another instance won the state file in a startup race, we lose: the
  // lock normally prevents this, but the check keeps identity unambiguous.
  const written = await readServiceFile(dataRoot);
  if (written === null || written.pid !== process.pid || written.bootId !== bootId) {
    await log(dataRoot, 'boot aborted: service.json identity check failed after write');
    await graceful('identity-check', 0);
    return;
  }

  // Heartbeat: rewrite the state file periodically so a corrupted or
  // hand-edited service.json self-heals while this service is alive.
  heartbeat = setInterval(() => {
    void writeServiceFile(dataRoot, serviceInfo).catch(() => undefined);
  }, 5000);
  heartbeat.unref?.();

  await log(
    dataRoot,
    `service up: pid ${process.pid}, control 127.0.0.1:${control.port}, data root ${dataRoot}`,
  );

  process.on('SIGTERM', () => void graceful('sigterm', 0));
  process.on('SIGINT', () => void graceful('sigint', 0));
  process.on('uncaughtException', (e) => {
    void log(dataRoot, `uncaught exception: ${e instanceof Error ? e.message : String(e)}`).then(() =>
      graceful('uncaught-exception', 1),
    );
  });
  process.on('unhandledRejection', (reason) => {
    void log(dataRoot, `unhandled rejection: ${String(reason)}`).then(() =>
      graceful('unhandled-rejection', 1),
    );
  });

  timer = setInterval(() => {
    void collector.tick().catch(() => undefined);
  }, POLL_MS);
  void collector.tick().catch(() => undefined);

  // The service is a detached background process: stay alive until a
  // graceful shutdown path calls process.exit.
  await new Promise<never>(() => undefined);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (e) => {
      process.stderr.write(`viewtrace-service: fatal: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
