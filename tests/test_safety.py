"""v0.26.2 Safety (S-18 Part 1): nmap options/targets checked (F-14), saved
secrets stay with their address (F-16), SSH access (F-25), restore/reset vs a
running scan (F-22) and the smaller hardening items (F-35, F-36)."""
from pathlib import Path

import pytest

from backend import auth, config, main, notify, scanner
from backend.database import get_conn
from backend.main import _MASKED

NET = "10.79.0"
ROOT = Path(__file__).resolve().parent.parent


# ── F-14: nothing reaches nmap that it could read as an extra option ─────────

@pytest.mark.parametrize("opts", [
    {"timing": "oN/app/data/boltarr.db"}, {"timing": "T9"}, {"ports": "-iL"},
    {"ports": "custom", "port_range": "22 -oN x"}, {"scripts": "/tmp/evil.nse"},
    {"scripts": "--script-args=x"}, {"scripts": "../x"}, {"top_n": 0}, {"version_intensity": 10},
])
def test_bad_scan_options_are_refused(client, opts):
    r = client.post("/api/scan/preview", json=opts)
    assert r.status_code == 422, (opts, r.text)


def test_normal_scan_options_still_work(client):
    for opts in ({}, {"timing": "T2", "ports": "custom", "port_range": "22,80,8000-8100,T:443,U:53"},
                 {"ports": "topN", "top_n": 200, "scripts": "default,vuln", "version_intensity": 9},
                 {"scripts": "(default or safe) and not intrusive"}, {"ports": "all", "udp": True, "pn": True}):
        r = client.post("/api/scan/preview", json=opts)
        assert r.status_code == 200, (opts, r.text)


def test_profiles_with_bad_options_cant_be_saved(client):
    r = client.post("/api/scan-profiles", json={"name": "demo-bad", "options": {"timing": "-oN x"}})
    assert r.status_code == 422


@pytest.mark.parametrize("t", ["-iL", "-oN/x", "10.0.0.0/24 -oN x", "a b", "x=y", "", "--script"])
def test_bad_targets(t):
    with pytest.raises(scanner.ScanOptionError):
        scanner.check_target(t)


@pytest.mark.parametrize("t", ["10.0.0.0/24", "10.0.0.5", "10.0.0.1-50", "fe80::1", "nas.lan", "node-1a2b3c4d"])
def test_good_targets(t):
    assert scanner.check_target(t) == t


def test_subnet_and_host_addresses_are_checked(client):
    r = client.post("/api/subnets", json={"name": "demo-x", "cidr": f"{NET}.0/24 -oN /tmp/x"})
    assert r.status_code == 422
    r = client.post("/api/subnets", json={"name": "demo-ok", "cidr": f"{NET}.0/24"})
    assert r.status_code == 201, r.text
    sid = r.json()["id"]
    try:
        assert client.put(f"/api/subnets/{sid}", json={"cidr": "-iL /etc/passwd"}).status_code == 422
        assert client.put(f"/api/subnets/{sid}", json={"name": "demo-ok2"}).status_code == 200
    finally:
        client.delete(f"/api/subnets/{sid}")
    assert client.post("/api/hosts", json={"ip": "-oN/tmp/x"}).status_code == 422


def test_scan_thread_refuses_bad_saved_values_without_running_nmap(monkeypatch):
    ran = []
    monkeypatch.setattr(scanner, "_run_nmap", lambda args, job: ran.append(args))
    with get_conn() as conn:
        run_id = conn.execute("INSERT INTO scan_runs (subnet_id) VALUES (NULL)").lastrowid
        conn.commit()
    scanner.scan_jobs[run_id] = {"status": "starting", "progress": 0, "total": 0, "cancelled": False, "_proc": None}
    scanner._do_scan(run_id, f"{NET}.0/24 -oN /tmp/x", {})       # e.g. a value saved before v0.26.2
    assert ran == [] and scanner.scan_jobs[run_id]["status"] == "error"
    with get_conn() as conn:
        row = conn.execute("SELECT status, note FROM scan_runs WHERE id=?", (run_id,)).fetchone()
        conn.execute("DELETE FROM scan_runs WHERE id=?", (run_id,))
        conn.commit()
    assert row["status"] == "error" and "Not a valid scan target" in row["note"]
    scanner.scan_jobs.pop(run_id, None)


# ── F-16: a hidden saved secret only goes where it was saved for ─────────────

@pytest.fixture
def saved_secrets(client):
    keep = config.get_config()
    client.put("/api/settings/all", json={
        "llm": {"provider": "openai", "base_url": "http://10.79.0.5/v1", "api_key": "demo-key"},
        "notifications": {"server": "http://10.79.0.6", "topic": "demo", "token": "demo-ntfy"},
        "statuspage": {"url": "http://10.79.0.7:12102", "token": "demo-sp"}})
    yield
    cfg = config.get_config()
    for k in ("llm", "notifications", "statuspage"):
        cfg[k] = keep[k]
    config.save_config(cfg)


def test_moving_a_hidden_secret_needs_the_tick(client, saved_secrets):
    for body in ({"llm": {"base_url": "http://evil.example/v1", "api_key": _MASKED}},
                 {"llm": {"provider": "anthropic", "api_key": _MASKED}},
                 {"notifications": {"server": "http://evil.example", "token": _MASKED}},
                 {"statuspage": {"url": "http://evil.example", "token": _MASKED}}):
        r = client.put("/api/settings/all", json=body)
        assert r.status_code == 409 and "Send my saved" in r.text, body
    assert config.get_config()["llm"]["base_url"] == "http://10.79.0.5/v1"     # nothing saved
    # With the tick it moves, and the secret stays saved
    r = client.put("/api/settings/all", json={"llm": {"base_url": "http://10.79.0.9/v1", "api_key": _MASKED,
                                                      "move_secret": True}})
    assert r.status_code == 200
    llm = config.get_config()["llm"]
    assert llm["base_url"] == "http://10.79.0.9/v1" and llm["api_key"] == "demo-key"


def test_no_tick_needed_when_nothing_moves(client, saved_secrets):
    ok = [{"llm": {"base_url": "http://10.79.0.5/v1/", "api_key": _MASKED, "model": "m"}},   # same address
          {"llm": {"base_url": "http://other.example/v1", "api_key": "a-new-key"}},          # retyped
          {"llm": {"provider": "none", "api_key": _MASKED}},                                 # AI off
          {"notifications": {"topic": "other", "token": _MASKED}}]
    for body in ok:
        assert client.put("/api/settings/all", json=body).status_code == 200, body


def test_test_notification_keeps_the_token_home(client, saved_secrets, monkeypatch):
    sent = []
    monkeypatch.setattr(notify, "send_with", lambda cfg, **kw: (sent.append(cfg), (True, ""))[1])
    r = client.post("/api/notifications/test", json={"server": "http://evil.example", "token": _MASKED})
    assert r.status_code == 409 and sent == []
    assert client.post("/api/notifications/test", json={"server": "http://10.79.0.6", "token": _MASKED}).json()["ok"]
    assert sent[-1]["token"] == "demo-ntfy"


# ── F-25: SSH access ─────────────────────────────────────────────────────────

_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoDemoDemoDemoDemoDemoDemoDemoDemoDemo demo@pc"


def test_ssh_keys_and_users_are_checked(client):
    assert client.post("/api/ssh-keys", json={"name": "x\nssh-rsa AAAA evil", "public_key": _KEY}).status_code == 422
    assert client.post("/api/ssh-keys", json={"name": "demo", "public_key": _KEY + "\nssh-rsa AAAA evil"}).status_code == 422
    assert client.post("/api/ssh-keys", json={"name": "demo", "public_key": "not a key"}).status_code == 422
    r = client.post("/api/ssh-keys", json={"name": "demo-ecdsa", "public_key": "ecdsa-sha2-nistp256 AAAAE2Vj demo"})
    assert r.status_code == 201, r.text                                  # ecdsa keys now accepted
    client.delete(f"/api/ssh-keys/{r.json()['id']}")


def test_ssh_access_remove_and_cleanup(client):
    client.post("/api/hosts", json={"ip": f"{NET}.20", "hostname": "demo-ssh"})
    kid = client.post("/api/ssh-keys", json={"name": "demo-key", "public_key": _KEY}).json()["id"]
    try:
        assert client.post(f"/api/hosts/{NET}.20/ssh-access",
                           json={"ssh_key_id": kid, "username": "root'; rm -rf /"}).status_code == 422
        a = client.post(f"/api/hosts/{NET}.20/ssh-access", json={"ssh_key_id": kid, "username": "demo"}).json()
        assert client.delete(f"/api/ssh-access/{a['id']}").status_code == 204        # the ✕ works again
        assert client.get(f"/api/hosts/{NET}.20/ssh-access").json() == []
        client.post(f"/api/hosts/{NET}.20/ssh-access", json={"ssh_key_id": kid, "username": "demo"})
        client.delete(f"/api/hosts/{NET}.20")
        client.post("/api/hosts", json={"ip": f"{NET}.20", "hostname": "demo-new-device"})
        assert client.get(f"/api/hosts/{NET}.20/ssh-access").json() == []            # nothing inherited
        # A row saved before the checks can't break into extra lines
        with get_conn() as conn:
            conn.execute("INSERT INTO ssh_access (ssh_key_id, host_ip, username) VALUES (?,?,?)", (kid, f"{NET}.20", "demo"))
            conn.execute("UPDATE ssh_keys SET name=? WHERE id=?", ("old\nssh-rsa AAAA injected", kid))
            conn.commit()
        text = client.get(f"/api/hosts/{NET}.20/authorized-keys?user=demo").text
        assert text.count("\n") == 1 and "injected" in text
    finally:
        client.delete(f"/api/hosts/{NET}.20")
        client.delete(f"/api/ssh-keys/{kid}")


# ── F-22: restore / factory reset vs a running scan ──────────────────────────

@pytest.mark.parametrize("status", ["starting", "discovering", "scanning"])
def test_live_scan_blocks_restore_and_reset(client, monkeypatch, status):
    monkeypatch.setitem(scanner.scan_jobs, 999998, {"status": status})
    assert main._scan_running()
    r = client.post("/api/factory-reset", json={"keep_settings": True})
    assert r.status_code == 409 and "scan is running" in r.text


def test_finished_scans_dont_block(monkeypatch):
    for st in ("completed", "error", "cancelled"):
        monkeypatch.setitem(scanner.scan_jobs, 999997, {"status": st})
        assert not main._scan_running()


def test_factory_reset_wipes_and_reseeds(client):
    client.post("/api/hosts", json={"ip": f"{NET}.30", "hostname": "demo-reset"})
    r = client.post("/api/factory-reset", json={"keep_settings": True})
    assert r.status_code == 200, r.text
    assert client.get("/api/hosts").json() == []
    assert any(p["builtin"] for p in client.get("/api/scan-profiles").json())


# ── F-35 ─────────────────────────────────────────────────────────────────────

def test_restore_upload_has_a_size_cap(client, monkeypatch):
    monkeypatch.setattr(main, "_UPLOAD_MAX", 1000)
    r = client.post("/api/restore/check", files={"file": ("b.zip", b"x" * 5000, "application/zip")})
    assert r.status_code == 413


def test_login_failure_memory_is_bounded(monkeypatch):
    monkeypatch.setattr(auth, "_FAILS_MAX", 5)
    monkeypatch.setattr(auth, "_fails", {})
    for i in range(20):
        auth.record_failure(f"10.79.1.{i}")
    assert len(auth._fails) <= 5


def test_trusted_proxy_range_warns(client, monkeypatch):
    cfg = config.get_config()
    keep = dict(cfg["auth"])
    try:
        r = client.put("/api/auth/settings", json={"trusted_proxies": "172.18.0.0/16"})
        assert r.status_code == 200 and "whole ranges" in r.json()["warning"]
        assert "warning" not in client.put("/api/auth/settings", json={"trusted_proxies": "172.18.0.5"}).json()
    finally:
        cfg = config.get_config()
        cfg["auth"] = keep
        config.save_config(cfg)


# ── F-36 ─────────────────────────────────────────────────────────────────────

def test_statuspage_image_drops_root_and_pins_versions():
    df = (ROOT / "statuspage" / "Dockerfile").read_text()
    assert 'ENTRYPOINT ["/entrypoint.sh"]' in df
    ep = (ROOT / "statuspage" / "entrypoint.sh").read_text()
    assert "setpriv" in ep and "PUID" in ep and 'exec "$@"' in ep
    reqs = (ROOT / "statuspage" / "requirements.txt").read_text().split()
    assert reqs and all("==" in r for r in reqs)
