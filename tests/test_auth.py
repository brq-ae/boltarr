"""F-01: optional login — off by default, gate + cookie sessions, CSRF header,
wrong-password slowdown, trusted proxy, first-run setup, reset command."""
import time

import pytest
from fastapi.testclient import TestClient

from backend import auth, config
from backend.main import app

H = {"X-Boltarr": "1"}
PW = "correct-horse-1"


def _anon():
    return TestClient(app)


@pytest.fixture
def login_on(client):
    """Turn login on for one test, always back off afterwards."""
    auth._fails.clear()
    me = _anon()
    r = me.post("/api/auth/setup", json={"username": "admin", "password": PW}, headers=H)
    assert r.status_code == 200, r.text
    try:
        yield me
    finally:
        auth.clear_password()
        auth._fails.clear()


def test_off_by_default_everything_open(client):
    assert client.get("/api/auth/status").json()["enabled"] is False
    assert _anon().get("/api/hosts").status_code == 200
    assert _anon().put("/api/settings/ip-history", json={"stale_days": 30}).status_code == 200  # no header needed


def test_gate_when_on(login_on):
    anon = _anon()
    assert anon.get("/api/hosts").status_code == 401
    r = anon.get("/", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/login.html"
    for open_path in ("/login.html", "/js/login.js", "/css/style.css", "/api/version", "/api/auth/status"):
        assert anon.get(open_path).status_code == 200, open_path
    assert anon.get("/js/app.js", follow_redirects=False).status_code == 303
    assert login_on.get("/api/hosts").status_code == 200          # the browser that set it up stays in


def test_login_and_cookie_flags(login_on):
    anon = _anon()
    assert anon.post("/api/auth/login", json={"password": "nope-nope"}, headers=H).status_code == 401
    assert anon.post("/api/auth/login", json={"username": "bob", "password": PW}, headers=H).status_code == 401
    r = anon.post("/api/auth/login", json={"username": "admin", "password": PW}, headers=H)
    assert r.status_code == 200
    sc = r.headers["set-cookie"].lower()
    assert "httponly" in sc and "samesite=lax" in sc and "max-age=2592000" in sc
    assert anon.get("/api/hosts").status_code == 200
    assert anon.get("/api/auth/status").json() == {"enabled": True, "setup_pending": False,
                                                   "logged_in": True, "username": "admin", "via_proxy": False}


def test_changes_need_the_header(login_on):
    assert login_on.put("/api/settings/ip-history", json={"stale_days": 30}).status_code == 403
    assert login_on.put("/api/settings/ip-history", json={"stale_days": 30}, headers=H).status_code == 200


def test_wrong_password_slowdown(login_on):
    anon = _anon()
    for _ in range(5):
        assert anon.post("/api/auth/login", json={"password": "wrong-pass"}, headers=H).status_code == 401
    r = anon.post("/api/auth/login", json={"password": PW}, headers=H)   # even the right one waits
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0


def test_password_change_logs_out_other_browsers(login_on):
    other = _anon()
    other.post("/api/auth/login", json={"password": PW}, headers=H)
    assert other.get("/api/hosts").status_code == 200
    r = login_on.post("/api/auth/password", json={"current": PW, "new": "new-password-2"}, headers=H)
    assert r.status_code == 200
    assert other.get("/api/hosts").status_code == 401
    assert login_on.get("/api/hosts").status_code == 200           # this browser got a fresh cookie
    assert login_on.post("/api/auth/password", json={"current": "bad", "new": "x" * 9}, headers=H).status_code == 401


def test_short_password_refused(client):
    r = _anon().post("/api/auth/setup", json={"password": "short"}, headers=H)
    assert r.status_code == 422
    assert client.get("/api/auth/status").json()["enabled"] is False


def test_tampered_or_expired_cookie_rejected(login_on):
    a = auth.auth_config()
    good = auth.make_session(a)
    payload, sig = good.rsplit(".", 1)
    assert auth.read_session(a, good) == "admin"
    assert auth.read_session(a, payload + "." + sig[:-2] + "AA") is None
    a2 = dict(a, session_days=-1)
    assert auth.read_session(a, auth.make_session(a2)) is None


def test_trusted_proxy_only_from_listed_ips():
    a = {"trust_proxy": True, "trusted_proxies": "10.0.0.5, 172.18.0.0/16", "proxy_header": "Remote-User"}
    assert auth.proxy_user(a, "10.0.0.5", {"Remote-User": "alice"}) == "alice"
    assert auth.proxy_user(a, "172.18.3.4", {"Remote-User": "alice"}) == "alice"
    assert auth.proxy_user(a, "10.0.0.6", {"Remote-User": "alice"}) is None      # not the proxy
    assert auth.proxy_user(a, "10.0.0.5", {}) is None                           # no header
    assert auth.proxy_user(dict(a, trust_proxy=False), "10.0.0.5", {"Remote-User": "x"}) is None


def test_proxy_settings_validation(login_on):
    r = login_on.put("/api/auth/settings", json={"trust_proxy": True}, headers=H)
    assert r.status_code == 422                                     # needs an IP first
    assert login_on.put("/api/auth/settings", json={"trusted_proxies": "not-an-ip"}, headers=H).status_code == 422
    r = login_on.put("/api/auth/settings", json={"trusted_proxies": "10.0.0.5", "trust_proxy": True}, headers=H)
    assert r.status_code == 200 and r.json()["trust_proxy"] is True


def test_disable_needs_password_and_reopens(login_on):
    assert login_on.post("/api/auth/disable", json={"password": "wrong"}, headers=H).status_code == 401
    assert login_on.post("/api/auth/disable", json={"password": PW}, headers=H).status_code == 200
    assert _anon().get("/api/hosts").status_code == 200


def test_settings_api_never_returns_secrets(login_on):
    body = login_on.get("/api/auth/settings").text + login_on.get("/api/settings").text
    a = auth.auth_config()
    assert a["password_hash"] not in body and a["secret"] not in body


def test_first_run_setup_gate_and_skip(client):
    cfg = config.get_config(); cfg["auth"]["setup_pending"] = True; config.save_config(cfg)
    try:
        anon = _anon()
        r = anon.get("/api/hosts")
        assert r.status_code == 401 and "password" in r.json()["detail"]
        assert anon.get("/api/auth/status").json()["setup_pending"] is True
        assert anon.post("/api/auth/skip-setup", headers=H).status_code == 200
        assert anon.get("/api/hosts").status_code == 200
    finally:
        cfg = config.get_config(); cfg["auth"]["setup_pending"] = False; config.save_config(cfg)


def test_reset_password_command(login_on, capsys):
    from backend import reset_password
    reset_password.main()
    assert "login is now off" in capsys.readouterr().out
    assert _anon().get("/api/hosts").status_code == 200
    assert login_on.get("/api/auth/status").json()["enabled"] is False


def test_password_hashing():
    h = auth.hash_password("pässwörd-1")
    assert h.startswith("scrypt$") and "pässwörd" not in h
    assert auth.verify_password("pässwörd-1", h) and not auth.verify_password("pässwörd-2", h)
    assert auth.hash_password("same") != auth.hash_password("same")   # salted
