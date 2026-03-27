from __future__ import annotations

import json
import logging
import os
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

# Windows defaults to cp1251 for subprocess text mode; Qwen/agent emit UTF-8.
SUBPROCESS_TEXT: dict[str, Any] = {"encoding": "utf-8", "errors": "replace"}


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
                value = value.strip().strip("'").strip('"').lstrip("\ufeff")
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
    ghrepo = (
        os.environ.get("GHREPO")
        or os.environ.get("GH_REPO")
        or dot.get("GHREPO")
        or dot.get("GH_REPO")
        or "mmpfrmvbg/osnova-fabrica"
    )
    gh_token = (
        os.environ.get("GH_TOKEN")
        or os.environ.get("GITHUB_TOKEN")
        or dot.get("GH_TOKEN")
        or dot.get("GITHUB_TOKEN")
        or ""
    )
    return {
        "OSNOVA_PROJECT": project,
        "OSNOVA_FORGE": forge,
        "GH_TOKEN": gh_token,
        "GHREPO": ghrepo.strip(),
        "QWENBIN": os.environ.get("QWENBIN", dot.get("QWENBIN", "qwen")),
        "CURSORBIN": os.environ.get("CURSORBIN", dot.get("CURSORBIN", "cursor-agent")),
    }


def heartbeat_path() -> Path:
    """v5.2 default: <FORGE>/heartbeat (override with FORGE_HEARTBEAT_FILE)."""
    p = os.environ.get("FORGE_HEARTBEAT_FILE", "").strip()
    if p:
        return Path(p)
    return Path(env_paths()["OSNOVA_FORGE"]) / "heartbeat"


def epic_socket_path() -> Path:
    p = os.environ.get("FORGE_EPIC_SOCKET", "").strip()
    if p:
        return Path(p)
    return Path(env_paths()["OSNOVA_FORGE"]) / "epic.sock"


def epic_queue_path() -> Path:
    """EPIC FIFO path. GHA 01-epic-intake commits <repo>/forge/epic-queue.txt."""
    paths = env_paths()
    project = Path(paths["OSNOVA_PROJECT"])
    forge_sub = project / "forge"
    repo_queue = forge_sub / "epic-queue.txt"
    forge_queue = Path(paths["OSNOVA_FORGE"]) / "epic-queue.txt"
    try:
        if repo_queue.resolve() == forge_queue.resolve():
            return repo_queue
    except (OSError, ValueError):
        pass
    if forge_sub.is_dir() or repo_queue.exists():
        return repo_queue
    return forge_queue


def resolve_executable(name_or_path: str) -> str:
    """
    Resolve a command to a path subprocess can run on Windows (npm publishes .cmd shims;
    bare ``qwen`` often raises WinError 2 from CreateProcess without this).
    """
    s = (name_or_path or "").strip()
    if not s:
        return s
    p = Path(s)
    try:
        if p.is_file():
            return str(p.resolve())
    except OSError:
        pass
    found = shutil.which(s)
    if found:
        return found
    if sys.platform == "win32":
        for suf in (".CMD", ".cmd", ".exe", ".bat"):
            found = shutil.which(s + suf)
            if found:
                return found
    return s


def qwen_headless_argv(prompt: str) -> list[str]:
    """
    Qwen Code headless: ``qwen --yolo -p "..."`` (see Qwen docs). ``--yolo`` auto-approves tool use in CI/forge.

    - ``FORGE_QWEN_LEGACY_RUN=1`` — use older ``qwen run <prompt>`` if your CLI only supports that.
    - ``FORGE_QWEN_MODEL`` — optional ``--model`` (e.g. ``qwen3-coder-plus``).
    """
    exe = resolve_executable(env_paths()["QWENBIN"])
    if os.environ.get("FORGE_QWEN_LEGACY_RUN", "").strip().lower() in ("1", "true", "yes"):
        return [exe, "run", prompt]
    argv: list[str] = [exe, "--yolo"]
    model = os.environ.get("FORGE_QWEN_MODEL", "").strip()
    if model:
        argv.extend(["--model", model])
    argv.extend(["-p", prompt])
    return argv


def cursor_cli_extra_path_entries() -> list[str]:
    """
    Directories where the Cursor Windows installer usually places ``agent`` / IDE shims.
    Git Bash started from Python often inherits a stale PATH (no ``~\\.local\\bin``).
    Optional: extend with FORGE_CURSOR_PATH_EXTRA (os.pathsep-separated).
    """
    if sys.platform != "win32":
        return []
    entries: list[Path] = [Path.home() / ".local" / "bin"]
    la = os.environ.get("LOCALAPPDATA", "").strip()
    if la:
        entries.append(Path(la) / "Programs" / "cursor" / "resources" / "app" / "bin")
    pf = os.environ.get("ProgramFiles", r"C:\Program Files").strip()
    if pf:
        entries.append(Path(pf) / "cursor" / "resources" / "app" / "bin")
    pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)").strip()
    if pf86:
        entries.append(Path(pf86) / "cursor" / "resources" / "app" / "bin")
    extra = os.environ.get("FORGE_CURSOR_PATH_EXTRA", "").strip()
    if extra:
        for part in extra.split(os.pathsep):
            part = part.strip().strip('"')
            if part:
                entries.append(Path(part))
    out: list[str] = []
    for p in entries:
        try:
            if p.is_dir():
                out.append(str(p.resolve()))
        except OSError:
            continue
    seen: set[str] = set()
    uniq: list[str] = []
    for d in out:
        if d not in seen:
            seen.add(d)
            uniq.append(d)
    return uniq


def _path_for_git_bash(p: Path) -> str:
    """Paths Git Bash can exec reliably (forward slashes on Windows)."""
    return Path(str(p.resolve())).as_posix()


def resolve_cursor_bin_for_smith(raw: str) -> str:
    """
    Resolve CURSORBIN for smith.sh: full path when possible so GNU timeout finds the binary.
    """
    s = (raw or "").strip()
    if not s:
        return ""
    try:
        p = Path(s)
        if p.is_file():
            return _path_for_git_bash(p)
    except OSError:
        pass
    r = resolve_executable(s)
    if r:
        try:
            rp = Path(r)
            if rp.is_file():
                return _path_for_git_bash(rp)
        except OSError:
            pass
    merged_path = os.pathsep.join([*cursor_cli_extra_path_entries(), os.environ.get("PATH", "")])
    w = shutil.which(s, path=merged_path)
    if not w and sys.platform == "win32":
        w = shutil.which(f"{s}.exe", path=merged_path)
    if w:
        try:
            wp = Path(w)
            if wp.is_file():
                return _path_for_git_bash(wp)
        except OSError:
            pass
    if sys.platform != "win32":
        return s
    trial_names: list[str] = []
    for n in (s, f"{s}.exe" if not s.lower().endswith(".exe") else "", "agent.exe", "cursor-agent.exe"):
        n = n.strip()
        if n and n not in trial_names:
            trial_names.append(n)
    for dn in cursor_cli_extra_path_entries():
        for name in trial_names:
            cand = Path(dn) / name
            try:
                if cand.is_file():
                    return _path_for_git_bash(cand)
            except OSError:
                continue
    return s


def bash_executable() -> str | None:
    """
    Bash for running forge/smith.sh. On Windows .sh is not a Win32 executable (WinError 193);
    use Git Bash or set FORGE_BASH to bash.exe.
    """
    override = os.environ.get("FORGE_BASH", "").strip()
    if override:
        p = Path(override)
        if p.is_file():
            return str(p)
        w = shutil.which(override)
        if w:
            return w
    if sys.platform == "win32":
        # Prefer Git Bash over WSL's system32\\bash.EXE (WSL + Windows cwd paths break smith.sh).
        for base in (
            os.environ.get("ProgramFiles", r"C:\Program Files"),
            os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
        ):
            candidate = Path(base) / "Git" / "bin" / "bash.exe"
            if candidate.is_file():
                return str(candidate)
    w = shutil.which("bash")
    if w:
        return w
    return None


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
        "last_epic_received_at": None,
        "forge_started_at": None,
    }
    state = load_json(forge_state_path(), default=default) or default
    for k, v in default.items():
        state.setdefault(k, v)
    if state.get("forge_started_at") is None:
        state["forge_started_at"] = now_iso()
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


def _github_bearer_value(token: str) -> str:
    """GitHub PATs are ASCII; strip BOM and drop non–latin-1 chars so urllib headers never choke."""
    t = (token or "").strip().lstrip("\ufeff")
    return "".join(ch for ch in t if ord(ch) < 128)


def gh_request(method: str, api_path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    paths = env_paths()
    token = _github_bearer_value(paths["GH_TOKEN"])
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
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        err_txt = ""
        try:
            err_txt = exc.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            pass
        if exc.code == 401:
            logging.getLogger("forge.common").warning(
                "GitHub API 401 Unauthorized — check GH_TOKEN or GITHUB_TOKEN (repo scope, not expired). %s",
                err_txt or exc.reason,
            )
        elif exc.code not in (404,):
            logging.getLogger("forge.common").warning(
                "GitHub API HTTP %s: %s %s", exc.code, exc.reason, err_txt
            )
        raise
    return json.loads(body) if body else {}

