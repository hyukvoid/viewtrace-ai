/**
 * M1 control-channel security against the real collector service:
 * §3 boundaries — loopback-only bind, Host allowlist, Origin refusal, token
 * on every endpoint, no CORS, method/body limits, terse errors.
 */

import { connect } from 'node:net';
import * as http from 'node:http';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServiceFile } from './helpers/m1.js';
import {
  downService,
  pidAlive,
  readServiceFile,
  runBin,
  upService,
  waitForPidExit,
} from './helpers/m1.js';
import { controlRequest } from '../src/viewtrace/control.js';

let root: string;

async function rawHttp(
  port: number,
  raw: string,
  timeoutMs = 3000,
): Promise<{ status: number; headers: string; body: string }> {
  return new Promise((resolveRaw, rejectRaw) => {
    const socket = connect(port, '127.0.0.1');
    let response = '';
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => socket.write(raw));
    socket.on('data', (c: Buffer) => {
      response += c.toString('utf8');
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolveRaw(parseResponse(response));
    });
    socket.on('close', () => resolveRaw(parseResponse(response)));
    socket.on('error', rejectRaw);
  });
}

function parseResponse(response: string): { status: number; headers: string; body: string } {
  const split = response.indexOf('\r\n\r\n');
  const head = split === -1 ? response : response.slice(0, split);
  const body = split === -1 ? '' : response.slice(split + 4);
  const statusLine = head.split('\r\n')[0] ?? '';
  const status = Number(statusLine.split(' ')[1] ?? 0);
  return { status, headers: head, body };
}

async function requireService(): Promise<ServiceFile> {
  const info = await readServiceFile(root);
  if (info === null) assert.fail('service.json missing after up');
  return info;
}

describe('viewtrace control channel (real service, §3 boundaries)', () => {
  after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('binds IPv4 127.0.0.1 only and serves health to the token holder', async () => {
    root = await mkdtemp(join(tmpdir(), 'vt-control-'));
    await upService(root);
    const info = await requireService();
    const health = await controlRequest({
      port: info.port,
      token: info.token,
      method: 'GET',
      path: '/health',
    });
    assert.equal(health.status, 200);
    const body = health.json as { ok: boolean; service: string; boundAddress: string; pid: number };
    assert.equal(body.ok, true);
    assert.equal(body.service, 'viewtrace-collector');
    assert.equal(body.boundAddress, '127.0.0.1', 'must bind 127.0.0.1, nothing else');
    assert.equal(body.pid, info.pid);

    // IPv6 loopback must NOT reach the control server.
    await assert.rejects(
      controlRequestV6(info.port, info.token),
      'control server must not be reachable over IPv6',
    );
  });

  it('rejects forged Host headers (DNS-rebinding shape) with 403', async () => {
    const info = await requireService();
    const result = await rawHttp(
      info.port,
      `GET /health HTTP/1.1\r\nHost: attacker.example\r\nAuthorization: Bearer ${info.token}\r\nConnection: close\r\n\r\n`,
    );
    assert.equal(result.status, 403);
    const result2 = await rawHttp(
      info.port,
      `GET /health HTTP/1.1\r\nHost: 127.0.0.1:${info.port + 1}\r\nAuthorization: Bearer ${info.token}\r\nConnection: close\r\n\r\n`,
    );
    assert.equal(result2.status, 403, 'a Host naming a different port is refused');
  });

  it('rejects HTTP/1.0 requests with no Host header', async () => {
    const info = await requireService();
    const result = await rawHttp(info.port, `GET /health HTTP/1.0\r\nAuthorization: Bearer ${info.token}\r\n\r\n`);
    assert.equal(result.status, 403);
  });

  it('requires the token on every endpoint, including reads', async () => {
    const info = await requireService();
    assert.equal(
      (await controlRequest({ port: info.port, token: '', method: 'GET', path: '/health' })).status,
      401,
    );
    assert.equal(
      (
        await controlRequest({
          port: info.port,
          token: 'a'.repeat(64),
          method: 'GET',
          path: '/health',
        })
      ).status,
      401,
    );
    assert.equal(
      (await controlRequest({ port: info.port, token: '', method: 'GET', path: '/runs' })).status,
      401,
    );
  });

  it('never emits CORS headers and refuses preflight/origins', async () => {
    const info = await requireService();
    const preflight = await rawHttp(
      info.port,
      `OPTIONS /runs HTTP/1.1\r\nHost: 127.0.0.1:${info.port}\r\nOrigin: http://evil.example\r\nAccess-Control-Request-Method: POST\r\nAuthorization: Bearer ${info.token}\r\nConnection: close\r\n\r\n`,
    );
    assert.ok(
      preflight.status === 403 || preflight.status === 405,
      `cross-origin preflight must be refused, got ${preflight.status}`,
    );
    assert.ok(!/access-control/i.test(preflight.headers), 'no CORS headers may ever be emitted');

    const plainOptions = await rawHttp(
      info.port,
      `OPTIONS /runs HTTP/1.1\r\nHost: 127.0.0.1:${info.port}\r\nAuthorization: Bearer ${info.token}\r\nConnection: close\r\n\r\n`,
    );
    assert.equal(plainOptions.status, 405, 'OPTIONS is not an allowed method');

    const evilOrigin = await rawHttp(
      info.port,
      `GET /runs HTTP/1.1\r\nHost: 127.0.0.1:${info.port}\r\nOrigin: http://evil.example\r\nAuthorization: Bearer ${info.token}\r\nConnection: close\r\n\r\n`,
    );
    assert.equal(evilOrigin.status, 403);

    const nullOrigin = await rawHttp(
      info.port,
      `GET /runs HTTP/1.1\r\nHost: 127.0.0.1:${info.port}\r\nOrigin: null\r\nAuthorization: Bearer ${info.token}\r\nConnection: close\r\n\r\n`,
    );
    assert.equal(nullOrigin.status, 403);
  });

  it('enforces methods, paths, query strings and body caps', async () => {
    const info = await requireService();
    assert.equal(
      (
        await controlRequest({
          port: info.port,
          token: info.token,
          method: 'POST',
          path: '/health',
        })
      ).status,
      405,
    );
    assert.equal(
      (
        await controlRequest({
          port: info.port,
          token: info.token,
          method: 'GET',
          path: '/nope',
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await controlRequest({
          port: info.port,
          token: info.token,
          method: 'GET',
          path: '/health?x=1',
        })
      ).status,
      400,
    );

    // Oversized declared body: headers announce 64KB, we only send a few
    // bytes and read the refusal — no EPIPE race from writing the payload.
    const oversized = await rawHttp(
      info.port,
      `POST /shutdown HTTP/1.1\r\nHost: 127.0.0.1:${info.port}\r\nAuthorization: Bearer ${info.token}\r\nContent-Length: 65536\r\nConnection: close\r\n\r\nxxxxx`,
    );
    assert.equal(oversized.status, 413);
  });

  it('shuts down through the authenticated API and leaves no process behind', async () => {
    const info = await requireService();
    await downService(root);
    await waitForPidExit(info.pid);
    assert.equal(pidAlive(info.pid), false, 'service process must be gone after down');
    assert.equal((await readServiceFile(root)), null, 'service.json must be removed');
    const status = await runBin(['status', '--data-root', root]);
    assert.equal(status.code, 1);
  });
});

function controlRequestV6(port: number, token: string): Promise<unknown> {
  return new Promise((resolveV6, rejectV6) => {
    const req = http.request(
      { host: '::1', port, method: 'GET', path: '/health', headers: { authorization: `Bearer ${token}` }, timeout: 1500 },
      (res) => {
        res.resume();
        res.on('end', () => rejectV6(new Error(`unexpected IPv6 response ${res.statusCode}`)));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      rejectV6(new Error('timeout'));
    });
    req.on('error', (e) => rejectV6(e));
    req.end();
  });
}
