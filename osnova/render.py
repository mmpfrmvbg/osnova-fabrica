"""Rich tables and panels for CLI output."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from rich import box
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

console = Console()

STATUS_ICON = {"OK": "✅", "BLK": "❌", "RUN": "🔄", "SKIP": "⏭", "WAIT": "⏳"}
STATUS_COLOR = {"OK": "green", "BLK": "red", "RUN": "yellow", "SKIP": "dim", "WAIT": ""}
PRIORITY_COLOR = {"P0": "bold red", "P1": "red", "P2": "cyan", "P3": "dim"}


def atm_status_icon(s: str) -> str:
    return STATUS_ICON.get(s, "❓")


def make_atm_table(atms: list[dict[str, Any]], title: str = "") -> Table:
    table = Table(
        title=title or None,
        show_header=True,
        header_style="bold cyan",
        box=box.SIMPLE,
        expand=False,
    )
    table.add_column("#", style="dim", width=4)
    table.add_column("", width=3)
    table.add_column("Stat", width=5)
    table.add_column("Goal / id", width=46)
    table.add_column("Time", width=7, justify="right")
    table.add_column("Exec", width=8)

    for idx, atm in enumerate(atms, 1):
        s = str(atm.get("s") or "WAIT").upper()
        icon = atm_status_icon(s)
        color = STATUS_COLOR.get(s, "")
        elapsed = atm.get("elapsed_s")
        if elapsed is None:
            elapsed = atm.get("elapsed")
        elapsed_str = f"{elapsed}s" if elapsed is not None else "—"
        goal = str(atm.get("goal") or atm.get("id") or "")[:46]

        table.add_row(
            str(idx),
            icon,
            f"[{color}]{s}[/]" if color else s,
            goal,
            elapsed_str,
            str(atm.get("executor", "?")),
            style="on dark_red" if s == "BLK" else "",
        )
    return table


def make_progress_bar(ok: int, total: int, width: int = 28) -> str:
    if total == 0:
        return "—"
    filled = int(width * ok / total)
    bar = "█" * filled + "░" * (width - filled)
    return f"{bar}  {ok}/{total}"


def make_passrate_line(passrate: float, target: float = 0.80) -> Text:
    t = Text()
    t.append("Passrate: ")
    color = "green" if passrate >= target else "yellow" if passrate >= 0.60 else "red"
    t.append(f"{passrate:.0%}", style=f"bold {color}")
    t.append(f"  target: {target:.0%}", style="dim")
    return t


def make_health_panel(health: dict[str, Any]) -> Panel:
    forge = health.get("forge", {})
    executors = health.get("executors", {})
    stats = health.get("stats", {})

    fs = forge.get("status", "?")
    forge_color = {"ALIVE": "green", "SLOW": "yellow", "STALE": "red", "DEAD": "bold red"}.get(
        str(fs), ""
    )
    line1 = (
        f"Forge: [{forge_color}]{fs}[/]  "
        f"[dim]{forge.get('detail', '')}[/]  "
        f"systemd: {forge.get('systemd', '?')}"
    )
    if forge.get("paused"):
        line1 += "  [yellow]PAUSED[/]"

    qwen_ok = executors.get("qwen", True)
    cursor_ok = executors.get("cursor", True)
    line2 = (
        f"Executors: qwen [{'green' if qwen_ok else 'red'}]"
        f"{'OK' if qwen_ok else 'DOWN'}[/]  "
        f"cursor [{'green' if cursor_ok else 'red'}]{'OK' if cursor_ok else 'DOWN'}[/]"
    )

    pr = float(stats.get("passrate") or 0)
    pr_color = "green" if pr >= 0.8 else "yellow" if pr >= 0.6 else "red"
    line3 = (
        f"Session stats: [{pr_color}]{pr:.0%}[/]  "
        f"OK {stats.get('atms_ok', 0)}  BLK {stats.get('atms_blk', 0)}  "
        f"epics received {stats.get('epics_today', 0)}"
    )

    ci = health.get("ci") if isinstance(health.get("ci"), dict) else {}
    open_n = int(ci.get("openblockerissues") or 0)
    line4 = f"CI openblockerissues (counter): [bold]{open_n}[/]"

    blockers_raw = health.get("blockers") if isinstance(health.get("blockers"), list) else []
    blocker_lines: list[str] = []
    for b in blockers_raw:
        if not isinstance(b, dict):
            continue
        if not b.get("open", True):
            continue
        blocker_lines.append(
            f"  issue [cyan]#{b.get('issue')}[/]  [dim]{b.get('atm_id', '?')}[/]"
        )
    if blocker_lines:
        line5 = "[bold]Blockers[/] ([dim]state.yaml blockers:[/])\n" + "\n".join(
            blocker_lines[:25]
        )
        if len(blocker_lines) > 25:
            line5 += f"\n  [dim]… +{len(blocker_lines) - 25}[/]"
        body = "\n".join([line1, line2, line3, line4, "", line5])
    else:
        body = "\n".join([line1, line2, line3, line4, "[dim]Blockers: (none open)[/]"])

    return Panel(body, title="[bold cyan]OSNOVA Health[/]", expand=False)


def make_epic_table(rows: list[dict[str, Any]]) -> Table:
    table = Table(show_header=True, header_style="bold", box=box.SIMPLE, expand=False)
    table.add_column("ID", width=22)
    table.add_column("Pri", width=5)
    table.add_column("Goal", width=48)
    for row in rows:
        pid = str(row.get("id", "?"))[:22]
        prio = str(row.get("priority", "?"))
        goal = str(row.get("goal", ""))[:48]
        table.add_row(
            pid,
            f"[{PRIORITY_COLOR.get(prio, '')}]{prio}[/]",
            goal,
        )
    return table


def fmt_ts(ts: Optional[str]) -> str:
    if not ts:
        return "—"
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        ago = (datetime.now(timezone.utc) - dt).total_seconds()
        if ago < 60:
            return f"{ago:.0f}s ago"
        if ago < 3600:
            return f"{ago / 60:.0f}m ago"
        return f"{ago / 3600:.1f}h ago"
    except Exception:
        return str(ts)[:16]
