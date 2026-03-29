import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import {
  mergeForgeBlockerSources,
  parseArgs,
  readBlockersFromStatePath,
  resolveBlockerSyncPaths,
  runBlockerSync,
} from '../../scripts/blocker-sync';
import { composeForgeStateBlockerAtmId, FORGE_STATE_BLOCKER_EPK_ATM_015 } from '../pipeline/types';

describe('blocker-sync', () => {
  it('mergeForgeBlockerSources prefers newer updated on same issue', () => {
    const oldRow = {
      issue: 10,
      atm_id: composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, 'a'),
      open: true,
      updated: '2024-01-01T00:00:00Z',
    };
    const newRow = {
      issue: 10,
      atm_id: composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, 'b'),
      open: false,
      updated: '2025-06-01T00:00:00Z',
    };
    const m = mergeForgeBlockerSources([oldRow], [newRow]);
    expect(m).toHaveLength(1);
    expect(m[0]!.atm_id).toBe(newRow.atm_id);
  });

  it('parseArgs resolves --apply and --state', () => {
    const a = parseArgs(['--apply', '--state', 'custom/state.yaml']);
    expect(a.apply).toBe(true);
    expect(a.dryRun).toBe(false);
    expect(a.statePath).toBe('custom/state.yaml');
  });

  it('resolveBlockerSyncPaths uses explicit state path', () => {
    const cwd = '/repo';
    const p = resolveBlockerSyncPaths(
      { dryRun: true, apply: false, verbose: false, statePath: '.osnova/state.yaml' },
      cwd
    );
    expect(p.localState).toBe(path.resolve(cwd, '.osnova/state.yaml'));
    expect(p.remoteState).toBeNull();
  });

  it('runBlockerSync dry-run reports fetch/merge/prune without writing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocker-sync-test-'));
    const localPath = path.join(dir, 'state.yaml');
    const remotePath = path.join(dir, 'remote.yaml');
    const atmOk = composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '001');
    fs.writeFileSync(
      localPath,
      `v: 5
blockers:
  - issue: 1
    atm_id: ${atmOk}
    open: true
    updated: '2024-01-01T00:00:00Z'
`,
      'utf8'
    );
    fs.writeFileSync(
      remotePath,
      `v: 5
blockers:
  - issue: 2
    atm_id: ${atmOk}
    open: true
    updated: '2024-02-01T00:00:00Z'
`,
      'utf8'
    );

    const result = runBlockerSync(
      {
        dryRun: true,
        apply: false,
        verbose: false,
        statePath: localPath,
        remoteStatePath: remotePath,
      },
      dir
    );

    expect(result.exitCode).toBe(0);
    expect(result.summaryLines.some((l) => l.includes('event=fetch'))).toBe(true);
    expect(result.summaryLines.some((l) => l.includes('event=merge') && l.includes('merged_rows=2'))).toBe(
      true
    );
    expect(result.summaryLines.some((l) => l.includes('drift=true'))).toBe(true);

    const after = fs.readFileSync(localPath, 'utf8');
    expect(after).toContain('issue: 1');
    expect(after).not.toContain('issue: 2');
  });

  it('readBlockersFromStatePath returns empty when file missing', () => {
    const r = readBlockersFromStatePath(path.join(os.tmpdir(), 'no-such-state-forge-xyz.yaml'));
    expect(r.present).toBe(false);
    expect(r.blockers).toEqual([]);
    expect(r.error).toBeUndefined();
  });
});
