# ViewTrace reference receipt and local reveal

Reference JSONL schema 1 adds `recordKind: "answer"`, independently versioned
by `receiptVersion: 1`. This represents only an explicitly finalized public
answer, never a streaming draft. Existing event/run records remain unchanged.
SQLite migrates v1 to v2 transactionally and preserves canonical legacy events.
Legacy runs without receipts are exploration containers with association UNKNOWN.

```json
{"recordKind":"answer","schemaVersion":1,"receiptVersion":1,"receiptId":"receipt-A1","runId":"receipt-multi","agentId":"reference-agent","agentSessionId":"session-1","turnId":"turn-1","answerId":"A1","answer":"Choose A.","final":true,"timestamp":"2026-10-07T01:00:01Z","occurredAt":"2026-10-07T01:00:01Z","adapterId":"viewtrace-reference-jsonl","adapterVersion":"1.2.0","questionSummary":"Which option?","eventIds":["e1"],"sharedEventIds":["shared"]}
```

The collector assigns sequence/receivedAt and computes `answerHash` and
`hashVersion: "sha256-sanitized-nfc-lf-v1"`. It redacts known credentials,
normalizes Unicode NFC and CRLF/CR to LF, then hashes UTF-8 with SHA-256.
It does not trim whitespace or case-fold. A supplied hash/version must agree
with this sanitized final text. No raw secret copy is stored. Final edits use
new answer/receipt IDs; multiple finals in one turn require explicit selection.

Session and turn are optional only when the producer lacks those identities;
missing identity lowers capability to PARTIAL. They are never synthesized.
`receiptId` is globally unique and `(runId, answerId)` is immutable. Duplicate
identical content is idempotent; conflicting content is quarantined and blocks
automatic resolution. `eventIds` defines own events; `sharedEventIds` defines
explicitly reused same-run events. Undefined own scope is UNKNOWN; an empty
list explicitly means no evidence. No event is filled from sequence/time
proximity. Missing events stay pending/UNKNOWN; foreign runs cannot satisfy
them. Overlapping own assignments between answers are UNKNOWN.

The resolver validates all supplied identifiers and returns:

| Status | Behavior |
| --- | --- |
| `matched` | Unique namespace/session/turn or explicit receipt, consistent fields and explicit scope |
| `uncertain` | No sufficient identity, repeated finals, hash alone, or unknown scope; picker |
| `missing` | Strong identity has no stored receipt/turn; picker or empty/missing notice |
| `mismatch` | Identifiers, receipt content or corroborating hash conflict; picker |

A failure of a stronger key never falls back to a weaker key. Explicit user
selection is recorded separately and never described as an automatic match.
The report's `explicit-link`/`explicit-selection` describes local navigation;
`currentAnswerMatch` remains UNKNOWN when no current client context is present.

The collector's `up/status/down` also controls the report server. Default bind
is IPv4 `127.0.0.1:7331`; `up --report-port 0` explicitly requests an isolated
ephemeral port. No wildcard, IPv6 or LAN bind exists. Readiness verifies the
collector pid/boot ID and the report's independent authenticated health.
Tokens never appear in URLs, logs, answer content or Raw.

| HTTP route | Purpose |
| --- | --- |
| `GET /health` | Authenticated report identity and readiness |
| `GET /api/runs?limit=50&offset=0` | Bounded run containers |
| `GET /api/runs/:runId` | Lifecycle/completeness/UNKNOWN support, diagnostics and revision |
| `GET /api/runs/:runId/events?limit=50&cursor=0` | Sanitized events in collector sequence |
| `GET /api/runs/:runId/answers/:answerId` | Saved final receipt and scope, status and revision |
| `GET /api/runs/:runId/answers/:answerId/events` | Same pagination, explicit answer scope only |
| `GET /api/runs/:runId/answers/:answerId/events?eventId=:id` | One sanitized inspector event; own/shared scope enforced, missing/out-of-scope 404 |
| `GET /api/runs/:runId/answers/:answerId/analysis?mode=...` | Authoritative M3 analysis; optional seven-mode lens override, same answer/evidence/support |
| `GET /api/receipts/:receiptId` | Receipt's bounded answer report |
| `GET /api/resolve?...` | Shared resolver; agentId/agentSessionId/turnId/receiptId/runId/answerId/answerHash/hashVersion |
| `GET /api/picker?limit=50&offset=0` | Recent answer/run candidates, honest missing identity and nextOffset |
| `GET /api/adapters` | Verified reference capability, real agents still PLANNED |
| `POST /api/select` | `{runId, receiptId?}`; records selection and returns a deep-link path |
| `POST /api/runs/:runId/keep` | `{keep: boolean}` |
| `DELETE /api/runs/:runId` | Explicit whole-run erasure, including receipts and derived artifacts |
| `POST /api/retention` | `{before: ISO timestamp}`; explicit pruning excluding kept/active runs |

Deep links are `/runs/:runId/answers/:answerId` and refresh never substitutes
latest. Selection links include a non-secret `selection` row ID; it is checked
against the target before labeling selection. Passing the same selection to
the event API preserves the report revision. Event cursors are the last
collector sequence, not offsets. Limits are 1–100, a page has a 1 MiB byte
budget, diagnostics/history display at most 100 with full counts.

Revisions are SHA-256 of canonical public report data, including scope and
diagnostics/status. Poll every 2 seconds using the same answer URL. On changed
revision, reset event pages; deduplicate by same-run event ID. On transient
failure keep the snapshot marked STALE and retry that identity; on 404 show
missing/deleted and a picker link. The UI performs no analysis or source fetch.

The answer-first report presents the stored answer before evidence, process
and sanitized Raw. The analyzer's support and input/state revisions are shown
separately from navigation association and transport freshness. Mode changes
use a transient analyzer projection; they preserve the receipt and evidence.
Claim/evidence/source buttons open a keyboard-accessible inspector over allowed
anchors. Graph relations retain their own provenance, including inferred
dashed edges with a text label. Source date absence remains UNKNOWN. Unresolved
conditions, references and conflicts remain visible even when process panels
are collapsed. Checkpoint JEV is advisory, with supportEffect NONE.

Retention is indefinite by default. Explicit delete commits a tombstone and
removes all receipt/index/selection rows in one transaction before removing
run-scoped files. Reopen completes interrupted erasure, and tombstones prevent
spool resurrection. Original input/history files and unrelated runs are not
deleted. Kept runs survive pruning, but may still be explicitly deleted.

Development verification requires Chromium: `npm ci`,
`npx playwright install --with-deps chromium`, `npm test`. The installed bin
requires no browser automation package. Windows/macOS deep OS/launcher/packed
browser checks are deferred to M5/final release audit, not claimed here.
