/**
 * M4 full analysis report rendering for `viewtrace analyze` (CLI text mode).
 *
 * Everything printed here is a projection of `AnalysisReportV1` plus run
 * facts read from the store. The renderer adds no heuristics of its own:
 * missing analyzer facts print as UNKNOWN, advisory JEV results never look
 * like evidence, and every concentration metric prints its denominator and
 * unit so a share can never be mistaken for importance or hidden reasoning.
 */

import type {
  AnalysisReportV1,
  ConcentrationMetric,
  ModeLens,
  ModeProjection,
  SourceLedgerEntry,
} from '../analysis-types.js';
import type { RunState } from '../types.js';
import type { ViewTraceStore } from '../store.js';
import { sanitizeForTerminal, sanitizeTerminalLine } from '../display.js';
import { renderStaticTree } from './tree.js';

export interface CollectionStatusInput {
  readonly run: RunState;
  readonly scoped: { count: number; maxSequence: number };
  readonly scopeLabel: 'answer-scoped' | 'run-scoped';
  readonly diagnosticsTotal: number;
  readonly errorDiagnostics: number;
  readonly lossDiagnostics: number;
  readonly diagnosticsPageCapped: boolean;
  readonly dataRoot: string;
}

export function collectionStatusLines(status: CollectionStatusInput): string[] {
  const cap = status.diagnosticsPageCapped ? '>=' : '';
  return [
    `collection: lifecycle=${status.run.lifecycle} completeness=${status.run.completeness}`,
    `  sequence: max=${status.scoped.maxSequence} accepted events=${status.run.eventCount} (${status.scopeLabel}: ${status.scoped.count} records)`,
    `  rejected/validation errors: ${cap}${status.errorDiagnostics} losses: ${cap}${status.lossDiagnostics} diagnostics total: ${status.diagnosticsTotal}`,
    `  replay: trace.jsonl lines=${status.run.jsonlLines} cursor=${status.run.jsonlCursor} (derived export; database is authoritative)`,
    `  storage: ${status.dataRoot} — viewtrace.db (authoritative), runs/${status.run.runId}/trace.jsonl (derived)`,
  ];
}

/** Bounded, honest collection facts from the store (no full-record reads). */
export function buildCollectionStatus(
  store: ViewTraceStore,
  runId: string,
  dataRoot: string,
  receiptId?: string,
): CollectionStatusInput | null {
  const run = store.getRun(runId);
  if (run === null) return null;
  const scoped = store.scopedEventStats(runId, receiptId);
  const page = store.pageDiagnostics(runId, 1000);
  const total = store.countDiagnostics(runId);
  return {
    run,
    scoped,
    scopeLabel: receiptId !== undefined ? 'answer-scoped' : 'run-scoped',
    diagnosticsTotal: total,
    errorDiagnostics: page.filter((d) => d.severity === 'error' && !d.code.startsWith('LOSS_')).length,
    lossDiagnostics: page.filter((d) => d.code.startsWith('LOSS_')).length,
    diagnosticsPageCapped: page.length >= 1000,
    dataRoot,
  };
}

function laneCounts(report: AnalysisReportV1): { obs: number; rep: number; inf: number; unknown: number } {
  let obs = 0;
  let rep = 0;
  let inf = 0;
  let unknown = 0;
  for (const e of report.evidence) {
    if (e.effectiveProvenance === 'VIEWTRACE_OBSERVED') obs++;
    else if (e.effectiveProvenance === 'AGENT_REPORTED') rep++;
    else if (e.effectiveProvenance === 'VIEWTRACE_INFERRED') inf++;
    else unknown++;
  }
  for (const c of report.claims) {
    if (c.provenance === 'AGENT_REPORTED') rep++;
    else if (c.provenance === 'VIEWTRACE_OBSERVED') obs++;
    else if (c.provenance === 'VIEWTRACE_INFERRED') inf++;
    else unknown++;
  }
  return { obs, rep, inf, unknown };
}

function lensLines(lens: ModeLens): string[] {
  const lines: string[] = [];
  const current = lens.revisions.find((r) => r.revisionId === lens.currentRevisionId);
  lines.push(`  Mode: ${lens.currentMode}${current ? ` [${current.phase}]` : ' [UNKNOWN]'}`);
  if (current?.phase === 'EXPLICIT_OVERRIDE') {
    lines.push('  (explicit override: lens selection only — evidence, scope and provenance unchanged)');
  }
  const history = lens.revisions.map((r) => `${r.phase}->${r.mode}`).join(', ');
  lines.push(`  Lens history: ${history.length > 0 ? history : 'none recorded'}`);
  if (lens.domain !== undefined) lines.push(`  Domain tag: ${sanitizeForTerminal(lens.domain)}`);
  lines.push(`  Temporal: ${lens.temporal}`);
  return lines;
}

function concentrationLine(label: string, metric: ConcentrationMetric): string {
  return `  ${label}: ${metric.numerator}/${metric.denominator} unit=${metric.unit} (${metric.meaning}; excluded ${metric.excluded}; share is not importance or hidden reasoning)`;
}

function sourceLedgerLines(sources: readonly SourceLedgerEntry[]): string[] {
  const lines: string[] = [];
  if (sources.length === 0) {
    lines.push('  sources: none recorded (UNKNOWN — no source claims made)');
    return lines;
  }
  lines.push(`  sources: ${sources.length} normalized`);
  for (const s of sources) {
    const roles =
      s.roles.length > 0
        ? s.roles.map((r) => `${r.role}`).join(',')
        : 'UNKNOWN';
    const dates = `published=${s.publicationDate?.value ?? 'UNKNOWN'} accessed=${s.accessedDate?.value ?? 'UNKNOWN'}`;
    const mirror =
      s.identityStatus === 'POSSIBLE_MIRROR' && s.mirrorOfCanonicalSourceId !== undefined
        ? ` mirror-of=${s.mirrorOfCanonicalSourceId}`
        : '';
    lines.push(
      `    - ${sanitizeForTerminal(s.canonicalSourceId)} [${s.kind}] identity=${s.identityStatus}${mirror} roles=${roles} ${dates}`,
    );
    if (s.location !== undefined) lines.push(`      location: ${sanitizeForTerminal(s.location, 160)}`);
    lines.push(`      edition: ${s.edition ? `${s.edition.label} (${s.edition.provenance})` : 'UNKNOWN'}`);
    lines.push(`      date provenance: published=${s.publicationDate?.provenance ?? 'UNKNOWN'} accessed=${s.accessedDate?.provenance ?? 'UNKNOWN'}`);
    lines.push(`      captured IDs: ${s.capturedSourceIds.join(', ')}; anchors: ${s.anchors.map((a) => a.eventId ?? 'UNKNOWN').join(', ') || 'UNKNOWN'}`);
    if (s.queries.length > 0) {
      lines.push(`      meaningful queries: ${s.queries.length}`);
      for (const query of s.queries) lines.push(`        ${query.eventId}: ${query.query}`);
    }
  }
  return lines;
}

function railLines(report: AnalysisReportV1): string[] {
  const lines: string[] = [];
  const conflicts = report.conflicts;
  const verifications = report.verifications;
  if (conflicts.length === 0 && verifications.length === 0) {
    lines.push('  rail: no contradictions or verifications observed (absence of a contradiction is not proof of consistency)');
    return lines;
  }
  for (const c of conflicts) {
    const resolution = c.resolution
      ? ` resolved by verify ${c.resolution.verifyEventId} (${c.resolution.result})`
      : c.status === 'RESOLVED'
        ? ' resolved (no resolver evidence attached — reported as stored)'
        : ' ? unresolved';
    lines.push(
      `  rail CONFLICT ${sanitizeForTerminal(c.conflictId)} [${c.status}] conditionMatch=${c.conditionMatch} claims=${c.claimIds.join(',')}${resolution}`,
    );
  }
  for (const v of verifications) {
    const target = v.target.kind === 'CLAIM' ? `claim ${v.target.claimId}` : `event ${v.target.eventId}`;
    lines.push(
      `  rail VERIFY ${sanitizeForTerminal(v.verifyEventId)} target=${target} resolution=${v.targetResolution} result=${v.result} correctness=${v.correctness}`,
    );
  }
  return lines;
}

function jevLines(report: AnalysisReportV1): string[] {
  const lines: string[] = [];
  if (report.jevResults.length === 0) {
    lines.push('  JEV v2: no checkpoint evaluations selected for this answer [? UNKNOWN] (not every event is evaluated)');
    return lines;
  }
  lines.push(`  JEV v2 advisory checkpoints: ${report.jevResults.length} (advisory only — never an input to evidence support)`);
  for (const j of report.jevResults) {
    if (j.labels !== undefined && j.status === 'SUCCEEDED') {
      lines.push(
        `    - ${sanitizeForTerminal(j.checkpointId)} [${j.status}] [inf, advisory; ${j.provenance}] evidenceGain=${j.labels.evidenceGain} progress=${j.labels.progress} rethinkNeeded=${j.labels.rethinkNeeded}`,
      );
    } else {
      lines.push(
        `    - ${sanitizeForTerminal(j.checkpointId)} [${j.status}] labels [?] UNKNOWN — evaluation failed or unavailable; the report is unaffected`,
      );
    }
    if (j.measurement?.latencyMs !== undefined) {
      lines.push(`      latency: ${j.measurement.latencyMs}ms (${j.measurement.basis})`);
    }
  }
  return lines;
}

function projectionLines(projection: ModeProjection, report: AnalysisReportV1): string[] {
  const lines: string[] = [];
  const claimText = (claimId: string): string => {
    const claim = report.claims.find((c) => c.claimId === claimId);
    return claim !== undefined ? sanitizeForTerminal(claim.text, 100) : `UNKNOWN claim ${claimId}`;
  };
  switch (projection.mode) {
    case 'EXPLAIN':
      lines.push(`  EXPLAIN structure claims: ${projection.structureClaimIds.length}, causal claims: ${projection.causalClaimIds.length}`);
      for (const id of projection.structureClaimIds) lines.push(`    - [structure] ${claimText(id)}`);
      for (const id of projection.causalClaimIds) lines.push(`    - [causal] ${claimText(id)}`);
      break;
    case 'COMPARE': {
      lines.push(`  COMPARE matrix: ${projection.candidates.length} candidates x ${projection.criteria.length} criteria`);
      for (const cell of projection.cells) {
        const evidence =
          cell.evidenceIds.length > 0
            ? ` evidence: ${cell.evidenceIds.join(',')}`
            : ' evidence: UNKNOWN (no admissible evidence for this cell)';
        lines.push(`    - ${sanitizeForTerminal(cell.candidate, 60)} / ${sanitizeForTerminal(cell.criterion, 60)} = ${cell.value !== undefined ? sanitizeForTerminal(cell.value, 60) : 'UNKNOWN'}${evidence}`);
      }
      break;
    }
    case 'DECIDE': {
      lines.push(`  DECIDE selected: ${projection.selectedCandidate !== undefined ? sanitizeForTerminal(projection.selectedCandidate) : 'UNKNOWN (no observed recommendation)'}`);
      for (const rejected of projection.rejectedOptions) {
        const hasRationale = rejected.rationaleClaimIds !== undefined && rejected.rationaleClaimIds.length > 0;
        const hasEvidence = rejected.evidenceIds !== undefined && rejected.evidenceIds.length > 0;
        if (hasRationale || hasEvidence) {
          const rationales = (rejected.rationaleClaimIds ?? []).map((id) => claimText(id)).join(' | ');
          lines.push(`    - why not ${sanitizeForTerminal(rejected.candidate, 60)}: ${rationales.length > 0 ? rationales : 'no rationale claim'}${hasEvidence ? ` (evidence: ${(rejected.evidenceIds ?? []).join(',')})` : ' (no observed evidence)'}`);
        } else {
          lines.push(`    - why not ${sanitizeForTerminal(rejected.candidate, 60)}: missing evidence — no observed/reported rejection rationale`);
        }
      }
      break;
    }
    case 'ASSESS':
      lines.push(`  ASSESS feasibility claims: ${projection.feasibilityClaimIds.length}, risk claims: ${projection.riskClaimIds.length}, freshness: ${projection.freshness}`);
      for (const id of projection.feasibilityClaimIds) lines.push(`    - [feasibility] ${claimText(id)}`);
      for (const id of projection.riskClaimIds) lines.push(`    - [risk] ${claimText(id)}`);
      break;
    case 'VERIFY':
      lines.push(`  VERIFY ledger: ${projection.verifyEventIds.length} verify events, ${projection.conflictIds.length} conflicts`);
      break;
    case 'IDEATE':
      lines.push(`  IDEATE branches: ${projection.branches.length} (diversity ${projection.diversityStatus})`);
      for (const b of projection.branches) {
        const evidence = b.discardEvidenceIds !== undefined && b.discardEvidenceIds.length > 0 ? ` discard evidence: ${b.discardEvidenceIds.join(',')}` : '';
        lines.push(`    - branch ${sanitizeForTerminal(b.branchId)} [${b.status}]${evidence}`);
      }
      break;
    case 'UNKNOWN':
      lines.push(`  UNKNOWN overview claims: ${projection.overviewClaimIds.length}, unresolved reasons: ${projection.unresolvedReasonIds.length}`);
      break;
  }
  return lines;
}

export interface ReportViewInput {
  readonly report: AnalysisReportV1;
  readonly run: RunState | null;
  readonly status: CollectionStatusInput | null;
  readonly answerText: string | null;
  readonly association: string;
}

export function renderAnalysisReport(input: ReportViewInput): string[] {
  const { report } = input;
  const lines: string[] = [];
  lines.push(`Analysis Report [${report.schema}]`);
  lines.push(`  Run: ${sanitizeForTerminal(report.scope.runId)}  Answer: ${sanitizeForTerminal(report.scope.answerId)}  Receipt: ${sanitizeForTerminal(report.scope.receiptId)}`);
  lines.push(`  Scope boundary: ${report.scope.boundary}  Association: ${sanitizeForTerminal(input.association, 120)}`);
  if (input.answerText !== null) {
    lines.push(`  Stored answer: ${sanitizeForTerminal(input.answerText, Number.MAX_SAFE_INTEGER)}`);
  } else {
    lines.push('  Stored answer: UNKNOWN (no answer text recorded on the receipt)');
  }
  lines.push(`  Freshness: ${report.freshness.status}${report.freshness.reasons.length > 0 ? ` (${report.freshness.reasons.join(',')})` : ''}`);
  lines.push(`  Input revision: ${report.inputRevision.value} (${report.inputRevision.recordCount} events)`);
  lines.push(`  State revision: ${report.stateRevision}; analyzer ${report.analyzer.analyzerId} ${report.analyzer.analyzerVersion}; rules ${report.analyzer.ruleSetVersion}`);
  lines.push(`  Support: ${report.support.status} (${report.support.reasonCodes.join(', ')})`);
  lines.push(`  Collection completeness: ${report.support.collectionCompleteness} — support is capped by collection completeness, never by exit codes`);
  lines.push(`  Claims: ${report.claims.length} (${report.claims.filter((c) => c.importance === 'CORE').length} core, ${report.claims.filter((c) => c.support === 'CONFLICTING_EVIDENCE').length} conflicting, ${report.claims.filter((c) => c.support === 'UNKNOWN' || c.support === 'INSUFFICIENT_EVIDENCE').length} unknown/insufficient)`);
  for (const c of report.claims) {
    lines.push(`    - ${c.claimId} [${c.support}, ${c.provenance}] ${sanitizeForTerminal(c.text, 70)}`);
    lines.push(`      supporting: ${c.supportingEvidenceIds.join(', ') || 'UNKNOWN'}; opposing: ${c.opposingEvidenceIds.join(', ') || 'NONE'}; unresolved: ${c.unresolvedReasonIds.join(', ') || 'NONE'}`);
  }
  lines.push(`  Mode lens:`);
  lines.push(...lensLines(report.lens));
  const lanes = laneCounts(report);
  lines.push(`  Lanes: obs:${lanes.obs}  rep:${lanes.rep}  inf:${lanes.inf}  ?:${lanes.unknown} (evidence items + claims)`);
  lines.push(`  Evidence: ${report.evidence.length} items; relations: ${report.relations.length}; topology: ${report.topology.nodes.length} nodes / ${report.topology.edges.length} edges`);
  for (const evidence of report.evidence) {
    lines.push(`    ${evidence.evidenceId} -> event ${evidence.eventId}; source ${evidence.sourceId ?? 'UNKNOWN'}; ${evidence.effectiveProvenance}; ${evidence.admissibility}; ${evidence.grounding}`);
  }
  lines.push(`  Unresolved areas: conflicts ${report.conflicts.filter((c) => c.status !== 'RESOLVED').length} unresolved of ${report.conflicts.length}, references ${report.references.filter((r) => r.status !== 'RESOLVED').length} pending of ${report.references.length}`);
  lines.push(`  Projection (${report.projection.mode}):`);
  lines.push(...projectionLines(report.projection, report));
  lines.push('  Exploration tree:');
  for (const line of renderStaticTree(report)) lines.push(`  ${line}`);
  lines.push('  Activity concentration:');
  if (report.topology.activityConcentration.length === 0) {
    lines.push('    UNKNOWN — no observed events in scope');
  } else {
    for (const m of report.topology.activityConcentration) lines.push(concentrationLine('activity share', m));
  }
  lines.push('  Source concentration:');
  if (report.topology.sourceConcentration.length === 0) {
    lines.push('    UNKNOWN — no sources observed in scope');
  } else {
    for (const m of report.topology.sourceConcentration) lines.push(concentrationLine('source share', m));
  }
  if (report.topology.observedDuration !== undefined) {
    lines.push(`  Latency: observed span ${report.topology.observedDuration.milliseconds}ms (${report.topology.observedDuration.measurement}: ${report.topology.observedDuration.startEventId} -> ${report.topology.observedDuration.endEventId})`);
  } else {
    lines.push('  Latency: UNKNOWN — fewer than two observed timestamps in scope');
  }
  lines.push('  Source Ledger:');
  lines.push(...sourceLedgerLines(report.sources));
  lines.push('  Contradiction/Verification Rail:');
  lines.push(...railLines(report));
  lines.push('  JEV v2:');
  lines.push(...jevLines(report));
  if (input.status !== null) {
    lines.push(...collectionStatusLines(input.status));
  }
  return lines.map(sanitizeTerminalLine);
}
