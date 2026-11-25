"""S-33: deleting a subnet can also delete its devices — only the ones no other subnet covers."""
from backend.database import get_conn


def _sub(client, name, cidr):
    r = client.post("/api/subnets", json={"name": name, "cidr": cidr})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _host(client, ip):
    assert client.post("/api/hosts", json={"ip": ip}).status_code in (200, 201)


def test_only_devices_no_other_subnet_covers(client):
    wide = _sub(client, "demo wide", "10.47.0.0/16")
    lab = _sub(client, "demo lab", "10.47.1.0/24")
    v6 = _sub(client, "demo v6", "fd47::/64")
    try:
        for ip in ("10.47.1.5", "10.47.2.5", "10.48.0.5", "10.48.0.6", "fd47::5"):
            _host(client, ip)
        # a merged device: main address only in "wide", second address in "lab"
        with get_conn() as c:
            hid = c.execute("SELECT id FROM hosts WHERE ip='10.48.0.6'").fetchone()["id"]
            c.execute("UPDATE hosts SET ip='10.47.3.6' WHERE id=?", (hid,))
            c.execute("INSERT INTO host_aliases (host_id, ip) VALUES (?, '10.47.1.6')", (hid,))
            c.commit()
        own = lambda sid: sorted(client.get(f"/api/subnets/{sid}/own-hosts").json()["ips"])
        assert own(lab) == []                         # 10.47.1.5 is also inside "wide"
        assert own(wide) == ["10.47.2.5"]             # 10.47.1.5 stays with "lab"; the merged one has an address in "lab"
        assert own(v6) == ["fd47::5"]                 # IPv6 works; nothing IPv4 leaks in
        assert client.get("/api/subnets/999999/own-hosts").status_code == 404
    finally:
        for sid in (wide, lab, v6):
            client.delete(f"/api/subnets/{sid}")
        client.request("DELETE", "/api/hosts", json={"ips": ["10.47.1.5", "10.47.2.5", "10.48.0.5", "10.47.3.6", "fd47::5"]})


def test_deleting_the_subnet_alone_keeps_its_devices(client):
    sid = _sub(client, "demo solo", "10.49.0.0/24")
    _host(client, "10.49.0.7")
    try:
        assert client.get(f"/api/subnets/{sid}/own-hosts").json()["ips"] == ["10.49.0.7"]
        assert client.delete(f"/api/subnets/{sid}").status_code == 200
        assert any(h["ip"] == "10.49.0.7" for h in client.get("/api/hosts").json())
    finally:
        client.request("DELETE", "/api/hosts", json={"ips": ["10.49.0.7"]})
