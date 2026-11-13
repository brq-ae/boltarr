import os
import sqlite3
from pathlib import Path

# Data lives in <repo>/data by default; BOLTARR_DATA_DIR overrides it (holds the
# DB and config.yaml) — handy for a preview instance or a custom deployment path.
_DATA_DIR = Path(os.environ.get("BOLTARR_DATA_DIR") or (Path(__file__).parent.parent / "data"))
DB_PATH = _DATA_DIR / "boltarr.db"


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
            "ALTER TABLE services ADD COLUMN check_type TEXT",   # http | tcp | icmp | NULL(auto-infer)
            "ALTER TABLE services ADD COLUMN monitor_resume_at TEXT",   # paused until (UTC ISO); NULL = no end
            # DHCP range lives on the subnet (one range per subnet for now; multi-pool
            # per subnet can be added later if requested). Hosts are classified static/
            # dynamic by whether their IP falls in it; static_override forces a value.
            "ALTER TABLE subnets ADD COLUMN dhcp_start TEXT",
            "ALTER TABLE subnets ADD COLUMN dhcp_end TEXT",
            "ALTER TABLE hosts ADD COLUMN static_override TEXT",  # NULL=auto | 'static' | 'dynamic'
            # Alias IPs are pinged on their own (F-10): each keeps its own liveness
            "ALTER TABLE host_aliases ADD COLUMN online INTEGER",
            "ALTER TABLE host_aliases ADD COLUMN miss_count INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE host_aliases ADD COLUMN last_seen TEXT",
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
            # Scheduled scans. A schedule = target (subnet all/one × host filter) +
            # timing (interval hours OR weekly days+time) + a scan profile. The
            # scheduler loop runs due schedules through the normal scan engine.
            """CREATE TABLE IF NOT EXISTS scan_schedules (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                name           TEXT NOT NULL,
                enabled        INTEGER NOT NULL DEFAULT 1,
                subnet_id      INTEGER REFERENCES subnets(id) ON DELETE CASCADE,  -- NULL = all subnets
                host_filter    TEXT NOT NULL DEFAULT 'all',   -- all | static | dynamic | unknown
                profile_id     INTEGER REFERENCES scan_profiles(id) ON DELETE SET NULL,
                timing_type    TEXT NOT NULL DEFAULT 'interval',  -- interval | weekly
                interval_hours REAL,                          -- for timing_type=interval
                days_of_week   TEXT,                           -- weekly: CSV of 0-6 (Mon=0..Sun=6)
                at_time        TEXT,                           -- weekly: 'HH:MM' local
                last_run       TEXT,                           -- ISO of last fire
                created_at     TEXT DEFAULT (datetime('now'))
            )""",
            "ALTER TABLE scan_runs ADD COLUMN schedule_id INTEGER",   # which schedule triggered it (NULL = manual)
            "ALTER TABLE scan_runs ADD COLUMN note TEXT",             # e.g. skip reason
            # Active window: a schedule only fires between window_start and window_end
            # (local 'HH:MM'; both NULL = always). Gates automatic firing, not Run now.
            "ALTER TABLE scan_schedules ADD COLUMN window_start TEXT",
            "ALTER TABLE scan_schedules ADD COLUMN window_end TEXT",
            # Silent schedule: records changes as usual but sends no per-scan alert
            # (its changes still appear in the daily digest).
            "ALTER TABLE scan_schedules ADD COLUMN silent INTEGER NOT NULL DEFAULT 0",
            # DHCP warnings (dhcp_check.py): per-host opt-out, and what the daily
            # digest already reported (so each warning is sent once)
            "ALTER TABLE hosts ADD COLUMN no_dhcp_warn INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE hosts ADD COLUMN dhcp_reported TEXT",
            "ALTER TABLE subnets ADD COLUMN pool_reported INTEGER NOT NULL DEFAULT 0",
            # Subnets page (v0.24.0): hidden on the Topology map, remembered across reloads
            "ALTER TABLE subnets ADD COLUMN map_hidden INTEGER NOT NULL DEFAULT 0",
            # Host up/down history (liveness), for host uptime %/outages — mirrors
            # monitor_events for services. status: 'up' | 'down'.
            """CREATE TABLE IF NOT EXISTS host_events (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
                status  TEXT NOT NULL,
                ts      TEXT NOT NULL
            )""",
            "CREATE INDEX IF NOT EXISTS idx_host_events_host_ts ON host_events(host_id, ts)",
            # Which hosts appear on the public status page (Phase 3).
            "ALTER TABLE hosts ADD COLUMN public INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE hosts ADD COLUMN public_name TEXT",
            # What the browser blocked (enforced policy) or would block under the
            # strict, no-inline-code policy (report-only). See security.py.
            """CREATE TABLE IF NOT EXISTS csp_reports (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                mode       TEXT NOT NULL,
                directive  TEXT NOT NULL,
                blocked    TEXT NOT NULL DEFAULT '',
                source     TEXT NOT NULL DEFAULT '',
                line       INTEGER NOT NULL DEFAULT 0,
                sample     TEXT NOT NULL DEFAULT '',
                count      INTEGER NOT NULL DEFAULT 1,
                first_seen TEXT NOT NULL,
                last_seen  TEXT NOT NULL
            )""",
            # Outage explanations (v0.25.0, AI Tier 3): every run is kept (history);
            # the newest one for an outage is shown. kind = 'service' | 'host'.
            """CREATE TABLE IF NOT EXISTS ai_explanations (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                kind         TEXT NOT NULL,
                target_id    INTEGER NOT NULL,
                outage_start TEXT NOT NULL,
                facts        TEXT NOT NULL DEFAULT '[]',
                summary      TEXT,
                model        TEXT,
                ai_error     TEXT,
                created_at   TEXT DEFAULT (datetime('now'))
            )""",
            "CREATE INDEX IF NOT EXISTS idx_ai_explanations_target ON ai_explanations(kind, target_id)",
            # AI actions record (v0.26.0): each Do it (done/failed) and Cancel on a chat
            # action card. item = "host:<id>" | "service:<id>" | "subnet:<id>" | "other",
            # for keep-N-per-item. Kept and cleaned up by the AI history settings.
            """CREATE TABLE IF NOT EXISTS ai_action_log (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                item       TEXT NOT NULL DEFAULT 'other',
                action     TEXT NOT NULL,
                title      TEXT NOT NULL,
                detail     TEXT,
                result     TEXT NOT NULL,
                message    TEXT,
                model      TEXT,
                asked      TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            )""",
            # Daily digests that carried an AI summary (v0.25.0), for "Past digests".
            # Kept and cleaned up by the AI history settings (backend/ai_history.py).
            """CREATE TABLE IF NOT EXISTS ai_digests (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                title      TEXT NOT NULL,
                body       TEXT NOT NULL,
                summary    TEXT,
                model      TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            )""",
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
