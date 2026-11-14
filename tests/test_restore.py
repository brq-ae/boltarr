"""F-09: restore is checked first, applied in place (no restart), announced,
and refused while a scan runs."""
import io
import threading
import time
import zipfile

from backend import config, maintenance
from backend.database import get_conn


def _hosts(client):
    return {h["ip"] for h in client.get("/api/hosts").json()}


def _backup(client) -> bytes:
    r = client.get("/api/backup")
    assert r.status_code == 200
    return r.content


def test_backup_has_manifest(client):
    zf = zipfile.ZipFile(io.BytesIO(_backup(client)))
    assert {"boltarr.db", "manifest.json"} <= set(zf.namelist())


def test_check_changes_nothing_then_apply_restores_in_place(client, monkeypatch):
    client.post("/api/hosts", json={"ip": "10.6.0.1", "hostname": "keep"})
    snap = _backup(client)
    client.post("/api/hosts", json={"ip": "10.6.0.2", "hostname": "added-after"})
    client.put("/api/settings/ip-history", json={"stale_days": 33, "gone_days": 66})

    r = client.post("/api/restore/check", files={"file": ("b.zip", snap, "application/zip")})
    assert r.status_code == 200, r.text
    chk = r.json()
    assert chk["backup"]["version"] and chk["backup"]["has_settings"]
    assert chk["current"]["hosts"] == chk["backup"]["counts"]["hosts"] + 1
    assert "10.6.0.2" in _hosts(client)                 # check alone changes nothing

    sent = []
    from backend import notify
    monkeypatch.setattr(notify, "send", lambda **kw: sent.append(kw))
    r = client.post(f"/api/restore/{chk['token']}")
    assert r.status_code == 200, r.text
    ips = _hosts(client)                                # same process, no restart
    assert "10.6.0.1" in ips and "10.6.0.2" not in ips
    assert config.get_config()["ip_history"]["stale_days"] != 33   # settings restored too
    assert sent and sent[0]["title"] == "Boltarr was restored from a backup"
    # the token is single-use
    assert client.post(f"/api/restore/{chk['token']}").status_code == 410


def test_cancel_discards_upload(client):
    chk = client.post("/api/restore/check", files={"file": ("b.zip", _backup(client))}).json()
    client.delete(f"/api/restore/{chk['token']}")
    assert client.post(f"/api/restore/{chk['token']}").status_code == 410


def test_bad_files_rejected(client):
    r = client.post("/api/restore/check", files={"file": ("x.zip", b"not a zip")})
    assert r.status_code == 400
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("boltarr.db", b"garbage" * 100)
    r = client.post("/api/restore/check", files={"file": ("x.zip", buf.getvalue())})
    assert r.status_code == 400


def test_old_backup_without_manifest_still_works(client):
    zin = zipfile.ZipFile(io.BytesIO(_backup(client)))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for n in ("boltarr.db", "config.yaml"):
            if n in zin.namelist():
                zf.writestr(zin.getinfo(n), zin.read(n))
    chk = client.post("/api/restore/check", files={"file": ("old.zip", buf.getvalue())}).json()
    assert chk["backup"]["has_manifest"] is False and chk["backup"]["created_at"]
    assert client.post(f"/api/restore/{chk['token']}").status_code == 200


def test_refused_while_scan_running(client, monkeypatch):
    import backend.main as m
    chk = client.post("/api/restore/check", files={"file": ("b.zip", _backup(client))}).json()
    monkeypatch.setitem(m.scan_jobs, 999999, {"status": "scanning"})
    r = client.post(f"/api/restore/{chk['token']}")
    assert r.status_code == 409 and "scan" in r.json()["detail"].lower()


def test_restore_waits_for_running_loop_iteration(client):
    """A background check in progress finishes before the data is swapped."""
    chk = client.post("/api/restore/check", files={"file": ("b.zip", _backup(client))}).json()
    order = []

    def fake_sweep():
        with maintenance.loop_work():
            order.append("sweep-start"); time.sleep(0.4); order.append("sweep-end")
    t = threading.Thread(target=fake_sweep); t.start(); time.sleep(0.1)
    client.post(f"/api/restore/{chk['token']}")
    order.append("restored")
    t.join()
    assert order == ["sweep-start", "sweep-end", "restored"]
    assert not maintenance.is_paused()
