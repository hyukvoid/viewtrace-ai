import type { AnswerContext, Association } from './answer.js';
import { ANSWER_HASH_VERSION } from './answer.js';
import { isValidEventId, isValidRunId } from './validate.js';
import type { ViewTraceStore } from './store.js';

const KEYS = [
  'agentId',
  'agentSessionId',
  'turnId',
  'receiptId',
  'runId',
  'answerId',
  'answerHash',
  'hashVersion',
] as const;
export function parseAnswerContext(raw: Record<string, unknown>): AnswerContext {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(KEYS as readonly string[]).includes(key) || typeof value !== 'string' || value.length === 0)
      throw new Error('INVALID_CONTEXT');
    if (
      key === 'answerHash'
        ? !/^[a-f0-9]{64}$/.test(value)
        : key === 'hashVersion'
          ? value !== ANSWER_HASH_VERSION
          : key === 'runId'
            ? !isValidRunId(value)
            : !isValidEventId(value)
    )
      throw new Error('INVALID_CONTEXT');
    out[key] = value;
  }
  return out;
}

/** Stronger identity failures never fall back to hash, latest, cwd or time. */
export function resolveAnswer(store: ViewTraceStore | null, context: AnswerContext): Association {
  parseAnswerContext(context as Record<string, unknown>);
  const result = (
    status: Association['status'],
    reason: string,
    basis: Association['basis'] = 'none',
  ): Association => ({ status, reason, basis });
  if (!store) return result('missing', 'NO_STORED_TRACES');
  let candidate;
  let basis: Association['basis'] = 'none';
  if (context.agentSessionId && context.turnId && context.agentId) {
    basis = 'session-turn';
    const candidates = store.turnAnswers(context.agentId, context.agentSessionId, context.turnId);
    if (candidates.length === 0) return result('missing', 'TURN_NOT_FOUND', basis);
    if (candidates.length > 1) return result('uncertain', 'MULTIPLE_FINAL_ANSWERS_FOR_TURN', basis);
    candidate = candidates[0];
  } else if (context.receiptId) {
    basis = 'receipt';
    candidate = store.getReceipt(context.receiptId);
    if (!candidate) return result('missing', 'RECEIPT_NOT_FOUND', basis);
  } else {
    return result(
      'uncertain',
      context.answerHash ? 'HASH_CANNOT_ESTABLISH_IDENTITY' : 'ANSWER_CONTEXT_REQUIRED',
      context.answerHash ? 'hash-only' : 'none',
    );
  }
  if (!candidate) return result('missing', 'ANSWER_NOT_FOUND', basis);
  for (const key of [
    'agentId',
    'agentSessionId',
    'turnId',
    'receiptId',
    'runId',
    'answerId',
    'answerHash',
    'hashVersion',
  ] as const) {
    if (context[key] !== undefined && context[key] !== candidate[key])
      return result('mismatch', `CONFLICTING_${key.toUpperCase()}`, basis);
  }
  if (context.answerHash && context.hashVersion !== candidate.hashVersion)
    return result('mismatch', 'HASH_POLICY_REQUIRED', basis);
  if (store.receiptConflicted(candidate)) return result('mismatch', 'RECEIPT_PAYLOAD_CONFLICT', basis);
  const scope = store.answerScope(candidate);
  if (scope.status !== 'EXPLICIT') return result('uncertain', 'ANSWER_SCOPE_UNKNOWN', basis);
  return {
    status: 'matched',
    reason: context.answerHash ? 'IDENTITY_AND_HASH_CORROBORATED' : 'EXPLICIT_IDENTITY',
    basis,
    receipt: candidate,
  };
}
