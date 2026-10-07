/** Local report surface: fixed asset allowlist, bounded SQL, no source fetching. */
import * as http from 'node:http';
import type { Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { assertLocalPath } from './paths.js';
import type { ViewTraceStore } from './store.js';
import { isValidEventId, isValidRunId, isValidTimestamp } from './validate.js';
import { answerAnalysisReport, answerReport, eventPage, pickerPage, runReport } from './report.js';
import { parseAnswerContext, resolveAnswer } from './resolver.js';
import { listAdapters } from './adapters.js';
import { ANALYSIS_MODES, type AnalysisMode } from './analysis-types.js';

export interface ReportServer {
  readonly port: number;
  readonly boundAddress: string;
  readonly token: string;
  close(): Promise<void>;
}
function equal(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function integer(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  if (!/^\d{1,16}$/.test(value)) throw new Error('INVALID_PAGE');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > max) throw new Error('INVALID_PAGE');
  return n;
}
async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const data of req) {
    const chunk = Buffer.from(data as Uint8Array);
    size += chunk.length;
    if (size > 4096) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('INVALID_BODY');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_BODY');
  return parsed as Record<string, unknown>;
}

export async function startReportServer(
  store: ViewTraceStore,
  options: { port?: number; bootId: string; assetRoot?: string },
): Promise<ReportServer> {
  const token = randomBytes(32).toString('hex');
  const assetRoot = options.assetRoot ?? fileURLToPath(new URL('../../../ui/viewtrace/', import.meta.url));
  const sockets = new Set<Socket>();
  let port = 0;
  const server = http.createServer((req, res) => {
    void handle(req, res);
  });
  server.maxHeadersCount = 40;
  server.headersTimeout = 10000;
  server.requestTimeout = 10000;
  server.timeout = 10000;
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('clientError', (_e, s) => s.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 7331, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const bound = server.address();
  if (!bound || typeof bound === 'string' || bound.address !== '127.0.0.1') {
    server.close();
    throw new Error('UNSAFE_BIND');
  }
  port = bound.port;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const send = (status: number, data: unknown): void => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(data));
    };
    const fail = (status: number, code: string): void => send(status, { error: { code } });
    try {
      const host = req.headers.host;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        fail(403, 'HOST_NOT_ALLOWED');
        return;
      }
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) {
        fail(403, 'ORIGIN_NOT_ALLOWED');
        return;
      }
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && site !== 'none') {
        fail(403, 'CROSS_SITE');
        return;
      }
      if (!req.url || req.url.length > 2048 || !req.url.startsWith('/') || req.url.startsWith('//')) {
        fail(400, 'BAD_URL');
        return;
      }
      const rawPath = req.url.split('?')[0] ?? '';
      let path: string;
      try {
        path = decodeURIComponent(rawPath);
      } catch {
        fail(400, 'BAD_URL');
        return;
      }
      if (path.includes('\\') || path.split('/').some((x) => x === '..' || x === '.')) {
        fail(400, 'BAD_PATH');
        return;
      }
      const url = new URL(req.url, `http://${host}`);
      const method = req.method ?? '';
      if (!['GET', 'POST', 'DELETE'].includes(method)) {
        fail(405, 'METHOD_NOT_ALLOWED');
        return;
      }
      const declared = Number(req.headers['content-length'] ?? '0');
      if (declared > 4096) {
        res.setHeader('Connection', 'close');
        fail(413, 'PAYLOAD_TOO_LARGE');
        res.on('finish', () => req.destroy());
        return;
      }
      if (method === 'GET' && (declared > 0 || req.headers['transfer-encoding'])) {
        fail(400, 'GET_BODY_NOT_ALLOWED');
        return;
      }
      const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const cookie =
        (req.headers.cookie ?? '')
          .split(';')
          .map((x) => x.trim())
          .find((x) => x.startsWith('viewtrace_session='))
          ?.slice(18) ?? '';
      const authed = equal(bearer, token) || equal(cookie, token);
      const auth = (): boolean => {
        if (!authed) fail(401, 'UNAUTHORIZED');
        return authed;
      };
      const mutAuth = (): boolean => {
        if (!auth()) return false;
        if (origin === undefined && !equal(bearer, token)) {
          fail(403, 'ORIGIN_REQUIRED');
          return false;
        }
        return true;
      };
      const pageKeys = new Set(['limit', 'cursor', 'offset', 'selection']);
      const isAnalysisPath = /\/analysis$/.test(path);
      const allowedKeys = isAnalysisPath
        ? new Set(['limit', 'cursor', 'offset', 'selection', 'mode'])
        : pageKeys;
      if (path !== '/api/resolve')
        for (const key of url.searchParams.keys())
          if (!allowedKeys.has(key)) {
            fail(400, 'UNKNOWN_QUERY');
            return;
          }
      for (const key of url.searchParams.keys())
        if (url.searchParams.getAll(key).length !== 1) {
          fail(400, 'DUPLICATE_QUERY');
          return;
        }
      const limit = integer(url.searchParams.get('limit'), 50, 100);
      if (limit === 0) throw new Error('INVALID_PAGE');
      const offset = integer(url.searchParams.get('offset'), 0, 1000000);
      const after = integer(url.searchParams.get('cursor'), 0, Number.MAX_SAFE_INTEGER);
      if (path === '/health' && method === 'GET') {
        if (!auth()) return;
        send(200, {
          ok: true,
          service: 'viewtrace-report',
          bootId: options.bootId,
          boundAddress: '127.0.0.1',
          port,
        });
        return;
      }
      if (path === '/api/runs' && method === 'GET') {
        if (auth()) send(200, { runs: store.recentRuns(limit, offset) });
        return;
      }
      if (path === '/api/adapters' && method === 'GET') {
        if (auth()) send(200, { adapters: listAdapters() });
        return;
      }
      if (path === '/api/picker' && method === 'GET') {
        if (auth()) send(200, pickerPage(store, offset, limit));
        return;
      }
      if (path === '/api/resolve' && method === 'GET') {
        if (!auth()) return;
        send(200, resolveAnswer(store, parseAnswerContext(Object.fromEntries(url.searchParams))));
        return;
      }
      const receiptMatch = /^\/api\/receipts\/([^/]+)$/.exec(path);
      if (receiptMatch && method === 'GET') {
        if (!auth()) return;
        if (!isValidEventId(receiptMatch[1] ?? '')) {
          fail(400, 'INVALID_ID');
          return;
        }
        const receipt = store.getReceipt(receiptMatch[1]!);
        if (!receipt) {
          fail(404, 'NOT_FOUND');
          return;
        }
        send(200, answerReport(store, receipt.runId, receipt.answerId));
        return;
      }
      const match = /^\/api\/runs\/([^/]+)(?:\/answers\/([^/]+))?(?:\/(events|keep|analysis))?$/.exec(path);
      if (match) {
        const runId = match[1]!,
          answerId = match[2],
          action = match[3];
        if (!isValidRunId(runId) || (answerId !== undefined && !isValidEventId(answerId))) {
          fail(400, 'INVALID_ID');
          return;
        }
        if (!auth()) return;
        if (action === 'analysis') {
          if (!answerId) {
            fail(400, 'BAD_REQUEST');
            return;
          }
          if (method !== 'GET') {
            fail(405, 'METHOD_NOT_ALLOWED');
            return;
          }
          const modeParam = url.searchParams.get('mode');
          if (modeParam && !ANALYSIS_MODES.includes(modeParam as AnalysisMode)) {
            fail(400, 'BAD_REQUEST');
            return;
          }
          const report = await answerAnalysisReport(store, runId, answerId, {
            overrideMode: (modeParam as AnalysisMode) || undefined,
          });
          if (!report) {
            fail(404, 'NOT_FOUND');
            return;
          }
          send(200, report);
          return;
        }
        if (method === 'DELETE' && !answerId && !action) {
          if (!mutAuth()) return;
          if (!store.getRun(runId)) {
            fail(404, 'NOT_FOUND');
            return;
          }
          await store.deleteRun(runId);
          send(200, { deleted: true, runId });
          return;
        }
        if (method === 'POST' && !answerId && action === 'keep') {
          if (!mutAuth()) return;
          const b = await body(req);
          if (typeof b['keep'] !== 'boolean' || Object.keys(b).length !== 1) throw new Error('INVALID_BODY');
          if (!store.getRun(runId)) {
            fail(404, 'NOT_FOUND');
            return;
          }
          store.setKeep(runId, b['keep']);
          send(200, { runId, keep: b['keep'] });
          return;
        }
        if (method !== 'GET') {
          fail(405, 'METHOD_NOT_ALLOWED');
          return;
        }
        const selection = url.searchParams.has('selection')
          ? integer(url.searchParams.get('selection'), 0, Number.MAX_SAFE_INTEGER)
          : undefined;
        const data =
          action === 'events'
            ? eventPage(store, runId, after, limit, answerId, selection)
            : answerId
              ? answerReport(store, runId, answerId, selection)
              : runReport(store, runId);
        if (data === null) {
          fail(404, 'NOT_FOUND');
          return;
        }
        send(200, data);
        return;
      }
      if (path === '/api/select' && method === 'POST') {
        if (!mutAuth()) return;
        const b = await body(req);
        if (
          Object.keys(b).some((k) => k !== 'receiptId' && k !== 'runId') ||
          typeof b['runId'] !== 'string' ||
          !isValidRunId(b['runId']) ||
          (b['receiptId'] !== undefined &&
            (typeof b['receiptId'] !== 'string' || !isValidEventId(b['receiptId'])))
        )
          throw new Error('INVALID_BODY');
        const receiptId = b['receiptId'] as string | undefined;
        if (!store.getRun(b['runId']) || (receiptId && store.getReceipt(receiptId)?.runId !== b['runId'])) {
          fail(404, 'NOT_FOUND');
          return;
        }
        const selectionId = store.select(receiptId, b['runId']);
        const receipt = receiptId ? store.getReceipt(receiptId) : null;
        send(200, {
          selectionId,
          association: 'explicit-selection',
          path: receipt
            ? `/runs/${receipt.runId}/answers/${receipt.answerId}?selection=${selectionId}`
            : `/runs/${b['runId']}`,
        });
        return;
      }
      if (path === '/api/retention' && method === 'POST') {
        if (!mutAuth()) return;
        const b = await body(req);
        if (Object.keys(b).length !== 1 || typeof b['before'] !== 'string' || !isValidTimestamp(b['before']))
          throw new Error('INVALID_BODY');
        send(200, { deleted: await store.pruneBefore(b['before']) });
        return;
      }
      const asset =
        path === '/app.js'
          ? 'app.js'
          : path === '/app.css'
            ? 'app.css'
            : path === '/' ||
                /^\/runs\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/answers\/[A-Za-z0-9][A-Za-z0-9._:-]*)?$/.test(path)
              ? 'index.html'
              : null;
      if (asset && method === 'GET') {
        const assetPath = join(assetRoot, asset);
        await assertLocalPath(assetRoot, assetPath);
        const bytes = await readFile(assetPath);
        if (asset === 'index.html')
          res.setHeader('Set-Cookie', `viewtrace_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
        res.setHeader(
          'Content-Type',
          asset === 'app.js'
            ? 'text/javascript; charset=utf-8'
            : asset === 'app.css'
              ? 'text/css; charset=utf-8'
              : 'text/html; charset=utf-8',
        );
        res.end(bytes);
        return;
      }
      fail(404, 'NOT_FOUND');
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      if (!res.headersSent)
        fail(
          code === 'PAYLOAD_TOO_LARGE' ? 413 : /^(INVALID_|BAD_)/.test(code) ? 400 : 500,
          /^(INVALID_|BAD_|PAYLOAD_TOO_LARGE)/.test(code) ? code : 'INTERNAL',
        );
      else res.destroy();
    }
  }
  return {
    port,
    boundAddress: '127.0.0.1',
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
      }),
  };
}
