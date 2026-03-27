from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from datetime import date
from pathlib import Path

try:
    from forge.common import backup_file, env_paths, gh_request, heartbeat_path, load_forge_state, now_iso, save_forge_state, setup_logging
except ImportError:  # pragma: no cover
    from common import backup_file, env_paths, gh_request, heartbeat_path, load_forge_state, now_iso, save_forge_state, setup_logging

LOG = setup_logging("heart")

# On Windows without FORGE_RESTART_CMD, stale heartbeat logs the same hint every loop;
# repeat the long hint at most this often (seconds). Override via HEART_STALE_HINT_INTERVAL.
_last_win_stale_hint_at = 0.0


def _heartbeat_age_seconds(path: Path) -> float:
    if not path.exists():
        return 10**9
    return time.time() - path.stat().st_mtime


def _restart_forge(state: dict) -> bool:
    """
    Try to restart the forge service. On Windows there is no systemctl — set
    FORGE_RESTART_CMD (shell string) to your own command, or restart manually.
    Returns True if a restart command ran with exit code 0.
    """
    global _last_win_stale_hint_at
    custom = os.environ.get("FORGE_RESTART_CMD", "").strip()
    if custom:
        proc = subprocess.run(custom, shell=True, check=False)
        ok = proc.returncode == 0
        if not ok:
            LOG.warning("FORGE_RESTART_CMD exited with %s", proc.returncode)
    elif sys.platform == "win32":
        now = time.time()
        interval = float(os.environ.get("HEART_STALE_HINT_INTERVAL", "900"))
        if now - _last_win_stale_hint_at >= max(60.0, interval):
            _last_win_stale_hint_at = now
            LOG.error(
                "Heartbeat stale — Windows has no systemctl. Start `python forge/forge.py` again, "
                "or set FORGE_RESTART_CMD to a command that restarts forge (see forge/.env.example)."
            )
        return False
    elif shutil.which("systemctl"):
        proc = subprocess.run(["systemctl", "restart", "osnova-forge"], check=False)
        ok = proc.returncode == 0
        if not ok:
            LOG.warning("systemctl restart osnova-forge returned %s", proc.returncode)
    else:
        LOG.error("No systemctl on PATH and FORGE_RESTART_CMD unset — cannot auto-restart forge.")
        return False

    if not ok:
        return False
    state["last_heart_restart"] = now_iso()
    state["heart_restarts_day"] = state.get("heart_restarts_day", date.today().isoformat())
    if state["heart_restarts_day"] != date.today().isoformat():
        state["heart_restarts"] = 0
        state["heart_restarts_day"] = date.today().isoformat()
    state["heart_restarts"] = int(state.get("heart_restarts", 0)) + 1
    return True


def _create_alert_issue(state: dict) -> None:
    repo = env_paths()["GHREPO"]
    title = "P0 heart-alert: forge restarted 3+ times"
    body = f"Heart restarted forge {state.get('heart_restarts')} times today."
    gh_request("POST", f"/repos/{repo}/issues", {"title": title, "body": body, "labels": ["P0", "heart-alert"]})


def _restore_if_corrupt(state_file: Path, backups_dir: Path) -> None:
    try:
        json.loads(state_file.read_text(encoding="utf-8"))
        return
    except Exception:
        pass
    backups = sorted(backups_dir.glob("forge-state-*.json"))
    if not backups:
        return
    state_file.write_text(backups[-1].read_text(encoding="utf-8"), encoding="utf-8")
    LOG.warning("Restored forge-state.json from backup %s", backups[-1])


def loop() -> None:
    paths = env_paths()
    forge_dir = Path(paths["OSNOVA_FORGE"])
    legacy = forge_dir / "forge.heartbeat"
    hb_path = heartbeat_path()
    max_silence = int(os.environ.get("HEART_MAX_SILENCE", "300"))
    state_file = forge_dir / "forge-state.json"
    backups_dir = forge_dir / "state-backups"
    last_backup_at = 0.0
    while True:
        state = load_forge_state()
        try:
            if hb_path.exists():
                primary: Path | None = hb_path
            elif legacy.exists():
                primary = legacy
            else:
                primary = None
            if primary is None:
                time.sleep(60)
                continue
            age = _heartbeat_age_seconds(primary)
            if age > max_silence:
                LOG.error("Forge heartbeat stale: %.1fs (HEART_MAX_SILENCE=%ss)", age, max_silence)
                _restart_forge(state)
                if int(state.get("heart_restarts", 0)) >= 3:
                    _create_alert_issue(state)
            now = time.time()
            if now - last_backup_at >= 600:
                backup_file(state_file, backups_dir)
                last_backup_at = now
            _restore_if_corrupt(state_file, backups_dir)
        except Exception as exc:
            LOG.exception("Heart loop error: %s", exc)
        save_forge_state(state)
        time.sleep(60)


def main() -> None:
    loop()


if __name__ == "__main__":
    main()

