import * as http from 'node:http';
import assert from 'node:assert/strict';
import { validateRecord } from '../../src/viewtrace/validate.js';
import type { AnswerReceipt } from '../../src/viewtrace/answer.js';
export function receipt(overrides: Record<string, unknown> = {}): AnswerReceipt {
  const outcome = validateRecord({
    recordKind: 'answer',
    schemaVersion: 1,
    receiptVersion: 1,
    receiptId: 'r1',
    runId: 'run-answers',
    agentId: 'agent',
    agentSessionId: 'session',
    turnId: 'turn',
    answerId: 'a1',
    answer: 'Same final answer.',
    final: true,
    timestamp: '2026-10-07T00:00:00Z',
    occurredAt: '2026-10-07T00:00:00Z',
    adapterId: 'viewtrace-reference-jsonl',
    adapterVersion: '1.2.0',
    eventIds: [],
    ...overrides,
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.record.recordKind, 'answer');
  return outcome.record as AnswerReceipt;
}
export async function request<T = Record<string, unknown>>(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    host?: string;
  } = {},
) {
  return new Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    text: string;
    json: T;
  }>((resolve, reject) => {
    const req = http.request(
      {
        host: options.host ?? '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers,
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json: json as T,
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('HTTP_TIMEOUT')));
    req.end(options.body);
  });
}
