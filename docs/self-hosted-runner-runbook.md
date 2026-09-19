<!-- doc-status: stable; source: .github/workflows/ci.yml -->
# Self-hosted Runner Runbook

This runbook documents monitoring and recovery for GitHub Actions self-hosted runners used by this repository.

## Current topology

- Runner 1: `osnova-vps-runner`
- Runner 2: `osnova-vps-runner-2`
- Labels: `self-hosted`, `Linux`, `X64`, `osnova`
- Host: `90.156.210.111`
- Install dirs:
  - `/opt/actions-runner`
  - `/opt/actions-runner-2`
- Services:
  - `actions.runner.mmpfrmvbg-osnova-fabrica.osnova-vps-runner.service`
  - `actions.runner.mmpfrmvbg-osnova-fabrica.osnova-vps-runner-2.service`

## Daily quick checks (2-3 min)

### 1) GitHub-side status

Run from repository root:

```bash
gh api repos/mmpfrmvbg/osnova-fabrica/actions/runners
```

Expected:

- `total_count >= 2`
- both runners have `status: "online"`

### 2) Service status on VPS

```bash
ssh root@90.156.210.111 "systemctl status actions.runner.mmpfrmvbg-osnova-fabrica.osnova-vps-runner.service --no-pager"
ssh root@90.156.210.111 "systemctl status actions.runner.mmpfrmvbg-osnova-fabrica.osnova-vps-runner-2.service --no-pager"
```

Expected: `Active: active (running)` for both services.

### 3) Capacity guardrails

```bash
ssh root@90.156.210.111 "df -h / /opt"
ssh root@90.156.210.111 "free -h"
ssh root@90.156.210.111 "top -bn1 | head -20"
```

Operational thresholds:

- disk free >= 20%
- memory pressure is low (no persistent OOM kills)
- CPU can spike during CI, but should return to normal baseline

## Incident checklist

Use this flow when workflows are red and fail before steps run.

1. Confirm failure type:
   - check run logs for only `system.txt` and no executed steps
2. Check runners online in GitHub (`gh api .../actions/runners`)
3. Check both systemd services on VPS
4. Restart unhealthy service(s)
5. Re-run affected workflows

## Recovery commands

### Restart one runner

```bash
ssh root@90.156.210.111 "systemctl restart actions.runner.mmpfrmvbg-osnova-fabrica.osnova-vps-runner.service"
ssh root@90.156.210.111 "systemctl restart actions.runner.mmpfrmvbg-osnova-fabrica.osnova-vps-runner-2.service"
```

### Restart both runners

```bash
ssh root@90.156.210.111 "systemctl restart actions.runner.mmpfrmvbg-osnova-fabrica.osnova-vps-runner.service actions.runner.mmpfrmvbg-osnova-fabrica.osnova-vps-runner-2.service"
```

### Check recent logs

```bash
ssh root@90.156.210.111 "journalctl -u actions.runner.mmpfrmvbg-osnova-fabrica.osnova-vps-runner.service -n 200 --no-pager"
ssh root@90.156.210.111 "journalctl -u actions.runner.mmpfrmvbg-osnova-fabrica.osnova-vps-runner-2.service -n 200 --no-pager"
```

## Re-register runner (if broken identity)

1. Request registration token:

```bash
gh api -X POST repos/mmpfrmvbg/osnova-fabrica/actions/runners/registration-token
```

2. Reconfigure runner in install directory (`/opt/actions-runner` or `/opt/actions-runner-2`) as user `gha`:

```bash
cd /opt/actions-runner-2
sudo -u gha ./config.sh \
  --url https://github.com/mmpfrmvbg/osnova-fabrica \
  --token <TOKEN> \
  --name osnova-vps-runner-2 \
  --labels osnova,linux,x64 \
  --unattended \
  --replace
```

3. Restart service and verify online in GitHub.

## Common failure signatures

- **Only `system.txt` in logs; no steps started**
  - Runner infra startup issue
  - Action: restart runner services, re-run workflow
- **`actionlint` unknown label**
  - Missing/incorrect `.github/actionlint.yaml`
  - Action: fix config, rerun `Workflow Lint`
- **Permission denied in workspace**
  - stale file ownership from previous runs
  - Action: fix ownership under `/opt/actions-runner*/_work`

## Change management notes

- Keep both runners on same action runner version.
- After OS updates, verify both services are still enabled:

```bash
ssh root@90.156.210.111 "systemctl is-enabled actions.runner.mmpfrmvbg-osnova-fabrica.osnova-vps-runner.service actions.runner.mmpfrmvbg-osnova-fabrica.osnova-vps-runner-2.service"
```

- Any change to runner labels must be reflected in:
  - workflow `runs-on`
  - `.github/actionlint.yaml`
