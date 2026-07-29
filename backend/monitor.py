"""Service uptime monitor.

Background loop that probes services flagged `monitored=1` every
CHECK_INTERVAL seconds, records live up/down status, and (Step 2) sends
ntfy alerts when a service stays down past the configured grace period,
and again when it recovers.

Probe rule (reachable = up):
  - URL present  -> HTTP(S) GET; ANY response = up. Connect error/timeout = down.
  - else port    -> TCP connect to host_ip:port.
  - else         -> 'unknown' (cannot probe).

Alerting: the live status/dot flips to 'down' on the first failed probe,
but a down-ALERT only fires once the service has been continuously down for
`alert_after_minutes` (config, default 5). A recovery alert fires when it
comes back, but only if a down-alert had been sent.
"""
import socket
import threading
from datetime import datetime, timezone, time as time_of_day

import httpx

from .database import get_conn
from .config import get_monitoring_config
from . import notify

CHECK_INTERVAL = 60          # seconds between sweeps
HTTP_TIMEOUT   = 6           # seconds per HTTP probe
TCP_TIMEOUT    = 5           # seconds per TCP probe

_thread: threading.Thread | None = None
_stop = threading.Event()

_SELECT = """
    SELECT s.id, s.name, s.url, s.port, s.monitor_status,
           s.monitor_fail_since, s.monitor_alerted, h.ip, h.hostname
    FROM services s JOIN hosts h ON s.host_id = h.id
"""


def _now_dt() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def _parse(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso)
    except Exception:
        return None


def _fmt_duration(seconds: float) -> str:
    m = int(seconds // 60)
    if m < 60:
        return f"{m} min"
    h, m = divmod(m, 60)
    return f"{h} h {m} min" if m else f"{h} h"


# ── Probing ───────────────────────────────────────────────────────────────────

def _probe_http(url: str) -> bool:
    try:
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
    url = (service.get("url") or "").strip()
    if url:
        return "up" if _probe_http(url) else "down"
    host = service.get("ip")
    port = service.get("port")
    if host and port:
        return "up" if _probe_tcp(host, int(port)) else "down"
    return "unknown"


# ── Alert-state evaluation (pure, unit-testable) ──────────────────────────────

def evaluate(prev: str, new: str, fail_since: str | None, alerted: int,
             grace_seconds: int, now: datetime, suppress: bool = False) -> dict:
    """Decide the new outage-tracking state and whether to alert.

    `suppress` = we're inside the global quiet window: never send an alert,
    and (crucially) never mark a down as 'alerted', so it stays PENDING and
    fires the moment the window ends and it's still down.

    Returns: {fail_since, alerted, alert, down_seconds}
      alert: None | 'down' | 'up'
    """
    if new == "up":
        if alerted and not suppress:  # was down + already buzzed -> recovery alert
            dur = None
            fs = _parse(fail_since)
            if fs:
                dur = (now - fs).total_seconds()
            return {"fail_since": None, "alerted": 0, "alert": "up", "down_seconds": dur}
        # recovered but never alerted, or muted by quiet window -> reset quietly
        return {"fail_since": None, "alerted": 0, "alert": None, "down_seconds": None}

    if new == "down":
        fs = _parse(fail_since) or now            # start the clock on first fail
        elapsed = (now - fs).total_seconds()
        if not alerted and elapsed >= grace_seconds and not suppress:
            return {"fail_since": _iso(fs), "alerted": 1, "alert": "down", "down_seconds": elapsed}
        # within grace, already alerted, or muted -> keep pending (alerted unchanged)
        return {"fail_since": _iso(fs), "alerted": alerted, "alert": None, "down_seconds": None}

    # unknown: leave state untouched
    return {"fail_since": fail_since, "alerted": alerted, "alert": None, "down_seconds": None}


def _parse_hhmm(s: str | None) -> time_of_day | None:
    if not s:
        return None
    try:
        hh, mm = s.strip().split(":")
        return time_of_day(int(hh), int(mm))
    except Exception:
        return None


def in_quiet_window(now_local: time_of_day, cfg: dict | None = None) -> bool:
    """True if the given local wall-clock time falls inside the quiet window.
    Handles windows that cross midnight (e.g. 23:00-06:00)."""
    cfg = cfg if cfg is not None else get_monitoring_config()
    if not cfg.get("quiet_enabled"):
        return False
    start = _parse_hhmm(cfg.get("quiet_start"))
    end = _parse_hhmm(cfg.get("quiet_end"))
    if start is None or end is None or start == end:
        return False
    if start < end:
        return start <= now_local < end
    return now_local >= start or now_local < end   # crosses midnight


def _grace_seconds() -> int:
    try:
        return max(0, int(get_monitoring_config().get("alert_after_minutes", 5))) * 60
    except Exception:
        return 300


# ── Persisting a probe result + firing alerts ─────────────────────────────────

def _process(conn, svc: dict, new: str) -> str:
    now_dt = _now_dt()
    now = _iso(now_dt)
    prev = svc.get("monitor_status") or "unknown"

    if new == "unknown":
        conn.execute("UPDATE services SET monitor_last_check=? WHERE id=?", (now, svc["id"]))
        conn.commit()
        return prev

    # Quiet window uses local wall-clock time (container TZ), not UTC
    suppress = in_quiet_window(datetime.now().time())
    r = evaluate(prev, new, svc.get("monitor_fail_since"),
                 svc.get("monitor_alerted") or 0, _grace_seconds(), now_dt, suppress=suppress)

    if new != prev:
        conn.execute(
            "UPDATE services SET monitor_status=?, monitor_last_check=?, monitor_last_change=?, "
            "monitor_fail_since=?, monitor_alerted=? WHERE id=?",
            (new, now, now, r["fail_since"], r["alerted"], svc["id"]))
    else:
        conn.execute(
            "UPDATE services SET monitor_status=?, monitor_last_check=?, "
            "monitor_fail_since=?, monitor_alerted=? WHERE id=?",
            (new, now, r["fail_since"], r["alerted"], svc["id"]))
    conn.commit()

    if r["alert"] == "down":
        _alert_down(svc)
    elif r["alert"] == "up":
        _alert_up(svc, r.get("down_seconds"))
    return new


def _where(svc: dict) -> str:
    return svc.get("hostname") or svc.get("ip") or "?"


def _alert_down(svc: dict) -> None:
    # Emoji goes in `tags` (ntfy renders it), never in the Title header.
    mins = _grace_seconds() // 60
    notify.send(
        title=f"{svc['name']} is down",
        message=f"{svc['name']} has been unreachable for {mins}+ min (on {_where(svc)}).",
        priority="high",
        tags=["rotating_light"],
    )


def _alert_up(svc: dict, down_seconds: float | None) -> None:
    tail = f" after ~{_fmt_duration(down_seconds)} down" if down_seconds else ""
    notify.send(
        title=f"{svc['name']} recovered",
        message=f"{svc['name']} is back up{tail} (on {_where(svc)}).",
        priority="default",
        tags=["white_check_mark"],
    )


# ── Public entry points ───────────────────────────────────────────────────────

def check_now(svc_id: int) -> dict:
    """Probe one service immediately and persist. Used for instant feedback
    when the user toggles monitoring on."""
    with get_conn() as conn:
        row = conn.execute(_SELECT + " WHERE s.id = ?", (svc_id,)).fetchone()
        if not row:
            return {"status": "unknown"}
        svc = dict(row)
        new = probe(svc)
        final = _process(conn, svc, new)
        return {"status": final, "checked_at": _iso(_now_dt())}


def _sweep() -> None:
    with get_conn() as conn:
        services = [dict(r) for r in conn.execute(_SELECT + " WHERE s.monitored = 1").fetchall()]
    for svc in services:
        new = probe(svc)
        with get_conn() as conn:
            _process(conn, svc, new)


def _loop() -> None:
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
