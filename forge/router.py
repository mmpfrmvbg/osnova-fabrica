from __future__ import annotations

from pathlib import Path
from typing import Any

try:
    from forge.common import env_paths, load_yaml, setup_logging
    from forge.degradation import resolve_executor
except ImportError:  # pragma: no cover
    from common import env_paths, load_yaml, setup_logging
    from degradation import resolve_executor

LOG = setup_logging("router")


def _scope_text(atom: dict[str, Any]) -> str:
    scope = atom.get("scope", [])
    if isinstance(scope, str):
        return scope
    return "\n".join(str(s) for s in scope)


def _primary_scope_paths(atom: dict[str, Any]) -> list[str]:
    """
    Path-ish prefix before description (—/–). Avoids matching `.yaml` inside
    Russian prose like «pipeline.yaml» when the real target is orchestrator.ts.
    """
    scope = atom.get("scope", [])
    rows: list[str] = []
    if isinstance(scope, str):
        rows = [scope]
    else:
        rows = [str(s) for s in scope]
    out: list[str] = []
    for raw in rows:
        segment = raw
        for sep in ("—", "–", " - "):
            if sep in segment:
                segment = segment.split(sep, 1)[0]
                break
        segment = segment.strip()
        if segment:
            out.append(segment)
    return out


_CODE_SUFFIXES = (
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".rs",
    ".go",
    ".py",
    ".java",
    ".kt",
    ".vue",
    ".svelte",
)
_CONFIG_SUFFIXES = (".yaml", ".yml", ".json", ".toml")


def choose_executor(atom: dict[str, Any], avail: dict[str, Any]) -> str:
    scope = _scope_text(atom)
    paths = _primary_scope_paths(atom)
    paths_l = [p.lower() for p in paths]
    risk = str(atom.get("risk", "")).upper()
    zone = str(atom.get("zone", "")).lower()
    priority = str(atom.get("priority", "")).upper()

    chosen = "cursor"
    if priority == "P0":
        chosen = "cursor"
    elif risk == "HIGH":
        chosen = "cursor"
    elif ".github/" in scope or ".github/workflows" in scope:
        chosen = "cursor"
    elif any(p.startswith("tests/") or "/tests/" in p for p in paths_l):
        chosen = "qwen"
    elif scope.strip().startswith("tests/") or "tests/" in scope:
        chosen = "qwen"
    elif (".test.ts" in scope) or (".spec.ts" in scope):
        # tests/*.test.ts → qwen; src/** (compiler/runtime) tests → Cursor — same process as prod code
        if any(
            pl.startswith("tests/")
            or pl.startswith("test/")
            or "/__tests__/" in pl
            for pl in paths_l
        ):
            chosen = "qwen"
        elif any("/src/" in pl or pl.startswith("src/") for pl in paths_l):
            chosen = "cursor"
        else:
            chosen = "qwen"
    elif any(pl.endswith(suf) for pl in paths_l for suf in _CODE_SUFFIXES):
        chosen = "cursor"
    elif any(pl.endswith(".md") for pl in paths_l):
        chosen = "qwen"
    elif any(pl.endswith(suf) for pl in paths_l for suf in _CONFIG_SUFFIXES):
        chosen = "qwen"
    elif zone == "infra" and risk == "LOW":
        chosen = "qwen"
    elif zone == "lang" and risk == "LOW":
        chosen = "qwen"
    elif zone == "lang" and risk == "MEDIUM":
        chosen = "cursor"
    atom["executor"] = chosen
    return resolve_executor(atom, avail)


def load_rules() -> dict[str, Any]:
    p = Path(env_paths()["OSNOVA_FORGE"]) / "router.yaml"
    return load_yaml(p, default={}) or {}


def main() -> None:
    LOG.info("router rules loaded: %s", bool(load_rules()))


if __name__ == "__main__":
    main()

