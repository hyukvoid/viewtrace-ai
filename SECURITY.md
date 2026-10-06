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

## ViewTrace AI — local storage, still zero network

ViewTrace (`viewtrace` bin, M0 foundation) is a **local-write, zero-network**
product. Its inputs and outputs are strictly separated:

- **Reads:** reference JSONL trace files you point it at, read-only. Original
  agent history files are inputs only and are never modified (tests verify
  checksums stay unchanged).
- **Writes:** only inside one data root (default `~/.viewtrace`, override with
  `--data-root` or `VIEWTRACE_DATA_ROOT`):
  - `viewtrace.db` — the authoritative SQLite store (schema version 1,
    migrated transactionally; future versions are refused, never guessed)
  - `runs/<runId>/trace.jsonl` — a derived, minimized replay export
  - `evidence/`, `artifacts/` — reserved for later milestones
- **Permissions:** data root and subdirectories 0700, database and trace
  files 0600 (POSIX). On Windows, POSIX permission bits do not apply; files
  inherit the containing directory's ACLs — treat the profile directory as
  the trust boundary.
- **Deletion / data lifetime:** data lives until you delete it. Remove the
  data root directory to erase everything ViewTrace recorded.
- **Network:** none, ever. The runtime performs zero external requests — no
  cloud, no accounts, no telemetry, no API keys, no URL fetching. Source URLs
  found in traces are recorded values and are never fetched automatically.
- **What is stored:** validated trace records (research events, run
  lifecycle, provenance, sanitized source references), diagnostics and
  duplicate/conflict records. Declared private-reasoning fields
  (`thinking`, `reasoning`, `analysis`, encrypted content, …) are stripped
  before anything is stored or echoed; diagnostic messages carry codes and
  positions, never record content. Free text that arrives through allowed
  fields is stored as-is — ViewTrace does not claim free text is safe based
  on keyword scanning.
- **SQLite driver:** Node's built-in `node:sqlite` (requires Node >= 22.13).
  No native addon, no third-party runtime dependency, no install scripts.
  All SQL uses parameter binding; the database is never deleted implicitly.

## Reporting a vulnerability

Open a GitHub issue at <https://github.com/hyukvoid/agent-pigeon/issues>
marked `security`, or contact the repository owner privately through GitHub.
Please do not disclose publicly until a fix is available.
