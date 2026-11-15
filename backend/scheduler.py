"""Scheduled scans.

A background loop wakes every minute and runs any schedule that's due through
the normal scan engine — so change-tracking and alerts fire automatically. A
schedule = target (subnet all/one × host filter) + timing (interval hours OR
weekly days+time) + a scan profile. One scan runs at a time: a due scan waits
in line behind a running one; a second run of a subnet that's already running
or waiting is skipped (and the skip is logged in history).
"""
import json
import ipaddress
import threading
from datetime import datetime, time as _time, timezone, timedelta

from .database import get_conn
from .config import get_timezone
from . import scanner
from . import maintenance
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


# ── Wall-clock helpers (F-23) ─────────────────────────────────────────────────
# Fixed-time schedules are worked out on the local wall clock only: "03:00" means
# once at 03:00 local, also on the days the clocks change. All maths happens on
# naive local datetimes; only the final answer is turned back into UTC.

def _wall(dt_utc: datetime) -> datetime:
    """A UTC moment as a naive local wall-clock time (configured zone, else the server's)."""
    tz = get_timezone()
    return (dt_utc.astimezone(tz) if tz else dt_utc.astimezone()).replace(tzinfo=None)


def _wall_to_utc(wall: datetime) -> datetime:
    """A local wall-clock time back to UTC. A time the clocks skip (spring forward)
    becomes the first real minute after it — when the scan will actually run."""
    tz = get_timezone()
    for minute in range(0, 181):
        w = wall + timedelta(minutes=minute)
        aware = w.replace(tzinfo=tz) if tz else w.astimezone()
        utc = aware.astimezone(timezone.utc)
        if _wall(utc) == w:
            return utc
    return (wall.replace(tzinfo=tz) if tz else wall.astimezone()).astimezone(timezone.utc)


def _interval_anchor(sched: dict, now_utc: datetime, anchor: _time, hours: float):
    """For an anchored interval: the first fire (the anchor clock time on/after the
    created date, as local wall time) and the step size."""
    created = _wall(_parse_utc(sched.get("created_at")) or now_utc)
    ff = created.replace(hour=anchor.hour, minute=anchor.minute, second=0, microsecond=0)
    if ff < created:
        ff += timedelta(days=1)
    return ff, timedelta(hours=hours)


def _in_window(t: _time, start: _time, end: _time) -> bool:
    if start <= end:
        return start <= t <= end
    return t >= start or t <= end          # window crosses midnight


def _within_window(sched: dict, dt_local: datetime) -> bool:
    """True if the local datetime falls in the schedule's active window (or there
    is no window). Only gates automatic firing — Run now ignores it."""
    ws = _at_time(sched.get("window_start"))
    we = _at_time(sched.get("window_end"))
    if ws is None or we is None:
        return True
    return _in_window(dt_local.time().replace(second=0, microsecond=0), ws, we)


CATCH_UP_GRACE = timedelta(minutes=5)


def _may_fire_now(sched: dict, slot_wall: datetime, now_wall: datetime) -> bool:
    """A due slot fires now only if now is still inside the active window, or the
    slot was moments ago (the loop wakes once a minute). So a run missed while
    Boltarr was off isn't caught up outside the window (F-42)."""
    return _within_window(sched, now_wall) or now_wall - slot_wall <= CATCH_UP_GRACE


def is_due(sched: dict, now_utc: datetime | None = None) -> bool:
    """Due check. Interval-without-a-time is plain elapsed time; fixed times
    (an interval's start time, weekly day + HH:MM) are local wall-clock (F-23)."""
    if not sched.get("enabled"):
        return False
    if now_utc is None:
        now_utc = datetime.now(timezone.utc)
    now_wall = _wall(now_utc)
    last = _parse_utc(sched.get("last_run"))
    last_wall = _wall(last) if last else None

    if sched["timing_type"] == "interval":
        hours = sched.get("interval_hours")
        if not hours or hours <= 0:
            return False
        anchor = _at_time(sched.get("at_time"))
        if anchor is None:                        # no fixed phase → gate on the current time
            if not _within_window(sched, now_wall):
                return False
            base = last or _parse_utc(sched.get("created_at")) or now_utc
            return (now_utc - base).total_seconds() >= hours * 3600
        ff, step = _interval_anchor(sched, now_utc, anchor, hours)
        if now_wall < ff:
            return False
        most_recent = ff + ((now_wall - ff) // step) * step
        if not _within_window(sched, most_recent):   # the anchored slot itself must be in-window
            return False
        if not _may_fire_now(sched, most_recent, now_wall):
            return False
        return last_wall is None or last_wall < most_recent

    # weekly: fire once per matching local day, at/after the local at_time
    at = _at_time(sched.get("at_time"))
    if at is None:
        return False
    days = {int(d) for d in (sched.get("days_of_week") or "").split(",") if d.strip().isdigit()}
    if now_wall.weekday() not in days:
        return False
    target = now_wall.replace(hour=at.hour, minute=at.minute, second=0, microsecond=0)
    if now_wall < target:
        return False
    if not _within_window(sched, target):         # the fire time must be in-window
        return False
    if not _may_fire_now(sched, target, now_wall):
        return False
    return last_wall is None or last_wall < target


def next_run_utc(sched: dict, now_utc: datetime | None = None) -> str | None:
    """When this schedule will next fire, as a UTC ISO string. None if it won't
    (disabled, invalid timing, or the active window excludes every run time).
    Respects the active window — the returned slot is always inside it."""
    if not sched.get("enabled"):
        return None
    if now_utc is None:
        now_utc = datetime.now(timezone.utc)
    iso = lambda d: d.astimezone(timezone.utc).isoformat(timespec="seconds")

    if sched["timing_type"] == "interval":
        hours = sched.get("interval_hours")
        if not hours or hours <= 0:
            return None
        step = timedelta(hours=hours)
        anchor = _at_time(sched.get("at_time"))
        if anchor is None:                      # elapsed time: real clock
            base = _parse_utc(sched.get("last_run")) or _parse_utc(sched.get("created_at")) or now_utc
            nxt = base + step
            while nxt <= now_utc:               # advance to the first future slot
                nxt += step
            for _ in range(2000):               # advance to the first slot inside the window
                if _within_window(sched, _wall(nxt)):
                    return iso(nxt)
                nxt += step
            return None
        now_wall = _wall(now_utc)
        ff, step = _interval_anchor(sched, now_utc, anchor, hours)
        nxt = ff if now_wall < ff else ff + (((now_wall - ff) // step) + 1) * step
        for _ in range(2000):
            if _within_window(sched, nxt):
                return iso(_wall_to_utc(nxt))
            nxt += step
        return None                             # window excludes every run time

    at = _at_time(sched.get("at_time"))
    if at is None:
        return None
    days = {int(d) for d in (sched.get("days_of_week") or "").split(",") if d.strip().isdigit()}
    if not days:
        return None
    now_wall = _wall(now_utc)
    for d in range(0, 8):
        cand = now_wall + timedelta(days=d)
        if cand.weekday() in days:
            target = cand.replace(hour=at.hour, minute=at.minute, second=0, microsecond=0)
            if target > now_wall and _within_window(sched, target):
                return iso(_wall_to_utc(target))
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
    """Kick off a schedule's scans now (or line them up behind a running scan).
    Returns {started:[...], skipped:[...], queued:[...]}."""
    started, skipped, queued = [], [], []
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
            if scanner.is_subnet_scanning(sn["id"]):   # this subnet is already running or waiting
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

            # One scan at a time (F-34): it waits in line ('queued') if another scan
            # is running, and starts by itself when that one finishes.
            cur = conn.execute(
                "INSERT INTO scan_runs (subnet_id, schedule_id, status) VALUES (?, ?, 'queued')",
                (sn["id"], schedule_id))
            conn.commit()
            run_id = cur.lastrowid
            if scanner.queue_scan(run_id, target, opts):
                started.append(run_id)
            else:
                queued.append(run_id)

        if mark_last_run:
            conn.execute("UPDATE scan_schedules SET last_run=? WHERE id=?",
                         (datetime.now(timezone.utc).isoformat(timespec="seconds"), schedule_id))
            conn.commit()
    return {"started": started, "skipped": skipped, "queued": queued}


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
            with maintenance.loop_work():
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
