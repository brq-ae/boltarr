import threading
import nmap
from .database import get_conn

# Keyed by run_id: {"status": str, "progress": int, "total": int, "error": str}
scan_jobs: dict[int, dict] = {}
_lock = threading.Lock()


def _do_scan(run_id: int, cidr: str):
    def update(status=None, progress=None, total=None, error=None):
        with _lock:
            job = scan_jobs[run_id]
            if status:
                job["status"] = status
            if progress is not None:
                job["progress"] = progress
            if total is not None:
                job["total"] = total
            if error:
                job["error"] = error

    try:
        update(status="discovering", progress=0)

        nm = nmap.PortScanner()
        nm.scan(hosts=cidr, arguments="-sn -T4 --min-parallelism 10")
        live_hosts = nm.all_hosts()

        update(total=len(live_hosts), status="scanning")

        conn = get_conn()
        for i, ip in enumerate(live_hosts):
            try:
                nm2 = nmap.PortScanner()
                nm2.scan(hosts=ip, arguments="-sV -O --open -T4 --version-intensity 5")

                addresses = nm2[ip].get("addresses", {})
                mac = addresses.get("mac")
                hostname = nm2[ip].hostname() or None

                os_guess = None
                osmatches = nm2[ip].get("osmatch", [])
                if osmatches:
                    os_guess = osmatches[0]["name"]

                vendor_dict = nm2[ip].get("vendor", {})
                vendor = list(vendor_dict.values())[0] if vendor_dict else None

                # If this IP is a registered alias, update the primary host instead
                alias_row = conn.execute(
                    "SELECT host_id FROM host_aliases WHERE ip=?", (ip,)
                ).fetchone()

                if alias_row:
                    host_id = alias_row["host_id"]
                    conn.execute(
                        "UPDATE hosts SET last_seen=datetime('now') WHERE id=?", (host_id,)
                    )
                else:
                    conn.execute("""
                        INSERT INTO hosts (ip, mac, hostname, os_guess, vendor, last_seen)
                        VALUES (?, ?, ?, ?, ?, datetime('now'))
                        ON CONFLICT(ip) DO UPDATE SET
                            mac        = COALESCE(excluded.mac, mac),
                            hostname   = COALESCE(excluded.hostname, hostname),
                            os_guess   = COALESCE(excluded.os_guess, os_guess),
                            vendor     = COALESCE(excluded.vendor, vendor),
                            last_seen  = excluded.last_seen
                    """, (ip, mac, hostname, os_guess, vendor))
                    row = conn.execute("SELECT id FROM hosts WHERE ip=?", (ip,)).fetchone()
                    host_id = row["id"]
                conn.commit()

                for proto in nm2[ip].all_protocols():
                    for port, svc in nm2[ip][proto].items():
                        conn.execute("""
                            INSERT INTO ports (host_id, port, protocol, state, service, version)
                            VALUES (?, ?, ?, ?, ?, ?)
                            ON CONFLICT(host_id, port, protocol) DO UPDATE SET
                                state   = excluded.state,
                                service = excluded.service,
                                version = excluded.version
                        """, (host_id, port, proto, svc["state"],
                              svc.get("name"), svc.get("version") or None))
                conn.commit()

            except Exception:
                pass  # single host failure shouldn't kill the whole scan

            update(progress=int((i + 1) / max(len(live_hosts), 1) * 100))

        conn.execute("""
            UPDATE scan_runs
            SET status='completed', completed_at=datetime('now'), hosts_found=?
            WHERE id=?
        """, (len(live_hosts), run_id))
        conn.commit()
        conn.close()
        update(status="completed", progress=100)

    except Exception as e:
        with _lock:
            scan_jobs[run_id]["status"] = "error"
            scan_jobs[run_id]["error"] = str(e)
        try:
            conn = get_conn()
            conn.execute("UPDATE scan_runs SET status='error' WHERE id=?", (run_id,))
            conn.commit()
            conn.close()
        except Exception:
            pass


def start_scan(run_id: int, cidr: str):
    with _lock:
        scan_jobs[run_id] = {"status": "starting", "progress": 0, "total": 0}
    t = threading.Thread(target=_do_scan, args=(run_id, cidr), daemon=True)
    t.start()
