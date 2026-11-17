"""Planned maintenance (R-22, v0.28.0).

A window has a title, an optional note, a start and an end (stored in UTC), and
covers services and/or devices (a device brings all its services). It moves
planned -> active -> done:

  * planned: nothing happens in Boltarr yet; the status page lists it as upcoming.
  * active:  each covered service that is being monitored is paused with the window's
             title as the reason (the F-28 pause: orange "Maint", no alerts, no
             downtime) until the window's end. A covered device's own offline/online
             alerts are held.
  * done:    the paused services come back on (by the window, or by hand earlier); a
             covered device still offline gets its normal "went offline" alert now.

"Done" early ends it now; changing the end of an active window moves the resume time
of the services it paused. A service paused or resumed by hand during the window is
the user's from then on (its link to the window is cleared).

tick() moves windows along; it runs in the monitor loop and on the reads that show
them, so windows start and end on time even with the background loops off.
"""
import json
import threading
from datetime import datetime, timezone

from .database import get_conn

TITLE_MAX = 100
NOTE_MAX = 500
DONE_KEEP_DAYS = 14          # finished windows stay in the list this long

_lock = threading.Lock()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def _parse(iso: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat(iso) if iso else None
    except ValueError:
        return None


def _ids(text: str | None) -> list[int]:
    try:
        return [int(x) for x in json.loads(text or "[]")]
    except (ValueError, TypeError):
        return []


def _row(r) -> dict:
    w = dict(r)
    w["service_ids"] = _ids(w.get("service_ids"))
    w["host_ids"] = _ids(w.get("host_ids"))
    return w


def get(conn, wid: int) -> dict | None:
    r = conn.execute("SELECT * FROM maintenance_windows WHERE id=?", (wid,)).fetchone()
    return _row(r) if r else None


def covered_services(conn, w: dict) -> list[int]:
    """The services a window covers: the ones picked, plus every service on a picked device."""
    ids = set(w["service_ids"])
    if w["host_ids"]:
        q = ",".join("?" * len(w["host_ids"]))
        ids |= {r[0] for r in conn.execute(f"SELECT id FROM services WHERE host_id IN ({q})", w["host_ids"])}
    if not ids:
        return []
    q = ",".join("?" * len(ids))
    return [r[0] for r in conn.execute(f"SELECT id FROM services WHERE id IN ({q}) ORDER BY id", list(ids))]


def pause_reason(w: dict) -> str:
    return w["title"]


# ── Moving windows along ──────────────────────────────────────────────────────

def _start(conn, w: dict) -> None:
    from . import monitor
    for sid in covered_services(conn, w):
        s = conn.execute("SELECT monitored FROM services WHERE id=?", (sid,)).fetchone()
        if not s or not s["monitored"]:
            continue                       # off or already paused by hand: left as it is
        monitor.set_monitored(conn, sid, False, resume_at=w["ends_at"], reason=pause_reason(w), pause=True)
        conn.execute("UPDATE services SET maint_window_id=? WHERE id=?", (w["id"], sid))
    conn.execute("UPDATE maintenance_windows SET state='active' WHERE id=?", (w["id"],))


def _finish(conn, w: dict) -> list[str]:
    """End a window: its services back on, and the IPs of covered devices still
    offline (their held "went offline" alert goes out now)."""
    from . import monitor
    for r in conn.execute("SELECT id FROM services WHERE maint_window_id=? AND monitored=0", (w["id"],)).fetchall():
        monitor.set_monitored(conn, r["id"], True)
    conn.execute("UPDATE services SET maint_window_id=NULL WHERE maint_window_id=?", (w["id"],))
    conn.execute("UPDATE maintenance_windows SET state='done' WHERE id=?", (w["id"],))
    still_down = []
    if w["state"] == "active" and w["host_ids"]:
        q = ",".join("?" * len(w["host_ids"]))
        still_down = [r["ip"] for r in conn.execute(
            f"SELECT ip FROM hosts WHERE id IN ({q}) AND online=0 AND offline_alerted=0", w["host_ids"])]
    return still_down


def _alert_still_down(conn, ips: list[str]) -> None:
    from . import changes
    for ip in ips:
        if host_in_window(conn, ip):       # another window still covers it
            continue
        res = changes.alert_transition(conn, ip, "host_offline")
        conn.execute("UPDATE hosts SET offline_alerted=? WHERE ip=?", (1 if res in ("sent", "queued") else 0, ip))
    conn.commit()


def tick() -> bool:
    """Start windows whose time has come and end the ones that are over. True if
    anything changed (the caller may push the status page)."""
    now = _now()
    changed, alerts = False, []
    with _lock, get_conn() as conn:
        rows = [_row(r) for r in conn.execute(
            "SELECT * FROM maintenance_windows WHERE state IN ('planned','active') ORDER BY starts_at")]
        for w in rows:
            start, end = _parse(w["starts_at"]), _parse(w["ends_at"])
            if not start or not end:
                continue
            if end <= now:
                alerts += _finish(conn, w)            # also a planned one Boltarr was off for
                changed = True
            elif w["state"] == "planned" and start <= now:
                _start(conn, w)
                changed = True
        conn.execute("DELETE FROM maintenance_windows WHERE state='done' AND ends_at < ?",
                     (_iso(datetime.fromtimestamp(now.timestamp() - DONE_KEEP_DAYS * 86400, timezone.utc)),))
        conn.commit()
        if alerts:
            _alert_still_down(conn, alerts)
    return changed


def end_now(wid: int) -> bool:
    """"Done": end an active window (or drop a planned one's time) now."""
    with _lock, get_conn() as conn:
        w = get(conn, wid)
        if not w or w["state"] == "done":
            return False
        conn.execute("UPDATE maintenance_windows SET ends_at=? WHERE id=?", (_iso(_now()), wid))
        alerts = _finish(conn, w)
        conn.commit()
        _alert_still_down(conn, alerts)
    return True


def delete(wid: int) -> bool:
    with _lock, get_conn() as conn:
        w = get(conn, wid)
        if not w:
            return False
        alerts = _finish(conn, w) if w["state"] == "active" else []
        conn.execute("DELETE FROM maintenance_windows WHERE id=?", (wid,))
        conn.commit()
        _alert_still_down(conn, alerts)
    return True


def save(wid: int | None, title: str, note: str, starts_at: datetime, ends_at: datetime,
         service_ids: list[int], host_ids: list[int]) -> int:
    """Add (wid None) or change a window. An active window keeps its start and what
    it covers; a new end moves the resume time of the services it paused."""
    with _lock, get_conn() as conn:
        if wid is None:
            cur = conn.execute(
                "INSERT INTO maintenance_windows (title, note, starts_at, ends_at, service_ids, host_ids) "
                "VALUES (?,?,?,?,?,?)",
                (title, note, _iso(starts_at), _iso(ends_at), json.dumps(service_ids), json.dumps(host_ids)))
            conn.commit()
            return cur.lastrowid
        w = get(conn, wid)
        if w["state"] == "active":
            conn.execute("UPDATE maintenance_windows SET title=?, note=?, ends_at=? WHERE id=?",
                         (title, note, _iso(ends_at), wid))
            conn.execute("UPDATE services SET monitor_resume_at=?, monitor_pause_reason=? "
                         "WHERE maint_window_id=? AND monitored=0", (_iso(ends_at), title, wid))
        else:
            conn.execute("UPDATE maintenance_windows SET title=?, note=?, starts_at=?, ends_at=?, "
                         "service_ids=?, host_ids=? WHERE id=?",
                         (title, note, _iso(starts_at), _iso(ends_at),
                          json.dumps(service_ids), json.dumps(host_ids), wid))
        conn.commit()
        return wid


# ── Read side ─────────────────────────────────────────────────────────────────

def host_in_window(conn, ip: str) -> bool:
    """Is this device (or the device this alias IP belongs to) in an active window?
    Its offline/online alerts are held meanwhile (owner choice 3A)."""
    r = conn.execute("SELECT id FROM hosts WHERE ip=?", (ip,)).fetchone() or conn.execute(
        "SELECT host_id AS id FROM host_aliases WHERE ip=?", (ip,)).fetchone()
    if not r:
        return False
    return any(r["id"] in _ids(w["host_ids"]) for w in conn.execute(
        "SELECT host_ids FROM maintenance_windows WHERE state='active'"))


def list_windows() -> list[dict]:
    with get_conn() as conn:
        out = []
        for r in conn.execute("SELECT * FROM maintenance_windows ORDER BY "
                              "CASE state WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, "
                              "starts_at"):
            w = _row(r)
            svc = covered_services(conn, w)
            names = lambda sql, ids: [x[0] for x in conn.execute(
                sql.format(",".join("?" * len(ids))), ids)] if ids else []
            w["service_names"] = names("SELECT name FROM services WHERE id IN ({}) ORDER BY name", w["service_ids"])
            w["host_names"] = names("SELECT COALESCE(NULLIF(hostname,''), ip) FROM hosts WHERE id IN ({}) "
                                    "ORDER BY 1", w["host_ids"])
            w["covered_count"] = len(svc)
            out.append(w)
        return out


def status_payload() -> list[dict]:
    """Planned and active windows for the public status page: only the public
    services and devices they cover (by key), never anything private. A window that
    covers nothing public isn't sent at all."""
    with get_conn() as conn:
        out = []
        for r in conn.execute("SELECT * FROM maintenance_windows WHERE state IN ('planned','active') "
                              "ORDER BY starts_at"):
            w = _row(r)
            keys = []
            svc = covered_services(conn, w)
            if svc:
                q = ",".join("?" * len(svc))
                keys += [f"svc-{x[0]}" for x in conn.execute(
                    f"SELECT id FROM services WHERE id IN ({q}) AND public=1", svc)]
            if w["host_ids"]:
                q = ",".join("?" * len(w["host_ids"]))
                keys += [f"host-{x[0]}" for x in conn.execute(
                    f"SELECT id FROM hosts WHERE id IN ({q}) AND public=1 AND ip NOT LIKE 'node-%'", w["host_ids"])]
            if keys:
                out.append({"title": w["title"], "note": w["note"], "start": w["starts_at"],
                            "end": w["ends_at"], "affects": keys})
        return out
