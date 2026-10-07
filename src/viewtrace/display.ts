/**
 * Terminal output formatting for live runs (M1).
 *
 * Rules:
 *  - ZERO ANSI escapes are ever emitted, so TTY and pipe/non-TTY output are
 *    the same stable text.
 *  - Producer-controlled strings (queries, chatter, stderr) are sanitized:
 *    escape sequences and control characters are removed before display.
 *  - Provenance labels (reported / observed / inferred) are always shown —
 *    the display must never present agent claims as observed facts.
 */

import { DISPLAY_NAMES } from './types.js';
import type { Diagnostic, LossRecord, RunLifecycle, ViewTraceEvent } from './types.js';

const ANSI_PATTERN = /(?:\x1b\[|\u009b)[0-9;?]*[ -/]*[@-~]|(?:\x1b\]|\u009d)[^\x07\x1b\u009c]*(?:\x07|\x1b\\|\u009c)?/g;
const CONTROL_PATTERN = /[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f]/g;

export function sanitizeForTerminal(input: string, maxLength = 200): string {
  let text = sanitizeTerminalLine(input);
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > maxLength) text = `${text.slice(0, maxLength)}…`;
  return text;
}

/** Keep layout spaces while blocking producer-created lines and controls. */
export function sanitizeTerminalLine(input: string): string {
  return input.replace(ANSI_PATTERN, ' ').replace(CONTROL_PATTERN, ' ').replace(/[\r\n\t]/g, ' ');
}

/** Escape C1 controls in JSON without changing any decoded contract value. */
export function stringifyForTerminal(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space).replace(/[\u007f-\u009f]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function clock(): string {
  return new Date().toISOString().slice(11, 19) + 'Z';
}

export function provenanceLabel(category: ViewTraceEvent['provenance']['category']): string {
  switch (category) {
    case 'AGENT_REPORTED':
      return 'reported';
    case 'VIEWTRACE_OBSERVED':
      return 'observed';
    case 'VIEWTRACE_INFERRED':
      return 'inferred';
  }
}

function snippetOf(event: ViewTraceEvent): string {
  const payload = event.payload;
  switch (payload.type) {
    case 'SEARCH':
      return `"${sanitizeForTerminal(payload.query, 120)}" · ${payload.results.length} result(s)`;
    case 'READ':
      return `${payload.sourceId} · ${payload.outcome}`;
    case 'CLAIM':
      return sanitizeForTerminal(payload.text, 140);
    case 'COMPARE':
      return `${payload.candidates.join(' vs ')} · ${payload.cells.length} cells`;
    case 'HYPOTHESIS':
      return sanitizeForTerminal(payload.text, 140);
    case 'CONTRADICTION':
      return sanitizeForTerminal(payload.description, 140);
    case 'VERIFY':
      return `${sanitizeForTerminal(payload.method, 80)} → ${payload.result}`;
    case 'RECOMMEND':
      return `→ ${sanitizeForTerminal(payload.choice, 120)}`;
  }
}

export function formatEventLine(event: ViewTraceEvent): string {
  return `[${clock()}] ${DISPLAY_NAMES[event.type].padEnd(11)} ${snippetOf(event)} (${provenanceLabel(event.provenance.category)})`;
}

export function formatRunLine(lifecycle: RunLifecycle, detail?: string): string {
  return `[${clock()}] RUN         ${lifecycle}${detail !== undefined && detail.length > 0 ? ` — ${sanitizeForTerminal(detail, 120)}` : ''}`;
}

export function formatChatter(text: string): string {
  return `[${clock()}] · chatter   (not an event) ${sanitizeForTerminal(text, 120)}`;
}

export function formatRejected(code: string): string {
  return `[${clock()}] · rejected  record failed validation (${code}); counted as a loss of input`;
}

export function formatWarning(diagnostic: Pick<Diagnostic, 'code' | 'message'>): string {
  return `[${clock()}] · warn      ${diagnostic.code}: ${sanitizeForTerminal(diagnostic.message, 160)}`;
}

export function formatLoss(loss: Pick<LossRecord, 'code' | 'lineIndex'>): string {
  return `[${clock()}] · loss      ${loss.code} at input line ${loss.lineIndex}`;
}

/** Structured activity record for `run --json` (one JSON object per line). */
export function activityJson(event: ViewTraceEvent): unknown {
  return {
    type: 'activity',
    at: new Date().toISOString(),
    kind: 'event',
    eventId: event.eventId,
    eventType: event.type,
    display: DISPLAY_NAMES[event.type],
    provenance: provenanceLabel(event.provenance.category),
    snippet: snippetOf(event),
  };
}

export function runTransitionJson(lifecycle: RunLifecycle, detail?: string): unknown {
  return {
    type: 'activity',
    at: new Date().toISOString(),
    kind: 'run',
    lifecycle,
    detail,
  };
}
