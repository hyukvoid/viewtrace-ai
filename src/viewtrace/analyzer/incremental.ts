/**
 * ViewTrace M3 Incremental Analysis revision helpers.
 *
 * The input revision is a *chain* hash over the scoped, sequence-ordered
 * canonical events: rev(n) = H(rev(n-1) || canonical(event_n)). Chaining
 * makes the revision resumable from a persisted hex digest, so the
 * incremental engine never re-hashes the processed prefix while a full
 * rebuild over the same events yields the identical value.
 */

import { createHash } from 'node:crypto';
import { canonicalize } from '../canonical.js';
import type {
  AnalysisAnchor,
  AnalysisInputSignature,
  AnalyzerIdentity,
  IncrementalCursor,
  InputRevision,
} from '../analysis-types.js';

export const ANALYZER_ID = 'viewtrace-incremental-analyzer';
export const ANALYZER_VERSION = '1.1.0';
export const RULE_SET_VERSION = '1.1.0';

export function defaultAnalyzerIdentity(): AnalyzerIdentity {
  return {
    analyzerId: ANALYZER_ID,
    analyzerVersion: ANALYZER_VERSION,
    ruleSetVersion: RULE_SET_VERSION,
  };
}

const CHAIN_GENESIS = 'viewtrace-analysis-input-chain-v1';

export function chainGenesis(): string {
  return createHash('sha256').update(CHAIN_GENESIS).digest('hex');
}

export function chainStep(previousHex: string, canonicalEvent: string): string {
  return createHash('sha256').update(`${previousHex}\n${canonicalEvent}`).digest('hex');
}

export function computeInputRevision(events: readonly import('../types.js').ViewTraceEvent[]): InputRevision {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  let hex = chainGenesis();
  for (const ev of sorted) {
    hex = chainStep(hex, canonicalize(ev));
  }
  return {
    algorithm: 'sha256-canonical-schema1-records-v1',
    value: hex,
    recordCount: events.length,
  };
}

export interface StateRevisionInputs {
  readonly inputRevision: InputRevision;
  readonly analyzer: AnalyzerIdentity;
  readonly cursors: readonly IncrementalCursor[];
  readonly collectionCompleteness: string;
  readonly scopeIdsHash: string;
}

export function computeStateRevision(inputs: StateRevisionInputs): string {
  return createHash('sha256')
    .update(
      canonicalize({
        inputRevision: inputs.inputRevision,
        analyzer: inputs.analyzer,
        cursors: inputs.cursors,
        collectionCompleteness: inputs.collectionCompleteness,
        scopeIdsHash: inputs.scopeIdsHash,
      }),
    )
    .digest('hex');
}

export function scopeIdsHash(scopeIds: readonly string[] | undefined): string {
  const material = scopeIds ? [...scopeIds].sort().join('\n') : 'run-container';
  return createHash('sha256').update(material).digest('hex');
}

export function anchorKey(a: AnalysisAnchor): string {
  return `${a.runId}:${a.eventId ?? ''}:${a.answerId ?? ''}:${a.sourceId ?? ''}`;
}

export interface ScopeCompatibility {
  readonly compatible: boolean;
}

/**
 * A persisted state is resumable only when its scope identity matches the
 * current receipt scope; otherwise the engine records an ANSWER_SCOPE_CHANGE
 * invalidation and re-folds from scratch.
 */
export function checkScopeCompatibility(
  persistedScopeIds: readonly string[] | undefined,
  persistedWasExact: boolean,
  currentScopeIds: readonly string[] | undefined,
  currentIsExact: boolean,
): ScopeCompatibility {
  const sameMode = persistedWasExact === currentIsExact;
  const sameIds =
    JSON.stringify([...(persistedScopeIds ?? [])].sort()) === JSON.stringify([...(currentScopeIds ?? [])].sort());
  return { compatible: sameMode && sameIds };
}

export function signatureMatches(
  a: AnalysisInputSignature | undefined,
  b: AnalysisInputSignature | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.scopeEventCount === b.scopeEventCount &&
    a.maxSequence === b.maxSequence &&
    a.scopeIdsHash === b.scopeIdsHash &&
    a.collectionCompleteness === b.collectionCompleteness
  );
}
