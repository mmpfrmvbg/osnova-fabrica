<!-- doc-status: stable; source: .github/workflows/ci.yml -->
# Self-hosted Runner Runbook

This runbook documents the GitHub Actions self-hosted runner that executes the
external-resource gates (`qemu`, `hardware`) and how to check or recover it.

## Current topology (measured 2026-11-12)

- Runner: `osnova-win-qemu`
- Labels: `self-hosted`, `Windows`, `X64`, `osnova-qemu`, `osnova-hardware`
- Host: the Windows workstation that has WSL distro `e2k` and the E8C2 SSH key
- Install directory: `C:\actions-runner-osnova`
- Work directory: `C:\actions-runner-osnova\_work`
- Start command: `C:\actions-runner-osnova\run.cmd` (interactive process, not a service)

One runner carries both labels on purpose: `gate:qemu` needs
`/root/qemu-build/qemu-e2k` inside WSL, and the E8C2 stand is reached over SSH
from the same Windows profile (key `%USERPROFILE%\.ssh\osnova_e2k`). A Linux
runner on the stand would require opening GitHub traffic into the stand network,
which is not part of this decision.

Verification:

```powershell
gh api repos/mmpfrmvbg/osnova-fabrica/actions/runners `
  --jq '.runners[] | {name,status,busy,labels:[.labels[].name]}'
```

Expected: `"name":"osnova-win-qemu"`, `"status":"online"`, both `osnova-qemu`
and `osnova-hardware` present.

## Stale topology warning

An earlier revision of this file documented two Linux VPS runners
(`osnova-vps-runner`, `osnova-vps-runner-2`) at `90.156.210.111`. On 2026-11-12
`gh api .../actions/runners` returned `total_count: 0`, and
`ssh root@90.156.210.111` timed out (port 22). Those runners do not exist in the
current repository; do not build workflow labels on them.

## Daily quick checks (2-3 min)

1. GitHub-side status (command above): runner online, not stuck busy for hours.
2. WSL model identity:

   ```powershell
   wsl -d e2k -e bash -lc 'sha256sum /root/qemu-build/qemu-e2k'
   ```

   Expected sha256:
   `4e37a37243189dec4f7405ed465c7eade2d51f5edab95060a6ada880f23fe081`.
3. Hardware key visible from Windows and WSL:

   ```powershell
   Test-Path "$env:USERPROFILE\.ssh\osnova_e2k"
   ```

4. Disk space for `C:\actions-runner-osnova\_work` (each job runs `npm ci`).

## Incident checklist

1. Open the failed run and check whether any steps started. A run with only
   `Set up job` failing is runner infrastructure, not a code failure.
2. Check runner online (`gh api ...`). If offline, start `run.cmd`.
3. If jobs hang in `queued`, confirm the job labels match the runner labels
   exactly (case-insensitive).
4. If `qemu` fails with `passport-unreadable` or `model-mismatch`, the METRICS
   artifact names both sha256 values; do not re-run hoping for green — rebuild
   or restore the model.
5. If `hardware` fails with `no-key` or `no-key-wsl`, the key is not visible to
   the account that started the runner; fixing this needs the same Windows
   profile that owns WSL.

## Recovery commands

Start the runner (interactive session; keep the window open):

```powershell
C:\actions-runner-osnova\run.cmd
```

Re-register the runner if its identity is broken:

```powershell
gh api -X POST repos/mmpfrmvbg/osnova-fabrica/actions/runners/registration-token
C:\actions-runner-osnova\config.cmd --url https://github.com/mmpfrmvbg/osnova-fabrica `
  --token <TOKEN> --name osnova-win-qemu `
  --labels osnova-qemu,osnova-hardware --work _work --unattended --replace
```

Then start `run.cmd` and verify online in GitHub.

## Security boundary

The repository is public. `pull_request` jobs are excluded from the self-hosted
`qemu` and `hardware` jobs (`if: github.event_name != 'pull_request'`), because a
fork PR could otherwise execute its own code on this machine. Those gates run on
pushes to repository branches and on manual dispatch only.

## Common failure signatures

- **Only `system.txt`; no steps started** — runner process died or was
  unregistered. Start `run.cmd`, verify online.
- **`actionlint` unknown label** — `.github/actionlint.yaml` must list
  `osnova-qemu` and `osnova-hardware`; it does as of 2026-11-12.
- **`wsl: distribution e2k not found`** — the runner was started under a
  different Windows account than the one that registered the WSL distro.
- **`METRICS ... reason=no-model`** — `/root/qemu-build/qemu-e2k` is missing or
  unreadable inside WSL; the artifact says so instead of a fake pass.

## Change management

- Any label change must be reflected in the workflow `runs-on` values and in
  `.github/actionlint.yaml`.
- After changing the QEMU binary, update `src/e2k/qemuModelPassport.ts` in the
  same commit; otherwise the job refuses with `model-mismatch` (by design).
