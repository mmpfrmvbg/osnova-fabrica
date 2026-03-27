from __future__ import annotations

import json
import subprocess
import time
from datetime import date
from pathlib import Path

try:
    from forge.common import backup_file, env_paths, gh_request, load_forge_state, now_iso, save_forge_state, setup_logging
except ImportError:  # pragma: no cover
    from common import backup_file, env_paths, gh_request, load_forge_state, now_iso, save_forge_state, setup_logging

LOG = setup_logging("heart")


def _heartbeat_age_seconds(path: Path) -> float:
    if not path.exists():
        return 10**9
    return time.time() - path.stat().st_mtime


def _restart_forge(state: dict) -> None:
    subprocess.run(["systemctl", "restart", "osnova-forge"], check=False)
    state["last_heart_restart"] = now_iso()
    state["heart_restarts_day"] = state.get("heart_restarts_day", date.today().isoformat())
    if state["heart_restarts_day"] != date.today().isoformat():
        state["heart_restarts"] = 0
        state["heart_restarts_day"] = date.today().isoformat()
    state["heart_restarts"] = int(state.get("heart_restarts", 0)) + 1


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
    heartbeat = forge_dir / "forge.heartbeat"
    state_file = forge_dir / "forge-state.json"
    backups_dir = forge_dir / "state-backups"
    last_backup_at = 0.0
    while True:
        state = load_forge_state()
        try:
            age = _heartbeat_age_seconds(heartbeat)
            if age > 300:
                LOG.error("Forge heartbeat stale: %.1fs", age)
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

