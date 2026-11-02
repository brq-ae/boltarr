"""F-10: alias IPs are pinged on their own and keep their own last-seen."""
from backend import liveness
from backend.database import get_conn


def _setup(client, main, alias):
    client.post("/api/hosts", json={"ip": main})
    client.post("/api/hosts", json={"ip": alias})
    r = client.post(f"/api/hosts/{main}/merge", json={"merge_ip": alias})
    assert r.status_code == 200, r.text


def _alias(ip):
    with get_conn() as c:
        return dict(c.execute("SELECT online, miss_count, last_seen FROM host_aliases WHERE ip=?", (ip,)).fetchone())


def _sweep(monkeypatch, live):
    monkeypatch.setattr(liveness, "get_liveness_config", lambda: {"enabled": True, "offline_after": 2})
    monkeypatch.setattr(liveness, "_sweep_live_ips", lambda: set(live))
    liveness.sweep_once()


def test_alias_answering_gets_its_own_last_seen(client, monkeypatch):
    _setup(client, "10.4.0.1", "10.4.0.2")
    _sweep(monkeypatch, {"10.4.0.1", "10.4.0.2"})
    a = _alias("10.4.0.2")
    assert a["online"] == 1 and a["last_seen"]


def test_alias_goes_offline_while_host_stays_up(client, monkeypatch):
    _setup(client, "10.4.0.3", "10.4.0.4")
    _sweep(monkeypatch, {"10.4.0.3", "10.4.0.4"})
    seen = _alias("10.4.0.4")["last_seen"]
    _sweep(monkeypatch, {"10.4.0.3"})
    assert _alias("10.4.0.4")["online"] == 1          # one miss: not yet offline
    _sweep(monkeypatch, {"10.4.0.3"})
    a = _alias("10.4.0.4")
    assert a["online"] == 0 and a["last_seen"] == seen  # offline, last-seen frozen
    host = next(h for h in client.get("/api/hosts").json() if h["ip"] == "10.4.0.3")
    assert host["online"] == 1                          # main IP unaffected
    assert host["alias_info"] == [{"ip": "10.4.0.4", "online": 0, "last_seen": seen}]
    assert host["aliases"] == ["10.4.0.4"]              # old shape still there


def _events(ip):
    with get_conn() as c:
        return [r["type"] for r in c.execute("SELECT type FROM change_events WHERE ip=? ORDER BY id", (ip,))]


def _alerts_setup(client, monkeypatch, main, alias, cidr):
    # a DHCP range makes both IPs 'static', which the default alert scope covers
    client.post("/api/subnets", json={"name": "s", "cidr": cidr,
                                      "dhcp_start": cidr.rsplit(".", 1)[0] + ".200",
                                      "dhcp_end": cidr.rsplit(".", 1)[0] + ".250"})
    _setup(client, main, alias)
    client.put(f"/api/hosts/{main}", json={"hostname": "nas"})
    sent = []
    from backend import changes
    monkeypatch.setattr(changes.notify, "send", lambda **kw: sent.append(kw))
    return sent


def test_alias_offline_and_back_is_logged_and_alerted(client, monkeypatch):
    sent = _alerts_setup(client, monkeypatch, "10.4.3.1", "10.4.3.2", "10.4.3.0/24")
    _sweep(monkeypatch, {"10.4.3.1", "10.4.3.2"})       # first sighting: no event
    assert _events("10.4.3.2") == [] and sent == []
    _sweep(monkeypatch, {"10.4.3.1"}); _sweep(monkeypatch, {"10.4.3.1"})
    _sweep(monkeypatch, {"10.4.3.1", "10.4.3.2"})
    assert _events("10.4.3.2") == ["host_offline", "host_online"]
    assert [m["title"] for m in sent if "10.4.3.2" in m["title"]] == ["10.4.3.2 (alias of nas) went offline",
                                          "10.4.3.2 (alias of nas) back online"]
    # the host's own Changes list includes its alias's events
    host_feed = client.get("/api/change-events", params={"ip": "10.4.3.1"}).json()
    assert {e["ip"] for e in host_feed} == {"10.4.3.2"}


def test_include_aliases_off_logs_but_does_not_alert(client, monkeypatch):
    sent = _alerts_setup(client, monkeypatch, "10.4.4.1", "10.4.4.2", "10.4.4.0/24")
    client.put("/api/settings/change-alerts", json={"include_aliases": False})
    try:
        _sweep(monkeypatch, {"10.4.4.1", "10.4.4.2"})
        _sweep(monkeypatch, {"10.4.4.1"}); _sweep(monkeypatch, {"10.4.4.1"})
        assert _events("10.4.4.2") == ["host_offline"]   # still in the Changes feed
        assert not [m for m in sent if "10.4.4.2" in m["title"]]   # but no ntfy alert
    finally:
        client.put("/api/settings/change-alerts", json={"include_aliases": True})


def test_host_no_offline_alert_also_silences_its_aliases(client, monkeypatch):
    sent = _alerts_setup(client, monkeypatch, "10.4.5.1", "10.4.5.2", "10.4.5.0/24")
    with get_conn() as c:
        c.execute("UPDATE hosts SET no_offline_alert=1 WHERE ip='10.4.5.1'"); c.commit()
    _sweep(monkeypatch, {"10.4.5.1", "10.4.5.2"})
    _sweep(monkeypatch, {"10.4.5.1"}); _sweep(monkeypatch, {"10.4.5.1"})
    assert _events("10.4.5.2") == ["host_offline"]
    assert not [m for m in sent if "10.4.5.2" in m["title"]]


def test_ip_history_uses_alias_own_times(client, monkeypatch):
    _setup(client, "10.4.1.1", "10.4.1.2")
    sid = client.post("/api/subnets", json={"name": "t", "cidr": "10.4.1.0/29"}).json()["id"]
    with get_conn() as c:   # alias last answered 45 days ago; host is up today
        c.execute("UPDATE hosts SET online=1, last_seen=datetime('now') WHERE ip='10.4.1.1'")
        c.execute("UPDATE host_aliases SET online=0, last_seen=datetime('now','-45 days') WHERE ip='10.4.1.2'")
        c.commit()
    rows = {r["ip"]: r for r in client.get(f"/api/subnets/{sid}/ip-history").json()["ips"]}
    assert rows["10.4.1.1"]["status"] == "in_use"
    assert rows["10.4.1.2"]["alias_of"] == "10.4.1.1"
    assert rows["10.4.1.2"]["status"] == "stale" and rows["10.4.1.2"]["days"] == 45


def test_merge_keeps_victim_liveness(client):
    client.post("/api/hosts", json={"ip": "10.4.2.1"})
    client.post("/api/hosts", json={"ip": "10.4.2.2"})
    with get_conn() as c:
        c.execute("UPDATE hosts SET online=1, last_seen='2026-10-01 10:00:00' WHERE ip='10.4.2.2'"); c.commit()
    client.post("/api/hosts/10.4.2.1/merge", json={"merge_ip": "10.4.2.2"})
    a = _alias("10.4.2.2")
    assert a["online"] == 1 and a["last_seen"] == "2026-10-01 10:00:00"
