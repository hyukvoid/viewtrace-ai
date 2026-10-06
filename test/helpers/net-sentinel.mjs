/**
 * Network sentinel preload for ViewTrace tests.
 *
 * Loaded with `node --import` before the CLI under test. Any attempt to make
 * an OUTBOUND network connection is recorded (and fails loudly). Loopback
 * connections (127.0.0.1 / localhost / ::1) are counted separately but are
 * NOT violations — the M1 control channel legitimately talks to the local
 * collector; the product contract bans EXTERNAL network, not loopback IPC.
 *
 * The report is written to $NET_SENTINEL_REPORT on exit; exit code 42 if
 * external violations were recorded.
 */

import { writeFileSync } from 'node:fs';
import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';

const reportPath = process.env.NET_SENTINEL_REPORT;
const violations = [];
const loopbackUses = [];

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', undefined, '']);

function hostOf(arg) {
  if (arg === null || typeof arg !== 'object') return null;
  return arg.host ?? arg.hostname ?? null;
}

function isLoopback(kind, target, arg) {
  if (kind === 'net.connect' || kind === 'net.createConnection') {
    const host = hostOf(arg);
    if (host === null) {
      // net.connect(port) with no host defaults to localhost.
      return true;
    }
    return LOOPBACK_HOSTS.has(String(host));
  }
  if (kind === 'http.request' || kind === 'http.get' || kind === 'https.request' || kind === 'https.get') {
    if (typeof target === 'string') {
      return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(target);
    }
    const host = hostOf(arg ?? target);
    if (host === null) {
      return true; // http.request() with no host defaults to localhost
    }
    return LOOPBACK_HOSTS.has(String(host));
  }
  if (kind === 'dns.lookup' || kind === 'dns.resolve') {
    return LOOPBACK_HOSTS.has(String(target));
  }
  return false;
}

function describeTarget(target) {
  try {
    if (typeof target === 'string') return target;
    if (typeof target === 'function') return '[function]';
    if (target !== null && typeof target === 'object') {
      const host = target.host ?? target.hostname;
      if (host !== undefined) return `${host}:${String(target.port ?? '')}`;
      return '[object]';
    }
    return String(target);
  } catch {
    return '[undescribable]';
  }
}

function record(kind, target, arg) {
  // The sentinel must never break the host application by failing to
  // describe an argument; only a real violation may throw.
  if (isLoopback(kind, target, arg)) {
    loopbackUses.push({ kind, target: describeTarget(target) });
    return;
  }
  const described = describeTarget(target);
  violations.push({ kind, target: described });
  throw new Error(`NET_SENTINEL: outbound network attempt (${kind}: ${described})`);
}

function guard(label, patch) {
  try {
    patch();
  } catch (e) {
    violations.push({ kind: 'sentinel-setup-failed', target: `${label}: ${String(e)}` });
  }
}

guard('net', () => {
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patchedConnect(...args) {
    record('net.connect', args[args.length - 1], args[args.length - 1]);
    return originalConnect.apply(this, args);
  };
  const originalCreateConnection = net.createConnection;
  net.createConnection = function patchedCreateConnection(...args) {
    record('net.createConnection', args[args.length - 1], args[args.length - 1]);
    return originalCreateConnection.apply(net, args);
  };
});

guard('dns', () => {
  dns.lookup = function patchedLookup(hostname) {
    record('dns.lookup', hostname);
  };
  dns.resolve = function patchedResolve(hostname) {
    record('dns.resolve', hostname);
  };
});

guard('http', () => {
  const originalRequest = http.request;
  http.request = function patchedRequest(urlOrOptions, ...rest) {
    record('http.request', urlOrOptions, urlOrOptions);
    return originalRequest.call(http, urlOrOptions, ...rest);
  };
  const originalGet = http.get;
  http.get = function patchedGet(urlOrOptions, ...rest) {
    record('http.get', urlOrOptions, urlOrOptions);
    return originalGet.call(http, urlOrOptions, ...rest);
  };
});

guard('https', () => {
  const originalRequest = https.request;
  https.request = function patchedRequest(urlOrOptions, ...rest) {
    record('https.request', urlOrOptions, urlOrOptions);
    return originalRequest.call(https, urlOrOptions, ...rest);
  };
  const originalGet = https.get;
  https.get = function patchedGet(urlOrOptions, ...rest) {
    record('https.get', urlOrOptions, urlOrOptions);
    return originalGet.call(https, urlOrOptions, ...rest);
  };
});

guard('fetch', () => {
  if (typeof globalThis.fetch === 'function') {
    globalThis.fetch = function patchedFetch(input) {
      record('fetch', input);
      return Promise.reject(new Error('NET_SENTINEL: fetch blocked'));
    };
  }
});

process.on('exit', (code) => {
  if (reportPath !== undefined) {
    try {
      writeFileSync(reportPath, JSON.stringify({ violations, loopbackUses, exitCode: code }, null, 2));
    } catch {
      /* report is best-effort; assertions read it when present */
    }
  }
  if (violations.length > 0 && code !== 42) {
    process.exitCode = 42;
  }
});
