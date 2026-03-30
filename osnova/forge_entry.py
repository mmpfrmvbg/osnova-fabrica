"""Console entry ``forge`` → ``osnova forge`` (избегает конфликта с каталогом ``forge/`` в репозитории)."""
from __future__ import annotations

import sys

from osnova.cli import app


def main() -> None:
    sys.argv = ["osnova", "forge", *sys.argv[1:]]
    app()


if __name__ == "__main__":
    main()
