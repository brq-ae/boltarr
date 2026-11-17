"""Service uptime monitor.

Background loop that probes services flagged `monitored=1` every
CHECK_INTERVAL seconds, records live up/down status, and sends ntfy alerts
when a service stays down past the configured grace period, and again when
it recovers.

Probe rule (check_type, or URL -> http, else tcp):
  - http -> GET, reading only the status line + headers (never the body, so an
            endless stream can't hang the check). Up = a reply below 500, or one
            of the service's own accepted codes (F-29). Error/timeout = down.
  - tcp  -> TCP connect to target:port.   - icmp -> nmap ping.
  - nothing to check (no URL / port / IP) -> 'unknown' (shown as "Not set up",
            never alerts).

Checks run a few at a time (POOL_SIZE), each with its own deadline, so one slow
or stuck target only holds up itself (F-18). The status-page push and the daily
digest run in their own loops.

Alerting: the live status/dot flips to 'down' on the first failed probe,
but a down-ALERT only fires once the service has been continuously down for
`alert_after_minutes` (config, default 5). A recovery alert fires when it
comes back, but only if a down-alert had been sent — and then always: in quiet
hours it is queued and sent in the summary when they end (F-17).
"""
import re
import socket
import subprocess
import threading
import time
from datetime import datetime, timezone, time as time_of_day

import httpx

from .database import get_conn
from .config import get_monitoring_config, get_statuspage_config, get_check_seconds, local_now, get_timezone
from . import notify
from . import maintenance
from . import planned

CHECK_INTERVAL = 60          # default probe interval; live value = get_check_seconds()
HTTP_TIMEOUT   = 6           # seconds per HTTP connect / read step
TCP_TIMEOUT    = 5           # seconds per TCP probe
ICMP_TIMEOUT   = 4           # seconds per ICMP (ping) probe
POOL_SIZE      = 8           # checks running at the same time (F-18)
PROBE_DEADLINE = 20          # a check that takes longer counts as down

_thread: threading.Thread | None = None
_threads: list[threading.Thread] = []
_stop = threading.Event()
_plock = threading.RLock()   # one _process at a time (sweep vs. check_now vs. pause)

_SELECT = """
    SELECT s.id, s.name, s.url, s.port, s.monitor_status,
           s.monitor_fail_since, s.monitor_alerted, s.container_ip, s.check_type,
           s.accepted_codes, s.monitored,
           h.ip, h.hostname, h.online, h.offline_alerted
    FROM services s JOIN hosts h ON s.host_id = h.id
"""
# What a probe depends on: a result is dropped if any of these changed meanwhile (F-30).
_PROBE_KEYS = ("url", "port", "container_ip", "check_type", "accepted_codes", "ip")


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


def fmt_duration(seconds: float) -> str:
    """A length of time for alert and digest text: "12 min", "2 h 5 min"."""
    m = int(seconds // 60)
    if m < 60:
        return f"{m} min"
    h, m = divmod(m, 60)
    return f"{h} h {m} min" if m else f"{h} h"


# ── Accepted HTTP replies (F-29) ──────────────────────────────────────────────

_CODES_RE = re.compile(r"\d{3}(-\d{3})?(,\d{3}(-\d{3})?)*")


def parse_codes(spec: str | None) -> list[tuple[int, int]] | None:
    """'200-299,404' -> [(200, 299), (404, 404)]; blank -> None (the default rule).
    Raises ValueError for anything else."""
    text = re.sub(r"\s+", "", spec or "")
    if not text:
        return None
    if len(text) > 100 or not _CODES_RE.fullmatch(text):
        raise ValueError("Accepted replies: use numbers, ranges and commas, e.g. 200-299 or 200,404")
    out = []
    for part in text.split(","):
        a, _, b = part.partition("-")
        lo, hi = int(a), int(b or a)
        if not (100 <= lo <= hi <= 599):
            raise ValueError("Accepted replies: codes go from 100 to 599, low to high (e.g. 200-299)")
        out.append((lo, hi))
    return out


def reply_ok(code: int, spec: str | None = None) -> bool:
    """Does this HTTP status count as up? Default: anything below 500 (a login page
    or redirect means the app answered; 5xx means it, or the proxy before it, failed)."""
    try:
        ranges = parse_codes(spec)
    except ValueError:
        ranges = None                      # a bad saved value falls back to the default
    if ranges is None:
        return code < 500
    return any(lo <= code <= hi for lo, hi in ranges)


# ── Probing ───────────────────────────────────────────────────────────────────

def _probe_http(url: str, accepted: str | None = None) -> bool:
    """Reads the status line + headers only: leaving the stream closes it before the
    body, so a camera feed or event stream can't keep the check open (F-18)."""
    try:
        with httpx.Client(timeout=HTTP_TIMEOUT, verify=False, follow_redirects=True) as c:
            with c.stream("GET", url) as r:
                return reply_ok(r.status_code, accepted)
    except Exception:
        return False


def _probe_tcp(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=TCP_TIMEOUT):
            return True
    except Exception:
        return False


def _probe_icmp(host: str) -> bool:
    """Reachability via nmap host-discovery (ICMP echo; ARP on the local segment).
    We use nmap because it's already in the image and works with Boltarr's caps —
    the `ping` binary is not installed in the container. Up = nmap reports it up."""
    try:
        import nmap
        from .scanner import check_target
        check_target(host)                # never pass anything nmap could read as an option
        proc = subprocess.run(
            ["nmap", "-sn", "-PE", "-n", "-oX", "-", host],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=ICMP_TIMEOUT + 4)
        nm = nmap.PortScanner()
        nm.analyse_nmap_xml_scan(proc.stdout.decode("utf-8", "replace"))
        return host in nm.all_hosts() and nm[host].state() == "up"
    except Exception:
        return False


def _check_plan(service: dict) -> tuple[str, str, str, int | None]:
    """(check type, url, target ip, port). The method is explicit (check_type =
    http|tcp|icmp); older services with no check_type fall back to the old rule
    (URL -> http, else tcp). The TCP/ICMP target is container_ip if set, otherwise
    the linked host's IP — so a service can 'live on' host A while its check points
    at the container's own IP."""
    ct = (service.get("check_type") or "").strip().lower()
    url = (service.get("url") or "").strip()
    target = (service.get("container_ip") or "").strip() or (service.get("ip") or "")
    if target.startswith("node-"):         # a hand-drawn node has no address to check
        target = ""
    if ct not in ("http", "tcp", "icmp"):
        ct = "http" if url else "tcp"
    return ct, url, target, service.get("port")


def has_target(service: dict) -> bool:
    """False = monitoring is on but there is nothing to check ("Not set up")."""
    ct, url, target, port = _check_plan(service)
    return bool(url) if ct == "http" else bool(target and port) if ct == "tcp" else bool(target)


def probe(service: dict) -> str:
    """Check a monitored service: 'up' | 'down' | 'unknown' (nothing to check)."""
    if not has_target(service):
        return "unknown"
    ct, url, target, port = _check_plan(service)
    if ct == "http":
        return "up" if _probe_http(url, service.get("accepted_codes")) else "down"
    if ct == "tcp":
        return "up" if _probe_tcp(target, int(port)) else "down"
    return "up" if _probe_icmp(target) else "down"


def probe_all(services: list[dict], pool: int = POOL_SIZE, deadline: float = PROBE_DEADLINE) -> dict:
    """{service id: result} for every service, `pool` checks at a time. A check
    still running after `deadline` seconds counts as 'down' and a fresh worker
    takes its place, so stuck checks can't use up the pool; the stuck thread is
    left to finish (or not) on its own — it's a daemon and its late answer is
    ignored."""
    results: dict = {}
    if not services:
        return results
    pending = list(services)
    started: dict = {}                     # id -> monotonic start
    cv = threading.Condition()

    def worker():
        while True:
            with cv:
                if not pending:
                    return
                svc = pending.pop(0)
                started[svc["id"]] = time.monotonic()
            try:
                r = probe(svc)
            except Exception:
                r = "down"
            with cv:
                results.setdefault(svc["id"], r)
                cv.notify_all()

    def spawn():
        threading.Thread(target=worker, name="monitor-probe", daemon=True).start()

    for _ in range(min(pool, len(services))):
        spawn()
    with cv:
        while len(results) < len(services):
            now = time.monotonic()
            for sid, t0 in list(started.items()):
                if sid not in results and now - t0 >= deadline:
                    results[sid] = "down"          # too slow: counts as down
                    if pending:
                        spawn()                    # replace the stuck worker
            if len(results) >= len(services):
                break
            waits = [deadline - (now - t0) for sid, t0 in started.items() if sid not in results]
            cv.wait(timeout=max(0.05, min(waits) if waits else 0.5))
    return results


# ── Alert-state evaluation (pure, unit-testable) ──────────────────────────────

def evaluate(prev: str, new: str, fail_since: str | None, alerted: int,
             grace_seconds: int, now: datetime, quiet: bool = False, hold: bool = False) -> dict:
    """Decide the new outage-tracking state and whether to alert.

    quiet = inside the quiet window: a down-alert is never sent and the outage is
            NOT marked alerted, so it stays pending and fires when the window ends
            if still down. A recovery of an outage that WAS alerted is never lost:
            it comes back as 'up_quiet' (queued for the quiet-hours summary).
    hold  = the service's host is offline and its "went offline" alert really
            went out (F-17): hold the down-alert the same way, so one host alert
            covers its services. A hold never swallows a recovery.

    Returns: {fail_since, alerted, alert, down_seconds}
      alert: None | 'down' | 'up' | 'up_quiet'
    """
    if new == "up":
        if alerted:                   # was down + already buzzed -> recovery alert
            dur = None
            fs = _parse(fail_since)
            if fs:
                dur = (now - fs).total_seconds()
            return {"fail_since": None, "alerted": 0, "alert": "up_quiet" if quiet else "up",
                    "down_seconds": dur}
        # recovered before any alert went out -> reset quietly
        return {"fail_since": None, "alerted": 0, "alert": None, "down_seconds": None}

    if new == "down":
        fs = _parse(fail_since) or now            # start the clock on first fail
        elapsed = (now - fs).total_seconds()
        if not alerted and elapsed >= grace_seconds and not quiet and not hold:
            return {"fail_since": _iso(fs), "alerted": 1, "alert": "down", "down_seconds": elapsed}
        # within grace, already alerted, or held -> keep pending (alerted unchanged)
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


# ── Held alerts: quiet hours + failed sends (F-17 / F-27) ─────────────────────

QUEUE_LINES = 40             # lines in one summary; the rest become "+N more"


def queue_alert(line: str, reason: str) -> None:
    """Keep an alert for the summary sent later. reason: 'quiet' | 'failed'.
    Nothing is kept while notifications are off — there'd be nowhere to send it."""
    if not notify.is_on():
        return
    stamp = local_now().strftime("%H:%M")
    with get_conn() as conn:
        conn.execute("INSERT INTO alert_queue (ts, reason, line) VALUES (?,?,?)",
                     (_iso(_now_dt()), reason, f"{stamp} {line}"))
        conn.commit()


def flush_queue() -> str | None:
    """Send everything held back as ONE message, once quiet hours are over and ntfy
    answers. Rows are removed only after it went out. Returns the deliver() result,
    None when there was nothing to send (or it's still quiet)."""
    if in_quiet_window(local_now().time()):
        return None
    with get_conn() as conn:
        rows = [dict(r) for r in conn.execute("SELECT id, reason, line FROM alert_queue ORDER BY id")]
    if not rows:
        return None
    reasons = {r["reason"] for r in rows}
    title = ("While quiet hours were on" if reasons == {"quiet"} else
             "Alerts that couldn't be sent earlier" if reasons == {"failed"} else "Held-back alerts")
    lines = [r["line"] for r in rows[:QUEUE_LINES]]
    if len(rows) > QUEUE_LINES:
        lines.append(f"+{len(rows) - QUEUE_LINES} more")
    res = notify.deliver(f"{title} ({len(rows)})", "\n".join(lines), tags=["bell"])
    if res in ("sent", "off"):
        with get_conn() as conn:
            conn.execute(f"DELETE FROM alert_queue WHERE id <= ?", (rows[-1]["id"],))
            conn.commit()
    return res


# ── Persisting a probe result + firing alerts ─────────────────────────────────

def _fresh(conn, svc_id: int) -> dict | None:
    row = conn.execute(_SELECT + " WHERE s.id = ?", (svc_id,)).fetchone()
    return dict(row) if row else None


def _process(conn, svc: dict, new: str) -> str:
    """Save one probe result and send its alert. The service is read again first
    (F-30): a result is dropped when the service was paused, deleted or re-pointed
    while its check ran, and `prev` is always the saved value, so two passes at once
    can't both write the same change."""
    with _plock:
        cur = _fresh(conn, svc["id"])
        if not cur or not cur.get("monitored"):
            return "unknown"
        if any((cur.get(k) or None) != (svc.get(k) or None) for k in _PROBE_KEYS if k in svc):
            return cur.get("monitor_status") or "unknown"
        r, svc = _save_result(conn, cur, new)
    if r is None:
        return svc.get("monitor_status") or "unknown"
    _send_alert(conn, svc, r)
    return new


def _save_result(conn, svc: dict, new: str):
    now_dt = _now_dt()
    now = _iso(now_dt)
    prev = svc.get("monitor_status") or "unknown"

    if new == "unknown":                  # nothing to check: "Not set up", never alerts
        if prev != "unknown":
            conn.execute("UPDATE services SET monitor_status='unknown', monitor_last_check=?, "
                         "monitor_last_change=?, monitor_fail_since=NULL, monitor_alerted=0 WHERE id=?",
                         (now, now, svc["id"]))
            conn.execute("INSERT INTO monitor_events (service_id, status, ts) VALUES (?,?,?)",
                         (svc["id"], "unknown", now))
        else:
            conn.execute("UPDATE services SET monitor_last_check=? WHERE id=?", (now, svc["id"]))
        conn.commit()
        return None, svc

    # Monitored services show running/stopped driven by the live probe result,
    # so the manual status label stays in sync with reality on its own.
    status_val = "running" if new == "up" else "stopped"

    # Quiet window uses local wall-clock time (container TZ), not UTC
    quiet = in_quiet_window(local_now().time())
    # Root-cause hold: the host is offline AND its "went offline" alert really went
    # out (F-17) — that one alert covers its services. If it didn't (e.g. the host
    # isn't in the alert scope), the service alerts normally.
    hold = bool(get_monitoring_config().get("suppress_when_host_down", True)
                and svc.get("online") == 0 and svc.get("offline_alerted"))
    r = evaluate(prev, new, svc.get("monitor_fail_since"),
                 svc.get("monitor_alerted") or 0, _grace_seconds(), now_dt, quiet=quiet, hold=hold)

    if new != prev:
        conn.execute(
            "UPDATE services SET monitor_status=?, status=?, monitor_last_check=?, monitor_last_change=?, "
            "monitor_fail_since=?, monitor_alerted=? WHERE id=?",
            (new, status_val, now, now, r["fail_since"], r["alerted"], svc["id"]))
        # Record the transition for uptime history
        conn.execute("INSERT INTO monitor_events (service_id, status, ts) VALUES (?,?,?)",
                     (svc["id"], new, now))
    else:
        conn.execute(
            "UPDATE services SET monitor_status=?, status=?, monitor_last_check=?, "
            "monitor_fail_since=?, monitor_alerted=? WHERE id=?",
            (new, status_val, now, r["fail_since"], r["alerted"], svc["id"]))
        # Seed a starting event if this monitored service has no history yet
        # (e.g. it was already 'up' and stable, so no transition ever fired).
        has_events = conn.execute(
            "SELECT 1 FROM monitor_events WHERE service_id=? LIMIT 1", (svc["id"],)).fetchone()
        if not has_events:
            conn.execute("INSERT INTO monitor_events (service_id, status, ts) VALUES (?,?,?)",
                         (svc["id"], new, now))
    conn.commit()
    return r, svc


def _send_alert(conn, svc: dict, r: dict) -> None:
    """Send outside the lock (ntfy can be slow). A down-alert that fails is un-marked
    so the next round tries again (F-27); a recovery that fails, or comes in quiet
    hours, waits in the queue — so neither is ever lost."""
    if r["alert"] == "down":
        if _alert_down(svc) == "failed":
            with _plock:
                conn.execute("UPDATE services SET monitor_alerted=0 WHERE id=? AND monitor_alerted=1 "
                             "AND monitor_fail_since=?", (svc["id"], r["fail_since"]))
                conn.commit()
    elif r["alert"] == "up":
        if _alert_up(svc, r.get("down_seconds")) == "failed":
            queue_alert(_up_line(svc, r.get("down_seconds")), "failed")
    elif r["alert"] == "up_quiet":
        queue_alert(_up_line(svc, r.get("down_seconds")), "quiet")


def _where(svc: dict) -> str:
    return svc.get("hostname") or svc.get("ip") or "?"


def _alert_down(svc: dict) -> str:
    # Emoji goes in `tags` (ntfy renders it), never in the Title header.
    mins = _grace_seconds() // 60
    return notify.deliver(
        title=f"{svc['name']} is down",
        message=f"{svc['name']} has been unreachable for {mins}+ min (on {_where(svc)}).",
        priority="high",
        tags=["rotating_light"],
    )


def _up_line(svc: dict, down_seconds: float | None) -> str:
    tail = f" after ~{fmt_duration(down_seconds)} down" if down_seconds else ""
    return f"✅ {svc['name']} is back up{tail} (on {_where(svc)})"


def _alert_up(svc: dict, down_seconds: float | None) -> str:
    tail = f" after ~{fmt_duration(down_seconds)} down" if down_seconds else ""
    return notify.deliver(
        title=f"{svc['name']} recovered",
        message=f"{svc['name']} is back up{tail} (on {_where(svc)}).",
        priority="default",
        tags=["white_check_mark"],
    )


# ── Pause / resume (v0.26.0; reason + "no data" history in v0.27.0, F-28) ─────

PAUSE_REASON_MAX = 200


def set_monitored(conn, svc_id: int, on: bool, resume_at: str | None = None,
                  reason: str | None = None, pause: bool = False) -> None:
    """Turn a service's monitoring on or off. Off resets the live status. pause=True
    makes it a pause (kept on the status page as Paused, or Maintenance with a
    reason); `resume_at` (UTC ISO) makes it end by itself (resume_due). Off/pause
    writes a 'paused' / 'maint' mark into the history, so that time counts as no
    data instead of carrying on the last up/down. Caller commits."""
    with _plock:
        row = conn.execute("SELECT monitored, monitor_paused_at, monitor_pause_reason FROM services "
                           "WHERE id=?", (svc_id,)).fetchone()
        if on:
            conn.execute("UPDATE services SET monitored=1, monitor_resume_at=NULL, monitor_paused_at=NULL, "
                         "monitor_pause_reason=NULL, maint_window_id=NULL WHERE id=?", (svc_id,))
            return
        reason = ((reason or "").strip()[:PAUSE_REASON_MAX] or None) if pause else None
        kind = "maint" if reason else "paused"
        paused_at = (row["monitor_paused_at"] if row and row["monitor_paused_at"] else _iso(_now_dt())) if pause else None
        conn.execute(
            "UPDATE services SET monitored=0, monitor_status='unknown', monitor_fail_since=NULL, "
            "monitor_alerted=0, monitor_resume_at=?, monitor_paused_at=?, monitor_pause_reason=?, "
            "maint_window_id=NULL WHERE id=?",
            (resume_at, paused_at, reason, svc_id))
        last = conn.execute("SELECT status FROM monitor_events WHERE service_id=? "
                            "ORDER BY ts DESC, id DESC LIMIT 1", (svc_id,)).fetchone()
        if row and last and last["status"] != kind:      # no history yet = nothing to end
            conn.execute("INSERT INTO monitor_events (service_id, status, ts) VALUES (?,?,?)",
                         (svc_id, kind, _iso(_now_dt())))


def resume_due() -> list[int]:
    """Turn monitoring back on for paused services whose resume time has passed."""
    now = _now_dt()
    with get_conn() as conn:
        rows = conn.execute("SELECT id, monitor_resume_at FROM services "
                            "WHERE monitored=0 AND monitor_resume_at IS NOT NULL").fetchall()
        due = [r["id"] for r in rows if (_parse(r["monitor_resume_at"]) or now) <= now]
        for sid in due:
            set_monitored(conn, sid, True)
        if due:
            conn.commit()
    return due


# ── Public entry points ───────────────────────────────────────────────────────

def check_now(svc_id: int) -> dict:
    """Probe one service immediately and persist. Used for instant feedback
    when the user toggles monitoring on."""
    with get_conn() as conn:
        svc = _fresh(conn, svc_id)
        if not svc:
            return {"status": "unknown"}
        new = probe_all([svc]).get(svc_id, "down")
        final = _process(conn, svc, new)
        return {"status": final, "checked_at": _iso(_now_dt())}


def _sweep() -> None:
    with get_conn() as conn:
        services = [dict(r) for r in conn.execute(_SELECT + " WHERE s.monitored = 1").fetchall()]
    results = probe_all(services)
    with get_conn() as conn:
        for svc in services:
            try:
                _process(conn, svc, results.get(svc["id"], "down"))
            except Exception as e:
                print(f"[monitor] could not save the check of {svc.get('name')!r}: {e}")


# ── Uptime history + retention ────────────────────────────────────────────────

RETENTION_DAYS = 31          # rolling window: ~1 month, older data is pruned


def _events(conn, service_id: int):
    return [dict(r) for r in conn.execute(
        "SELECT status, ts FROM monitor_events WHERE service_id=? ORDER BY ts", (service_id,)
    ).fetchall()]


def _compute_uptime(evs: list[dict], anchor_status: str | None,
                    window_seconds: int, now: datetime) -> dict | None:
    """Uptime % over [now-window, now] from a status/ts event timeline."""
    start = now.timestamp() - window_seconds
    points: list[tuple[float, str]] = []
    if anchor_status is not None:
        points.append((start, anchor_status))
    for e in evs:
        t = _parse(e["ts"])
        if not t:
            continue
        ts = t.timestamp()
        if ts >= start:
            points.append((ts, e["status"]))
    if not points:
        return None
    up = 0.0
    total = 0.0
    for i, (ts, state) in enumerate(points):
        if state not in ("up", "down"):    # paused / maintenance / not set up = no data (F-28)
            continue
        seg_end = points[i + 1][0] if i + 1 < len(points) else now.timestamp()
        dur = max(0.0, seg_end - ts)
        total += dur
        if state == "up":
            up += dur
    if total <= 0:
        return None
    return {"pct": round(up / total * 100, 3), "up_seconds": int(up), "monitored_seconds": int(total)}


def _compute_outages(evs: list[dict], window_seconds: int, limit: int, now: datetime) -> list[dict]:
    start_dt = now.timestamp() - window_seconds
    out: list[dict] = []
    cur_down_start = None
    for e in evs:
        t = _parse(e["ts"])
        if not t:
            continue
        ts = t.timestamp()
        if e["status"] == "down" and cur_down_start is None:
            cur_down_start = ts
        elif e["status"] != "down" and cur_down_start is not None:   # up, or paused while down
            if ts >= start_dt:
                out.append({"start": _iso(datetime.fromtimestamp(cur_down_start, timezone.utc)),
                            "end": e["ts"], "seconds": int(ts - cur_down_start)})
            cur_down_start = None
    if cur_down_start is not None:  # still down now
        out.append({"start": _iso(datetime.fromtimestamp(cur_down_start, timezone.utc)),
                    "end": None, "seconds": int(now.timestamp() - cur_down_start)})
    return list(reversed(out))[:limit]


def _anchor_status(conn, table: str, key_col: str, key, start: float) -> str | None:
    start_iso = datetime.fromtimestamp(start, timezone.utc).isoformat(timespec="seconds")
    row = conn.execute(
        f"SELECT status FROM {table} WHERE {key_col}=? AND ts < ? ORDER BY ts DESC LIMIT 1",
        (key, start_iso)).fetchone()
    return row["status"] if row else None


def uptime(service_id: int, window_seconds: int, now: datetime | None = None) -> dict | None:
    now = now or _now_dt()
    with get_conn() as conn:
        evs = _events(conn, service_id)
        anchor = _anchor_status(conn, "monitor_events", "service_id", service_id, now.timestamp() - window_seconds)
    return _compute_uptime(evs, anchor, window_seconds, now)


def outages(service_id: int, window_seconds: int, limit: int = 10, now: datetime | None = None) -> list[dict]:
    now = now or _now_dt()
    with get_conn() as conn:
        evs = _events(conn, service_id)
    return _compute_outages(evs, window_seconds, limit, now)


# ── Uptime reset (clear history, re-seed current state so the % restarts clean) ─
def reset_service_uptime(service_id: int) -> None:
    now = _iso(_now_dt())
    with get_conn() as conn:
        row = conn.execute("SELECT monitor_status FROM services WHERE id=?", (service_id,)).fetchone()
        conn.execute("DELETE FROM monitor_events WHERE service_id=?", (service_id,))
        if row and row["monitor_status"] in ("up", "down"):
            conn.execute("INSERT INTO monitor_events (service_id, status, ts) VALUES (?,?,?)",
                         (service_id, row["monitor_status"], now))
        conn.commit()


def reset_host_uptime(host_id: int) -> None:
    now = _iso(_now_dt())
    with get_conn() as conn:
        row = conn.execute("SELECT online FROM hosts WHERE id=?", (host_id,)).fetchone()
        conn.execute("DELETE FROM host_events WHERE host_id=?", (host_id,))
        if row is not None and row["online"] is not None:
            conn.execute("INSERT INTO host_events (host_id, status, ts) VALUES (?,?,?)",
                         (host_id, "up" if row["online"] else "down", now))
        conn.commit()


def reset_all_uptime() -> dict:
    now = _iso(_now_dt())
    with get_conn() as conn:
        conn.execute("DELETE FROM monitor_events")
        conn.execute("DELETE FROM host_events")
        for r in conn.execute("SELECT id, monitor_status FROM services WHERE monitored=1").fetchall():
            if r["monitor_status"] in ("up", "down"):
                conn.execute("INSERT INTO monitor_events (service_id, status, ts) VALUES (?,?,?)",
                             (r["id"], r["monitor_status"], now))
        for r in conn.execute("SELECT id, online FROM hosts WHERE online IS NOT NULL").fetchall():
            conn.execute("INSERT INTO host_events (host_id, status, ts) VALUES (?,?,?)",
                         (r["id"], "up" if r["online"] else "down", now))
        conn.commit()
    return {"ok": True}


# ── Host uptime (same engine, fed by liveness host_events) ────────────────────

def _host_events(conn, host_id: int):
    return [dict(r) for r in conn.execute(
        "SELECT status, ts FROM host_events WHERE host_id=? ORDER BY ts", (host_id,)).fetchall()]


def host_uptime(host_id: int, window_seconds: int, now: datetime | None = None) -> dict | None:
    now = now or _now_dt()
    with get_conn() as conn:
        evs = _host_events(conn, host_id)
        anchor = _anchor_status(conn, "host_events", "host_id", host_id, now.timestamp() - window_seconds)
    return _compute_uptime(evs, anchor, window_seconds, now)


def host_outages(host_id: int, window_seconds: int, limit: int = 10, now: datetime | None = None) -> list[dict]:
    now = now or _now_dt()
    with get_conn() as conn:
        evs = _host_events(conn, host_id)
    return _compute_outages(evs, window_seconds, limit, now)


def _events_by(conn, table: str, key_col: str, keys) -> dict:
    """Every stored event of many items in one query, {key: [{status, ts}, …]}."""
    keys = list(keys)
    out: dict = {k: [] for k in keys}
    if not keys:
        return out
    q = ",".join("?" * len(keys))
    for r in conn.execute(f"SELECT {key_col} AS k, status, ts FROM {table} WHERE {key_col} IN ({q}) "
                          f"ORDER BY {key_col}, ts", keys):
        out[r["k"]].append({"status": r["status"], "ts": r["ts"]})
    return out


def _anchor_from(evs: list[dict], start: float) -> str | None:
    """The state at `start`: the last event before it (same as _anchor_status)."""
    st = None
    for e in evs:
        t = _parse(e["ts"])
        if t and t.timestamp() < start:
            st = e["status"]
        elif t:
            break
    return st


def history_summary(service_ids, host_ids, now: datetime | None = None) -> dict:
    """For the chat notes (F-33): uptime and recent outages of many services and
    hosts from two grouped queries, instead of several queries per item.
    {"svc": {id: {"up24", "up7", "outages"}}, "host": {id: {"outages", "events"}}}."""
    now = now or _now_dt()
    with get_conn() as conn:
        sev = _events_by(conn, "monitor_events", "service_id", service_ids)
        hev = _events_by(conn, "host_events", "host_id", host_ids)
    out = {"svc": {}, "host": {}}
    for sid, evs in sev.items():
        u = {}
        for key, w in (("up24", 86400), ("up7", 7 * 86400)):
            r = _compute_uptime(evs, _anchor_from(evs, now.timestamp() - w), w, now)
            u[key] = r["pct"] if r else None
        out["svc"][sid] = {**u, "outages": _compute_outages(evs, 7 * 86400, 5, now)}
    for hid, evs in hev.items():
        out["host"][hid] = {"outages": _compute_outages(evs, 7 * 86400, 5, now), "events": evs}
    return out


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
        # Same rolling-window prune for host up/down history
        host_ids = [r[0] for r in conn.execute(
            "SELECT DISTINCT host_id FROM host_events WHERE ts < ?", (cutoff,)).fetchall()]
        for hid in host_ids:
            anchor = conn.execute(
                "SELECT status FROM host_events WHERE host_id=? AND ts < ? "
                "ORDER BY ts DESC LIMIT 1", (hid, cutoff)).fetchone()
            conn.execute("DELETE FROM host_events WHERE host_id=? AND ts < ?", (hid, cutoff))
            if anchor:
                conn.execute("INSERT INTO host_events (host_id, status, ts) VALUES (?,?,?)",
                             (hid, anchor["status"], cutoff))
        conn.commit()


# ── Public status page: ticks, payload, push ──────────────────────────────────

def _compute_ticks(evs: list[dict], anchor_status: str | None, minutes: int, now: datetime) -> list[str]:
    since = now.timestamp() - minutes * 60
    points: list[tuple[float, str]] = [(since, anchor_status or "unknown")]
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


def _ticks_for(table: str, key_col: str, key, minutes: int, now: datetime) -> list[str]:
    since_iso = _iso(datetime.fromtimestamp(now.timestamp() - minutes * 60, timezone.utc))
    with get_conn() as conn:
        anchor = conn.execute(
            f"SELECT status FROM {table} WHERE {key_col}=? AND ts < ? ORDER BY ts DESC LIMIT 1",
            (key, since_iso)).fetchone()
        evs = [dict(r) for r in conn.execute(
            f"SELECT status, ts FROM {table} WHERE {key_col}=? AND ts >= ? ORDER BY ts",
            (key, since_iso)).fetchall()]
    return _compute_ticks(evs, anchor["status"] if anchor else None, minutes, now)


def ticks(service_id: int, minutes: int = 60, now: datetime | None = None) -> list[str]:
    """Per-minute up/down/unknown for the last `minutes`, oldest→newest."""
    return _ticks_for("monitor_events", "service_id", service_id, minutes, now or _now_dt())


def host_ticks(host_id: int, minutes: int = 60, now: datetime | None = None) -> list[str]:
    return _ticks_for("host_events", "host_id", host_id, minutes, now or _now_dt())


def _bucket_history(evs, anchor_status, period_secs, count, now, label_fn):
    """Uptime % per bucket over the last `period_secs`, split into `count` slices,
    oldest→newest. 'unknown' periods (before monitoring) are no-data (pct=None)."""
    end = now.timestamp()
    start = end - period_secs
    slice_len = period_secs / count
    points = [(start, anchor_status or "unknown")]
    for e in evs:
        t = _parse(e["ts"])
        if t and t.timestamp() >= start:
            points.append((t.timestamp(), e["status"]))
    out = []
    for i in range(count):
        b0 = start + i * slice_len
        b1 = b0 + slice_len
        up = tot = 0.0
        held = {"maint": 0.0, "paused": 0.0}
        for j, (ts, state) in enumerate(points):
            seg_end = points[j + 1][0] if j + 1 < len(points) else end
            lo, hi = max(ts, b0), min(seg_end, b1)
            if hi <= lo:
                continue
            if state in ("up", "down"):
                tot += hi - lo
                if state == "up":
                    up += hi - lo
            elif state in held:
                held[state] += hi - lo
        pct = round(up / tot * 100, 2) if tot > 0 else None
        slot = {"date": label_fn(b0 + slice_len / 2), "pct": pct}
        # F-28: a slot mostly spent paused shows grey ('paused') or, with a reason,
        # orange ('maint') — never as downtime.
        kind = max(held, key=held.get)
        if held[kind] > 0 and held[kind] >= tot:
            slot["pause"] = kind
        out.append(slot)
    return out


def _bucketed_for(table, key_col, key, period_secs, count, now, label_fn):
    since_iso = _iso(datetime.fromtimestamp(now.timestamp() - period_secs, timezone.utc))
    with get_conn() as conn:
        anchor = conn.execute(
            f"SELECT status FROM {table} WHERE {key_col}=? AND ts < ? ORDER BY ts DESC LIMIT 1",
            (key, since_iso)).fetchone()
        evs = [dict(r) for r in conn.execute(
            f"SELECT status, ts FROM {table} WHERE {key_col}=? AND ts >= ? ORDER BY ts",
            (key, since_iso)).fetchall()]
    return _bucket_history(evs, anchor["status"] if anchor else None, period_secs, count, now, label_fn)


# Bar tooltips in Boltarr's timezone (Settings → General), else the server clock (F-38)
def _local(ts, tz=None):
    tz = tz if tz is not None else get_timezone()
    return datetime.fromtimestamp(ts, tz) if tz else datetime.fromtimestamp(ts)
def _min_label(ts, tz=None): return _local(ts, tz).strftime("%b %d %H:%M")
def _hr_label(ts, tz=None):  return _local(ts, tz).strftime("%b %d %H:%M")
def _day_label(ts, tz=None): return _local(ts, tz).strftime("%b %d")


def _hour_ticks() -> int:
    """Number of slices in the 1-hour bar: one per real probe (adaptive to the
    configured probe interval). At the default 60s that's 60 per-minute ticks."""
    return max(1, round(3600 / get_check_seconds()))


def tick_windows(table, key_col, key, now=None):
    """Tick bars for 1h (one tick per probe), 24h (hourly), 7d + 30d (daily)."""
    now = now or _now_dt()
    tz = get_timezone()                       # read once, not per bar
    lbl = lambda f: (lambda ts: f(ts, tz))
    return {
        "1h":  _bucketed_for(table, key_col, key, 3600, _hour_ticks(), now, lbl(_min_label)),
        "24h": _bucketed_for(table, key_col, key, 86400, 24, now, lbl(_hr_label)),
        "7d":  _bucketed_for(table, key_col, key, 7 * 86400, 7, now, lbl(_day_label)),
        "30d": _bucketed_for(table, key_col, key, 30 * 86400, 30, now, lbl(_day_label)),
    }


def uptime_windows(fn, key, now=None):
    """{1h,24h,7d,30d} uptime % using the given uptime function (service or host)."""
    now = now or _now_dt()
    out = {}
    for k, w in (("1h", 3600), ("24h", 86400), ("7d", 7 * 86400), ("30d", 30 * 86400)):
        u = fn(key, w, now)
        out[k] = u["pct"] if u else None
    return out


ITEM_INCIDENTS = 10   # outages sent with each status-page item, for its own expand view


def _incident(key, name, section, o) -> dict:
    return {"key": key, "name": name, "section": section, "start": o["start"],
            "end": o["end"], "seconds": o["seconds"], "ongoing": o["end"] is None}


def build_status_payload() -> dict:
    with get_conn() as conn:
        rows = [dict(r) for r in conn.execute("""
            SELECT s.id, s.name, s.public_name, s.monitor_status, s.monitored,
                   s.monitor_pause_reason, s.monitor_resume_at
            FROM services s
            WHERE s.public = 1 AND (s.monitored = 1 OR s.monitor_paused_at IS NOT NULL)
            ORDER BY COALESCE(NULLIF(TRIM(s.public_name), ''), s.name)
        """).fetchall()]
    services = []
    incidents = []
    # Match the real event-retention window — older events are pruned, so an
    # incident list reaching further back would only ever show partial history.
    WINDOW = RETENTION_DAYS * 86400
    for r in rows:
        name = (r.get("public_name") or "").strip() or r["name"]
        key = f"svc-{r['id']}"
        own = [_incident(key, name, "services", o) for o in outages(r["id"], WINDOW, limit=25)]
        item = {
            "key": key,
            "name": name,
            "status": r.get("monitor_status") or "unknown",
            "uptime": uptime_windows(uptime, r["id"]),
            "ticks": tick_windows("monitor_events", "service_id", r["id"]),
            "incidents": own[:ITEM_INCIDENTS],
        }
        if not r["monitored"]:          # a pause (F-28): Paused, or Maintenance + its note
            reason = (r.get("monitor_pause_reason") or "").strip()
            item["status"] = "maintenance" if reason else "paused"
            if reason:
                item["note"] = reason
            if r.get("monitor_resume_at"):
                item["until"] = r["monitor_resume_at"]
        services.append(item)
        incidents.extend(own)
    # Public hosts — SANITIZED: only a public name (never the IP), status,
    # uptime and ticks leave the LAN. Networking gear goes in its own section.
    NETWORKING = {"router", "gateway", "switch", "unmanaged-switch", "firewall", "ap"}
    with get_conn() as conn:
        host_rows = [dict(r) for r in conn.execute("""
            SELECT id, public_name, hostname, online, device_type
            FROM hosts
            WHERE public = 1 AND ip NOT LIKE 'node-%'
            ORDER BY COALESCE(NULLIF(TRIM(public_name), ''), hostname, '')
        """).fetchall()]
    hosts, networking = [], []
    for r in host_rows:
        name = (r.get("public_name") or "").strip() or (r.get("hostname") or "").strip() or "Host"
        sect = "networking" if (r.get("device_type") or "") in NETWORKING else "hosts"
        key = f"host-{r['id']}"
        own = [_incident(key, name, sect, o) for o in host_outages(r["id"], WINDOW, limit=25)]
        item = {
            "key": key,
            "name": name,
            "status": "up" if r["online"] == 1 else "down" if r["online"] == 0 else "unknown",
            "uptime": uptime_windows(host_uptime, r["id"]),
            "ticks": tick_windows("host_events", "host_id", r["id"]),
            "incidents": own[:ITEM_INCIDENTS],
        }
        (networking if sect == "networking" else hosts).append(item)
        incidents.extend(own)
    incidents.sort(key=lambda x: x["start"], reverse=True)
    return {"updated_at": _iso(_now_dt()), "title": "Service Status",
            "services": services, "hosts": hosts, "networking": networking,
            "incidents": incidents[:25], "announcements": [],
            # R-22: planned maintenance (upcoming + in progress), public items only
            "maintenance_windows": planned.status_payload(),
            # F-27: the status page warns visitors once no update came for this long
            "stale_after_minutes": stale_minutes()}


STALE_DEFAULT = 5


def stale_minutes() -> int:
    try:
        return min(1440, max(1, int(get_statuspage_config().get("stale_minutes") or STALE_DEFAULT)))
    except Exception:
        return STALE_DEFAULT


_push_lock = threading.Lock()
_push_health = {"last_ok": None, "last_error": None, "last_error_at": None}


def push_health() -> dict:
    with _push_lock:
        return dict(_push_health)


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
    except Exception as e:
        err = (str(e) or type(e).__name__)[:300]
        if isinstance(e, httpx.HTTPStatusError) and e.response.status_code == 413:
            err = "The status page refused the update as too big (413). Update the status page image."
        with _push_lock:
            first = _push_health["last_error"] != err
            _push_health.update(last_error=err, last_error_at=_iso(_now_dt()))
        if first:                          # log a new problem once, not every minute
            print(f"[statuspage] push failed: {err}")
        return False, err
    with _push_lock:
        _push_health.update(last_ok=_iso(_now_dt()), last_error=None)
    return True, ""


# ── Loops ─────────────────────────────────────────────────────────────────────
# Three loops, so a slow status page or a slow digest AI can't delay the checks
# (F-18). Each runs one iteration inside maintenance.loop_work(), so a restore can
# pause all of them.

def _tick() -> float:
    return min(get_check_seconds(), 60)


def _loop() -> None:
    _stop.wait(3)
    last_prune = 0.0
    last_sweep = 0.0
    while not _stop.is_set():
        started = time.monotonic()
        try:
            with maintenance.loop_work():
                check = get_check_seconds()
                now_ts = _now_dt().timestamp()
                # Probe services only when the configured interval has elapsed. This
                # is the detection cadence — slower interval = slower to notice a
                # change, but cheaper.
                try:
                    if planned.tick():
                        push_status()         # the status page shows it started / ended
                except Exception as e:
                    print(f"[monitor] planned maintenance: {e}")
                try:
                    if resume_due():
                        last_sweep = 0.0      # probe the resumed ones straight away
                except Exception:
                    pass
                if now_ts - last_sweep >= check - 1:     # 1 s slack: the wait below can end a hair early
                    _sweep()
                    last_sweep = now_ts
                # Held-back alerts (quiet hours, failed sends) go out as one summary.
                try:
                    flush_queue()
                except Exception as e:
                    print(f"[monitor] held alerts not sent: {e}")
                # prune roughly once a day
                if _now_dt().timestamp() - last_prune > 86400:
                    prune_events()
                    try:
                        from . import changes
                        changes.prune()
                    except Exception:
                        pass
                    try:
                        from . import ai_history
                        ai_history.prune()
                    except Exception:
                        pass
                    try:
                        from . import scanner
                        scanner.prune_runs()
                    except Exception as e:
                        print(f"[monitor] scan history not pruned: {e}")
                    last_prune = _now_dt().timestamp()
        except Exception as e:
            print(f"[monitor] check round failed: {e}")
        # Wait out the rest of the tick: the time a round took counts, so slow
        # (dead) targets don't stretch a 60 s interval to 70+ s.
        _stop.wait(max(1.0, _tick() - (time.monotonic() - started)))


def _push_loop() -> None:
    """Heartbeat push to the public status page (LAN-only), at least once a minute —
    decoupled from probing so the bars/percentages stay fresh even when the probe
    interval is long."""
    _stop.wait(5)
    while not _stop.is_set():
        try:
            with maintenance.loop_work():
                push_status()
        except Exception:
            pass
        _stop.wait(_tick())


def _digest_loop() -> None:
    """Daily change-alert digest: checked every minute, sent once a day."""
    _stop.wait(10)
    while not _stop.is_set():
        try:
            with maintenance.loop_work():
                from . import changes
                changes.maybe_send_digest()
        except Exception as e:
            print(f"[digest] failed: {e}")
        _stop.wait(60)


def start_monitor() -> None:
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _threads.clear()
    for target, name in ((_loop, "service-monitor"), (_push_loop, "status-push"), (_digest_loop, "digest")):
        t = threading.Thread(target=target, name=name, daemon=True)
        t.start()
        _threads.append(t)
    _thread = _threads[0]
