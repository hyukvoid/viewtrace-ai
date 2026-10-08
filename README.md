# Agent Pigeon

> **ViewTrace AI is under construction on top of this repository.** The new
> `viewtrace` bin traces the
> evidence behind AI answers for research/comparison/recommendation runs.
> Status is honest and early: batch ingest **and live collection** of the
> reference JSONL format are implemented and tested — `viewtrace up` starts
> the local collector, `viewtrace run -- <producer>` wraps a reference
> producer and shows activity live, `status`/`runs`/`replay` report the
> honest state. Final public receipts, safe answer resolution, a recent
> picker and the answer-first loopback report are implemented. The shared
> evidence analyzer supplies seven mode lenses, claim/evidence relationships,
> source provenance and unresolved areas for CLI and Web inspection. Codex exec
> JSON and Claude Code stream JSON now have **partial, version-specific**
> research adapters (`viewtrace adapters --json` lists capabilities and limits).
> Requires Node >= 22.13 (built-in `node:sqlite`).
>
> - **Local-only.** Everything ViewTrace records lives under one data root
>   (default `~/.viewtrace`); the runtime makes zero external network
>   requests — no cloud, accounts, telemetry or API keys. An explicitly launched
>   external agent uses its own authentication and network. The collector's
>   control channel binds `127.0.0.1` only and requires a per-process token.
> - **Original agent history files are read-only inputs** and are never
>   modified. ViewTrace's own recordings are local writes under the data
>   root (SQLite `viewtrace.db`, per-run `trace.jsonl` and a sanitized live
>   spool, mode 0700/0600 on POSIX). Explicit delete/keep/prune commands
>   control individual runs; default retention is indefinite. Delete the data root to erase
>   everything ViewTrace recorded.
> - **Private reasoning is never collected.** Declared thinking/analysis
>   payloads are stripped before anything touches disk; provenance labels
>   (agent-reported / observed / inferred) are preserved exactly as claimed,
>   never promoted.
> - The legacy `agent-pigeon` flight recorder below is unchanged.

## ViewTrace: Answer → Curiosity → Reveal

Receive an answer normally. When you want to inspect its basis, run bare
`viewtrace` with a saved receipt context, or choose the answer explicitly in
the recent picker. Reading the trace is optional; capture still requires
`viewtrace run` or an explicitly supported integration.

Asking an AI “why?” produces another answer. ViewTrace opens the **stored
evidence trail for the selected answer**: recorded claims, source anchors,
public events and missing evidence. It does not generate another rationale.
The report follows **Answer → Evidence → Process → Raw**. Association,
collection completeness, evidence support and unresolved areas remain visible.

The reference adapter demonstrates the full event contract. This demo reads
a synthetic multi-turn fixture:

```sh
viewtrace up
viewtrace ingest fixtures/viewtrace/answer-multi-turn.jsonl
viewtrace --agent reference-agent --session session-1 --turn turn-2 --url-only
# http://127.0.0.1:7331/runs/receipt-multi/answers/A2
viewtrace --receipt receipt-A1 --url-only
viewtrace --url-only                     # recent answer/trace picker
viewtrace --select receipt-A3 --url-only  # records explicit user selection
viewtrace open latest --url-only         # run exploration; association UNKNOWN
viewtrace analyze receipt-multi --answer A2
viewtrace analyze receipt-multi --answer A2 --mode COMPARE
viewtrace analyze receipt-multi --answer A2 --json
viewtrace monitor receipt-multi --answer A2  # optional live exploration tree
viewtrace keep receipt-multi
viewtrace keep receipt-multi --release
viewtrace prune --before 2026-10-01T00:00:00Z
viewtrace delete receipt-multi           # all answers + exports + artifacts
viewtrace down
```

Capture actual agents with their public JSON output enabled:

```sh
viewtrace up
viewtrace run --adapter codex -- codex exec --json "Research a public source"
viewtrace run --adapter claude-code -- claude -p --output-format stream-json --verbose "Research a public source"
viewtrace --receipt <receipt-id-printed-by-capture> --url-only
viewtrace --url-only
# Read native JSON output without changing the original file:
viewtrace ingest public-output.jsonl --adapter codex --agent-version 0.160.1
```

Native adapters map public SEARCH/READ results and an opaque final CLAIM.
They do not infer COMPARE, VERIFY or other research events from prose.
Missing results, unsupported tools, nested-agent output, version drift and
missing turn boundaries remain diagnostic gaps. Private thinking, prompts,
native debug metadata and native stderr are excluded before disk.

| Capture path | Verified native version | Real agent execution verified locally | Answer association |
| --- | --- | --- | --- |
| `codex exec --json` wrapper | 0.160.1 | Linux x64 on WSL2 | Explicit receipt; session alone uses picker |
| Claude `-p --output-format stream-json --verbose` wrapper | 2.1.121 | Windows x64 executable through WSL2, Linux capture host | Explicit receipt; session alone uses picker |
| Claude project hooks | 2.1.121 | Windows executable through explicit WSL option, Linux capture host | Explicit receipt; session alone uses picker |

Both observed native protocols supply session identity but omit provider
turn identity. ViewTrace never invents it. Other versions remain partial
until independently verified. ZCode/OpenCode research capture is unavailable;
their legacy coding support below does not establish research support.

For direct Claude launches, install project hooks explicitly:

```sh
viewtrace capture install --adapter claude-code --project .
viewtrace up
claude --settings .viewtrace/claude.settings.json
viewtrace capture uninstall --adapter claude-code --project .
```

Installation owns only `.viewtrace/claude.settings.json`, its launcher and
manifest. Existing `.claude` configuration/history stays byte-identical.
Removal refuses modified owned files to preserve user edits. Windows Claude
invoked from WSL requires `--windows-agent-on-wsl` during installation.
Launch from the installed project and start the collector before capture.
Direct Codex launches require the wrapper; they are not intercepted.

The release matrix targets Ubuntu x64, Windows x64, macOS ARM64 and macOS
Intel with Node 22.13.0, 22 and 24. CI verifies sanitized native replay,
clean offline tarball installation, installed CLI and Chromium reports,
permissions, Unicode/space paths and real-console Ctrl+C. Real-model live
verification is limited to the local invocation/OS rows above. No agent
credentials are copied to CI. Windows `.cmd`/`.bat` arguments containing
`%`, `!` or newlines are refused; invoke a JS entrypoint with `node` when
those literals are needed. UNC history files are readable; SQLite data roots
must be on a local drive. Windows files inherit the containing directory ACL.

Use `--data-root <dir>` on commands to isolate local recordings. `up` starts
both collector and report; the default report port is 7331. An occupied port
fails startup; ViewTrace never connects to the occupying service. Explicit
`up --report-port 0` uses an OS-assigned port for isolated roots. `status --json`
reports the ready URL. Bare reveal never starts capture or installs hooks.

Resolution is agent namespace + session + turn, then explicit receipt ID,
with a versioned answer hash as corroboration only. Supplied identifiers must
all agree. Repeated/revised final answers for a turn, conflicts, missing
identity or unknown scope go to a picker. Hash, cwd, latest and timestamps
never prove a current-answer match. Missing/deleted answers never fall back
to another answer. A user's selection is displayed as `explicit-selection`;
a direct saved link is `explicit-link`, with current-answer match UNKNOWN.
These describe local navigation, not verified factual support.

The report shows the stored answer, receipt, explicit own/shared event scope,
lifecycle, collection completeness and analyzer support. Choose EXPLAIN,
COMPARE, DECIDE, ASSESS, VERIFY, IDEATE or UNKNOWN as a lens over the same
answer and evidence. A lens override changes presentation, never support.
Follow a claim through its evidence card, recorded source and sanitized event
inspector, or inspect the exploration graph and source/freshness ledger.
Missing comparison rationale, unresolved conflicts, unavailable checkpoint
evaluations and unknown source dates stay explicit. JEV is advisory and does
not increase factual support. `obs / rep / inf / ?` distinguish provenance and
missing information; producer provenance labels remain claims.

Polling every 2 seconds keeps the same answer identity, marks an unreachable
snapshot STALE, retries and deduplicates event pages. Raw events are paginated;
private reasoning and credentials are excluded. Source URLs are never fetched
automatically; a safe external source link opens only on an explicit click.

Non-TTY and headless use URL-only/text or `--json` candidates, including an
explicit `--select` path. Interactive TTY has a numbered picker and Enter to
cancel. Browser launch uses argv without a shell; failure leaves the safe URL.
See [the reference receipt and HTTP contract](docs/viewtrace-reveal.md).

For development, run `npm ci` and `npx playwright install --with-deps chromium`
before `npm test`. Chromium is required for the DOM tests; Playwright is a
pinned development dependency and is not needed by the installed public bin.

**A flight recorder for coding agents.**

See what your coding agents changed, where they failed, how they recovered,
and **which one needs attention right now** — in one local UI, no matter
which coding tool produced the session.

![Flight Recorder UI](docs/ui/flight-recorder-timeline.png)

**Local-first · Read-only · No account · No telemetry · Nothing uploaded**

## The radar

The first screen is a problem-first live radar, not a dashboard. It answers
one question in three seconds: *which agent needs attention right now?*

```
NEEDS ATTENTION 2

  BLOCKED · PROVIDER/QUOTA        last observed 8m ago
  GameProbe — Claude Code
  Provider issue — quota exceeded

  RECOVERY IN PROGRESS            last observed 31s ago
  MA Now — Codex
  npm test failed — 4 tests failing

ALL CLEAR 3
  ● running   Agent Pigeon   zcode   last observed: ran npm test
  idle 7m     Trading Bench  codex   last observed: tests passed
```

Ranking is by attention, never by activity. And the radar does not lie
about state: RUNNING appears only when the session file is provably live,
and a session without a completion record is "idle 7m" — never "DONE".

![Live Radar](docs/ui/live-radar.png)

## What it does

A one-hour agent session produces thousands of log lines. Agent Pigeon turns
them into an answer to two questions: **what happened, and where did it go
wrong?**

- **Timeline** — the session's chronology: files read and changed, commands
  run, tests and builds with their outcomes, all time-stamped.
- **Problems & Recovery** — every test failure, build failure, non-zero
  command and agent error, chained to what the agent did next and to the
  signal that proves recovery (same tests passing, same command succeeding).
- **Show only the mess** — one toggle that hides routine operations and
  leaves only failures, retries and recovery work. *"327 routine operations
  hidden. Problems: 4."*
- **Agent Graph** — parent/child structure for parallel agents (main →
  research / backend / tests), with status, duration and task per agent.
- **Files Touched** — every file the session created, changed or deleted,
  by which agent, and whether it was involved in a failure or recovery.
- **Live sessions** — sessions currently being written show as ● Running and
  update while the agent works.

Everything is derived from observable evidence in your local logs — tool
calls, commands, exit codes, test results. Agent Pigeon never guesses what
an agent "thought" and never sends your code anywhere.

## Supported agents

Support levels are honest: an adapter is only marked FULL when its format
maps losslessly, and the UI never claims more than the capability matrix
allows.

| Agent | Level | Live activity | Explicit completion | Test outcomes | File events | Subagents |
| --- | --- | --- | --- | --- | --- | --- |
| Pigeon JSONL | **FULL** | YES | YES | YES | YES | YES |
| Codex | **PARTIAL** | YES | UNKNOWN | YES | YES | NO |
| Claude Code | **PARTIAL** | PARTIAL | NO | YES | YES | PARTIAL |
| ZCode | **EXPERIMENTAL** | EXPERIMENTAL | UNKNOWN | PARTIAL | YES | PARTIAL |
| OpenCode | UNAVAILABLE | — | — | — | — | — |

Notes: Codex rollouts carry no subagent records and report outcomes via exit
codes. Claude Code sessions have no explicit end record (the radar shows
"idle Nm", never DONE) and sidechain subagents are grouped under one agent.
ZCode support reads the model-io rollout debug log, which may change between
versions. OpenCode: no local session storage was found to verify a format
against — no adapter was guessed.

## Quick start

Requires **Node.js ≥ 22.13** for this package.

```bash
npm install -g agent-pigeon

# Launch the Flight Recorder UI (http://127.0.0.1:7676)
agent-pigeon ui
```

The UI opens on the live radar: blocked, failed and recovering sessions
first, healthy ones below. It automatically discovers sessions from Claude
Code, Codex and ZCode local history, plus any directory you pass with
`--dir <path>`. Click a card for the full flight record — timeline, problems
& recovery, agent graph, files touched. Sessions still being written refresh
live.

![Problems & Recovery](docs/ui/flight-recorder-problems.png)

## CLI

```bash
agent-pigeon ui                    # standalone local web UI
agent-pigeon session <file>        # terminal overview for one session file
agent-pigeon flight                # report for the latest coding session
agent-pigeon compare <A> <B>       # side-by-side comparison of two sessions
agent-pigeon replay                # corpus-wide history analysis
agent-pigeon share flight          # SVG card on stdout
```

Every command is read-only: Agent Pigeon reads your local session files,
computes in memory, and prints. It creates nothing, stores nothing, and
sends nothing.

## The Pigeon Event Format

Any coding tool can participate by appending JSON lines:

```jsonl
{"id":"e1","sessionId":"s1","agentId":"main","type":"SESSION_STARTED","timestamp":"2026-09-24T09:00:00.000Z","source":"my-tool"}
{"id":"e2","sessionId":"s1","agentId":"main","type":"FILE_CHANGED","timestamp":"2026-09-24T09:00:30.000Z","filePath":"src/api.ts"}
{"id":"e3","sessionId":"s1","agentId":"main","type":"TEST_FAILED","timestamp":"2026-09-24T09:01:10.000Z","command":"npm test","status":"error","error":"4 tests failed","metadata":{"testsFailedCount":4}}
{"id":"e4","sessionId":"s1","agentId":"main","type":"TEST_PASSED","timestamp":"2026-09-24T09:02:30.000Z","command":"npm test","status":"ok"}
{"id":"e5","sessionId":"s1","agentId":"main","type":"SESSION_COMPLETED","timestamp":"2026-09-24T09:03:00.000Z","metadata":{"outcome":"success"}}
```

Event types cover the session lifecycle, agent and subagent start/complete
(parent links via `parentAgentId`), messages, tool calls and results, file
read/create/change/delete, command/test/build start and outcome, errors and
checkpoints — each with `id`, `sessionId`, `agentId`, `timestamp`,
`status`, `summary`, and optional `filePath`, `command`, `exitCode`,
`durationMs`, `metadata`. Corrupted lines are skipped, never fatal — see
[`src/pigeon/types.ts`](src/pigeon/types.ts) for the full model and
[`fixtures/pigeon/`](fixtures/pigeon) for complete example sessions.

## How recovery detection works

Deterministic heuristics over evidence — no AI inference:

- A `TEST_FAILED` followed later by `TEST_PASSED` (in the same agent family)
  is **RECOVERED**; the actions in between (files inspected, files changed,
  commands rerun) become the failure's follow-up chain.
- A failed command recovered only when the **same command** later succeeds —
  a different command succeeding proves nothing.
- Weaker correlations (e.g. an error followed by an unrelated green build)
  are shown as **POSSIBLY_RECOVERED**, never overstated. Failures with no
  positive signal are **UNRESOLVED**; while a session is live they are
  **PENDING**.

## Architecture

```
   Coding agents & tools
   Codex · Claude Code · ZCode · your tool (pigeon.jsonl)
                 │
             Adapters  (per-format parsers → one event model)
                 ▼
        Pigeon Event Format
                 │
         Session Processor  (timeline · agent graph · files ·
                 │           failure & recovery detection)
                 ▼
   Independent local UI  (agent-pigeon ui — localhost, zero-dep)
        plus the read-only CLI (session · flight · compare · replay)
```

Core (`src/pigeon/`, `src/adapters/`) knows nothing about HTTP or any editor;
`src/ui/` is a thin, removable boundary. IDE extensions (VS Code, Zed) are
optional future integrations, not the product.

## Privacy

- Local-first by construction: the UI binds to `127.0.0.1` only; there is
  no server, no sync, no telemetry, and no network access at all.
- Read-only over your local agent history (`~/.claude/projects`,
  `~/.codex/sessions`, `~/.zcode/cli/rollout`, plus dirs you pass).
- The UI shows display-safe paths (repo-relative or last segments) and short
  error identities — not file contents, not prompts.
- Nothing is written: no cache, no state, no database.

Agent Pigeon is an independent local tool and does not require or configure
PigeonHub.

## Development

```bash
npm install
npm test        # build + unit tests (core, adapters, processor, server, perf)
npm run ui      # build + launch the local UI
```

The test suite covers event validation, ordering, parent/child agents,
failure and recovery detection, the "problems-only" view, all adapters
(including corrupted-line handling and a 10k-event performance budget), and
the UI server endpoints. Performance: 100 / 1,000 / 10,000-event sessions
process in ~2 / ~6 / ~50 ms respectively.

Windows is tested; macOS and Linux are untested for the 0.2 UI.

## License

MIT
