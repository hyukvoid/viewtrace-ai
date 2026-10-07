'use strict';
// All recorded strings use textContent. No HTML/markdown/raw URL execution.
const app = document.getElementById('app');
let revision = null;
let selectedPath = location.pathname;
let timer;
function el(tag, text, parent) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (parent) parent.append(node);
  return node;
}
function button(text, parent, fn) {
  const b = el('button', text, parent);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}
async function api(path, method = 'GET', data) {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: data ? { 'Content-Type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!r.ok)
    throw Object.assign(
      new Error(
        r.status === 404
          ? 'Saved answer/trace is missing or deleted. Choose a trace explicitly.'
          : `Local request failed (${r.status}).`,
      ),
      { status: r.status },
    );
  return r.json();
}
function link(text, path, parent) {
  const a = el('a', text, parent);
  a.href = path;
  return a;
}
function section(title, parent = app) {
  const s = el('section', undefined, parent);
  el('h2', title, s);
  return s;
}
function error(e) {
  clearTimeout(timer);
  app.replaceChildren();
  el('h1', 'Trace unavailable', app);
  el('p', e.message, app);
  link('Open recent trace picker', '/', app);
}
async function picker(offset = 0) {
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
    el('p', `${row.lifecycle} · collection ${row.completeness} · scope ${row.scope}`, s);
    button(`Select answer ${row.answerId}`, s, async () => {
      try {
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
        const result = await api('/api/select', 'POST', { runId: row.runId });
        location.assign(result.path);
      } catch (e) {
        error(e);
      }
    });
  }
  if (!data.answers.length && !data.runs.length) el('p', 'No saved traces.', app);
  if (data.nextOffset !== null)
    button('More candidates', app, async () => {
      try {
        await picker(data.nextOffset);
      } catch (e) {
        error(e);
      }
    });
}
async function renderReport(data, path) {
  app.replaceChildren();
  revision = data.revision;
  el('h1', data.receipt ? `Answer ${data.receipt.answerId}` : `Run ${data.run.runId}`, app);
  el(
    'p',
    `Lifecycle ${data.run.lifecycle} · Collection ${data.run.completeness} · Evidence support UNKNOWN`,
    app,
  ).id = 'status';
  el('p', `Revision ${data.revision}`, app).id = 'revision';
  el('p', 'Stored snapshot; checking for updates every 2 seconds.', app).id = 'connection';
  if (data.receipt) {
    const answer = section('Answer');
    el('pre', data.receipt.answer, answer);
    el(
      'p',
      `Receipt ${data.receipt.receiptId} · ${data.receipt.agentId} · session ${data.receipt.agentSessionId ?? 'UNKNOWN'} · turn ${data.receipt.turnId ?? 'UNKNOWN'}`,
      answer,
    );
    el(
      'p',
      `Receipt integrity ${data.receiptIntegrity}. Association ${data.association.status} (${data.association.basis}); current answer match ${data.association.currentAnswerMatch}.`,
      answer,
    );
    el('p', `Hash policy ${data.receipt.hashVersion}; finalized ${data.receipt.timestamp}`, answer);
    const evidence = section('Evidence scope');
    el(
      'p',
      `${data.scope.status} · ${data.scope.eventCount} available · ${data.scope.ownDeclared ?? 'UNKNOWN'} own · ${data.scope.sharedDeclared} shared · ${data.scope.missingCount} missing · ${data.scope.conflicts} conflicting assignments`,
      evidence,
    );
  } else {
    el('p', 'Run exploration container. Answer association UNKNOWN.', app);
  }
  const process = section('Process and diagnostics');
  el(
    'p',
    `${data.diagnosticCount} diagnostics; at most 100 displayed. Provenance labels are claimed by the reference producer, never verified by ViewTrace.`,
    process,
  );
  for (const d of data.diagnostics) el('p', `${d.severity} ${d.code}: ${d.message}`, process);
  const raw = section('Sanitized events / Raw');
  let cursor = 0;
  let loaded = new Set();
  async function load() {
    const page = await api(
      `${path}/events?limit=50&cursor=${cursor}${new URLSearchParams(location.search).has('selection') ? '&selection=' + new URLSearchParams(location.search).get('selection') : ''}`,
    );
    if (page.revision !== data.revision) throw new Error('Saved trace has changed.');
    for (const event of page.events) {
      if (loaded.has(event.eventId)) continue;
      loaded.add(event.eventId);
      const row = el('article', undefined, raw);
      el('h3', `${event.type} · ${event.eventId}`, row);
      el('p', `Provenance ${event.provenance.category} (claimed; not verified)`, row);
      el('pre', JSON.stringify(event, null, 2), row);
      const location = event.source?.location;
      if (location) {
        try {
          const u = new URL(location);
          if (['http:', 'https:'].includes(u.protocol) && !u.username && !u.password) {
            const a = link('Open recorded source (external)', u.href, row);
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
          }
        } catch {}
      }
    }
    cursor = page.nextCursor;
    more.hidden = cursor === null;
  }
  const more = button('Load more events', raw, () => {
    load().catch(error);
  });
  await load();
  const controls = section('Local retention');
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
}
async function refresh(path, force = false) {
  clearTimeout(timer);
  try {
    const data = await api(path + location.search);
    if (force || data.revision !== revision) await renderReport(data, path);
    const connection = document.getElementById('connection');
    if (connection) connection.textContent = 'Stored snapshot; checking for updates every 2 seconds.';
  } catch (e) {
    if (e.status === 404) {
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
    connection.textContent = `STALE — ${e.message} Retrying the same saved answer.`;
  }
  timer = setTimeout(() => {
    if (location.pathname === selectedPath) refresh(path);
  }, 2000);
}
const m = /^\/runs\/([^/]+)(?:\/answers\/([^/]+))?$/.exec(location.pathname);
if (m) refresh(`/api/runs/${m[1]}${m[2] ? `/answers/${m[2]}` : ''}`).catch(error);
else picker().catch(error);
