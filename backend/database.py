import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "data" / "boltarr.db"


def get_conn():
    DB_PATH.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    with get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS subnets (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL,
                cidr        TEXT NOT NULL UNIQUE,
                description TEXT,
                created_at  TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS scan_runs (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                subnet_id    INTEGER REFERENCES subnets(id) ON DELETE CASCADE,
                started_at   TEXT DEFAULT (datetime('now')),
                completed_at TEXT,
                status       TEXT DEFAULT 'running',
                hosts_found  INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS hosts (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ip          TEXT NOT NULL UNIQUE,
                mac         TEXT,
                hostname    TEXT,
                os_guess    TEXT,
                device_type TEXT,
                vendor      TEXT,
                notes       TEXT,
                first_seen  TEXT DEFAULT (datetime('now')),
                last_seen   TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS ports (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                host_id  INTEGER REFERENCES hosts(id) ON DELETE CASCADE,
                port     INTEGER NOT NULL,
                protocol TEXT NOT NULL DEFAULT 'tcp',
                state    TEXT,
                service  TEXT,
                version  TEXT,
                manual   INTEGER NOT NULL DEFAULT 0,
                UNIQUE(host_id, port, protocol)
            );

            CREATE TABLE IF NOT EXISTS llm_analyses (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                host_id    INTEGER REFERENCES hosts(id) ON DELETE CASCADE,
                model      TEXT,
                analysis   TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS connections (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                src_ip     TEXT NOT NULL,
                dst_ip     TEXT NOT NULL,
                type       TEXT NOT NULL DEFAULT 'wired',
                label      TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                UNIQUE(src_ip, dst_ip)
            );

            CREATE TABLE IF NOT EXISTS services (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                host_id     INTEGER REFERENCES hosts(id) ON DELETE CASCADE,
                name        TEXT NOT NULL,
                description TEXT,
                port        INTEGER,
                protocol    TEXT NOT NULL DEFAULT 'tcp',
                status      TEXT NOT NULL DEFAULT 'unknown',
                url         TEXT,
                icon        TEXT,
                created_at  TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS vlans (
                id    INTEGER PRIMARY KEY AUTOINCREMENT,
                tag   INTEGER NOT NULL UNIQUE,
                name  TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '#888888'
            );

            CREATE TABLE IF NOT EXISTS connection_vlans (
                connection_id INTEGER REFERENCES connections(id) ON DELETE CASCADE,
                vlan_id       INTEGER REFERENCES vlans(id) ON DELETE CASCADE,
                PRIMARY KEY (connection_id, vlan_id)
            );

            CREATE TABLE IF NOT EXISTS host_aliases (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
                ip      TEXT NOT NULL UNIQUE
            );

            CREATE TABLE IF NOT EXISTS ssh_keys (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL,
                public_key  TEXT NOT NULL,
                fingerprint TEXT,
                created_at  TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS ssh_access (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                ssh_key_id INTEGER NOT NULL REFERENCES ssh_keys(id) ON DELETE CASCADE,
                host_ip    TEXT NOT NULL,
                username   TEXT NOT NULL DEFAULT 'root',
                created_at TEXT DEFAULT (datetime('now')),
                UNIQUE(ssh_key_id, host_ip, username)
            );
        """)

        # Migrate existing DBs that predate new columns
        for sql in [
            "ALTER TABLE hosts ADD COLUMN notes TEXT",
            "ALTER TABLE ports ADD COLUMN manual INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE connections ADD COLUMN port_mode TEXT",
            "ALTER TABLE hosts ADD COLUMN pos_x REAL",
            "ALTER TABLE hosts ADD COLUMN pos_y REAL",
            "ALTER TABLE hosts ADD COLUMN tier INTEGER",
            "ALTER TABLE connections ADD COLUMN speed TEXT",
            "ALTER TABLE connections ADD COLUMN tagged_only INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE hosts ADD COLUMN port_count INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE hosts ADD COLUMN has_wifi INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE hosts ADD COLUMN is_dhcp INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE hosts ADD COLUMN dhcp_pool TEXT",
            "ALTER TABLE hosts ADD COLUMN is_dns INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE hosts ADD COLUMN source TEXT NOT NULL DEFAULT 'scanned'",
            "ALTER TABLE scan_runs ADD COLUMN type TEXT NOT NULL DEFAULT 'scan'",
            "ALTER TABLE scan_runs ADD COLUMN host_ip TEXT",
        ]:
            try:
                conn.execute(sql)
                conn.commit()
            except Exception:
                pass
