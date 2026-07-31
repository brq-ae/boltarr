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
            "ALTER TABLE services ADD COLUMN container_ip TEXT",
            "ALTER TABLE services ADD COLUMN monitored INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE services ADD COLUMN monitor_status TEXT DEFAULT 'unknown'",
            "ALTER TABLE services ADD COLUMN monitor_last_check TEXT",
            "ALTER TABLE services ADD COLUMN monitor_last_change TEXT",
            "ALTER TABLE services ADD COLUMN monitor_fail_since TEXT",
            "ALTER TABLE services ADD COLUMN monitor_alerted INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE services ADD COLUMN public INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE services ADD COLUMN public_name TEXT",
            # DHCP range lives on the subnet (one range per subnet for now; multi-pool
            # per subnet can be added later if requested). Hosts are classified static/
            # dynamic by whether their IP falls in it; static_override forces a value.
            "ALTER TABLE subnets ADD COLUMN dhcp_start TEXT",
            "ALTER TABLE subnets ADD COLUMN dhcp_end TEXT",
            "ALTER TABLE hosts ADD COLUMN static_override TEXT",  # NULL=auto | 'static' | 'dynamic'
            """CREATE TABLE IF NOT EXISTS monitor_events (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
                status     TEXT NOT NULL,          -- 'up' | 'down'
                ts         TEXT NOT NULL           -- UTC ISO8601
            )""",
            "CREATE INDEX IF NOT EXISTS idx_monitor_events_svc_ts ON monitor_events(service_id, ts)",
            """CREATE TABLE IF NOT EXISTS service_dependencies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
                to_service_id   INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
                UNIQUE(from_service_id, to_service_id)
            )""",
            # Reusable scan profiles (options as JSON). Built-ins are seeded below
            # and can't be deleted; users add their own. Used by manual scans,
            # per-host probes, and (later) scheduled scans.
            """CREATE TABLE IF NOT EXISTS scan_profiles (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                name     TEXT NOT NULL UNIQUE,
                builtin  INTEGER NOT NULL DEFAULT 0,
                options  TEXT NOT NULL DEFAULT '{}'
            )""",
            # Change-tracking log: what a scan found different vs. the last known
            # state. type: host_new | port_opened | port_closed | mac_changed |
            # hostname_changed. Pruned to a configurable retention window.
            """CREATE TABLE IF NOT EXISTS change_events (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                ts        TEXT NOT NULL,
                ip        TEXT NOT NULL,
                type      TEXT NOT NULL,
                port      INTEGER,
                old_value TEXT,
                new_value TEXT
            )""",
            "CREATE INDEX IF NOT EXISTS idx_change_events_ts ON change_events(ts)",
            "CREATE INDEX IF NOT EXISTS idx_change_events_ip ON change_events(ip, ts)",
            "ALTER TABLE change_events ADD COLUMN run_id INTEGER",   # groups events by scan run
            "ALTER TABLE hosts ADD COLUMN no_mac_alert INTEGER NOT NULL DEFAULT 0",  # per-IP MAC-alert opt-out
            # Liveness (ping tier): online = 1/0/NULL(unknown); miss_count tracks
            # consecutive missed sweeps; no_offline_alert opts a host out of offline alerts.
            "ALTER TABLE hosts ADD COLUMN online INTEGER",
            "ALTER TABLE hosts ADD COLUMN miss_count INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE hosts ADD COLUMN no_offline_alert INTEGER NOT NULL DEFAULT 0",
        ]:
            try:
                conn.execute(sql)
                conn.commit()
            except Exception:
                pass

        # Seed built-in scan profiles (idempotent).
        import json as _json
        for _name, _opts in [
            ("Quick",    {"ports": "none"}),                 # discovery only (-sn)
            ("Standard", {}),                                # top-1000 + version + OS (defaults)
            ("Full",     {"ports": "all"}),                  # all ports + version + OS
        ]:
            try:
                conn.execute("INSERT OR IGNORE INTO scan_profiles (name, builtin, options) VALUES (?, 1, ?)",
                             (_name, _json.dumps(_opts)))
            except Exception:
                pass
        conn.commit()
