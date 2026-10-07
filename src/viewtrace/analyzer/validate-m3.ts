/**
 * Runtime schema and contract validator for ViewTrace M3 derived-analysis artifacts.
 *
 * Enforces strict typing, rejects foreign fields, checks required basis for
 * inferred elements, and validates enum domains according to docs/MILESTONES.md §8.
 */

import {
  ANALYSIS_MODES,
  CONDITION_DIMENSIONS,
  CONDITION_OPERATORS,
  M3_ANALYSIS_REPORT_SCHEMA,
  M3_EVIDENCE_EXTENSION_SCHEMA,
  M3_INCREMENTAL_STATE_SCHEMA,
  M3_JEV_CHECKPOINT_SCHEMA,
  M3_JEV_RESULT_SCHEMA,
  M3_SUPPORTED_SCHEMAS,
  PROVENANCE_INTEGRITY,
  SOURCE_ROLES,
  JEV_TRIGGER_REASONS,
  type AnalysisMode,
  type AnalysisReportV1,
  type ConditionDimension,
  type ConditionOperator,
  type EvidenceExtensionV1,
  type IncrementalAnalysisStateV1,
  type JevCheckpointV2,
  type JevResultV2,
  type M3Artifact,
  type ProvenanceIntegrity,
  type SourceRole,
  type JevTriggerReason,
} from '../analysis-types.js';
import { EVIDENCE_SUPPORT, PROVENANCE_CATEGORIES, SOURCE_KINDS } from '../types.js';

export interface ValidationOutcome<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: string;
  readonly details?: readonly string[];
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function checkAllowedKeys(obj: Record<string, unknown>, allowedKeys: Set<string>, path: string, errors: string[]) {
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      errors.push(`Disallowed foreign field "${key}" at ${path}`);
    }
  }
}

export function validateBasis(val: unknown, path: string, errors: string[]): boolean {
  if (!isObject(val)) {
    errors.push(`Expected basis object at ${path}`);
    return false;
  }
  const allowed = new Set(['ruleId', 'ruleVersion', 'inputAnchors', 'limitations']);
  checkAllowedKeys(val, allowed, path, errors);
  if (typeof val['ruleId'] !== 'string' || !val['ruleId']) {
    errors.push(`Invalid or missing ruleId in basis at ${path}`);
  }
  if (typeof val['ruleVersion'] !== 'string' || !val['ruleVersion']) {
    errors.push(`Invalid or missing ruleVersion in basis at ${path}`);
  }
  if (!Array.isArray(val['inputAnchors'])) {
    errors.push(`Expected inputAnchors array in basis at ${path}`);
  }
  if (!Array.isArray(val['limitations'])) {
    errors.push(`Expected limitations array in basis at ${path}`);
  }
  return true;
}

export function validateInputRevision(val: unknown, path: string, errors: string[]): boolean {
  if (!isObject(val)) {
    errors.push(`Expected inputRevision object at ${path}`);
    return false;
  }
  const allowed = new Set(['algorithm', 'value', 'recordCount']);
  checkAllowedKeys(val, allowed, path, errors);
  if (val['algorithm'] !== 'sha256-canonical-schema1-records-v1') {
    errors.push(`Unsupported inputRevision algorithm "${String(val['algorithm'])}" at ${path}`);
  }
  if (typeof val['value'] !== 'string' || !/^[a-f0-9]{64}$/.test(val['value'])) {
    errors.push(`Invalid inputRevision hash value at ${path}`);
  }
  if (typeof val['recordCount'] !== 'number' || val['recordCount'] < 0 || !Number.isInteger(val['recordCount'])) {
    errors.push(`Invalid inputRevision recordCount at ${path}`);
  }
  return true;
}

export function validateAnalyzerIdentity(val: unknown, path: string, errors: string[]): boolean {
  if (!isObject(val)) {
    errors.push(`Expected analyzer object at ${path}`);
    return false;
  }
  const allowed = new Set(['analyzerId', 'analyzerVersion', 'ruleSetVersion']);
  checkAllowedKeys(val, allowed, path, errors);
  if (typeof val['analyzerId'] !== 'string' || !val['analyzerId']) {
    errors.push(`Missing analyzerId at ${path}`);
  }
  if (typeof val['analyzerVersion'] !== 'string' || !val['analyzerVersion']) {
    errors.push(`Missing analyzerVersion at ${path}`);
  }
  if (typeof val['ruleSetVersion'] !== 'string' || !val['ruleSetVersion']) {
    errors.push(`Missing ruleSetVersion at ${path}`);
  }
  return true;
}

export function validateAnalysisReport(val: unknown): ValidationOutcome<AnalysisReportV1> {
  const errors: string[] = [];
  if (!isObject(val)) {
    return { ok: false, error: 'Expected object for AnalysisReportV1', details: ['Not an object'] };
  }

  const allowedKeys = new Set([
    'schema',
    'captureSchemaVersion',
    'analyzer',
    'inputRevision',
    'stateRevision',
    'freshness',
    'scope',
    'lens',
    'projection',
    'conditions',
    'sources',
    'evidence',
    'claims',
    'relations',
    'conflicts',
    'verifications',
    'support',
    'topology',
    'references',
    'jevResults',
  ]);
  checkAllowedKeys(val, allowedKeys, 'AnalysisReport', errors);

  if (val['schema'] !== M3_ANALYSIS_REPORT_SCHEMA) {
    errors.push(`Invalid schema "${String(val['schema'])}"; expected "${M3_ANALYSIS_REPORT_SCHEMA}"`);
  }
  if (val['captureSchemaVersion'] !== 1) {
    errors.push(`Invalid captureSchemaVersion ${String(val['captureSchemaVersion'])}; expected 1`);
  }

  validateAnalyzerIdentity(val['analyzer'], 'AnalysisReport.analyzer', errors);
  validateInputRevision(val['inputRevision'], 'AnalysisReport.inputRevision', errors);

  if (typeof val['stateRevision'] !== 'string' || !val['stateRevision']) {
    errors.push('Missing stateRevision');
  }

  // Freshness
  if (!isObject(val['freshness'])) {
    errors.push('Missing freshness object');
  } else {
    const freshnessKeys = new Set(['status', 'reasons']);
    checkAllowedKeys(val['freshness'], freshnessKeys, 'AnalysisReport.freshness', errors);
    if (val['freshness']['status'] !== 'CURRENT' && val['freshness']['status'] !== 'STALE') {
      errors.push(`Invalid freshness status "${String(val['freshness']['status'])}"`);
    }
    if (!Array.isArray(val['freshness']['reasons'])) {
      errors.push('freshness.reasons must be an array');
    }
  }

  // Scope
  if (!isObject(val['scope'])) {
    errors.push('Missing scope object');
  } else {
    const scopeKeys = new Set(['runId', 'answerId', 'receiptId', 'boundary', 'ownEventIds', 'sharedEventIds']);
    checkAllowedKeys(val['scope'], scopeKeys, 'AnalysisReport.scope', errors);
    if (typeof val['scope']['runId'] !== 'string' || !val['scope']['runId']) {
      errors.push('Invalid scope.runId');
    }
    if (typeof val['scope']['answerId'] !== 'string' || !val['scope']['answerId']) {
      errors.push('Invalid scope.answerId');
    }
    if (typeof val['scope']['receiptId'] !== 'string' || !val['scope']['receiptId']) {
      errors.push('Invalid scope.receiptId');
    }
    if (!['EXACT', 'PARTIAL', 'UNKNOWN'].includes(String(val['scope']['boundary']))) {
      errors.push(`Invalid scope.boundary "${String(val['scope']['boundary'])}"`);
    }
  }

  // Lens
  if (!isObject(val['lens'])) {
    errors.push('Missing lens object');
  } else {
    const lensKeys = new Set(['revisions', 'currentRevisionId', 'currentMode', 'domain', 'temporal']);
    checkAllowedKeys(val['lens'], lensKeys, 'AnalysisReport.lens', errors);
    if (!ANALYSIS_MODES.includes(val['lens']['currentMode'] as AnalysisMode)) {
      errors.push(`Invalid currentMode "${String(val['lens']['currentMode'])}"`);
    }
    if (!['NONE', 'FRESHNESS_SENSITIVE', 'UNKNOWN'].includes(String(val['lens']['temporal']))) {
      errors.push(`Invalid temporal setting "${String(val['lens']['temporal'])}"`);
    }
    if (!Array.isArray(val['lens']['revisions']) || val['lens']['revisions'].length === 0) {
      errors.push('lens.revisions must be a non-empty array');
    }
  }

  // Projection
  if (!isObject(val['projection'])) {
    errors.push('Missing projection object');
  } else {
    if (!ANALYSIS_MODES.includes(val['projection']['mode'] as AnalysisMode)) {
      errors.push(`Invalid projection.mode "${String(val['projection']['mode'])}"`);
    }
  }

  // Arrays
  const arrayFields = [
    'conditions',
    'sources',
    'evidence',
    'claims',
    'relations',
    'conflicts',
    'verifications',
    'references',
    'jevResults',
  ] as const;
  for (const field of arrayFields) {
    if (!Array.isArray(val[field])) {
      errors.push(`${field} must be an array`);
    }
  }

  // Evidence items: admissibility and grounding enums (grounding gates
  // direct claim support; a foreign value must never pass silently).
  if (Array.isArray(val['evidence'])) {
    for (const [i, item] of (val['evidence'] as unknown[]).entries()) {
      if (!isObject(item)) {
        errors.push(`evidence[${i}] must be an object`);
        continue;
      }
      if (
        item['admissibility'] !== undefined &&
        !['ADMISSIBLE', 'INADMISSIBLE', 'UNKNOWN'].includes(String(item['admissibility']))
      ) {
        errors.push(`Invalid evidence admissibility "${String(item['admissibility'])}" at evidence[${i}]`);
      }
      if (
        item['grounding'] !== undefined &&
        !['SOURCE_CONTENT', 'ACTIVITY_ONLY', 'UNKNOWN'].includes(String(item['grounding']))
      ) {
        errors.push(`Invalid evidence grounding "${String(item['grounding'])}" at evidence[${i}]`);
      }
    }
  }

  // Support
  if (!isObject(val['support'])) {
    errors.push('Missing support object');
  } else {
    const supportKeys = new Set([
      'status',
      'collectionCompleteness',
      'coreClaimIds',
      'evaluatedClaimIds',
      'missingRequiredConditionIds',
      'unresolvedConflictIds',
      'reasonCodes',
      'basis',
    ]);
    checkAllowedKeys(val['support'], supportKeys, 'AnalysisReport.support', errors);
    if (!EVIDENCE_SUPPORT.includes(val['support']['status'] as any)) {
      errors.push(`Invalid support status "${String(val['support']['status'])}"`);
    }
    validateBasis(val['support']['basis'], 'AnalysisReport.support.basis', errors);
  }

  // Topology
  if (!isObject(val['topology'])) {
    errors.push('Missing topology object');
  } else {
    const topoKeys = new Set([
      'nodes',
      'edges',
      'frontierStatus',
      'currentFrontierNodeIds',
      'activityConcentration',
      'sourceConcentration',
      'observedDuration',
      'limitations',
    ]);
    checkAllowedKeys(val['topology'], topoKeys, 'AnalysisReport.topology', errors);
    if (!['OBSERVED', 'INFERRED', 'UNKNOWN'].includes(String(val['topology']['frontierStatus']))) {
      errors.push(`Invalid frontierStatus "${String(val['topology']['frontierStatus'])}"`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join('; '), details: errors };
  }
  return { ok: true, value: val as unknown as AnalysisReportV1 };
}

export function validateIncrementalState(val: unknown): ValidationOutcome<IncrementalAnalysisStateV1> {
  const errors: string[] = [];
  if (!isObject(val)) {
    return { ok: false, error: 'Expected object for IncrementalAnalysisStateV1', details: ['Not an object'] };
  }
  const allowedKeys = new Set([
    'schema',
    'captureSchemaVersion',
    'analyzer',
    'inputRevision',
    'stateRevision',
    'cursors',
    'scopes',
    'dependencies',
    'pendingReferences',
    'invalidations',
    'selectedCheckpointIds',
    'completedJevResultIds',
    'processedEventIds',
    'inputSignature',
    'fold',
    'lastRunStats',
  ]);
  checkAllowedKeys(val, allowedKeys, 'IncrementalAnalysisState', errors);

  if (val['schema'] !== M3_INCREMENTAL_STATE_SCHEMA) {
    errors.push(`Invalid schema "${String(val['schema'])}"; expected "${M3_INCREMENTAL_STATE_SCHEMA}"`);
  }
  if (val['captureSchemaVersion'] !== 1) {
    errors.push(`Invalid captureSchemaVersion ${String(val['captureSchemaVersion'])}; expected 1`);
  }
  validateAnalyzerIdentity(val['analyzer'], 'IncrementalAnalysisState.analyzer', errors);
  validateInputRevision(val['inputRevision'], 'IncrementalAnalysisState.inputRevision', errors);

  for (const arrayField of [
    'cursors',
    'scopes',
    'dependencies',
    'pendingReferences',
    'invalidations',
    'selectedCheckpointIds',
    'completedJevResultIds',
    'processedEventIds',
  ]) {
    if (val[arrayField] !== undefined && !Array.isArray(val[arrayField])) {
      errors.push(`State field "${arrayField}" must be an array`);
    }
  }

  if (val['inputSignature'] !== undefined) {
    if (!isObject(val['inputSignature'])) {
      errors.push('State field "inputSignature" must be an object');
    } else {
      const sigKeys = new Set(['scopeEventCount', 'maxSequence', 'scopeIdsHash', 'collectionCompleteness']);
      checkAllowedKeys(val['inputSignature'], sigKeys, 'IncrementalAnalysisState.inputSignature', errors);
    }
  }

  if (val['fold'] !== undefined) {
    if (!isObject(val['fold'])) {
      errors.push('State field "fold" must be an object');
    } else if (val['fold']['snapshotVersion'] !== 1) {
      errors.push('State field "fold.snapshotVersion" must be 1');
    }
  }

  if (val['lastRunStats'] !== undefined) {
    if (!isObject(val['lastRunStats'])) {
      errors.push('State field "lastRunStats" must be an object');
    } else {
      const statKeys = new Set([
        'mode',
        'eventsExamined',
        'deltaEventCount',
        'claimsEvaluated',
        'claimsReusedFromCache',
        'jevCheckpointsEvaluated',
        'stateLoaded',
        'invalidationsRecorded',
      ]);
      checkAllowedKeys(val['lastRunStats'], statKeys, 'IncrementalAnalysisState.lastRunStats', errors);
      if (val['lastRunStats']['mode'] !== 'INCREMENTAL_DELTA' && val['lastRunStats']['mode'] !== 'FULL_FOLD') {
        errors.push(`Invalid lastRunStats.mode "${String(val['lastRunStats']['mode'])}"`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join('; '), details: errors };
  }
  return { ok: true, value: val as unknown as IncrementalAnalysisStateV1 };
}

export function validateJevCheckpoint(val: unknown): ValidationOutcome<JevCheckpointV2> {
  const errors: string[] = [];
  if (!isObject(val)) {
    return { ok: false, error: 'Expected object for JevCheckpointV2', details: ['Not an object'] };
  }
  const allowedKeys = new Set([
    'schema',
    'checkpointId',
    'deduplicationKey',
    'selectorVersion',
    'analyzer',
    'inputRevision',
    'scope',
    'triggerReasons',
    'delta',
    'budget',
  ]);
  checkAllowedKeys(val, allowedKeys, 'JevCheckpoint', errors);

  if (val['schema'] !== M3_JEV_CHECKPOINT_SCHEMA) {
    errors.push(`Invalid schema "${String(val['schema'])}"; expected "${M3_JEV_CHECKPOINT_SCHEMA}"`);
  }
  if (typeof val['checkpointId'] !== 'string' || !val['checkpointId']) {
    errors.push('Invalid checkpointId');
  }
  if (typeof val['deduplicationKey'] !== 'string' || !val['deduplicationKey']) {
    errors.push('Invalid deduplicationKey');
  }
  validateAnalyzerIdentity(val['analyzer'], 'JevCheckpoint.analyzer', errors);
  validateInputRevision(val['inputRevision'], 'JevCheckpoint.inputRevision', errors);

  if (!Array.isArray(val['triggerReasons']) || val['triggerReasons'].length === 0) {
    errors.push('triggerReasons must be non-empty array');
  } else {
    for (const r of val['triggerReasons']) {
      if (!JEV_TRIGGER_REASONS.includes(r as JevTriggerReason)) {
        errors.push(`Unknown trigger reason "${String(r)}"`);
      }
    }
  }

  if (!isObject(val['delta'])) {
    errors.push('Missing delta object');
  }
  if (!isObject(val['budget'])) {
    errors.push('Missing budget object');
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join('; '), details: errors };
  }
  return { ok: true, value: val as unknown as JevCheckpointV2 };
}

export function validateJevResult(val: unknown): ValidationOutcome<JevResultV2> {
  const errors: string[] = [];
  if (!isObject(val)) {
    return { ok: false, error: 'Expected object for JevResultV2', details: ['Not an object'] };
  }
  const allowedKeys = new Set([
    'schema',
    'resultId',
    'checkpointId',
    'inputRevision',
    'evaluator',
    'status',
    'labels',
    'provenance',
    'supportEffect',
    'limitations',
    'measurement',
  ]);
  checkAllowedKeys(val, allowedKeys, 'JevResult', errors);

  if (val['schema'] !== M3_JEV_RESULT_SCHEMA) {
    errors.push(`Invalid schema "${String(val['schema'])}"; expected "${M3_JEV_RESULT_SCHEMA}"`);
  }
  if (typeof val['resultId'] !== 'string' || !val['resultId']) {
    errors.push('Invalid resultId');
  }
  if (typeof val['checkpointId'] !== 'string' || !val['checkpointId']) {
    errors.push('Invalid checkpointId');
  }
  validateInputRevision(val['inputRevision'], 'JevResult.inputRevision', errors);

  if (!['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'UNAVAILABLE', 'REJECTED', 'STALE'].includes(String(val['status']))) {
    errors.push(`Invalid status "${String(val['status'])}"`);
  }

  if (val['provenance'] !== 'EVALUATOR_REPORTED') {
    errors.push(`Invalid provenance "${String(val['provenance'])}"; must be EVALUATOR_REPORTED`);
  }
  if (val['supportEffect'] !== 'NONE') {
    errors.push(`supportEffect must strictly be "NONE"; got "${String(val['supportEffect'])}"`);
  }

  if (!Array.isArray(val['limitations'])) {
    errors.push('limitations must be an array');
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join('; '), details: errors };
  }
  return { ok: true, value: val as unknown as JevResultV2 };
}
