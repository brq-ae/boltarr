"""v0.28.0 (R-22) — planned maintenance: plan ahead, Boltarr pauses the covered
services itself while it runs, a covered device's offline alert is held, and the
status page is told (public items only)."""
from datetime import datetime, timedelta, timezone

import pytest

from backend import changes, main, planned
from backend.database import get_conn


def _local(dt):
    """A time as the Settings timezone shows it (what the browser form sends)."""
    return main._utc_to_local(dt.isoformat(timespec="seconds"))


def _now():
    return datetime.now(timezone.utc).replace(second=0, microsecond=0)


@pytest.fixture
def lab(client):
    """A demo device with two monitored services, and one more service elsewhere."""
    ips = ["10.28.0.10", "10.28.0.11"]
    for ip in ips:
        client.post("/api/hosts", json={"ip": ip, "hostname": "demo-" + ip.rsplit(".", 1)[1]})
    sids = [client.post(f"/api/hosts/{ips[0]}/services", json={"name": n, "port": p}).json()["id"]
            for n, p in (("Demo web", 80), ("Demo files", 445))]
    other = client.post(f"/api/hosts/{ips[1]}/services", json={"name": "Demo other", "port": 22}).json()["id"]
    with get_conn() as conn:
        conn.execute("UPDATE services SET monitored=1, monitor_status='up' WHERE id IN (?,?,?)", (*sids, other))
        conn.execute("UPDATE hosts SET online=1, offline_alerted=0 WHERE ip IN (?,?)", ips)
        hid = conn.execute("SELECT id FROM hosts WHERE ip=?", (ips[0],)).fetchone()[0]
        conn.commit()
    yield {"ip": ips[0], "host_id": hid, "services": sids, "other": other}
    with get_conn() as conn:
        conn.execute("DELETE FROM maintenance_windows")
        for ip in ips:
            conn.execute("DELETE FROM hosts WHERE ip=?", (ip,))
        conn.commit()


def _svc(sid):
    with get_conn() as conn:
        return dict(conn.execute("SELECT * FROM services WHERE id=?", (sid,)).fetchone())


def _plan(client, start, end, **kw):
    body = {"title": "Demo: firmware upgrade", "note": "Back by 03:00", "starts": _local(start),
            "ends": _local(end), "service_ids": [], "host_ids": [], **kw}
    return client.post("/api/maintenance-windows", json=body)


def test_planned_window_changes_nothing_until_it_starts(client, lab):
    r = _plan(client, _now() + timedelta(hours=2), _now() + timedelta(hours=3), host_ids=[lab["host_id"]])
    assert r.status_code == 201, r.text
    w = r.json()["windows"][0]
    assert w["state"] == "planned" and w["covered_count"] == 2 and w["host_names"] == ["demo-10"]
    assert all(_svc(s)["monitored"] == 1 for s in lab["services"])


def test_window_pauses_the_device_services_and_holds_its_alerts(client, lab):
    end = _now() + timedelta(hours=1)
    wid = _plan(client, _now() - timedelta(minutes=1), end, host_ids=[lab["host_id"]]).json()["id"]
    for sid in lab["services"]:
        s = _svc(sid)
        assert (s["monitored"], s["monitor_pause_reason"], s["maint_window_id"]) == (0, "Demo: firmware upgrade", wid)
        assert s["monitor_resume_at"] == end.isoformat(timespec="seconds")
    assert _svc(lab["other"])["monitored"] == 1                 # not covered: untouched
    with get_conn() as conn:
        assert planned.host_in_window(conn, lab["ip"])
        assert not changes.is_alert_worthy(conn, {"type": "host_offline", "ip": lab["ip"]}, [])


def test_longer_end_moves_the_resume_time(client, lab):
    wid = _plan(client, _now() - timedelta(minutes=1), _now() + timedelta(hours=1),
                service_ids=[lab["services"][0]]).json()["id"]
    later = _now() + timedelta(hours=3)
    r = client.put(f"/api/maintenance-windows/{wid}", json={
        "title": "Demo: longer", "starts": _local(_now()), "ends": _local(later), "service_ids": [], "host_ids": []})
    assert r.status_code == 200, r.text
    s = _svc(lab["services"][0])
    assert s["monitor_resume_at"] == later.isoformat(timespec="seconds")
    assert s["monitor_pause_reason"] == "Demo: longer"
    w = planned.list_windows()[0]
    assert w["service_ids"] == [lab["services"][0]]               # what it covers can't change once running


def test_done_resumes_and_sends_the_held_offline_alert(client, lab, monkeypatch):
    sent = []
    monkeypatch.setattr(changes, "alert_transition", lambda conn, ip, ev: (sent.append((ip, ev)), "sent")[1])
    wid = _plan(client, _now() - timedelta(minutes=1), _now() + timedelta(hours=1),
                host_ids=[lab["host_id"]]).json()["id"]
    with get_conn() as conn:                                     # the device went down during the work
        conn.execute("UPDATE hosts SET online=0, offline_alerted=0 WHERE ip=?", (lab["ip"],))
        conn.commit()
    r = client.post(f"/api/maintenance-windows/{wid}/done")
    assert r.status_code == 200 and r.json()["windows"][0]["state"] == "done"
    assert all(_svc(s)["monitored"] == 1 and _svc(s)["maint_window_id"] is None for s in lab["services"])
    assert sent == [(lab["ip"], "host_offline")]                 # still down after: a normal alert


def test_window_ends_on_time_by_itself(client, lab, monkeypatch):
    wid = _plan(client, _now() - timedelta(minutes=1), _now() + timedelta(minutes=30),
                service_ids=lab["services"]).json()["id"]
    monkeypatch.setattr(planned, "_now", lambda: datetime.now(timezone.utc) + timedelta(hours=1))
    assert planned.tick()
    with get_conn() as conn:
        assert planned.get(conn, wid)["state"] == "done"
    assert all(_svc(s)["monitored"] == 1 for s in lab["services"])


def test_a_change_by_hand_wins_over_the_window(client, lab):
    wid = _plan(client, _now() - timedelta(minutes=1), _now() + timedelta(hours=1),
                service_ids=lab["services"]).json()["id"]
    sid = lab["services"][0]
    client.post(f"/api/services/{sid}/pause", json={"reason": "Demo: mine"})   # paused by hand, no end
    client.post(f"/api/maintenance-windows/{wid}/done")
    assert _svc(sid)["monitored"] == 0 and _svc(sid)["monitor_pause_reason"] == "Demo: mine"
    assert _svc(lab["services"][1])["monitored"] == 1


def test_delete_of_a_running_window_ends_it(client, lab):
    wid = _plan(client, _now() - timedelta(minutes=1), _now() + timedelta(hours=1),
                service_ids=lab["services"]).json()["id"]
    assert client.delete(f"/api/maintenance-windows/{wid}").json()["windows"] == []
    assert all(_svc(s)["monitored"] == 1 for s in lab["services"])


@pytest.mark.parametrize("change, message", [
    ({"title": " "}, "title"),
    ({"service_ids": []}, "at least one"),
    ({"ends_delta": -2}, "after the start"),
    ({"starts_delta": -5, "ends_delta": -3}, "past"),
    ({"service_ids": [987654]}, "no longer exists"),
])
def test_bad_windows_are_refused(client, lab, change, message):
    start = _now() + timedelta(hours=change.pop("starts_delta", 1))
    end = _now() + timedelta(hours=change.pop("ends_delta", 2))
    body = {"title": "Demo", "starts": _local(start), "ends": _local(end),
            "service_ids": [lab["services"][0]], "host_ids": [], **change}
    r = client.post("/api/maintenance-windows", json=body)
    assert r.status_code == 400 and message in r.json()["detail"]


def test_status_page_gets_only_public_items(client, lab):
    _plan(client, _now() + timedelta(hours=1), _now() + timedelta(hours=2), service_ids=[lab["other"]])
    assert planned.status_payload() == []                        # nothing public: not sent
    with get_conn() as conn:
        conn.execute("UPDATE services SET public=1 WHERE id=?", (lab["other"],))
        conn.commit()
    [w] = planned.status_payload()
    assert w["affects"] == [f"svc-{lab['other']}"] and w["title"] == "Demo: firmware upgrade"
    assert w["note"] == "Back by 03:00" and "10.28." not in str(w)      # no addresses leave the LAN
