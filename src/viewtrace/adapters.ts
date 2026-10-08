/**
 * ViewTrace adapter interface and verified research capability matrix.
 * Native support covers only the recorded public formats/invocations.
 * Legacy coding parsers do not establish research or receipt support.
 */

import type { DomainEventType } from './types.js';
import { DOMAIN_EVENT_TYPES } from './types.js';

export type SupportLevel = 'YES' | 'PARTIAL' | 'NO' | 'UNKNOWN';

export interface AdapterCapability {
  readonly adapterId: string;
  readonly label: string;
  readonly version: string;
  readonly status: 'REFERENCE' | 'SUPPORTED' | 'EXPERIMENTAL' | 'UNAVAILABLE' | 'PLANNED';
  readonly events: Readonly<Record<DomainEventType, SupportLevel>>;
  readonly sourceAnchor: SupportLevel;
  readonly provenance: SupportLevel;
  readonly liveIngest: SupportLevel;
  readonly completion: SupportLevel;
  readonly finalAnswerCapture: SupportLevel;
  readonly sessionTurnIdentity: SupportLevel;
  readonly exactAssociation: SupportLevel;
  readonly invocations?: readonly { command: string; versions: readonly string[]; realLiveOs: readonly string[]; transportOs: readonly string[] }[];
  readonly limitations: readonly string[];
}

const ALL_YES = Object.fromEntries(DOMAIN_EVENT_TYPES.map((t) => [t, 'YES'])) as Record<
  DomainEventType,
  SupportLevel
>;
const ALL_UNKNOWN = Object.fromEntries(DOMAIN_EVENT_TYPES.map((t) => [t, 'UNKNOWN'])) as Record<
  DomainEventType,
  SupportLevel
>;

export const REFERENCE_ADAPTER_ID = 'viewtrace-reference-jsonl';
const NATIVE_EVENTS: Record<DomainEventType, SupportLevel> = {
  ...ALL_UNKNOWN, SEARCH: 'PARTIAL', READ: 'PARTIAL', CLAIM: 'PARTIAL',
  COMPARE: 'NO', HYPOTHESIS: 'NO', CONTRADICTION: 'NO', VERIFY: 'NO', RECOMMEND: 'NO',
};

export const ADAPTER_CAPABILITIES: readonly AdapterCapability[] = [
  {
    adapterId: REFERENCE_ADAPTER_ID,
    label: 'ViewTrace reference JSONL',
    version: '1.2.0',
    status: 'REFERENCE',
    events: ALL_YES,
    sourceAnchor: 'YES',
    provenance: 'YES',
    liveIngest: 'YES',
    completion: 'YES',
    finalAnswerCapture: 'YES',
    sessionTurnIdentity: 'PARTIAL',
    exactAssociation: 'PARTIAL',
    limitations: [
      'Final public answers and explicit event scopes supported in v1.2; absent session/turn/scope remains UNKNOWN and uses picker',
      'Reference format for contract verification, not a real agent adapter',
      'Provenance labels are preserved as claimed; ViewTrace never verifies or promotes them',
    ],
  },
  {
    adapterId: 'codex',
    label: 'Codex public exec JSON',
    version: '1.0.0',
    status: 'SUPPORTED',
    events: NATIVE_EVENTS,
    sourceAnchor: 'PARTIAL',
    provenance: 'PARTIAL',
    liveIngest: 'PARTIAL',
    completion: 'PARTIAL',
    finalAnswerCapture: 'PARTIAL',
    sessionTurnIdentity: 'PARTIAL',
    exactAssociation: 'PARTIAL',
    invocations: [{ command: 'codex exec --json', versions: ['0.160.1'], realLiveOs: ['Linux x64 (WSL2)'], transportOs: [] }],
    limitations: [
      'Only native web_search search/open_page results and opaque public final claims are mapped; unsupported tools stay partial',
      'Final answer is gated on turn.completed; progress messages and private reasoning are excluded',
      'Exec has thread identity but no provider turnID; use explicit receipt or the picker. No automatic session-turn match',
      'Direct Codex launches are not intercepted; use the explicit wrapper. Other versions/OS live invocations remain unverified',
    ],
  },
  {
    adapterId: 'claude-code',
    label: 'Claude Code public stream JSON',
    version: '1.0.0',
    status: 'SUPPORTED',
    events: NATIVE_EVENTS,
    sourceAnchor: 'PARTIAL',
    provenance: 'PARTIAL',
    liveIngest: 'PARTIAL',
    completion: 'PARTIAL',
    finalAnswerCapture: 'PARTIAL',
    sessionTurnIdentity: 'PARTIAL',
    exactAssociation: 'PARTIAL',
    invocations: [
      { command: 'claude -p --output-format stream-json --verbose', versions: ['2.1.121'], realLiveOs: ['Windows x64 executable via WSL2; capture host Linux x64'], transportOs: [] },
      { command: 'claude --settings .viewtrace/claude.settings.json (project opt-in hooks)', versions: ['2.1.121'], realLiveOs: ['Windows x64 via explicit --windows-agent-on-wsl; capture host Linux x64'], transportOs: [] },
    ],
    limitations: [
      'WebSearch, WebFetch and Read are matched by tool_use_id; missing results and nested tools are diagnostic gaps',
      'Only a successful result packet creates a final receipt; is_error overrides a success subtype',
      'Session ID is retained, provider turnID is absent; receipt reveal is explicit and insufficient context uses the picker',
      'Only verified native versions/invocations are covered; no global agent configuration is modified',
    ],
  },
  { adapterId: 'zcode', label: 'ZCode research capture', version: '0.0.0', status: 'UNAVAILABLE',
    events: ALL_UNKNOWN, sourceAnchor: 'UNKNOWN', provenance: 'UNKNOWN', liveIngest: 'NO', completion: 'UNKNOWN',
    finalAnswerCapture: 'UNKNOWN', sessionTurnIdentity: 'UNKNOWN', exactAssociation: 'UNKNOWN',
    limitations: ['No verified native research/receipt fixtures; legacy coding parsers do not establish support'] },
  { adapterId: 'opencode', label: 'OpenCode research capture', version: '0.0.0', status: 'UNAVAILABLE',
    events: ALL_UNKNOWN, sourceAnchor: 'UNKNOWN', provenance: 'UNKNOWN', liveIngest: 'NO', completion: 'UNKNOWN',
    finalAnswerCapture: 'UNKNOWN', sessionTurnIdentity: 'UNKNOWN', exactAssociation: 'UNKNOWN',
    limitations: ['No verified native research/receipt fixtures or live invocation'] },
];

export function listAdapters(): readonly AdapterCapability[] {
  return ADAPTER_CAPABILITIES;
}

export function getAdapter(adapterId: string): AdapterCapability | null {
  return ADAPTER_CAPABILITIES.find((a) => a.adapterId === adapterId) ?? null;
}

export function isSupportedAdapter(adapterId: string): boolean {
  const adapter = getAdapter(adapterId);
  return adapter !== null && (adapter.status === 'REFERENCE' || adapter.status === 'SUPPORTED');
}
