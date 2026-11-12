"""v0.24.0 Subnets page: summary per subnet and the map-hidden flag."""


def _sub(client, name, cidr, **kw):
    r = client.post("/api/subnets", json={"name": name, "cidr": cidr, **kw})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_summary_counts_hosts_pool_and_schedules(client):
    sid = _sub(client, "lab", "10.20.0.0/24", dhcp_start="10.20.0.100", dhcp_end="10.20.0.103")
    other = _sub(client, "other", "10.30.0.0/24")
    for ip in ("10.20.0.5", "10.20.0.100", "10.20.0.101", "10.30.0.9"):
        assert client.post("/api/hosts", json={"ip": ip}).status_code in (200, 201)
    client.post("/api/scan-schedules", json={"name": "Nightly", "subnet_id": sid, "interval_hours": 24})
    rows = {r["id"]: r for r in client.get("/api/subnets/summary").json()}
    assert rows[sid]["hosts"] == 3 and rows[other]["hosts"] == 1
    assert rows[sid]["pool"]["size"] == 4 and rows[other]["pool"] is None
    assert rows[sid]["schedules"] == 1 and rows[other]["schedules"] == 0
    assert rows[sid]["last_scan"] is None and rows[sid]["running_run_id"] is None


def test_map_hidden_saved_and_left_alone_by_other_edits(client):
    sid = _sub(client, "lab", "10.21.0.0/24")
    assert client.get("/api/subnets").json()[-1]["map_hidden"] == 0
    assert client.put(f"/api/subnets/{sid}", json={"map_hidden": True}).json()["map_hidden"] == 1
    assert client.put(f"/api/subnets/{sid}", json={"name": "lab 2"}).json()["map_hidden"] == 1   # unchanged
    assert client.put(f"/api/subnets/{sid}", json={"map_hidden": False}).json()["map_hidden"] == 0
