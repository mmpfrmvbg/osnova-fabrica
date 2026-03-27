from __future__ import annotations

import subprocess
from typing import Any

try:
    from forge.common import SUBPROCESS_TEXT, env_paths, resolve_executable, setup_logging
except ImportError:  # pragma: no cover
    from common import SUBPROCESS_TEXT, env_paths, resolve_executable, setup_logging

LOG = setup_logging("degradation")

_CURSOR_PROBE_HINT = (
    "Install Cursor Agent CLI (headless), not only the IDE: "
    "https://cursor.com/docs/cli/installation - then `agent` or `cursor-agent` on PATH, "
    "or set CURSORBIN to that binary's full path."
)


def _probe(cmd: list[str], timeout: int = 5) -> bool:
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False, **SUBPROCESS_TEXT
        )
        return proc.returncode == 0
    except Exception as exc:
        LOG.warning("Probe failed for %s: %s", cmd, exc)
        return False


def probe_qwen() -> bool:
    qwen = resolve_executable(env_paths()["QWENBIN"])
    ok = _probe([qwen, "--version"], timeout=15)
    if not ok:
        LOG.warning("Qwen not runnable as %s — check QWENBIN or npm global @qwen-code/qwen-code", qwen)
    return ok


def probe_cursor() -> bool:
    paths = env_paths()
    tried: list[str] = []
    for name in (paths["CURSORBIN"], "agent", "cursor-agent"):
        name = (name or "").strip()
        if not name:
            continue
        exe = resolve_executable(name)
        if exe in tried:
            continue
        tried.append(exe)
        # Prefer --version only: `agent --help` can hang or be very slow on Windows.
        if _probe([exe, "--version"], timeout=12):
            return True
        if _probe([exe, "--help"], timeout=5):
            return True
    LOG.warning("Cursor agent CLI not found. %s", _CURSOR_PROBE_HINT)
    return False


def get_available() -> dict[str, Any]:
    qwen_ok = probe_qwen()
    cursor_ok = probe_cursor()
    executors = []
    if qwen_ok:
        executors.append("qwen")
    if cursor_ok:
        executors.append("cursor")
    return {
        "qwen": qwen_ok,
        "cursor": cursor_ok,
        "executors": executors,
        "healthy": bool(executors),
    }


def resolve_executor(atom: dict[str, Any], avail: dict[str, Any]) -> str:
    preferred = atom.get("executor", "cursor")
    if avail.get(preferred):
        return preferred
    fallback = "qwen" if preferred == "cursor" else "cursor"
    if avail.get(fallback):
        LOG.warning("Executor %s unavailable, fallback to %s", preferred, fallback)
        return fallback
    LOG.error("No executor available for atom %s", atom.get("id"))
    return "none"


def main() -> None:
    LOG.info("Availability: %s", get_available())


if __name__ == "__main__":
    main()

