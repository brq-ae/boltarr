"""v0.27.0 Part 2 — alerts you can rely on.

F-17 no silent host failures, F-18 one stuck check can't freeze monitoring,
F-19 a failed liveness sweep changes nothing, F-27 failed sends are retried and
shown, F-28 pauses count as no data, F-29 5xx = down + accepted replies,
F-30 results from before a pause/change are dropped."""
import http.server
import ipaddress
import subprocess
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest

from backend import changes, liveness, maintenance, monitor, notify
from backend.database import get_conn
from conftest import fake_ntfy

NOW = datetime(2026, 11, 20, 12, 0, tzinfo=timezone.utc)


def _iso(dt):
    return dt.isoformat(timespec="seconds")


# ── helpers ───────────────────────────────────────────────────────────────────

@pytest.fixture
def svc(client):
    """A monitored demo service on its own host; cleaned up afterwards."""
    made = []

    def make(ip="10.27.0.10", name="Demo web", url=None, port=80, check_type="tcp", online=1):
        client.post("/api/hosts", json={"ip": ip})
        with get_conn() as conn:
            conn.execute("UPDATE hosts SET online=?, offline_alerted=0 WHERE ip=?", (online, ip))
            conn.commit()
        r = client.post(f"/api/hosts/{ip}/services",
                        json={"name": name, "port": port, "url": url, "check_type": check_type})
        assert r.status_code == 201, r.text
        sid = r.json()["id"]
        with get_conn() as conn:
            conn.execute("UPDATE services SET monitored=1, monitor_status='up' WHERE id=?", (sid,))
            conn.commit()
        made.append(ip)
        return sid

    yield make
    with get_conn() as conn:
        for ip in made:
            conn.execute("DELETE FROM hosts WHERE ip=?", (ip,))
        conn.execute("DELETE FROM alert_queue")
        conn.commit()


def _row(sid):
    with get_conn() as conn:
        return dict(conn.execute(monitor._SELECT + " WHERE s.id=?", (sid,)).fetchone())


def _events(sid):
    with get_conn() as conn:
        return [r["status"] for r in conn.execute(
            "SELECT status FROM monitor_events WHERE service_id=? ORDER BY ts, id", (sid,))]


def _queue():
    with get_conn() as conn:
        return [dict(r) for r in conn.execute("SELECT reason, line FROM alert_queue ORDER BY id")]


def _run(sid, result):
    """One check round for one service, with the given probe result."""
    with get_conn() as conn:
        return monitor._process(conn, _row(sid), result)


@pytest.fixture
def quiet(monkeypatch):
    state = {"on": False}
    monkeypatch.setattr(monitor, "in_quiet_window", lambda *a, **k: state["on"])
    return state


@pytest.fixture
def no_grace(monkeypatch):
    monkeypatch.setattr(monitor, "_grace_seconds", lambda: 0)


# ── F-17: evaluate() ──────────────────────────────────────────────────────────

def test_quiet_holds_a_down_alert_and_never_marks_it_sent():
    r = monitor.evaluate("up", "down", _iso(NOW - timedelta(minutes=10)), 0, 300, NOW, quiet=True)
    assert r["alert"] is None and r["alerted"] == 0


def test_hold_waits_for_the_host_alert():
    r = monitor.evaluate("up", "down", _iso(NOW - timedelta(minutes=10)), 0, 300, NOW, hold=True)
    assert r["alert"] is None and r["alerted"] == 0
    r = monitor.evaluate("down", "down", _iso(NOW - timedelta(minutes=10)), 0, 300, NOW)
    assert r["alert"] == "down" and r["alerted"] == 1          # hold lifted -> it fires


def test_recovery_is_never_swallowed():
    fs = _iso(NOW - timedelta(minutes=30))
    assert monitor.evaluate("down", "up", fs, 1, 300, NOW, hold=True)["alert"] == "up"
    r = monitor.evaluate("down", "up", fs, 1, 300, NOW, quiet=True)
    assert r["alert"] == "up_quiet" and r["down_seconds"] == 1800
    # recovered before any alert went out: still quiet
    assert monitor.evaluate("down", "up", fs, 0, 300, NOW)["alert"] is None


# ── F-17: the real path ───────────────────────────────────────────────────────

def test_offline_host_without_its_own_alert_still_alerts_the_service(svc, monkeypatch, no_grace, quiet):
    sent = fake_ntfy(monkeypatch)
    sid = svc(online=0)                                        # host offline, but no host alert went out
    _run(sid, "down")
    assert [m["title"] for m in sent] == ["Demo web is down"]


def test_host_alert_sent_holds_the_service_alert_until_the_host_is_back(svc, monkeypatch, no_grace, quiet):
    sent = fake_ntfy(monkeypatch)
    sid = svc(ip="10.27.0.11", online=0)
    with get_conn() as conn:
        conn.execute("UPDATE hosts SET offline_alerted=1 WHERE ip='10.27.0.11'")
        conn.commit()
    _run(sid, "down")
    assert sent == []                                          # the host alert covers it
    with get_conn() as conn:                                   # host back, service still down
        conn.execute("UPDATE hosts SET online=1, offline_alerted=0 WHERE ip='10.27.0.11'")
        conn.commit()
    _run(sid, "down")
    assert [m["title"] for m in sent] == ["Demo web is down"]


def test_recovery_sent_while_host_still_marked_offline(svc, monkeypatch, no_grace, quiet):
    sent = fake_ntfy(monkeypatch)
    sid = svc(ip="10.27.0.12")
    _run(sid, "down")                                          # alerted at 5 min ...
    with get_conn() as conn:                                   # ... host marked offline later
        conn.execute("UPDATE hosts SET online=0, offline_alerted=1 WHERE ip='10.27.0.12'")
        conn.commit()
    _run(sid, "up")
    assert [m["title"] for m in sent] == ["Demo web is down", "Demo web recovered"]


def test_quiet_hours_recovery_goes_into_the_summary(svc, monkeypatch, no_grace, quiet):
    sent = fake_ntfy(monkeypatch)
    sid = svc(ip="10.27.0.13")
    _run(sid, "down")
    quiet["on"] = True
    _run(sid, "up")
    assert len(sent) == 1 and [q["reason"] for q in _queue()] == ["quiet"]
    assert monitor.flush_queue() is None                       # still quiet: nothing goes out
    quiet["on"] = False
    assert monitor.flush_queue() == "sent"
    assert sent[-1]["title"] == "While quiet hours were on (1)"
    assert "Demo web is back up" in sent[-1]["message"] and _queue() == []


def test_quiet_host_alerts_are_queued_not_dropped(svc, monkeypatch, quiet):
    sent = fake_ntfy(monkeypatch)
    monkeypatch.setattr(changes, "is_alert_worthy", lambda conn, e, subnets: True)
    svc(ip="10.27.0.14")
    quiet["on"] = True
    with get_conn() as conn:
        assert changes.alert_transition(conn, "10.27.0.14", "host_offline") == "queued"
        assert changes.alert_transition(conn, "10.27.0.14", "host_online") == "queued"
    assert sent == [] and len(_queue()) == 2
    quiet["on"] = False
    monitor.flush_queue()
    body = sent[0]["message"].splitlines()
    assert len(sent) == 1 and "went offline" in body[0] and "back online" in body[1]


def test_queue_needs_notifications_on(svc, monkeypatch):
    monkeypatch.setattr(notify, "is_on", lambda: False)
    monitor.queue_alert("demo line", "quiet")
    assert _queue() == []


def test_liveness_remembers_whether_the_host_alert_went_out(client, svc, monkeypatch):
    sent = fake_ntfy(monkeypatch)
    svc(ip="10.27.1.5")
    client.post("/api/subnets", json={"name": "Demo F-17", "cidr": "10.27.1.0/24"})
    monkeypatch.setattr(liveness, "get_liveness_config", lambda: {"enabled": True, "offline_after": 1})
    net = ipaddress.ip_network("10.27.1.0/24")
    monkeypatch.setattr(liveness, "_sweep_live_ips", lambda: (set(), [net]))
    try:
        monkeypatch.setattr(changes, "is_alert_worthy", lambda conn, e, subnets: False)   # not in scope
        liveness.sweep_once()
        with get_conn() as conn:
            assert conn.execute("SELECT online, offline_alerted FROM hosts WHERE ip='10.27.1.5'").fetchone()[:] == (0, 0)
            conn.execute("UPDATE hosts SET online=1 WHERE ip='10.27.1.5'")
            conn.commit()
        monkeypatch.setattr(changes, "is_alert_worthy", lambda conn, e, subnets: True)
        liveness.sweep_once()
        with get_conn() as conn:
            assert conn.execute("SELECT offline_alerted FROM hosts WHERE ip='10.27.1.5'").fetchone()[0] == 1
        assert any("went offline" in m["title"] for m in sent)
        monkeypatch.setattr(liveness, "_sweep_live_ips", lambda: ({"10.27.1.5"}, [net]))
        liveness.sweep_once()                                  # back online clears it
        with get_conn() as conn:
            assert conn.execute("SELECT online, offline_alerted FROM hosts WHERE ip='10.27.1.5'").fetchone()[:] == (1, 0)
    finally:
        with get_conn() as conn:
            conn.execute("DELETE FROM subnets WHERE cidr='10.27.1.0/24'")
            conn.commit()


# ── F-18: stuck and slow checks ───────────────────────────────────────────────

class _Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/stream"):                    # a camera-style endless body
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=demo")
            self.end_headers()
            try:
                while True:
                    self.wfile.write(b"--demo\r\n" + b"x" * 4096 + b"\r\n")
                    self.wfile.flush()
                    time.sleep(0.05)
            except Exception:
                return
        code = int(self.path.strip("/") or 200)
        self.send_response(code)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")


@pytest.fixture(scope="module")
def web():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def test_endless_stream_check_finishes_at_once(web):
    t0 = time.monotonic()
    assert monitor._probe_http(web + "/stream") is True
    assert time.monotonic() - t0 < 3


def test_stuck_checks_dont_hold_up_the_others(monkeypatch):
    release = threading.Event()

    def fake(s):
        if s["stuck"]:
            release.wait(30)
        return "up"
    monkeypatch.setattr(monitor, "probe", fake)
    services = [{"id": i, "stuck": i < 3} for i in range(8)]
    t0 = time.monotonic()
    try:
        res = monitor.probe_all(services, pool=2, deadline=0.5)  # 3 stuck, only 2 workers
    finally:
        release.set()
    assert time.monotonic() - t0 < 3
    assert [res[i] for i in range(3)] == ["down"] * 3          # too slow = down
    assert all(res[i] == "up" for i in range(3, 8))            # the rest still got checked


def test_slow_dead_targets_run_side_by_side(monkeypatch):
    monkeypatch.setattr(monitor, "probe", lambda s: (time.sleep(0.4), "down")[1])
    t0 = time.monotonic()
    res = monitor.probe_all([{"id": i} for i in range(16)])    # 16 x 0.4 s one by one = 6.4 s
    assert len(res) == 16 and time.monotonic() - t0 < 2.5


def test_restore_can_pause_monitoring_while_a_check_is_stuck(monkeypatch):
    release = threading.Event()
    monkeypatch.setattr(monitor, "probe", lambda s: (release.wait(30), "up")[1])

    def round_():
        with maintenance.loop_work():
            monitor.probe_all([{"id": 1}], deadline=0.5)
    t = threading.Thread(target=round_)
    t.start()
    time.sleep(0.1)
    t0 = time.monotonic()
    try:
        with maintenance.exclusive(timeout=10):
            assert time.monotonic() - t0 < 3
    finally:
        release.set()
        t.join(5)


def test_slow_push_and_digest_dont_delay_checks(monkeypatch):
    block = threading.Event()
    swept = []
    stop = threading.Event()
    monkeypatch.setattr(monitor, "_stop", stop)
    monkeypatch.setattr(monitor, "_thread", None)
    monkeypatch.setattr(monitor, "get_check_seconds", lambda: 1)
    monkeypatch.setattr(monitor, "_sweep", lambda: swept.append(time.monotonic()))
    monkeypatch.setattr(monitor, "push_status", lambda: block.wait(30))
    monkeypatch.setattr(changes, "maybe_send_digest", lambda: block.wait(30))
    monkeypatch.setattr(monitor, "flush_queue", lambda: None)
    monkeypatch.setattr(monitor, "resume_due", lambda: [])
    monkeypatch.setattr(monitor, "prune_events", lambda: None)
    try:
        monitor.start_monitor()
        names = {t.name for t in monitor._threads}
        assert names == {"service-monitor", "status-push", "digest"}
        time.sleep(6)                         # 3 s start-up wait, then a round every second
        assert len(swept) >= 2
    finally:
        stop.set()
        block.set()
        for t in monitor._threads:
            t.join(5)


# ── F-19: a failed liveness sweep ─────────────────────────────────────────────

_EMPTY_XML = (b'<?xml version="1.0"?><nmaprun scanner="nmap" args="nmap -sn" start="1" version="7.94">'
              b'<scaninfo type="syn" protocol="tcp" numservices="0" services=""/>'
              b'<runstats><finished time="2" timestr="" elapsed="1.0" summary="" exit="success"/>'
              b'<hosts up="0" down="256" total="256"/></runstats></nmaprun>')


def test_failed_subnet_sweep_is_left_out(client, monkeypatch):
    calls = []

    def fake_run(args, **kw):
        cidr = args[-1]
        calls.append(cidr)
        if cidr == "10.27.2.0/24":
            raise subprocess.TimeoutExpired(args, 120)
        if cidr == "10.27.3.0/24":
            return subprocess.CompletedProcess(args, 1, b"", b"demo: nmap broke")
        return subprocess.CompletedProcess(args, 0, _EMPTY_XML, b"")
    with get_conn() as conn:
        for c in ("10.27.2.0/24", "10.27.3.0/24", "10.27.4.0/24"):
            conn.execute("INSERT INTO subnets (name, cidr) VALUES (?, ?)", ("Demo " + c, c))
        conn.commit()
    monkeypatch.setattr(liveness.subprocess, "run", fake_run)
    try:
        live, swept = liveness._sweep_live_ips()
        assert {str(n) for n in swept} >= {"10.27.4.0/24"}
        assert not {"10.27.2.0/24", "10.27.3.0/24"} & {str(n) for n in swept}
    finally:
        with get_conn() as conn:
            conn.execute("DELETE FROM subnets WHERE cidr LIKE '10.27.%'")
            conn.commit()


def test_hosts_in_failed_or_no_subnet_keep_their_state(client, monkeypatch):
    ips = {"failed": "10.27.5.9", "ok": "10.27.6.9", "outside": "10.27.250.9"}
    for ip in ips.values():
        client.post("/api/hosts", json={"ip": ip})
    with get_conn() as conn:
        conn.execute("UPDATE hosts SET online=1, miss_count=0 WHERE ip LIKE '10.27.%'")
        conn.commit()
    monkeypatch.setattr(liveness, "get_liveness_config", lambda: {"enabled": True, "offline_after": 1})
    monkeypatch.setattr(liveness, "_sweep_live_ips", lambda: (set(), [ipaddress.ip_network("10.27.6.0/24")]))
    fake_ntfy(monkeypatch)
    try:
        liveness.sweep_once()
        with get_conn() as conn:
            st = {r["ip"]: (r["online"], r["miss_count"]) for r in conn.execute(
                "SELECT ip, online, miss_count FROM hosts WHERE ip IN (?,?,?)", tuple(ips.values()))}
        assert st[ips["failed"]] == (1, 0)                    # its sweep failed: unchanged
        assert st[ips["outside"]] == (1, 0)                   # in no subnet: unchanged
        assert st[ips["ok"]] == (0, 1)                        # really missed: offline
    finally:
        with get_conn() as conn:
            conn.execute("DELETE FROM hosts WHERE ip LIKE '10.27.%'")
            conn.commit()


# ── F-27: failed sends ────────────────────────────────────────────────────────

def test_failed_down_alert_is_tried_again(svc, monkeypatch, no_grace, quiet):
    sent = fake_ntfy(monkeypatch, ok=False)
    sid = svc(ip="10.27.0.20")
    _run(sid, "down")
    assert _row(sid)["monitor_alerted"] == 0                   # not marked sent
    fake_ntfy(monkeypatch, sent, ok=True)
    _run(sid, "down")
    assert [m["title"] for m in sent] == ["Demo web is down", "Demo web is down"]
    assert _row(sid)["monitor_alerted"] == 1


def test_failed_recovery_waits_in_the_queue(svc, monkeypatch, no_grace, quiet):
    sent = fake_ntfy(monkeypatch)
    sid = svc(ip="10.27.0.21")
    _run(sid, "down")
    fake_ntfy(monkeypatch, sent, ok=False)
    _run(sid, "up")
    assert [q["reason"] for q in _queue()] == ["failed"]
    assert monitor.flush_queue() == "failed" and len(_queue()) == 1   # kept while ntfy is down
    fake_ntfy(monkeypatch, sent, ok=True)
    assert monitor.flush_queue() == "sent" and _queue() == []
    assert sent[-1]["title"] == "Alerts that couldn't be sent earlier (1)"


def test_after_a_failure_sends_skip_the_network_for_a_while(monkeypatch):
    calls = []
    monkeypatch.setattr(notify, "is_on", lambda: True)
    monkeypatch.setattr(notify, "_fail_mono", 0.0)
    monkeypatch.setattr(notify, "get_notifications_config",
                        lambda: {"enabled": True, "server": "http://127.0.0.1:9", "topic": "demo-topic"})

    def boom(*a, **k):
        calls.append(1)
        raise OSError("demo: connection refused")
    monkeypatch.setattr(notify.httpx, "Client", boom)
    assert notify.deliver("a", "b") == "failed" and notify.deliver("a", "b") == "failed"
    assert len(calls) == 1                                     # the second didn't wait for a time-out
    h = notify.health()
    assert "connection refused" in h["last_error"] and h["last_error_at"]


def test_notifications_off_is_not_a_failure(svc, monkeypatch, no_grace, quiet):
    monkeypatch.setattr(notify, "is_on", lambda: False)
    sid = svc(ip="10.27.0.22")
    _run(sid, "down")
    assert _row(sid)["monitor_alerted"] == 1 and _queue() == []


def test_digest_is_retried_without_composing_it_again(monkeypatch):
    sent = fake_ntfy(monkeypatch, ok=False)
    composed = []
    monkeypatch.setattr(changes, "compose_digest",
                        lambda: composed.append(1) or {"title": "Daily digest: demo", "body": "x", "summary": None, "model": None})
    cfg = {"enabled": True, "digest_enabled": True, "digest_time": "00:00", "last_digest": ""}
    monkeypatch.setattr(changes, "get_change_alerts_config", lambda: cfg)
    marked = []
    monkeypatch.setattr(changes, "_mark_digest_sent", lambda day: (marked.append(day), cfg.update(last_digest=day)))
    changes._pending_digest.clear()
    changes.maybe_send_digest()
    changes.maybe_send_digest()
    assert len(sent) == 2 and marked == [] and composed == [1]
    fake_ntfy(monkeypatch, sent, ok=True)
    changes.maybe_send_digest()
    assert len(sent) == 3 and len(marked) == 1 and composed == [1]
    changes.maybe_send_digest()                                # done for today
    assert len(sent) == 3


def test_health_endpoint(client, monkeypatch):
    monkeypatch.setattr(notify, "_health", {"last_ok": None, "last_error": "demo: refused",
                                            "last_error_at": "2026-11-20T12:00:00+00:00"})
    d = client.get("/api/monitor/health").json()
    assert d["notify"]["last_error"] == "demo: refused" and "push" in d and d["held_alerts"] == 0


def test_push_failure_is_remembered(monkeypatch):
    monkeypatch.setattr(monitor, "get_statuspage_config",
                        lambda: {"enabled": True, "url": "http://127.0.0.1:9", "token": "demo-status-token"})
    monkeypatch.setattr(monitor, "build_status_payload", lambda: {})
    ok, err = monitor.push_status()
    assert not ok and monitor.push_health()["last_error"] == err and err


def test_stale_minutes_setting(client):
    try:
        assert client.put("/api/settings/statuspage", json={"stale_minutes": 0}).status_code == 422
        assert client.put("/api/settings/statuspage", json={"stale_minutes": 1441}).status_code == 422
        r = client.put("/api/settings/statuspage", json={"stale_minutes": 12})
        assert r.status_code == 200 and r.json()["statuspage"]["stale_minutes"] == 12
        assert monitor.build_status_payload()["stale_after_minutes"] == 12
    finally:
        client.put("/api/settings/statuspage", json={"stale_minutes": 5})


# ── F-28: pauses ──────────────────────────────────────────────────────────────

def _uptime_from(evs, window_h=6):
    return monitor._compute_uptime([{"status": s, "ts": _iso(NOW - timedelta(hours=h))} for s, h in evs],
                                   None, window_h * 3600, NOW)


def test_paused_time_is_not_counted():
    # down 1 h, then maintenance 2 h, then up 1 h -> 50 %, not 25 %
    u = _uptime_from([("down", 4), ("maint", 3), ("up", 1)])
    assert u["pct"] == 50.0 and u["monitored_seconds"] == 7200
    assert _uptime_from([("up", 4), ("paused", 2)])["pct"] == 100.0


def test_pausing_ends_an_outage():
    evs = [{"status": "down", "ts": _iso(NOW - timedelta(hours=3))},
           {"status": "maint", "ts": _iso(NOW - timedelta(hours=2))}]
    out = monitor._compute_outages(evs, 86400, 10, NOW)
    assert out == [{"start": evs[0]["ts"], "end": evs[1]["ts"], "seconds": 3600}]


def test_bars_mark_paused_slots():
    evs = [{"status": "up", "ts": _iso(NOW - timedelta(hours=5))},
           {"status": "maint", "ts": _iso(NOW - timedelta(hours=3))},
           {"status": "paused", "ts": _iso(NOW - timedelta(hours=2))},
           {"status": "up", "ts": _iso(NOW - timedelta(hours=1))}]
    bars = monitor._bucket_history(evs, None, 4 * 3600, 4, NOW, monitor._hr_label)
    assert [b.get("pause") for b in bars] == [None, "maint", "paused", None]
    assert bars[1]["pct"] is None and bars[3]["pct"] == 100.0


def test_pause_with_reason_shows_maintenance(client, svc, monkeypatch):
    monkeypatch.setattr(monitor, "push_status", lambda: (True, ""))
    sid = svc(ip="10.27.0.30", name="Demo media")
    with get_conn() as conn:
        conn.execute("INSERT INTO monitor_events (service_id, status, ts) VALUES (?, 'up', ?)",
                     (sid, _iso(datetime.now(timezone.utc) - timedelta(hours=1))))
        conn.execute("UPDATE services SET public=1 WHERE id=?", (sid,))
        conn.commit()
    until = _iso(datetime.now(timezone.utc) + timedelta(hours=3))
    r = client.post(f"/api/services/{sid}/pause", json={"reason": "Demo: updating\tto v2", "until": until})
    assert r.status_code == 200, r.text
    assert r.json()["monitored"] == 0 and r.json()["monitor_pause_reason"] == "Demo: updating to v2"
    assert _events(sid)[-1] == "maint"
    item = next(s for s in monitor.build_status_payload()["services"] if s["key"] == f"svc-{sid}")
    assert item["status"] == "maintenance" and item["note"] == "Demo: updating to v2" and item["until"]
    # the same pause again adds no second mark; without a reason it turns into 'paused'
    client.post(f"/api/services/{sid}/pause", json={"reason": "Demo: updating to v2"})
    assert _events(sid).count("maint") == 1
    client.post(f"/api/services/{sid}/pause", json={})
    assert _events(sid)[-1] == "paused"
    item = next(s for s in monitor.build_status_payload()["services"] if s["key"] == f"svc-{sid}")
    assert item["status"] == "paused" and "note" not in item
    # back on: the pause fields are cleared
    client.post(f"/api/services/{sid}/monitor", json={"enabled": True})
    row = client.get("/api/services").json()
    s = next(x for x in row if x["id"] == sid)
    assert s["monitored"] == 1 and s["monitor_paused_at"] is None and s["monitor_pause_reason"] is None


def test_monitoring_off_leaves_the_status_page(client, svc, monkeypatch):
    monkeypatch.setattr(monitor, "push_status", lambda: (True, ""))
    monkeypatch.setattr(monitor, "check_now", lambda sid: {"status": "up"})
    sid = svc(ip="10.27.0.31")
    with get_conn() as conn:
        conn.execute("INSERT INTO monitor_events (service_id, status, ts) VALUES (?, 'up', ?)",
                     (sid, _iso(datetime.now(timezone.utc))))
        conn.execute("UPDATE services SET public=1 WHERE id=?", (sid,))
        conn.commit()
    client.post(f"/api/services/{sid}/monitor", json={"enabled": False})
    assert _events(sid)[-1] == "paused"                        # no data from now on
    assert not any(s["key"] == f"svc-{sid}" for s in monitor.build_status_payload()["services"])


@pytest.mark.parametrize("body, msg", [
    ({"until": "2020-01-01T00:00:00Z"}, "already passed"),
    ({"until": "2099-01-01T00:00:00Z"}, "30 days"),
    ({"reason": "x" * 201}, "200"),
])
def test_pause_input_is_checked(client, svc, body, msg):
    sid = svc(ip="10.27.0.32")
    r = client.post(f"/api/services/{sid}/pause", json=body)
    assert r.status_code == 422 and msg in r.text


def test_ai_pause_counts_as_a_pause(client, svc):
    from backend import ai_actions
    sid = svc(ip="10.27.0.33", name="Demo dns")
    with get_conn() as conn:
        ai_actions._run_pause(conn, {"service": "Demo dns", "host": "10.27.0.33"})
        conn.commit()
        assert conn.execute("SELECT monitor_paused_at FROM services WHERE id=?", (sid,)).fetchone()[0]


# ── F-29: what counts as up ───────────────────────────────────────────────────

@pytest.mark.parametrize("code, spec, up", [
    (200, None, True), (301, None, True), (401, None, True), (403, None, True), (404, None, True),
    (500, None, False), (502, None, False), (503, None, False),
    (404, "200-299", False), (204, "200-299", True), (404, "200,404", True), (502, " 502 ", True),
    (500, "garbage", False),                 # a bad saved value falls back to the default rule
])
def test_reply_ok(code, spec, up):
    assert monitor.reply_ok(code, spec) is up


@pytest.mark.parametrize("bad", ["abc", "99", "600", "300-200", "200-", "200,,404", "1" * 120])
def test_bad_accepted_replies_are_refused(client, svc, bad):
    sid = svc(ip="10.27.0.40")
    r = client.put(f"/api/services/{sid}", json={"accepted_codes": bad})
    assert r.status_code == 422, bad


def test_accepted_replies_saved_and_cleared(client, svc):
    sid = svc(ip="10.27.0.41")
    assert client.put(f"/api/services/{sid}", json={"accepted_codes": " 200 - 299, 404 "}).json()["accepted_codes"] == "200-299,404"
    assert client.put(f"/api/services/{sid}", json={"accepted_codes": ""}).json()["accepted_codes"] is None
    r = client.post("/api/hosts/10.27.0.41/services", json={"name": "Demo api", "accepted_codes": "200"})
    assert r.status_code == 201 and r.json()["accepted_codes"] == "200"


def test_502_behind_a_proxy_is_down(web):
    assert monitor._probe_http(web + "/502") is False
    assert monitor._probe_http(web + "/502", "502") is True
    assert monitor._probe_http(web + "/401") is True


def test_nothing_to_check_is_not_set_up_and_never_alerts(client, svc, monkeypatch, no_grace, quiet):
    sent = fake_ntfy(monkeypatch)
    sid = svc(ip="10.27.0.42", port=None, check_type="http")   # http check, no URL
    with get_conn() as conn:
        conn.execute("UPDATE services SET monitor_status='down', monitor_alerted=0 WHERE id=?", (sid,))
        conn.commit()
    assert monitor.probe(_row(sid)) == "unknown"
    _run(sid, "unknown")
    assert _row(sid)["monitor_status"] == "unknown" and sent == []
    s = next(x for x in client.get("/api/services").json() if x["id"] == sid)
    assert s["monitor_not_set_up"] is True


def test_hand_drawn_node_has_nothing_to_check():
    assert not monitor.has_target({"check_type": "icmp", "ip": "node-ab12"})


# ── F-30: results from before a change are dropped ────────────────────────────

def test_result_dropped_when_paused_during_the_check(svc, monkeypatch, no_grace, quiet):
    sent = fake_ntfy(monkeypatch)
    sid = svc(ip="10.27.0.50")
    before = _row(sid)                                         # the check starts ...
    with get_conn() as conn:                                   # ... the user pauses ...
        monitor.set_monitored(conn, sid, False, pause=True)
        conn.commit()
        monitor._process(conn, before, "down")                 # ... the result comes in
    assert sent == [] and "down" not in _events(sid)


def test_result_dropped_when_the_target_changed(svc, monkeypatch, no_grace, quiet):
    sent = fake_ntfy(monkeypatch)
    sid = svc(ip="10.27.0.51")
    before = _row(sid)
    with get_conn() as conn:
        conn.execute("UPDATE services SET port=8443 WHERE id=?", (sid,))
        conn.commit()
        monitor._process(conn, before, "down")
    assert sent == [] and _row(sid)["monitor_status"] == "up"


def test_two_passes_at_once_write_one_change(svc, monkeypatch, quiet):
    fake_ntfy(monkeypatch)
    sid = svc(ip="10.27.0.52")
    stale = _row(sid)                                          # both passes read 'up'
    with get_conn() as conn:
        monitor._process(conn, stale, "down")
        monitor._process(conn, stale, "down")
    assert _events(sid).count("down") == 1


def test_checks_keep_their_interval_when_a_round_is_slow(monkeypatch):
    """A 1 s round on a 2 s interval runs every ~2 s, not every 3+ s (round time
    counts, and a wait that ends a hair early doesn't skip a round)."""
    swept = []
    stop = threading.Event()
    monkeypatch.setattr(monitor, "_stop", stop)
    monkeypatch.setattr(monitor, "_thread", None)
    monkeypatch.setattr(monitor, "get_check_seconds", lambda: 2)
    monkeypatch.setattr(monitor, "_sweep", lambda: (swept.append(time.monotonic()), time.sleep(1)))
    for name in ("push_status", "flush_queue", "prune_events"):
        monkeypatch.setattr(monitor, name, lambda: None)
    monkeypatch.setattr(monitor, "resume_due", lambda: [])
    monkeypatch.setattr(changes, "maybe_send_digest", lambda: None)
    try:
        monitor.start_monitor()
        time.sleep(9.5)
    finally:
        stop.set()
        for t in monitor._threads:
            t.join(5)
    gaps = [b - a for a, b in zip(swept, swept[1:])]
    assert len(swept) >= 3 and all(g < 2.6 for g in gaps), gaps
