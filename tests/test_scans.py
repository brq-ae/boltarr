"""F-34 scans: nmap's errors are kept, one bad host doesn't stop the rest
("completed with problems"), a per-host time limit, one scan at a time
(scheduled ones wait), no deleting a running scan, probes run beside a scan,
-Pn really skips the ping sweep. F-24 ports per address. F-42 one 'new device'
event with its ports. All against a stand-in nmap (tests/fake_nmap.py)."""
import json
import os
import sys
import time
from pathlib import Path

import pytest

from backend import changes, scanner, scheduler
from backend.database import get_conn

FAKE = Path(__file__).with_name("fake_nmap.py")


class Nmap:
    def __init__(self, d: Path):
        self.d = d

    def up(self, *ips):
        (self.d / "up.json").write_text(json.dumps(list(ips)))

    def host(self, ip, **kw):
        (self.d / f"{ip}.json").write_text(json.dumps(kw))

    def discovery_fails(self, msg):
        (self.d / "discovery.json").write_text(json.dumps({"fail": msg}))

    def calls(self):
        """nmap runs, without python-nmap's version checks."""
        p = self.d / "calls.log"
        return [c for c in (json.loads(x) for x in p.read_text().splitlines()) if c != ["-V"]] if p.exists() else []


@pytest.fixture
def nmap(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    shim = bin_dir / "nmap"
    shim.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FAKE}" "$@"\n')
    shim.chmod(0o755)
    data = tmp_path / "nmap"
    data.mkdir()
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("FAKE_NMAP_DIR", str(data))
    yield Nmap(data)
    for rid in list(scanner.scan_jobs):          # never leave a job running for the next test
        scanner.cancel_scan(rid)
    _wait_idle()


def _wait_idle(timeout=20):
    t0 = time.monotonic()
    while scanner.anything_running() and time.monotonic() - t0 < timeout:
        time.sleep(0.05)
    assert not scanner.anything_running(), "a scan was still running"


def _wait(run_id, timeout=20, until=("completed", "error", "cancelled")):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        with get_conn() as conn:
            r = conn.execute("SELECT * FROM scan_runs WHERE id=?", (run_id,)).fetchone()
        if r and r["status"] in until:
            return dict(r)
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} still {r['status'] if r else 'missing'}")


_n = [0]


@pytest.fixture
def subnet(client):
    """A fresh /29 subnet per test (10.34.N.0/29)."""
    _n[0] += 1
    cidr = f"10.34.{_n[0]}.0/29"
    r = client.post("/api/subnets", json={"name": f"Demo scan {_n[0]}", "cidr": cidr})
    assert r.status_code == 201, r.text
    sid = r.json()["id"]
    base = f"10.34.{_n[0]}."
    return {"id": sid, "cidr": cidr, "ip": lambda last: base + str(last)}


def _scan(client, subnet, **opts):
    r = client.post(f"/api/scan/{subnet['id']}", json={"os": False, "sv": False, **opts})
    assert r.status_code == 200, r.text
    return r.json()["run_id"]


def _events(run_id):
    with get_conn() as conn:
        return [dict(r) for r in conn.execute("SELECT type, ip, port, new_value FROM change_events WHERE run_id=? "
                                              "ORDER BY id", (run_id,))]


def _open_ports(ip):
    with get_conn() as conn:
        return sorted(r["port"] for r in conn.execute(
            "SELECT p.port FROM ports p JOIN hosts h ON h.id=p.host_id WHERE h.ip=? AND p.state='open'", (ip,)))


# ── nmap's errors are kept ──────────────────────────────────────────────────────

def test_a_failed_ping_sweep_is_an_error_with_nmaps_words(client, nmap, subnet):
    nmap.discovery_fails("Failed to open device eth9")
    run = _wait(_scan(client, subnet))
    assert run["status"] == "error" and "nmap failed: Failed to open device eth9" in run["note"]
    assert run["completed_at"]


def test_one_failed_host_doesnt_stop_the_rest(client, nmap, subnet):
    a, b, c = subnet["ip"](1), subnet["ip"](2), subnet["ip"](3)
    nmap.up(a, b, c)
    nmap.host(a, ports=[22])
    nmap.host(b, fail="QUITTING! demo resource problem")
    nmap.host(c, ports=[80])
    run = _wait(_scan(client, subnet))
    assert run["status"] == "completed"
    assert run["note"] == "completed with problems — 1 of 3 hosts couldn't be scanned"
    probs = json.loads(run["problems"])
    assert probs == [{"ip": b, "error": "QUITTING! demo resource problem"}]
    assert _open_ports(a) == [22] and _open_ports(c) == [80]       # the hosts after it were still scanned
    listed = next(s for s in client.get("/api/scans").json() if s["id"] == run["id"])
    assert listed["problems"] == probs


def test_clean_scan_has_no_problems(client, nmap, subnet):
    a = subnet["ip"](1)
    nmap.up(a)
    nmap.host(a, ports=[22])
    run = _wait(_scan(client, subnet))
    assert run["status"] == "completed" and run["problems"] is None and run["note"] is None
    assert run["hosts_found"] == 1


# ── per-host time limit ─────────────────────────────────────────────────────────

def test_host_time_limit_is_15_minutes_by_default(client, nmap, subnet):
    a = subnet["ip"](1)
    nmap.up(a)
    nmap.host(a, ports=[22])
    _wait(_scan(client, subnet))
    detail = [c for c in nmap.calls() if "-sn" not in c][-1]
    assert detail[detail.index("--host-timeout") + 1] == "15m"
    assert "--host-timeout 15m" in client.post("/api/scan/preview", json={}).json()["command"]


def test_host_time_limit_can_be_changed_or_turned_off(client, nmap, subnet):
    a = subnet["ip"](1)
    nmap.up(a)
    nmap.host(a, ports=[22])
    _wait(_scan(client, subnet, host_timeout=40))
    assert "40m" in [c for c in nmap.calls() if "-sn" not in c][-1]
    _wait(_scan(client, subnet, host_timeout=0))
    assert "--host-timeout" not in [c for c in nmap.calls() if "-sn" not in c][-1]
    assert client.post(f"/api/scan/{subnet['id']}", json={"host_timeout": 1441}).status_code == 422
    assert client.post(f"/api/scan/{subnet['id']}", json={"host_timeout": -1}).status_code == 422


def test_a_saved_profile_keeps_the_time_limit(client):
    r = client.post("/api/scan-profiles", json={"name": "Demo slow hosts", "options": {"host_timeout": 60}})
    assert r.status_code == 201, r.text
    prof = next(p for p in client.get("/api/scan-profiles").json() if p["name"] == "Demo slow hosts")
    assert prof["options"]["host_timeout"] == 60


def test_a_host_that_times_out_keeps_its_ports(client, nmap, subnet):
    a, b = subnet["ip"](1), subnet["ip"](2)
    nmap.up(a, b)
    nmap.host(a, ports=[22, 443])
    nmap.host(b, ports=[80])
    _wait(_scan(client, subnet))
    nmap.host(a, timeout=True)
    run = _wait(_scan(client, subnet))
    assert run["status"] == "completed" and "1 of 2" in run["note"]
    assert "took longer than 15 min" in json.loads(run["problems"])[0]["error"]
    assert _open_ports(a) == [22, 443]                              # not "all closed"
    assert not [e for e in _events(run["id"]) if e["type"] == "port_closed"]


# ── one scan at a time ──────────────────────────────────────────────────────────

def test_a_second_manual_scan_is_refused_while_one_runs(client, nmap, subnet):
    a = subnet["ip"](1)
    nmap.up(a)
    nmap.host(a, ports=[22], sleep=1.5)
    first = _scan(client, subnet)
    r = client.post(f"/api/scan/{subnet['id']}", json={})
    assert r.status_code == 409 and "already running" in r.json()["detail"]
    with get_conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM scan_runs WHERE subnet_id=?", (subnet["id"],)).fetchone()[0] == 1
    _wait(first)
    _wait(_scan(client, subnet))                                    # free again afterwards


def test_a_scheduled_scan_waits_then_starts(client, nmap, subnet):
    a = subnet["ip"](1)
    nmap.up(a)
    nmap.host(a, ports=[22], sleep=1.2)
    with get_conn() as conn:
        conn.execute("INSERT INTO subnets (name, cidr) VALUES ('Demo other', ?)", (f"10.35.{_n[0]}.0/29",))
        other = conn.execute("SELECT id FROM subnets WHERE cidr=?", (f"10.35.{_n[0]}.0/29",)).fetchone()[0]
        conn.execute("INSERT INTO scan_schedules (name, subnet_id, timing_type, interval_hours) "
                     "VALUES ('Demo nightly', ?, 'interval', 24)", (other,))
        sched = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()
    first = _scan(client, subnet)
    res = scheduler.run_schedule(sched)
    assert res["started"] == [] and len(res["queued"]) == 1
    waiting = res["queued"][0]
    listed = {s["id"]: s for s in client.get("/api/scans").json()}
    assert listed[waiting]["status"] == "queued"
    assert client.post(f"/api/scan/{subnet['id']}", json={}).status_code == 409   # the line counts as busy
    assert _wait(first)["status"] == "completed"
    run = _wait(waiting)
    assert run["status"] == "completed" and run["started_at"] >= _wait(first)["completed_at"]


def test_a_waiting_scan_can_be_stopped_before_it_starts(client, nmap, subnet):
    a = subnet["ip"](1)
    nmap.up(a)
    nmap.host(a, ports=[22], sleep=1.0)
    with get_conn() as conn:
        conn.execute("INSERT INTO scan_runs (subnet_id, status) VALUES (?, 'queued')", (subnet["id"],))
        waiting = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()
    first = _scan(client, subnet)
    assert not scanner.queue_scan(waiting, subnet["cidr"], {})
    assert client.post(f"/api/scan/{waiting}/cancel").status_code == 204
    assert _wait(waiting)["status"] == "cancelled"
    _wait(first)
    time.sleep(0.3)
    assert waiting not in scanner.scan_jobs and not scanner.queued_runs()     # it never started
    assert _wait(waiting)["note"] == "stopped before it started"


def test_a_second_run_of_the_same_subnet_is_skipped(client, nmap, subnet):
    a = subnet["ip"](1)
    nmap.up(a)
    nmap.host(a, ports=[22], sleep=1.0)
    with get_conn() as conn:
        conn.execute("INSERT INTO scan_schedules (name, subnet_id, timing_type, interval_hours) "
                     "VALUES ('Demo same', ?, 'interval', 24)", (subnet["id"],))
        sched = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()
    first = _scan(client, subnet)
    res = scheduler.run_schedule(sched)
    assert res["skipped"] == [subnet["id"]] and not res["queued"]
    _wait(first)


def test_waiting_scans_are_cleared_after_a_restart(client, subnet):
    with get_conn() as conn:
        conn.execute("INSERT INTO scan_runs (subnet_id, status) VALUES (?, 'queued')", (subnet["id"],))
        rid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()
    scanner.reconcile_orphaned_runs()
    run = _wait(rid)
    assert run["status"] == "cancelled" and "restarted" in run["note"]


def test_restore_waits_for_a_queued_scan(client, monkeypatch):
    monkeypatch.setattr(scanner, "_queue", [(999998, "10.0.0.1", {})])
    assert scanner.anything_running()
    chk = client.post("/api/restore/check", files={"file": ("b.zip", client.get("/api/backup").content)}).json()
    assert client.post(f"/api/restore/{chk['token']}").status_code == 409


# ── no deleting a running scan ──────────────────────────────────────────────────

def test_a_running_scan_cant_be_deleted(client, nmap, subnet):
    a = subnet["ip"](1)
    nmap.up(a)
    nmap.host(a, ports=[22], sleep=1.0)
    rid = _scan(client, subnet)
    r = client.delete(f"/api/scans/{rid}")
    assert r.status_code == 409 and "stop it first" in r.json()["detail"]
    r = client.request("DELETE", "/api/scans", json={"ids": [rid]})
    assert r.json() == {"ok": True, "deleted": 0, "kept_running": 1}
    _wait(rid)
    assert client.delete(f"/api/scans/{rid}").status_code == 200


# ── Stop ────────────────────────────────────────────────────────────────────────

def test_stop_ends_nmap_at_once(client, nmap, subnet):
    a = subnet["ip"](1)
    nmap.up(a)
    nmap.host(a, ports=[22], sleep=30)
    rid = _scan(client, subnet)
    t0 = time.monotonic()
    while scanner.scan_jobs.get(rid, {}).get("status") != "scanning":
        assert time.monotonic() - t0 < 10, scanner.scan_jobs.get(rid)
        time.sleep(0.05)
    time.sleep(0.3)
    assert client.post(f"/api/scan/{rid}/cancel").status_code == 204
    assert _wait(rid, timeout=5)["status"] == "cancelled"
    assert time.monotonic() - t0 < 10


# ── probes run beside a scan ────────────────────────────────────────────────────

def test_a_probe_runs_beside_a_scan_but_not_twice(client, nmap, subnet):
    a, b = subnet["ip"](1), subnet["ip"](2)
    nmap.up(a)
    nmap.host(a, ports=[22], sleep=1.5)
    nmap.host(b, ports=[8080], sleep=0.8)
    with get_conn() as conn:
        conn.execute("INSERT INTO hosts (ip, hostname) VALUES (?, 'demo-probe')", (b,))
        conn.commit()
    scan = _scan(client, subnet)
    r = client.post(f"/api/hosts/{b}/probe", json={"os": False, "sv": False})
    assert r.status_code == 201, r.text
    probe = r.json()["run_id"]
    again = client.post(f"/api/hosts/{b}/probe", json={})
    assert again.status_code == 409 and "already being probed" in again.json()["detail"]
    assert scanner.scan_jobs[scan]["kind"] == "scan" and scanner.scan_jobs[probe]["kind"] == "probe"
    assert _wait(probe)["status"] == "completed" and _open_ports(b) == [8080]
    assert _wait(scan)["status"] == "completed"


def test_a_failed_probe_says_why(client, nmap, subnet):
    b = subnet["ip"](4)
    nmap.host(b, fail="Failed to resolve demo")
    with get_conn() as conn:
        conn.execute("INSERT INTO hosts (ip) VALUES (?)", (b,))
        conn.commit()
    run = _wait(client.post(f"/api/hosts/{b}/probe", json={}).json()["run_id"])
    assert run["status"] == "error" and run["note"] == "nmap failed: Failed to resolve demo"


def test_a_probe_of_a_host_thats_gone_changes_nothing(client, nmap, subnet):
    b = subnet["ip"](5)
    nmap.host(b, ports=[22])
    with get_conn() as conn:
        conn.execute("INSERT INTO hosts (ip) VALUES (?)", (b,))
        conn.commit()
    _wait(client.post(f"/api/hosts/{b}/probe", json={}).json()["run_id"])
    nmap.host(b)                                                   # no reply now
    run = _wait(client.post(f"/api/hosts/{b}/probe", json={}).json()["run_id"])
    assert run["status"] == "completed" and run["hosts_found"] == 0 and _open_ports(b) == [22]


# ── -Pn really skips the ping sweep ─────────────────────────────────────────────

def test_skip_host_discovery_scans_every_address(client, nmap, subnet):
    a, quiet = subnet["ip"](3), subnet["ip"](6)
    nmap.host(a, ports=[3389])                       # answers on a port, ignores ping
    with get_conn() as conn:
        conn.execute("INSERT INTO hosts (ip) VALUES (?)", (quiet,))
        hid = conn.execute("SELECT id FROM hosts WHERE ip=?", (quiet,)).fetchone()[0]
        conn.execute("INSERT INTO ports (host_id, port, state) VALUES (?, 22, 'open')", (hid,))
        conn.commit()
    run = _wait(_scan(client, subnet, pn=True))
    calls = nmap.calls()
    assert not any("-sn" in c for c in calls)                       # no ping sweep
    detail = [c[c.index("-oX") - 1] for c in calls if "-Pn" in c]
    assert sorted(detail) == sorted(subnet["ip"](i) for i in range(1, 7))   # .0 and .7 left out
    assert run["status"] == "completed" and run["hosts_found"] == 1
    with get_conn() as conn:
        known = {r["ip"] for r in conn.execute("SELECT ip FROM hosts WHERE ip LIKE ?", (subnet["ip"]("%"),))}
    assert known == {a, quiet}                                      # silent addresses aren't added
    assert _open_ports(a) == [3389] and _open_ports(quiet) == [22]  # no reply ≠ "all closed"
    assert [e["type"] for e in _events(run["id"])] == ["host_new"]


def test_skip_host_discovery_refuses_a_huge_range(nmap):
    with pytest.raises(scanner.NmapError, match="at most 4096"):
        scanner._list_targets(["10.0.0.0/19"], {"cancelled": False})


# ── F-42: a new device = one event with its ports ───────────────────────────────

def test_a_new_device_is_one_event_with_its_ports(client, nmap, subnet):
    a = subnet["ip"](1)
    nmap.up(a)
    nmap.host(a, ports=[22, 80, 443])
    run = _wait(_scan(client, subnet))
    evs = _events(run["id"])
    assert evs == [{"type": "host_new", "ip": a, "port": None, "new_value": "22,80,443"}]
    line = changes.summarize(evs)
    assert f"{a} (ports 22, 80, 443)" in line and "port opened" not in line
    nmap.host(a, ports=[22, 80, 443, 8080])                          # later changes are reported as before
    evs = _events(_wait(_scan(client, subnet))["id"])
    assert [(e["type"], e["port"]) for e in evs] == [("port_opened", 8080)]


# ── F-24: a host's two addresses keep their own ports ───────────────────────────

def _merged(client, subnet):
    a, b = subnet["ip"](1), subnet["ip"](2)
    with get_conn() as conn:
        conn.execute("INSERT INTO hosts (ip, hostname) VALUES (?, 'demo-two-nics')", (a,))
        hid = conn.execute("SELECT id FROM hosts WHERE ip=?", (a,)).fetchone()[0]
        conn.execute("INSERT INTO host_aliases (host_id, ip) VALUES (?, ?)", (hid, b))
        conn.commit()
    return a, b, hid


def test_two_addresses_dont_flip_each_others_ports(client, nmap, subnet):
    a, b, hid = _merged(client, subnet)
    nmap.up(a, b)
    nmap.host(a, ports=[22, 80])
    nmap.host(b, ports=[445, 3389])
    for _ in range(3):
        run = _wait(_scan(client, subnet))
    assert _events(run["id"]) == []                                 # third scan: nothing changed
    with get_conn() as conn:
        main = sorted(r["port"] for r in conn.execute("SELECT port FROM ports WHERE host_id=? AND state='open'", (hid,)))
        second = sorted(r["port"] for r in conn.execute(
            "SELECT ap.port FROM alias_ports ap JOIN host_aliases ha ON ha.id=ap.alias_id WHERE ha.ip=? "
            "AND ap.state='open'", (b,)))
    assert main == [22, 80] and second == [445, 3389]


def test_second_address_first_look_is_quiet_then_tracked(client, nmap, subnet):
    a, b, hid = _merged(client, subnet)
    nmap.up(a, b)
    nmap.host(a, ports=[22])
    nmap.host(b, ports=[445])
    first = _wait(_scan(client, subnet))
    assert not [e for e in _events(first["id"]) if e["ip"] == b]     # baseline, not "opened"
    nmap.host(b, ports=[445, 5900])
    evs = _events(_wait(_scan(client, subnet))["id"])
    assert [(e["type"], e["ip"], e["port"]) for e in evs] == [("port_opened", b, 5900)]
    nmap.host(b, ports=[5900])
    evs = _events(_wait(_scan(client, subnet))["id"])
    assert [(e["type"], e["ip"], e["port"]) for e in evs] == [("port_closed", b, 445)]
    assert _open_ports(a) == [22]                                    # the main address is untouched


def test_probe_of_a_second_address_saves_its_ports(client, nmap, subnet):
    a, b, hid = _merged(client, subnet)
    nmap.host(b, ports=[8443])
    run = _wait(client.post(f"/api/hosts/{b}/probe", json={}).json()["run_id"])
    assert run["status"] == "completed" and run["hosts_found"] == 1
    with get_conn() as conn:
        assert [r["port"] for r in conn.execute(
            "SELECT ap.port FROM alias_ports ap JOIN host_aliases ha ON ha.id=ap.alias_id WHERE ha.ip=?", (b,))] == [8443]
    assert _open_ports(a) == []


# ── F-42: custom port lists ─────────────────────────────────────────────────────

def test_custom_port_lists_understand_nmap_syntax():
    p = changes._parse_port_range
    assert p("22,80,8000-8002") == {22, 80, 8000, 8001, 8002}
    assert p("T:22,80,U:53,161") == {22, 80}                         # U: part is UDP
    assert p("-3") == {1, 2, 3} and max(p("65530-")) == 65535
    assert p("u:53,t:443") == {443}


# ── F-42: finished jobs are forgotten after an hour ─────────────────────────────

def test_old_finished_jobs_are_forgotten(monkeypatch):
    now = time.monotonic()
    monkeypatch.setitem(scanner.scan_jobs, 999990, {"status": "completed", "_done": now - 4000})
    monkeypatch.setitem(scanner.scan_jobs, 999991, {"status": "completed", "_done": now - 10})
    with scanner._lock:
        scanner._prune_jobs()
    assert 999990 not in scanner.scan_jobs and 999991 in scanner.scan_jobs


# ── F-42: scan history is kept 90 days (skipped runs 7) ─────────────────────────

def test_old_scan_history_is_pruned(client, subnet):
    def add(status, days_ago):
        with get_conn() as conn:
            conn.execute("INSERT INTO scan_runs (subnet_id, status, started_at, completed_at) VALUES "
                         "(?, ?, datetime('now', ?), datetime('now', ?))",
                         (subnet["id"], status, f"-{days_ago} days", f"-{days_ago} days"))
            conn.commit()
            return conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    keep = [add("completed", 89), add("error", 30), add("skipped", 6), add("running", 200), add("queued", 200)]
    gone = [add("completed", 91), add("cancelled", 120), add("skipped", 8)]
    with get_conn() as conn:                      # a change from a run that will be pruned
        conn.execute("INSERT INTO change_events (ts, ip, type, port, run_id) VALUES "
                     "(datetime('now'), '10.34.99.1', 'port_opened', 22, ?)", (gone[0],))
        conn.commit()
    scanner.prune_runs()
    with get_conn() as conn:
        left = {r[0] for r in conn.execute("SELECT id FROM scan_runs WHERE subnet_id=?", (subnet["id"],))}
    assert set(keep) <= left and not (set(gone) & left)
    evs = client.get("/api/change-events", params={"ip": "10.34.99.1"})
    assert evs.status_code == 200 and [e["port"] for e in evs.json()] == [22]   # still listed
    assert client.get("/api/scans").status_code == 200


# ── F-24: merging, and where a second address's ports show ──────────────────────

def test_merge_keeps_each_addresses_scanned_ports_apart(client, subnet):
    a, b = subnet["ip"](1), subnet["ip"](2)
    with get_conn() as conn:
        for ip, hn in ((a, "demo-main"), (b, "demo-second")):
            conn.execute("INSERT INTO hosts (ip, hostname) VALUES (?, ?)", (ip, hn))
        ha = conn.execute("SELECT id FROM hosts WHERE ip=?", (a,)).fetchone()[0]
        hb = conn.execute("SELECT id FROM hosts WHERE ip=?", (b,)).fetchone()[0]
        conn.execute("INSERT INTO ports (host_id, port, state, service) VALUES (?, 22, 'open', 'ssh')", (ha,))
        conn.execute("INSERT INTO ports (host_id, port, state, service) VALUES (?, 445, 'open', 'smb')", (hb,))
        conn.execute("INSERT INTO ports (host_id, port, state, service, manual) VALUES (?, 9000, 'open', 'demo', 1)", (hb,))
        conn.commit()
    assert client.post(f"/api/hosts/{a}/merge", json={"merge_ip": b}).status_code == 200
    h = client.get(f"/api/hosts/{a}").json()
    assert sorted(p["port"] for p in h["ports"]) == [22, 9000]                  # a hand-added port moves to the host
    assert [(p["addr"], p["port"]) for p in h["alias_ports"]] == [(b, 445)]     # scanned ones keep their address
    listed = next(x for x in client.get("/api/hosts").json() if x["ip"] == a)
    assert [(p["addr"], p["port"]) for p in listed["alias_ports"]] == [(b, 445)]


def test_chat_sees_both_addresses_ports(client, nmap, subnet):
    import backend.main as m
    a, b, hid = _merged(client, subnet)
    nmap.up(a, b)
    nmap.host(a, ports=[22])
    nmap.host(b, ports=[5432])
    _wait(_scan(client, subnet))
    ctx = m._chat_context([{"role": "user", "content": f"what runs on {a}?"}])
    assert f"open@{b}=5432/" in ctx                                             # on the host's line
    idx = ctx[ctx.index("5432/demo5432:"):].splitlines()[0]
    assert b in idx and a not in idx                                            # port index names the right address


def test_chat_mentions_a_new_devices_ports(client, nmap, subnet):
    import backend.main as m
    a = subnet["ip"](1)
    nmap.up(a)
    nmap.host(a, ports=[22, 8123])
    _wait(_scan(client, subnet))
    ctx = m._chat_context([{"role": "user", "content": "anything new?"}])
    assert f"new host  {a} with open ports 22,8123" in ctx


def test_slow_timing_doesnt_break_the_ping_sweep(client, nmap, subnet):
    """T0–T2 cap nmap at one probe at a time; adding --min-parallelism 10 made
    nmap refuse to run (found by the real-nmap end-to-end run)."""
    a = subnet["ip"](1)
    nmap.up(a)
    nmap.host(a, ports=[22])
    for timing in ("T2", "T4"):
        _wait(_scan(client, subnet, timing=timing))
        sweep = [c for c in nmap.calls() if "-sn" in c][-1]
        assert (f"-{timing}" in sweep) and (("--min-parallelism" in sweep) == (timing == "T4"))


# ── F-20: a name / vendor / OS you set stays; the network's is kept beside it ───

def _host(ip):
    with get_conn() as conn:
        return dict(conn.execute("SELECT * FROM hosts WHERE ip=?", (ip,)).fetchone())


def test_a_name_you_set_survives_scans(client, nmap, subnet):
    a = subnet["ip"](1)
    nmap.up(a)
    nmap.host(a, ports=[22], name="dns-box.lan", mac="02:00:00:00:00:01", vendor="DemoVendor", os="Demo Linux 5")
    _wait(_scan(client, subnet))
    h = _host(a)
    assert (h["hostname"], h["net_hostname"], h["vendor"], h["os_guess"]) == ("dns-box.lan", "dns-box.lan", "DemoVendor", "Demo Linux 5")
    assert client.put(f"/api/hosts/{a}", json={"hostname": "Living room TV", "vendor": "My vendor"}).status_code == 200
    nmap.host(a, ports=[22], name="dns-box.lan", mac="02:00:00:00:00:02", vendor="OtherVendor", os="Demo Linux 6")
    run = _wait(_scan(client, subnet))
    h = _host(a)
    assert h["hostname"] == "Living room TV" and h["vendor"] == "My vendor"         # yours stay
    assert h["net_hostname"] == "dns-box.lan" and h["net_vendor"] == "OtherVendor"  # the network's, beside them
    assert h["os_guess"] == "Demo Linux 6"                                         # not set by you: follows the scan
    assert h["mac"] == "02:00:00:00:00:02"                                         # the MAC always comes from the scan
    assert "hostname_changed" not in [e["type"] for e in _events(run["id"])]       # your rename isn't a "change"


def test_clearing_a_name_hands_it_back_to_the_network(client, nmap, subnet):
    a = subnet["ip"](1)
    nmap.up(a)
    nmap.host(a, ports=[22], name="dns-box.lan")
    _wait(_scan(client, subnet))
    client.put(f"/api/hosts/{a}", json={"hostname": "Mine"})
    client.put(f"/api/hosts/{a}", json={"hostname": ""})
    h = _host(a)
    assert h["hostname"] == "dns-box.lan" and h["hostname_set"] == 0
    nmap.host(a, ports=[22], name="renamed.lan")
    run = _wait(_scan(client, subnet))
    assert _host(a)["hostname"] == "renamed.lan"                                    # follows the network again
    evs = [(e["type"]) for e in _events(run["id"])]
    assert evs.count("hostname_changed") == 1                                       # a real network rename is still logged


def test_a_network_rename_is_logged_even_when_you_named_it(client, nmap, subnet):
    a = subnet["ip"](1)
    nmap.up(a)
    nmap.host(a, ports=[22], name="old.lan")
    _wait(_scan(client, subnet))
    client.put(f"/api/hosts/{a}", json={"hostname": "Mine"})
    nmap.host(a, ports=[22], name="new.lan")
    run = _wait(_scan(client, subnet))
    with get_conn() as conn:
        ev = conn.execute("SELECT old_value, new_value FROM change_events WHERE run_id=? AND type='hostname_changed'",
                          (run["id"],)).fetchone()
    assert tuple(ev) == ("old.lan", "new.lan") and _host(a)["hostname"] == "Mine"


def test_a_probe_keeps_your_name_too(client, nmap, subnet):
    a = subnet["ip"](1)
    with get_conn() as conn:
        conn.execute("INSERT INTO hosts (ip, hostname, hostname_set) VALUES (?, 'Mine', 1)", (a,))
        conn.commit()
    nmap.host(a, ports=[22], name="dns-box.lan")
    _wait(client.post(f"/api/hosts/{a}/probe", json={}).json()["run_id"])
    h = _host(a)
    assert h["hostname"] == "Mine" and h["net_hostname"] == "dns-box.lan"


def test_an_ai_card_name_sticks(client, nmap, subnet):
    a = subnet["ip"](1)
    nmap.up(a)
    nmap.host(a, ports=[22], name="dns-box.lan")
    _wait(_scan(client, subnet))
    r = client.post("/api/ai-actions/run", json={"action": {"do": "set_host", "host": a, "hostname": "Backup NAS"}}).json()
    assert r["ok"], r
    _wait(_scan(client, subnet))
    assert _host(a)["hostname"] == "Backup NAS"


def test_a_host_you_add_by_hand_keeps_what_you_typed(client, nmap, subnet):
    a = subnet["ip"](1)
    assert client.post("/api/hosts", json={"ip": a, "hostname": "Garage cam", "vendor": "Demo cams"}).status_code == 201
    nmap.up(a)
    nmap.host(a, ports=[554], name="ipcam-7731.lan", vendor="Generic", mac="02:00:00:00:00:09")
    _wait(_scan(client, subnet))
    h = _host(a)
    assert (h["hostname"], h["vendor"], h["net_hostname"]) == ("Garage cam", "Demo cams", "ipcam-7731.lan")


def test_hosts_list_and_map_carry_the_network_name(client, nmap, subnet):
    a = subnet["ip"](1)
    nmap.up(a)
    nmap.host(a, ports=[22], name="dns-box.lan")
    _wait(_scan(client, subnet))
    client.put(f"/api/hosts/{a}", json={"hostname": "Mine"})
    listed = next(h for h in client.get("/api/hosts").json() if h["ip"] == a)
    assert listed["net_hostname"] == "dns-box.lan"
    node = next(n for n in client.get("/api/graph").json()["nodes"] if n["data"]["ip"] == a)
    assert node["data"]["net_hostname"] == "dns-box.lan" and node["data"]["label"] == "Mine"
