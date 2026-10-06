#!/usr/bin/env node
/**
 * viewtrace — CLI entry point for ViewTrace AI (M0 foundation scope).
 *
 * M0 provides: --help/--version, batch ingest of reference JSONL traces,
 * run listing, replay and the adapter capability matrix.
 * Live collection (up/run/status/down) lands in M1; the local report
 * server (open) lands in M2 — those commands explicitly report themselves
 * as not implemented instead of pretending.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { ingestFile } from './ingest.js';
import { ViewTraceStore } from './store.js';
import { listAdapters } from './adapters.js';

const PROGRAM = 'viewtrace';
const PRODUCT = 'ViewTrace AI';
const TAGLINE = 'Trace the evidence behind AI answers.';

const NOT_IMPLEMENTED: Readonly<Record<string, string>> = {
  up: 'live collector service (planned for M1)',
  down: 'collector shutdown (planned for M1)',
  status: 'collector status (planned for M1)',
  run: 'wrapped live agent runs (planned for M1)',
  open: 'local report server UI (planned for M2)',
};

const HELP = `${PRODUCT} — ${TAGLINE}

v0.1 traces the research evidence behind AI answers: what was searched,
read, claimed, compared, contradicted, verified and recommended — with the
provenance of every record kept honest (agent-reported / observed / inferred).

Privacy and storage:
  - Local-only. All data lives under the data root (default: ~/.viewtrace).
    ViewTrace makes ZERO external network requests — no cloud, no accounts,
    no telemetry, no API keys.
  - Original agent history files are read-only inputs and are never modified.
  - Private reasoning (thinking/analysis payloads) is never collected.
  - To delete everything ViewTrace recorded, remove the data root directory.

Commands:
  viewtrace ingest <file.jsonl> [--data-root <dir>] [--json]
      Validate a reference JSONL trace, store it in SQLite, then close,
      reopen and verify the replay is identical.
  viewtrace runs [--data-root <dir>] [--json]
      List stored runs with lifecycle and collection completeness.
  viewtrace replay <runId> [--data-root <dir>] [--json]
      Print the stored replay: canonical records, diagnostics, duplicates.
  viewtrace adapters [--json]
      Show the adapter capability matrix (honest YES/PARTIAL/NO/UNKNOWN).
  viewtrace --help | -h
      Show this help.
  viewtrace --version | -V
      Show the version.

not implemented yet (explicitly):
  viewtrace up       live collector service — planned for M1
  viewtrace down     collector shutdown — planned for M1
  viewtrace status   collector status — planned for M1
  viewtrace run      wrapped live agent runs — planned for M1
  viewtrace open     local report server — planned for M2

Compatibility: the legacy 'agent-pigeon' bin and its commands are unchanged.
`;

function resolveVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', '..', 'package.json'), // repo: dist/src/viewtrace/
    join(here, '..', 'package.json'), // packed: <pkg>/dist/src/viewtrace -> up 2 = <pkg>/dist? no
    join(here, '..', '..', 'package.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
        if (typeof pkg.version === 'string') return pkg.version;
      } catch {
        /* try next candidate */
      }
    }
  }
  return '0.0.0-unknown';
}

function defaultDataRoot(): string {
  const override = process.env['VIEWTRACE_DATA_ROOT'];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), '.viewtrace');
}

function usage(error?: string): number {
  if (error !== undefined) process.stderr.write(`${PROGRAM}: ${error}\n`);
  process.stderr.write(`Usage: ${PROGRAM} <command> [options] — try '${PROGRAM} --help'\n`);
  return 2;
}

interface CliArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--json') {
      flags.set('json', true);
      continue;
    }
    if (arg === '--data-root') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        process.stderr.write(`${PROGRAM}: --data-root requires a directory argument\n`);
        process.exit(2);
      }
      flags.set('data-root', next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      process.stderr.write(`${PROGRAM}: unknown option ${arg}\n`);
      process.exit(2);
    }
    positional.push(arg);
  }
  return { positional, flags };
}

function dataRootOf(flags: CliArgs['flags']): string {
  const value = flags.get('data-root');
  return typeof value === 'string' ? value : defaultDataRoot();
}

async function main(argv: readonly string[]): Promise<number> {
  const first = argv[0];

  if (argv.length === 0) return usage('no command given');
  if (first === '--help' || first === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  if (first === '--version' || first === '-V') {
    process.stdout.write(`${resolveVersion()}\n`);
    return 0;
  }

  const command = first as string;
  const rest = argv.slice(1);
  const notImplemented = NOT_IMPLEMENTED[command];
  if (notImplemented !== undefined) {
    process.stderr.write(
      `${PROGRAM}: '${command}' is not implemented yet (${notImplemented}). See '${PROGRAM} --help'.\n`,
    );
    return 3;
  }

  switch (command) {
    case 'adapters': {
      const args = parseArgs(rest);
      const adapters = listAdapters();
      if (args.flags.get('json') === true) {
        process.stdout.write(JSON.stringify(adapters, null, 2) + '\n');
        return 0;
      }
      for (const adapter of adapters) {
        process.stdout.write(
          `${adapter.adapterId} [${adapter.status}] v${adapter.version} — events:${summarizeEvents(adapter.events)} sourceAnchor:${adapter.sourceAnchor} provenance:${adapter.provenance} liveIngest:${adapter.liveIngest} completion:${adapter.completion}\n`,
        );
        for (const limitation of adapter.limitations) {
          process.stdout.write(`    - ${limitation}\n`);
        }
      }
      return 0;
    }

    case 'ingest': {
      const args = parseArgs(rest);
      const input = args.positional[0];
      if (input === undefined) return usage('ingest requires a trace file path');
      try {
        const outcome = await ingestFile(input, { dataRoot: dataRootOf(args.flags) });
        if (args.flags.get('json') === true) {
          process.stdout.write(JSON.stringify(outcome, null, 2) + '\n');
        } else {
          printIngest(outcome);
        }
        for (const err of outcome.jsonlWriteErrors) {
          process.stderr.write(
            `${PROGRAM}: warning: derived trace.jsonl write failed for run ${err.runId} (${err.message}); database is authoritative and the file will be re-derived on next open\n`,
          );
        }
        const unverified = outcome.replayChecks.filter((c) => !c.verified);
        if (unverified.length > 0) {
          for (const check of unverified) {
            process.stderr.write(`${PROGRAM}: replay verification FAILED for ${check.runId}: ${check.mismatch}\n`);
          }
          return 1;
        }
        return outcome.jsonlWriteErrors.length > 0 ? 1 : 0;
      } catch (e) {
        process.stderr.write(`${PROGRAM}: ingest failed: ${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
      }
    }

    case 'runs': {
      const args = parseArgs(rest);
      const store = await ViewTraceStore.open({ dataRoot: dataRootOf(args.flags) });
      try {
        const runs = store.listRuns();
        if (args.flags.get('json') === true) {
          process.stdout.write(JSON.stringify(runs, null, 2) + '\n');
        } else {
          if (runs.length === 0) process.stdout.write('no stored runs\n');
          for (const run of runs) {
            process.stdout.write(
              `${run.runId}  ${run.lifecycle}  completeness=${run.completeness}  events=${run.eventCount}  adapter=${run.adapterId}@${run.adapterVersion}\n`,
            );
          }
        }
      } finally {
        await store.close();
      }
      return 0;
    }

    case 'replay': {
      const args = parseArgs(rest);
      const runId = args.positional[0];
      if (runId === undefined) return usage('replay requires a run id');
      const store = await ViewTraceStore.open({ dataRoot: dataRootOf(args.flags) });
      try {
        const replay = store.replay(runId);
        if (replay === null) {
          process.stderr.write(`${PROGRAM}: unknown run: ${runId}\n`);
          return 1;
        }
        process.stdout.write(JSON.stringify(replay, null, 2) + '\n');
      } finally {
        await store.close();
      }
      return 0;
    }

    default:
      return usage(`unknown command '${command}'`);
  }
}

function printIngest(outcome: Awaited<ReturnType<typeof ingestFile>>): void {
  for (const run of outcome.runs) {
    process.stdout.write(
      `run ${run.runId}: ${run.lifecycle} / ${run.completeness} — events ${run.eventsAccepted} accepted, ${run.eventsRejected} rejected; duplicates ${run.duplicatesIdempotent} idempotent, ${run.duplicatesConflicting} conflicting\n`,
    );
  }
  if (outcome.runs.length === 0) process.stdout.write('no runs found in input\n');
  if (outcome.losses.length === 0) {
    process.stdout.write('input losses: none\n');
  } else {
    process.stdout.write(`input losses: ${outcome.losses.length}\n`);
    for (const loss of outcome.losses) {
      process.stdout.write(
        `  line ${loss.lineIndex} byte ${loss.byteOffset}: ${loss.code}${loss.definitive ? '' : ' (possibly incomplete tail)'}\n`,
      );
    }
  }
  const errors = outcome.diagnostics.filter((d) => d.severity === 'error');
  const warnings = outcome.diagnostics.filter((d) => d.severity !== 'error');
  process.stdout.write(`diagnostics: ${errors.length} error, ${warnings.length} warning/info\n`);
  for (const d of outcome.diagnostics) {
    process.stdout.write(`  [${d.severity}] ${d.code}: ${d.message}\n`);
  }
  process.stdout.write(`replay verification: ${outcome.replayChecks.every((c) => c.verified) ? 'OK' : 'FAILED'}\n`);
  process.stdout.write(`data root: ${outcome.dataRoot}\n`);
}

function summarizeEvents(events: Readonly<Record<string, string>>): string {
  return Object.entries(events)
    .map(([type, level]) => `${type}=${level}`)
    .join(',');
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (e) => {
    process.stderr.write(`${PROGRAM}: unexpected failure: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
