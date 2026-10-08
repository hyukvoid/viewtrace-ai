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

## ViewTrace AI — local storage, loopback-only collector and report, zero external network

ViewTrace (`viewtrace` bin) is a **local-write,
zero-external-network** product. Its inputs and outputs are strictly
separated:

- **Reads:** reference or explicitly selected native public JSONL files, read-only. Original
  agent history files are inputs only and are never modified (tests verify
  checksums stay unchanged). The live wrapper (`viewtrace run`) spawns the
  producer you name with literal executable arguments. Windows `.cmd`/`.bat`
  launchers use `cmd.exe` with escaping; `%`, `!` and newline arguments are
  refused. Invoke the JavaScript entrypoint with Node for those literals.
  Native capture accepts only known public tool/result/final-answer fields;
  it discards prompts, private thinking, unknown packet bodies and native
  stderr before spooling. Unknown format/tool/version records produce fixed
  diagnostic codes, never raw packet excerpts.
- **Writes:** only inside one data root (default `~/.viewtrace`, override with
  `--data-root` or `VIEWTRACE_DATA_ROOT`):
  - `viewtrace.db` — the authoritative SQLite store (schema version 2,
    migrated transactionally; future versions are refused, never guessed)
  - `runs/<runId>/trace.jsonl` — a derived, minimized replay export
  - `live/<runId>/stream.jsonl` — the live spool: producer stdout already
    sanitized (declared private-reasoning fields are stripped *before* the
    bytes are written; they never exist at rest)
  - `service.json`, `service.lock` — collector state: loopback port, random
    per-process token (mode 0600; the token never appears in URLs or logs)
  - `logs/service.log` — collector log (events and errors only, no tokens,
    no record content)
  - `evidence/`, `artifacts/` — local incremental analysis reports/state and
    advisory JEV checkpoints, with the same private-field/credential boundary
- **Explicit project integration:** `capture install --adapter claude-code`
  creates only owned `.viewtrace` settings, launcher and manifest in the
  selected project. Existing `.claude` settings and history are preserved.
  Hooks save minimized calls/state and public results under the selected data
  root; neither private thinking nor user prompts are persisted. Uninstall
  checks owned-file hashes and refuses modified files. No global agent settings
  or authentication are installed or copied. Hook launchers pin the installing
  Node runtime/package path; reinstall after moving or replacing that installation.
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
- **Report channel (M2):** IPv4 `127.0.0.1:7331` by default, with a separate
  per-process secret. An explicit alternate port is supported; conflicts fail
  startup. Every API read/mutation requires bearer authentication or a
  same-site HttpOnly session cookie issued by a guarded local HTML navigation.
  Host must match the actual bound port, Origin must match that Host, and
  cross-site Fetch Metadata is refused, including page/cookie bootstrap.
  Cookie mutations require same-origin Origin; CLI mutations use the bearer.
  No CORS. CSP disallows inline script, external assets and framing; text is
  rendered with textContent. Source links permit only http(s) without URL
  userinfo and require an explicit click. No source is fetched by ViewTrace.
  Body cap is 4 KiB, URLs 2 KiB, pages 1–100 events with a 1 MiB byte budget
  (one accepted record at most 1 MiB). Diagnostics/history are capped at 100
  with full counts. Static assets have a fixed allowlist and realpath/symlink
  checks. There are no arbitrary-path/SQL HTTP parameters. Errors are codes.
- **Deletion / data lifetime:** default retention is indefinite. Authenticated
  `delete <runId>` removes that run's receipts, scopes, selections, DB records,
  replay JSONL, spool and run-scoped evidence/artifacts; unrelated runs and
  original history are preserved. Active CREATED/RUNNING runs are refused.
  `keep` excludes a run from explicit `prune --before <ISO timestamp>`;
  explicit deletion still works for kept runs. A DB tombstone commits before
  filesystem cleanup; restart finishes cleanup, never resurrects receipts or
  reuses a deleted run ID. A cleanup failure stays an error. Remove the data
  root to erase everything including service logs and tombstones. SQLite
  deletion is logical deletion, not forensic secure erasure of device sectors.
- **Network:** zero external requests, ever — no cloud, no accounts, no
  telemetry, no API keys, no URL fetching. The only sockets the runtime
  opens are loopback connections to its own collector (verified by a
  network sentinel in the test suite; loopback uses are counted separately
  from violations). Source URLs found in traces are recorded values and are
  never fetched automatically. An explicitly launched external agent uses
  its own credentials and may make network requests independently of ViewTrace.
  The network-zero guarantee covers ViewTrace's collector, analyzer and report,
  not the external agent process.
- **What is stored:** validated trace records (research events, run
  lifecycle, provenance, sanitized source references), diagnostics and
  duplicate/conflict records. Declared private-reasoning fields
  (`thinking`, `reasoning`, `analysis`, encrypted content, …) are stripped
  before anything is stored, spooled or echoed; diagnostic messages carry
  codes and positions, never record content. Declared credential fields and
  recognizable token/credential/URL query forms are redacted before storage
  and receipt hashing. This is not a guarantee that arbitrary allowed free
  text contains no personal information. Reference producers must emit only
  public final answers and allowed tool records, not hidden reasoning.
  Receipt v1 hashes normalized sanitized final text (NFC and LF, SHA-256;
  whitespace/case otherwise preserved). Original secrets are never copied
  just for hash corroboration. Draft answers are rejected. Hash alone cannot
  establish exact answer identity.
- **SQLite driver:** Node's built-in `node:sqlite` (requires Node >= 22.13).
  No native addon, no third-party runtime dependency, no install scripts.
  All SQL uses parameter binding; the database is never deleted implicitly.
  Store/asset paths reject symlinks and junctions inside their local root.
  UNC/network SQLite data roots are refused; native history on UNC shares
  remains a read-only input. Existing read-only POSIX roots are not made writable.
  The collector service owns HTTP mutations; CLI queries open read-only
  connections and never run recovery.

## Reporting a vulnerability

Open a GitHub issue at <https://github.com/hyukvoid/agent-pigeon/issues>
marked `security`, or contact the repository owner privately through GitHub.
Please do not disclose publicly until a fix is available.
