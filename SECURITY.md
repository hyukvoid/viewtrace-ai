# Security Policy

This repository ships two products with two data policies.

## Agent Pigeon (flight recorder) — local, read-only analysis

- **Reads:** Claude Code history (`~/.claude/projects/**/*.jsonl`) and Codex
  history (`~/.codex/sessions/**/*.jsonl`), read-only. Nothing else on your
  machine is read.
- **Writes:** nothing. `agent-pigeon replay` creates no files, stores no
  state, keeps no cache.
- **Network:** none. The replay path contains no network code.
- **Output:** aggregate counts, short session identifiers, confidence labels
  and turn counts. Source code, diffs, shell commands, prompts, reasoning and
  transcript text are **never** included in output.

## ViewTrace AI — local storage, loopback-only control, zero external network

ViewTrace (`viewtrace` bin, M1 — live CLI trace) is a **local-write,
zero-external-network** product. Its inputs and outputs are strictly
separated:

- **Reads:** reference JSONL trace files you point it at, read-only. Original
  agent history files are inputs only and are never modified (tests verify
  checksums stay unchanged). The live wrapper (`viewtrace run`) spawns the
  producer you name with its arguments passed verbatim — there is never a
  shell in between, so producer arguments cannot be interpolated.
- **Writes:** only inside one data root (default `~/.viewtrace`, override with
  `--data-root` or `VIEWTRACE_DATA_ROOT`):
  - `viewtrace.db` — the authoritative SQLite store (schema version 1,
    migrated transactionally; future versions are refused, never guessed)
  - `runs/<runId>/trace.jsonl` — a derived, minimized replay export
  - `live/<runId>/stream.jsonl` — the live spool: producer stdout already
    sanitized (declared private-reasoning fields are stripped *before* the
    bytes are written; they never exist at rest)
  - `service.json`, `service.lock` — collector state: loopback port, random
    per-process token (mode 0600; the token never appears in URLs or logs)
  - `logs/service.log` — collector log (events and errors only, no tokens,
    no record content)
  - `evidence/`, `artifacts/` — reserved for later milestones
- **Permissions:** data root and subdirectories 0700, files 0600 (POSIX); the
  collector service also sets umask 077. On Windows, POSIX permission bits do
  not apply; files inherit the containing directory's ACLs — treat the
  profile directory as the trust boundary.
- **Control channel (M1):** the collector serves an HTTP control API bound
  to IPv4 `127.0.0.1` only (never `0.0.0.0`/`::`/LAN). Every request — reads
  included — requires the per-process bearer token from `service.json`
  (timing-safe compare). The `Host` header must be exactly
  `127.0.0.1:<port>`/`localhost:<port>`; any `Origin` other than the same
  origin is refused with 403; no CORS headers are ever emitted; request
  bodies are capped at 4 KiB; errors are terse codes without paths or
  stacks. Shutdown (`viewtrace down`) goes through this authenticated API —
  the CLI never kills a pid blindly (PID reuse safety), and `down` only
  stops the collector it owns; committed events are preserved.
- **Deletion / data lifetime:** data lives until you delete it. Remove the
  data root directory to erase everything ViewTrace recorded (store, spools
  and logs together).
- **Network:** zero external requests, ever — no cloud, no accounts, no
  telemetry, no API keys, no URL fetching. The only sockets the runtime
  opens are loopback connections to its own collector (verified by a
  network sentinel in the test suite; loopback uses are counted separately
  from violations). Source URLs found in traces are recorded values and are
  never fetched automatically.
- **What is stored:** validated trace records (research events, run
  lifecycle, provenance, sanitized source references), diagnostics and
  duplicate/conflict records. Declared private-reasoning fields
  (`thinking`, `reasoning`, `analysis`, encrypted content, …) are stripped
  before anything is stored, spooled or echoed; diagnostic messages carry
  codes and positions, never record content. Free text that arrives through
  allowed fields is stored as-is — ViewTrace does not claim free text is
  safe based on keyword scanning.
- **SQLite driver:** Node's built-in `node:sqlite` (requires Node >= 22.13).
  No native addon, no third-party runtime dependency, no install scripts.
  All SQL uses parameter binding; the database is never deleted implicitly.
  The collector service is the single writer; CLI queries open read-only
  connections and never run recovery.

## Reporting a vulnerability

Open a GitHub issue at <https://github.com/hyukvoid/agent-pigeon/issues>
marked `security`, or contact the repository owner privately through GitHub.
Please do not disclose publicly until a fix is available.
