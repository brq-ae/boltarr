"""Scan change-tracking.

Records what a scan found different vs. the last known state: new hosts,
opened/closed ports, MAC changes, hostname changes. Each type is individually
toggleable (config), and "port closed" is only recorded for ports the scan
actually covered so a shallow scan never false-flags a deeper scan's port.
"""
import os
from datetime import datetime, timezone, timedelta

from .config import get_change_tracking_config
from .database import get_conn

_NMAP_SERVICES_PATHS = [
    "/usr/share/nmap/nmap-services",
    "/usr/local/share/nmap/nmap-services",
    "/opt/homebrew/share/nmap/nmap-services",
]
_ranked_tcp: list[int] | None = None
_top_cache: dict[int, set[int]] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _cfg() -> dict:
    return get_change_tracking_config()


# ── nmap top-ports (so 'port closed' is scoped to what a scan covered) ─────────

def _load_ranked_tcp() -> list[int]:
    global _ranked_tcp
    if _ranked_tcp is not None:
        return _ranked_tcp
    path = next((p for p in _NMAP_SERVICES_PATHS if os.path.exists(p)), None)
    ranked: list[tuple[float, int]] = []
    if path:
        try:
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    parts = line.split()
                    if len(parts) < 3 or not parts[1].endswith("/tcp"):
                        continue
                    try:
                        ranked.append((float(parts[2]), int(parts[1].split("/")[0])))
                    except ValueError:
                        continue
            # highest frequency first; ties broken by lower port number (so the
            # top-N favours common ports, matching nmap's intent, not obscure
            # high ports that merely share a boundary frequency)
            ranked.sort(key=lambda x: (-x[0], x[1]))
        except Exception:
            ranked = []
    _ranked_tcp = [p for _, p in ranked]
    return _ranked_tcp


def top_ports(n: int) -> set[int]:
    if n not in _top_cache:
        _top_cache[n] = set(_load_ranked_tcp()[:n])
    return _top_cache[n]


def _parse_port_range(spec: str) -> set[int]:
    out: set[int] = set()
    for part in (spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            if "-" in part:
                a, b = part.split("-", 1)
                out.update(range(int(a), int(b) + 1))
            else:
                out.add(int(part))
        except ValueError:
            pass
    return out


def scanned_ports(opts: dict) -> set[int] | None:
    """TCP ports a scan with these options covers. None = all; empty = none."""
    p = (opts or {}).get("ports", "top1000")
    if p == "all":
        return None
    if p == "none":
        return set()
    if p == "custom":
        return _parse_port_range(opts.get("port_range", ""))
    if p == "topN":
        return top_ports(int(opts.get("top_n") or 100))
    return top_ports(1000)   # top1000 (default)


# ── Recording ─────────────────────────────────────────────────────────────────

def record(conn, ip: str, type_: str, port=None, old=None, new=None) -> None:
    c = _cfg()
    if not c.get("enabled") or not c.get(type_, True):
        return
    conn.execute(
        "INSERT INTO change_events (ts, ip, type, port, old_value, new_value) VALUES (?,?,?,?,?,?)",
        (_now(), ip, type_, port, old, new))


def record_meta(conn, ip, existed, old_mac, new_mac, old_host, new_host) -> None:
    if not _cfg().get("enabled"):
        return
    if not existed:
        record(conn, ip, "host_new")
        return
    if new_mac and old_mac and new_mac.lower() != old_mac.lower():
        record(conn, ip, "mac_changed", old=old_mac, new=new_mac)
    if new_host and old_host and old_host != new_host:   # only a real rename, not first discovery
        record(conn, ip, "hostname_changed", old=old_host, new=new_host)


def record_ports(conn, ip, host_id, old_open: set[int], new_open: set[int], scanned: set[int] | None) -> None:
    if not _cfg().get("enabled"):
        return
    for p in sorted(new_open - old_open):
        record(conn, ip, "port_opened", port=p)
    closed = [p for p in sorted(old_open - new_open) if scanned is None or p in scanned]
    for p in closed:
        record(conn, ip, "port_closed", port=p)
        # mark it closed in the DB so it's not re-detected next scan and the
        # host's port list stays accurate
        conn.execute("UPDATE ports SET state='closed' WHERE host_id=? AND port=? AND protocol='tcp'", (host_id, p))


def prune(retention_days: int | None = None) -> None:
    days = retention_days if retention_days is not None else int(_cfg().get("retention_days", 90))
    cutoff = (datetime.now(timezone.utc) - timedelta(days=max(1, days))).isoformat(timespec="seconds")
    with get_conn() as conn:
        conn.execute("DELETE FROM change_events WHERE ts < ?", (cutoff,))
        conn.commit()
