"""osnova quota."""
from __future__ import annotations

from rich import box
from rich.table import Table

from osnova.engine import ForgeEngine
from osnova.render import console

engine = ForgeEngine()


def quota():
    """Квота Qwen и статус cursor из state.yaml."""
    st = engine.get_state()
    q = engine.get_quota_info()
    ex = st.get("executors") if isinstance(st.get("executors"), dict) else {}

    table = Table(box=box.SIMPLE, show_header=True, header_style="bold")
    table.add_column("Executor")
    table.add_column("Статус")
    table.add_column("Использовано")
    table.add_column("Лимит")

    qw_ok = q.get("qwen_available", True)
    table.add_row(
        "qwen",
        "OK" if qw_ok else "LIMIT",
        str(q.get("qwen_used", "?")),
        str(q.get("qwen_limit", "?")),
    )
    c = ex.get("cursor") if isinstance(ex.get("cursor"), dict) else {}
    table.add_row(
        "cursor",
        "OK" if c.get("available", True) else "DOWN",
        "—",
        "∞",
    )
    console.print("\n[bold]Quota[/]\n")
    console.print(table)
    console.print()
