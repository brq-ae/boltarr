"""Scan change-tracking.

Records what a scan found different vs. the last known state: new hosts,
opened/closed ports, MAC changes, hostname changes. Each type is individually
toggleable (config), and "port closed" is only recorded for ports the scan
actually covered so a shallow scan never false-flags a deeper scan's port.
"""
import os
import ipaddress
from datetime import datetime, timezone, timedelta, time as _time
from typing import Optional

from .config import get_change_tracking_config, get_change_alerts_config, get_config, save_config, local_now
from .database import get_conn
from . import notify


def classify_host(ip_str: str, subnets: list[dict], override: Optional[str]) -> str:
    """static | dynamic | unknown — override wins; else in a subnet's DHCP range = dynamic."""
    if override in ("static", "dynamic"):
        return override
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return "unknown"
    for s in subnets:
        try:
            net = ipaddress.ip_network(s.get("cidr", ""), strict=False)
        except ValueError:
            continue
        if ip in net:
            start, end = s.get("dhcp_start"), s.get("dhcp_end")
            if start and end:
                try:
                    return "dynamic" if ipaddress.ip_address(start) <= ip <= ipaddress.ip_address(end) else "static"
                except ValueError:
                    return "unknown"
            return "unknown"
    return "unknown"

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

def record(conn, ip: str, type_: str, port=None, old=None, new=None, run_id=None) -> None:
    c = _cfg()
    if not c.get("enabled") or not c.get(type_, True):
        return
    conn.execute(
        "INSERT INTO change_events (ts, ip, type, port, old_value, new_value, run_id) VALUES (?,?,?,?,?,?,?)",
        (_now(), ip, type_, port, old, new, run_id))


def record_meta(conn, ip, existed, old_mac, new_mac, old_host, new_host, run_id=None) -> None:
    if not _cfg().get("enabled"):
        return
    if not existed:
        record(conn, ip, "host_new", run_id=run_id)
        return
    if new_mac and old_mac and new_mac.lower() != old_mac.lower():
        record(conn, ip, "mac_changed", old=old_mac, new=new_mac, run_id=run_id)
    if new_host and old_host and old_host != new_host:   # only a real rename, not first discovery
        record(conn, ip, "hostname_changed", old=old_host, new=new_host, run_id=run_id)


def record_ports(conn, ip, host_id, old_open: set[int], new_open: set[int], scanned: set[int] | None, run_id=None) -> None:
    if not _cfg().get("enabled"):
        return
    for p in sorted(new_open - old_open):
        record(conn, ip, "port_opened", port=p, run_id=run_id)
    closed = [p for p in sorted(old_open - new_open) if scanned is None or p in scanned]
    for p in closed:
        record(conn, ip, "port_closed", port=p, run_id=run_id)
        # mark it closed in the DB so it's not re-detected next scan and the
        # host's port list stays accurate
        conn.execute("UPDATE ports SET state='closed' WHERE host_id=? AND port=? AND protocol='tcp'", (host_id, p))


def prune(retention_days: int | None = None) -> None:
    days = retention_days if retention_days is not None else int(_cfg().get("retention_days", 90))
    cutoff = (datetime.now(timezone.utc) - timedelta(days=max(1, days))).isoformat(timespec="seconds")
    with get_conn() as conn:
        conn.execute("DELETE FROM change_events WHERE ts < ?", (cutoff,))
        conn.commit()


# ── Alerting (ntfy summary per scan + daily digest) ───────────────────────────

_LABEL = {
    "host_new":         ("🆕", "new device",      "new devices"),
    "host_offline":     ("🔴", "went offline",    "went offline"),
    "host_online":      ("🟢", "back online",     "back online"),
    "port_opened":      ("🔓", "port opened",     "ports opened"),
    "port_closed":      ("🔒", "port closed",     "ports closed"),
    "mac_changed":      ("🔀", "MAC change",      "MAC changes"),
    "hostname_changed": ("🏷️", "hostname change", "hostname changes"),
}
_ORDER = ["host_new", "host_offline", "host_online", "port_opened", "port_closed", "mac_changed", "hostname_changed"]
_STATIC_SCOPED = ("host_new", "mac_changed", "host_offline", "host_online")


def _detail(ev: dict) -> str:
    t = ev["type"]
    if t in ("port_opened", "port_closed"):
        return f"{ev['ip']}:{ev['port']}"
    return ev["ip"]


def summarize(events: list[dict], cap: int = 6) -> str:
    by: dict[str, list] = {}
    for e in events:
        by.setdefault(e["type"], []).append(e)
    lines = []
    for t in _ORDER:
        evs = by.get(t)
        if not evs:
            continue
        icon, sing, plur = _LABEL[t]
        n = len(evs)
        details = [_detail(e) for e in evs[:cap]]
        more = f" +{n - cap} more" if n > cap else ""
        lines.append(f"{icon} {n} {sing if n == 1 else plur}: {', '.join(details)}{more}")
    return "\n".join(lines)


def is_alert_worthy(conn, ev: dict, subnets: list[dict]) -> bool:
    a = get_change_alerts_config()
    if not a.get("enabled") or not a.get(ev["type"], True):
        return False
    if ev["type"] in _STATIC_SCOPED:
        row = conn.execute(
            "SELECT static_override, no_mac_alert, no_offline_alert FROM hosts WHERE ip=?",
            (ev["ip"],)).fetchone()
        override = row["static_override"] if row else None
        if classify_host(ev["ip"], subnets, override) != "static":   # scoped to static IPs
            return False
        if ev["type"] == "mac_changed" and row and row["no_mac_alert"]:
            return False
        if ev["type"] in ("host_offline", "host_online") and row and row["no_offline_alert"]:
            return False
    return True


def _worthy_events(conn, where_sql: str, params: tuple) -> list[dict]:
    subnets = [dict(s) for s in conn.execute("SELECT cidr, dhcp_start, dhcp_end FROM subnets")]
    evs = [dict(r) for r in conn.execute(f"SELECT * FROM change_events WHERE {where_sql}", params)]
    return [e for e in evs if is_alert_worthy(conn, e, subnets)]


def send_scan_summary(run_id: int, target_label: str = "") -> None:
    """One ntfy summary of a scan's alert-worthy changes (respects quiet hours)."""
    a = get_change_alerts_config()
    if not a.get("enabled") or not a.get("on_scan") or run_id is None:
        return
    with get_conn() as conn:
        worthy = _worthy_events(conn, "run_id=?", (run_id,))
    if not worthy:
        return
    try:   # quiet hours (lazy import avoids a module cycle)
        from .monitor import in_quiet_window
        if in_quiet_window(local_now().time()):
            return
    except Exception:
        pass
    n = len(worthy)
    title = f"{n} network change{'s' if n != 1 else ''}" + (f" on {target_label}" if target_label else "")
    notify.send(title=title, message=summarize(worthy), tags=["satellite_antenna"])


def alert_transition(conn, ip: str, event_type: str) -> None:
    """Immediate ntfy alert for a single offline/online transition (quiet-hours-aware)."""
    subnets = [dict(s) for s in conn.execute("SELECT cidr, dhcp_start, dhcp_end FROM subnets")]
    if not is_alert_worthy(conn, {"type": event_type, "ip": ip}, subnets):
        return
    try:
        from .monitor import in_quiet_window
        if in_quiet_window(local_now().time()):
            return
    except Exception:
        pass
    icon, sing, _ = _LABEL.get(event_type, ("•", event_type, ""))
    host = conn.execute("SELECT hostname FROM hosts WHERE ip=?", (ip,)).fetchone()
    label = ip + (f" ({host['hostname']})" if host and host["hostname"] else "")
    notify.send(title=f"{label} {sing}",
                message=f"{label} {sing}.",
                priority="high" if event_type == "host_offline" else "default",
                tags=["red_circle"] if event_type == "host_offline" else ["green_circle"])


def send_digest() -> None:
    """Daily digest: alert-worthy changes from the last 24h."""
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat(timespec="seconds")
    with get_conn() as conn:
        worthy = _worthy_events(conn, "ts > ?", (since,))
    if worthy:
        n = len(worthy)
        notify.send(title=f"Daily digest: {n} network change{'s' if n != 1 else ''}",
                    message=summarize(worthy), tags=["sunrise"])


def maybe_send_digest() -> None:
    """Called periodically; sends the digest once per local day, past digest_time."""
    a = get_change_alerts_config()
    if not a.get("enabled") or not a.get("digest_enabled"):
        return
    try:
        hh, mm = (a.get("digest_time") or "08:00").split(":")
        target = _time(int(hh), int(mm))
    except Exception:
        return
    now_local = local_now()
    today = now_local.strftime("%Y-%m-%d")
    if now_local.time() < target or (a.get("last_digest") or "") == today:
        return
    # mark first (avoid double-send), then send
    cfg = get_config()
    cfg.setdefault("change_alerts", {})["last_digest"] = today
    save_config(cfg)
    send_digest()
