"""F-11: optional password on backups (AES-256 zip); restore asks for it."""
import io
import zipfile

import pyzipper

from backend import config

PW = "backup-pass-9"


def _protected(client, pw=PW):
    r = client.post("/api/backup", json={"password": pw})
    assert r.status_code == 200, r.text
    return r


def test_protected_backup_is_encrypted(client):
    cfg = config.get_config(); cfg["notifications"]["token"] = "tk_secret_value_123"; config.save_config(cfg)
    r = _protected(client)
    assert "-protected.zip" in r.headers["content-disposition"]
    data = r.content
    assert b"tk_secret_value_123" not in data and b"SQLite format" not in data   # nothing readable
    zf = pyzipper.AESZipFile(io.BytesIO(data))
    assert all(i.flag_bits & 0x1 for i in zf.infolist())
    zf.setpassword(PW.encode())                       # opens like any encrypted zip
    assert b"tk_secret_value_123" in zf.read("config.yaml")


def test_unprotected_backup_unchanged(client):
    r = client.post("/api/backup", json={})
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    assert not any(i.flag_bits & 0x1 for i in zf.infolist())
    assert "-protected" not in r.headers["content-disposition"]
    assert client.get("/api/backup").status_code == 200     # old GET still works


def test_short_backup_password_refused(client):
    assert client.post("/api/backup", json={"password": "short"}).status_code == 422


def test_restore_asks_for_password_then_works(client):
    data = _protected(client).content
    r = client.post("/api/restore/check", files={"file": ("b.zip", data)})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "password_required"
    r = client.post("/api/restore/check", files={"file": ("b.zip", data)}, data={"password": "wrong-one"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "wrong_password"
    r = client.post("/api/restore/check", files={"file": ("b.zip", data)}, data={"password": PW})
    assert r.status_code == 200, r.text
    chk = r.json()
    assert chk["backup"]["protected"] is True and chk["backup"]["has_settings"]
    assert client.post(f"/api/restore/{chk['token']}").status_code == 200


def test_one_shot_restore_with_password(client):
    data = _protected(client).content
    assert client.post("/api/restore", files={"file": ("b.zip", data)}).status_code == 422
    assert client.post("/api/restore", files={"file": ("b.zip", data)}, data={"password": PW}).status_code == 200
