"""S-15: the view level a new browser starts on is decided once by the server —
an install that already had devices or networks (an upgrade) starts on Advanced,
an empty one on Basic."""
import sqlite3
from contextlib import contextmanager

from backend import config, main
from backend.database import get_conn


def _set_start(level):
    cfg = config.get_config()
    cfg["ui"]["start_level"] = level
    config.save_config(cfg)


@contextmanager
def _empty_db():
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE hosts (ip TEXT)")
    conn.execute("CREATE TABLE subnets (cidr TEXT)")
    try:
        yield conn
    finally:
        conn.close()


def test_a_saved_level_is_kept(client):
    _set_start("intermediate")
    assert client.get("/api/ui/start-level").json() == {"level": "intermediate"}


def test_an_install_with_devices_starts_on_advanced(client):
    with get_conn() as conn:
        conn.execute("INSERT OR IGNORE INTO hosts (ip, hostname, last_seen) VALUES ('10.9.0.1', 'demo-box', '2026-01-01')")
    _set_start("")
    assert client.get("/api/ui/start-level").json() == {"level": "advanced"}
    assert config.get_config()["ui"]["start_level"] == "advanced"   # saved, not guessed each time


def test_an_empty_install_starts_on_basic(client, monkeypatch):
    monkeypatch.setattr(main, "get_conn", _empty_db)
    _set_start("")
    assert client.get("/api/ui/start-level").json() == {"level": "basic"}
    # once decided it stays, even after devices are added
    monkeypatch.undo()
    assert client.get("/api/ui/start-level").json() == {"level": "basic"}


def test_an_odd_value_is_decided_again(client):
    _set_start("expert")
    assert client.get("/api/ui/start-level").json()["level"] in main.VIEW_LEVELS


def test_saving_settings_keeps_the_start_level(client):
    _set_start("basic")
    r = client.put("/api/settings/all", json={"general": {"timezone": "Europe/Berlin"}})
    assert r.status_code == 200, r.text
    assert config.get_config()["ui"]["start_level"] == "basic"
