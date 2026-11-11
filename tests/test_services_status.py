"""Service status accepts only what the app and monitor use: running / stopped / unknown."""
from backend.database import get_conn


def test_service_status_values(client):
    with get_conn() as conn:
        conn.execute("INSERT OR IGNORE INTO hosts (ip, hostname) VALUES ('10.66.0.5', 'svc-box')")
        conn.commit()
    r = client.post("/api/hosts/10.66.0.5/services", json={"name": "web", "port": 80, "status": "up"})
    assert r.status_code == 422
    r = client.post("/api/hosts/10.66.0.5/services", json={"name": "web", "port": 80})
    assert r.status_code == 201 and r.json()["status"] == "unknown"
    sid = r.json()["id"]
    assert client.put(f"/api/services/{sid}", json={"status": ""}).status_code == 422
    assert client.put(f"/api/services/{sid}", json={"status": "stopped"}).json()["status"] == "stopped"
    with get_conn() as conn:
        conn.execute("DELETE FROM hosts WHERE ip='10.66.0.5'")
        conn.commit()
