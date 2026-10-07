/**
 * Loopback control channel for the collector service (M1).
 *
 * §3 boundaries applied from day one (required before M2):
 *  - Binds IPv4 127.0.0.1 ONLY (never 0.0.0.0/::/LAN).
 *  - Host header must be exactly 127.0.0.1:<port> or localhost:<port>.
 *  - Any Origin header must be the same origin; our CLI sends none.
 *  - Every request (reads included) requires the per-process bearer token
 *    (timing-safe compare); the token never appears in URLs or logs.
 *  - No CORS headers are ever emitted; OPTIONS is refused (405).
 *  - Bodies are capped; unknown paths 404; non-allowed methods 405.
 *  - Errors are terse JSON codes — no paths, no stacks, no secrets.
 */

import * as http from 'node:http';
import type { Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const MAX_CONTROL_BODY_BYTES = 4096;

export interface ControlRequest {
  readonly method: string;
  readonly pathname: string;
}

export interface ControlResponse {
  readonly status: number;
  readonly body: unknown;
}

export type ControlHandler = (req: ControlRequest) => Promise<ControlResponse> | ControlResponse;

export interface ControlServer {
  readonly port: number;
  readonly token: string;
  /** Bound socket address — always '127.0.0.1'; verified at listen time. */
  readonly boundAddress: string;
  close(): Promise<void>;
}

export function notFound(): ControlResponse {
  return { status: 404, body: { error: { code: 'NOT_FOUND' } } };
}
export function methodNotAllowed(): ControlResponse {
  return { status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } };
}

function tokensEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function startControlServer(handler: ControlHandler): Promise<ControlServer> {
  const token = randomBytes(32).toString('hex');
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    void handle(token, handler, req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_err, socket) => {
    socket.destroy();
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (e: Error): void => rejectListen(e);
    server.once('error', onError);
    // 127.0.0.1 only — loopback control, never wildcard/IPv6/LAN.
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string' || address.address !== '127.0.0.1') {
    for (const socket of sockets) socket.destroy();
    server.close();
    throw new Error(`control server bound to unexpected address: ${JSON.stringify(address)}`);
  }
  const port = address.port;

  async function handle(
    srvToken: string,
    h: ControlHandler,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const finish = (status: number, body: unknown): void => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      // Deliberately NO Access-Control-* headers — cross-origin reads are
      // never enabled, so browsers keep same-origin policy protection.
      res.end(JSON.stringify(body) + '\n');
    };

    try {
      // Reject request bodies over the cap before reading anything. The
      // refusal is written first so a well-behaved client still receives it;
      // the connection is then dropped without draining the payload.
      const contentLength = Number(req.headers['content-length'] ?? '0');
      if (Number.isFinite(contentLength) && contentLength > MAX_CONTROL_BODY_BYTES) {
        res.setHeader('Connection', 'close');
        finish(413, { error: { code: 'PAYLOAD_TOO_LARGE' } });
        res.on('finish', () => req.destroy());
        return;
      }

      let pathname = '';
      if (typeof req.url === 'string' && req.url.length > 0) {
        try {
          const url = new URL(req.url, `http://127.0.0.1:${port}`);
          if (url.search !== '') {
            finish(400, { error: { code: 'QUERY_NOT_SUPPORTED' } });
            return;
          }
          pathname = url.pathname;
        } catch {
          finish(400, { error: { code: 'BAD_URL' } });
          return;
        }
      }

      // Host allowlist: exactly this bound port on loopback names.
      const host = (req.headers.host ?? '').trim().toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        finish(403, { error: { code: 'HOST_NOT_ALLOWED' } });
        return;
      }

      // Origin: absent (our CLI) or exactly this origin. Anything else —
      // including null — is a cross-origin request and is refused.
      const origin = req.headers.origin;
      if (
        origin !== undefined &&
        origin !== `http://127.0.0.1:${port}` &&
        origin !== `http://localhost:${port}`
      ) {
        finish(403, { error: { code: 'ORIGIN_NOT_ALLOWED' } });
        return;
      }

      // Per-process secret on every endpoint, reads included.
      const auth = req.headers.authorization;
      if (typeof auth !== 'string' || !auth.startsWith('Bearer ') || !tokensEqual(auth.slice(7), srvToken)) {
        finish(401, { error: { code: 'UNAUTHORIZED' } });
        return;
      }

      // Drain any (small) body so the socket is reusable, then dispatch.
      await readCappedBody(req);

      const method = req.method ?? '';
      if (method === 'OPTIONS') {
        finish(405, { error: { code: 'METHOD_NOT_ALLOWED' } });
        return;
      }
      const response = await h({ method, pathname });
      finish(response.status, response.body);
    } catch {
      if (!res.headersSent) finish(500, { error: { code: 'INTERNAL' } });
      else res.destroy();
    }
  }

  return {
    port,
    token,
    boundAddress: '127.0.0.1',
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        for (const socket of sockets) socket.destroy();
      }),
  };
}

function readCappedBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_CONTROL_BODY_BYTES) {
        req.destroy();
        rejectBody(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', rejectBody);
  });
}

/* ------------------------------------------------------------------ */
/* Client side                                                         */
/* ------------------------------------------------------------------ */

export interface ControlClientResult {
  readonly status: number;
  readonly json: unknown;
}

export function controlRequest(options: {
  readonly port: number;
  readonly token: string;
  readonly method: string;
  readonly path: string;
  readonly timeoutMs?: number;
  readonly body?: unknown;
}): Promise<ControlClientResult> {
  return new Promise((resolveReq, rejectReq) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        headers: { authorization: `Bearer ${options.token}`, ...(options.body === undefined ? {} : { 'Content-Type':'application/json' }) },
        timeout: options.timeoutMs ?? 3000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let json: unknown = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            json = null;
          }
          resolveReq({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('CONTROL_TIMEOUT')));
    req.on('error', rejectReq);
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

export interface HealthInfo {
  readonly ok: boolean;
  readonly service: string;
  readonly protocolVersion: number;
  readonly pid: number;
  readonly bootId: string;
  readonly boundAddress: string;
  readonly uptimeMs: number;
  readonly reportPort?: number;
  readonly reportReady?: boolean;
}

export type ProbeOutcome =
  | { readonly state: 'running'; readonly health: HealthInfo; readonly info: { readonly port: number; readonly token: string } }
  | { readonly state: 'stale'; readonly reason: string };

/**
 * Checks whether the service described by a service.json entry is actually
 * alive AND is the same process instance (pid + bootId identity). A healthy
 * listener whose identity does not match the file is reported so callers can
 * repair or replace the file — the listener itself is never killed by pid.
 */
export async function probeService(
  info: { readonly pid: number; readonly bootId: string; readonly port: number; readonly token: string },
  timeoutMs = 2000,
): Promise<ProbeOutcome> {
  let result: ControlClientResult;
  try {
    result = await controlRequest({
      port: info.port,
      token: info.token,
      method: 'GET',
      path: '/health',
      timeoutMs,
    });
  } catch (e) {
    return { state: 'stale', reason: `control endpoint unreachable (${errorMessage(e)})` };
  }
  if (result.status !== 200) {
    return { state: 'stale', reason: `control endpoint answered ${result.status}` };
  }
  const h = result.json as Partial<HealthInfo> | null;
  if (
    h === null || typeof h !== 'object' || h.ok !== true || h.service !== 'viewtrace-collector' ||
    typeof h.pid !== 'number' || typeof h.bootId !== 'string' || typeof h.protocolVersion !== 'number'
  ) {
    return { state: 'stale', reason: 'control endpoint is not a viewtrace collector' };
  }
  if (h.pid !== info.pid || h.bootId !== info.bootId) {
    return {
      state: 'stale',
      reason: `service.json identity mismatch (file pid=${info.pid}, listener pid=${h.pid})`,
    };
  }
  return { state: 'running', health: h as HealthInfo, info: { port: info.port, token: info.token } };
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
