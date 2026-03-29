#!/usr/bin/env tsx

/**
 * Stale-blocker sync: fetch local (+ optional remote) state v5 blockers, merge, prune
 * (closed issues + invalid atm_id per 015/FBK016), optional write to local state.
 *
 * Structured lines on stdout use prefix `[blocker_sync]`; the same lines are appended to
 * `.tmp/blocker-sync.log` (see appendBlockerSyncLogFile). Diagnostics and verbose argv go to stderr.
 *
 * Log file policy (no code rotation): append-only under `.tmp/blocker-sync.log`. The script never
 * truncates or rotates the file; archive or delete it manually if it grows too large.
 */

import * as fs from 'fs';
import * as path from 'path';

import { parseForgeBlockerAtmId, pruneForgeStateBlockers } from '../src/pipeline/blocker-resolver';
import { loadForgeState, saveForgeState, type ForgeStateV5 } from '../src/pipeline/executor';
import type { ForgeStateBlockerIssueId, ForgeStateBlockerRecord } from '../src/pipeline/types';

export interface BlockerSyncArgs {
  dryRun: boolean;
  apply: boolean;
  verbose: boolean;
  statePath?: string;
  remoteStatePath?: string;
}

export interface BlockerSyncPaths {
  localState: string;
  remoteState: string | null;
}

export interface BlockerSyncResult {
  exitCode: 0 | 1 | 2;
  summaryLines: string[];
  stderrLines: string[];
}

const LOG_PREFIX = '[blocker_sync]';

/** Resolved path to `.tmp/blocker-sync.log` under the repo root. */
export function blockerSyncLogPath(repoRoot: string): string {
  return path.join(repoRoot, '.tmp', 'blocker-sync.log');
}

/**
 * Append one UTF-8 line to `.tmp/blocker-sync.log`: ensures `.tmp` exists, opens in append mode.
 * Each line is prefixed with an ISO-8601 timestamp and a single space before the message body.
 */
export function appendBlockerSyncLogFile(repoRoot: string, line: string): void {
  const tmpDir = path.join(repoRoot, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const stamp = new Date().toISOString();
  fs.appendFileSync(blockerSyncLogPath(repoRoot), `${stamp} ${line}\n`, 'utf8');
}

function summaryLine(fields: Record<string, string | number | boolean>): string {
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
  return `${LOG_PREFIX} ${parts.join(' ')}`;
}

/** Read blockers from a state YAML path; no throw on missing file — returns empty list. */
export function readBlockersFromStatePath(filePath: string): {
  present: boolean;
  blockers: ForgeStateBlockerRecord[];
  error?: string;
} {
  try {
    const state = loadForgeState(filePath);
    if (state === null) {
      return { present: false, blockers: [] };
    }
    return { present: true, blockers: state.blockers ?? [] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { present: true, blockers: [], error: msg };
  }
}

/** Merge remote into local by issue; on conflict, keep row with lexicographically greater `updated`. */
export function mergeForgeBlockerSources(
  local: readonly ForgeStateBlockerRecord[],
  remote: readonly ForgeStateBlockerRecord[]
): ForgeStateBlockerRecord[] {
  const byIssue = new Map<number, ForgeStateBlockerRecord>();
  for (const e of local) {
    byIssue.set(e.issue, e);
  }
  for (const e of remote) {
    const cur = byIssue.get(e.issue);
    if (!cur || e.updated > cur.updated) {
      byIssue.set(e.issue, e);
    }
  }
  return [...byIssue.values()].sort((a, b) => a.issue - b.issue);
}

function parseClosedIds(raw: string | undefined): Set<ForgeStateBlockerIssueId> {
  if (!raw?.trim()) return new Set();
  const out = new Set<ForgeStateBlockerIssueId>();
  for (const part of raw.split(/[\s,]+/)) {
    const t = part.trim();
    if (!t) continue;
    const n = Number(t);
    if (Number.isInteger(n)) out.add(n);
  }
  return out;
}

function blockersStableJson(list: readonly ForgeStateBlockerRecord[]): string {
  const sorted = [...list].sort((a, b) => a.issue - b.issue);
  return JSON.stringify(
    sorted.map((e) => ({ issue: e.issue, atm_id: e.atm_id, open: e.open, updated: e.updated }))
  );
}

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/blocker-sync.ts [options]

Fetches local .osnova/state.yaml blockers and optional remote state, merges by GitHub issue
(newer updated timestamp wins), prunes closed issues and stale atm_id (015/FBK016 contract).

Exit codes:
  0  Success
  1  State load/save or YAML error
  2  Invalid arguments

Options:
  --dry-run          Report only (default when --apply is not set)
  --apply            Write merged+pruned blockers to local state
  --no-dry-run       Same as --apply
  --verbose          Log argv and paths to stderr
  --state <path>     Local state YAML (else OSNOVA_STATE_PATH / FORGE_STATE_PATH or .osnova/state.yaml)
  --remote-state <path>  Remote state YAML (else STALE_BLOCKER_REMOTE_STATE / OSNOVA_REMOTE_STATE_PATH; omit = no remote)
  --help, -h         Show this help
`);
}

export function resolveBlockerSyncPaths(args: BlockerSyncArgs, cwd: string = process.cwd()): BlockerSyncPaths {
  const fromEnvLocal = process.env.OSNOVA_STATE_PATH ?? process.env.FORGE_STATE_PATH;
  const local = path.resolve(cwd, args.statePath ?? fromEnvLocal ?? '.osnova/state.yaml');

  const fromEnvRemote =
    process.env.STALE_BLOCKER_REMOTE_STATE?.trim() || process.env.OSNOVA_REMOTE_STATE_PATH?.trim();
  const remoteExplicit = args.remoteStatePath?.trim();
  const remote =
    remoteExplicit && remoteExplicit.length > 0
      ? path.resolve(cwd, remoteExplicit)
      : fromEnvRemote && fromEnvRemote.length > 0
        ? path.resolve(cwd, fromEnvRemote)
        : null;

  return { localState: local, remoteState: remote };
}

export function parseArgs(argv: string[]): BlockerSyncArgs {
  const args: BlockerSyncArgs = {
    dryRun: true,
    apply: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      continue;
    }
    if (arg === '--state' || arg === '-s') {
      args.statePath = argv[++i];
      if (args.statePath === undefined) throw new Error('--state requires a path');
      continue;
    }
    if (arg === '--remote-state' || arg === '--remote') {
      args.remoteStatePath = argv[++i];
      if (args.remoteStatePath === undefined) throw new Error('--remote-state requires a path');
      continue;
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      args.apply = false;
    } else if (arg === '--no-dry-run' || arg === '--apply') {
      args.apply = true;
      args.dryRun = false;
    } else if (arg === '--verbose') {
      args.verbose = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return args;
}

export function runBlockerSync(args: BlockerSyncArgs, cwd: string = process.cwd()): BlockerSyncResult {
  const summaryLines: string[] = [];
  const stderrLines: string[] = [];
  const finish = (result: BlockerSyncResult): BlockerSyncResult => {
    for (const line of result.summaryLines) {
      appendBlockerSyncLogFile(cwd, line);
    }
    return result;
  };
  const paths = resolveBlockerSyncPaths(args, cwd);
  const closed = parseClosedIds(
    process.env.FORGE_CLOSED_BLOCKER_ISSUES ?? process.env.FORGE_CLOSED_ISSUES
  );

  const localRead = readBlockersFromStatePath(paths.localState);
  if (localRead.error) {
    stderrLines.push(`${LOG_PREFIX} local_load_error path=${paths.localState} msg=${localRead.error}`);
    return finish({ exitCode: 1, summaryLines, stderrLines });
  }

  let remoteBlockers: ForgeStateBlockerRecord[] = [];
  let remotePresent = false;
  if (paths.remoteState !== null) {
    const remoteRead = readBlockersFromStatePath(paths.remoteState);
    if (remoteRead.error) {
      stderrLines.push(`${LOG_PREFIX} remote_load_error path=${paths.remoteState} msg=${remoteRead.error}`);
      return finish({ exitCode: 1, summaryLines, stderrLines });
    }
    remotePresent = remoteRead.present;
    remoteBlockers = remoteRead.blockers;
  }

  summaryLines.push(
    summaryLine({
      event: 'fetch',
      local_path: paths.localState,
      local_present: localRead.present,
      local_rows: localRead.blockers.length,
      remote_path: paths.remoteState ?? '(none)',
      remote_present: remotePresent,
      remote_rows: remoteBlockers.length,
    })
  );

  const merged = mergeForgeBlockerSources(localRead.blockers, remoteBlockers);
  summaryLines.push(
    summaryLine({
      event: 'merge',
      merged_rows: merged.length,
    })
  );

  let removedClosed = 0;
  let removedStaleAtm = 0;
  for (const entry of merged) {
    if (closed.has(entry.issue)) removedClosed += 1;
    else if (!parseForgeBlockerAtmId(entry.atm_id).ok) removedStaleAtm += 1;
  }

  const pruned = pruneForgeStateBlockers(merged, closed);
  summaryLines.push(
    summaryLine({
      event: 'prune',
      removed_closed: removedClosed,
      removed_stale_atm: removedStaleAtm,
      final_rows: pruned.length,
    })
  );

  const drift = blockersStableJson(localRead.blockers) !== blockersStableJson(pruned);
  summaryLines.push(
    summaryLine({
      event: 'plan',
      drift,
      apply: args.apply,
      dry_run: args.dryRun,
    })
  );

  if (!args.apply) {
    return finish({ exitCode: 0, summaryLines, stderrLines });
  }

  if (!localRead.present) {
    stderrLines.push(
      `${LOG_PREFIX} apply_aborted reason=no_local_state path=${paths.localState}`
    );
    return finish({ exitCode: 1, summaryLines, stderrLines });
  }

  let state: ForgeStateV5;
  try {
    const loaded = loadForgeState(paths.localState);
    if (loaded === null) {
      stderrLines.push(`${LOG_PREFIX} apply_aborted reason=state_missing path=${paths.localState}`);
      return finish({ exitCode: 1, summaryLines, stderrLines });
    }
    state = loaded;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stderrLines.push(`${LOG_PREFIX} apply_load_error msg=${msg}`);
    return finish({ exitCode: 1, summaryLines, stderrLines });
  }

  try {
    saveForgeState(paths.localState, { ...state, blockers: pruned });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stderrLines.push(`${LOG_PREFIX} apply_save_error msg=${msg}`);
    return finish({ exitCode: 1, summaryLines, stderrLines });
  }

  summaryLines.push(
    summaryLine({
      event: 'apply',
      wrote_rows: pruned.length,
      path: paths.localState,
    })
  );

  return finish({ exitCode: 0, summaryLines, stderrLines });
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  let args: BlockerSyncArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[blocker-sync] ${msg}`);
    console.error('Use --help for usage.');
    process.exit(2);
  }

  const paths = resolveBlockerSyncPaths(args);

  if (args.verbose) {
    console.error(
      `[blocker-sync] dryRun=${args.dryRun} apply=${args.apply} local=${paths.localState} remote=${paths.remoteState ?? '(none)'}`
    );
  }

  const result = runBlockerSync(args);
  for (const line of result.stderrLines) {
    console.error(line);
  }
  for (const line of result.summaryLines) {
    console.log(line);
  }
  process.exit(result.exitCode);
}

if (require.main === module) {
  main();
}
