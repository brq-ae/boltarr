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
from .config import get_monitoring_config, get_statuspage_config
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
        # Record the transition for uptime history
        conn.execute("INSERT INTO monitor_events (service_id, status, ts) VALUES (?,?,?)",
                     (svc["id"], new, now))
    else:
        conn.execute(
            "UPDATE services SET monitor_status=?, monitor_last_check=?, "
            "monitor_fail_since=?, monitor_alerted=? WHERE id=?",
            (new, now, r["fail_since"], r["alerted"], svc["id"]))
        # Seed a starting event if this monitored service has no history yet
        # (e.g. it was already 'up' and stable, so no transition ever fired).
        has_events = conn.execute(
            "SELECT 1 FROM monitor_events WHERE service_id=? LIMIT 1", (svc["id"],)).fetchone()
        if not has_events:
            conn.execute("INSERT INTO monitor_events (service_id, status, ts) VALUES (?,?,?)",
                         (svc["id"], new, now))
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


# ── Uptime history + retention ────────────────────────────────────────────────

RETENTION_DAYS = 31          # rolling window: ~1 month, older data is pruned


def _events(conn, service_id: int):
    return [dict(r) for r in conn.execute(
        "SELECT status, ts FROM monitor_events WHERE service_id=? ORDER BY ts", (service_id,)
    ).fetchall()]


def uptime(service_id: int, window_seconds: int, now: datetime | None = None) -> dict | None:
    """Uptime over [now-window, now] from the event timeline.
    Returns {pct, up_seconds, monitored_seconds} or None if no data in range."""
    now = now or _now_dt()
    start = now.timestamp() - window_seconds
    with get_conn() as conn:
        evs = _events(conn, service_id)
        anchor = conn.execute(
            "SELECT status, ts FROM monitor_events WHERE service_id=? AND ts < ? "
            "ORDER BY ts DESC LIMIT 1",
            (service_id, datetime.fromtimestamp(start, timezone.utc).isoformat(timespec="seconds")),
        ).fetchone()
    # Build (timestamp, state) points from window start to now
    points: list[tuple[float, str]] = []
    if anchor:
        points.append((start, anchor["status"]))
    for e in evs:
        t = _parse(e["ts"])
        if not t:
            continue
        ts = t.timestamp()
        if ts >= start:
            points.append((ts, e["status"]))
    if not points:
        return None
    # If the first data point is after window start (monitoring began mid-window),
    # only measure from that first point — don't count un-monitored time.
    seg_start = points[0][0]
    up = 0.0
    total = 0.0
    for i, (ts, state) in enumerate(points):
        seg_end = points[i + 1][0] if i + 1 < len(points) else now.timestamp()
        dur = max(0.0, seg_end - ts)
        total += dur
        if state == "up":
            up += dur
    if total <= 0:
        return None
    return {"pct": round(up / total * 100, 3), "up_seconds": int(up), "monitored_seconds": int(total)}


def outages(service_id: int, window_seconds: int, limit: int = 10, now: datetime | None = None) -> list[dict]:
    """Recent down periods within the window: {start, end|None, seconds}."""
    now = now or _now_dt()
    start_dt = now.timestamp() - window_seconds
    with get_conn() as conn:
        evs = _events(conn, service_id)
    out: list[dict] = []
    cur_down_start = None
    for e in evs:
        t = _parse(e["ts"])
        if not t:
            continue
        ts = t.timestamp()
        if e["status"] == "down" and cur_down_start is None:
            cur_down_start = ts
        elif e["status"] == "up" and cur_down_start is not None:
            if ts >= start_dt:
                out.append({"start": _iso(datetime.fromtimestamp(cur_down_start, timezone.utc)),
                            "end": e["ts"], "seconds": int(ts - cur_down_start)})
            cur_down_start = None
    if cur_down_start is not None:  # still down now
        out.append({"start": _iso(datetime.fromtimestamp(cur_down_start, timezone.utc)),
                    "end": None, "seconds": int(now.timestamp() - cur_down_start)})
    return list(reversed(out))[:limit]


def prune_events(retention_days: int = RETENTION_DAYS) -> None:
    """Drop events older than the retention window, but keep the timeline
    anchored: rebase the last event before the cutoff to the cutoff time so
    uptime maths stay correct without storing >1-month-old data."""
    cutoff_dt = _now_dt().timestamp() - retention_days * 86400
    cutoff = _iso(datetime.fromtimestamp(cutoff_dt, timezone.utc))
    with get_conn() as conn:
        svc_ids = [r[0] for r in conn.execute(
            "SELECT DISTINCT service_id FROM monitor_events WHERE ts < ?", (cutoff,)).fetchall()]
        for sid in svc_ids:
            anchor = conn.execute(
                "SELECT id, status FROM monitor_events WHERE service_id=? AND ts < ? "
                "ORDER BY ts DESC LIMIT 1", (sid, cutoff)).fetchone()
            # delete everything older than cutoff
            conn.execute("DELETE FROM monitor_events WHERE service_id=? AND ts < ?", (sid, cutoff))
            # re-insert a single anchor at the cutoff carrying the state
            if anchor:
                conn.execute("INSERT INTO monitor_events (service_id, status, ts) VALUES (?,?,?)",
                             (sid, anchor["status"], cutoff))
        conn.commit()


# ── Public status page: ticks, payload, push ──────────────────────────────────

def ticks(service_id: int, minutes: int = 60, now: datetime | None = None) -> list[str]:
    """Per-minute up/down/unknown for the last `minutes`, oldest→newest,
    derived from the event timeline."""
    now = now or _now_dt()
    since = now.timestamp() - minutes * 60
    since_iso = _iso(datetime.fromtimestamp(since, timezone.utc))
    with get_conn() as conn:
        anchor = conn.execute(
            "SELECT status FROM monitor_events WHERE service_id=? AND ts < ? "
            "ORDER BY ts DESC LIMIT 1", (service_id, since_iso)).fetchone()
        evs = [dict(r) for r in conn.execute(
            "SELECT status, ts FROM monitor_events WHERE service_id=? AND ts >= ? ORDER BY ts",
            (service_id, since_iso)).fetchall()]
    points: list[tuple[float, str]] = [(since, anchor["status"] if anchor else "unknown")]
    for e in evs:
        t = _parse(e["ts"])
        if t:
            points.append((t.timestamp(), e["status"]))
    out = []
    for i in range(minutes):
        slot = since + i * 60 + 30            # middle of each minute
        state = "unknown"
        for pts_ts, pts_state in points:
            if pts_ts <= slot:
                state = pts_state
            else:
                break
        out.append(state if state in ("up", "down") else "unknown")
    return out


def build_status_payload() -> dict:
    with get_conn() as conn:
        rows = [dict(r) for r in conn.execute("""
            SELECT s.id, s.name, s.public_name, s.monitor_status
            FROM services s
            WHERE s.public = 1 AND s.monitored = 1
            ORDER BY COALESCE(NULLIF(TRIM(s.public_name), ''), s.name)
        """).fetchall()]
    services = []
    for r in rows:
        up = uptime(r["id"], 86400)
        services.append({
            "key": f"svc-{r['id']}",
            "name": (r.get("public_name") or "").strip() or r["name"],
            "status": r.get("monitor_status") or "unknown",
            "uptime_24h": up["pct"] if up else None,
            "ticks": ticks(r["id"], 60),
        })
    return {"updated_at": _iso(_now_dt()), "title": "Service Status",
            "services": services, "announcements": []}


def push_status() -> tuple[bool, str]:
    cfg = get_statuspage_config()
    if not cfg.get("enabled") or not cfg.get("url"):
        return False, "status page push disabled or no URL"
    base = cfg["url"].strip().rstrip("/")
    url = base if base.endswith("/push") else base + "/push"
    headers = {}
    if cfg.get("token"):
        headers["Authorization"] = f"Bearer {cfg['token']}"
    try:
        with httpx.Client(timeout=8) as c:
            r = c.post(url, json=build_status_payload(), headers=headers)
            r.raise_for_status()
        return True, ""
    except Exception as e:
        return False, str(e)


# ── Loop ──────────────────────────────────────────────────────────────────────

def _loop() -> None:
    _stop.wait(3)
    last_prune = 0.0
    while not _stop.is_set():
        try:
            _sweep()
            # heartbeat push to the public status page (tiny, LAN-only)
            try:
                push_status()
            except Exception:
                pass
            # prune roughly once a day
            if _now_dt().timestamp() - last_prune > 86400:
                prune_events()
                last_prune = _now_dt().timestamp()
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
