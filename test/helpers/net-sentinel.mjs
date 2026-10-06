/**
 * Network sentinel preload for ViewTrace tests.
 *
 * Loaded with `node --import` before the CLI under test. Any attempt to make
 * an outbound network connection is recorded (and fails loudly). The report
 * is written to $NET_SENTINEL_REPORT on exit; exit code 42 if violations
 * were recorded.
 */

import { writeFileSync } from 'node:fs';
import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';

const reportPath = process.env.NET_SENTINEL_REPORT;
const violations = [];

function record(kind, target) {
  violations.push({ kind, target: String(target) });
  throw new Error(`NET_SENTINEL: outbound network attempt (${kind}: ${target})`);
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
    record('net.connect', args[args.length - 1]);
    return originalConnect.apply(this, args);
  };
  const originalCreateConnection = net.createConnection;
  net.createConnection = function patchedCreateConnection(...args) {
    record('net.createConnection', args[args.length - 1]);
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
    record('http.request', typeof urlOrOptions === 'string' ? urlOrOptions : 'options');
    return originalRequest.call(http, urlOrOptions, ...rest);
  };
  const originalGet = http.get;
  http.get = function patchedGet(urlOrOptions, ...rest) {
    record('http.get', typeof urlOrOptions === 'string' ? urlOrOptions : 'options');
    return originalGet.call(http, urlOrOptions, ...rest);
  };
});

guard('https', () => {
  const originalRequest = https.request;
  https.request = function patchedRequest(urlOrOptions, ...rest) {
    record('https.request', typeof urlOrOptions === 'string' ? urlOrOptions : 'options');
    return originalRequest.call(https, urlOrOptions, ...rest);
  };
  const originalGet = https.get;
  https.get = function patchedGet(urlOrOptions, ...rest) {
    record('https.get', typeof urlOrOptions === 'string' ? urlOrOptions : 'options');
    return originalGet.call(https, urlOrOptions, ...rest);
  };
});

guard('fetch', () => {
  if (typeof globalThis.fetch === 'function') {
    globalThis.fetch = function patchedFetch(input) {
      record('fetch', typeof input === 'string' ? input : 'request');
      return Promise.reject(new Error('NET_SENTINEL: fetch blocked'));
    };
  }
});

process.on('exit', (code) => {
  if (reportPath !== undefined) {
    try {
      writeFileSync(reportPath, JSON.stringify({ violations, exitCode: code }, null, 2));
    } catch {
      /* report is best-effort; assertions read it when present */
    }
  }
});
