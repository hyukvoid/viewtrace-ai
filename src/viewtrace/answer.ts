import { createHash } from 'node:crypto';
import { redactSecrets } from './privacy.js';

export const ANSWER_HASH_VERSION = 'sha256-sanitized-nfc-lf-v1';
export function normalizedAnswer(text: string): string {
  return redactSecrets(text).replace(/\r\n?/g, '\n').normalize('NFC');
}
export function answerHash(text: string): string {
  return createHash('sha256').update(normalizedAnswer(text), 'utf8').digest('hex');
}

/** Immutable final receipt. Provider identities are absent when unavailable. */
export interface AnswerReceipt {
  readonly recordKind: 'answer';
  readonly schemaVersion: number;
  readonly receiptVersion: 1;
  readonly receiptId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly agentSessionId?: string;
  readonly turnId?: string;
  readonly answerId: string;
  readonly answer: string;
  readonly answerHash: string;
  readonly hashVersion: typeof ANSWER_HASH_VERSION;
  readonly final: true;
  readonly timestamp: string;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly sequence: number;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly questionSummary?: string;
  /** Undefined = unknown boundary; [] = explicitly no evidence. Same run only. */
  readonly eventIds?: readonly string[];
  readonly sharedEventIds?: readonly string[];
}

export interface AnswerContext {
  readonly agentId?: string;
  readonly agentSessionId?: string;
  readonly turnId?: string;
  readonly receiptId?: string;
  readonly runId?: string;
  readonly answerId?: string;
  readonly answerHash?: string;
  readonly hashVersion?: string;
}

export interface Association {
  readonly status: 'matched' | 'uncertain' | 'missing' | 'mismatch';
  readonly reason: string;
  readonly basis: 'session-turn' | 'receipt' | 'hash-only' | 'none';
  readonly receipt?: AnswerReceipt;
}
