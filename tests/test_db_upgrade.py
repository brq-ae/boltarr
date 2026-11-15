"""F-37: database upgrades skip only "already there" errors; anything else stops
with a clear message (at start-up, and a backup that can't be upgraded is
refused before restore changes anything)."""
import io
import sqlite3
import zipfile

import pytest

from backend import database
from backend.database import MigrationError, init_db

# Roughly the first Boltarr schema: no notes/manual/source/... columns, none of
# the later tables (monitor_events, scan_schedules, change_events, ...).
_EARLY = """
CREATE TABLE subnets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, cidr TEXT NOT NULL UNIQUE,
                      description TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE scan_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, subnet_id INTEGER, started_at TEXT,
                        completed_at TEXT, status TEXT DEFAULT 'running', hosts_found INTEGER DEFAULT 0);
CREATE TABLE hosts (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL UNIQUE, mac TEXT, hostname TEXT,
                    os_guess TEXT, device_type TEXT, vendor TEXT, first_seen TEXT, last_seen TEXT);
CREATE TABLE ports (id INTEGER PRIMARY KEY AUTOINCREMENT, host_id INTEGER, port INTEGER NOT NULL,
                    protocol TEXT NOT NULL DEFAULT 'tcp', state TEXT, service TEXT, version TEXT,
                    UNIQUE(host_id, port, protocol));
CREATE TABLE services (id INTEGER PRIMARY KEY AUTOINCREMENT, host_id INTEGER, name TEXT NOT NULL,
                       description TEXT, port INTEGER, protocol TEXT NOT NULL DEFAULT 'tcp',
                       status TEXT NOT NULL DEFAULT 'unknown', url TEXT, icon TEXT, created_at TEXT);
CREATE TABLE connections (id INTEGER PRIMARY KEY AUTOINCREMENT, src_ip TEXT NOT NULL, dst_ip TEXT NOT NULL,
                          type TEXT NOT NULL DEFAULT 'wired', label TEXT, created_at TEXT, UNIQUE(src_ip, dst_ip));
INSERT INTO hosts (ip, hostname) VALUES ('10.7.0.1', 'demo-early');
INSERT INTO ports (host_id, port, state) VALUES (1, 22, 'open');
"""


def _cols(path, table):
    with sqlite3.connect(path) as c:
        return {r[1] for r in c.execute(f"PRAGMA table_info({table})")}


def _schema(path):
    with sqlite3.connect(path) as c:
        return sorted(c.execute("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"))


def test_early_schema_upgrades_twice(tmp_path):
    db = tmp_path / "early.db"
    with sqlite3.connect(db) as c:
        c.executescript(_EARLY)
    init_db(db)
    first = _schema(db)
    assert {"notes", "source", "online", "offline_alerted"} <= _cols(db, "hosts")
    assert {"manual"} <= _cols(db, "ports")
    assert {"monitored", "monitor_pause_reason", "accepted_codes"} <= _cols(db, "services")
    with sqlite3.connect(db) as c:
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"monitor_events", "scan_schedules", "change_events", "alert_queue"} <= tables
        assert c.execute("SELECT hostname FROM hosts WHERE ip='10.7.0.1'").fetchone()[0] == "demo-early"
        # F-20: a name already in Boltarr counts as yours, so scans leave it alone
        assert c.execute("SELECT hostname_set FROM hosts WHERE ip='10.7.0.1'").fetchone()[0] == 1
        assert c.execute("SELECT COUNT(*) FROM scan_profiles WHERE builtin=1").fetchone()[0] == 3
    with sqlite3.connect(db) as c:               # set it back: a re-run must not flip it again
        c.execute("UPDATE hosts SET hostname_set=0")
    init_db(db)                                  # second run: nothing new, nothing fails
    assert _schema(db) == first
    with sqlite3.connect(db) as c:
        assert c.execute("SELECT hostname_set FROM hosts").fetchone()[0] == 0     # the one-time step ran once


def test_fresh_db_twice(tmp_path):
    db = tmp_path / "fresh.db"
    init_db(db)
    first = _schema(db)
    init_db(db)
    assert _schema(db) == first


def test_already_there_is_skipped(tmp_path):
    with database.get_conn(tmp_path / "x.db") as c:
        c.execute("CREATE TABLE t (a TEXT)")
        database._migrate(c, "ALTER TABLE t ADD COLUMN b TEXT")
        database._migrate(c, "ALTER TABLE t ADD COLUMN b TEXT")          # duplicate column name
        database._migrate(c, "CREATE TABLE t (a TEXT)")                   # already exists
        database._migrate(c, "CREATE INDEX i ON t(a)")
        database._migrate(c, "CREATE INDEX i ON t(a)")                    # index already exists


def test_a_real_failure_stops_with_a_clear_message(tmp_path):
    with database.get_conn(tmp_path / "x.db") as c:
        with pytest.raises(MigrationError, match="couldn't upgrade its database: no such table: nosuch"):
            database._migrate(c, "ALTER TABLE nosuch ADD COLUMN b TEXT")


def _broken_db(tmp_path):
    """Passes the integrity check and has hosts, but scan_runs is a view, so
    'ALTER TABLE scan_runs ADD COLUMN ...' can't work."""
    db = tmp_path / "broken.db"
    with sqlite3.connect(db) as c:
        c.executescript(_EARLY.replace(
            "CREATE TABLE scan_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, subnet_id INTEGER, started_at TEXT,\n"
            "                        completed_at TEXT, status TEXT DEFAULT 'running', hosts_found INTEGER DEFAULT 0);",
            "CREATE VIEW scan_runs AS SELECT 1 AS id, NULL AS subnet_id;"))
    return db


def test_upgrade_failure_stops_start_up(tmp_path):
    with pytest.raises(MigrationError, match="Cannot add a column to a view"):
        init_db(_broken_db(tmp_path))


def test_backup_that_cant_be_upgraded_is_refused_before_restore(client, tmp_path):
    client.post("/api/hosts", json={"ip": "10.7.0.9", "hostname": "demo-stays"})
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("boltarr.db", _broken_db(tmp_path).read_bytes())
    r = client.post("/api/restore/check", files={"file": ("broken.zip", buf.getvalue())})
    assert r.status_code == 400 and "can't be upgraded" in r.json()["detail"]
    assert "10.7.0.9" in {h["ip"] for h in client.get("/api/hosts").json()}     # live data untouched


def test_early_backup_still_restores(client, tmp_path):
    db = tmp_path / "early.db"
    with sqlite3.connect(db) as c:
        c.executescript(_EARLY)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("boltarr.db", db.read_bytes())
    chk = client.post("/api/restore/check", files={"file": ("early.zip", buf.getvalue())})
    assert chk.status_code == 200, chk.text
    assert client.post(f"/api/restore/{chk.json()['token']}").status_code == 200
    assert "10.7.0.1" in {h["ip"] for h in client.get("/api/hosts").json()}
