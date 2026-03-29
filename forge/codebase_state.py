"""
Синхронизация ``codebase`` в ``.osnova/state.yaml`` для Brain / диагностики.

``implemented`` — все непустые ``src/**/*.ts`` на диске.
``pending`` — пути ``*.ts`` из ``scope`` pending-ATM, которых нет среди implemented
(файл отсутствует или пустой).
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

try:
    from forge.atm_store import get_pending_atms, load_all_atms_from_disk
    from forge.common import atomic_write_text, setup_logging
except ImportError:  # pragma: no cover
    from atm_store import get_pending_atms, load_all_atms_from_disk
    from common import atomic_write_text, setup_logging

LOG = setup_logging("codebase_state")

# Блок ``codebase:`` и все строки с отступом до следующего ключа верхнего уровня.
# Только (?m), без DOTALL: иначе ``.*`` пересекает ``\n`` и съедает ключи вроде ``testcommands:``.
_CODEBASE_BLOCK_RE = re.compile(r"(?m)^codebase:\n(?:^[ \t][^\n]*\n)*")


def _discover_epic_ids(epics_root: Path) -> list[str]:
    ids: set[str] = set()
    if not epics_root.is_dir():
        return []
    for f in epics_root.glob("EPK-*.yaml"):
        ids.add(f.stem)
    for d in epics_root.iterdir():
        if d.is_dir() and d.name.startswith("EPK-"):
            ids.add(d.name)
    return sorted(ids)


def _ts_nonempty(path: Path) -> bool:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return False
    return len(raw.replace("\ufeff", "").strip()) > 0


def scan_implemented_ts(project: Path) -> list[str]:
    """Все ``src/**/*.ts`` с непустым содержимым, пути с ``/``."""
    src = project / "src"
    if not src.is_dir():
        return []
    out: list[str] = []
    for p in sorted(src.rglob("*.ts")):
        if p.is_file() and _ts_nonempty(p):
            rel = p.relative_to(project).as_posix()
            if rel.startswith("src/"):
                out.append(rel)
    return out


def _atom_scope_lines(atom: dict[str, Any]) -> list[str]:
    sc = atom.get("scope")
    if isinstance(sc, list):
        return [str(x).strip() for x in sc if str(x).strip()]
    if isinstance(sc, str) and sc.strip():
        return [sc.strip()]
    return []


def collect_pending_ts_paths(project: Path, implemented: set[str]) -> list[str]:
    """
    Явные ``src/**/*.ts`` из scope pending-ATM, которых нет в ``implemented``
    (нет файла или он пустой).
    """
    epics_root = project / ".osnova" / "epics"
    found: set[str] = set()
    for eid in _discover_epic_ids(epics_root):
        atoms = load_all_atms_from_disk(project, eid)
        for a in get_pending_atms(atoms):
            for raw in _atom_scope_lines(a):
                s = raw.replace("\\", "/").strip()
                if not s.endswith(".ts") or not s.startswith("src/"):
                    continue
                if s in implemented:
                    continue
                full = project / s
                if full.is_file() and _ts_nonempty(full):
                    continue
                found.add(s)
    return sorted(found)


def format_codebase_block(implemented: list[str], pending: list[str]) -> str:
    """YAML-фрагмент с выравниванием и комментариями для чтения Brain."""
    lines: list[str] = ["codebase:"]
    ci = sorted(set(implemented))
    cp = sorted(set(pending))
    if not ci:
        lines.append("  implemented: []")
    else:
        lines.append("  implemented:")
        col = max((len(f"    - {p}") for p in ci), default=0) + 2
        col = max(col, 44)
        for p in ci:
            pref = f"    - {p}"
            pad = max(2, col - len(pref))
            lines.append(f"{pref}{' ' * pad}# ✅ done")
    if not cp:
        lines.append("  pending: []")
    else:
        lines.append("  pending:")
        col = max((len(f"    - {p}") for p in cp), default=0) + 2
        col = max(col, 44)
        for p in cp:
            pref = f"    - {p}"
            pad = max(2, col - len(pref))
            lines.append(f"{pref}{' ' * pad}# ❌ not yet")
    return "\n".join(lines) + "\n"


def merge_codebase_into_state_yaml(project: Path | str) -> None:
    """Перезаписывает только секцию ``codebase:`` в ``state.yaml`` (остальной текст без изменений)."""
    root = Path(project)
    p = root / ".osnova" / "state.yaml"
    if not p.is_file():
        return
    try:
        imp = scan_implemented_ts(root)
        pend = collect_pending_ts_paths(root, set(imp))
        block = format_codebase_block(imp, pend)
        raw = p.read_text(encoding="utf-8")
        if _CODEBASE_BLOCK_RE.search(raw):
            new_raw = _CODEBASE_BLOCK_RE.sub(block, raw, count=1)
        else:
            sep = "" if raw.endswith("\n") else "\n"
            new_raw = raw.rstrip() + sep + "\n" + block
        if new_raw != raw:
            atomic_write_text(p, new_raw)
    except Exception as exc:
        LOG.warning("codebase_state: could not update state.yaml: %s", exc)
