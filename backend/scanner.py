import json
import os
import re
import signal
import threading
import subprocess
import nmap
from .database import get_conn
from . import changes
from .host_fields import scan_update_sql

# Keyed by run_id: {"kind", "status", "progress", "total", "error", "cancelled", "_proc", "problems"}
scan_jobs: dict[int, dict] = {}
_lock = threading.Lock()
FINAL = ("completed", "error", "cancelled")
# Scheduled scans waiting for the one before them (F-34: one scan at a time):
# [(run_id, target, opts)], started in order by _pump().
_queue: list[tuple[int, str, dict | None]] = []


class ScanBusy(RuntimeError):
    """Another scan is running (or waiting) — a manual scan is refused (F-34)."""


class NmapError(RuntimeError):
    """nmap stopped with an error; the message is what nmap said."""


class _Cancelled(Exception):
    pass


_TIMEDOUT_RE = re.compile(r'<host\b[^>]*\btimedout="true"')


def _nmap_error_text(stderr: bytes, code: int) -> str:
    lines = [ln.strip() for ln in stderr.decode("utf-8", errors="replace").splitlines() if ln.strip()]
    lines = [ln for ln in lines if not ln.startswith(("See the output of nmap -h", "Starting Nmap", "Nmap done"))]
    text = " · ".join(lines[-3:])[:300]
    return text or f"nmap stopped with code {code}"


def _run_nmap(args: list[str], job: dict) -> str:
    """Run nmap and return its XML. Raises _Cancelled when Stop was pressed and
    NmapError (with nmap's own words) when it failed (F-34)."""
    proc = subprocess.Popen(
        ["nmap"] + args + ["-oX", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=True,           # own process group: Stop ends any helpers nmap started too
    )
    with _lock:
        job["_proc"] = proc
    stdout, stderr = proc.communicate()
    with _lock:
        job["_proc"] = None
    if job.get("cancelled"):
        raise _Cancelled()
    out = stdout.decode("utf-8", errors="replace")
    if "</nmaprun>" not in out:            # no complete result: a real failure (nmap warns with code 1 too)
        raise NmapError(_nmap_error_text(stderr, proc.returncode))
    return out


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
    "host_timeout": 15,   # minutes per host before nmap gives up on it (0 = no limit) (F-34)
}


class ScanOptionError(ValueError):
    """A scan option or target that could make nmap do something else (F-14)."""


_PORT_MODES = {"none", "top1000", "topN", "all", "custom"}
_TIMING_RE  = re.compile(r"T[0-5]")
_RANGE_RE   = re.compile(r"[0-9TUSP:,\-]+")            # nmap -p syntax: 22,80,8000-8100 or T:80,U:53
_SCRIPTS_RE = re.compile(r"[A-Za-z0-9_\-,*() ]+")      # NSE names / categories / expressions, no file paths
_TARGET_RE  = re.compile(r"[A-Za-z0-9:][A-Za-z0-9.:/\-]*")   # IP, CIDR, range or hostname, never an option


def check_target(t: str) -> str:
    """One nmap target (IP, CIDR, a1-b range or hostname). Anything that could be
    read as an nmap option (starts with '-', has spaces or '=') is refused."""
    t = (t or "").strip()
    if not t or len(t) > 255 or not _TARGET_RE.fullmatch(t):
        raise ScanOptionError(f"Not a valid scan target: {t[:60]!r}")
    return t


def check_opts(opts: dict | None) -> dict:
    """norm_opts + refuse values the screens never send (they'd reach nmap as extra options)."""
    o = norm_opts(opts)
    if not isinstance(o["timing"], str) or not _TIMING_RE.fullmatch(o["timing"]):
        raise ScanOptionError("Timing must be T0 to T5.")
    if o["ports"] not in _PORT_MODES:
        raise ScanOptionError(f"Unknown ports choice: {str(o['ports'])[:30]!r}")
    pr = (o.get("port_range") or "").strip()
    if pr and (len(pr) > 500 or not _RANGE_RE.fullmatch(pr)):
        raise ScanOptionError("Port range may only use numbers, commas and dashes (e.g. 22,80,8000-8100).")
    sc = (o.get("scripts") or "").strip()
    if sc and (len(sc) > 300 or sc.startswith("-") or not _SCRIPTS_RE.fullmatch(sc)):
        raise ScanOptionError("Scripts may only be NSE script names or categories (e.g. default,vuln), no file paths.")
    for key, lo, hi in (("top_n", 1, 65535), ("version_intensity", 0, 9), ("host_timeout", 0, 1440)):
        try:
            v = int(o.get(key) if o.get(key) is not None else _DEFAULT_OPTS[key])
        except (TypeError, ValueError):
            raise ScanOptionError(f"{key} must be a number.")
        if not lo <= v <= hi:
            raise ScanOptionError(f"{key} must be between {lo} and {hi}.")
        o[key] = v
    for key in ("sv", "os", "pn", "udp"):
        o[key] = bool(o[key])
    return o


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
    if int(o.get("host_timeout") or 0) > 0:
        args += ["--host-timeout", f"{int(o['host_timeout'])}m"]
    scripts = (o.get("scripts") or "").strip()
    if scripts:
        args += ["--script", scripts]
    return args


def _discovery_args(o: dict) -> list[str]:
    """The ping sweep. --min-parallelism speeds it up, but T0–T2 cap nmap at one
    probe at a time and nmap refuses the pair — those scans used to fail and
    show as 'cancelled' — so it's only added for T3–T5."""
    args = ["-sn", f"-{o['timing']}"]
    if o["timing"] in ("T3", "T4", "T5"):
        args += ["--min-parallelism", "10"]
    return args


def build_command(opts: dict | None, target: str = "") -> str:
    """The full nmap command string, for the UI preview. Mirrors what runs."""
    o = norm_opts(opts)
    tgt = [target] if target else []
    if o["ports"] == "none":
        return " ".join(["nmap", f"-{o['timing']}", "-sn"] + tgt)
    return " ".join(["nmap"] + _detail_args(o) + tgt)


def _active(kind: str | None = None) -> list[int]:
    """Run ids of jobs still going (caller holds _lock), optionally only scans or probes."""
    return [rid for rid, j in scan_jobs.items()
            if j.get("status") not in FINAL and (kind is None or j.get("kind") == kind)]


def scan_busy() -> bool:
    """True while a scan runs or waits in line (one scan at a time, F-34)."""
    with _lock:
        return bool(_active("scan") or _queue)


def anything_running() -> bool:
    """Any scan or probe running or waiting (restore must not happen meanwhile)."""
    with _lock:
        return bool(_active() or _queue)


def probe_running(ip: str) -> bool:
    with _lock:
        return any(j.get("kind") == "probe" and j.get("ip") == ip and j.get("status") not in FINAL
                   for j in scan_jobs.values())


def is_subnet_scanning(subnet_id) -> bool:
    """True if a scan of this subnet is running or waiting its turn."""
    with get_conn() as conn:
        rows = conn.execute("SELECT id FROM scan_runs WHERE subnet_id=? AND status IN ('running', 'queued')",
                            (subnet_id,)).fetchall()
    with _lock:
        queued = {q[0] for q in _queue}
        for r in rows:
            job = scan_jobs.get(r["id"])
            if r["id"] in queued or (job and job.get("status") not in FINAL):
                return True
    return False


def reconcile_orphaned_runs() -> None:
    """A fresh process means any 'running' scan_runs died with the old one, and
    waiting ones never started."""
    with get_conn() as conn:
        conn.execute("UPDATE scan_runs SET status='error', note=COALESCE(note,'interrupted'), "
                     "completed_at=COALESCE(completed_at, datetime('now')) WHERE status='running'")
        conn.execute("UPDATE scan_runs SET status='cancelled', note='Boltarr restarted before it could start', "
                     "completed_at=COALESCE(completed_at, datetime('now')) WHERE status='queued'")
        conn.commit()


RUNS_KEEP_DAYS = 90          # scan history
SKIPPED_KEEP_DAYS = 7        # "skipped" rows (a schedule's run that didn't happen) go sooner


def prune_runs() -> int:
    """Drop old scan history, daily from the monitor loop (F-42). Hosts, ports
    and change history are untouched; a change whose run is gone still shows."""
    with get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM scan_runs WHERE status NOT IN ('running', 'queued') AND ("
            "  COALESCE(completed_at, started_at) < datetime('now', ?) OR "
            "  (status='skipped' AND COALESCE(completed_at, started_at) < datetime('now', ?)))",
            (f"-{RUNS_KEEP_DAYS} days", f"-{SKIPPED_KEEP_DAYS} days"))
        conn.commit()
        return cur.rowcount


def _kill(proc) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)     # nmap and anything it started
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def cancel_scan(run_id: int) -> bool:
    queued = False
    with _lock:
        for i, q in enumerate(_queue):
            if q[0] == run_id:
                _queue.pop(i)
                queued = True
                break
        if not queued:
            job = scan_jobs.get(run_id)
            if not job or job["status"] in FINAL:
                return False
            job["cancelled"] = True
            proc = job.get("_proc")
    if queued:
        with get_conn() as conn:
            conn.execute("UPDATE scan_runs SET status='cancelled', note='stopped before it started', "
                         "completed_at=datetime('now') WHERE id=?", (run_id,))
            conn.commit()
        return True
    if proc:
        _kill(proc)
    return True


JOB_KEEP_SECONDS = 3600


def _prune_jobs() -> None:
    """Forget finished jobs after an hour (their result is in scan_runs) — F-42.
    Caller holds _lock."""
    import time
    now = time.monotonic()
    for rid in [rid for rid, j in scan_jobs.items()
                if j.get("status") in FINAL and now - j.get("_done", now) > JOB_KEEP_SECONDS]:
        del scan_jobs[rid]


def _set(run_id: int, **kw) -> None:
    import time
    with _lock:
        job = scan_jobs[run_id]
        for k, v in kw.items():
            if v is not None:
                job[k] = v
        if job.get("status") in FINAL and "_done" not in job:
            job["_done"] = time.monotonic()


# ── Saving one address's result (scans and probes share this) ─────────────────

def _open_tcp(h) -> set[int]:
    return {port for proto in h.all_protocols() if proto == "tcp"
            for port, svc in h[proto].items() if svc["state"] == "open"}


def _main_open(conn, host_id) -> set[int]:
    return {r["port"] for r in conn.execute(
        "SELECT port FROM ports WHERE host_id=? AND protocol='tcp' AND state='open'", (host_id,))}


def _alias_open(conn, alias_id) -> set[int]:
    return {r["port"] for r in conn.execute(
        "SELECT port FROM alias_ports WHERE alias_id=? AND protocol='tcp' AND state='open'", (alias_id,))}


def _upsert_ports(conn, table: str, key_col: str, key, h) -> None:
    for proto in h.all_protocols():
        for port, svc in h[proto].items():
            conn.execute(f"""
                INSERT INTO {table} ({key_col}, port, protocol, state, service, version)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT({key_col}, port, protocol) DO UPDATE SET
                    state   = excluded.state,
                    service = excluded.service,
                    version = excluded.version
            """, (key, port, proto, svc["state"], svc.get("name"), svc.get("version") or None))


def _save_detail(conn, ip: str, nm, o: dict, run_id: int, new_ips: set, *,
                 probe: bool = False) -> bool:
    """Save one address's detail-scan result: host facts, ports, change events.
    Returns True if nmap reported the address.

    A host's main address keeps its ports in `ports`; a second address (alias)
    in `alias_ports`, compared only with itself (F-24). A brand-new device gets
    one 'new device' event listing its ports, not one event per port (F-42)."""
    scanned = changes.scanned_ports(o)
    alias = conn.execute("SELECT id, host_id, ports_tracked FROM host_aliases WHERE ip=?", (ip,)).fetchone()

    if ip not in nm.all_hosts():
        # Scan: up in discovery but nothing open in range → its open in-range ports closed.
        # Probe / -Pn: can't tell "nothing open" from "not there", so leave it as it was.
        if probe or o.get("pn"):
            return False
        if alias:
            if alias["ports_tracked"]:
                changes.record_ports(conn, ip, alias["host_id"], _alias_open(conn, alias["id"]), set(), scanned,
                                     run_id=run_id, alias_id=alias["id"])
        else:
            hr = conn.execute("SELECT id FROM hosts WHERE ip=?", (ip,)).fetchone()
            if hr:
                changes.record_ports(conn, ip, hr["id"], _main_open(conn, hr["id"]), set(), scanned, run_id=run_id)
        conn.commit()
        return False

    h = nm[ip]
    mac = h.get("addresses", {}).get("mac")
    hostname = h.hostname() or None
    osm = h.get("osmatch", [])
    os_guess = osm[0]["name"] if osm else None
    vd = h.get("vendor", {})
    vendor = list(vd.values())[0] if vd else None
    new_open = _open_tcp(h)

    if alias:
        conn.execute("UPDATE hosts SET last_seen=datetime('now') WHERE id=?", (alias["host_id"],))
        conn.execute("UPDATE host_aliases SET online=1, miss_count=0, last_seen=datetime('now'), ports_tracked=1 "
                     "WHERE id=?", (alias["id"],))
        if alias["ports_tracked"]:   # the first look at an address on its own is the baseline, not "opened"
            changes.record_ports(conn, ip, alias["host_id"], _alias_open(conn, alias["id"]), new_open, scanned,
                                 run_id=run_id, alias_id=alias["id"])
        _upsert_ports(conn, "alias_ports", "alias_id", alias["id"], h)
        conn.commit()
        return True

    existing = conn.execute("SELECT id, mac, net_hostname FROM hosts WHERE ip=?", (ip,)).fetchone()
    if probe and not existing:
        return False
    if probe:   # a rename is what the network reports changing, not a name you typed (F-20)
        changes.record_meta(conn, ip, True, existing["mac"], mac, existing["net_hostname"], hostname, run_id=run_id)
    elif not existing:              # -Pn found a device that discovery didn't list
        changes.record_meta(conn, ip, False, None, mac, None, hostname, run_id=run_id)
        new_ips.add(ip)
    conn.execute(f"""
        INSERT INTO hosts (ip, mac, hostname, net_hostname, os_guess, net_os, vendor, net_vendor, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(ip) DO UPDATE SET
            mac       = COALESCE(excluded.mac, mac),
            {scan_update_sql("hostname")},
            {scan_update_sql("os_guess")},
            {scan_update_sql("vendor")},
            last_seen = excluded.last_seen,
            source    = CASE WHEN excluded.mac IS NOT NULL THEN 'scanned' ELSE source END
    """, (ip, mac, hostname, hostname, os_guess, os_guess, vendor, vendor))
    host_id = conn.execute("SELECT id FROM hosts WHERE ip=?", (ip,)).fetchone()["id"]
    if ip in new_ips:
        changes.note_new_host_ports(conn, ip, new_open, run_id)
    else:
        changes.record_ports(conn, ip, host_id, _main_open(conn, host_id), new_open, scanned, run_id=run_id)
    _upsert_ports(conn, "ports", "host_id", host_id, h)
    conn.commit()
    return True


def _record_discovered(conn, ip: str, nm, run_id: int, new_ips: set) -> None:
    """Discovery pass: log the host (basic facts) so a Quick scan fills the list
    and a host is kept even if its detail scan fails later."""
    d_mac = nm[ip].get("addresses", {}).get("mac")
    d_host = nm[ip].hostname() or None
    d_vend = list(nm[ip].get("vendor", {}).values())
    d_vend = d_vend[0] if d_vend else None
    arow = conn.execute("SELECT host_id FROM host_aliases WHERE ip=?", (ip,)).fetchone()
    existing = conn.execute("SELECT mac, net_hostname FROM hosts WHERE ip=?", (ip,)).fetchone()
    if existing is None and arow is None:
        new_ips.add(ip)
    changes.record_meta(conn, ip, existed=(existing is not None or arow is not None),
                        old_mac=(existing["mac"] if existing else None), new_mac=d_mac,
                        old_host=(existing["net_hostname"] if existing else None), new_host=d_host,
                        run_id=run_id)
    if arow:
        conn.execute("UPDATE hosts SET last_seen=datetime('now') WHERE id=?", (arow["host_id"],))
        conn.execute("UPDATE host_aliases SET online=1, miss_count=0, last_seen=datetime('now') "
                     "WHERE ip=?", (ip,))
    else:
        conn.execute(f"""
            INSERT INTO hosts (ip, mac, hostname, net_hostname, vendor, net_vendor, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(ip) DO UPDATE SET
                mac       = COALESCE(excluded.mac, mac),
                {scan_update_sql("hostname")},
                {scan_update_sql("vendor")},
                last_seen = excluded.last_seen,
                source    = CASE WHEN excluded.mac IS NOT NULL THEN 'scanned' ELSE source END
        """, (ip, d_mac, d_host, d_host, d_vend, d_vend))


PN_MAX_ADDRESSES = 4096
_ADDR_RE = re.compile(r'<address addr="([^"]+)" addrtype="ipv[46]"')


def _list_targets(targets: list[str], job: dict) -> list[str]:
    """-Pn on a subnet: every address in the targets, without pinging (nmap -sL
    lists them, sending nothing). A subnet's network and broadcast addresses are
    left out."""
    import ipaddress
    xml = _run_nmap(["-sL", "-n"] + targets, job)
    skip = set()
    for t in targets:
        try:
            net = ipaddress.ip_network(t, strict=False)
        except ValueError:
            continue
        if net.version == 4 and net.prefixlen <= 30:
            skip |= {str(net.network_address), str(net.broadcast_address)}
    out, seen = [], set()
    for a in _ADDR_RE.findall(xml):
        if a not in skip and a not in seen:
            seen.add(a)
            out.append(a)
    if len(out) > PN_MAX_ADDRESSES:
        raise NmapError(f"'Skip host discovery' would scan {len(out)} addresses one by one — "
                        f"pick a smaller range (at most {PN_MAX_ADDRESSES}) or turn that option off.")
    return out


# ── Scans ──────────────────────────────────────────────────────────────────────

def _do_scan(run_id: int, cidr: str, opts: dict | None = None):
    problems: list[dict] = []
    found = 0

    def finish(status: str, note: str | None = None):
        _set(run_id, status=status, error=note if status == "error" else None, problems=len(problems),
             progress=100 if status == "completed" else None)
        try:
            with get_conn() as c:
                c.execute("UPDATE scan_runs SET status=?, completed_at=datetime('now'), note=COALESCE(?, note), "
                          "problems=?, hosts_found=CASE WHEN ?='completed' THEN ? ELSE hosts_found END WHERE id=?",
                          (status, note, json.dumps(problems) if problems else None, status, found, run_id))
                c.commit()
        except Exception:
            pass

    try:
        with _lock:
            job = scan_jobs[run_id]
        o = check_opts(opts)                         # again here: saved profiles and schedules too
        targets = [check_target(t) for t in cidr.split()]
        _set(run_id, status="discovering", progress=0)

        # `cidr` is one CIDR or a space-separated list of IPs (host-filtered schedules).
        # -Pn (F-34): no ping sweep — every address gets the port scan, and only
        # addresses that answer are recorded.
        pn = o["pn"] and o["ports"] != "none"
        new_ips: set = set()
        if pn:
            live_hosts = _list_targets(targets, job)
        else:
            nm = nmap.PortScanner()
            nm.analyse_nmap_xml_scan(_run_nmap(_discovery_args(o) + targets, job))
            live_hosts = nm.all_hosts()
        _set(run_id, total=len(live_hosts), status="scanning")

        conn = get_conn()
        try:
            if not pn:
                for ip in live_hosts:
                    try:
                        _record_discovered(conn, ip, nm, run_id, new_ips)
                    except Exception as e:
                        problems.append({"ip": ip, "error": f"couldn't save it: {e}"[:300]})
                conn.commit()
                found = len(live_hosts)
            if o["ports"] == "none":                 # "Quick" scan = discovery only
                finish("completed", _problem_note(problems, len(live_hosts)))
                _summary(run_id, cidr)
                return

            for i, ip in enumerate(live_hosts):
                if job.get("cancelled"):
                    raise _Cancelled()
                try:
                    xml2 = _run_nmap(_detail_args(o) + [ip], job)
                    if _TIMEDOUT_RE.search(xml2):
                        problems.append({"ip": ip, "error": f"took longer than {o['host_timeout']} min, so it was "
                                                            "skipped — its ports were left as they were"})
                    else:
                        nm2 = nmap.PortScanner()
                        nm2.analyse_nmap_xml_scan(xml2)
                        if _save_detail(conn, ip, nm2, o, run_id, new_ips) and pn:
                            found += 1
                except (_Cancelled, ScanOptionError):
                    raise
                except NmapError as e:
                    problems.append({"ip": ip, "error": str(e)})
                except Exception as e:           # one bad host never stops the rest
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                    problems.append({"ip": ip, "error": f"couldn't read or save the result: {e}"[:300]})
                _set(run_id, progress=int((i + 1) / max(len(live_hosts), 1) * 100), problems=len(problems))
        finally:
            conn.close()

        finish("completed", _problem_note(problems, len(live_hosts)))
        _summary(run_id, cidr)

    except _Cancelled:
        finish("cancelled")
    except NmapError as e:
        finish("error", f"nmap failed: {e}"[:300])
    except Exception as e:
        finish("error", str(e)[:300])
    finally:
        _pump()                                     # start the next scan waiting in line


def _problem_note(problems: list, total: int) -> str | None:
    if not problems:
        return None
    n = len(problems)
    return f"completed with problems — {n} of {total} host{'s' if total != 1 else ''} couldn't be scanned"


def _summary(run_id: int, label: str) -> None:
    try:
        changes.send_scan_summary(run_id, label)
    except Exception:
        pass


def _launch(run_id: int, cidr: str, opts: dict | None) -> None:
    """Caller holds _lock."""
    _prune_jobs()
    scan_jobs[run_id] = {"kind": "scan", "status": "starting", "progress": 0, "total": 0,
                         "cancelled": False, "_proc": None, "problems": 0}
    threading.Thread(target=_do_scan, args=(run_id, cidr, opts), daemon=True).start()


BUSY_MESSAGE = "A scan is already running — wait for it to finish (or stop it), then try again."


def start_scan(run_id: int, cidr: str, opts: dict | None = None):
    """Start a scan now (manual). One scan at a time: raises ScanBusy if another
    scan is running or waiting (F-34)."""
    with _lock:
        if _active("scan") or _queue:
            raise ScanBusy(BUSY_MESSAGE)
        _launch(run_id, cidr, opts)


def queue_scan(run_id: int, cidr: str, opts: dict | None = None) -> bool:
    """Scheduled scans: start now if nothing is scanning, else wait in line and
    start when the one before finishes. True = started now. The caller has
    stored the run as 'queued'."""
    with _lock:
        if _active("scan") or _queue:
            _queue.append((run_id, cidr, opts))
            return False
        _launch(run_id, cidr, opts)
    with get_conn() as conn:
        conn.execute("UPDATE scan_runs SET status='running' WHERE id=? AND status='queued'", (run_id,))
        conn.commit()
    return True


def _pump() -> None:
    """Start the next waiting scan, if nothing else is scanning."""
    with _lock:
        if _active("scan") or not _queue:
            return
        run_id, cidr, opts = _queue.pop(0)
        _launch(run_id, cidr, opts)
    try:
        with get_conn() as conn:
            conn.execute("UPDATE scan_runs SET status='running', started_at=datetime('now') WHERE id=?", (run_id,))
            conn.commit()
    except Exception:
        pass


def queued_runs() -> list[int]:
    with _lock:
        return [q[0] for q in _queue]


# ── Probes (one host) ──────────────────────────────────────────────────────────

def _do_probe(run_id: int, ip: str, opts: dict | None = None):
    def finish(status, note=None, found=0):
        _set(run_id, status=status, error=note if status == "error" else None,
             progress=100 if status == "completed" else None)
        try:
            with get_conn() as c:
                c.execute("UPDATE scan_runs SET status=?, completed_at=datetime('now'), note=COALESCE(?, note), "
                          "hosts_found=? WHERE id=?", (status, note, found, run_id))
                c.commit()
        except Exception:
            pass

    try:
        with _lock:
            job = scan_jobs[run_id]
        o = check_opts(opts)
        ip = check_target(ip)
        _set(run_id, status="scanning", progress=0)

        # A probe is always a per-host detail scan (never discovery-only).
        probe_o = dict(o)
        if probe_o["ports"] == "none":
            probe_o["ports"] = "top1000"
        xml = _run_nmap(_detail_args(probe_o) + [ip], job)
        if _TIMEDOUT_RE.search(xml):
            raise NmapError(f"took longer than {probe_o['host_timeout']} min, so nmap gave up — nothing was changed")
        nm = nmap.PortScanner()
        nm.analyse_nmap_xml_scan(xml)
        conn = get_conn()
        try:
            found = _save_detail(conn, ip, nm, probe_o, run_id, set(), probe=True)
        finally:
            conn.close()
        _summary(run_id, ip)
        finish("completed", found=1 if found else 0)

    except _Cancelled:
        finish("cancelled")
    except NmapError as e:
        finish("error", f"nmap failed: {e}"[:300])
    except Exception as e:
        finish("error", str(e)[:300])


def start_probe(run_id: int, ip: str, opts: dict | None = None):
    """Probe one address. Runs alongside a scan; one probe per address at a time."""
    with _lock:
        if any(j.get("kind") == "probe" and j.get("ip") == ip and j.get("status") not in FINAL
               for j in scan_jobs.values()):
            raise ScanBusy(f"{ip} is already being probed.")
        _prune_jobs()
        scan_jobs[run_id] = {"kind": "probe", "ip": ip, "status": "starting", "progress": 0, "total": 1,
                             "cancelled": False, "_proc": None}
        threading.Thread(target=_do_probe, args=(run_id, ip, opts), daemon=True).start()
