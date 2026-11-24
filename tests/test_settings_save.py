"""F-03: the Settings dialog saves every section in one all-or-nothing request."""
import pytest

from backend import config


@pytest.fixture(autouse=True)
def _keep_settings(client, data_dir):
    """These tests rewrite Settings: put config.yaml back after each one, so the
    tests that run later still see the defaults (F-39: alerts were left off)."""
    path = data_dir / "config.yaml"
    before = path.read_bytes()
    yield
    path.write_bytes(before)
    config.invalidate_config_cache()


def _all(**over):
    body = {
        "general": {"timezone": "Europe/Berlin"},
        "llm": {"provider": "none", "model": "m1"},
        "notifications": {"enabled": False, "topic": "t1", "check_seconds": 90},
        "statuspage": {"enabled": False, "url": "http://status.example/"},
        "change_tracking": {"enabled": True, "retention_days": 45},
        "liveness": {"enabled": True, "interval_minutes": 4},
        "ip_history": {"stale_days": 20, "gone_days": 50},
        "change_alerts": {"enabled": False, "scope": "static"},
    }
    body.update(over)
    return body


def test_save_all_writes_every_section(client):
    r = client.put("/api/settings/all", json=_all())
    assert r.status_code == 200, r.text
    cfg = config.get_config()
    assert cfg["general"]["timezone"] == "Europe/Berlin"
    assert cfg["llm"]["model"] == "m1"
    assert cfg["monitoring"]["check_seconds"] == 90
    assert cfg["statuspage"]["url"] == "http://status.example"
    assert cfg["change_tracking"]["retention_days"] == 45
    assert cfg["liveness"]["interval_minutes"] == 4
    assert cfg["ip_history"] == {"stale_days": 20, "gone_days": 50}
    assert cfg["change_alerts"]["scope"] == "static"


def test_one_bad_section_saves_nothing(client):
    client.put("/api/settings/all", json=_all())
    before = config.get_config()
    # valid changes in early sections + an invalid IP History at the end
    r = client.put("/api/settings/all", json=_all(
        general={"timezone": "Europe/London"},
        llm={"model": "m2"},
        ip_history={"stale_days": 40, "gone_days": 10}))
    assert r.status_code == 422
    assert config.get_config() == before          # used to be half-saved


def test_bad_timezone_saves_nothing(client):
    before = config.get_config()
    r = client.put("/api/settings/all", json=_all(general={"timezone": "Not/AZone"},
                                                  llm={"model": "m3"}))
    assert r.status_code == 422
    assert config.get_config() == before


def test_masked_secrets_are_kept(client):
    client.put("/api/settings/all", json=_all(notifications={"token": "secret-tok"}))
    masked = client.get("/api/settings").json()["notifications"]["token"]
    assert masked and masked != "secret-tok"
    client.put("/api/settings/all", json=_all(notifications={"token": masked}))
    assert config.get_config()["notifications"]["token"] == "secret-tok"


def test_one_file_write_per_save(client, monkeypatch):
    calls = []
    import backend.main as m
    real = m.save_config
    monkeypatch.setattr(m, "save_config", lambda c: calls.append(1) or real(c))
    client.put("/api/settings/all", json=_all())
    assert len(calls) == 1                        # was 8


def test_save_is_atomic_no_temp_left(client, data_dir):
    client.put("/api/settings/all", json=_all())
    assert not (data_dir / "config.yaml.tmp").exists()


def test_one_section_saves_on_its_own(client):
    r = client.put("/api/settings/all", json={"ip_history": {"stale_days": 25, "gone_days": 70}})
    assert r.json()["ip_history"] == {"stale_days": 25, "gone_days": 70}
    r = client.put("/api/settings/all", json={"ip_history": {"stale_days": 90}})
    assert r.status_code == 422
    assert config.get_config()["ip_history"]["stale_days"] == 25


def test_old_section_addresses_are_gone(client):
    # F-41: Settings saves through /api/settings/all only
    for sec in ("general", "liveness", "notifications", "change-alerts", "change-tracking", "ip-history"):
        assert client.put(f"/api/settings/{sec}", json={}).status_code in (404, 405)


def test_include_aliases_setting_round_trips(client):
    assert client.get("/api/settings").json()["change_alerts"]["include_aliases"] is True   # default on
    client.put("/api/settings/all", json=_all(change_alerts={"include_aliases": False}))
    assert client.get("/api/settings").json()["change_alerts"]["include_aliases"] is False
    client.put("/api/settings/all", json=_all(change_alerts={"include_aliases": True}))
