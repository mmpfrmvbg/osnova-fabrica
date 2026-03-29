from __future__ import annotations

import json
import logging
import os
import re
import shutil
import sys
import threading
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

# Windows defaults to cp1251 for subprocess text mode; Qwen/agent emit UTF-8.
SUBPROCESS_TEXT: dict[str, Any] = {"encoding": "utf-8", "errors": "replace"}


def ensure_stdio_utf8() -> None:
    """
    Windows: переключает stdout/stderr на UTF-8, чтобы русский текст и emoji в логах не ломались.
    Дополнительно задайте PYTHONUTF8=1 в окружении или в обёртке запуска forge.
    """
    if sys.platform != "win32":
        return
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _parse_dotenv_file(path: Path, into: dict[str, str]) -> None:
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip("'").strip('"').lstrip("\ufeff")
            if key:
                into[key] = value
    except Exception:
        pass


def _load_dotenv_defaults() -> dict[str, str]:
    """
    Merge KEY=VALUE from (in order, later overrides): forge/.env, /opt/osnova-forge/.env,
    then ``<OSNOVA_PROJECT>/.env`` so repo-root secrets (e.g. CURSOR_API_KEY) load when only
    ``forge/.env`` sets OSNOVA_PROJECT.
    ``os.environ`` still wins where callers use ``os.environ.get`` first.
    """
    data: dict[str, str] = {}
    forge_dir = Path(__file__).resolve().parent
    fi = forge_dir / ".env"
    if fi.exists():
        _parse_dotenv_file(fi, data)
    opt = Path("/opt/osnova-forge/.env")
    if opt.exists():
        _parse_dotenv_file(opt, data)
    project = (os.environ.get("OSNOVA_PROJECT") or data.get("OSNOVA_PROJECT") or "").strip()
    if project:
        pe = Path(project) / ".env"
        if pe.exists():
            _parse_dotenv_file(pe, data)
    return data


_tls = threading.local()


def set_thread_project(path: str | None) -> None:
    """Per-thread override for ``OSNOVA_PROJECT`` (e.g. parallel wave worktrees). ``None`` clears."""
    if path is None:
        if hasattr(_tls, "osnova_project"):
            delattr(_tls, "osnova_project")
    else:
        _tls.osnova_project = path


def get_thread_project() -> str | None:
    return getattr(_tls, "osnova_project", None)


def env_paths() -> dict[str, str]:
    dot = _load_dotenv_defaults()
    home = os.path.expanduser("~")
    thread_proj = get_thread_project()
    if thread_proj is not None and str(thread_proj).strip():
        project = str(thread_proj).strip()
    else:
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


def secret_from_env_or_forge_dotenv(key: str) -> str:
    """Secrets for child processes: ``os.environ`` wins, else merged forge + project ``.env`` (see _load_dotenv_defaults)."""
    v = os.environ.get(key, "").strip()
    if v:
        return v
    return (_load_dotenv_defaults().get(key) or "").strip()


def forge_dotenv_setting(key: str, default: str = "") -> str:
    """Non-secret settings: ``os.environ`` wins, else merged forge + project ``.env``."""
    v = os.environ.get(key, "").strip()
    if v:
        return v
    return (_load_dotenv_defaults().get(key) or default).strip()


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
        # npm global shims: subprocess without shell often misses PATH; scan typical dirs
        if "/" not in s and "\\" not in s and ":" not in s:
            npm_dirs: list[Path] = []
            appdata = os.environ.get("APPDATA", "").strip()
            if appdata:
                npm_dirs.append(Path(appdata) / "npm")
            local = os.environ.get("LOCALAPPDATA", "").strip()
            if local:
                npm_dirs.append(Path(local) / "npm")
            npm_dirs.append(Path.home() / "AppData" / "Roaming" / "npm")
            seen: set[str] = set()
            for d in npm_dirs:
                try:
                    dr = d.resolve()
                except OSError:
                    continue
                key = str(dr)
                if key in seen:
                    continue
                seen.add(key)
                for name in (f"{s}.cmd", f"{s}.CMD", f"{s}.bat", f"{s}.exe"):
                    cand = dr / name
                    try:
                        if cand.is_file():
                            return str(cand.resolve())
                    except OSError:
                        pass
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


def cursor_headless_argv(
    prompt: str,
    *,
    workspace: str | None = None,
    use_stdin: bool = False,
) -> list[str]:
    """
    Cursor agent headless for atomizer: ``cursor-agent -p --yolo --trust --workspace <repo> <prompt>``.
    Matches ``forge/smith.sh`` (without the node-bundle path).

    Windows: если ``CURSORBIN`` резолвится в ``*.ps1``, ``-p`` уходит в PowerShell как чужой параметр
    (ошибка про ``name``). Тогда: ``node.exe`` + ``index.js`` из ``cursor-agent\\versions\\…``.

    - ``FORGE_ATOMIZER_CURSOR_MODEL`` — optional ``--model`` (omit if unset or ``_``).
    - If ``use_stdin`` is True, the last argument is ``-``; pass ``input=prompt`` to ``subprocess.run`` (long prompts on Windows).
    """
    raw = env_paths()["CURSORBIN"]
    exe = resolve_cursor_bin_for_smith(raw) or resolve_executable(raw)
    proj = (workspace or env_paths()["OSNOVA_PROJECT"] or "").strip() or "."
    tail: list[str] = ["-p", "--yolo", "--trust", "--workspace", proj]
    model = os.environ.get("FORGE_ATOMIZER_CURSOR_MODEL", "").strip()
    if model and model not in ("_", "-"):
        tail.extend(["--model", model])
    if use_stdin:
        tail.append("-")
    else:
        tail.append(prompt)

    if sys.platform == "win32":
        try:
            suf = Path(exe).suffix.lower()
        except OSError:
            suf = ""
        if suf == ".ps1":
            bundle = find_cursor_agent_node_bundle()
            if bundle:
                node, idx = bundle
                try:
                    return [str(node.resolve()), str(idx.resolve()), *tail]
                except OSError:
                    return [str(node), str(idx), *tail]

    return [exe, *tail]


def cursor_cli_available() -> bool:
    """True if ``CURSORBIN`` resolves to an executable (atomizer / smith)."""
    raw = (env_paths().get("CURSORBIN") or "").strip()
    if not raw:
        return False
    p = resolve_cursor_bin_for_smith(raw)
    if p:
        try:
            if Path(p).is_file():
                return True
        except OSError:
            pass
    merged = os.pathsep.join([*cursor_cli_extra_path_entries(), os.environ.get("PATH", "")])
    if shutil.which(raw, path=merged):
        return True
    if sys.platform == "win32":
        w = shutil.which(f"{raw}.exe", path=merged) if not raw.lower().endswith(".exe") else None
        if w:
            return True
    return False


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
        entries.append(Path(la) / "cursor-agent")
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


_WIN32_CURSOR_AGENT_VER_DIR = re.compile(r"^\d{4}\.\d{1,2}\.\d{1,2}-[a-f0-9]+$")


def find_cursor_agent_node_bundle() -> tuple[Path, Path] | None:
    """
    Windows: official Cursor CLI is ``agent.cmd`` / ``agent.ps1`` shims that run
    ``%LOCALAPPDATA%\\cursor-agent\\versions\\<ver>\\node.exe`` with ``index.js``.
    There is often no ``agent.exe``; Git Bash + ``.cmd`` hangs. Prefer this bundle when present.
    """
    if sys.platform != "win32":
        return None
    la = os.environ.get("LOCALAPPDATA", "").strip()
    if not la:
        return None
    base = Path(la) / "cursor-agent" / "versions"
    if not base.is_dir():
        return None
    dirs = [p for p in base.iterdir() if p.is_dir() and _WIN32_CURSOR_AGENT_VER_DIR.match(p.name)]
    if not dirs:
        return None

    def sort_key(p: Path) -> int:
        try:
            date_part = p.name.split("-")[0]
            y, m, d = date_part.split(".")
            return int(f"{y}{int(m):02d}{int(d):02d}")
        except (ValueError, IndexError):
            return 0

    merged = os.pathsep.join([*cursor_cli_extra_path_entries(), os.environ.get("PATH", "")])
    for d in sorted(dirs, key=sort_key, reverse=True):
        idx = d / "index.js"
        if not idx.is_file():
            continue
        node = d / "node.exe"
        if node.is_file():
            return (node, idx)
        wn = shutil.which("node", path=merged) or shutil.which("node.exe", path=merged)
        if wn:
            return (Path(wn), idx)
    return None


def _win32_prefer_agent_exe_over_cmd(path: Path) -> Path:
    """
    On Windows, running ``agent.cmd`` from Git Bash under ``timeout`` often hangs until SIGTERM
    with no stdout/stderr — looks like “Cursor does nothing”. Prefer ``agent.exe`` in the same
    directory when the shim points at ``.cmd``/``.bat``. If there is no sibling exe, search PATH
    (installers sometimes put ``agent.cmd`` in one dir and ``agent.exe`` elsewhere).
    """
    if sys.platform != "win32":
        return path
    try:
        rp = path.resolve()
        if rp.suffix.lower() not in (".cmd", ".bat"):
            return path
        parent = rp.parent
        for name in ("agent.exe", "cursor-agent.exe"):
            cand = parent / name
            if cand.is_file():
                return cand
        merged = os.pathsep.join([*cursor_cli_extra_path_entries(), os.environ.get("PATH", "")])
        for exe_name in ("agent.exe", "cursor-agent.exe"):
            w = shutil.which(exe_name, path=merged)
            if w:
                wp = Path(w)
                if wp.is_file():
                    return wp
    except OSError:
        pass
    return path


def _finalize_cursor_bin(p: Path) -> str:
    return _path_for_git_bash(_win32_prefer_agent_exe_over_cmd(p))


def resolve_cursor_bin_for_smith(raw: str) -> str:
    """
    Resolve CURSORBIN for smith.sh: full path when possible so GNU timeout finds the binary.
    On Windows, if the resolved file is ``agent.cmd``, use sibling ``agent.exe`` when present.
    """
    s = (raw or "").strip()
    if not s:
        return ""
    try:
        p = Path(s)
        if p.is_file():
            return _finalize_cursor_bin(p)
    except OSError:
        pass
    r = resolve_executable(s)
    if r:
        try:
            rp = Path(r)
            if rp.is_file():
                return _finalize_cursor_bin(rp)
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
                return _finalize_cursor_bin(wp)
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
                    return _finalize_cursor_bin(cand)
            except OSError:
                continue
    try:
        ps = Path(s)
        if ps.is_file():
            return _finalize_cursor_bin(ps)
    except OSError:
        pass
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


def write_smith_agent_prompt(project: Path) -> str:
    """
    Write ``.osnova/smith-agent-prompt.txt`` from ``.osnova/task.yaml``.
    Same text as the embedded Python block in ``forge/smith.sh``.
    """
    osnova = project / ".osnova"
    osnova.mkdir(parents=True, exist_ok=True)
    task = osnova / "task.yaml"
    out = osnova / "smith-agent-prompt.txt"
    with task.open("r", encoding="utf-8") as f:
        d = yaml.safe_load(f) or {}
    atm_id = str(d.get("id", "UNKNOWN"))
    text = f"""OSNOVA Forge — execute one ATM (atom).

Read the full atom definition in this YAML file (open it with your tools):
{task.resolve().as_posix()}

Workspace (git repo root):
{project.resolve().as_posix()}

Follow goal, scope, steps, and priority from that file. Respect notouch paths.
Make concrete file edits; be minimal. When finished, the atom's `done` command should be runnable from the repo root.
"""
    out.write_text(text, encoding="utf-8")
    return atm_id


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
        "forge_loop_pid": None,
        "consecutive_failures": 0,
        "current_epic": None,
        "brain_source": "idle",
        "current_epic_issue": None,
        "current_epic_started_at": None,
        "last_epic_received_at": None,
        "forge_started_at": None,
        "idle_streak_index": 0,
        "issue_attempts": {},
    }
    state = load_json(forge_state_path(), default=default) or default
    for k, v in default.items():
        state.setdefault(k, v)
    if state.get("forge_started_at") is None:
        state["forge_started_at"] = now_iso()
    if not isinstance(state.get("issue_attempts"), dict):
        state["issue_attempts"] = {}
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


def gh_request(method: str, api_path: str, payload: dict[str, Any] | None = None) -> Any:
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

