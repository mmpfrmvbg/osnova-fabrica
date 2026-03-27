from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml


def _load_dotenv_defaults() -> dict[str, str]:
    """
    Load KEY=VALUE pairs from forge/.env (or /opt/osnova-forge/.env)
    without overriding already exported environment variables.
    """
    candidates: list[Path] = []
    here = Path(__file__).resolve().parent
    candidates.append(here / ".env")
    candidates.append(Path("/opt/osnova-forge/.env"))
    data: dict[str, str] = {}
    for p in candidates:
        if not p.exists():
            continue
        try:
            for raw in p.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip("'").strip('"')
                if key:
                    data[key] = value
            break
        except Exception:
            continue
    return data


def env_paths() -> dict[str, str]:
    dot = _load_dotenv_defaults()
    home = os.path.expanduser("~")
    project = os.environ.get("OSNOVA_PROJECT", dot.get("OSNOVA_PROJECT", os.path.join(home, "osnova-fabrica")))
    forge = os.environ.get("OSNOVA_FORGE", dot.get("OSNOVA_FORGE", "/opt/osnova-forge"))
    return {
        "OSNOVA_PROJECT": project,
        "OSNOVA_FORGE": forge,
        "GH_TOKEN": os.environ.get("GH_TOKEN", dot.get("GH_TOKEN", "")),
        "GHREPO": os.environ.get("GHREPO", dot.get("GHREPO", "mmpfrmvbg/osnova-fabrica")),
        "QWENBIN": os.environ.get("QWENBIN", dot.get("QWENBIN", "qwen")),
        "CURSORBIN": os.environ.get("CURSORBIN", dot.get("CURSORBIN", "cursor-agent")),
    }


def ensure_dir(path: str | Path) -> Path:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


def setup_logging(name: str) -> logging.Logger:
    paths = env_paths()
    log_dir = ensure_dir(paths["OSNOVA_FORGE"])
    logger = logging.getLogger(f"forge.{name}")
    if logger.handlers:
        return logger
    logger.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    fh = logging.FileHandler(log_dir / f"{name}.log", encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    logger.addHandler(fh)
    logger.addHandler(sh)
    return logger


def atomic_write_text(path: str | Path, data: str) -> None:
    target = Path(path)
    ensure_dir(target.parent)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=target.parent) as f:
        f.write(data)
        tmp = Path(f.name)
    os.replace(tmp, target)


def atomic_write_json(path: str | Path, obj: Any) -> None:
    atomic_write_text(path, json.dumps(obj, ensure_ascii=False, indent=2) + "\n")


def atomic_write_yaml(path: str | Path, obj: Any) -> None:
    atomic_write_text(path, yaml.safe_dump(obj, allow_unicode=True, sort_keys=False))


def load_json(path: str | Path, default: Any = None) -> Any:
    p = Path(path)
    if not p.exists():
        return default
    with p.open("r", encoding="utf-8") as f:
        return json.load(f)


def load_yaml(path: str | Path, default: Any = None) -> Any:
    p = Path(path)
    if not p.exists():
        return default
    with p.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or default


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def forge_state_path() -> Path:
    return Path(env_paths()["OSNOVA_FORGE"]) / "forge-state.json"


def load_forge_state() -> dict[str, Any]:
    default = {
        "session": "S-2026-03-27",
        "paused": False,
        "active_task": None,
        "smith_pid": None,
        "consecutive_failures": 0,
        "current_epic": None,
        "brain_source": "idle",
        "current_epic_issue": None,
    }
    state = load_json(forge_state_path(), default=default) or default
    for k, v in default.items():
        state.setdefault(k, v)
    return state


def save_forge_state(state: dict[str, Any]) -> None:
    atomic_write_json(forge_state_path(), state)


def backup_file(src: str | Path, dst_dir: str | Path) -> Path | None:
    source = Path(src)
    if not source.exists():
        return None
    ensure_dir(dst_dir)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dst = Path(dst_dir) / f"{source.stem}-{stamp}{source.suffix}"
    shutil.copy2(source, dst)
    return dst


def gh_request(method: str, api_path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    paths = env_paths()
    token = paths["GH_TOKEN"]
    url = f"https://api.github.com{api_path}"
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        method=method,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "osnova-forge",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8")
    return json.loads(body) if body else {}

