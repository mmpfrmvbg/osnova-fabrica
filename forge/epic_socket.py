from __future__ import annotations

import json
import socket
import sys
from typing import Any

try:
    from forge.common import epic_socket_path, setup_logging
except ImportError:  # pragma: no cover
    from common import epic_socket_path, setup_logging

LOG = setup_logging("epic_socket")

_listener_sock: socket.socket | None = None


def _unix_supported() -> bool:
    return hasattr(socket, "AF_UNIX")


def ensure_listener() -> socket.socket | None:
    """Bind Unix stream socket for GHA notify. Returns None on Windows or bind failure."""
    global _listener_sock
    if not _unix_supported():
        return None
    if _listener_sock is not None:
        return _listener_sock
    path = epic_socket_path()
    try:
        if path.exists():
            path.unlink()
    except OSError as exc:
        LOG.warning("Could not remove stale epic socket %s: %s", path, exc)
        return None
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.bind(str(path))
        sock.listen(5)
        timeout = int(__import__("os").environ.get("FORGE_EPIC_SOCKET_TIMEOUT", "120"))
        sock.settimeout(float(timeout))
        _listener_sock = sock
        LOG.info("Epic listener on %s", path)
        return sock
    except OSError as exc:
        LOG.warning("Epic socket not available: %s", exc)
        return None


def accept_epic_event() -> dict[str, Any] | None:
    """Block until GHA sends JSON {\"issue_number\": N} or socket timeout."""
    sock = ensure_listener()
    if sock is None:
        return None
    try:
        conn, _ = sock.accept()
        try:
            data = b""
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
            if not data:
                return None
            return json.loads(data.decode("utf-8"))
        finally:
            conn.close()
    except socket.timeout:
        LOG.debug("Epic socket timeout — poll fallback")
        return None
    except Exception as exc:
        LOG.warning("Epic socket accept error: %s", exc)
        return None


def close_listener() -> None:
    global _listener_sock
    if _listener_sock is not None:
        try:
            _listener_sock.close()
        finally:
            _listener_sock = None
    try:
        epic_socket_path().unlink(missing_ok=True)
    except OSError:
        pass


def main() -> None:
    ensure_listener()
    ev = accept_epic_event()
    LOG.info("event=%s", ev)


if __name__ == "__main__":
    main()
    sys.exit(0)
