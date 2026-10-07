# Changelog

## Unreleased — ViewTrace M2

- Final public AnswerReceipt v1, immutable finalization, sanitized versioned
  hashes, transactional SQLite v2 migration and explicit own/shared scope.
- Shared resolver, bare reveal/picker, explicit selection, safe URL-only
  reveal and latest-run exploration. Uncertain or conflicting identity never
  auto-matches by hash, latest, cwd or timestamp.
- Loopback report/API on 7331, paginated sanitized events, polling/stale
  recovery, Host/Origin/cookie/bearer/CSP boundaries, delete/keep/prune and
  tombstone recovery. Evidence analysis and real agent research adapters
  remain M3/M5 work.
- Mandatory actual HTTP/public-bin/Chromium DOM tests; no runtime dependencies.

## 0.3.0 — problem-first live radar

The first screen is no longer a session browser. It answers one question in
three seconds: **which coding agent needs attention right now?**

- **LIVE RADAR** — sessions ranked by attention, not activity:
  1. BLOCKED (provider quota/auth, environment)
  2. FAILED (unresolved coding failure in an ended session)
  3. RECOVERY IN PROGRESS (live session with an active failure)
  4. RUNNING · HAD PROBLEMS
  5. RUNNING (healthy)
  6. IDLE
  Healthy sessions get one compact row; trouble gets the cards.
- **Last observed** replaces "current activity": the label always names the
  most recent observable action ("ran npm test · 31s ago"). RUNNING appears
  only when the session file is provably live; sessions without a completion
  record are "idle Nm" — never DONE.
- **Adapter capability matrix** (`ADAPTER_CAPABILITIES`, exposed via
  `/api/adapters`): what each format can prove — live activity, explicit
  completion, test outcomes, file events, subagents. The UI never claims
  more than the matrix allows.
- Initial radar payload is time-budgeted with recent sessions first
  (measured < 3 s over a 540-file real history; cached reloads ~10 ms).
- Zero new dependencies; still 127.0.0.1-only, read-only, no network.

## 0.2.0 — cross-tool flight recorder + standalone local UI

Agent Pigeon is no longer CLI-report-only and not tied to any IDE. One place
to see what your coding agents did — across tools.

- **`agent-pigeon ui`** — standalone local Flight Recorder web UI
  (http://127.0.0.1:7676, bound to localhost only, zero runtime
  dependencies). Session list with live "running" detection, timeline,
  Problems & Recovery, parallel Agent Graph, Files Touched, and the
  "Show only the mess" filter that hides routine operations.
- **Pigeon Event Format** (`src/pigeon/`) — a normalized event model every
  adapter emits: tool calls, file changes, commands, test/build outcomes,
  subagent spawns, errors — with a deterministic session processor that
  derives timeline, agent graph, per-file stats, failure chains and
  evidence-based recovery status (RECOVERED / POSSIBLY_RECOVERED /
  UNRESOLVED / PENDING).
- **Adapters**: Pigeon JSONL (FULL, reference format), Codex (PARTIAL —
  rollout parsing incl. embedded `apply_patch`, verification classification),
  Claude Code (PARTIAL — edits, reads, verification outcomes, sidechains),
  ZCode (EXPERIMENTAL — model-io rollout logs). OpenCode: UNAVAILABLE (no
  local storage found to verify a format against — no guessing).
- **`agent-pigeon session <file>`** — terminal flight-recorder overview for
  one session file of any supported format.
- Honest support levels: an adapter is only FULL/PARTIAL/EXPERIMENTAL when
  verified against real local logs; limitations are listed, never hidden.
- Failure taxonomy: problems are classified CODE / VALIDATION / TOOL /
  ENVIRONMENT / PROVIDER (auth · quota · rate-limit). Provider and
  environment failures never count as coding failures — a session stopped by
  an API quota error reports "Provider issue — quota exceeded" and a BLOCKED
  outcome, not "agent failed". Code-recovery heuristics apply only to
  coding failures (VALIDATION/CODE/TOOL).
- Product scope: pure-conversation sessions (no file/command/tool evidence)
  are listed separately under "Other sessions" — the default list is a
  coding-agent flight list.
- Performance: 10k-event sessions process in ~50ms; the UI lists huge
  histories progressively (time-budgeted) and throttles re-parsing of huge
  live session files.

## 0.1.2 — version output hotfix

- Fixed `--version` reporting the previous package version.
- No analysis, privacy, or report behavior changes.

## 0.1.1 — branding polish

- Added the Agent Pigeon pixel-art mascot, compact terminal dot pigeon, and refreshed README.
- No analysis or privacy behavior changes.

## 0.1.0 — local-analysis release candidate

Initial public-surface scope: **`agent-pigeon replay`**, plus `flight`,
`compare`, and `share` (SVG card on stdout).

- Parses local Claude Code (`~/.claude/projects`) and Codex
  (`~/.codex/sessions`) history, read-only. Replay creates no files and
  performs no network access.
- Turn-based attempt reconstruction (multi-edit model turns count as one
  implementation attempt, not N).
- Corrected verification classification, including package-manager script
  indirection (`npm run check` etc.); lint/format scripts deliberately do not
  count as recognized verification.
- Conservative reporting: recognized verification runs, unverified
  implementation stretches, and healthy fail→pass verification loops.
- `--json` machine-readable aggregate; history-directory overrides.

**Deliberately withheld** (researched; see `docs/research/`): live
VERIFY_FIRST governor (failed its behavioral dogfood — precision 0/6 — and is
preserved as experimental code), RETHINK, HUMAN_REVIEW, Jev semantic
evaluation.
