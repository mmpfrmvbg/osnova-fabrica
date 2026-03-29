#!/usr/bin/env tsx

/**
 * Stale-blocker sync CLI (scaffold).
 * Default behavior is a safe no-op: no state files are read or written.
 */

export interface BlockerSyncArgs {
  dryRun: boolean;
  apply: boolean;
  verbose: boolean;
}

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/blocker-sync.ts [options]

Stale-blocker sync (scaffold). By default performs no I/O and makes no changes.

Exit codes:
  0  Success (help shown, or completed without error)
  1  Reserved for sync or I/O errors when implementation lands
  2  Invalid arguments

Options:
  --dry-run       Report-only mode (default when --apply is not set)
  --apply         Perform sync (scaffold: still a no-op; logs that apply is not wired)
  --no-dry-run    Same as --apply for readability
  --verbose       Log argv resolution to stderr
  --help, -h      Show this help
`);
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

export function runBlockerSync(args: BlockerSyncArgs): { mode: string; message: string } {
  if (args.apply) {
    return {
      mode: 'apply-scaffold',
      message: '[blocker-sync] --apply: scaffold only; no stale-blocker changes performed.',
    };
  }
  return {
    mode: 'dry-run',
    message: '[blocker-sync] dry-run (default): no stale-blocker sync performed.',
  };
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

  if (args.verbose) {
    console.error(`[blocker-sync] dryRun=${args.dryRun} apply=${args.apply}`);
  }

  const result = runBlockerSync(args);
  console.log(result.message);
  process.exit(0);
}

if (require.main === module) {
  main();
}
