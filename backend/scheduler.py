"""Scheduled scans.

A background loop wakes every minute and runs any schedule that's due through
the normal scan engine — so change-tracking and alerts fire automatically. A
schedule = target (subnet all/one × host filter) + timing (interval hours OR
weekly days+time) + a scan profile. Overlapping runs of the same subnet are
skipped (and the skip is logged in history) so scans never stack.
"""
import json
import ipaddress
import threading
from datetime import datetime, time as _time, timezone, timedelta

from .database import get_conn
from .config import get_timezone
from . import scanner
from .changes import classify_host

_thread: threading.Thread | None = None
_stop = threading.Event()


# ── Due-time logic ─────────────────────────────────────────────────────────────

def _parse_utc(s: str | None) -> datetime | None:
    """Parse a stored timestamp as UTC-aware (handles ISO and SQLite formats)."""
    if not s:
        return None
    dt = None
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        try:
            dt = datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def _at_time(s: str | None) -> _time | None:
    try:
        hh, mm = (s or "").split(":")
        return _time(int(hh), int(mm))
    except Exception:
        return None


def _interval_anchor(sched: dict, now_utc: datetime, anchor: _time, hours: float):
    """For an anchored interval: the first fire (the anchor clock time on/after the
    created date, in the local zone) and the step size."""
    tz = get_timezone()
    created = _parse_utc(sched.get("created_at")) or now_utc
    created_local = created.astimezone(tz) if tz else created.astimezone()
    ff = created_local.replace(hour=anchor.hour, minute=anchor.minute, second=0, microsecond=0)
    if ff < created_local:
        ff += timedelta(days=1)
    return ff, timedelta(hours=hours)


def is_due(sched: dict, now_utc: datetime | None = None) -> bool:
    """Due check. Interval math is done in UTC; weekly wall-clock (day + HH:MM)
    is evaluated in the configured timezone so '03:00' means 3am *local*."""
    if not sched.get("enabled"):
        return False
    if now_utc is None:
        now_utc = datetime.now(timezone.utc)

    if sched["timing_type"] == "interval":
        hours = sched.get("interval_hours")
        if not hours or hours <= 0:
            return False
        anchor = _at_time(sched.get("at_time"))
        if anchor is None:                        # no anchor → count from creation/last run
            base = _parse_utc(sched.get("last_run")) or _parse_utc(sched.get("created_at")) or now_utc
            return (now_utc - base).total_seconds() >= hours * 3600
        ff, step = _interval_anchor(sched, now_utc, anchor, hours)
        if now_utc < ff:
            return False
        most_recent = ff + ((now_utc - ff) // step) * step
        last = _parse_utc(sched.get("last_run"))
        return last is None or last < most_recent

    # weekly: fire once per matching local day, at/after the local at_time
    at = _at_time(sched.get("at_time"))
    if at is None:
        return False
    tz = get_timezone()
    now_local = now_utc.astimezone(tz) if tz else now_utc.astimezone()
    days = {int(d) for d in (sched.get("days_of_week") or "").split(",") if d.strip().isdigit()}
    if now_local.weekday() not in days:
        return False
    target = now_local.replace(hour=at.hour, minute=at.minute, second=0, microsecond=0)
    if now_local < target:
        return False
    last = _parse_utc(sched.get("last_run"))
    return last is None or last < target


def next_run_utc(sched: dict, now_utc: datetime | None = None) -> str | None:
    """When this schedule will next fire, as a UTC ISO string. None if it won't
    (disabled or invalid timing). Interval is UTC; weekly is in the local zone."""
    if not sched.get("enabled"):
        return None
    if now_utc is None:
        now_utc = datetime.now(timezone.utc)

    if sched["timing_type"] == "interval":
        hours = sched.get("interval_hours")
        if not hours or hours <= 0:
            return None
        anchor = _at_time(sched.get("at_time"))
        if anchor is None:
            base = _parse_utc(sched.get("last_run")) or _parse_utc(sched.get("created_at")) or now_utc
            nxt = base + timedelta(hours=hours)
        else:
            ff, step = _interval_anchor(sched, now_utc, anchor, hours)
            nxt = ff if now_utc < ff else ff + (((now_utc - ff) // step) + 1) * step
        return nxt.astimezone(timezone.utc).isoformat(timespec="seconds")

    at = _at_time(sched.get("at_time"))
    if at is None:
        return None
    days = {int(d) for d in (sched.get("days_of_week") or "").split(",") if d.strip().isdigit()}
    if not days:
        return None
    tz = get_timezone()
    now_local = now_utc.astimezone(tz) if tz else now_utc.astimezone()
    for d in range(0, 8):
        cand = now_local + timedelta(days=d)
        if cand.weekday() in days:
            target = cand.replace(hour=at.hour, minute=at.minute, second=0, microsecond=0)
            if target > now_local:
                return target.astimezone(timezone.utc).isoformat(timespec="seconds")
    return None


# ── Target resolution ──────────────────────────────────────────────────────────

def _subnets_for(sched: dict, conn) -> list[dict]:
    if sched.get("subnet_id"):
        rows = conn.execute("SELECT * FROM subnets WHERE id=?", (sched["subnet_id"],)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM subnets").fetchall()
    return [dict(r) for r in rows]


def _filtered_ips(conn, subnet: dict, host_filter: str, all_subnets: list[dict]) -> list[str]:
    """Known IPs inside `subnet` whose classification matches host_filter."""
    try:
        net = ipaddress.ip_network(subnet["cidr"], strict=False)
    except ValueError:
        return []
    out = []
    for h in conn.execute("SELECT ip, static_override FROM hosts WHERE ip NOT LIKE 'node-%'"):
        try:
            if ipaddress.ip_address(h["ip"]) not in net:
                continue
        except ValueError:
            continue
        if classify_host(h["ip"], all_subnets, h["static_override"]) == host_filter:
            out.append(h["ip"])
    return out


def _profile_opts(conn, profile_id) -> dict:
    if not profile_id:
        return {}
    row = conn.execute("SELECT options FROM scan_profiles WHERE id=?", (profile_id,)).fetchone()
    if not row:
        return {}
    try:
        return json.loads(row["options"])
    except Exception:
        return {}


# ── Running a schedule ─────────────────────────────────────────────────────────

def run_schedule(schedule_id: int, mark_last_run: bool = True) -> dict:
    """Kick off a schedule's scans now. Returns {started:[...], skipped:[...]}."""
    started, skipped = [], []
    with get_conn() as conn:
        sched = conn.execute("SELECT * FROM scan_schedules WHERE id=?", (schedule_id,)).fetchone()
        if not sched:
            return {"error": "not found"}
        sched = dict(sched)
        all_subnets = [dict(s) for s in conn.execute("SELECT * FROM subnets")]
        subnets = _subnets_for(sched, conn)
        opts = _profile_opts(conn, sched.get("profile_id"))
        hf = sched.get("host_filter") or "all"

        for sn in subnets:
            if scanner.is_subnet_scanning(sn["id"]):
                conn.execute(
                    "INSERT INTO scan_runs (subnet_id, schedule_id, status, note, completed_at) "
                    "VALUES (?, ?, 'skipped', 'scan already running', datetime('now'))",
                    (sn["id"], schedule_id))
                conn.commit()
                skipped.append(sn["id"]);  continue

            if hf == "all":
                target = sn["cidr"]
            else:
                ips = _filtered_ips(conn, sn, hf, all_subnets)
                if not ips:
                    conn.execute(
                        "INSERT INTO scan_runs (subnet_id, schedule_id, status, note, completed_at) "
                        "VALUES (?, ?, 'skipped', ?, datetime('now'))",
                        (sn["id"], schedule_id, f"no {hf} hosts to scan"))
                    conn.commit()
                    skipped.append(sn["id"]);  continue
                target = " ".join(ips)

            cur = conn.execute(
                "INSERT INTO scan_runs (subnet_id, schedule_id, status) VALUES (?, ?, 'running')",
                (sn["id"], schedule_id))
            conn.commit()
            run_id = cur.lastrowid
            scanner.start_scan(run_id, target, opts)
            started.append(run_id)

        if mark_last_run:
            conn.execute("UPDATE scan_schedules SET last_run=? WHERE id=?",
                         (datetime.now(timezone.utc).isoformat(timespec="seconds"), schedule_id))
            conn.commit()
    return {"started": started, "skipped": skipped}


def tick() -> None:
    now_utc = datetime.now(timezone.utc)
    with get_conn() as conn:
        due = [dict(r) for r in conn.execute("SELECT * FROM scan_schedules WHERE enabled=1")
               if is_due(dict(r), now_utc)]
    for sched in due:
        try:
            run_schedule(sched["id"])
        except Exception:
            pass


# ── Loop ───────────────────────────────────────────────────────────────────────

def _loop() -> None:
    _stop.wait(20)   # let startup settle
    while not _stop.is_set():
        try:
            tick()
        except Exception:
            pass
        _stop.wait(60)


def start_scheduler() -> None:
    global _thread
    scanner.reconcile_orphaned_runs()
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="scheduler", daemon=True)
    _thread.start()
