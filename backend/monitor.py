"""Service uptime monitor.

A lightweight background loop that probes services flagged `monitored=1`
every CHECK_INTERVAL seconds and records whether each is reachable.

Step 1 scope: probing + live up/down status only. No alerts, no maintenance
windows, no history yet — those come in later steps.

Probe rule (reachable = up):
  - If the service has a URL  -> HTTP(S) GET; ANY response counts as up
    (even 401/403/500 means the server is alive). Connect error / timeout = down.
  - else if it has a port     -> open a TCP connection to host_ip:port.
  - else                      -> cannot probe; left as 'unknown'.
"""
import socket
import threading
import time
from datetime import datetime, timezone

import httpx

from .database import get_conn

CHECK_INTERVAL = 60          # seconds between sweeps
HTTP_TIMEOUT   = 6           # seconds per HTTP probe
TCP_TIMEOUT    = 5           # seconds per TCP probe

_thread: threading.Thread | None = None
_stop = threading.Event()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _probe_http(url: str) -> bool:
    try:
        # verify=False: homelab services often use self-signed certs; we only
        # care whether the service answers, not whether the cert is trusted.
        with httpx.Client(timeout=HTTP_TIMEOUT, verify=False, follow_redirects=True) as c:
            c.get(url)
        return True
    except Exception:
        return False


def _probe_tcp(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=TCP_TIMEOUT):
            return True
    except Exception:
        return False


def probe(service: dict) -> str:
    """Return 'up' or 'down' for a service dict (needs url or ip+port)."""
    url = (service.get("url") or "").strip()
    if url:
        return "up" if _probe_http(url) else "down"
    host = service.get("ip")
    port = service.get("port")
    if host and port:
        return "up" if _probe_tcp(host, int(port)) else "down"
    return "unknown"


def _monitored_services(conn) -> list[dict]:
    rows = conn.execute("""
        SELECT s.id, s.url, s.port, s.monitor_status, h.ip
        FROM services s JOIN hosts h ON s.host_id = h.id
        WHERE s.monitored = 1
    """).fetchall()
    return [dict(r) for r in rows]


def _apply_result(conn, svc_id: int, prev: str, new: str) -> None:
    now = _now()
    if new != prev:
        conn.execute(
            "UPDATE services SET monitor_status=?, monitor_last_check=?, monitor_last_change=? WHERE id=?",
            (new, now, now, svc_id),
        )
    else:
        conn.execute(
            "UPDATE services SET monitor_status=?, monitor_last_check=? WHERE id=?",
            (new, now, svc_id),
        )


def check_now(svc_id: int) -> dict:
    """Probe a single service immediately and persist the result.
    Used for instant feedback when the user toggles monitoring on."""
    with get_conn() as conn:
        row = conn.execute("""
            SELECT s.id, s.url, s.port, s.monitor_status, h.ip
            FROM services s JOIN hosts h ON s.host_id = h.id
            WHERE s.id = ?
        """, (svc_id,)).fetchone()
        if not row:
            return {"status": "unknown"}
        svc = dict(row)
        new = probe(svc)
        _apply_result(conn, svc_id, svc.get("monitor_status") or "unknown", new)
        conn.commit()
        return {"status": new, "checked_at": _now()}


def _sweep() -> None:
    with get_conn() as conn:
        services = _monitored_services(conn)
    for svc in services:
        new = probe(svc)
        with get_conn() as conn:
            _apply_result(conn, svc["id"], svc.get("monitor_status") or "unknown", new)
            conn.commit()


def _loop() -> None:
    # small delay so it doesn't fight app startup
    _stop.wait(3)
    while not _stop.is_set():
        try:
            _sweep()
        except Exception:
            pass
        _stop.wait(CHECK_INTERVAL)


def start_monitor() -> None:
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="service-monitor", daemon=True)
    _thread.start()
