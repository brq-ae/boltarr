import threading
import subprocess
import nmap
from .database import get_conn

# Keyed by run_id: {"status", "progress", "total", "error", "cancelled", "_proc"}
scan_jobs: dict[int, dict] = {}
_lock = threading.Lock()


def _run_nmap(args: list[str], job: dict) -> str | None:
    """Run nmap as a subprocess, storing the handle so it can be killed."""
    proc = subprocess.Popen(
        ["nmap"] + args + ["-oX", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    with _lock:
        job["_proc"] = proc
    stdout, _ = proc.communicate()
    with _lock:
        job["_proc"] = None
    if job.get("cancelled"):
        return None
    return stdout.decode("utf-8", errors="replace") if proc.returncode in (0, 1) else None


# ── Scan options → nmap args ──────────────────────────────────────────────────
# A scan is built from these options (a Standard scan = today's behaviour).
_DEFAULT_OPTS = {
    "ports": "top1000",   # none (discovery only) | top1000 | topN | all | custom
    "top_n": 100,         # for ports=topN  -> --top-ports N
    "port_range": "",     # for ports=custom -> -p <range>, e.g. "22,80,8000-8100"
    "sv": True,           # -sV service/version detection
    "version_intensity": 5,
    "os": True,           # -O OS detection
    "timing": "T4",       # T0..T5
    "pn": False,          # -Pn skip host discovery (scan hosts that block ping)
    "udp": False,         # -sU UDP scan
    "scripts": "",        # --script <...> NSE scripts
}


def norm_opts(opts: dict | None) -> dict:
    o = dict(_DEFAULT_OPTS)
    if opts:
        o.update({k: v for k, v in opts.items() if v is not None})
    return o


def _detail_args(o: dict) -> list[str]:
    """nmap args for a per-host detail scan (target appended by the caller)."""
    args = [f"-{o['timing']}"]
    if o["pn"]:
        args.append("-Pn")
    if o["udp"]:
        args.append("-sU")
    ports = o["ports"]
    if ports == "all":
        args.append("-p-")
    elif ports == "topN":
        args += ["--top-ports", str(int(o.get("top_n") or 100))]
    elif ports == "custom" and (o.get("port_range") or "").strip():
        args += ["-p", o["port_range"].strip()]
    # top1000 = nmap default (no -p flag)
    if o["sv"]:
        args.append("-sV")
        args += ["--version-intensity", str(int(o.get("version_intensity", 5)))]
    if o["os"]:
        args.append("-O")
    args.append("--open")
    scripts = (o.get("scripts") or "").strip()
    if scripts:
        args += ["--script", scripts]
    return args


def build_command(opts: dict | None, target: str = "") -> str:
    """The full nmap command string, for the UI preview. Mirrors what runs."""
    o = norm_opts(opts)
    tgt = [target] if target else []
    if o["ports"] == "none":
        return " ".join(["nmap", f"-{o['timing']}", "-sn"] + tgt)
    return " ".join(["nmap"] + _detail_args(o) + tgt)


def cancel_scan(run_id: int) -> bool:
    with _lock:
        job = scan_jobs.get(run_id)
        if not job or job["status"] in ("completed", "error", "cancelled"):
            return False
        job["cancelled"] = True
        proc = job.get("_proc")
    if proc:
        try:
            proc.kill()
        except Exception:
            pass
    return True


def _do_scan(run_id: int, cidr: str, opts: dict | None = None):
    o = norm_opts(opts)

    def update(status=None, progress=None, total=None, error=None):
        with _lock:
            job = scan_jobs[run_id]
            if status:              job["status"] = status
            if progress is not None: job["progress"] = progress
            if total is not None:   job["total"] = total
            if error:               job["error"] = error

    def is_cancelled():
        with _lock:
            return scan_jobs[run_id].get("cancelled", False)

    def mark_cancelled():
        with _lock:
            scan_jobs[run_id]["status"] = "cancelled"
        try:
            conn = get_conn()
            conn.execute("UPDATE scan_runs SET status='cancelled', completed_at=datetime('now') WHERE id=?", (run_id,))
            conn.commit()
            conn.close()
        except Exception:
            pass

    try:
        with _lock:
            job = scan_jobs[run_id]

        update(status="discovering", progress=0)

        xml = _run_nmap(["-sn", f"-{o['timing']}", "--min-parallelism", "10", cidr], job)
        if xml is None or is_cancelled():
            mark_cancelled()
            return

        nm = nmap.PortScanner()
        nm.analyse_nmap_xml_scan(xml)
        live_hosts = nm.all_hosts()

        update(total=len(live_hosts), status="scanning")

        conn = get_conn()

        # Record every discovered host from the discovery pass (basic info). This
        # makes a discovery-only "Quick" scan populate the host list, and ensures
        # hosts are logged even if their detail scan later fails.
        for ip in live_hosts:
            try:
                d_mac  = nm[ip].get("addresses", {}).get("mac")
                d_host = nm[ip].hostname() or None
                d_vend = list(nm[ip].get("vendor", {}).values())
                d_vend = d_vend[0] if d_vend else None
                arow = conn.execute("SELECT host_id FROM host_aliases WHERE ip=?", (ip,)).fetchone()
                if arow:
                    conn.execute("UPDATE hosts SET last_seen=datetime('now') WHERE id=?", (arow["host_id"],))
                else:
                    conn.execute("""
                        INSERT INTO hosts (ip, mac, hostname, vendor, last_seen)
                        VALUES (?, ?, ?, ?, datetime('now'))
                        ON CONFLICT(ip) DO UPDATE SET
                            mac       = COALESCE(excluded.mac, mac),
                            hostname  = COALESCE(excluded.hostname, hostname),
                            vendor    = COALESCE(excluded.vendor, vendor),
                            last_seen = excluded.last_seen,
                            source    = CASE WHEN excluded.mac IS NOT NULL THEN 'scanned' ELSE source END
                    """, (ip, d_mac, d_host, d_vend))
            except Exception:
                pass
        conn.commit()

        # "Quick" scan = discovery only; no per-host port scan.
        if o["ports"] == "none":
            conn.close()
            if is_cancelled():
                mark_cancelled(); return
            conn = get_conn()
            conn.execute("UPDATE scan_runs SET status='completed', completed_at=datetime('now'), hosts_found=? WHERE id=?",
                         (len(live_hosts), run_id))
            conn.commit(); conn.close()
            update(status="completed", progress=100)
            return

        scanned = 0
        for ip in live_hosts:
            if is_cancelled():
                break

            try:
                xml2 = _run_nmap(_detail_args(o) + [ip], job)
                if xml2 is None or is_cancelled():
                    break

                nm2 = nmap.PortScanner()
                nm2.analyse_nmap_xml_scan(xml2)

                if ip not in nm2.all_hosts():
                    scanned += 1
                    update(progress=int(scanned / max(len(live_hosts), 1) * 100))
                    continue

                addresses = nm2[ip].get("addresses", {})
                mac = addresses.get("mac")
                hostname = nm2[ip].hostname() or None

                os_guess = None
                osmatches = nm2[ip].get("osmatch", [])
                if osmatches:
                    os_guess = osmatches[0]["name"]

                vendor_dict = nm2[ip].get("vendor", {})
                vendor = list(vendor_dict.values())[0] if vendor_dict else None

                alias_row = conn.execute(
                    "SELECT host_id FROM host_aliases WHERE ip=?", (ip,)
                ).fetchone()

                if alias_row:
                    host_id = alias_row["host_id"]
                    conn.execute("UPDATE hosts SET last_seen=datetime('now') WHERE id=?", (host_id,))
                else:
                    conn.execute("""
                        INSERT INTO hosts (ip, mac, hostname, os_guess, vendor, last_seen)
                        VALUES (?, ?, ?, ?, ?, datetime('now'))
                        ON CONFLICT(ip) DO UPDATE SET
                            mac       = COALESCE(excluded.mac, mac),
                            hostname  = COALESCE(excluded.hostname, hostname),
                            os_guess  = COALESCE(excluded.os_guess, os_guess),
                            vendor    = COALESCE(excluded.vendor, vendor),
                            last_seen = excluded.last_seen,
                            source    = CASE WHEN excluded.mac IS NOT NULL THEN 'scanned' ELSE source END
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
                pass

            scanned += 1
            update(progress=int(scanned / max(len(live_hosts), 1) * 100))

        conn.close()

        if is_cancelled():
            mark_cancelled()
            return

        conn = get_conn()
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


def start_scan(run_id: int, cidr: str, opts: dict | None = None):
    with _lock:
        scan_jobs[run_id] = {"status": "starting", "progress": 0, "total": 0, "cancelled": False, "_proc": None}
    t = threading.Thread(target=_do_scan, args=(run_id, cidr, opts), daemon=True)
    t.start()


def _do_probe(run_id: int, ip: str, opts: dict | None = None):
    o = norm_opts(opts)

    def update(status=None, progress=None, error=None):
        with _lock:
            job = scan_jobs[run_id]
            if status:              job["status"] = status
            if progress is not None: job["progress"] = progress
            if error:               job["error"] = error

    try:
        with _lock:
            job = scan_jobs[run_id]

        update(status="scanning", progress=0)

        # A probe is always a per-host detail scan (never discovery-only).
        probe_o = dict(o)
        if probe_o["ports"] == "none":
            probe_o["ports"] = "top1000"
        xml = _run_nmap(_detail_args(probe_o) + [ip], job)
        if xml is None or job.get("cancelled"):
            with _lock:
                scan_jobs[run_id]["status"] = "cancelled"
            try:
                conn = get_conn()
                conn.execute("UPDATE scan_runs SET status='cancelled', completed_at=datetime('now') WHERE id=?", (run_id,))
                conn.commit()
                conn.close()
            except Exception:
                pass
            return

        nm = nmap.PortScanner()
        nm.analyse_nmap_xml_scan(xml)

        conn = get_conn()
        if ip in nm.all_hosts():
            addresses = nm[ip].get("addresses", {})
            mac = addresses.get("mac")
            hostname = nm[ip].hostname() or None

            os_guess = None
            osmatches = nm[ip].get("osmatch", [])
            if osmatches:
                os_guess = osmatches[0]["name"]

            vendor_dict = nm[ip].get("vendor", {})
            vendor = list(vendor_dict.values())[0] if vendor_dict else None

            conn.execute("""
                UPDATE hosts SET
                    mac       = COALESCE(?, mac),
                    hostname  = COALESCE(?, hostname),
                    os_guess  = COALESCE(?, os_guess),
                    vendor    = COALESCE(?, vendor),
                    last_seen = datetime('now'),
                    source    = CASE WHEN ? IS NOT NULL THEN 'scanned' ELSE source END
                WHERE ip=?
            """, (mac, hostname, os_guess, vendor, mac, ip))
            conn.commit()

            host_row = conn.execute("SELECT id FROM hosts WHERE ip=?", (ip,)).fetchone()
            if host_row:
                host_id = host_row["id"]
                for proto in nm[ip].all_protocols():
                    for port, svc in nm[ip][proto].items():
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

        conn.execute("""
            UPDATE scan_runs
            SET status='completed', completed_at=datetime('now'), hosts_found=1
            WHERE id=?
        """, (run_id,))
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


def start_probe(run_id: int, ip: str, opts: dict | None = None):
    with _lock:
        scan_jobs[run_id] = {"status": "starting", "progress": 0, "total": 1, "cancelled": False, "_proc": None}
    t = threading.Thread(target=_do_probe, args=(run_id, ip, opts), daemon=True)
    t.start()
