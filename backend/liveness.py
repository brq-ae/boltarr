"""Host liveness (ping tier).

A light background loop runs `nmap -sn` per subnet every N minutes to detect
which known hosts are online. A host is marked offline after `offline_after`
consecutive missed sweeps, and back online on the first response. Static-host
transitions record a change event and fire an immediate ntfy alert.
"""
import subprocess
import threading
from datetime import datetime, timezone

import nmap

from .database import get_conn
from .config import get_liveness_config
from . import changes


def _host_event(conn, host_id: int, status: str) -> None:
    """Record an up/down transition for host uptime history."""
    conn.execute("INSERT INTO host_events (host_id, status, ts) VALUES (?, ?, ?)",
                 (host_id, status, datetime.now(timezone.utc).isoformat(timespec="seconds")))

_thread: threading.Thread | None = None
_stop = threading.Event()


def _sweep_live_ips() -> set[str]:
    """Live IPs across all defined subnets via nmap -sn (ARP/ping)."""
    with get_conn() as conn:
        cidrs = [r["cidr"] for r in conn.execute("SELECT cidr FROM subnets")]
    live: set[str] = set()
    for cidr in cidrs:
        try:
            proc = subprocess.run(
                ["nmap", "-sn", "-T4", "--min-parallelism", "10", "-oX", "-", cidr],
                capture_output=True, timeout=120)
            nm = nmap.PortScanner()
            nm.analyse_nmap_xml_scan(proc.stdout.decode("utf-8", "replace"))
            live.update(nm.all_hosts())
        except Exception:
            pass
    return live


def sweep_once() -> None:
    cfg = get_liveness_config()
    if not cfg.get("enabled"):
        return
    offline_after = max(1, int(cfg.get("offline_after", 3)))
    live = _sweep_live_ips()
    with get_conn() as conn:
        # Seed a starting uptime event for hosts that have a state but no history
        # yet — so an always-up host (which never transitions) still accrues uptime.
        conn.execute("""
            INSERT INTO host_events (host_id, status, ts)
            SELECT id, CASE WHEN online=1 THEN 'up' ELSE 'down' END, ?
            FROM hosts
            WHERE online IS NOT NULL AND ip NOT LIKE 'node-%'
              AND id NOT IN (SELECT DISTINCT host_id FROM host_events)
        """, (datetime.now(timezone.utc).isoformat(timespec="seconds"),))
        hosts = [dict(r) for r in conn.execute(
            "SELECT id, ip, online, miss_count FROM hosts WHERE ip NOT LIKE 'node-%'")]
        for h in hosts:
            ip, was = h["ip"], h["online"]
            if ip in live:
                conn.execute("UPDATE hosts SET online=1, miss_count=0, last_seen=datetime('now') WHERE id=?", (h["id"],))
                if was != 1:                      # None/0 -> up: record uptime event
                    _host_event(conn, h["id"], "up")
                if was == 0:                      # offline -> back online
                    changes.record(conn, ip, "host_online")
                    conn.commit()
                    changes.alert_transition(conn, ip, "host_online")
            else:
                miss = (h["miss_count"] or 0) + 1
                if miss >= offline_after and was == 1:     # online -> offline
                    conn.execute("UPDATE hosts SET online=0, miss_count=? WHERE id=?", (miss, h["id"]))
                    _host_event(conn, h["id"], "down")
                    changes.record(conn, ip, "host_offline")
                    conn.commit()
                    changes.alert_transition(conn, ip, "host_offline")
                elif miss >= offline_after and was is None:  # never seen up -> mark offline (seed)
                    conn.execute("UPDATE hosts SET online=0, miss_count=? WHERE id=?", (miss, h["id"]))
                    _host_event(conn, h["id"], "down")
                else:
                    conn.execute("UPDATE hosts SET miss_count=? WHERE id=?", (miss, h["id"]))
        conn.commit()


def _loop() -> None:
    _stop.wait(15)   # let startup settle
    while not _stop.is_set():
        try:
            sweep_once()
        except Exception:
            pass
        interval = max(1, int(get_liveness_config().get("interval_minutes", 3))) * 60
        _stop.wait(interval)


def start_liveness() -> None:
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="liveness", daemon=True)
    _thread.start()
