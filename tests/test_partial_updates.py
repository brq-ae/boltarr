"""F-04: updating one field must never blank the others."""


def _host(client, ip, **fields):
    r = client.post("/api/hosts", json={"ip": ip, **fields})
    assert r.status_code in (200, 201), r.text
    return r.json()


def _get_host(client, ip):
    return next(h for h in client.get("/api/hosts").json() if h["ip"] == ip)


def test_host_field_edit_keeps_notes(client):
    _host(client, "10.1.0.1", hostname="nas", vendor="Synology", notes="rack 2")
    client.put("/api/hosts/10.1.0.1", json={"hostname": "nas-01"})
    h = _get_host(client, "10.1.0.1")
    assert h["hostname"] == "nas-01"
    assert h["notes"] == "rack 2"          # used to be wiped
    assert h["vendor"] == "Synology"


def test_host_notes_can_still_be_cleared(client):
    _host(client, "10.1.0.2", notes="temp")
    client.put("/api/hosts/10.1.0.2", json={"notes": None})
    assert _get_host(client, "10.1.0.2")["notes"] is None


def test_host_type_edit_keeps_everything_else(client):
    _host(client, "10.1.0.3", hostname="cam", notes="garage", os_guess="Linux")
    client.put("/api/hosts/10.1.0.3", json={"device_type": "camera", "set_static_override": True,
                                            "static_override": "static"})
    h = _get_host(client, "10.1.0.3")
    assert (h["device_type"], h["notes"], h["os_guess"], h["hostname"]) == ("camera", "garage", "Linux", "cam")
    assert h["static_override"] == "static"


def test_host_flags_only_change_when_sent(client):
    _host(client, "10.1.0.4")
    client.put("/api/hosts/10.1.0.4", json={"has_wifi": True})
    client.put("/api/hosts/10.1.0.4", json={"hostname": "ap"})
    assert _get_host(client, "10.1.0.4")["has_wifi"] == 1


def _svc(client, ip, **fields):
    r = client.post(f"/api/hosts/{ip}/services", json=fields)
    assert r.status_code == 201, r.text
    return r.json()


def test_service_status_cycle_keeps_description_port_url(client):
    _host(client, "10.1.0.10")
    s = _svc(client, "10.1.0.10", name="Plex", description="media", port=32400, url="http://plex.lan")
    r = client.put(f"/api/services/{s['id']}", json={"status": "running"})
    out = r.json()
    assert out["status"] == "running"
    assert (out["description"], out["port"], out["url"]) == ("media", 32400, "http://plex.lan")


def test_service_single_field_and_clearing(client):
    _host(client, "10.1.0.11")
    s = _svc(client, "10.1.0.11", name="Web", description="d", port=80, url="http://x")
    out = client.put(f"/api/services/{s['id']}", json={"url": None}).json()
    assert out["url"] is None and out["port"] == 80 and out["description"] == "d"
    out = client.put(f"/api/services/{s['id']}", json={"name": None}).json()
    assert out["name"] == "Web"            # required field: null is ignored, never stored


def test_service_container_ip_override_clear(client):
    _host(client, "10.1.0.12")
    s = _svc(client, "10.1.0.12", name="App", container_ip="10.1.0.99")
    out = client.put(f"/api/services/{s['id']}", json={"port": 8080}).json()
    assert out["container_ip"] == "10.1.0.99"
    out = client.put(f"/api/services/{s['id']}", json={"container_ip": ""}).json()
    assert out["container_ip"] is None


def test_service_move_host(client):
    _host(client, "10.1.0.13"); _host(client, "10.1.0.14")
    s = _svc(client, "10.1.0.13", name="DB", description="pg")
    out = client.put(f"/api/services/{s['id']}", json={"host_ip": "10.1.0.14"}).json()
    assert out["ip"] == "10.1.0.14" and out["description"] == "pg"
