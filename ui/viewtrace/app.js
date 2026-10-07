'use strict';
// All recorded strings use textContent. No HTML/markdown/raw URL execution.

/**
 * @typedef {import('../../src/viewtrace/analysis-types.js').AnalysisReportV1} AnalysisReportV1
 * @typedef {import('../../src/viewtrace/analysis-types.js').AnalysisMode} AnalysisMode
 * @typedef {import('../../src/viewtrace/analysis-types.js').EvidenceItem} EvidenceItem
 * @typedef {import('../../src/viewtrace/analysis-types.js').ClaimAnalysis} ClaimAnalysis
 * @typedef {import('../../src/viewtrace/analysis-types.js').AnalysisRelation} AnalysisRelation
 * @typedef {import('../../src/viewtrace/analysis-types.js').SourceLedgerEntry} SourceLedgerEntry
 * @typedef {import('../../src/viewtrace/analysis-types.js').ConflictAnalysis} ConflictAnalysis
 * @typedef {import('../../src/viewtrace/analysis-types.js').VerifyAssessment} VerifyAssessment
 * @typedef {import('../../src/viewtrace/analysis-types.js').TopologyNode} TopologyNode
 * @typedef {import('../../src/viewtrace/analysis-types.js').TopologyEdge} TopologyEdge
 * @typedef {import('../../src/viewtrace/analysis-types.js').ConcentrationMetric} ConcentrationMetric
 * @typedef {import('../../src/viewtrace/analysis-types.js').JevResultV2} JevResultV2
 * @typedef {import('../../src/viewtrace/analysis-types.js').ModeRevision} ModeRevision
 * @typedef {import('../../src/viewtrace/analysis-types.js').ModeProjection} ModeProjection
 * @typedef {import('../../src/viewtrace/analysis-types.js').ExplainProjection} ExplainProjection
 * @typedef {import('../../src/viewtrace/analysis-types.js').CompareProjection} CompareProjection
 * @typedef {import('../../src/viewtrace/analysis-types.js').DecideProjection} DecideProjection
 * @typedef {import('../../src/viewtrace/analysis-types.js').AssessProjection} AssessProjection
 * @typedef {import('../../src/viewtrace/analysis-types.js').VerifyProjection} VerifyProjection
 * @typedef {import('../../src/viewtrace/analysis-types.js').IdeateProjection} IdeateProjection
 * @typedef {import('../../src/viewtrace/analysis-types.js').UnknownProjection} UnknownProjection
 * @typedef {import('../../src/viewtrace/types.js').ViewTraceEvent} ViewTraceEvent
 * @typedef {import('../../src/viewtrace/types.js').ProvenanceCategory} ProvenanceCategory
 * @typedef {import('../../src/viewtrace/types.js').EvidenceSupport} EvidenceSupport
 */

/**
 * @typedef {Object} DiagnosticItem
 * @property {string} severity
 * @property {string} code
 * @property {string} message
 */

/**
 * @typedef {Object} AnswerReceiptDetail
 * @property {string} runId
 * @property {string} answerId
 * @property {string} receiptId
 * @property {string} agentId
 * @property {string | null} [agentSessionId]
 * @property {string | null} [turnId]
 * @property {string} timestamp
 * @property {string} answer
 * @property {string | null} [questionSummary]
 * @property {string} hashVersion
 * @property {string} answerHash
 */

/**
 * @typedef {Object} RunInfo
 * @property {string} runId
 * @property {string} lifecycle
 * @property {string} completeness
 * @property {number} eventCount
 * @property {readonly unknown[]} [lifecycleHistory]
 * @property {number} [lifecycleTransitionCount]
 * @property {string} [updatedAt]
 */

/**
 * @typedef {Object} AssociationInfo
 * @property {string} status
 * @property {string} currentAnswerMatch
 * @property {string} basis
 */

/**
 * @typedef {Object} ScopeInfo
 * @property {string} status
 * @property {number} eventCount
 * @property {number | null} ownDeclared
 * @property {number} sharedDeclared
 * @property {number} missingCount
 * @property {number} conflicts
 */

/**
 * @typedef {Object} AnswerDetailData
 * @property {AnswerReceiptDetail} [receipt]
 * @property {RunInfo} run
 * @property {boolean} kept
 * @property {AssociationInfo} [association]
 * @property {string} [receiptIntegrity]
 * @property {string} [associationCapability]
 * @property {ScopeInfo} [scope]
 * @property {string} [evidenceSupport]
 * @property {readonly DiagnosticItem[]} diagnostics
 * @property {number} diagnosticCount
 * @property {string} revision
 */

/**
 * @typedef {Object} PickerAnswerRow
 * @property {string} receiptId
 * @property {string} runId
 * @property {string} answerId
 * @property {string} agentId
 * @property {string | null} agentSessionId
 * @property {string | null} turnId
 * @property {string} timestamp
 * @property {string | null} questionSummary
 * @property {string} [lifecycle]
 * @property {string} [completeness]
 * @property {string} scope
 */

/**
 * @typedef {Object} PickerRunRow
 * @property {string} runId
 * @property {string} timestamp
 * @property {null} agentId
 * @property {null} questionSummary
 * @property {string} lifecycle
 * @property {string} completeness
 * @property {string} association
 */

/**
 * @typedef {Object} PickerData
 * @property {readonly PickerAnswerRow[]} answers
 * @property {readonly PickerRunRow[]} runs
 * @property {number | null} nextOffset
 */

/**
 * @typedef {Object} EventPageData
 * @property {readonly ViewTraceEvent[]} events
 * @property {number | null} nextCursor
 * @property {string} revision
 */

const app = /** @type {HTMLElement} */ (document.getElementById('app') || document.body);

/** @type {string | null} */
let currentDetailRevision = null;
/** @type {string | null} */
let currentAnalysisRevision = null;
let selectedPath = location.pathname;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer = undefined;
/** @type {AnalysisMode | null} */
let currentModeOverride = null;

/**
 * Cache for events keyed by run:answer:eventId:revision
 * @type {Map<string, ViewTraceEvent>}
 */
const eventCache = new Map();

/**
 * Preservation state across re-renders
 */
/** @type {Set<string>} */
const openDetailsState = new Set();
/** @type {number} */
let rawPageTarget = 50;
/** @type {string | null} */
let selectedGraphNodeId = null;
/** @type {string | null} */
let selectedGraphRelationId = null;

/** @type {string | null} */
let inspectingEventId = null;
/** @type {string | null} */
let inspectingRunId = null;
/** @type {string | null} */
let inspectingAnswerId = null;

/**
 * Saved invoking element information to restore focus even if detached
 * @type {{ focusKey?: string, id?: string, dataEventId?: string, dataClaimId?: string, dataEvidenceId?: string, dataNodeId?: string, dataRelationId?: string, className?: string } | null}
 */
let lastInvokingElementInfo = null;

/**
 * Limits for list pagination
 * @type {Record<string, number>}
 */
const sectionLimits = {
  claims: 20,
  evidence: 20,
  sources: 20,
  graphNodes: 20,
  graphRelations: 20,
  topologyNodes: 20,
  conflicts: 20,
  verifications: 20,
  compareCandidates: 10,
  compareCriteria: 10,
  explainStructure: 20,
  explainCausal: 20,
  decideRejected: 20,
  assessFeasibility: 20,
  assessRisk: 20,
  verifyEvents: 20,
  ideateBranches: 20,
  unknownOverview: 20,
  unknownUnresolvedReasons: 20,
};
/** @type {Record<string, readonly string[]>} */
let cardIdsBySection = {};
/** @type {Record<string, number>} */
const focusedListIndices = {};
/** @type {(() => Promise<void>) | null} */
let rerenderCurrentReport = null;

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string | number | boolean | null | undefined} [text]
 * @param {HTMLElement | null} [parent]
 * @returns {HTMLElementTagNameMap[K]}
 */
function el(tag, text, parent) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (parent) parent.append(node);
  return node;
}

/**
 * @param {string} text
 * @param {HTMLElement | null} parent
 * @param {(e: MouseEvent) => void | Promise<void>} fn
 * @returns {HTMLButtonElement}
 */
function button(text, parent, fn) {
  const b = el('button', text, parent);
  b.type = 'button';
  b.dataset.focusKey = `${parent?.closest('[id]')?.id || 'page'}:${parent?.className || ''}:${text}`;
  b.addEventListener('click', (e) => {
    Promise.resolve(fn(e)).catch(presentationError);
  });
  return b;
}

/**
 * @template T
 * @param {string} path
 * @param {string} [method='GET']
 * @param {unknown} [data]
 * @returns {Promise<T>}
 */
async function api(path, method = 'GET', data) {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: data ? { 'Content-Type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!r.ok) {
    /** @type {Error & { status?: number }} */
    const err = Object.assign(
      new Error(
        r.status === 404
          ? 'Saved answer/trace is missing or deleted. Choose a trace explicitly.'
          : `Local request failed (${r.status}).`,
      ),
      { status: r.status },
    );
    throw err;
  }
  return /** @type {Promise<T>} */ (r.json());
}

/**
 * @param {string} text
 * @param {string} path
 * @param {HTMLElement | null} parent
 * @returns {HTMLAnchorElement}
 */
function link(text, path, parent) {
  const a = el('a', text, parent);
  a.href = path;
  return a;
}

/**
 * @param {string} title
 * @param {HTMLElement} [parent=app]
 * @returns {HTMLElement}
 */
function section(title, parent = app) {
  const s = el('section', undefined, parent);
  el('h2', title, s);
  return s;
}

/**
 * Disclose provenance lane: obs / rep / inf / ?
 * @param {string | undefined} category
 * @returns {'obs' | 'rep' | 'inf' | '?'}
 */
function provenanceLane(category) {
  if (category === 'VIEWTRACE_OBSERVED' || category === 'OBSERVED') return 'obs';
  if (category === 'AGENT_REPORTED' || category === 'REPORTED' || category === 'EVALUATOR_REPORTED') return 'rep';
  if (category === 'VIEWTRACE_INFERRED' || category === 'INFERRED') return 'inf';
  return '?';
}

/**
 * Append lane badge to element
 * @param {string | undefined} category
 * @param {HTMLElement} parent
 */
function appendLaneBadge(category, parent) {
  const lane = provenanceLane(category);
  const badge = el('span', `[${lane}]`, parent);
  badge.className = `lane-badge lane-${lane === '?' ? 'unk' : lane}`;
}

/**
 * Safe link rendering: only http/https without credentials.
 * Dangerous protocols render as plain text.
 * @param {string} loc
 * @param {HTMLElement} parent
 */
function appendSafeLocation(loc, parent) {
  try {
    const u = new URL(loc);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password) {
      const a = el('a', 'Open recorded source (external)', parent);
      a.href = u.href;
      a.target = '_blank';
      a.dataset.focusKey = `${parent.closest('[id]')?.id || 'page'}:source-link:${u.href}`;
      a.rel = 'noopener noreferrer';
      return;
    }
  } catch {}
  el('span', loc, parent);
}

/**
 * Return CSS border class reflecting actual relation provenance
 * @param {ProvenanceCategory | string} provenance
 * @returns {'edge-solid' | 'edge-dashed' | 'edge-reported'}
 */
function relationEdgeClass(provenance) {
  if (provenance === 'VIEWTRACE_OBSERVED') return 'edge-solid';
  if (provenance === 'VIEWTRACE_INFERRED') return 'edge-dashed';
  return 'edge-reported';
}

/**
 * Return edge line style textual name: solid / dashed / dotted
 * @param {ProvenanceCategory | string} provenance
 * @returns {'solid' | 'dashed' | 'dotted'}
 */
function relationEdgeStyleName(provenance) {
  if (provenance === 'VIEWTRACE_OBSERVED') return 'solid';
  if (provenance === 'VIEWTRACE_INFERRED') return 'dashed';
  return 'solid';
}

/**
 * Scroll and highlight element by selector
 * @param {string} selector
 */
async function highlightAndFocus(selector) {
  // Links also carry these IDs; navigate to the actual card, not the link
  // that invoked navigation or a graph duplicate.
  const scope = selector.startsWith('[data-evidence-id') ? '#evidence-cards '
    : selector.startsWith('[data-source-id') ? '#source-ledger '
      : selector.startsWith('[data-claim-id') ? '#why-answer ' : '';
  let target = document.querySelector(scope + selector);
  if (!target && rerenderCurrentReport) {
    const key = scope.startsWith('#evidence-cards') ? 'evidence'
      : scope.startsWith('#source-ledger') ? 'sources' : 'claims';
    // A deep link exposes just its target in addition to the current page,
    // rather than rendering every preceding record in a large report.
    const index = (cardIdsBySection[key] ?? []).findIndex((id) =>
      selector.includes(`"${CSS.escape(id)}"`));
    if (index >= 0) {
      focusedListIndices[key] = index;
      try {
        await rerenderCurrentReport();
      } catch (err) {
        presentationError(err);
        return;
      }
      target = document.querySelector(scope + selector);
    }
  }
  if (target instanceof HTMLElement) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('highlight-target');
    // Force reflow
    void target.offsetWidth;
    target.classList.add('highlight-target');
    const focusable = target.querySelector('button, [tabindex="0"], a');
    if (focusable instanceof HTMLElement) {
      focusable.focus();
    } else {
      target.focus();
    }
  }
}

/**
 * Render a bounded list with an accessible More button and count indicators
 * @template T
 * @param {readonly T[]} items
 * @param {string} limitKey
 * @param {HTMLElement} container
 * @param {(item: T, parent: HTMLElement, index: number) => void} renderItem
 * @param {string} itemLabelPlural
 * @param {() => void | Promise<void>} onMore
 * @param {number} [step=20]
 */
function renderBoundedList(items, limitKey, container, renderItem, itemLabelPlural, onMore, step = 20) {
  const currentLimit = sectionLimits[limitKey] ?? step;
  const visible = items.slice(0, currentLimit);
  const focusIndex = focusedListIndices[limitKey];
  if (focusIndex !== undefined && focusIndex >= currentLimit && items[focusIndex] !== undefined) {
    visible.push(items[focusIndex]);
  }
  for (let i = 0; i < visible.length; i++) {
    const item = visible[i];
    if (item !== undefined) {
      renderItem(item, container, i);
    }
  }
  if (items.length > visible.length) {
    const moreBox = el('div', undefined, container);
    moreBox.className = 'paging-box';
    const remaining = items.length - visible.length;
    el('span', `Showing ${visible.length} of ${items.length} ${itemLabelPlural}. `, moreBox);
    const moreBtn = button(`Show more ${itemLabelPlural} (${Math.min(remaining, step)} more)`, moreBox, () => {
      sectionLimits[limitKey] = currentLimit + step;
      Promise.resolve(onMore()).catch(presentationError);
    });
    moreBtn.setAttribute('aria-label', `Show more ${itemLabelPlural}`);
  }
}

/**
 * Save focus state before redraw
 */
function saveFocusState() {
  const active = document.activeElement;
  const dialog = document.getElementById('event-inspector');
  if (dialog instanceof HTMLDialogElement && dialog.open && dialog.contains(active)) return;
  if (active instanceof HTMLElement) {
    lastInvokingElementInfo = {
      focusKey: active.dataset.focusKey,
      id: active.id || undefined,
      dataEventId: active.getAttribute('data-event-id') || undefined,
      dataClaimId: active.getAttribute('data-claim-id') || undefined,
      dataEvidenceId: active.getAttribute('data-evidence-id') || undefined,
      dataNodeId: active.getAttribute('data-node-id') || undefined,
      dataRelationId: active.getAttribute('data-relation-id') || undefined,
      className: active.className || undefined,
    };
  }
}

/**
 * Restore focus state after redraw
 */
function restoreFocusState() {
  if (!lastInvokingElementInfo) return;
  const dialog = document.getElementById('event-inspector');
  if (dialog instanceof HTMLDialogElement && dialog.open) return;
  const info = lastInvokingElementInfo;
  let target = null;
  if (info.focusKey) {
    target = document.querySelector(`[data-focus-key="${CSS.escape(info.focusKey)}"]`);
  }
  if (!target && info.id) {
    target = document.getElementById(info.id);
  }
  if (!target && info.dataEventId) {
    target = document.querySelector(`[data-event-id="${CSS.escape(info.dataEventId)}"]`);
  }
  if (!target && info.dataClaimId) {
    target = document.querySelector(`[data-claim-id="${CSS.escape(info.dataClaimId)}"]`);
  }
  if (!target && info.dataEvidenceId) {
    target = document.querySelector(`[data-evidence-id="${CSS.escape(info.dataEvidenceId)}"]`);
  }
  if (!target && info.dataNodeId) {
    target = document.querySelector(`[data-node-id="${CSS.escape(info.dataNodeId)}"]`);
  }
  if (!target && info.dataRelationId) {
    target = document.querySelector(`[data-relation-id="${CSS.escape(info.dataRelationId)}"]`);
  }
  if (target instanceof HTMLElement && typeof target.focus === 'function') {
    target.focus();
  }
}

/**
 * @param {unknown} e
 */
function error(e) {
  clearTimeout(timer);
  app.replaceChildren();
  const message = e instanceof Error ? e.message : String(e);
  el('h1', 'Trace unavailable', app);
  el('p', message, app);
  link('Open recent trace picker', '/', app);
}

/** Preserve the selected answer and retry its presentation after an outage.
 * @param {unknown} e
 */
function presentationError(e) {
  if (typeof e === 'object' && e !== null && 'status' in e && e.status === 404) {
    error(e);
    return;
  }
  const connection = document.getElementById('connection');
  if (!connection) { error(e); return; }
  connection.textContent = `STALE — ${e instanceof Error ? e.message : String(e)} Retrying the same saved answer.`;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (location.pathname === selectedPath) void refresh(`/api${selectedPath}`, true);
  }, 2000);
}

/**
 * @param {number} [offset=0]
 * @returns {Promise<void>}
 */
async function picker(offset = 0) {
  /** @type {PickerData} */
  const data = await api(`/api/picker?offset=${offset}`);
  if (offset === 0) {
    app.replaceChildren();
    el('h1', 'Choose a saved answer or trace', app);
    el('p', 'Current answer association is UNKNOWN. Nothing is selected automatically.', app);
    button('Cancel', app, () => {
      app.replaceChildren();
      el('p', 'Reveal cancelled. No answer was opened.', app);
    });
  }
  for (const row of data.answers) {
    const s = section(`Answer ${row.answerId}`);
    el('p', row.questionSummary ?? 'Question summary UNKNOWN', s);
    el(
      'p',
      `${row.timestamp} · ${row.agentId} · session ${row.agentSessionId ?? 'UNKNOWN'} · turn ${row.turnId ?? 'UNKNOWN'}`,
      s,
    );
    el('p', `${row.lifecycle ?? 'UNKNOWN'} · collection ${row.completeness ?? 'UNKNOWN'} · scope ${row.scope}`, s);
    button(`Select answer ${row.answerId}`, s, async () => {
      try {
        /** @type {{ path: string }} */
        const result = await api('/api/select', 'POST', {
          runId: row.runId,
          receiptId: row.receiptId,
        });
        location.assign(result.path);
      } catch (e) {
        error(e);
      }
    });
  }
  for (const row of data.runs) {
    const s = section(`Run ${row.runId}`);
    el(
      'p',
      `${row.timestamp} · ${row.lifecycle} · collection ${row.completeness} · answer association UNKNOWN`,
      s,
    );
    button(`Select run ${row.runId}`, s, async () => {
      try {
        /** @type {{ path: string }} */
        const result = await api('/api/select', 'POST', { runId: row.runId });
        location.assign(result.path);
      } catch (e) {
        error(e);
      }
    });
  }
  if (!data.answers.length && !data.runs.length) el('p', 'No saved traces.', app);
  if (data.nextOffset !== null) {
    const next = data.nextOffset;
    button('More candidates', app, async () => {
      try {
        await picker(next);
      } catch (e) {
        error(e);
      }
    });
  }
}

/**
 * Scoped lazy event inspector using root GET .../events?eventId=ID
 * Avoids scanning every raw page; supports events beyond 250 records.
 * @param {string} eventId
 * @param {string} runId
 * @param {string | undefined | null} answerId
 * @returns {Promise<void>}
 */
async function openEventInspector(eventId, runId, answerId) {
  saveFocusState();
  inspectingEventId = eventId;
  inspectingRunId = runId;
  inspectingAnswerId = answerId ?? null;

  let dialog = /** @type {HTMLDialogElement | null} */ (document.getElementById('event-inspector'));
  if (!dialog) {
    dialog = /** @type {HTMLDialogElement} */ (document.createElement('dialog'));
    dialog.id = 'event-inspector';
    dialog.setAttribute('aria-label', 'Evidence inspector');
    document.body.append(dialog);
  }

  dialog.replaceChildren();
  const header = el('div', undefined, dialog);
  header.className = 'inspector-header';
  el('h2', `Evidence inspector: ${eventId}`, header);
  const closeBtn = button('Close inspector', header, () => {
    closeInspector();
  });
  closeBtn.setAttribute('aria-label', 'Close inspector');

  const content = el('div', undefined, dialog);
  content.className = 'inspector-content';
  el('p', 'Loading scoped event details…', content);

  if (typeof dialog.showModal === 'function' && !dialog.open) {
    dialog.showModal();
  } else if (!dialog.open) {
    dialog.setAttribute('open', '');
  }
  closeBtn.focus();

  dialog.oncancel = (e) => {
    e.preventDefault();
    closeInspector();
  };
  dialog.onclose = () => {
    closeInspector();
  };

  const snapshotRevision = currentDetailRevision;
  const stillSelected = () => inspectingEventId === eventId && inspectingRunId === runId &&
    inspectingAnswerId === (answerId ?? null);
  const cacheKey = `${runId}:${answerId ?? ''}:${eventId}:${snapshotRevision ?? ''}`;
  let event = eventCache.get(cacheKey);

  if (!event) {
    try {
      const selParam = new URLSearchParams(location.search).get('selection');
      const selQuery = selParam ? `&selection=${encodeURIComponent(selParam)}` : '';
      const query = answerId
        ? `/api/runs/${encodeURIComponent(runId)}/answers/${encodeURIComponent(answerId)}/events?eventId=${encodeURIComponent(eventId)}${selQuery}`
        : `/api/runs/${encodeURIComponent(runId)}/events?eventId=${encodeURIComponent(eventId)}${selQuery}`;

      /** @type {EventPageData} */
      const page = await api(query);
      if (!stillSelected()) return;
      if (page.revision !== snapshotRevision) {
        throw new Error('The stored snapshot changed. Wait for the report to refresh, then reopen this event.');
      }
      if (page.events && page.events.length > 0 && page.events[0]) {
        event = page.events[0];
        eventCache.set(cacheKey, event);
      }
    } catch (err) {
      if (!stillSelected()) return;
      content.replaceChildren();
      const status = typeof err === 'object' && err !== null && 'status' in err ? err.status : undefined;
      if (status === 404) {
        el(
          'p',
          `Event ${eventId} not found in scope for this answer/run (404 Not Found: missing or out of scoped revision).`,
          content,
        );
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        el('p', `Failed to load event ${eventId}: ${msg}`, content);
      }
      return;
    }
  }

  if (!stillSelected()) return;
  content.replaceChildren();
  if (!event) {
    el('p', `Event ${eventId} not found in scoped records.`, content);
    return;
  }

  const lane = provenanceLane(event.provenance.category);
  el('p', `Snapshot revision: ${snapshotRevision ?? 'UNKNOWN'}`, content).id = 'inspector-revision';
  el('p', `Type: ${event.type} · Sequence: ${event.sequence}`, content);
  el('p', `Occurred at: ${event.occurredAt ?? 'UNKNOWN'} · Received at: ${event.receivedAt ?? 'UNKNOWN'}`, content);
  const provP = el('p', `Provenance: ${event.provenance.category} `, content);
  appendLaneBadge(event.provenance.category, provP);
  el('span', ` [${lane}] (claimed by producer; not verified)`, provP);

  if (event.origin) {
    el(
      'p',
      `Origin: producer ${event.origin.producer}${event.origin.agent ? ' · Agent ' + event.origin.agent : ''}${event.origin.tool ? ' · Tool ' + event.origin.tool : ''}`,
      content,
    );
  }

  if (event.source) {
    const sBox = el('div', undefined, content);
    sBox.className = 'inspector-source';
    el('h3', `Source: ${event.source.sourceId} (${event.source.kind})`, sBox);
    if (event.source.location) {
      appendSafeLocation(event.source.location, sBox);
    }
  }

  if (event.relations && event.relations.length > 0) {
    const rBox = el('div', undefined, content);
    rBox.className = 'inspector-relations';
    el('h3', 'Event relations', rBox);
    const rList = el('ul', undefined, rBox);
    for (const rel of event.relations) {
      const rItem = el('li', undefined, rList);
      el('span', `${rel.type} -> ${rel.targetEventId}${rel.targetRunId ? ' (run ' + rel.targetRunId + ')' : ''} `, rItem);
      const relBtn = button(`Inspect target ${rel.targetEventId}`, rItem, () => {
        void openEventInspector(rel.targetEventId, rel.targetRunId ?? runId, answerId);
      });
      relBtn.setAttribute('data-event-id', rel.targetEventId);
    }
  }

  el('h3', 'Payload / Raw record', content);
  const pre = el('pre', JSON.stringify(event, null, 2), content);
  pre.className = 'event-payload';
}

function closeInspector() {
  inspectingEventId = null;
  inspectingRunId = null;
  inspectingAnswerId = null;
  const dialog = /** @type {HTMLDialogElement | null} */ (document.getElementById('event-inspector'));
  if (dialog) {
    if (typeof dialog.close === 'function' && dialog.open) {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
  }
  restoreFocusState();
}

/**
 * Render projection for current authoritative mode with bounded controls
 * @param {ModeProjection} projection
 * @param {AnalysisReportV1} analysis
 * @param {HTMLElement} parent
 * @param {string} runId
 * @param {string | undefined} answerId
 * @param {() => Promise<void>} onRerender
 */
function renderModeProjection(projection, analysis, parent, runId, answerId, onRerender) {
  const box = el('div', undefined, parent);
  box.className = 'mode-projection-container';
  el('h3', `Mode projection: ${projection.mode}`, box);

  switch (projection.mode) {
    case 'EXPLAIN': {
      el('h4', 'Structural explanation claims', box);
      const strList = el('ul', undefined, box);
      renderBoundedList(
        projection.structureClaimIds,
        'explainStructure',
        strList,
        (id, container) => {
          const item = el('li', undefined, container);
          const claim = analysis.claims.find((c) => c.claimId === id);
          el('strong', `${id}: `, item);
          el('span', claim ? claim.text : id, item);
          const jumpBtn = button('View claim', item, () => {
            highlightAndFocus(`[data-claim-id="${CSS.escape(id)}"]`);
          });
          jumpBtn.setAttribute('data-claim-id', id);
          jumpBtn.className = 'chain-link';
        },
        'structural claims',
        onRerender,
      );
      if (!projection.structureClaimIds.length) el('p', 'No structural claims observed.', box);

      el('h4', 'Causal claims', box);
      const causalList = el('ul', undefined, box);
      renderBoundedList(
        projection.causalClaimIds,
        'explainCausal',
        causalList,
        (id, container) => {
          const item = el('li', undefined, container);
          const claim = analysis.claims.find((c) => c.claimId === id);
          el('strong', `${id}: `, item);
          el('span', claim ? claim.text : id, item);
          const jumpBtn = button('View claim', item, () => {
            highlightAndFocus(`[data-claim-id="${CSS.escape(id)}"]`);
          });
          jumpBtn.setAttribute('data-claim-id', id);
          jumpBtn.className = 'chain-link';
        },
        'causal claims',
        onRerender,
      );
      if (!projection.causalClaimIds.length) el('p', 'No causal claims observed.', box);
      break;
    }
    case 'COMPARE': {
      const candLimit = sectionLimits.compareCandidates ?? 10;
      const critLimit = sectionLimits.compareCriteria ?? 10;
      const visibleCandidates = projection.candidates.slice(0, candLimit);
      const visibleCriteria = projection.criteria.slice(0, critLimit);

      const tableWrap = el('div', undefined, box);
      tableWrap.className = 'table-wrap';
      const tbl = el('table', undefined, tableWrap);
      tbl.className = 'matrix-table';
      const thead = el('thead', undefined, tbl);
      const hRow = el('tr', undefined, thead);
      el('th', 'Criterion / Candidate', hRow);
      for (const cand of visibleCandidates) {
        el('th', cand, hRow);
      }

      const tbody = el('tbody', undefined, tbl);
      for (const crit of visibleCriteria) {
        const row = el('tr', undefined, tbody);
        el('th', crit, row);
        for (const cand of visibleCandidates) {
          const td = el('td', undefined, row);
          const cell = projection.cells.find((c) => c.candidate === cand && c.criterion === crit);
          if (cell) {
            el('strong', cell.value ?? 'UNKNOWN', td);
            if (cell.evidenceIds.length > 0) {
              const evBox = el('div', undefined, td);
              el('span', 'Evidence: ', evBox);
              for (const evId of cell.evidenceIds) {
                const evBtn = button(evId, evBox, () => {
                  highlightAndFocus(`[data-evidence-id="${CSS.escape(evId)}"]`);
                });
                evBtn.setAttribute('data-evidence-id', evId);
                evBtn.className = 'chain-link';
              }
            } else {
              el('div', '비교 근거 부족 (No evidence)', td);
            }
          } else {
            el('span', '비교 근거 부족', td);
          }
        }
      }

      if (projection.candidates.length > visibleCandidates.length || projection.criteria.length > visibleCriteria.length) {
        const pBox = el('div', undefined, box);
        pBox.className = 'paging-box';
        el(
          'span',
          `Matrix showing ${visibleCandidates.length}/${projection.candidates.length} candidates, ${visibleCriteria.length}/${projection.criteria.length} criteria. `,
          pBox,
        );
        if (projection.candidates.length > visibleCandidates.length) {
          button('More candidates', pBox, () => {
            sectionLimits.compareCandidates = candLimit + 10;
            void onRerender();
          });
        }
        if (projection.criteria.length > visibleCriteria.length) {
          button('More criteria', pBox, () => {
            sectionLimits.compareCriteria = critLimit + 10;
            void onRerender();
          });
        }
      }
      if (!projection.candidates.length) el('p', 'No candidates compared.', box);
      break;
    }
    case 'DECIDE': {
      el('p', `Selected candidate: ${projection.selectedCandidate ?? 'None'}`, box);
      el('h4', 'Why not B/C (Rejected options)', box);
      const rejList = el('ul', undefined, box);
      renderBoundedList(
        projection.rejectedOptions,
        'decideRejected',
        rejList,
        (opt, container) => {
          const item = el('li', undefined, container);
          el('strong', `${opt.candidate}: `, item);
          if (opt.rationaleClaimIds && opt.rationaleClaimIds.length > 0) {
            el('span', `Rationale claims: `, item);
            for (const cId of opt.rationaleClaimIds) {
              const cBtn = button(cId, item, () => {
                highlightAndFocus(`[data-claim-id="${CSS.escape(cId)}"]`);
              });
              cBtn.setAttribute('data-claim-id', cId);
              cBtn.className = 'chain-link';
            }
          } else if (opt.evidenceIds && opt.evidenceIds.length > 0) {
            el('span', `Evidence: `, item);
            for (const eId of opt.evidenceIds) {
              const eBtn = button(eId, item, () => {
                highlightAndFocus(`[data-evidence-id="${CSS.escape(eId)}"]`);
              });
              eBtn.setAttribute('data-evidence-id', eId);
              eBtn.className = 'chain-link';
            }
          } else {
            el('span', '비교 근거 부족 (근거 부재 / No observed rejection rationale)', item);
          }
        },
        'rejected options',
        onRerender,
      );
      if (!projection.rejectedOptions.length) el('p', 'No rejected alternatives recorded.', box);
      break;
    }
    case 'ASSESS': {
      el('p', `Freshness assessment: ${projection.freshness}`, box);
      el('h4', 'Feasibility claims', box);
      const fList = el('ul', undefined, box);
      renderBoundedList(
        projection.feasibilityClaimIds,
        'assessFeasibility',
        fList,
        (id, container) => {
          const item = el('li', id, container);
          const btn = button('View', item, () => {
            highlightAndFocus(`[data-claim-id="${CSS.escape(id)}"]`);
          });
          btn.setAttribute('data-claim-id', id);
          btn.className = 'chain-link';
        },
        'feasibility claims',
        onRerender,
      );
      if (!projection.feasibilityClaimIds.length) el('p', 'No feasibility claims.', box);

      el('h4', 'Risk claims', box);
      const rList = el('ul', undefined, box);
      renderBoundedList(
        projection.riskClaimIds,
        'assessRisk',
        rList,
        (id, container) => {
          const item = el('li', id, container);
          const btn = button('View', item, () => {
            highlightAndFocus(`[data-claim-id="${CSS.escape(id)}"]`);
          });
          btn.setAttribute('data-claim-id', id);
          btn.className = 'chain-link';
        },
        'risk claims',
        onRerender,
      );
      if (!projection.riskClaimIds.length) el('p', 'No risk claims.', box);
      break;
    }
    case 'VERIFY': {
      el('h4', 'Verification ledger', box);
      const vList = el('ul', undefined, box);
      renderBoundedList(
        projection.verifyEventIds,
        'verifyEvents',
        vList,
        (vId, container) => {
          const item = el('li', undefined, container);
          el('span', `Verify event ${vId} `, item);
          const btn = button('Inspect verify event', item, () => {
            void openEventInspector(vId, runId, answerId);
          });
          btn.setAttribute('data-event-id', vId);
        },
        'verification events',
        onRerender,
      );
      if (!projection.verifyEventIds.length) el('p', 'No verification events.', box);
      break;
    }
    case 'IDEATE': {
      el('p', `Diversity status: ${projection.diversityStatus} `, box);
      appendLaneBadge(projection.diversityStatus, box);
      el('h4', 'Explored branch alternatives', box);
      const bContainer = el('div', undefined, box);
      renderBoundedList(
        projection.branches,
        'ideateBranches',
        bContainer,
        (br, container) => {
          const bCard = el('div', undefined, container);
          bCard.className = 'branch-card';
          el('h5', `Branch ${br.branchId} · Status: ${br.status}`, bCard);
          el('p', `Events: ${br.eventIds.join(', ')}`, bCard);
          if (br.discardEvidenceIds && br.discardEvidenceIds.length > 0) {
            el('p', `Discard evidence: ${br.discardEvidenceIds.join(', ')}`, bCard);
          }
        },
        'branches',
        onRerender,
      );
      if (!projection.branches.length) el('p', 'No branch alternatives recorded.', box);
      break;
    }
    case 'UNKNOWN':
    default: {
      el('h4', 'Overview claims', box);
      const oList = el('ul', undefined, box);
      renderBoundedList(
        projection.overviewClaimIds,
        'unknownOverview',
        oList,
        (id, container) => {
          const item = el('li', id, container);
          const btn = button('View', item, () => {
            highlightAndFocus(`[data-claim-id="${CSS.escape(id)}"]`);
          });
          btn.setAttribute('data-claim-id', id);
          btn.className = 'chain-link';
        },
        'overview claims',
        onRerender,
      );
      if (!projection.overviewClaimIds.length) el('p', 'No overview claims recorded.', box);
      break;
    }
  }
}

/**
 * Main render function adhering to:
 * Order: Answer -> Evidence -> Process -> Raw
 * @param {AnswerDetailData} data
 * @param {string} path
 * @param {AnalysisReportV1 | null} [analysis=null]
 * @returns {Promise<void>}
 */
async function renderReport(data, path, analysis = null) {
  saveFocusState();
  rerenderCurrentReport = () => renderReport(data, path, analysis);
  cardIdsBySection = {
    claims: analysis?.claims.map((item) => item.claimId) ?? [],
    evidence: analysis?.evidence.map((item) => item.evidenceId) ?? [],
    sources: analysis?.sources.map((item) => item.canonicalSourceId) ?? [],
  };
  app.replaceChildren();

  const runId = data.run.runId;
  const answerId = data.receipt?.answerId;
  const supportStatus = analysis?.support?.status ?? data.evidenceSupport ?? 'UNKNOWN';

  // Heading and Top Metadata
  el('h1', data.receipt ? `Answer ${data.receipt.answerId}` : `Run ${data.run.runId}`, app);
  el(
    'p',
    `Lifecycle ${data.run.lifecycle} · Collection ${data.run.completeness} · Evidence support ${supportStatus}`,
    app,
  ).id = 'status';
  el('p', `Revision ${data.revision}`, app).id = 'revision';
  if (analysis) {
    el('p', `Analysis input ${analysis.inputRevision.value} · ${analysis.inputRevision.recordCount} records · state ${analysis.stateRevision}`, app).id = 'analysis-revision';
    el('p', `Analyzer ${analysis.analyzer.analyzerId} ${analysis.analyzer.analyzerVersion} · rules ${analysis.analyzer.ruleSetVersion} · ${analysis.claims.length} claims · ${analysis.evidence.length} evidence · ${analysis.sources.length} sources · ${analysis.relations.length} relations`, app).id = 'analysis-counts';
  }
  el('p', 'Stored snapshot; checking for updates every 2 seconds.', app).id = 'connection';

  if (!data.receipt) {
    el('p', 'Run exploration container. Answer association UNKNOWN.', app);
  }

  /* ------------------------------------------------------------- */
  /* 1. ANSWER SECTION                                             */
  /* ------------------------------------------------------------- */
  if (data.receipt) {
    const answerSec = section('Answer', app);

    // #answer-summary hook
    const summaryBox = el('div', undefined, answerSec);
    summaryBox.id = 'answer-summary';
    el('h3', 'Answer summary', summaryBox);
    el('pre', data.receipt.answer, summaryBox);
    el(
      'p',
      `Receipt ${data.receipt.receiptId} · ${data.receipt.agentId} · session ${data.receipt.agentSessionId ?? 'UNKNOWN'} · turn ${data.receipt.turnId ?? 'UNKNOWN'}`,
      summaryBox,
    );
    el(
      'p',
      `Receipt integrity ${data.receiptIntegrity ?? 'STORED'}. Association ${data.association?.status ?? 'UNKNOWN'} (${data.association?.basis ?? 'UNKNOWN'}); current answer match ${data.association?.currentAnswerMatch ?? 'UNKNOWN'}.`,
      summaryBox,
    );
    el('p', `Hash policy ${data.receipt.hashVersion}; finalized ${data.receipt.timestamp}`, summaryBox);

    // Support, conflicts, unresolved, freshness visible with honest UNKNOWN when absent
    const statusBox = el('div', undefined, summaryBox);
    statusBox.className = 'answer-status-ledger';
    let confCountText = 'UNKNOWN';
    let unresCountText = 'UNKNOWN';
    let freshnessStatus = 'UNKNOWN';

    if (analysis) {
      confCountText = String(analysis.conflicts.length);
      const claimUnresolvedIds = new Set();
      for (const c of analysis.claims) {
        for (const r of c.unresolvedReasonIds) {
          claimUnresolvedIds.add(r);
        }
      }
      const pendingRefCount = analysis.references.filter((r) => r.status !== 'RESOLVED').length;
      const totalUnres =
        analysis.support.unresolvedConflictIds.length +
        analysis.support.missingRequiredConditionIds.length +
        claimUnresolvedIds.size +
        pendingRefCount;
      unresCountText = String(totalUnres);
      freshnessStatus = analysis.freshness.status;
    }

    el(
      'p',
      `Evidence support: ${supportStatus} · Conflicts: ${confCountText} · Unresolved areas: ${unresCountText} · Report freshness: ${freshnessStatus}`,
      statusBox,
    );

    if (data.scope) {
      el(
        'p',
        `Scope: ${data.scope.status} · ${data.scope.eventCount} available · ${data.scope.ownDeclared ?? 'UNKNOWN'} own · ${data.scope.sharedDeclared} shared · ${data.scope.missingCount} missing · ${data.scope.conflicts} conflicting assignments`,
        summaryBox,
      );
    }

    // Mode lens control (#mode-lens)
    const modeControl = el('div', undefined, answerSec);
    modeControl.className = 'mode-control';
    const modeLabel = el('label', 'Mode lens: ', modeControl);
    modeLabel.setAttribute('for', 'mode-lens');
    const modeSelect = el('select', undefined, modeControl);
    modeSelect.id = 'mode-lens';
    modeSelect.setAttribute('aria-label', 'Mode lens');

    const modes = /** @type {const} */ ([
      'EXPLAIN',
      'COMPARE',
      'DECIDE',
      'ASSESS',
      'VERIFY',
      'IDEATE',
      'UNKNOWN',
    ]);
    const activeMode = currentModeOverride ?? analysis?.lens.currentMode ?? 'UNKNOWN';
    for (const m of modes) {
      const opt = el('option', m, modeSelect);
      opt.value = m;
      if (m === activeMode) opt.selected = true;
    }

    modeSelect.addEventListener('change', async () => {
      const chosen = /** @type {AnalysisMode} */ (modeSelect.value);
      currentModeOverride = chosen;
      if (answerId) {
        await refresh(path, true);
      }
    });

    // #mode-history hook
    const historyBox = el('div', undefined, answerSec);
    historyBox.id = 'mode-history';
    el('h3', 'Mode revision history', historyBox);
    if (analysis && analysis.lens && analysis.lens.revisions.length > 0) {
      const histList = el('ul', undefined, historyBox);
      renderBoundedList(analysis.lens.revisions, 'lensHistory', histList, (rev, container) => {
        const item = el('li', undefined, container);
        el('strong', `${rev.phase}: `, item);
        el('span', `mode ${rev.mode} · source ${rev.source}`, item);
      }, 'mode revisions', () => renderReport(data, path, analysis));
    } else {
      el('p', 'Initial hypothesis: UNKNOWN (observed correction pending analysis)', historyBox);
    }

    // Render current authoritative mode projection with bounded controls
    if (analysis && analysis.projection) {
      renderModeProjection(analysis.projection, analysis, answerSec, runId, answerId, () =>
        renderReport(data, path, analysis),
      );
    }
  }

  /* ------------------------------------------------------------- */
  /* 2. EVIDENCE SECTION                                           */
  /* ------------------------------------------------------------- */
  if (data.receipt) {
    const evSec = section('Evidence', app);

    // #why-answer hook with linked claim -> evidence -> source chain navigation
    const whyBox = el('div', undefined, evSec);
    whyBox.id = 'why-answer';
    el('h3', 'Why this answer', whyBox);
    if (analysis && analysis.claims.length > 0) {
      renderBoundedList(
        analysis.claims,
        'claims',
        whyBox,
        (claim, parent) => {
          const cCard = el('div', undefined, parent);
          cCard.className = 'claim-card';
          cCard.id = `claim-${claim.claimId}`;
          cCard.setAttribute('data-claim-id', claim.claimId);
          el('h4', `Claim ${claim.claimId} (${claim.importance})`, cCard);
          appendLaneBadge(claim.provenance, cCard);
          el('p', claim.text, cCard);
          el('p', `Support: ${claim.support}`, cCard);

          // Give keyboard users a direct allowed-record action before the
          // optional links that move focus to other cards.
          for (const anchor of claim.anchors) {
            if (anchor.eventId) {
              const evId = anchor.eventId;
              const action = button(`Inspect anchor event ${evId}`, cCard, () => {
                void openEventInspector(evId, runId, answerId);
              });
              action.setAttribute('data-event-id', evId);
            }
          }

          if (claim.supportingEvidenceIds.length > 0) {
            const spBox = el('div', undefined, cCard);
            el('strong', 'Supporting evidence: ', spBox);
            renderBoundedList(claim.supportingEvidenceIds, `support:${claim.claimId}`, spBox, (evId, container) => {
              const evBtn = button(evId, container, () => {
                highlightAndFocus(`[data-evidence-id="${CSS.escape(evId)}"]`);
              });
              evBtn.setAttribute('data-evidence-id', evId);
              evBtn.className = 'chain-link';
            }, 'supporting links', () => renderReport(data, path, analysis));
          }

          if (claim.opposingEvidenceIds.length > 0) {
            const opBox = el('div', undefined, cCard);
            el('strong', 'Opposing evidence: ', opBox);
            renderBoundedList(claim.opposingEvidenceIds, `opposing:${claim.claimId}`, opBox, (evId, container) => {
              const evBtn = button(evId, container, () => {
                highlightAndFocus(`[data-evidence-id="${CSS.escape(evId)}"]`);
              });
              evBtn.setAttribute('data-evidence-id', evId);
              evBtn.className = 'chain-link';
            }, 'opposing links', () => renderReport(data, path, analysis));
          }

          if (claim.unresolvedReasonIds.length > 0) {
            el('p', `Unresolved reasons: ${claim.unresolvedReasonIds.join(', ')}`, cCard);
          }

          for (const anchor of claim.anchors) {
            if (anchor.sourceId) {
              const srcId = anchor.sourceId;
              const srcBtn = button(`Source: ${srcId}`, cCard, () => {
                highlightAndFocus(`[data-source-id="${CSS.escape(srcId)}"]`);
              });
              srcBtn.setAttribute('data-source-id', srcId);
              srcBtn.className = 'chain-link';
            }
          }
        },
        'claims',
        () => renderReport(data, path, analysis),
      );
    } else {
      el('p', 'No grounded claims extracted yet (UNKNOWN).', whyBox);
    }

    // #evidence-cards hook with linked source jump & event inspector
    const cardsBox = el('div', undefined, evSec);
    cardsBox.id = 'evidence-cards';
    el('h3', 'Evidence cards', cardsBox);
    if (analysis && analysis.evidence.length > 0) {
      renderBoundedList(
        analysis.evidence,
        'evidence',
        cardsBox,
        (item, parent) => {
          const card = el('div', undefined, parent);
          card.className = 'evidence-card';
          card.id = `evidence-${item.evidenceId}`;
          card.setAttribute('data-evidence-id', item.evidenceId);
          card.setAttribute('data-event-id', item.eventId);
          if (item.sourceId) card.setAttribute('data-source-id', item.sourceId);

          el('h4', `Evidence ${item.evidenceId}`, card);
          const pLane = el('p', 'Lane: ', card);
          appendLaneBadge(item.effectiveProvenance, pLane);
          el(
            'span',
            ` · Claimed: ${item.claimedProvenance} · Integrity: ${item.provenanceIntegrity} · Admissibility: ${item.admissibility}`,
            pLane,
          );
          el('p', `Grounding: ${item.grounding}`, card);
          if (item.limitations.length > 0) {
            el('p', `Limitations: ${item.limitations.join('; ')}`, card);
          }

          if (item.sourceId) {
            const sId = item.sourceId;
            const srcBtn = button(`Jump to Source ${sId}`, card, () => {
              highlightAndFocus(`[data-source-id="${CSS.escape(sId)}"]`);
            });
            srcBtn.setAttribute('data-source-id', sId);
            srcBtn.className = 'chain-link';
          }

          const inspBtn = button(`Inspect event ${item.eventId}`, card, () => {
            void openEventInspector(item.eventId, runId, answerId);
          });
          inspBtn.setAttribute('data-event-id', item.eventId);
        },
        'evidence items',
        () => renderReport(data, path, analysis),
      );
    } else {
      el('p', 'No evidence items recorded (UNKNOWN).', cardsBox);
    }

    // #source-ledger hook with explicit UNKNOWN dates/editions and event queries/anchors
    const sourceBox = el('div', undefined, evSec);
    sourceBox.id = 'source-ledger';
    el('h3', 'Source ledger', sourceBox);
    if (analysis && analysis.sources.length > 0) {
      renderBoundedList(
        analysis.sources,
        'sources',
        sourceBox,
        (src, parent) => {
          const sCard = el('div', undefined, parent);
          sCard.className = 'source-card';
          sCard.id = `source-${src.canonicalSourceId}`;
          sCard.setAttribute('data-source-id', src.canonicalSourceId);
          el('h4', `${src.title ?? src.canonicalSourceId} (${src.kind})`, sCard);

          if (src.location) {
            appendSafeLocation(src.location, sCard);
          }
          if (src.roles.length > 0) {
            const rText = src.roles.map((r) => `${r.role} [${provenanceLane(r.provenance)}]`).join(', ');
            el('p', `Roles: ${rText}`, sCard);
          }
          el('p', `Identity status: ${src.identityStatus}`, sCard);

          if (src.publicationDate) {
            el('p', `Publication date: ${src.publicationDate.value} [${provenanceLane(src.publicationDate.provenance)}]`, sCard);
          } else {
            el('p', 'Publication date: UNKNOWN', sCard);
          }

          if (src.accessedDate) {
            el('p', `Accessed date: ${src.accessedDate.value} [${provenanceLane(src.accessedDate.provenance)}]`, sCard);
          } else {
            el('p', 'Accessed date: UNKNOWN', sCard);
          }

          if (src.edition) {
            el(
              'p',
              `Edition: ${src.edition.label}${src.edition.identifier ? ' (' + src.edition.identifier + ')' : ''} [${provenanceLane(src.edition.provenance)}]`,
              sCard,
            );
          } else {
            el('p', 'Edition: UNKNOWN', sCard);
          }

          if (src.queries.length > 0) {
            const qBox = el('div', undefined, sCard);
            qBox.className = 'source-queries';
            el('strong', 'Queries: ', qBox);
            renderBoundedList(src.queries, `queries:${src.canonicalSourceId}`, qBox, (q, container) => {
              const qBtn = button(`Query "${q.query}" (event ${q.eventId})`, container, () => {
                void openEventInspector(q.eventId, runId, answerId);
              });
              qBtn.setAttribute('data-event-id', q.eventId);
              qBtn.className = 'chain-link';
            }, 'source queries', () => renderReport(data, path, analysis));
          }

          if (src.anchors.length > 0) {
            const aBox = el('div', undefined, sCard);
            aBox.className = 'source-anchors';
            el('strong', 'Anchors: ', aBox);
            renderBoundedList(src.anchors, `anchors:${src.canonicalSourceId}`, aBox, (a, container) => {
              if (a.eventId) {
                const evId = a.eventId;
                const aBtn = button(`Inspect anchor ${evId}`, container, () => {
                  void openEventInspector(evId, runId, answerId);
                });
                aBtn.setAttribute('data-event-id', evId);
                aBtn.className = 'chain-link';
              }
            }, 'source anchors', () => renderReport(data, path, analysis));
          }

          if (src.basis?.limitations && src.basis.limitations.length > 0) {
            el('p', `Rule limitations: ${src.basis.limitations.join('; ')}`, sCard);
          }
        },
        'sources',
        () => renderReport(data, path, analysis),
      );
    } else {
      el('p', 'No sources normalized (UNKNOWN).', sourceBox);
    }
  }

  /* ------------------------------------------------------------- */
  /* 3. PROCESS SECTION                                            */
  /* ------------------------------------------------------------- */
  const procSec = section('Process and diagnostics', app);

  // #exploration-graph hook with keyboard selection, endpoint jump & real relation provenance
  if (data.receipt) {
    const graphBox = el('div', undefined, procSec);
    graphBox.id = 'exploration-graph';
    el('h3', 'Claim / Evidence / Decision graph', graphBox);

    if (analysis) {
      el('p', `Evidence coverage: ${analysis.claims.filter((c) => c.supportingEvidenceIds.length > 0).length}/${analysis.claims.length} claims with supporting evidence links · ${analysis.evidence.filter((e) => e.admissibility === 'ADMISSIBLE').length}/${analysis.evidence.length} admissible evidence items. Claim support remains the analyzer judgement.`, graphBox);
      if (analysis.projection.mode === 'IDEATE') {
        const branches = el('div', undefined, graphBox);
        renderBoundedList(analysis.projection.branches, 'graphBranches', branches, (branch, container) => {
          el('p', `Branch ${branch.branchId}: ${branch.status} · ${branch.eventIds.length} events · discard evidence ${branch.discardEvidenceIds?.join(', ') || 'UNKNOWN'}`, container);
        }, 'branches', () => renderReport(data, path, analysis));
      }
      // Build unified semantic graph nodes (Claims + Evidence + Decisions + Topology)
      /** @type {Array<{ nodeId: string, kind: string, label: string, provenance: ProvenanceCategory, eventIds: readonly string[], targetDataId?: string }>} */
      const semanticNodes = [];
      const nodeIdsSeen = new Set();

      for (const claim of analysis.claims) {
        if (!nodeIdsSeen.has(claim.claimId)) {
          nodeIdsSeen.add(claim.claimId);
          semanticNodes.push({
            nodeId: claim.claimId,
            kind: analysis.projection.mode === 'DECIDE' &&
              analysis.projection.recommendationClaimIds.includes(claim.claimId) ? 'DECISION' : 'CLAIM',
            label: claim.text,
            provenance: claim.provenance,
            eventIds: claim.anchors.map((a) => a.eventId).filter(/** @type {(e?: string) => e is string} */ ((e) => Boolean(e))),
            targetDataId: claim.claimId,
          });
        }
      }

      for (const ev of analysis.evidence) {
        if (!nodeIdsSeen.has(ev.evidenceId)) {
          nodeIdsSeen.add(ev.evidenceId);
          semanticNodes.push({
            nodeId: ev.evidenceId,
            kind: 'EVIDENCE',
            label: `Evidence (${ev.grounding}, admissibility: ${ev.admissibility})`,
            provenance: ev.effectiveProvenance,
            eventIds: [ev.eventId],
            targetDataId: ev.evidenceId,
          });
        }
      }

      if (analysis.topology?.nodes) {
        for (const tn of analysis.topology.nodes) {
          if (!nodeIdsSeen.has(tn.nodeId)) {
            nodeIdsSeen.add(tn.nodeId);
            semanticNodes.push({
              nodeId: tn.nodeId,
              kind: tn.kind,
              label: tn.label,
              provenance: tn.provenance,
              eventIds: tn.eventIds,
            });
          }
        }
      }

      // Present actual analyzer relations and topology edges together. IDs,
      // endpoints and basis stay exactly as recorded in their own contracts.
      const graphRelations = [
        ...analysis.relations.map((r) => ({ ...r, eventIds: /** @type {readonly string[]} */ ([]) })),
        ...analysis.topology.edges.map((e) => ({
          relationId: e.edgeId, type: e.kind, fromId: e.fromNodeId, toId: e.toNodeId,
          evidenceIds: /** @type {readonly string[]} */ ([]), eventIds: e.eventIds,
          provenance: /** @type {ProvenanceCategory} */ (
            e.kind === 'INFERRED_BRANCH' ? 'VIEWTRACE_INFERRED' : 'VIEWTRACE_OBSERVED'
          ), basis: e.basis,
        })),
      ];

      // A bounded visual preview draws only recorded endpoints. Position is
      // presentation, not chronology, causality or a new semantic relation.
      const previewIds = new Set();
      const nodesById = new Map(semanticNodes.map((node) => [node.nodeId, node]));
      for (const relation of graphRelations) {
        if (previewIds.size >= 10) break;
        if (nodesById.has(relation.fromId)) previewIds.add(relation.fromId);
        if (nodesById.has(relation.toId)) previewIds.add(relation.toId);
      }
      for (const node of semanticNodes) {
        if (previewIds.size >= 12) break;
        previewIds.add(node.nodeId);
      }
      const previewNodes = semanticNodes.filter((node) => previewIds.has(node.nodeId));
      if (previewNodes.length > 0) {
        el('p', `Graph preview: ${previewNodes.length}/${semanticNodes.length} nodes. Select a node here or use the keyboard controls below. Layout does not imply event order.`, graphBox);
        const previewWrap = el('div', undefined, graphBox);
        previewWrap.className = 'graph-preview-wrap';
        previewWrap.tabIndex = 0;
        previewWrap.setAttribute('role', 'region');
        previewWrap.setAttribute('aria-label', 'Graph visual preview');
        previewWrap.dataset.focusKey = 'graph-preview';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('graph-preview');
        svg.setAttribute('viewBox', '0 0 760 360');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', 'Recorded graph connections; equivalent labelled node and relation controls follow');
        previewWrap.append(svg);
        const positions = new Map(previewNodes.map((node, index) => [node.nodeId, {
          x: 16 + (index % 3) * 250, y: 16 + Math.floor(index / 3) * 88,
        }]));
        const visibleRelations = graphRelations.filter((relation) =>
          positions.has(relation.fromId) && positions.has(relation.toId)).slice(0, 24);
        for (const relation of visibleRelations) {
          const from = positions.get(relation.fromId);
          const to = positions.get(relation.toId);
          if (!from || !to) continue;
          const line = document.createElementNS(svg.namespaceURI, 'line');
          line.setAttribute('x1', String(from.x + 108));
          line.setAttribute('y1', String(from.y + 25));
          line.setAttribute('x2', String(to.x + 108));
          line.setAttribute('y2', String(to.y + 25));
          line.setAttribute('class', `preview-edge lane-${provenanceLane(relation.provenance)}`);
          if (relation.provenance === 'VIEWTRACE_INFERRED') line.setAttribute('stroke-dasharray', '7 5');
          const title = document.createElementNS(svg.namespaceURI, 'title');
          title.textContent = `${relation.relationId}: ${relation.fromId} → ${relation.toId} (${relation.provenance}, ${relationEdgeStyleName(relation.provenance)})`;
          line.append(title);
          svg.append(line);
        }
        for (const node of previewNodes) {
          const pos = positions.get(node.nodeId);
          if (!pos) continue;
          const group = document.createElementNS(svg.namespaceURI, 'g');
          group.setAttribute('class', `preview-node${selectedGraphNodeId === node.nodeId ? ' preview-selected' : ''}`);
          group.setAttribute('transform', `translate(${pos.x} ${pos.y})`);
          const rect = document.createElementNS(svg.namespaceURI, 'rect');
          rect.setAttribute('width', '216');
          rect.setAttribute('height', '50');
          rect.setAttribute('rx', '6');
          group.append(rect);
          const text = document.createElementNS(svg.namespaceURI, 'text');
          text.setAttribute('x', '10');
          text.setAttribute('y', '20');
          text.textContent = `${node.kind} [${provenanceLane(node.provenance)}]`;
          group.append(text);
          const label = document.createElementNS(svg.namespaceURI, 'text');
          label.setAttribute('x', '10');
          label.setAttribute('y', '39');
          label.textContent = node.nodeId.length > 26 ? `${node.nodeId.slice(0, 25)}…` : node.nodeId;
          group.append(label);
          const title = document.createElementNS(svg.namespaceURI, 'title');
          title.textContent = `${node.nodeId}: ${node.label} (${node.provenance})`;
          group.append(title);
          group.addEventListener('click', () => {
            selectedGraphNodeId = node.nodeId;
            selectedGraphRelationId = null;
            void renderReport(data, path, analysis).catch(presentationError);
          });
          svg.append(group);
        }
      }

      // Selection Detail Panel
      if (selectedGraphNodeId || selectedGraphRelationId) {
        const selPanel = el('div', undefined, graphBox);
        selPanel.className = 'graph-selection-panel';
        if (selectedGraphNodeId) {
          const sNode = semanticNodes.find((n) => n.nodeId === selectedGraphNodeId);
          if (sNode) {
            el('h4', `Selected node: ${sNode.nodeId} (${sNode.kind})`, selPanel);
            el('p', sNode.label, selPanel);
            appendLaneBadge(sNode.provenance, selPanel);
            if (sNode.kind === 'CLAIM' || sNode.kind === 'DECISION') {
              const jumpBtn = button('Jump to claim card', selPanel, () => {
                highlightAndFocus(`[data-claim-id="${CSS.escape(sNode.nodeId)}"]`);
              });
              jumpBtn.className = 'chain-link';
            } else if (sNode.kind === 'EVIDENCE') {
              const jumpBtn = button('Jump to evidence card', selPanel, () => {
                highlightAndFocus(`[data-evidence-id="${CSS.escape(sNode.nodeId)}"]`);
              });
              jumpBtn.className = 'chain-link';
            }
            if (sNode.eventIds.length > 0) {
              for (const eId of sNode.eventIds) {
                const eBtn = button(`Inspect event ${eId}`, selPanel, () => {
                  void openEventInspector(eId, runId, answerId);
                });
                eBtn.setAttribute('data-event-id', eId);
              }
            }
            // Connected relations
            const connectedRels = graphRelations.filter(
              (r) => r.fromId === sNode.nodeId || r.toId === sNode.nodeId,
            );
            if (connectedRels.length > 0) {
              const cBox = el('div', undefined, selPanel);
              el('strong', 'Connected relations: ', cBox);
              for (const cr of connectedRels) {
                const otherId = cr.fromId === sNode.nodeId ? cr.toId : cr.fromId;
                const crBtn = button(`${cr.type} -> ${otherId}`, cBox, () => {
                  selectedGraphNodeId = otherId;
                  void renderReport(data, path, analysis).catch(presentationError);
                });
                crBtn.className = 'chain-link';
              }
            }
          }
        } else if (selectedGraphRelationId) {
          const sRel = graphRelations.find((r) => r.relationId === selectedGraphRelationId);
          if (sRel) {
            const lane = provenanceLane(sRel.provenance);
            const edgeStyle = relationEdgeStyleName(sRel.provenance);
            el('h4', `Selected relation: ${sRel.relationId}`, selPanel);
            el(
              'p',
              `Type: ${sRel.type} · Provenance: ${sRel.provenance} [${lane}, ${edgeStyle}] · Rule basis: ${sRel.basis?.ruleId ?? 'NONE'}`,
              selPanel,
            );
            const endBox = el('div', undefined, selPanel);
            el('strong', 'Endpoints: ', endBox);
            const fromBtn = button(`From: ${sRel.fromId}`, endBox, () => {
              selectedGraphNodeId = sRel.fromId;
              selectedGraphRelationId = null;
              void renderReport(data, path, analysis).catch(presentationError);
            });
            fromBtn.className = 'chain-link';
            const toBtn = button(`To: ${sRel.toId}`, endBox, () => {
              selectedGraphNodeId = sRel.toId;
              selectedGraphRelationId = null;
              void renderReport(data, path, analysis).catch(presentationError);
            });
            toBtn.className = 'chain-link';

            for (const eventId of sRel.eventIds.slice(0, 20)) {
              const action = button(`Inspect event ${eventId}`, selPanel, () => {
                void openEventInspector(eventId, runId, answerId);
              });
              action.setAttribute('data-event-id', eventId);
            }

            if (sRel.evidenceIds.length > 0) {
              const eBox = el('div', undefined, selPanel);
              el('strong', 'Relation evidence: ', eBox);
              for (const eId of sRel.evidenceIds) {
                const eBtn = button(eId, eBox, () => {
                  highlightAndFocus(`[data-evidence-id="${CSS.escape(eId)}"]`);
                });
                eBtn.setAttribute('data-evidence-id', eId);
                eBtn.className = 'chain-link';
              }
            }
          }
        }
        button('Clear selection', selPanel, () => {
          selectedGraphNodeId = null;
          selectedGraphRelationId = null;
          void renderReport(data, path, analysis).catch(presentationError);
        });
      }

      // Render Graph Nodes (keyboard accessible)
      el('h4', 'Graph nodes (select with click or Enter)', graphBox);
      const nList = el('div', undefined, graphBox);
      renderBoundedList(
        semanticNodes,
        'graphNodes',
        nList,
        (node, container) => {
          const nEl = el('div', undefined, container);
          nEl.className = `graph-node ${selectedGraphNodeId === node.nodeId ? 'node-selected' : ''}`;
          nEl.setAttribute('data-node-id', node.nodeId);
          nEl.setAttribute('tabindex', '0');
          nEl.setAttribute('role', 'button');
          nEl.setAttribute('aria-pressed', selectedGraphNodeId === node.nodeId ? 'true' : 'false');

          el('strong', `${node.nodeId} (${node.kind}): `, nEl);
          el('span', node.label, nEl);
          appendLaneBadge(node.provenance, nEl);

          nEl.addEventListener('click', () => {
            selectedGraphNodeId = selectedGraphNodeId === node.nodeId ? null : node.nodeId;
            selectedGraphRelationId = null;
            void renderReport(data, path, analysis).catch(presentationError);
          });
          nEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              selectedGraphNodeId = selectedGraphNodeId === node.nodeId ? null : node.nodeId;
              selectedGraphRelationId = null;
              void renderReport(data, path, analysis).catch(presentationError);
            }
          });

        },
        'nodes',
        () => renderReport(data, path, analysis),
      );

      // Render Relations with solid/dashed border, textual style disclosure, and keyboard selection
      el('h4', 'Graph relations (reflects relation own provenance; select with click or Enter)', graphBox);
      const rList = el('div', undefined, graphBox);
      renderBoundedList(
        graphRelations,
        'graphRelations',
        rList,
        (rel, container) => {
          const relEl = el('div', undefined, container);
          const edgeStyle = relationEdgeStyleName(rel.provenance);
          const lane = provenanceLane(rel.provenance);
          relEl.className = `graph-relation ${relationEdgeClass(rel.provenance)} ${selectedGraphRelationId === rel.relationId ? 'relation-selected' : ''}`;
          relEl.setAttribute('data-relation-id', rel.relationId);
          relEl.setAttribute('data-provenance', rel.provenance);
          relEl.setAttribute('tabindex', '0');
          relEl.setAttribute('role', 'button');
          relEl.setAttribute('aria-pressed', selectedGraphRelationId === rel.relationId ? 'true' : 'false');

          el('span', `${rel.fromId} --(${rel.type} [${lane}, ${edgeStyle}])--> ${rel.toId}`, relEl);
          if (rel.evidenceIds && rel.evidenceIds.length > 0) {
            el('small', `Evidence: ${rel.evidenceIds.join(', ')}`, relEl);
          }

          relEl.addEventListener('click', () => {
            selectedGraphRelationId = selectedGraphRelationId === rel.relationId ? null : rel.relationId;
            selectedGraphNodeId = null;
            void renderReport(data, path, analysis).catch(presentationError);
          });
          relEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              selectedGraphRelationId = selectedGraphRelationId === rel.relationId ? null : rel.relationId;
              selectedGraphNodeId = null;
              void renderReport(data, path, analysis).catch(presentationError);
            }
          });
        },
        'relations',
        () => renderReport(data, path, analysis),
      );

      // Separate Exploration Topology Section
      if (analysis.topology) {
        el('h4', 'Exploration topology & frontiers', graphBox);
        el('p', `Frontier status: ${analysis.topology.frontierStatus} `, graphBox);
        appendLaneBadge(analysis.topology.frontierStatus, graphBox);
        if (analysis.topology.currentFrontierNodeIds && analysis.topology.currentFrontierNodeIds.length > 0) {
          el('p', `Current frontier: ${analysis.topology.currentFrontierNodeIds.join(', ')}`, graphBox);
        }
        if (analysis.topology.activityConcentration.length > 0) {
          const act = analysis.topology.activityConcentration[0];
          if (act) {
            el(
              'p',
              `Activity concentration: ${act.numerator}/${act.denominator} ${act.unit} (${act.meaning})`,
              graphBox,
            );
          }
        }
        if (analysis.topology.sourceConcentration.length > 0) {
          const sc = analysis.topology.sourceConcentration[0];
          if (sc) {
            el('p', `Source concentration: ${sc.numerator}/${sc.denominator} ${sc.unit} (${sc.meaning})`, graphBox);
          }
        }
        if (analysis.topology.limitations.length > 0) {
          el('p', `Topology limitations (dead-end/backtrack limits): ${analysis.topology.limitations.join('; ')}`, graphBox);
        }

        // Exploration Activity & Cluster nodes
        const topoNodesBox = el('div', undefined, graphBox);
        renderBoundedList(
          analysis.topology.nodes,
          'topologyNodes',
          topoNodesBox,
          (tNode, container) => {
            const tEl = el('div', undefined, container);
            tEl.className = 'graph-node';
            tEl.setAttribute('data-topology-node-id', tNode.nodeId);
            el('strong', `${tNode.nodeId} (${tNode.kind}): `, tEl);
            el('span', tNode.label, tEl);
            appendLaneBadge(tNode.provenance, tEl);
            if (tNode.eventIds.length > 0) {
              const firstEv = tNode.eventIds[0];
              if (firstEv) {
                const btn = button(`Inspect event ${firstEv}`, tEl, () => {
                  void openEventInspector(firstEv, runId, answerId);
                });
                btn.setAttribute('data-event-id', firstEv);
              }
            }
          },
          'topology nodes',
          () => renderReport(data, path, analysis),
        );
      }
    } else {
      el('p', 'Graph topology not available (UNKNOWN).', graphBox);
    }

    // #health-ledger hook with conflict history and verification assessments
    const healthBox = el('div', undefined, procSec);
    healthBox.id = 'health-ledger';
    el('h3', 'Evidence health and contradiction ledger', healthBox);
    if (analysis) {
      el('h4', 'Conflicts and contradictions', healthBox);
      if (analysis.conflicts.length > 0) {
        renderBoundedList(
          analysis.conflicts,
          'conflicts',
          healthBox,
          (c, parent) => {
            const cBox = el('div', undefined, parent);
            cBox.className = 'conflict-card';
            el('h5', `Conflict ${c.conflictId} · Status: ${c.status}`, cBox);
            el('p', `Claims: ${c.claimIds.join(', ')} · Condition match: ${c.conditionMatch}`, cBox);
            if (c.resolution) {
              const res = c.resolution;
              const rP = el('p', undefined, cBox);
              el(
                'span',
                `Resolution: ${res.result} by verify event ${res.verifyEventId} (resolver evidence: ${res.resolverEvidenceIds.join(', ')}) `,
                rP,
              );
              const rBtn = button(`Inspect verify event ${res.verifyEventId}`, rP, () => {
                void openEventInspector(res.verifyEventId, runId, answerId);
              });
              rBtn.setAttribute('data-event-id', res.verifyEventId);
            }
            if (c.history && c.history.length > 0) {
              const hDetails = el('details', undefined, cBox);
              hDetails.id = `details-conflict-hist-${c.conflictId}`;
              if (openDetailsState.has(hDetails.id)) hDetails.open = true;
              hDetails.addEventListener('toggle', () => {
                if (hDetails.open) openDetailsState.add(hDetails.id);
                else openDetailsState.delete(hDetails.id);
              });
              el('summary', `Conflict history (${c.history.length} transitions)`, hDetails);
              const hList = el('ul', undefined, hDetails);
              for (const h of c.history) {
                const hItem = el('li', undefined, hList);
                el(
                  'span',
                  `Status: ${h.status} · Revision: ${h.inputRevision.value.slice(0, 8)} · Rule: ${h.basis.ruleId} v${h.basis.ruleVersion}`,
                  hItem,
                );
              }
            }
            if (c.limitations.length > 0) {
              el('p', `Limitations: ${c.limitations.join('; ')}`, cBox);
            }
          },
          'conflicts',
          () => renderReport(data, path, analysis),
        );
      } else {
        el('p', 'No active contradictions detected.', healthBox);
      }

      el('h4', 'Verification assessments', healthBox);
      if (analysis.verifications.length > 0) {
        renderBoundedList(
          analysis.verifications,
          'verifications',
          healthBox,
          (v, parent) => {
            const vCard = el('div', undefined, parent);
            vCard.className = 'verification-card';
            const targetDesc = v.target.kind === 'CLAIM' ? `Claim ${v.target.claimId}` : `Event ${v.target.eventId}`;
            el('h5', `Verification: ${targetDesc} (Result: ${v.result})`, vCard);
            el('p', `Target resolution: ${v.targetResolution} · Correctness: ${v.correctness}`, vCard);
            if (v.resolverEvidenceIds.length > 0) {
              el('p', `Resolver evidence: ${v.resolverEvidenceIds.join(', ')}`, vCard);
            }
            if (v.limitations.length > 0) {
              el('p', `Limitations: ${v.limitations.join('; ')}`, vCard);
            }
            const vBtn = button(`Inspect verify event ${v.verifyEventId}`, vCard, () => {
              void openEventInspector(v.verifyEventId, runId, answerId);
            });
            vBtn.setAttribute('data-event-id', v.verifyEventId);
          },
          'verifications',
          () => renderReport(data, path, analysis),
        );
      } else {
        el('p', 'No verification assessments recorded.', healthBox);
      }
    } else {
      el('p', 'Evidence health ledger UNKNOWN (pending analysis).', healthBox);
    }

    // #unresolved-areas hook with first-class reason codes, claim reason IDs, pending references and honesty check
    const unresBox = el('div', undefined, procSec);
    unresBox.id = 'unresolved-areas';
    el('h3', 'Unresolved areas', unresBox);
    if (analysis && analysis.support) {
      /** @type {Array<{ claimId: string, reasons: readonly string[] }>} */
      const claimUnresolvedList = [];
      for (const c of analysis.claims) {
        if (c.unresolvedReasonIds.length > 0) {
          claimUnresolvedList.push({ claimId: c.claimId, reasons: c.unresolvedReasonIds });
        }
      }
      const pendingRefs = analysis.references.filter((r) => r.status !== 'RESOLVED');

      if (analysis.support.missingRequiredConditionIds.length > 0) {
        el('p', `Missing required conditions: ${analysis.support.missingRequiredConditionIds.join(', ')}`, unresBox);
      }
      if (analysis.support.unresolvedConflictIds.length > 0) {
        el('p', `Unresolved conflicts: ${analysis.support.unresolvedConflictIds.join(', ')}`, unresBox);
      }
      if (analysis.support.reasonCodes.length > 0) {
        el('p', `Support reason codes: ${analysis.support.reasonCodes.join(', ')}`, unresBox);
      }
      if (claimUnresolvedList.length > 0) {
        renderBoundedList(claimUnresolvedList, 'unresolvedClaims', unresBox, (item, container) => {
          el('p', `Claim ${item.claimId} unresolved reasons: ${item.reasons.join(', ')}`, container);
        }, 'unresolved claims', () => renderReport(data, path, analysis));
      }
      if (pendingRefs.length > 0) {
        el(
          'p',
          `Unresolved references: ${pendingRefs.map((r) => `${r.referenceId} (${r.kind}: ${r.status})`).join(', ')}`,
          unresBox,
        );
      }
      if (analysis.references.length > 0) {
        const nonPending = analysis.references.filter((r) => r.status === 'RESOLVED');
        if (nonPending.length > 0) {
          el(
            'p',
            `Diagnostics / Resolved references: ${nonPending.map((r) => `${r.referenceId} (${r.kind}: ${r.status})`).join(', ')}`,
            unresBox,
          );
        }
      }

      const hasUnresolvedItems =
        analysis.support.missingRequiredConditionIds.length > 0 ||
        analysis.support.unresolvedConflictIds.length > 0 ||
        claimUnresolvedList.length > 0 ||
        pendingRefs.length > 0;
      const isAuthoritativelySupported = analysis.support.status === 'STRONGLY_SUPPORTED';

      if (!hasUnresolvedItems && isAuthoritativelySupported) {
        el('p', 'No critical unresolved conditions.', unresBox);
      } else if (!hasUnresolvedItems && !isAuthoritativelySupported) {
        el(
          'p',
          `Evidence support status is ${analysis.support.status}; core claims remain unconfirmed or pending required support.`,
          unresBox,
        );
      }
    } else {
      el('p', 'Unresolved areas pending analysis (UNKNOWN).', unresBox);
    }

    // #jev-advisory hook with ? UNKNOWN / UNAVAILABLE handling
    const jevBox = el('div', undefined, procSec);
    jevBox.id = 'jev-advisory';
    el('h3', 'JEV advisory', jevBox);
    el(
      'p',
      'JEV is advisory and never an input to evidence support. Evaluator assessments are reported judgements, not observed facts or claim verifications.',
      jevBox,
    );
    if (analysis && analysis.jevResults && analysis.jevResults.length > 0) {
      renderBoundedList(analysis.jevResults, 'jevResults', jevBox, (res, container) => {
        const jCard = el('div', undefined, container);
        jCard.className = 'jev-card';
        el('h4', `JEV checkpoint: ${res.checkpointId} · Status: ${res.status}`, jCard);
        el('p', `Evaluator: ${res.evaluator.provider} v${res.evaluator.evaluatorVersion}`, jCard);
        if (res.labels && res.status === 'SUCCEEDED') {
          el(
            'p',
            `Labels [inf, advisory]: Evidence gain: ${res.labels.evidenceGain} · Progress: ${res.labels.progress} · Rethink needed: ${res.labels.rethinkNeeded}`,
            jCard,
          );
        } else {
          el('p', 'Labels: ? UNKNOWN / UNAVAILABLE (Evaluator judgement missing or failed)', jCard);
        }
        el('p', `Provenance: ${res.provenance} [rep] · Support effect: ${res.supportEffect} (advisory only)`, jCard);
      }, 'JEV evaluations', () => renderReport(data, path, analysis));
    } else {
      el('p', 'JEV unavailable: ? UNKNOWN — No JEV evaluations recorded for this trace.', jevBox);
    }
  }

  // Diagnostics list (preserving M2 behavior)
  el(
    'p',
    `${data.diagnosticCount} diagnostics; at most 100 displayed. Provenance labels are claimed by the reference producer, never verified by ViewTrace.`,
    procSec,
  );
  for (const d of data.diagnostics) el('p', `${d.severity} ${d.code}: ${d.message}`, procSec);

  // Retention controls (preserving M2 behavior)
  const controls = section('Local retention', app);
  el(
    'p',
    data.kept
      ? 'Kept: excluded from explicit age pruning.'
      : 'Default retention: keep indefinitely. Age pruning requires an explicit CLI action.',
    controls,
  );
  button(data.kept ? 'Release keep' : 'Keep run', controls, async () => {
    try {
      await api(`/api/runs/${data.run.runId}/keep`, 'POST', {
        keep: !data.kept,
      });
      await refresh(path, true);
    } catch (e) {
      error(e);
    }
  });
  button('Delete this run and its receipts', controls, async () => {
    if (!confirm('Delete this stored run, all its answers and derived local artifacts?')) return;
    try {
      await api(`/api/runs/${data.run.runId}`, 'DELETE');
      location.assign('/');
    } catch (e) {
      error(e);
    }
  });

  /* ------------------------------------------------------------- */
  /* 4. RAW SECTION with native details, collapse & pagination     */
  /* ------------------------------------------------------------- */
  const raw = section('Sanitized events / Raw', app);
  const rawEventsContainer = el('div', undefined, raw);
  rawEventsContainer.id = 'raw-events';

  if (data.scope && data.scope.missingCount > 0) {
    el('p', `Collection loss notice: ${data.scope.missingCount} missing events detected in scope.`, rawEventsContainer);
  }

  let rawCursor = 0;
  /** @type {Set<string>} */
  const loadedEventIds = new Set();

  async function loadRawEvents() {
    const selParam = new URLSearchParams(location.search).get('selection');
    const selQuery = selParam ? `&selection=${encodeURIComponent(selParam)}` : '';

    while (loadedEventIds.size < rawPageTarget) {
      /** @type {EventPageData} */
      const page = await api(`${path}/events?limit=50&cursor=${rawCursor}${selQuery}`);
      if (page.revision !== data.revision) throw new Error('Saved trace has changed.');

      for (const event of page.events) {
        const cacheKey = `${runId}:${answerId ?? ''}:${event.eventId}:${data.revision}`;
        eventCache.set(cacheKey, event);
        if (loadedEventIds.has(event.eventId)) continue;
        loadedEventIds.add(event.eventId);

        // IMPORTANT: <article> tag preserved specifically for raw events to satisfy existing M2 tests!
        const row = el('article', undefined, rawEventsContainer);
        row.setAttribute('data-event-id', event.eventId);
        el('h3', `${event.type} · ${event.eventId}`, row);
        el('p', `Provenance ${event.provenance.category} (claimed; not verified)`, row);

        const details = el('details', undefined, row);
        details.id = `raw-details-${event.eventId}`;
        // Raw starts collapsed and preserves the user's state on refresh.
        details.open = openDetailsState.has(details.id);
        details.addEventListener('toggle', () => {
          if (details.open) openDetailsState.add(details.id);
          else openDetailsState.delete(details.id);
        });

        el('summary', 'Raw event record', details).dataset.focusKey = `${details.id}:summary`;
        const pre = el('pre', JSON.stringify(event, null, 2), details);
        pre.className = 'event-payload';
        const loc = event.source?.location;
        if (loc) {
          appendSafeLocation(loc, details);
        }
      }

      if (page.nextCursor === null) {
        rawMoreBtn.hidden = true;
        break;
      }
      rawCursor = page.nextCursor;
      rawMoreBtn.hidden = false;
    }
  }

  const rawMoreBtn = button('Load more events', raw, async () => {
    rawMoreBtn.disabled = true;
    rawMoreBtn.textContent = 'Loading more events…';
    rawPageTarget += 50;
    try {
      await loadRawEvents();
    } catch (err) {
      presentationError(err);
    } finally {
      rawMoreBtn.disabled = false;
      rawMoreBtn.textContent = 'Load more events';
    }
  });
  rawMoreBtn.id = 'raw-more';

  await loadRawEvents();
  currentDetailRevision = data.revision;
  restoreFocusState();
}

/**
 * Polling and page refresh with live revision change detection and STALE handling
 * @param {string} path
 * @param {boolean} [force=false]
 * @returns {Promise<void>}
 */
async function refresh(path, force = false) {
  clearTimeout(timer);
  try {
    const selParam = new URLSearchParams(location.search).get('selection');
    const selQuery = selParam ? `?selection=${encodeURIComponent(selParam)}` : '';

    /** @type {AnswerDetailData | null} */
    let data = null;

    const isAnswer = /^\/api\/runs\/[^/]+\/answers\/[^/]+$/.test(path);
    /** @type {AnalysisReportV1 | null} */
    let analysis = null;

    if (isAnswer) {
      try {
        const modeQuery = currentModeOverride ? `&mode=${encodeURIComponent(currentModeOverride)}` : '';
        const analysisSel = selParam ? `&selection=${encodeURIComponent(selParam)}` : '';
        const analysisUrl = `${path}/analysis?${(modeQuery + analysisSel).replace(/^&/, '')}`;
        analysis = await api(analysisUrl);
        if (!analysis) throw new Error('Analysis is unavailable for this saved answer.');

        // Fetch detail after analysis so revision reflects evidenceSupport
        // persistence and the snapshot guard sees concurrent collection. The
        // selected answer path already supplies identity; no earlier detail
        // read is needed on the successful path.
        data = await api(path + selQuery);
        if (!data) throw new Error('The stored report is unavailable.');
        // An explicitly empty own list still means an exact empty scope in
        // M3, even though its boundary label is UNKNOWN. Only absent own IDs
        // use the run-scoped unknown analysis contract.
        const availableCount = analysis.scope.ownEventIds === undefined
          ? data.run.eventCount : data.scope?.eventCount;
        if (availableCount !== analysis.inputRevision.recordCount ||
            data.run.completeness !== analysis.support.collectionCompleteness) {
          throw new Error('The stored trace changed during analysis. Waiting for a matching snapshot.');
        }
      } catch (analysisErr) {
        // Keep the stored answer available on the first failed analysis, and
        // the complete prior snapshot on later failures. The outer handler
        // marks it STALE and retries without overwriting that state below.
        if (!currentDetailRevision) {
          if (!data) data = await api(path + selQuery);
          if (!data) throw new Error('The stored report is unavailable.');
          await renderReport(data, path, null);
        }
        throw analysisErr;
      }
    } else {
      data = await api(path + selQuery);
    }

    if (!data) throw new Error('The stored report is unavailable.');

    const currentAnalysisRev = analysis
      ? `${analysis.inputRevision.value}:${analysis.stateRevision}:${analysis.freshness.status}`
      : null;

    const shouldRedraw =
      force ||
      data.revision !== currentDetailRevision ||
      (currentAnalysisRev !== null && currentAnalysisRev !== currentAnalysisRevision);

    if (shouldRedraw) {
      await renderReport(data, path, analysis);
      currentDetailRevision = data.revision;
      currentAnalysisRevision = currentAnalysisRev;
    }

    const connection = document.getElementById('connection');
    if (connection) {
      if (analysis && analysis.freshness.status === 'STALE') {
        connection.textContent = `STALE analysis (${analysis.freshness.reasons.join(', ')}); checking for updates every 2 seconds.`;
      } else {
        connection.textContent = 'Stored snapshot; checking for updates every 2 seconds.';
      }
    }
  } catch (e) {
    const err =
      typeof e === 'object' && e !== null && 'status' in e
        ? /** @type {{ status?: number }} */ (e)
        : null;
    if (err && err.status === 404) {
      error(e);
      return;
    }
    let connection = document.getElementById('connection');
    if (!connection) {
      app.replaceChildren();
      el('h1', 'Local report unavailable', app);
      connection = el('p', '', app);
      connection.id = 'connection';
    }
    const msg = e instanceof Error ? e.message : String(e);
    connection.textContent = `STALE — ${msg} Retrying the same saved answer.`;
  }
  timer = setTimeout(() => {
    if (location.pathname === selectedPath) refresh(path);
  }, 2000);
}

const m = /^\/runs\/([^/]+)(?:\/answers\/([^/]+))?$/.exec(location.pathname);
if (m && m[1]) {
  const answerPart = m[2] ? `/answers/${m[2]}` : '';
  refresh(`/api/runs/${m[1]}${answerPart}`).catch(error);
} else {
  picker().catch(error);
}
