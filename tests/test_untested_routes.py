"""F-39: the API routes no test called before (coverage run 2026-11-23): host IP
rename and deletes, ports, uptime resets, service delete/public/uptime,
dependencies, VLANs, connections, layout, logout, profile delete, clearing
changes, scan status, Run now, maintenance list, SSH key list."""
import json

import pytest

from backend import auth, monitor, scanner
from backend.database import get_conn

NET = "10.39"


def _host(client, ip, **kw):
    r = client.post("/api/hosts", json={"ip": ip, **kw})
    assert r.status_code in (200, 201), r.text
    with get_conn() as conn:
        return conn.execute("SELECT id FROM hosts WHERE ip=?", (ip,)).fetchone()["id"]


def _svc(client, ip, name, **kw):
    r = client.post(f"/api/hosts/{ip}/services", json={"name": name, **kw})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


@pytest.fixture
def tidy():
    """Remove every demo row of this file afterwards."""
    yield
    with get_conn() as conn:
        conn.execute("DELETE FROM connections WHERE src_ip LIKE ? OR dst_ip LIKE ?", (f"{NET}.%", f"{NET}.%"))
        conn.execute("DELETE FROM change_events WHERE ip LIKE ?", (f"{NET}.%",))
        conn.execute("DELETE FROM services WHERE host_id IN (SELECT id FROM hosts WHERE ip LIKE ?)", (f"{NET}.%",))
        conn.execute("DELETE FROM hosts WHERE ip LIKE ?", (f"{NET}.%",))
        conn.execute("DELETE FROM vlans WHERE name LIKE 'demo-f39%'")
        conn.commit()


@pytest.fixture
def keep_db(client):
    """For routes that clear a whole table: put the shared test database back after."""
    before = client.get("/api/backup").content
    yield
    chk = client.post("/api/restore/check", files={"file": ("before.zip", before)})
    assert client.post(f"/api/restore/{chk.json()['token']}").status_code == 200


# ── Hosts ─────────────────────────────────────────────────────────────────────

def test_rename_ip_moves_everything_with_the_host(client, tidy):
    hid = _host(client, f"{NET}.0.1", hostname="demo-nas")
    client.post(f"/api/hosts/{NET}.0.1/ports", json={"port": 22, "service": "ssh"})
    _host(client, f"{NET}.0.9")
    client.post("/api/connections", json={"src_ip": f"{NET}.0.1", "dst_ip": f"{NET}.0.9"})
    with get_conn() as conn:
        conn.execute("INSERT INTO change_events (ip, type, ts) VALUES (?, 'host_new', '2026-01-01T00:00:00+00:00')",
                     (f"{NET}.0.1",))
        conn.execute("INSERT INTO host_aliases (host_id, ip) VALUES (?, ?)", (hid, f"{NET}.0.2"))
        conn.commit()

    assert client.post(f"/api/hosts/{NET}.0.1/rename", json={"new_ip": "not-an-ip"}).status_code == 422
    assert client.post(f"/api/hosts/{NET}.0.77/rename", json={"new_ip": f"{NET}.0.78"}).status_code == 404
    r = client.post(f"/api/hosts/{NET}.0.1/rename", json={"new_ip": f"{NET}.0.9"})
    assert r.status_code == 409 and "Merge" in r.text                 # never overwrites another host

    assert client.post(f"/api/hosts/{NET}.0.1/rename", json={"new_ip": f"{NET}.0.5"}).json() == {"ok": True, "ip": f"{NET}.0.5"}
    h = client.get(f"/api/hosts/{NET}.0.5").json()
    assert h["id"] == hid and h["hostname"] == "demo-nas" and [p["port"] for p in h["ports"]] == [22]
    with get_conn() as conn:
        assert conn.execute("SELECT src_ip FROM connections WHERE dst_ip=?", (f"{NET}.0.9",)).fetchone()[0] == f"{NET}.0.5"
        assert conn.execute("SELECT COUNT(*) FROM change_events WHERE ip=?", (f"{NET}.0.5",)).fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM change_events WHERE ip=?", (f"{NET}.0.1",)).fetchone()[0] == 0

    # its own alias can become the primary address: the alias goes away
    assert client.post(f"/api/hosts/{NET}.0.5/rename", json={"new_ip": f"{NET}.0.2"}).json()["ok"]
    with get_conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM host_aliases WHERE ip=?", (f"{NET}.0.2",)).fetchone()[0] == 0
        assert conn.execute("SELECT ip FROM hosts WHERE id=?", (hid,)).fetchone()[0] == f"{NET}.0.2"


def test_bulk_delete_removes_hosts_ports_and_links_only(client, tidy):
    ids = [_host(client, f"{NET}.1.{i}") for i in (1, 2, 3)]
    client.post(f"/api/hosts/{NET}.1.1/ports", json={"port": 80})
    client.post("/api/connections", json={"src_ip": f"{NET}.1.1", "dst_ip": f"{NET}.1.3"})
    assert client.request("DELETE", "/api/hosts", json={"ips": []}).json() == {"ok": True, "deleted": 0}
    assert client.request("DELETE", "/api/hosts", json={"ips": [f"{NET}.1.1", f"{NET}.1.2"]}).json()["deleted"] == 2
    left = {h["ip"] for h in client.get("/api/hosts").json() if h["ip"].startswith(f"{NET}.1.")}
    assert left == {f"{NET}.1.3"}
    with get_conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM ports WHERE host_id=?", (ids[0],)).fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM connections WHERE src_ip=?", (f"{NET}.1.1",)).fetchone()[0] == 0


def test_remove_alias_and_delete_port(client, tidy):
    hid = _host(client, f"{NET}.2.1")
    with get_conn() as conn:
        conn.execute("INSERT INTO host_aliases (host_id, ip) VALUES (?, ?)", (hid, f"{NET}.2.2"))
        conn.commit()
    assert client.delete(f"/api/hosts/{NET}.2.99/aliases/{NET}.2.2").status_code == 404
    assert client.delete(f"/api/hosts/{NET}.2.1/aliases/{NET}.2.2").json() == {"ok": True}
    assert client.get(f"/api/hosts/{NET}.2.1").json()["aliases"] == []

    pid = client.post(f"/api/hosts/{NET}.2.1/ports", json={"port": 443}).json()["id"]
    assert client.delete(f"/api/ports/{pid}").json() == {"ok": True}
    assert client.get(f"/api/hosts/{NET}.2.1").json()["ports"] == []


def test_host_uptime_reset_starts_from_now(client, tidy):
    hid = _host(client, f"{NET}.3.1")
    with get_conn() as conn:
        conn.execute("UPDATE hosts SET online=1 WHERE id=?", (hid,))
        conn.executemany("INSERT INTO host_events (host_id, status, ts) VALUES (?,?,?)",
                         [(hid, "up", "2026-01-01T00:00:00+00:00"), (hid, "down", "2026-01-02T00:00:00+00:00")])
        conn.commit()
    assert client.post(f"/api/hosts/{NET}.3.99/uptime/reset").status_code == 404
    assert client.post(f"/api/hosts/{NET}.3.1/uptime/reset").json() == {"ok": True}
    with get_conn() as conn:
        assert [r["status"] for r in conn.execute("SELECT status FROM host_events WHERE host_id=?", (hid,))] == ["up"]


# ── Services ──────────────────────────────────────────────────────────────────

def test_public_toggle_changes_only_the_public_fields(client, tidy, monkeypatch):
    monkeypatch.setattr(monitor, "push_status", lambda: None)
    _host(client, f"{NET}.4.1")
    sid = _svc(client, f"{NET}.4.1", "Demo Web", port=80, description="keep me")
    assert client.post("/api/services/99999/public", json={"enabled": True}).status_code == 404
    assert client.post(f"/api/services/{sid}/public", json={"enabled": True, "name": " Demo Public "}).json() == {
        "id": sid, "public": True}
    with get_conn() as conn:
        s = dict(conn.execute("SELECT * FROM services WHERE id=?", (sid,)).fetchone())
    assert s["public"] == 1 and s["public_name"] == "Demo Public" and s["description"] == "keep me" and s["port"] == 80
    client.post(f"/api/services/{sid}/public", json={"enabled": False})
    with get_conn() as conn:
        s = dict(conn.execute("SELECT public, public_name FROM services WHERE id=?", (sid,)).fetchone())
    assert s == {"public": 0, "public_name": "Demo Public"}          # the label is kept for next time


def test_service_uptime_read_and_reset(client, tidy):
    _host(client, f"{NET}.5.1")
    sid = _svc(client, f"{NET}.5.1", "Demo DNS", port=53)
    with get_conn() as conn:
        conn.execute("UPDATE services SET monitored=1, monitor_status='up' WHERE id=?", (sid,))
        conn.executemany("INSERT INTO monitor_events (service_id, status, ts) VALUES (?,?,?)",
                         [(sid, "up", "2026-01-01T00:00:00+00:00"), (sid, "down", "2026-01-01T01:00:00+00:00")])
        conn.commit()
    u = client.get(f"/api/services/{sid}/uptime").json()
    assert set(u["uptime"]) == {"24h", "7d", "30d"} and isinstance(u["outages"], list)
    assert client.post("/api/services/99999/uptime/reset").status_code == 404
    assert client.post(f"/api/services/{sid}/uptime/reset").json() == {"ok": True}
    with get_conn() as conn:
        assert [r["status"] for r in conn.execute("SELECT status FROM monitor_events WHERE service_id=?", (sid,))] == ["up"]


def test_uptime_reset_all_keeps_one_event_per_watched_item(client, keep_db, tidy):
    hid = _host(client, f"{NET}.6.1")
    sid = _svc(client, f"{NET}.6.1", "Demo SMB", port=445)
    with get_conn() as conn:
        conn.execute("UPDATE hosts SET online=0 WHERE id=?", (hid,))
        conn.execute("UPDATE services SET monitored=1, monitor_status='down' WHERE id=?", (sid,))
        conn.execute("INSERT INTO monitor_events (service_id, status, ts) VALUES (?, 'up', '2026-01-01T00:00:00+00:00')", (sid,))
        conn.execute("INSERT INTO host_events (host_id, status, ts) VALUES (?, 'up', '2026-01-01T00:00:00+00:00')", (hid,))
        conn.commit()
    assert client.post("/api/uptime/reset-all").json() == {"ok": True}
    with get_conn() as conn:
        assert [r[0] for r in conn.execute("SELECT status FROM monitor_events WHERE service_id=?", (sid,))] == ["down"]
        assert [r[0] for r in conn.execute("SELECT status FROM host_events WHERE host_id=?", (hid,))] == ["down"]


def test_delete_services_one_and_several(client, tidy):
    _host(client, f"{NET}.7.1")
    a, b, c = (_svc(client, f"{NET}.7.1", f"Demo {n}") for n in "ABC")
    assert client.delete(f"/api/services/{a}").json() == {"ok": True}
    assert client.request("DELETE", "/api/services", json={"ids": []}).json() == {"ok": True, "deleted": 0}
    assert client.request("DELETE", "/api/services", json={"ids": [b]}).json()["deleted"] == 1
    with get_conn() as conn:
        assert [r[0] for r in conn.execute("SELECT id FROM services WHERE id IN (?,?,?)", (a, b, c))] == [c]


def test_service_dependencies_add_list_delete(client, tidy):
    _host(client, f"{NET}.8.1")
    a, b = _svc(client, f"{NET}.8.1", "Demo App"), _svc(client, f"{NET}.8.1", "Demo DB")
    r = client.post("/api/service-dependencies", json={"from_service_id": a, "to_service_id": b})
    assert r.status_code == 201
    dep = r.json()
    assert (dep["from_service_id"], dep["to_service_id"]) == (a, b)
    assert client.post("/api/service-dependencies", json={"from_service_id": a, "to_service_id": b}).status_code == 409
    assert any(d["id"] == dep["id"] for d in client.get("/api/service-dependencies").json())
    assert client.delete(f"/api/service-dependencies/{dep['id']}").status_code == 204
    assert not any(d["id"] == dep["id"] for d in client.get("/api/service-dependencies").json())


# ── VLANs and connections ─────────────────────────────────────────────────────

def test_vlans_create_edit_delete(client, tidy):
    r = client.post("/api/vlans", json={"tag": 3901, "name": "demo-f39-iot", "color": "#112233"})
    assert r.status_code == 201
    v = r.json()
    assert client.post("/api/vlans", json={"tag": 3901, "name": "demo-f39-twin"}).status_code == 400   # tag taken
    client.post("/api/vlans", json={"tag": 3900, "name": "demo-f39-lan"})
    tags = [x["tag"] for x in client.get("/api/vlans").json() if x["name"].startswith("demo-f39")]
    assert tags == [3900, 3901]                                         # sorted by tag
    assert client.put("/api/vlans/999999", json={"name": "x"}).status_code == 404
    v2 = client.put(f"/api/vlans/{v['id']}", json={"name": "demo-f39-cams"}).json()
    assert (v2["tag"], v2["name"], v2["color"]) == (3901, "demo-f39-cams", "#112233")   # only the name changed
    assert client.delete(f"/api/vlans/{v['id']}").json() == {"ok": True}
    assert not any(x["id"] == v["id"] for x in client.get("/api/vlans").json())


def test_connections_create_edit_delete(client, tidy):
    _host(client, f"{NET}.9.1"), _host(client, f"{NET}.9.2")
    v1 = client.post("/api/vlans", json={"tag": 3910, "name": "demo-f39-a"}).json()["id"]
    v2 = client.post("/api/vlans", json={"tag": 3911, "name": "demo-f39-b"}).json()["id"]
    assert client.post("/api/connections", json={"src_ip": f"{NET}.9.1", "dst_ip": f"{NET}.9.1"}).status_code == 400
    r = client.post("/api/connections", json={"src_ip": f"{NET}.9.1", "dst_ip": f"{NET}.9.2", "type": "fiber",
                                              "label": "uplink", "vlan_ids": [v1]})
    assert r.status_code == 201
    c = r.json()
    assert c["type"] == "fiber" and [v["tag"] for v in c["vlans"]] == [3910]
    assert client.post("/api/connections", json={"src_ip": f"{NET}.9.1", "dst_ip": f"{NET}.9.2"}).status_code == 400

    c2 = client.put(f"/api/connections/{c['id']}", json={"label": "core link"}).json()
    assert (c2["label"], c2["type"], [v["tag"] for v in c2["vlans"]]) == ("core link", "fiber", [3910])   # rest kept
    c3 = client.put(f"/api/connections/{c['id']}", json={"set_vlans": True, "vlan_ids": [v2]}).json()
    assert [v["tag"] for v in c3["vlans"]] == [3911]
    assert client.put("/api/connections/999999", json={"label": "x"}).status_code == 404

    client.delete(f"/api/vlans/{v2}")                                   # a deleted VLAN leaves the link
    with get_conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM connection_vlans WHERE connection_id=?", (c["id"],)).fetchone()[0] == 0
    assert client.delete(f"/api/connections/{c['id']}").json() == {"ok": True}
    with get_conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM connections WHERE id=?", (c["id"],)).fetchone()[0] == 0


def test_layout_saves_positions(client, tidy):
    _host(client, f"{NET}.10.1")
    r = client.put("/api/layout", json={"positions": {f"{NET}.10.1": {"x": 12.5, "y": -40}, f"{NET}.10.99": {"x": 1, "y": 1}}})
    assert r.json() == {"ok": True, "saved": 2}
    with get_conn() as conn:
        assert tuple(conn.execute("SELECT pos_x, pos_y FROM hosts WHERE ip=?", (f"{NET}.10.1",)).fetchone()) == (12.5, -40)


def test_layout_refuses_bad_spots(client, tidy):
    """F-46: moves save on their own now, so a bad spot is refused, never stored."""
    _host(client, f"{NET}.10.1")
    for bad in ({"x": "left", "y": 1}, {"x": 1}, {"x": 1e400, "y": 1}, "here"):
        assert client.put("/api/layout", json={"positions": {f"{NET}.10.1": bad}}).status_code == 422, bad
    r = client.put("/api/layout", content='{"positions": {"%s.10.1": {"x": NaN, "y": 1}}}' % NET,
                   headers={"content-type": "application/json"})
    assert r.status_code == 422
    with get_conn() as conn:
        assert tuple(conn.execute("SELECT pos_x, pos_y FROM hosts WHERE ip=?", (f"{NET}.10.1",)).fetchone()) == (None, None)


# ── Login, scans, maintenance, SSH ────────────────────────────────────────────

def test_logout_clears_the_cookie(client):
    r = client.post("/api/auth/logout")
    assert r.json() == {"ok": True}
    cookie = r.headers.get("set-cookie", "")
    assert cookie.startswith(f"{auth.COOKIE}=") and ("Max-Age=0" in cookie or "expires=" in cookie.lower())


def test_scan_profile_delete(client):
    builtin = next(p for p in client.get("/api/scan-profiles").json() if p["builtin"])
    assert client.delete(f"/api/scan-profiles/{builtin['id']}").status_code == 400
    assert client.delete("/api/scan-profiles/999999").status_code == 404
    pid = client.post("/api/scan-profiles", json={"name": "Demo F-39", "options": {}}).json()["id"]
    assert client.delete(f"/api/scan-profiles/{pid}").json() == {"ok": True}
    assert not any(p["id"] == pid for p in client.get("/api/scan-profiles").json())


def test_clear_all_changes(client, keep_db):
    with get_conn() as conn:
        conn.execute("INSERT INTO change_events (ip, type, ts) VALUES (?, 'host_new', '2026-01-01T00:00:00+00:00')",
                     (f"{NET}.11.1",))
        conn.commit()
    assert client.delete("/api/change-events").json() == {"ok": True}
    assert client.get("/api/change-events").json() == []


def test_scan_status_live_saved_and_missing(client):
    scanner.scan_jobs[-39] = {"status": "running", "progress": 40, "total": 10, "_proc": object()}
    try:
        assert client.get("/api/scan/-39/status").json() == {"status": "running", "progress": 40, "total": 10}
    finally:
        scanner.scan_jobs.pop(-39, None)
    with get_conn() as conn:
        rid = conn.execute("INSERT INTO scan_runs (status, problems) VALUES ('queued', ?)",
                           (json.dumps([{"ip": f"{NET}.12.1"}]),)).lastrowid
        conn.commit()
    try:
        s = client.get(f"/api/scan/{rid}/status").json()
        assert s["status"] == "waiting" and s["problems"] == 1 and len(s["problem_list"]) == 1
    finally:
        with get_conn() as conn:
            conn.execute("DELETE FROM scan_runs WHERE id=?", (rid,))
            conn.commit()
    assert client.get("/api/scan/999999/status").status_code == 404


def test_run_now_scans_only_the_chosen_hosts(client, tidy, monkeypatch):
    queued = []
    monkeypatch.setattr(scanner, "queue_scan", lambda run_id, target, opts=None: queued.append(target) or True)
    sn = client.post("/api/subnets", json={"name": "Demo F-39", "cidr": f"{NET}.13.0/24",
                                           "dhcp_start": f"{NET}.13.100", "dhcp_end": f"{NET}.13.200"}).json()["id"]
    _host(client, f"{NET}.13.10"), _host(client, f"{NET}.13.150")      # static, dynamic
    sid = client.post("/api/scan-schedules", json={"name": "Demo F-39", "subnet_id": sn, "host_filter": "static",
                                                   "timing_type": "interval", "interval_hours": 24,
                                                   "enabled": False}).json()["id"]
    try:
        r = client.post(f"/api/scan-schedules/{sid}/run").json()
        assert len(r["started"]) == 1 and r["skipped"] == [] and queued == [f"{NET}.13.10"]
        row = next(s for s in client.get("/api/scan-schedules").json() if s["id"] == sid)
        assert not row.get("last_run")                                  # Run now doesn't move the schedule
        assert client.post("/api/scan-schedules/999999/run").status_code == 404
    finally:
        with get_conn() as conn:
            conn.execute("DELETE FROM scan_runs WHERE schedule_id=?", (sid,))
            conn.execute("DELETE FROM scan_schedules WHERE id=?", (sid,))
            conn.execute("DELETE FROM subnets WHERE id=?", (sn,))
            conn.commit()


def test_maintenance_list_and_ssh_key_list(client):
    assert isinstance(client.get("/api/maintenance-windows").json()["windows"], list)
    import base64, hashlib, struct
    blob = b"".join(struct.pack(">I", len(x)) + x for x in (b"ssh-ed25519", b"\x39" * 32))   # a well-formed demo key
    key = "ssh-ed25519 " + base64.b64encode(blob).decode() + " demo@f39"
    kid = client.post("/api/ssh-keys", json={"name": "demo-f39", "public_key": key}).json()["id"]
    try:
        row = next(k for k in client.get("/api/ssh-keys").json() if k["id"] == kid)
        assert set(row) == {"id", "name", "public_key", "fingerprint", "created_at"}   # public parts only
        assert row["fingerprint"] == "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")
    finally:
        client.delete(f"/api/ssh-keys/{kid}")
