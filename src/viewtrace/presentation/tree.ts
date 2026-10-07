/**
 * M4 Live Exploration Tree presentation (CLI).
 *
 * This module is a pure renderer over `AnalysisReportV1` (docs/MILESTONES.md
 * §9). It never derives branches, claims, support or provenance of its own:
 * every structure it prints comes from the analyzer's `topology`,
 * `conflicts`, `verifications` and mode projection. Absent analyzer facts
 * are printed as UNKNOWN, never guessed.
 *
 * Honesty rules baked into the rendering:
 *  - Lane tags `obs / rep / inf / ?` on every node and edge come from the
 *    report's own provenance; relation lines state solid/dashed from the
 *    actual relation provenance (never endpoint node provenance).
 *  - Collapsing a branch only hides the repetitive event-id list. Rail items
 *    (contradictions/verifications), dropped/stalled statuses and unknown
 *    frontiers are never suppressed by collapse.
 *  - The frontier line states the analyzer's frontierStatus and always says
 *    it is the end of the *observed* sequence, not agent intent.
 *  - All producer-controlled text (labels, queries) is sanitized for the
 *    terminal exactly like M1 display output — identical when piped.
 */

import type {
  AnalysisReportV1,
  TopologyEdge,
  TopologyNode,
} from '../analysis-types.js';
import { sanitizeForTerminal, sanitizeTerminalLine } from '../display.js';

/** A branch whose observed event list reaches this size collapses to counts. */
export const BRANCH_COLLAPSE_THRESHOLD = 3;
/** Event ids shown inline for an expanded branch (older ids stay hidden). */
export const MAX_INLINE_EVENT_IDS = 6;

export interface TreeScope {
  readonly runId: string;
  readonly answerId: string;
}

export interface TreeSessionOptions {
  readonly collapseThreshold?: number;
  readonly staticMode?: boolean;
}

function laneOfProvenance(provenance: string): string {
  switch (provenance) {
    case 'VIEWTRACE_OBSERVED':
      return 'obs';
    case 'AGENT_REPORTED':
      return 'rep';
    case 'VIEWTRACE_INFERRED':
      return 'inf';
    default:
      return '?';
  }
}

function edgeStyle(edge: TopologyEdge): { lane: string; style: string } {
  // The relation's own provenance decides the lane and line style; endpoint
  // node provenance is intentionally not consulted.
  switch (edge.kind) {
    case 'OBSERVED_SEQUENCE':
      return { lane: 'obs', style: 'solid' };
    case 'SHARED_SOURCE':
      return { lane: 'obs', style: 'solid' };
    case 'INFERRED_BRANCH':
      return { lane: 'inf', style: 'dashed' };
    default:
      return { lane: '?', style: 'dashed' };
  }
}

function formatEventIds(ids: readonly string[]): string {
  const shown = ids.slice(0, MAX_INLINE_EVENT_IDS);
  const suffix = ids.length > shown.length ? `, +${ids.length - shown.length} more` : '';
  return `[ids: ${shown.join(', ')}${suffix}]`;
}

/** IDEATE projection branch statuses keyed by the topology branch node id. */
function branchStatusesFromProjection(report: AnalysisReportV1): Map<string, string> {
  const out = new Map<string, string>();
  if (report.projection.mode !== 'IDEATE') return out;
  for (const branch of report.projection.branches) {
    const nodeId = report.topology.nodes.find(
      (n) => n.kind === 'BRANCH' && n.eventIds.some((id) => branch.eventIds.includes(id)),
    )?.nodeId;
    if (nodeId !== undefined) out.set(nodeId, branch.status);
  }
  return out;
}

interface RailItem {
  readonly key: string;
  readonly text: string;
  readonly anchorEventId?: string;
}

function conflictRailItems(report: AnalysisReportV1): RailItem[] {
  return report.conflicts.map((conflict) => {
    const anchor =
      conflict.history.find((h) => h.anchors.some((a) => a.eventId !== undefined))?.anchors.find((a) => a.eventId !== undefined)
        ?.eventId;
    const resolved = conflict.status === 'RESOLVED';
    const resolution = conflict.resolution
      ? ` resolved by verify ${conflict.resolution.verifyEventId} (${conflict.resolution.result})`
      : '';
    const deficit = resolved ? '' : ' ? unresolved';
    return {
      key: `conflict:${conflict.conflictId}:${conflict.status}`,
      text: `rail CONFLICT ${conflict.conflictId} [${conflict.status}] conditionMatch=${conflict.conditionMatch}${resolution}${deficit}`,
      anchorEventId: anchor,
    };
  });
}

function verificationRailItems(report: AnalysisReportV1): RailItem[] {
  return report.verifications.map((v) => {
    const target =
      v.target.kind === 'CLAIM' ? `claim ${v.target.claimId}` : `event ${v.target.eventId}`;
    return {
      key: `verify:${v.verifyEventId}:${v.result}:${v.targetResolution}`,
      text: `rail VERIFY ${v.verifyEventId} target=${target} resolution=${v.targetResolution} result=${v.result} correctness=${v.correctness}`,
      anchorEventId: v.verifyEventId,
    };
  });
}

/**
 * One answer-scoped live tree. Repeated `update` calls with successive
 * analyzer reports emit only what is new (growth, collapse transitions,
 * count updates, rail items, frontier moves). Re-delivering an already seen
 * report emits nothing (reconnect dedup is by item identity, not revision).
 */
export class ExplorationTreeSession {
  private readonly scope: TreeScope;
  private readonly collapseThreshold: number;
  private started = false;
  private readonly emittedNodes = new Set<string>();
  private readonly emittedEdges = new Set<string>();
  private readonly shownEventIds = new Map<string, Set<string>>();
  private readonly branchCounts = new Map<string, number>();
  private readonly collapsed = new Set<string>();
  private readonly emittedRail = new Set<string>();
  private readonly emittedBranchStatus = new Set<string>();
  private lastFrontierKey: string | null = null;
  private sequenceEdgeCount = -1;
  private readonly staticMode: boolean;
  private lastSupportKey: string | null = null;
  private lastLensKey: string | null = null;
  private lastConcentrationKey: string | null = null;
  private readonly emittedSources = new Map<string, string>();
  private readonly emittedJev = new Set<string>();
  private lastRevisionKey: string | null = null;

  constructor(scope: TreeScope, options: TreeSessionOptions = {}) {
    this.scope = scope;
    this.collapseThreshold = options.collapseThreshold ?? BRANCH_COLLAPSE_THRESHOLD;
    this.staticMode = options.staticMode ?? false;
  }

  update(report: AnalysisReportV1): string[] {
    if (report.scope.runId !== this.scope.runId || report.scope.answerId !== this.scope.answerId) {
      return [
        `tree: refusing report for ${report.scope.runId}/${report.scope.answerId} — this session is scoped to ${this.scope.runId}/${this.scope.answerId}; open a new session per answer`,
      ];
    }
    const lines: string[] = [];
    if (!this.staticMode) {
      const revisionKey = `${report.inputRevision.value}:${report.stateRevision}:${report.freshness.status}`;
      if (revisionKey !== this.lastRevisionKey) {
        this.lastRevisionKey = revisionKey;
        lines.push(`|  = revisions input=${report.inputRevision.value} (${report.inputRevision.recordCount} records) state=${report.stateRevision} freshness=${report.freshness.status}`);
        lines.push(`|  = counts: ${report.claims.length} claims, ${report.evidence.length} evidence, ${report.sources.length} sources, ${report.relations.length} relations; ${report.topology.nodes.length} topology nodes / ${report.topology.edges.length} edges`);
      }
    }
    if (!this.started) {
      this.started = true;
      lines.push(
        `exploration tree [run ${this.scope.runId} answer ${this.scope.answerId}] — inferred segmentation of observed events; not hidden reasoning`,
      );
      lines.push('lanes: obs=observed rep=reported inf=inferred ?=unknown/unresolved');
      if (!this.staticMode) {
        lines.push(...this.renderSupport(report, true));
        lines.push(...this.renderLens(report, true));
      }
    } else if (!this.staticMode) {
      lines.push(...this.renderSupport(report, false));
      lines.push(...this.renderLens(report, false));
    }

    const branchOfEvent = new Map<string, string>();
    for (const node of report.topology.nodes) {
      if (node.kind === 'BRANCH') for (const id of node.eventIds) branchOfEvent.set(id, node.nodeId);
    }

    const branches = report.topology.nodes.filter((n) => n.kind === 'BRANCH');
    for (const node of branches) {
      lines.push(...this.renderBranch(node));
    }
    for (const node of report.topology.nodes) {
      if (node.kind === 'BRANCH') continue;
      if (!this.emittedNodes.has(node.nodeId)) {
        this.emittedNodes.add(node.nodeId);
        const lane = laneOfProvenance(node.provenance);
        lines.push(
          `+-- [${lane}] ${node.kind.toLowerCase()} ${sanitizeForTerminal(node.nodeId)} "${sanitizeForTerminal(node.label)}"`,
        );
        if (node.kind === 'ACTIVITY' || node.kind === 'QUERY_CLUSTER') {
          this.branchCounts.set(node.nodeId, node.eventIds.length);
          this.shownEventIds.set(node.nodeId, new Set(node.eventIds));
        }
      } else {
        const previous = this.branchCounts.get(node.nodeId);
        if (previous !== undefined && node.eventIds.length > previous) {
          this.branchCounts.set(node.nodeId, node.eventIds.length);
          lines.push(`|  = ${node.kind.toLowerCase()} ${sanitizeForTerminal(node.nodeId)} now ${node.eventIds.length} events`);
        }
      }
    }

    lines.push(...this.renderEdges(report));
    lines.push(...this.renderRail(report, branchOfEvent));
    lines.push(...this.renderBranchStatuses(report, branchOfEvent));
    lines.push(...this.renderFrontier(report));
    if (!this.staticMode) {
      lines.push(...this.renderConcentration(report));
      lines.push(...this.renderSources(report));
      lines.push(...this.renderJev(report));
    }
    return lines.map(sanitizeTerminalLine);
  }

  private renderBranch(node: TopologyNode): string[] {
    const lines: string[] = [];
    const id = sanitizeForTerminal(node.nodeId);
    const label = sanitizeForTerminal(node.label);
    const count = node.eventIds.length;
    if (!this.emittedNodes.has(node.nodeId)) {
      this.emittedNodes.add(node.nodeId);
      this.branchCounts.set(node.nodeId, count);
      if (count >= this.collapseThreshold) {
        this.collapsed.add(node.nodeId);
        this.shownEventIds.set(node.nodeId, new Set());
        lines.push(
          `+-- [inf] branch ${id} "${label}" — ${count} events [collapsed: ids hidden, counts continue]`,
        );
      } else {
        this.shownEventIds.set(node.nodeId, new Set(node.eventIds));
        lines.push(`+-- [inf] branch ${id} "${label}" — ${count} events ${formatEventIds(node.eventIds)}`);
      }
      return lines;
    }
    const previous = this.branchCounts.get(node.nodeId) ?? count;
    if (count === previous) return lines;
    this.branchCounts.set(node.nodeId, count);
    if (count < previous) {
      lines.push(`|  = branch ${id} now ${count} events (down from ${previous}; scope re-derived, nothing invented)`);
      return lines;
    }
    const fresh = node.eventIds.filter((e) => !this.shownEventIds.get(node.nodeId)?.has(e));
    if (!this.collapsed.has(node.nodeId) && count >= this.collapseThreshold) {
      this.collapsed.add(node.nodeId);
      lines.push(
        `|  x branch ${id} collapsed at ${count} events — ids hidden; rail items and dropped/unknown statuses remain`,
      );
      return lines;
    }
    if (this.collapsed.has(node.nodeId)) {
      lines.push(`|  = branch ${id} now ${count} events (+${count - previous} since last; still collapsed)`);
    } else {
      const shown = this.shownEventIds.get(node.nodeId);
      if (shown !== undefined) for (const e of node.eventIds) shown.add(e);
      lines.push(`|  = branch ${id} +${count - previous} events ${formatEventIds(fresh)}`);
    }
    return lines;
  }

  private renderEdges(report: AnalysisReportV1): string[] {
    const lines: string[] = [];
    let sequenceEdges = 0;
    for (const edge of report.topology.edges) {
      if (edge.kind === 'OBSERVED_SEQUENCE') {
        sequenceEdges += 1;
        continue;
      }
      if (this.emittedEdges.has(edge.edgeId)) continue;
      this.emittedEdges.add(edge.edgeId);
      const { lane, style } = edgeStyle(edge);
      lines.push(
        `|  edge ${sanitizeForTerminal(edge.fromNodeId)} -> ${sanitizeForTerminal(edge.toNodeId)} [${edge.kind}] lane=${lane} ${style}`,
      );
    }
    if (sequenceEdges !== this.sequenceEdgeCount) {
      const delta = this.sequenceEdgeCount < 0 ? '' : ` (+${sequenceEdges - this.sequenceEdgeCount})`;
      this.sequenceEdgeCount = sequenceEdges;
      lines.push(`|  = ${sequenceEdges} observed sequence edges${delta} lane=obs solid`);
    }
    return lines;
  }

  private renderRail(report: AnalysisReportV1, branchOfEvent: Map<string, string>): string[] {
    const lines: string[] = [];
    for (const item of [...conflictRailItems(report), ...verificationRailItems(report)]) {
      if (this.emittedRail.has(item.key)) continue;
      this.emittedRail.add(item.key);
      const branch =
        item.anchorEventId !== undefined ? branchOfEvent.get(item.anchorEventId) : undefined;
      const anchor = branch !== undefined ? ` @branch ${sanitizeForTerminal(branch)}` : '';
      lines.push(`|  ! ${sanitizeForTerminal(item.text, 200)}${anchor}`);
    }
    return lines;
  }

  private renderBranchStatuses(
    report: AnalysisReportV1,
    branchOfEvent: Map<string, string>,
  ): string[] {
    // IDEATE branch statuses (ACTIVE/DROPPED/STALLED/UNKNOWN) — DROPPED and
    // STALLED are salient and must survive collapse of their branch.
    const lines: string[] = [];
    if (report.projection.mode !== 'IDEATE') return lines;
    for (const branch of report.projection.branches) {
      const key = `${branch.branchId}:${branch.status}`;
      if (this.emittedBranchStatus.has(key)) continue;
      this.emittedBranchStatus.add(key);
      const anchor = branchOfEvent.get(branch.eventIds[0] ?? '');
      const anchorText = anchor !== undefined ? ` @branch ${sanitizeForTerminal(anchor)}` : '';
      const evidence =
        branch.discardEvidenceIds !== undefined && branch.discardEvidenceIds.length > 0
          ? ` discard evidence: ${branch.discardEvidenceIds.join(', ')}`
          : branch.status === 'DROPPED'
            ? ' discard evidence: none observed'
            : '';
      const deficit = branch.status === 'UNKNOWN' ? ' ?' : '';
      lines.push(
        `|  ! branch status ${sanitizeForTerminal(branch.branchId)} [${branch.status}]${deficit}${anchorText}${evidence}`,
      );
    }
    return lines;
  }

  private renderFrontier(report: AnalysisReportV1): string[] {
    const frontierIds = report.topology.currentFrontierNodeIds ?? [];
    const key = `${report.topology.frontierStatus}:${frontierIds.join('|')}`;
    if (key === this.lastFrontierKey) return [];
    this.lastFrontierKey = key;
    if (report.topology.frontierStatus === 'UNKNOWN' || frontierIds.length === 0) {
      return ['frontier [UNKNOWN]: no observed events — nothing claimed about where exploration stands'];
    }
    const frontierBranch = frontierIds.find((id) => id.startsWith('node-branch-'));
    const lines = [
      `frontier [${report.topology.frontierStatus}]: ${frontierIds.map((id) => sanitizeForTerminal(id)).join(', ')} — end of observed sequence, not agent intent`,
    ];
    if (frontierBranch !== undefined && this.collapsed.has(frontierBranch)) {
      const node = report.topology.nodes.find((n) => n.nodeId === frontierBranch);
      const tail =
        node !== undefined && node.eventIds.length > 0
          ? ` last observed events ${formatEventIds(node.eventIds.slice(-MAX_INLINE_EVENT_IDS))}`
          : '';
      lines.push(
        `|  ! frontier entered collapsed branch ${sanitizeForTerminal(frontierBranch)} — expanded${tail}`,
      );
    }
    return lines;
  }

  private renderSupport(report: AnalysisReportV1, initial: boolean): string[] {
    const lines: string[] = [];
    const key = `${report.support.status}:${report.support.reasonCodes.join(',')}:${report.inputRevision.value}`;
    if (initial) {
      this.lastSupportKey = key;
      lines.push(
        `|  = support: ${report.support.status} (${report.support.reasonCodes.join(', ')}) [revision ${report.inputRevision.value.slice(0, 16)}… ${report.inputRevision.recordCount} records]`,
      );
    } else if (key !== this.lastSupportKey) {
      this.lastSupportKey = key;
      lines.push(
        `|  = support updated: ${report.support.status} (${report.support.reasonCodes.join(', ')}) [revision ${report.inputRevision.value.slice(0, 16)}… ${report.inputRevision.recordCount} records]`,
      );
    }
    return lines;
  }

  private renderLens(report: AnalysisReportV1, initial: boolean): string[] {
    const lines: string[] = [];
    const current = report.lens.revisions.find((r) => r.revisionId === report.lens.currentRevisionId);
    const key = `${report.lens.currentMode}:${current?.phase ?? ''}:${report.lens.temporal}`;
    if (initial) {
      this.lastLensKey = key;
      lines.push(
        `|  = mode lens: ${report.lens.currentMode}${current ? ` [${current.phase}]` : ''}`,
      );
    } else if (key !== this.lastLensKey) {
      this.lastLensKey = key;
      lines.push(
        `|  = mode lens updated: ${report.lens.currentMode}${current ? ` [${current.phase}]` : ''}`,
      );
    }
    return lines;
  }

  private renderConcentration(report: AnalysisReportV1): string[] {
    const lines: string[] = [];
    const act = report.topology.activityConcentration.map((c) => `${c.numerator}/${c.denominator}`).join(',');
    const src = report.topology.sourceConcentration.map((c) => `${c.numerator}/${c.denominator}`).join(',');
    const key = JSON.stringify([report.topology.activityConcentration, report.topology.sourceConcentration]);
    if (key !== this.lastConcentrationKey && (act.length > 0 || src.length > 0)) {
      this.lastConcentrationKey = key;
      for (const m of report.topology.activityConcentration) {
        lines.push(`|  = activity share: ${m.numerator}/${m.denominator} unit=${m.unit} ${m.meaning}; excluded=${m.excluded}; share is not importance`);
      }
      for (const m of report.topology.sourceConcentration) {
        lines.push(`|  = source share: ${m.numerator}/${m.denominator} unit=${m.unit} ${m.meaning}; excluded=${m.excluded}; share is not importance`);
      }
    }
    return lines;
  }

  private renderSources(report: AnalysisReportV1): string[] {
    const lines: string[] = [];
    for (const s of report.sources) {
      const sourceKey = JSON.stringify(s);
      if (this.emittedSources.get(s.canonicalSourceId) !== sourceKey) {
        this.emittedSources.set(s.canonicalSourceId, sourceKey);
        lines.push(
          `|  + source ${sanitizeForTerminal(s.canonicalSourceId)} [${s.kind}] identity=${s.identityStatus}`,
        );
        lines.push(`|    edition=${s.edition?.label ?? 'UNKNOWN'} published=${s.publicationDate?.value ?? 'UNKNOWN'} accessed=${s.accessedDate?.value ?? 'UNKNOWN'}; anchors=${s.anchors.map((a) => a.eventId ?? 'UNKNOWN').join(', ') || 'UNKNOWN'}`);
      }
    }
    return lines;
  }

  private renderJev(report: AnalysisReportV1): string[] {
    const lines: string[] = [];
    for (const j of report.jevResults) {
      const key = `${j.checkpointId}:${j.status}:${j.labels ? `${j.labels.evidenceGain}:${j.labels.progress}:${j.labels.rethinkNeeded}` : 'none'}`;
      if (!this.emittedJev.has(key)) {
        this.emittedJev.add(key);
        if (j.labels !== undefined && j.status === 'SUCCEEDED') {
          lines.push(
            `|  ! [inf] JEV ${sanitizeForTerminal(j.checkpointId)} [${j.status}] evidenceGain=${j.labels.evidenceGain} progress=${j.labels.progress} rethinkNeeded=${j.labels.rethinkNeeded} (advisory) ${j.provenance}; supportEffect=${j.supportEffect}`,
          );
        } else {
          lines.push(
            `|  ! [?] JEV ${sanitizeForTerminal(j.checkpointId)} [${j.status}] labels UNKNOWN (advisory)`,
          );
        }
      }
    }
    return lines;
  }
}

/**
 * Routes reports to per-answer sessions so monitor output for one answer can
 * never leak state into another (run/answer switch isolation).
 */
export class TreeTracker {
  private readonly sessions = new Map<string, ExplorationTreeSession>();
  private readonly collapseThreshold: number;
  private readonly staticMode: boolean;

  constructor(options: TreeSessionOptions = {}) {
    this.collapseThreshold = options.collapseThreshold ?? BRANCH_COLLAPSE_THRESHOLD;
    this.staticMode = options.staticMode ?? false;
  }

  update(report: AnalysisReportV1): string[] {
    const key = `${report.scope.runId}/${report.scope.answerId}`;
    let session = this.sessions.get(key);
    if (session === undefined) {
      session = new ExplorationTreeSession(
        { runId: report.scope.runId, answerId: report.scope.answerId },
        { collapseThreshold: this.collapseThreshold, staticMode: this.staticMode },
      );
      this.sessions.set(key, session);
    }
    return session.update(report);
  }
}

/** One-shot static tree for `viewtrace analyze` (fresh session, single update). */
export function renderStaticTree(report: AnalysisReportV1): string[] {
  return new ExplorationTreeSession(
    { runId: report.scope.runId, answerId: report.scope.answerId },
    { staticMode: true },
  ).update(report);
}
