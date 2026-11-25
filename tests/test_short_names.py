"""S-27: device names the network reports are shown short ("phone-1" for
"phone-1.lan.example.com") in the app, the map and alerts; Settings → General can turn
it off. The stored name never changes, and a name you set is shown as you typed it."""
from conftest import fake_ntfy

from backend import ai_actions, changes, host_fields
from backend.database import get_conn


def test_the_rule():
    d = host_fields.display_name
    assert d("phone-1.lan.example.com", 0, short=True) == "phone-1"
    assert d("nas.unknown.home.arpa", 0, short=True) == "nas"
    assert d("printer", 0, short=True) == "printer"
    assert d("Dad's Mac.old", 1, short=True) == "Dad's Mac.old"          # set by you: as typed
    assert d("10.61.0.5", 0, short=True) == "10.61.0.5"                  # an address stays whole
    assert d(".odd", 0, short=True) == ".odd" and d("", 0, short=True) == "" and d(None, 0, short=True) == ""
    assert d("phone-1.lan.example.com", 0, short=False) == "phone-1.lan.example.com"


def _setting(client, on):
    r = client.put("/api/settings/all", json={"general": {"short_names": on}})
    assert r.status_code == 200, r.text
    assert r.json()["general"]["short_names"] is on


def test_app_map_services_and_alerts_show_the_short_name(client, monkeypatch):
    ip, mine = "10.61.0.5", "10.61.0.6"
    for a, name in ((ip, "phone-1.lan.example.com"), (mine, "laptop.lan.example.com")):
        assert client.post("/api/hosts", json={"ip": a, "hostname": name}).status_code == 201
    with get_conn() as c:   # as a scan would leave it: the network's name, not set by you
        c.execute("UPDATE hosts SET hostname_set=0, net_hostname=hostname WHERE ip IN (?, ?)", (ip, mine))
        c.commit()
    client.put(f"/api/hosts/{mine}", json={"hostname": "Work.Laptop"})           # set by you
    svc = client.post(f"/api/hosts/{ip}/services", json={"name": "Demo web", "port": 80}).json()
    try:
        hosts = {h["ip"]: h for h in client.get("/api/hosts").json()}
        assert hosts[ip]["display_name"] == "phone-1" and hosts[ip]["hostname"] == "phone-1.lan.example.com"   # stored in full
        assert hosts[mine]["display_name"] == "Work.Laptop"
        assert client.get(f"/api/hosts/{ip}").json()["display_name"] == "phone-1"
        node = next(n["data"] for n in client.get("/api/graph").json()["nodes"] if n["data"]["id"] == ip)
        assert node["label"] == "phone-1" and node["net_hostname"] == "phone-1.lan.example.com"   # hover shows the full name
        assert svc["host_display_name"] == "phone-1"
        assert next(s for s in client.get("/api/services").json() if s["id"] == svc["id"])["host_display_name"] == "phone-1"
        # The alert uses it too
        sent = fake_ntfy(monkeypatch)
        monkeypatch.setattr(changes, "is_alert_worthy", lambda conn, e, subnets: True)
        with get_conn() as conn:
            changes.alert_transition(conn, ip, "host_offline")
        assert sent and "(phone-1)" in sent[-1]["title"] and "example.com" not in sent[-1]["title"], sent
        # The AI finds a device by the short name you see
        with get_conn() as conn:
            assert ai_actions._host(conn, "phone-1")["ip"] == ip
        # Full names: everything shows the stored name again
        _setting(client, False)
        assert {h["ip"]: h for h in client.get("/api/hosts").json()}[ip]["display_name"] == "phone-1.lan.example.com"
        with get_conn() as conn:
            changes.alert_transition(conn, ip, "host_online")
        assert "(phone-1.lan.example.com)" in sent[-1]["title"]
    finally:
        _setting(client, True)
        client.delete(f"/api/services/{svc['id']}")
        client.request("DELETE", "/api/hosts", json={"ips": [ip, mine]})


def test_on_by_default(client):
    assert client.get("/api/settings").json()["general"].get("short_names", True) is True
