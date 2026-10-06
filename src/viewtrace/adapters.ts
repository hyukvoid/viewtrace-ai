/**
 * ViewTrace adapter interface and capability matrix (M0 foundation).
 *
 * Honesty rule (docs/MILESTONES.md §5/§10): a capability is YES only when a
 * verified fixture exists for it. The reference JSONL adapter is the only
 * executable adapter in M0; real agent adapters (Codex, Claude Code) are
 * listed as PLANNED with UNKNOWN capabilities — their existing *coding* log
 * parsers are NOT research-support evidence.
 */

import type { DomainEventType } from './types.js';
import { DOMAIN_EVENT_TYPES } from './types.js';

export type SupportLevel = 'YES' | 'PARTIAL' | 'NO' | 'UNKNOWN';

export interface AdapterCapability {
  readonly adapterId: string;
  readonly label: string;
  readonly version: string;
  readonly status: 'REFERENCE' | 'PLANNED';
  readonly events: Readonly<Record<DomainEventType, SupportLevel>>;
  readonly sourceAnchor: SupportLevel;
  readonly provenance: SupportLevel;
  readonly liveIngest: SupportLevel;
  readonly completion: SupportLevel;
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

export const ADAPTER_CAPABILITIES: readonly AdapterCapability[] = [
  {
    adapterId: REFERENCE_ADAPTER_ID,
    label: 'ViewTrace reference JSONL',
    version: '1.0.0',
    status: 'REFERENCE',
    events: ALL_YES,
    sourceAnchor: 'YES',
    provenance: 'YES',
    liveIngest: 'NO',
    completion: 'YES',
    limitations: [
      'Batch file ingest only; live collection lands in M1',
      'Reference format for contract verification, not a real agent adapter',
      'Provenance labels are preserved as claimed; ViewTrace never verifies or promotes them',
    ],
  },
  {
    adapterId: 'codex',
    label: 'Codex (research events)',
    version: '0.0.0',
    status: 'PLANNED',
    events: ALL_UNKNOWN,
    sourceAnchor: 'UNKNOWN',
    provenance: 'UNKNOWN',
    liveIngest: 'NO',
    completion: 'UNKNOWN',
    limitations: [
      'Not implemented; research mapping is M5 scope',
      'Existing coding-log support in agent-pigeon is not research-support evidence',
    ],
  },
  {
    adapterId: 'claude-code',
    label: 'Claude Code (research events)',
    version: '0.0.0',
    status: 'PLANNED',
    events: ALL_UNKNOWN,
    sourceAnchor: 'UNKNOWN',
    provenance: 'UNKNOWN',
    liveIngest: 'NO',
    completion: 'UNKNOWN',
    limitations: [
      'Not implemented; research mapping is M5 scope',
      'Existing coding-log support in agent-pigeon is not research-support evidence',
    ],
  },
];

export function listAdapters(): readonly AdapterCapability[] {
  return ADAPTER_CAPABILITIES;
}

export function getAdapter(adapterId: string): AdapterCapability | null {
  return ADAPTER_CAPABILITIES.find((a) => a.adapterId === adapterId) ?? null;
}

export function isSupportedAdapter(adapterId: string): boolean {
  const adapter = getAdapter(adapterId);
  return adapter !== null && adapter.status === 'REFERENCE';
}
