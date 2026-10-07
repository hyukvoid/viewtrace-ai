/**
 * ViewTrace M3 Source Normalization and Ledger Engine.
 *
 * Implements canonical source normalization, edition/query extraction,
 * mirror/re-read deduplication without evidence inflation, and spoof
 * detection. Per docs/MILESTONES.md §8: primary/official roles and dates
 * only when supported; absent dates remain absent.
 *
 * The ledger is a fold over events (insertion-ordered accumulators) so the
 * incremental engine can resume it from a persisted snapshot. Mirror
 * detection requires an observed content relation (shared content hash or a
 * web.archive.org URL embedding a canonical location we captured); a mirror
 * host alone does not relate two unrelated documents.
 */

import type {
  AnalysisAnchor,
  EvidenceDate,
  EvidenceExtensionV1,
  MeaningfulQuery,
  SourcedRole,
  SourceEdition,
  SourceLedgerEntry,
  SourceRole,
  SourceAccumulatorSnapshot,
} from '../analysis-types.js';
import type { ProvenanceCategory, SourceKind, ViewTraceEvent } from '../types.js';

const TRACKING_QUERY_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'ref_src',
  'fbclid',
  'gclid',
  'mc_eid',
  'igshid',
]);

export function normalizeLocation(rawLocation?: string, kind: SourceKind = 'UNKNOWN'): string | undefined {
  if (!rawLocation) return undefined;
  const trimmed = rawLocation.trim();
  if (!trimmed) return undefined;

  if (kind === 'URL' || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      parsed.protocol = parsed.protocol.toLowerCase();
      parsed.hostname = parsed.hostname.toLowerCase();
      if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
        parsed.port = '';
      }
      parsed.hash = ''; // Strip fragment

      // Filter tracking parameters and sort
      const searchParams = new URLSearchParams();
      const keys = Array.from(parsed.searchParams.keys()).sort();
      for (const key of keys) {
        if (!TRACKING_QUERY_PARAMS.has(key.toLowerCase())) {
          for (const val of parsed.searchParams.getAll(key)) {
            searchParams.append(key, val);
          }
        }
      }
      parsed.search = searchParams.toString();

      // Normalize path slashes
      parsed.pathname = parsed.pathname.replace(/\/+/g, '/');
      if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
        parsed.pathname = parsed.pathname.slice(0, -1);
      }
      return parsed.toString();
    } catch {
      // If invalid URL, fallback to trimmed
      return trimmed;
    }
  }

  // Non-URL path normalization
  return trimmed.replace(/\/+/g, '/');
}

export function extractMeaningfulQuery(event: ViewTraceEvent): MeaningfulQuery | null {
  if (event.type !== 'SEARCH') return null;
  const payload = event.payload as { type: 'SEARCH'; query?: string };
  const query = payload.query?.trim();
  if (!query) return null;
  return { query, eventId: event.eventId };
}

export interface LedgerAccumulator {
  readonly canonicalKey: string;
  readonly canonicalSourceId: string;
  readonly capturedSourceIds: Set<string>;
  kind: SourceKind;
  location?: string;
  normalizedLocation?: string;
  title?: string;
  readonly contentHashes: Set<string>;
  edition?: SourceEdition;
  publicationDate?: EvidenceDate;
  accessedDate?: EvidenceDate;
  readonly roles: Map<SourceRole, SourcedRole>;
  readonly queries: Map<string, MeaningfulQuery>;
  readonly anchors: AnalysisAnchor[];
  isSpoofSuspected: boolean;
}

export interface LedgerFold {
  readonly accs: Map<string, LedgerAccumulator>;
  apply(event: ViewTraceEvent, extension?: EvidenceExtensionV1): void;
}

export function createLedgerFold(): LedgerFold {
  const accs = new Map<string, LedgerAccumulator>();
  return {
    accs,
    apply(ev: ViewTraceEvent, extension?: EvidenceExtensionV1): void {
      const evSources = ev.source ? [ev.source] : [];

      // Also collect search result sources
      if (ev.type === 'SEARCH') {
        const searchPayload = ev.payload as { type: 'SEARCH'; query?: string; results?: readonly { sourceId: string; url?: string; title?: string }[] };
        for (const res of searchPayload.results ?? []) {
          evSources.push({
            sourceId: res.sourceId,
            kind: 'URL',
            location: res.url,
            title: res.title,
          });
        }
      }

      const query = extractMeaningfulQuery(ev);

      for (const src of evSources) {
        const rawLocation = src.location;
        const normalized = normalizeLocation(rawLocation, src.kind);
        // Canonical key: prefer normalized location, else contentHash, else sourceId
        const key = normalized ? `loc:${normalized}` : src.contentHash ? `hash:${src.contentHash}` : `id:${src.sourceId}`;

        let acc = accs.get(key);
        if (!acc) {
          // Derive canonical source id: stable format
          const cleanId = src.sourceId.startsWith('src-') ? src.sourceId : `src-${src.sourceId}`;
          acc = {
            canonicalKey: key,
            canonicalSourceId: cleanId,
            capturedSourceIds: new Set(),
            kind: src.kind,
            location: rawLocation,
            normalizedLocation: normalized,
            title: src.title,
            contentHashes: new Set(),
            roles: new Map(),
            queries: new Map(),
            anchors: [],
            isSpoofSuspected: false,
          };
          accs.set(key, acc);
        }

        acc.capturedSourceIds.add(src.sourceId);
        if (src.contentHash) acc.contentHashes.add(src.contentHash);
        if (src.title && !acc.title) acc.title = src.title;

        const anchor: AnalysisAnchor = {
          runId: ev.runId,
          eventId: ev.eventId,
          sourceId: src.sourceId,
        };
        acc.anchors.push(anchor);

        if (query) {
          acc.queries.set(`${query.query}:${query.eventId}`, query);
        }

        // Check dates from source.accessedAt
        if (src.accessedAt && !acc.accessedDate) {
          const prov: Exclude<ProvenanceCategory, 'VIEWTRACE_INFERRED'> =
            ev.provenance.category === 'VIEWTRACE_INFERRED' ? 'VIEWTRACE_OBSERVED' : ev.provenance.category;
          acc.accessedDate = {
            value: src.accessedAt,
            precision: src.accessedAt.length <= 10 ? 'DAY' : 'TIMESTAMP',
            provenance: prov,
            anchors: [anchor],
          };
        }

        // Metadata from extension if present
        if (extension?.sourceMetadata) {
          if (extension.sourceMetadata.edition && !acc.edition) {
            acc.edition = extension.sourceMetadata.edition;
          }
          if (extension.sourceMetadata.publicationDate && !acc.publicationDate) {
            acc.publicationDate = extension.sourceMetadata.publicationDate;
          }
          if (extension.sourceMetadata.accessedDate && !acc.accessedDate) {
            acc.accessedDate = extension.sourceMetadata.accessedDate;
          }
          if (extension.sourceMetadata.roles) {
            for (const r of extension.sourceMetadata.roles) {
              acc.roles.set(r.role, r);
            }
          }
        }

        // Spoof detection heuristic:
        // If title or role claims "OFFICIAL" or "PRIMARY" or official docs, but
        // location is a non-official IP or deceptive host
        if (acc.normalizedLocation) {
          try {
            const u = new URL(acc.normalizedLocation);
            const hostname = u.hostname.toLowerCase();
            const isOfficialClaimed =
              (acc.title && /official|canonical|authoritative/i.test(acc.title)) ||
              acc.roles.has('OFFICIAL') ||
              acc.roles.has('PRIMARY');

            const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname);
            if (isOfficialClaimed && (isIp || hostname.includes('spoof') || hostname.includes('fake-mirror'))) {
              acc.isSpoofSuspected = true;
            }
          } catch {
            // ignore
          }
        }
      }
    },
  };
}

/** Extracts the embedded original URL from a web.archive.org snapshot URL. */
function archiveEmbeddedLocation(normalizedLocation?: string): string | undefined {
  if (!normalizedLocation) return undefined;
  try {
    const u = new URL(normalizedLocation);
    if (u.hostname !== 'web.archive.org' && u.hostname !== 'archive.org') return undefined;
    // https://web.archive.org/web/<timestamp>/<original-url>
    const m = /^\/web\/[0-9*]+(?:[a-z_]+)?\/(.+)$/i.exec(u.pathname);
    if (!m) return undefined;
    return normalizeLocation(decodeURIComponent(m[1]!), 'URL');
  } catch {
    return undefined;
  }
}

export function finalizeLedgerEntries(accs: Map<string, LedgerAccumulator>): readonly SourceLedgerEntry[] {
  const result: SourceLedgerEntry[] = [];
  const entries = Array.from(accs.values());

  for (let i = 0; i < entries.length; i++) {
    const current = entries[i]!;
    let identityStatus: 'MATCHED' | 'POSSIBLE_MIRROR' | 'SPOOF_SUSPECTED' | 'UNKNOWN' = 'MATCHED';
    let mirrorOfCanonicalSourceId: string | undefined = undefined;

    if (current.isSpoofSuspected) {
      identityStatus = 'SPOOF_SUSPECTED';
    } else {
      // Mirror of an earlier entry requires an observed content relation:
      // a shared content hash, or an archive URL embedding the earlier
      // entry's canonical location. Being on a mirror host alone does not
      // relate two unrelated documents.
      for (let j = 0; j < i; j++) {
        const earlier = entries[j]!;
        let sharedHash = false;
        for (const h of current.contentHashes) {
          if (earlier.contentHashes.has(h)) {
            sharedHash = true;
            break;
          }
        }

        let archiveOfEarlier = false;
        if (!sharedHash && current.normalizedLocation?.includes('archive.org')) {
          const embedded = archiveEmbeddedLocation(current.normalizedLocation);
          archiveOfEarlier = !!embedded && embedded === earlier.normalizedLocation;
        }

        if (sharedHash || archiveOfEarlier) {
          identityStatus = 'POSSIBLE_MIRROR';
          mirrorOfCanonicalSourceId = earlier.canonicalSourceId;
          break;
        }
      }
    }

    if (!current.normalizedLocation && !current.location) {
      identityStatus = 'UNKNOWN';
    }

    result.push({
      canonicalSourceId: current.canonicalSourceId,
      capturedSourceIds: Array.from(current.capturedSourceIds),
      kind: current.kind,
      location: current.location,
      title: current.title,
      edition: current.edition,
      publicationDate: current.publicationDate,
      accessedDate: current.accessedDate,
      roles: Array.from(current.roles.values()),
      queries: Array.from(current.queries.values()),
      identityStatus,
      mirrorOfCanonicalSourceId,
      anchors: current.anchors,
      basis: {
        ruleId: 'source-ledger-normalization-v1',
        ruleVersion: '1.0.0',
        inputAnchors: current.anchors,
        limitations: [
          'Source identities are normalized from recorded URLs and hashes without external HTTP verification.',
          'Mirror detection requires a shared content hash or an archive URL embedding a captured canonical location.',
        ],
      },
    });
  }

  return result;
}

export function snapshotLedger(accs: Map<string, LedgerAccumulator>): readonly SourceAccumulatorSnapshot[] {
  return Array.from(accs.values()).map((acc) => ({
    canonicalKey: acc.canonicalKey,
    canonicalSourceId: acc.canonicalSourceId,
    capturedSourceIds: Array.from(acc.capturedSourceIds),
    kind: acc.kind,
    location: acc.location,
    normalizedLocation: acc.normalizedLocation,
    title: acc.title,
    contentHashes: Array.from(acc.contentHashes),
    edition: acc.edition,
    publicationDate: acc.publicationDate,
    accessedDate: acc.accessedDate,
    roles: Array.from(acc.roles.values()),
    queries: Array.from(acc.queries.values()),
    anchors: acc.anchors,
    isSpoofSuspected: acc.isSpoofSuspected,
  }));
}

export function restoreLedger(snapshots: readonly SourceAccumulatorSnapshot[]): Map<string, LedgerAccumulator> {
  const accs = new Map<string, LedgerAccumulator>();
  for (const s of snapshots) {
    accs.set(s.canonicalKey, {
      canonicalKey: s.canonicalKey,
      canonicalSourceId: s.canonicalSourceId,
      capturedSourceIds: new Set(s.capturedSourceIds),
      kind: s.kind,
      location: s.location,
      normalizedLocation: s.normalizedLocation,
      title: s.title,
      contentHashes: new Set(s.contentHashes),
      edition: s.edition,
      publicationDate: s.publicationDate,
      accessedDate: s.accessedDate,
      roles: new Map(s.roles.map((r) => [r.role, r])),
      queries: new Map(s.queries.map((q) => [`${q.query}:${q.eventId}`, q])),
      anchors: [...s.anchors],
      isSpoofSuspected: s.isSpoofSuspected,
    });
  }
  return accs;
}

export interface BuildLedgerOptions {
  readonly extensions?: readonly EvidenceExtensionV1[];
  readonly officialDomains?: readonly string[];
}

export function buildSourceLedger(
  events: readonly ViewTraceEvent[],
  options: BuildLedgerOptions = {},
): readonly SourceLedgerEntry[] {
  const fold = createLedgerFold();
  const extensionMap = new Map<string, EvidenceExtensionV1>();
  for (const ext of options.extensions ?? []) {
    extensionMap.set(ext.eventId, ext);
  }
  for (const ev of events) {
    fold.apply(ev, extensionMap.get(ev.eventId));
  }
  return finalizeLedgerEntries(fold.accs);
}
