import os
import hashlib
import re
import uuid
import io
import json
import ipaddress
import zipfile
import tempfile
import sqlite3 as _sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Literal, Optional


from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import StreamingResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .database import init_db, get_conn
from .scanner import start_scan, scan_jobs, cancel_scan, start_probe, build_command
from .config import get_config, get_llm_config, get_notifications_config, save_config, invalidate_config_cache
from . import notify
from . import monitor
from . import liveness
from . import scheduler
from . import auth
from . import security
from . import dhcp_check
from .changes import classify_host
from .llm import (
    list_models, generate, chat, chat_stream, is_configured, get_default_model,
    build_host_prompt, build_network_prompt, infer_device_type, LLMError, LONG_TIMEOUT,
)

APP_VERSION = (Path(__file__).parent.parent / "VERSION").read_text().strip()

app = FastAPI(title="Boltarr", version=APP_VERSION)

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


@app.on_event("startup")
def startup():
    from .config import CONFIG_PATH
    fresh = not CONFIG_PATH.exists()
    init_db()
    if fresh:
        with get_conn() as conn:
            empty = not conn.execute("SELECT 1 FROM hosts UNION ALL SELECT 1 FROM subnets LIMIT 1").fetchone()
        if empty:   # brand-new install: ask for an admin password first
            cfg = get_config()
            cfg["auth"]["setup_pending"] = True
            auth.ensure_secret(cfg)
            save_config(cfg)
    # BOLTARR_DISABLE_LOOPS skips the background probe/scan loops — for a preview
    # instance with sample data (so it isn't marked all-down against fake IPs).
    if os.environ.get("BOLTARR_DISABLE_LOOPS", "").lower() not in ("1", "true", "yes"):
        monitor.start_monitor()
        liveness.start_liveness()
        scheduler.start_scheduler()


@app.get("/api/version")
def get_version():
    return {"version": APP_VERSION}


# ── Login gate ────────────────────────────────────────────────────────────────

@app.middleware("http")
async def login_gate(request: Request, call_next):
    path = request.url.path
    a = auth.auth_config()
    gated = auth.login_required(a)
    if gated and path not in auth.OPEN_PATHS and not path.startswith(auth.OPEN_PREFIXES):
        if a.get("setup_pending") and not a.get("password_hash"):
            if path.startswith("/api/"):
                return JSONResponse({"detail": "Create an admin password first"}, status_code=401)
            return RedirectResponse("/login.html", status_code=303)
        if not auth.current_user(a, request):
            if path.startswith("/api/"):
                return JSONResponse({"detail": "Login required"}, status_code=401)
            return RedirectResponse("/login.html", status_code=303)
    # Forged cross-site requests: changes must come from Boltarr's own pages
    # (the browser's own security reports can't carry the header)
    if (gated and path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS")
            and auth.CSRF_HEADER not in request.headers and path != security.REPORT_PATH):
        return JSONResponse({"detail": "Missing X-Boltarr header"}, status_code=403)
    return await call_next(request)


# Registered after login_gate, so it wraps it: redirects and 401s get the headers too.
@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    for k, v in security.headers_for(get_config()["security"].get("frame_origins", "")).items():
        resp.headers.setdefault(k, v)
    # Caching. The pages (index/login) are always re-checked. They link every
    # script/style as file?v=<fingerprint of its contents>, so those URLs can be
    # kept by the browser for good: a changed file gets a new URL. Anything else
    # of ours (fetched without ?v=) is re-checked on each load (a cheap 304).
    path = request.url.path
    if not path.startswith("/api/") and "cache-control" not in resp.headers:
        if request.query_params.get("v") and resp.status_code == 200:
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        elif not path.startswith("/vendor/"):
            resp.headers["Cache-Control"] = "no-cache"
    return resp


# ── Pages with fingerprinted asset links ─────────────────────────────────────

_ASSET_RE = re.compile(r'((?:src|href)=")(/(?:js|css|vendor)/[^"?#]+)(")')
_fingerprints: dict = {}


def _fingerprint(rel: str) -> str:
    """Short hash of a frontend file's contents, cached until the file changes."""
    f = (FRONTEND_DIR / rel.lstrip("/")).resolve()
    try:
        st = f.stat()
    except OSError:
        return ""
    key = (str(f), st.st_mtime_ns, st.st_size)
    if key not in _fingerprints:
        _fingerprints[key] = hashlib.sha1(f.read_bytes()).hexdigest()[:10]
    return _fingerprints[key]


_pages: dict = {}


def _page(name: str, request: Request) -> Response:
    src = FRONTEND_DIR / name
    raw = src.read_text(encoding="utf-8")
    key = (name, src.stat().st_mtime_ns,
           tuple(_fingerprint(m[2]) for m in _ASSET_RE.finditer(raw)))   # rebuilt only when a file changed
    if key not in _pages:
        for k in [k for k in _pages if k[0] == name]:      # drop this page's old copy
            del _pages[k]
        html = _ASSET_RE.sub(lambda m: f"{m[1]}{m[2]}?v={_fingerprint(m[2])}{m[3]}" if _fingerprint(m[2]) else m[0], raw)
        _pages[key] = (html, '"' + hashlib.sha1(html.encode()).hexdigest()[:16] + '"')
    html, etag = _pages[key]
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    return Response(html, media_type="text/html; charset=utf-8", headers={"ETag": etag})


@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
def index_page(request: Request):
    return _page("index.html", request)


@app.get("/login.html", include_in_schema=False)
def login_page(request: Request):
    return _page("login.html", request)


@app.post("/api/csp-report", status_code=204)
async def csp_report(request: Request):
    """Where browsers send security-policy reports. Open (the login page reports
    too), size-capped, and stored de-duplicated with a row cap."""
    body = await request.body()
    security.record(security.parse_reports(body))
    return Response(status_code=204)


@app.get("/api/security/reports")
def get_security_reports():
    return security.list_reports()


@app.delete("/api/security/reports")
def clear_security_reports():
    security.clear_reports()
    return {"ok": True}


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "?"


def _set_session_cookie(resp, request: Request, a: dict):
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "") == "https"
    resp.set_cookie(auth.COOKIE, auth.make_session(a), max_age=int(a.get("session_days") or 30) * 86400,
                    httponly=True, samesite="lax", secure=secure, path="/")


class LoginIn(BaseModel):
    username: str = ""
    password: str


class SetupIn(BaseModel):
    username: str = "admin"
    password: str


class PasswordChangeIn(BaseModel):
    current: str
    new: str


class DisableLoginIn(BaseModel):
    password: str


class AuthSettingsIn(BaseModel):
    trust_proxy:     Optional[bool] = None
    proxy_header:    Optional[str]  = None
    trusted_proxies: Optional[str]  = None


def _check_new_password(pw: str):
    if len(pw or "") < auth.MIN_PASSWORD:
        raise HTTPException(422, f"Password must be at least {auth.MIN_PASSWORD} characters")


@app.get("/api/auth/status")
def auth_status(request: Request):
    a = auth.auth_config()
    on = bool(a.get("enabled") and a.get("password_hash"))
    client = _client_ip(request)
    via_proxy = bool(on and auth.proxy_user(a, client, request.headers))
    user = auth.current_user(a, request) if on else None
    return {"enabled": on, "setup_pending": bool(a.get("setup_pending") and not a.get("password_hash")),
            "logged_in": bool(user), "username": user, "via_proxy": via_proxy}


@app.post("/api/auth/login")
def auth_login(data: LoginIn, request: Request):
    a = auth.auth_config()
    if not (a.get("enabled") and a.get("password_hash")):
        raise HTTPException(400, "Login is not turned on")
    ip = _client_ip(request)
    wait = auth.retry_after(ip)
    if wait:
        raise HTTPException(429, f"Too many wrong tries — wait {wait} seconds", headers={"Retry-After": str(wait)})
    name_ok = not data.username.strip() or data.username.strip() == a.get("username")
    if not (auth.verify_password(data.password, a["password_hash"]) and name_ok):
        auth.record_failure(ip)
        raise HTTPException(401, "Wrong username or password")
    auth.record_success(ip)
    resp = JSONResponse({"ok": True, "username": a.get("username")})
    _set_session_cookie(resp, request, a)
    return resp


@app.post("/api/auth/logout")
def auth_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE, path="/")
    return resp


@app.post("/api/auth/setup")
def auth_setup(data: SetupIn, request: Request):
    """Set the first password (fresh install, or turning login on in Settings)."""
    if auth.auth_config().get("password_hash"):
        raise HTTPException(409, "A password is already set — use Change password")
    _check_new_password(data.password)
    a = auth.set_password(data.username, data.password)
    resp = JSONResponse({"ok": True, "username": a["username"]})
    _set_session_cookie(resp, request, a)
    return resp


@app.post("/api/auth/skip-setup")
def auth_skip_setup():
    """Fresh install: 'set it later' — run without a password for now."""
    cfg = get_config()
    if not cfg["auth"].get("password_hash"):
        cfg["auth"]["setup_pending"] = False
        save_config(cfg)
    return {"ok": True}


@app.post("/api/auth/password")
def auth_change_password(data: PasswordChangeIn, request: Request):
    a = auth.auth_config()
    if not auth.verify_password(data.current, a.get("password_hash") or ""):
        raise HTTPException(401, "Current password is wrong")
    _check_new_password(data.new)
    a = auth.set_password(a.get("username") or "admin", data.new)
    resp = JSONResponse({"ok": True})
    _set_session_cookie(resp, request, a)     # this browser stays in; others are logged out
    return resp


@app.post("/api/auth/disable")
def auth_disable(data: DisableLoginIn):
    a = auth.auth_config()
    if not auth.verify_password(data.password, a.get("password_hash") or ""):
        raise HTTPException(401, "Password is wrong")
    auth.clear_password()
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE, path="/")
    return resp


@app.get("/api/auth/settings")
def auth_settings_get():
    a = auth.auth_config()
    return {k: a.get(k) for k in ("enabled", "username", "trust_proxy", "proxy_header",
                                   "trusted_proxies", "session_days")}


@app.put("/api/auth/settings")
def auth_settings_put(data: AuthSettingsIn):
    cfg = get_config()
    a = cfg["auth"]
    if data.proxy_header is not None:
        a["proxy_header"] = data.proxy_header.strip() or "Remote-User"
    if data.trusted_proxies is not None:
        try:
            auth.parse_proxies(data.trusted_proxies)
        except ValueError as e:
            raise HTTPException(422, f"Not an IP address or range: {e}")
        a["trusted_proxies"] = data.trusted_proxies.strip()
    if data.trust_proxy is not None:
        if data.trust_proxy and not a.get("password_hash"):
            raise HTTPException(422, "Turn login on first")
        if data.trust_proxy and not auth.parse_proxies(a.get("trusted_proxies", "")):
            raise HTTPException(422, "Add the proxy's IP address first")
        a["trust_proxy"] = data.trust_proxy
    save_config(cfg)
    return auth_settings_get()


# ── Subnets ───────────────────────────────────────────────────────────────────

class SubnetIn(BaseModel):
    name: str
    cidr: str
    description: Optional[str] = None
    dhcp_start:  Optional[str] = None
    dhcp_end:    Optional[str] = None


class SubnetUpdate(BaseModel):
    name:        Optional[str] = None
    cidr:        Optional[str] = None
    description: Optional[str] = None
    dhcp_start:  Optional[str] = None   # "" clears it
    dhcp_end:    Optional[str] = None


@app.get("/api/subnets")
def list_subnets():
    with get_conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM subnets ORDER BY id")]


@app.post("/api/subnets", status_code=201)
def create_subnet(data: SubnetIn):
    try:
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO subnets (name, cidr, description, dhcp_start, dhcp_end) VALUES (?,?,?,?,?)",
                (data.name, data.cidr, data.description,
                 data.dhcp_start or None, data.dhcp_end or None),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM subnets WHERE cidr=?", (data.cidr,)).fetchone()
            return dict(row)
    except Exception as e:
        raise HTTPException(400, str(e))


@app.put("/api/subnets/{subnet_id}")
def update_subnet(subnet_id: int, data: SubnetUpdate):
    with get_conn() as conn:
        s = conn.execute("SELECT id FROM subnets WHERE id=?", (subnet_id,)).fetchone()
        if not s:
            raise HTTPException(404, "Subnet not found")
        # dhcp_start/end: empty string clears (NULL); None leaves unchanged
        ds = None if data.dhcp_start is None else (data.dhcp_start.strip() or None)
        de = None if data.dhcp_end   is None else (data.dhcp_end.strip()   or None)
        try:
            conn.execute("""
                UPDATE subnets SET
                    name        = COALESCE(?, name),
                    cidr        = COALESCE(?, cidr),
                    description = COALESCE(?, description),
                    dhcp_start  = CASE WHEN ? IS NULL THEN dhcp_start ELSE ? END,
                    dhcp_end    = CASE WHEN ? IS NULL THEN dhcp_end   ELSE ? END
                WHERE id=?
            """, (data.name, data.cidr, data.description,
                  data.dhcp_start, ds, data.dhcp_end, de, subnet_id))
            conn.commit()
        except Exception as e:
            raise HTTPException(400, str(e))
        return dict(conn.execute("SELECT * FROM subnets WHERE id=?", (subnet_id,)).fetchone())


@app.delete("/api/subnets/{subnet_id}")
def delete_subnet(subnet_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM subnets WHERE id=?", (subnet_id,))
        conn.commit()
    return {"ok": True}


_IP_HISTORY_MAX = 4096   # largest subnet (addresses) the IP History view will enumerate


@app.get("/api/subnets/{subnet_id}/ip-history")
def subnet_ip_history(subnet_id: int):
    """Every static-range IP of a subnet with how long since it last answered.
    Static range = the subnet minus its DHCP pool (whole subnet if no pool is set)."""
    cfg = get_config()["ip_history"]
    stale_days = max(1, int(cfg.get("stale_days") or 30))
    gone_days  = max(stale_days, int(cfg.get("gone_days") or 60))
    with get_conn() as conn:
        subnet = conn.execute("SELECT * FROM subnets WHERE id=?", (subnet_id,)).fetchone()
        if not subnet:
            raise HTTPException(404, "Subnet not found")
        subnet = dict(subnet)
        try:
            net = ipaddress.ip_network(subnet["cidr"], strict=False)
        except ValueError:
            raise HTTPException(422, "Subnet CIDR is invalid")
        if net.num_addresses > _IP_HISTORY_MAX:
            raise HTTPException(422, f"Subnet too large for IP History (max {_IP_HISTORY_MAX} addresses)")
        pool = None
        try:
            if subnet.get("dhcp_start") and subnet.get("dhcp_end"):
                pool = (ipaddress.ip_address(subnet["dhcp_start"]), ipaddress.ip_address(subnet["dhcp_end"]))
        except ValueError:
            pool = None

        hosts = {h["ip"]: dict(h) for h in conn.execute(
            "SELECT id, ip, mac, hostname, vendor, device_type, online, first_seen, last_seen FROM hosts")}
        by_id = {h["id"]: h for h in hosts.values()}
        aliases = {a["ip"]: (by_id.get(a["host_id"]), dict(a)) for a in conn.execute(
            "SELECT host_id, ip, online, last_seen FROM host_aliases")}
        mac_changes = {}
        for e in conn.execute(
                "SELECT ip, ts, old_value, new_value FROM change_events WHERE type='mac_changed' ORDER BY ts"):
            mac_changes[e["ip"]] = {"ts": e["ts"], "old": e["old_value"], "new": e["new_value"]}
        since = conn.execute("SELECT MIN(first_seen) AS m FROM hosts").fetchone()["m"]

    now = datetime.now(timezone.utc)
    counts = {"in_use": 0, "recent": 0, "stale": 0, "gone": 0, "never": 0}
    rows = []
    for ip in net.hosts():
        if pool and pool[0] <= ip <= pool[1]:
            continue
        ip_s = str(ip)
        h, alias_of = hosts.get(ip_s), None
        if not h and aliases.get(ip_s) and aliases[ip_s][0]:
            owner, al = aliases[ip_s]
            alias_of = owner["ip"]
            h = dict(owner)
            if al["last_seen"]:           # pinged on its own — use its own times
                h["online"], h["last_seen"] = al["online"], al["last_seen"]
        row = {"ip": ip_s, "alias_of": alias_of, "mac_change": mac_changes.get(ip_s)}
        if not h:
            row["status"] = "never"
        else:
            days = None
            try:
                seen = datetime.strptime(h["last_seen"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                days = max(0, (now - seen).days)
            except (TypeError, ValueError):
                pass
            if h.get("online") == 1 or (h.get("online") is None and days == 0):
                status = "in_use"
            elif days is None or days < stale_days:
                status = "recent"
            elif days < gone_days:
                status = "stale"
            else:
                status = "gone"
            row.update({"status": status, "days": days, "host_ip": h["ip"],
                        "hostname": h.get("hostname"), "mac": h.get("mac"), "vendor": h.get("vendor"),
                        "device_type": h.get("device_type"), "online": h.get("online"),
                        "first_seen": h.get("first_seen"), "last_seen": h.get("last_seen")})
        counts[row["status"]] += 1
        rows.append(row)
    return {"subnet": {"id": subnet["id"], "name": subnet.get("name"), "cidr": subnet["cidr"],
                       "dhcp_start": subnet.get("dhcp_start"), "dhcp_end": subnet.get("dhcp_end")},
            "has_pool": bool(pool), "stale_days": stale_days, "gone_days": gone_days,
            "tracking_since": since, "counts": counts, "ips": rows}


# ── Scans ─────────────────────────────────────────────────────────────────────

class ScanOptions(BaseModel):
    ports:             str  = "top1000"   # none | top1000 | topN | all | custom
    top_n:             int  = 100
    port_range:        str  = ""
    sv:                bool = True
    version_intensity: int  = 5
    os:                bool = True
    timing:            str  = "T4"
    pn:                bool = False
    udp:               bool = False
    scripts:           str  = ""


@app.post("/api/scan/preview")
def scan_preview(opts: ScanOptions, target: str = "TARGET"):
    """Return the exact nmap command a scan with these options would run."""
    return {"command": build_command(opts.dict(), target)}


@app.post("/api/scan/{subnet_id}")
def trigger_scan(subnet_id: int, opts: Optional[ScanOptions] = None):
    with get_conn() as conn:
        subnet = conn.execute("SELECT * FROM subnets WHERE id=?", (subnet_id,)).fetchone()
        if not subnet:
            raise HTTPException(404, "Subnet not found")
        conn.execute("INSERT INTO scan_runs (subnet_id) VALUES (?)", (subnet_id,))
        conn.commit()
        run_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    start_scan(run_id, subnet["cidr"], (opts or ScanOptions()).dict())
    return {"run_id": run_id, "status": "started"}


# ── Scan schedules (automated scans) ──────────────────────────────────────────

class ScanScheduleIn(BaseModel):
    name:           str
    enabled:        bool = True
    subnet_id:      Optional[int] = None       # None = all subnets
    host_filter:    str = "all"                # all | static | dynamic | unknown
    profile_id:     Optional[int] = None
    timing_type:    str = "interval"           # interval | weekly
    interval_hours: Optional[float] = None
    days_of_week:   Optional[str] = None       # CSV of 0-6 (Mon=0..Sun=6)
    at_time:        Optional[str] = None       # 'HH:MM'
    window_start:   Optional[str] = None       # active window 'HH:MM' (both set or both empty)
    window_end:     Optional[str] = None
    silent:         bool = False                # record changes, send no per-scan alert


def _sched_row(r) -> dict:
    return dict(r)


@app.get("/api/scan-schedules")
def list_scan_schedules():
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT sc.*, s.name AS subnet_name, p.name AS profile_name
            FROM scan_schedules sc
            LEFT JOIN subnets s       ON sc.subnet_id = s.id
            LEFT JOIN scan_profiles p ON sc.profile_id = p.id
            ORDER BY sc.name
        """).fetchall()
    out = []
    for r in rows:
        d = _sched_row(r)
        d["next_run"] = scheduler.next_run_utc(d)
        out.append(d)
    return out


def _validate_sched(d: ScanScheduleIn):
    if d.host_filter not in ("all", "static", "dynamic", "unknown"):
        raise HTTPException(422, "invalid host_filter")
    if d.timing_type not in ("interval", "weekly"):
        raise HTTPException(422, "invalid timing_type")
    if d.timing_type == "interval" and (not d.interval_hours or d.interval_hours <= 0):
        raise HTTPException(422, "interval_hours must be > 0")
    if d.timing_type == "weekly":
        if not d.at_time:
            raise HTTPException(422, "at_time required for weekly")
        days = [x for x in (d.days_of_week or "").split(",") if x.strip() != ""]
        if not days:
            raise HTTPException(422, "pick at least one day for weekly")
    # active window: both-or-neither, valid HH:MM
    ws, we = (d.window_start or "").strip(), (d.window_end or "").strip()
    if bool(ws) != bool(we):
        raise HTTPException(422, "set both the window start and end, or leave both empty")
    for w in (ws, we):
        if w:
            try:
                hh, mm = w.split(":")
                if not (0 <= int(hh) <= 23 and 0 <= int(mm) <= 59):
                    raise ValueError
            except Exception:
                raise HTTPException(422, f"invalid time: {w}")


@app.post("/api/scan-schedules", status_code=201)
def create_scan_schedule(data: ScanScheduleIn):
    _validate_sched(data)
    with get_conn() as conn:
        cur = conn.execute("""
            INSERT INTO scan_schedules
                (name, enabled, subnet_id, host_filter, profile_id, timing_type, interval_hours,
                 days_of_week, at_time, window_start, window_end, silent)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """, (data.name.strip(), 1 if data.enabled else 0, data.subnet_id, data.host_filter,
              data.profile_id, data.timing_type, data.interval_hours, data.days_of_week, data.at_time,
              (data.window_start or None), (data.window_end or None), 1 if data.silent else 0))
        conn.commit()
        return {"id": cur.lastrowid}


@app.put("/api/scan-schedules/{sid}")
def update_scan_schedule(sid: int, data: ScanScheduleIn):
    _validate_sched(data)
    with get_conn() as conn:
        if not conn.execute("SELECT id FROM scan_schedules WHERE id=?", (sid,)).fetchone():
            raise HTTPException(404, "Schedule not found")
        conn.execute("""
            UPDATE scan_schedules SET
                name=?, enabled=?, subnet_id=?, host_filter=?, profile_id=?,
                timing_type=?, interval_hours=?, days_of_week=?, at_time=?,
                window_start=?, window_end=?, silent=?
            WHERE id=?
        """, (data.name.strip(), 1 if data.enabled else 0, data.subnet_id, data.host_filter,
              data.profile_id, data.timing_type, data.interval_hours, data.days_of_week, data.at_time,
              (data.window_start or None), (data.window_end or None), 1 if data.silent else 0, sid))
        conn.commit()
    return {"ok": True}


@app.delete("/api/scan-schedules/{sid}")
def delete_scan_schedule(sid: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM scan_schedules WHERE id=?", (sid,))
        conn.commit()
    return {"ok": True}


@app.post("/api/scan-schedules/{sid}/run")
def run_scan_schedule(sid: int):
    result = scheduler.run_schedule(sid, mark_last_run=False)
    if result.get("error"):
        raise HTTPException(404, "Schedule not found")
    return result


# ── Scan profiles (reusable saved scan configs) ───────────────────────────────

class ScanProfileIn(BaseModel):
    name:    str
    options: ScanOptions


def _profile_row(r) -> dict:
    d = dict(r)
    try:
        d["options"] = json.loads(d["options"])
    except Exception:
        d["options"] = {}
    d["builtin"] = bool(d["builtin"])
    return d


@app.get("/api/scan-profiles")
def list_scan_profiles():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM scan_profiles ORDER BY builtin DESC, name").fetchall()
    return [_profile_row(r) for r in rows]


@app.post("/api/scan-profiles", status_code=201)
def create_scan_profile(data: ScanProfileIn):
    with get_conn() as conn:
        try:
            conn.execute("INSERT INTO scan_profiles (name, builtin, options) VALUES (?, 0, ?)",
                         (data.name.strip(), json.dumps(data.options.dict())))
            conn.commit()
        except Exception as e:
            msg = "A profile with that name already exists" if "UNIQUE" in str(e) else str(e)
            raise HTTPException(400, msg)
        return _profile_row(conn.execute("SELECT * FROM scan_profiles WHERE name=?", (data.name.strip(),)).fetchone())


@app.put("/api/scan-profiles/{pid}")
def update_scan_profile(pid: int, data: ScanProfileIn):
    with get_conn() as conn:
        row = conn.execute("SELECT builtin FROM scan_profiles WHERE id=?", (pid,)).fetchone()
        if not row:
            raise HTTPException(404, "Profile not found")
        if row["builtin"]:
            raise HTTPException(400, "Built-in profiles can't be edited")
        try:
            conn.execute("UPDATE scan_profiles SET name=?, options=? WHERE id=?",
                         (data.name.strip(), json.dumps(data.options.dict()), pid))
            conn.commit()
        except Exception as e:
            msg = "A profile with that name already exists" if "UNIQUE" in str(e) else str(e)
            raise HTTPException(400, msg)
        return _profile_row(conn.execute("SELECT * FROM scan_profiles WHERE id=?", (pid,)).fetchone())


@app.delete("/api/scan-profiles/{pid}")
def delete_scan_profile(pid: int):
    with get_conn() as conn:
        row = conn.execute("SELECT builtin FROM scan_profiles WHERE id=?", (pid,)).fetchone()
        if not row:
            raise HTTPException(404, "Profile not found")
        if row["builtin"]:
            raise HTTPException(400, "Built-in profiles can't be deleted")
        conn.execute("DELETE FROM scan_profiles WHERE id=?", (pid,))
        conn.commit()
    return {"ok": True}


# ── Change-tracking log ───────────────────────────────────────────────────────

@app.get("/api/change-events")
def list_change_events(ip: Optional[str] = None, limit: int = 200):
    with get_conn() as conn:
        if ip:   # a host's own IP plus its alias IPs
            rows = conn.execute("""
                SELECT * FROM change_events WHERE ip=? OR ip IN (
                    SELECT a.ip FROM host_aliases a JOIN hosts h ON h.id = a.host_id WHERE h.ip=?)
                ORDER BY ts DESC LIMIT ?""", (ip, ip, limit)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM change_events ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


@app.delete("/api/change-events")
def clear_change_events():
    with get_conn() as conn:
        conn.execute("DELETE FROM change_events")
        conn.commit()
    return {"ok": True}


@app.get("/api/scan/{run_id}/status")
def scan_status(run_id: int):
    if run_id in scan_jobs:
        job = dict(scan_jobs[run_id])
        job.pop("_proc", None)
        return job
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM scan_runs WHERE id=?", (run_id,)).fetchone()
        if row:
            return dict(row)
    raise HTTPException(404, "Run not found")


@app.post("/api/scan/{run_id}/cancel", status_code=204)
def cancel_scan_endpoint(run_id: int):
    if not cancel_scan(run_id):
        raise HTTPException(404, "Scan not found or already finished")


@app.get("/api/scans")
def list_scans():
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT sr.*, s.name AS subnet_name, s.cidr, sc.name AS schedule_name
            FROM scan_runs sr
            LEFT JOIN subnets s        ON sr.subnet_id = s.id
            LEFT JOIN scan_schedules sc ON sr.schedule_id = sc.id
            ORDER BY sr.started_at DESC
            LIMIT 100
        """).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        # Merge live progress for in-flight runs (DB status stays 'running' until
        # the scan finishes; scan_jobs holds the live sub-status + percentage).
        if d["status"] == "running":
            job = scan_jobs.get(d["id"])
            if job:
                d["live_status"] = job.get("status")          # discovering | scanning | ...
                d["progress"]    = job.get("progress", 0)
                d["total"]       = job.get("total", 0)
        out.append(d)
    return out


@app.delete("/api/scans/{run_id}")
def delete_scan_run(run_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM scan_runs WHERE id=?", (run_id,))
        conn.commit()
    return {"ok": True}


class ScanBulkDelete(BaseModel):
    ids: list[int]


@app.delete("/api/scans")
def bulk_delete_scans(data: ScanBulkDelete):
    if not data.ids:
        return {"ok": True, "deleted": 0}
    with get_conn() as conn:
        placeholders = ",".join("?" * len(data.ids))
        conn.execute(f"DELETE FROM scan_runs WHERE id IN ({placeholders})", data.ids)
        conn.commit()
    return {"ok": True, "deleted": len(data.ids)}


# ── Hosts ─────────────────────────────────────────────────────────────────────

def _resolve_host(conn, ip: str):
    """Return host row by primary IP or alias IP. Returns None if not found."""
    row = conn.execute("SELECT * FROM hosts WHERE ip=?", (ip,)).fetchone()
    if row:
        return row
    return conn.execute("""
        SELECT h.* FROM hosts h
        JOIN host_aliases a ON a.host_id = h.id
        WHERE a.ip = ?
    """, (ip,)).fetchone()


def _get_aliases(conn, host_id: int) -> list[str]:
    return [r["ip"] for r in conn.execute(
        "SELECT ip FROM host_aliases WHERE host_id=? ORDER BY ip", (host_id,)
    ).fetchall()]


def _get_alias_info(conn, host_id: int) -> list[dict]:
    return [dict(r) for r in conn.execute(
        "SELECT ip, online, last_seen FROM host_aliases WHERE host_id=? ORDER BY ip", (host_id,))]


class SshKeyIn(BaseModel):
    name: str
    public_key: str

class SshAccessIn(BaseModel):
    ssh_key_id: int
    username: str = "root"


def _rows_by_host(conn, sql: str, params=()) -> dict:
    """Run one query whose rows carry host_id and group them per host — replaces
    a query-per-host loop (N+1) with a single query."""
    out: dict = {}
    for r in conn.execute(sql, params):
        out.setdefault(r["host_id"], []).append(dict(r))
    return out


@app.get("/api/hosts")
def list_hosts():
    with get_conn() as conn:
        hosts = [dict(h) for h in conn.execute("SELECT * FROM hosts ORDER BY ip")]
        subnets = [dict(s) for s in conn.execute("SELECT cidr, dhcp_start, dhcp_end FROM subnets")]
        alias_by = _rows_by_host(conn, "SELECT host_id, ip, online, last_seen FROM host_aliases ORDER BY ip")
        ports_by = _rows_by_host(conn, "SELECT * FROM ports ORDER BY host_id, port")
        dhcp = dhcp_check.find_issues(conn)["hosts"]
        for h in hosts:
            h["ports"]      = ports_by.get(h["id"], [])
            h["alias_info"] = [{k: a[k] for k in ("ip", "online", "last_seen")} for a in alias_by.get(h["id"], [])]
            h["aliases"]    = [a["ip"] for a in h["alias_info"]]
            h["classification"] = classify_host(h["ip"], subnets, h.get("static_override"))
            h["dhcp_warnings"]  = dhcp.get(h["ip"], [])
    return JSONResponse(hosts)      # plain rows: skip FastAPI's slower generic encoder


@app.get("/api/dhcp-warnings")
def dhcp_warnings():
    """Hosts and DHCP pools that look wrong (see dhcp_check.py)."""
    with get_conn() as conn:
        return dhcp_check.find_issues(conn)


@app.post("/api/hosts/{ip}/probe", status_code=201)
def probe_host(ip: str, opts: Optional[ScanOptions] = None):
    with get_conn() as conn:
        host = conn.execute("SELECT id FROM hosts WHERE ip=?", (ip,)).fetchone()
        if not host:
            raise HTTPException(404, "Host not found")
        conn.execute(
            "INSERT INTO scan_runs (type, host_ip, status) VALUES ('probe', ?, 'running')",
            (ip,)
        )
        conn.commit()
        run_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    start_probe(run_id, ip, (opts or ScanOptions()).dict())
    return {"run_id": run_id, "status": "started"}


@app.get("/api/hosts/{ip}/ssh-access")
def get_host_ssh_access(ip: str):
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT a.id, a.ssh_key_id, a.username, k.name, k.fingerprint
            FROM ssh_access a JOIN ssh_keys k ON k.id = a.ssh_key_id
            WHERE a.host_ip = ? ORDER BY a.username, k.name
        """, (ip,)).fetchall()
    return [dict(r) for r in rows]

@app.post("/api/hosts/{ip}/ssh-access", status_code=201)
def add_host_ssh_access(ip: str, data: SshAccessIn):
    with get_conn() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO ssh_access (ssh_key_id, host_ip, username) VALUES (?,?,?)",
                (data.ssh_key_id, ip, data.username.strip())
            )
            conn.commit()
        except Exception:
            raise HTTPException(409, "Access entry already exists")
        row = conn.execute("""
            SELECT a.id, a.ssh_key_id, a.username, k.name, k.fingerprint
            FROM ssh_access a JOIN ssh_keys k ON k.id = a.ssh_key_id WHERE a.id=?
        """, (cur.lastrowid,)).fetchone()
    return dict(row)

@app.get("/api/hosts/{ip}/authorized-keys")
def get_authorized_keys(ip: str, user: str = "root"):
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT k.public_key, k.name
            FROM ssh_access a JOIN ssh_keys k ON k.id = a.ssh_key_id
            WHERE a.host_ip = ? AND a.username = ?
            ORDER BY k.name
        """, (ip, user)).fetchall()
    lines = [f"{r['public_key']} {r['name']}" for r in rows]
    from fastapi.responses import PlainTextResponse
    return PlainTextResponse("\n".join(lines) + ("\n" if lines else ""))


@app.post("/api/hosts/{ip:path}/uptime/reset")
def host_uptime_reset(ip: str):
    ip = ip.rstrip("/")
    with get_conn() as conn:
        host = _resolve_host(conn, ip)
        if not host:
            raise HTTPException(404, "Host not found")
        hid = host["id"]
    monitor.reset_host_uptime(hid)
    return {"ok": True}


@app.get("/api/hosts/{ip:path}/uptime")
def host_uptime_endpoint(ip: str):
    """Host up/down uptime %/outages from liveness history — mirrors service uptime."""
    ip = ip.rstrip("/")
    with get_conn() as conn:
        host = _resolve_host(conn, ip)
        if not host:
            raise HTTPException(404, "Host not found")
        hid = host["id"]
    windows = {"24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400}
    return {
        "uptime": {k: monitor.host_uptime(hid, secs) for k, secs in windows.items()},
        "outages": monitor.host_outages(hid, 30 * 86400, limit=10),
    }


@app.get("/api/hosts/{ip:path}")
def get_host(ip: str):
    ip = ip.rstrip("/")
    with get_conn() as conn:
        host = _resolve_host(conn, ip)
        if not host:
            raise HTTPException(404, "Host not found")
        host = dict(host)
        host["ports"] = [
            dict(p) for p in conn.execute(
                "SELECT * FROM ports WHERE host_id=? ORDER BY port", (host["id"],)
            )
        ]
        host["analyses"] = [
            dict(a) for a in conn.execute(
                "SELECT * FROM llm_analyses WHERE host_id=? ORDER BY created_at DESC LIMIT 5",
                (host["id"],),
            )
        ]
        host["services"] = [
            dict(s) for s in conn.execute(
                "SELECT * FROM services WHERE host_id=? ORDER BY name", (host["id"],)
            )
        ]
        host["aliases"] = _get_aliases(conn, host["id"])
        host["alias_info"] = _get_alias_info(conn, host["id"])
        return host


class HostCreate(BaseModel):
    ip:          Optional[str] = None
    hostname:    Optional[str] = None
    mac:         Optional[str] = None
    vendor:      Optional[str] = None
    os_guess:    Optional[str] = None
    device_type: Optional[str] = "unknown"
    notes:       Optional[str] = None


@app.post("/api/hosts", status_code=201)
def create_host(data: HostCreate):
    ip = (data.ip or "").strip()
    if not ip:
        ip = "node-" + uuid.uuid4().hex[:8]
    with get_conn() as conn:
        existing = conn.execute("SELECT id FROM hosts WHERE ip=?", (ip,)).fetchone()
        if existing:
            raise HTTPException(400, f"Host {ip} already exists")
        conn.execute(
            "INSERT INTO hosts (ip, hostname, mac, vendor, os_guess, device_type, notes, source) "
            "VALUES (?,?,?,?,?,?,?,'manual')",
            (ip, data.hostname or None, data.mac or None, data.vendor or None,
             data.os_guess or None, data.device_type or "unknown", data.notes or None),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM hosts WHERE ip=?", (ip,)).fetchone()
        return dict(row)


def _update_row(conn, table: str, where: str, key, fields: dict) -> None:
    """UPDATE only the given columns (column → value). Callers put a column in
    `fields` only when the request actually sent it, so unsent fields are never
    touched — an edit of one field can't blank another."""
    if fields:
        cols = ", ".join(f"{c}=?" for c in fields)
        conn.execute(f"UPDATE {table} SET {cols} WHERE {where}=?", (*fields.values(), key))


def _flag(v):
    return None if v is None else (1 if v else 0)


class HostUpdate(BaseModel):
    hostname:    Optional[str] = None
    mac:         Optional[str] = None
    device_type: Optional[str] = None
    vendor:      Optional[str] = None
    os_guess:    Optional[str] = None
    notes:       Optional[str] = None
    tier:        Optional[int] = None
    set_tier:    bool = False
    port_count:  Optional[int] = None
    has_wifi:    Optional[bool] = None
    is_dns:      Optional[bool] = None
    is_dhcp:     Optional[bool] = None
    dhcp_pool:   Optional[str] = None
    set_dhcp:    bool = False
    static_override:     Optional[str] = None   # 'static' | 'dynamic' | '' / 'auto'
    set_static_override: bool = False
    no_mac_alert:        Optional[bool] = None
    no_offline_alert:    Optional[bool] = None
    no_dhcp_warn:        Optional[bool] = None
    public:              Optional[bool] = None   # show on the public status page
    public_name:         Optional[str]  = None
    set_public:          bool = False


@app.put("/api/hosts/{ip}")
def update_host(ip: str, data: HostUpdate):
    with get_conn() as conn:
        host = conn.execute("SELECT id FROM hosts WHERE ip=?", (ip,)).fetchone()
        if not host:
            raise HTTPException(404, "Host not found")
        sent = data.model_fields_set
        fields = {}
        for f in ("hostname", "vendor", "os_guess", "notes"):        # clearable text
            if f in sent:
                fields[f] = getattr(data, f)
        if "mac" in sent:
            fields["mac"] = data.mac or None
        for f in ("device_type", "port_count"):                     # never set to NULL
            if f in sent and getattr(data, f) is not None:
                fields[f] = getattr(data, f)
        for f in ("has_wifi", "is_dns", "is_dhcp"):
            if f in sent and getattr(data, f) is not None:
                fields[f] = _flag(getattr(data, f))
        _update_row(conn, "hosts", "ip", ip, fields)
        if data.set_tier:
            conn.execute("UPDATE hosts SET tier=? WHERE ip=?", (data.tier, ip))
        if data.set_dhcp:
            conn.execute("UPDATE hosts SET dhcp_pool=? WHERE ip=?", (data.dhcp_pool, ip))
        if data.set_static_override:
            ov = data.static_override if data.static_override in ("static", "dynamic") else None
            conn.execute("UPDATE hosts SET static_override=? WHERE ip=?", (ov, ip))
        if data.no_mac_alert is not None:
            conn.execute("UPDATE hosts SET no_mac_alert=? WHERE ip=?", (1 if data.no_mac_alert else 0, ip))
        if data.no_offline_alert is not None:
            conn.execute("UPDATE hosts SET no_offline_alert=? WHERE ip=?", (1 if data.no_offline_alert else 0, ip))
        if data.no_dhcp_warn is not None:
            conn.execute("UPDATE hosts SET no_dhcp_warn=? WHERE ip=?", (1 if data.no_dhcp_warn else 0, ip))
        if data.set_public:
            conn.execute("UPDATE hosts SET public=?, public_name=? WHERE ip=?",
                         (1 if data.public else 0, (data.public_name or "").strip() or None, ip))
        conn.commit()
        row = conn.execute("SELECT * FROM hosts WHERE ip=?", (ip,)).fetchone()
    if data.set_public:                     # keep the public page in sync
        try:
            monitor.push_status()
        except Exception:
            pass
    return dict(row)


class HostRenameReq(BaseModel):
    new_ip: str


@app.post("/api/hosts/{ip}/rename")
def rename_host_ip(ip: str, data: HostRenameReq):
    """Change a host's primary IP, cascading to every place the IP is stored."""
    old_ip = ip.rstrip("/")
    new_ip = (data.new_ip or "").strip()
    try:
        ipaddress.ip_address(new_ip)
    except ValueError:
        raise HTTPException(422, f"'{new_ip}' is not a valid IP address")
    if new_ip == old_ip:
        return {"ok": True, "ip": new_ip}
    with get_conn() as conn:
        host = conn.execute("SELECT id FROM hosts WHERE ip=?", (old_ip,)).fetchone()
        if not host:
            raise HTTPException(404, "Host not found")
        hid = host["id"]
        # collision guards — never silently overwrite/merge another host
        if conn.execute("SELECT 1 FROM hosts WHERE ip=?", (new_ip,)).fetchone():
            raise HTTPException(409, f"{new_ip} already belongs to another host — use Merge instead")
        al = conn.execute("SELECT host_id FROM host_aliases WHERE ip=?", (new_ip,)).fetchone()
        if al and al["host_id"] != hid:
            raise HTTPException(409, f"{new_ip} is an alias of another host — use Merge instead")
        if al:                     # this host's own alias becomes the primary → drop the alias
            conn.execute("DELETE FROM host_aliases WHERE ip=?", (new_ip,))
        # cascade the rename to every place an IP is stored as a string
        conn.execute("UPDATE hosts SET ip=? WHERE id=?", (new_ip, hid))
        conn.execute("UPDATE host_aliases SET ip=? WHERE ip=?", (new_ip, old_ip))
        conn.execute("UPDATE ssh_access SET host_ip=? WHERE host_ip=?", (new_ip, old_ip))
        conn.execute("UPDATE services SET container_ip=? WHERE container_ip=?", (new_ip, old_ip))
        conn.execute("UPDATE change_events SET ip=? WHERE ip=?", (new_ip, old_ip))
        conn.execute("UPDATE scan_runs SET host_ip=? WHERE host_ip=?", (new_ip, old_ip))
        # connections have UNIQUE(src_ip,dst_ip): update what we can, drop any leftover
        # rows that would have become duplicate edges
        conn.execute("UPDATE OR IGNORE connections SET src_ip=? WHERE src_ip=?", (new_ip, old_ip))
        conn.execute("UPDATE OR IGNORE connections SET dst_ip=? WHERE dst_ip=?", (new_ip, old_ip))
        conn.execute("DELETE FROM connections WHERE src_ip=? OR dst_ip=?", (old_ip, old_ip))
        conn.commit()
    return {"ok": True, "ip": new_ip}


@app.delete("/api/hosts/{ip}")
def delete_host(ip: str):
    with get_conn() as conn:
        host = conn.execute("SELECT id FROM hosts WHERE ip=?", (ip,)).fetchone()
        if not host:
            raise HTTPException(404, "Host not found")
        conn.execute("DELETE FROM hosts WHERE ip=?", (ip,))
        conn.execute("DELETE FROM connections WHERE src_ip=? OR dst_ip=?", (ip, ip))
        conn.commit()
    return {"ok": True}


class HostBulkDelete(BaseModel):
    ips: list[str]


@app.delete("/api/hosts")
def bulk_delete_hosts(data: HostBulkDelete):
    if not data.ips:
        return {"ok": True, "deleted": 0}
    with get_conn() as conn:
        ph = ",".join("?" * len(data.ips))
        conn.execute(f"DELETE FROM hosts WHERE ip IN ({ph})", data.ips)
        conn.execute(f"DELETE FROM connections WHERE src_ip IN ({ph}) OR dst_ip IN ({ph})",
                     data.ips + data.ips)
        conn.commit()
    return {"ok": True, "deleted": len(data.ips)}


class MergeReq(BaseModel):
    merge_ip: str


@app.post("/api/hosts/{ip}/merge")
def merge_host(ip: str, data: MergeReq):
    merge_ip = data.merge_ip.strip()
    if ip == merge_ip:
        raise HTTPException(400, "Cannot merge a host with itself")
    with get_conn() as conn:
        primary = conn.execute("SELECT * FROM hosts WHERE ip=?", (ip,)).fetchone()
        victim  = conn.execute("SELECT * FROM hosts WHERE ip=?", (merge_ip,)).fetchone()
        if not primary: raise HTTPException(404, f"Host {ip} not found")
        if not victim:  raise HTTPException(404, f"Host {merge_ip} not found")

        pid = primary["id"]
        vid = victim["id"]

        # 1. Delete any direct connection between the two (would become self-loop)
        conn.execute("""
            DELETE FROM connections
            WHERE (src_ip=? AND dst_ip=?) OR (src_ip=? AND dst_ip=?)
        """, (ip, merge_ip, merge_ip, ip))

        # 2. Rewrite connections referencing merge_ip → ip, drop duplicates
        for col, other in [("src_ip", "dst_ip"), ("dst_ip", "src_ip")]:
            dupes = conn.execute(f"""
                SELECT v.id FROM connections v
                JOIN connections p ON p.{col}=? AND p.{other}=v.{other}
                WHERE v.{col}=?
            """, (ip, merge_ip)).fetchall()
            for d in dupes:
                conn.execute("DELETE FROM connections WHERE id=?", (d["id"],))
            conn.execute(f"UPDATE connections SET {col}=? WHERE {col}=?", (ip, merge_ip))

        # 3. Reparent ports (INSERT OR IGNORE skips duplicates)
        for p in conn.execute("SELECT * FROM ports WHERE host_id=?", (vid,)).fetchall():
            conn.execute("""
                INSERT OR IGNORE INTO ports
                    (host_id, port, protocol, state, service, version, manual)
                VALUES (?,?,?,?,?,?,?)
            """, (pid, p["port"], p["protocol"], p["state"],
                  p["service"], p["version"], p["manual"]))

        # 4. Reparent services, analyses
        conn.execute("UPDATE services     SET host_id=? WHERE host_id=?", (pid, vid))
        conn.execute("UPDATE llm_analyses SET host_id=? WHERE host_id=?", (pid, vid))

        # 5. Transfer victim's existing aliases to primary, then add merge_ip itself
        conn.execute("UPDATE host_aliases SET host_id=? WHERE host_id=?", (pid, vid))
        conn.execute("INSERT OR IGNORE INTO host_aliases (host_id, ip, online, last_seen) VALUES (?,?,?,?)",
                     (pid, merge_ip, victim["online"], victim["last_seen"]))

        # 6. Delete victim (cascades its ports; services/analyses already reparented)
        conn.execute("DELETE FROM hosts WHERE id=?", (vid,))
        conn.commit()

        row = dict(conn.execute("SELECT * FROM hosts WHERE ip=?", (ip,)).fetchone())
        row["aliases"] = _get_aliases(conn, pid)
        return row


@app.delete("/api/hosts/{ip}/aliases/{alias_ip:path}")
def remove_alias(ip: str, alias_ip: str):
    with get_conn() as conn:
        host = conn.execute("SELECT id FROM hosts WHERE ip=?", (ip,)).fetchone()
        if not host:
            raise HTTPException(404, "Host not found")
        conn.execute(
            "DELETE FROM host_aliases WHERE host_id=? AND ip=?",
            (host["id"], alias_ip)
        )
        conn.commit()
    return {"ok": True}


# ── Ports ─────────────────────────────────────────────────────────────────────

class PortIn(BaseModel):
    port:     int
    protocol: Optional[str] = "tcp"
    state:    Optional[str] = "open"
    service:  Optional[str] = None
    version:  Optional[str] = None


@app.post("/api/hosts/{ip}/ports", status_code=201)
def add_port(ip: str, data: PortIn):
    with get_conn() as conn:
        host = conn.execute("SELECT id FROM hosts WHERE ip=?", (ip,)).fetchone()
        if not host:
            raise HTTPException(404, "Host not found")
        try:
            conn.execute("""
                INSERT INTO ports (host_id, port, protocol, state, service, version, manual)
                VALUES (?,?,?,?,?,?,1)
                ON CONFLICT(host_id, port, protocol) DO UPDATE SET
                    state   = excluded.state,
                    service = excluded.service,
                    version = excluded.version,
                    manual  = 1
            """, (host["id"], data.port, data.protocol, data.state,
                  data.service, data.version))
            conn.commit()
            row = conn.execute(
                "SELECT * FROM ports WHERE host_id=? AND port=? AND protocol=?",
                (host["id"], data.port, data.protocol)
            ).fetchone()
            return dict(row)
        except Exception as e:
            raise HTTPException(400, str(e))


@app.delete("/api/ports/{port_id}")
def delete_port(port_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM ports WHERE id=?", (port_id,))
        conn.commit()
    return {"ok": True}


# ── Services ──────────────────────────────────────────────────────────────────

SvcStatus = Literal["running", "stopped", "unknown"]   # what the monitor writes too


class ServiceIn(BaseModel):
    name:         str
    description:  Optional[str] = None
    port:         Optional[int] = None
    protocol:     Optional[str] = "tcp"
    status:       Optional[SvcStatus] = "unknown"
    url:          Optional[str] = None
    icon:         Optional[str] = None
    container_ip: Optional[str] = None
    check_type:   Optional[str] = None   # http | tcp | icmp | None (auto)


class ServiceUpdate(BaseModel):
    name:         Optional[str] = None
    description:  Optional[str] = None
    port:         Optional[int] = None
    protocol:     Optional[str] = None
    status:       Optional[SvcStatus] = None
    url:          Optional[str] = None
    icon:         Optional[str] = None
    monitored:    Optional[bool] = None
    container_ip: Optional[str] = None
    check_type:   Optional[str] = None
    host_ip:      Optional[str] = None   # move the service to another host


@app.get("/api/services")
def list_all_services():
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT s.*, h.ip, h.hostname, h.online AS host_online
            FROM services s
            JOIN hosts h ON s.host_id = h.id
            ORDER BY h.ip, s.name
        """).fetchall()
        return [dict(r) for r in rows]


@app.post("/api/hosts/{ip}/services", status_code=201)
def add_service(ip: str, data: ServiceIn):
    with get_conn() as conn:
        host = conn.execute("SELECT id FROM hosts WHERE ip=?", (ip,)).fetchone()
        if not host:
            raise HTTPException(404, "Host not found")
        conn.execute(
            "INSERT INTO services (host_id, name, description, port, protocol, status, url, icon, container_ip, check_type)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (host["id"], data.name, data.description, data.port, data.protocol,
             data.status, data.url, data.icon, data.container_ip,
             (data.check_type or None) and data.check_type.strip().lower() or None),
        )
        conn.commit()
        row = conn.execute("""
            SELECT s.*, h.ip, h.hostname FROM services s
            JOIN hosts h ON s.host_id = h.id
            WHERE s.id = last_insert_rowid()
        """).fetchone()
        return dict(row)


@app.put("/api/services/{svc_id}")
def update_service(svc_id: int, data: ServiceUpdate):
    with get_conn() as conn:
        s = conn.execute("SELECT id FROM services WHERE id=?", (svc_id,)).fetchone()
        if not s:
            raise HTTPException(404, "Service not found")
        new_host_id = None
        if data.host_ip:
            hrow = conn.execute("SELECT id FROM hosts WHERE ip=?", (data.host_ip,)).fetchone()
            if not hrow:
                raise HTTPException(404, "Host not found")
            new_host_id = hrow["id"]
        sent = data.model_fields_set
        fields = {}
        if new_host_id is not None:
            fields["host_id"] = new_host_id
        for f in ("description", "port", "url"):                     # clearable
            if f in sent:
                fields[f] = getattr(data, f)
        for f in ("name", "protocol", "status", "icon"):             # never set to NULL
            if f in sent and getattr(data, f) is not None:
                fields[f] = getattr(data, f)
        if "monitored" in sent and data.monitored is not None:
            fields["monitored"] = _flag(data.monitored)
        if "container_ip" in sent and data.container_ip is not None:  # "" clears the override
            fields["container_ip"] = data.container_ip.strip() or None
        if "check_type" in sent and data.check_type is not None:
            fields["check_type"] = data.check_type.strip().lower() or None
        _update_row(conn, "services", "id", svc_id, fields)
        conn.commit()
        row = conn.execute("""
            SELECT s.*, h.ip, h.hostname FROM services s
            JOIN hosts h ON s.host_id = h.id WHERE s.id=?
        """, (svc_id,)).fetchone()
        return dict(row)


class MonitorToggleIn(BaseModel):
    enabled: bool


@app.post("/api/services/{svc_id}/monitor")
def set_service_monitor(svc_id: int, data: MonitorToggleIn):
    """Toggle monitoring for a service WITHOUT touching its other fields.
    Turning on probes immediately; turning off resets the live status."""
    with get_conn() as conn:
        s = conn.execute("SELECT id FROM services WHERE id=?", (svc_id,)).fetchone()
        if not s:
            raise HTTPException(404, "Service not found")
        if data.enabled:
            conn.execute("UPDATE services SET monitored=1 WHERE id=?", (svc_id,))
        else:
            conn.execute(
                "UPDATE services SET monitored=0, monitor_status='unknown', "
                "monitor_fail_since=NULL, monitor_alerted=0 WHERE id=?",
                (svc_id,))
        conn.commit()
    status = "unknown"
    if data.enabled:
        try:
            status = monitor.check_now(svc_id)["status"]
        except Exception:
            pass
    try:
        monitor.push_status()   # keep public page in sync
    except Exception:
        pass
    return {"id": svc_id, "monitored": data.enabled, "monitor_status": status}


@app.post("/api/services/{svc_id}/check")
def check_service_now(svc_id: int):
    return monitor.check_now(svc_id)


class PublicToggleIn(BaseModel):
    enabled: bool
    name:    Optional[str] = None   # public label; None leaves it unchanged


@app.post("/api/services/{svc_id}/public")
def set_service_public(svc_id: int, data: PublicToggleIn):
    """Toggle whether a service appears on the public status page, and set its
    public label. Only touches the public fields (never other service data)."""
    with get_conn() as conn:
        s = conn.execute("SELECT id FROM services WHERE id=?", (svc_id,)).fetchone()
        if not s:
            raise HTTPException(404, "Service not found")
        conn.execute("UPDATE services SET public=? WHERE id=?", (1 if data.enabled else 0, svc_id))
        if data.name is not None:
            conn.execute("UPDATE services SET public_name=? WHERE id=?", (data.name.strip(), svc_id))
        conn.commit()
    # reflect immediately on the public page
    try:
        monitor.push_status()
    except Exception:
        pass
    return {"id": svc_id, "public": data.enabled}


@app.get("/api/services/{svc_id}/uptime")
def service_uptime(svc_id: int):
    windows = {"24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400}
    return {
        "uptime": {k: monitor.uptime(svc_id, secs) for k, secs in windows.items()},
        "outages": monitor.outages(svc_id, 30 * 86400, limit=10),
    }


@app.post("/api/services/{svc_id}/uptime/reset")
def service_uptime_reset(svc_id: int):
    with get_conn() as conn:
        if not conn.execute("SELECT 1 FROM services WHERE id=?", (svc_id,)).fetchone():
            raise HTTPException(404, "Service not found")
    monitor.reset_service_uptime(svc_id)
    return {"ok": True}


@app.post("/api/uptime/reset-all")
def uptime_reset_all():
    return monitor.reset_all_uptime()


@app.delete("/api/services/{svc_id}")
def delete_service_endpoint(svc_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM services WHERE id=?", (svc_id,))
        conn.commit()
    return {"ok": True}


class ServiceBulkDelete(BaseModel):
    ids: list[int]


@app.delete("/api/services")
def bulk_delete_services(data: ServiceBulkDelete):
    if not data.ids:
        return {"ok": True, "deleted": 0}
    with get_conn() as conn:
        ph = ",".join("?" * len(data.ids))
        conn.execute(f"DELETE FROM services WHERE id IN ({ph})", data.ids)
        conn.commit()
    return {"ok": True, "deleted": len(data.ids)}


# ── Service dependencies ──────────────────────────────────────────────────────

class ServiceDependency(BaseModel):
    from_service_id: int
    to_service_id:   int

@app.get("/api/service-dependencies")
def list_service_dependencies():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM service_dependencies").fetchall()
        return [dict(r) for r in rows]

@app.post("/api/service-dependencies", status_code=201)
def add_service_dependency(data: ServiceDependency):
    with get_conn() as conn:
        try:
            conn.execute(
                "INSERT INTO service_dependencies (from_service_id, to_service_id) VALUES (?,?)",
                (data.from_service_id, data.to_service_id)
            )
            conn.commit()
        except Exception:
            raise HTTPException(409, "Dependency already exists")
        row = conn.execute(
            "SELECT * FROM service_dependencies WHERE from_service_id=? AND to_service_id=?",
            (data.from_service_id, data.to_service_id)
        ).fetchone()
        return dict(row)

@app.delete("/api/service-dependencies/{dep_id}", status_code=204)
def delete_service_dependency(dep_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM service_dependencies WHERE id=?", (dep_id,))
        conn.commit()


# ── VLANs ─────────────────────────────────────────────────────────────────────

class VlanIn(BaseModel):
    tag:   int
    name:  str
    color: str = "#888888"


class VlanUpdate(BaseModel):
    tag:   Optional[int] = None
    name:  Optional[str] = None
    color: Optional[str] = None


@app.get("/api/vlans")
def list_vlans():
    with get_conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM vlans ORDER BY tag")]


@app.post("/api/vlans", status_code=201)
def create_vlan(data: VlanIn):
    try:
        with get_conn() as conn:
            conn.execute("INSERT INTO vlans (tag, name, color) VALUES (?,?,?)",
                         (data.tag, data.name, data.color))
            conn.commit()
            row = conn.execute("SELECT * FROM vlans WHERE tag=?", (data.tag,)).fetchone()
            return dict(row)
    except Exception as e:
        raise HTTPException(400, str(e))


@app.put("/api/vlans/{vlan_id}")
def update_vlan(vlan_id: int, data: VlanUpdate):
    with get_conn() as conn:
        v = conn.execute("SELECT id FROM vlans WHERE id=?", (vlan_id,)).fetchone()
        if not v:
            raise HTTPException(404, "VLAN not found")
        conn.execute("""
            UPDATE vlans SET
                tag   = COALESCE(?, tag),
                name  = COALESCE(?, name),
                color = COALESCE(?, color)
            WHERE id=?
        """, (data.tag, data.name, data.color, vlan_id))
        conn.commit()
        row = conn.execute("SELECT * FROM vlans WHERE id=?", (vlan_id,)).fetchone()
        return dict(row)


@app.delete("/api/vlans/{vlan_id}")
def delete_vlan(vlan_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM vlans WHERE id=?", (vlan_id,))
        conn.commit()
    return {"ok": True}


# ── Connections ───────────────────────────────────────────────────────────────

def _conn_with_vlans(conn, conn_id):
    row = dict(conn.execute("SELECT * FROM connections WHERE id=?", (conn_id,)).fetchone())
    vlans = conn.execute("""
        SELECT v.* FROM vlans v
        JOIN connection_vlans cv ON cv.vlan_id = v.id
        WHERE cv.connection_id=? ORDER BY v.tag
    """, (conn_id,)).fetchall()
    row["vlans"] = [dict(v) for v in vlans]
    return row


class ConnectionIn(BaseModel):
    src_ip:      str
    dst_ip:      str
    type:        Optional[str] = "wired"
    label:       Optional[str] = None
    port_mode:   Optional[str] = None
    speed:       Optional[str] = None
    tagged_only: Optional[bool] = None
    vlan_ids:    Optional[list[int]] = None


@app.get("/api/connections")
def list_connections():
    with get_conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM connections ORDER BY id")]


@app.post("/api/connections", status_code=201)
def create_connection(data: ConnectionIn):
    if data.src_ip == data.dst_ip:
        raise HTTPException(400, "Cannot connect a device to itself")
    try:
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO connections (src_ip, dst_ip, type, label, port_mode, speed, tagged_only)"
                " VALUES (?,?,?,?,?,?,?)",
                (data.src_ip, data.dst_ip, data.type, data.label, data.port_mode, data.speed,
                 int(bool(data.tagged_only)) if data.tagged_only is not None else 0),
            )
            conn_id = conn.execute("SELECT last_insert_rowid() as id").fetchone()["id"]
            if data.vlan_ids:
                for vid in data.vlan_ids:
                    try:
                        conn.execute("INSERT INTO connection_vlans (connection_id, vlan_id) VALUES (?,?)",
                                     (conn_id, vid))
                    except Exception:
                        pass
            conn.commit()
            return _conn_with_vlans(conn, conn_id)
    except Exception as e:
        raise HTTPException(400, str(e))


@app.delete("/api/connections/{conn_id}")
def delete_connection(conn_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM connections WHERE id=?", (conn_id,))
        conn.commit()
    return {"ok": True}


class ConnectionUpdate(BaseModel):
    type:        Optional[str] = None
    label:       Optional[str] = None
    port_mode:   Optional[str] = None
    speed:       Optional[str] = None
    tagged_only: Optional[bool] = None
    vlan_ids:    Optional[list[int]] = None
    set_vlans:   bool = False


@app.put("/api/connections/{conn_id}")
def update_connection(conn_id: int, data: ConnectionUpdate):
    with get_conn() as conn:
        c = conn.execute("SELECT id FROM connections WHERE id=?", (conn_id,)).fetchone()
        if not c:
            raise HTTPException(404, "Connection not found")
        sent = data.model_fields_set
        fields = {f: getattr(data, f) for f in ("label", "port_mode", "speed") if f in sent}
        if "type" in sent and data.type is not None:
            fields["type"] = data.type
        if "tagged_only" in sent and data.tagged_only is not None:
            fields["tagged_only"] = _flag(data.tagged_only)
        _update_row(conn, "connections", "id", conn_id, fields)
        if data.set_vlans:
            conn.execute("DELETE FROM connection_vlans WHERE connection_id=?", (conn_id,))
            if data.vlan_ids:
                for vid in data.vlan_ids:
                    try:
                        conn.execute("INSERT INTO connection_vlans (connection_id, vlan_id) VALUES (?,?)",
                                     (conn_id, vid))
                    except Exception:
                        pass
        conn.commit()
        return _conn_with_vlans(conn, conn_id)


# ── Layout ────────────────────────────────────────────────────────────────────

class LayoutIn(BaseModel):
    positions: dict  # {ip: {x: float, y: float}}


@app.put("/api/layout")
def save_layout(data: LayoutIn):
    with get_conn() as conn:
        for ip, pos in data.positions.items():
            conn.execute(
                "UPDATE hosts SET pos_x=?, pos_y=? WHERE ip=?",
                (pos.get("x"), pos.get("y"), ip),
            )
        conn.commit()
    return {"ok": True, "saved": len(data.positions)}


# ── LLM ──────────────────────────────────────────────────────────────────────

class AnalyzeReq(BaseModel):
    model: Optional[str] = None


@app.post("/api/hosts/{ip}/analyze")
async def analyze_host(ip: str, req: AnalyzeReq):
    with get_conn() as conn:
        host = conn.execute("SELECT * FROM hosts WHERE ip=?", (ip,)).fetchone()
        if not host:
            raise HTTPException(404, "Host not found")
        host = dict(host)
        ports = [dict(p) for p in conn.execute(
            "SELECT * FROM ports WHERE host_id=? ORDER BY port", (host["id"],)
        )]
        services = [dict(s) for s in conn.execute(
            "SELECT * FROM services WHERE host_id=? ORDER BY name", (host["id"],)
        )]

        # Connections involving this host with peer info and VLANs
        raw_conns = [dict(c) for c in conn.execute(
            "SELECT * FROM connections WHERE src_ip=? OR dst_ip=?", (ip, ip)
        )]
        connections = []
        for c in raw_conns:
            peer_ip = c["dst_ip"] if c["src_ip"] == ip else c["src_ip"]
            peer = conn.execute("SELECT hostname, device_type FROM hosts WHERE ip=?", (peer_ip,)).fetchone()
            peer_label = ""
            if peer:
                peer_label = peer["hostname"] or peer["device_type"] or ""
            vlans = conn.execute("""
                SELECT v.tag, v.name FROM vlans v
                JOIN connection_vlans cv ON cv.vlan_id = v.id
                WHERE cv.connection_id=? ORDER BY v.tag
            """, (c["id"],)).fetchall()
            connections.append({
                "peer_ip": peer_ip,
                "peer_label": peer_label,
                "speed": c.get("speed"),
                "port_mode": c.get("port_mode"),
                "label": c.get("label"),
                "tagged_only": c.get("tagged_only"),
                "vlan_summary": ", ".join(f"VLAN{v['tag']}({v['name']})" for v in vlans) if vlans else "",
            })

    try:
        analysis = await generate(
            build_host_prompt(host, ports, services, connections),
            model=req.model or get_default_model(),
        )
    except LLMError as e:
        raise HTTPException(503, str(e))
    device_type = infer_device_type(analysis)

    with get_conn() as conn:
        conn.execute(
            "INSERT INTO llm_analyses (host_id, model, analysis) VALUES (?,?,?)",
            (host["id"], req.model, analysis),
        )
        conn.execute(
            "UPDATE hosts SET device_type=? WHERE id=?",
            (device_type, host["id"]),
        )
        conn.commit()

    return {"analysis": analysis, "model": req.model or get_default_model(), "device_type": device_type}


@app.post("/api/analyze/network")
async def analyze_network(req: AnalyzeReq):
    with get_conn() as conn:
        subnets = [dict(r) for r in conn.execute("SELECT * FROM subnets ORDER BY id")]
        vlans   = [dict(r) for r in conn.execute("SELECT * FROM vlans ORDER BY tag")]
        hosts   = [dict(h) for h in conn.execute("SELECT * FROM hosts ORDER BY ip")]

        # Attach ports and services to each host
        ports_by = _rows_by_host(conn, "SELECT * FROM ports ORDER BY host_id, port")
        svcs_by  = _rows_by_host(conn, "SELECT * FROM services ORDER BY host_id, name")
        for h in hosts:
            h["ports"]    = ports_by.get(h["id"], [])
            h["services"] = svcs_by.get(h["id"], [])

        # Connections with full VLAN info
        raw_conns = [dict(c) for c in conn.execute("SELECT * FROM connections ORDER BY id")]
        connections = []
        for c in raw_conns:
            vlans_for_conn = conn.execute("""
                SELECT v.tag, v.name FROM vlans v
                JOIN connection_vlans cv ON cv.vlan_id = v.id
                WHERE cv.connection_id=? ORDER BY v.tag
            """, (c["id"],)).fetchall()
            c["vlans"] = [dict(v) for v in vlans_for_conn]
            connections.append(c)

    prompt = build_network_prompt(hosts, connections, vlans, subnets)
    try:
        analysis = await generate(prompt, model=req.model or get_default_model(), timeout=LONG_TIMEOUT)
    except LLMError as e:
        raise HTTPException(503, str(e))
    return {"analysis": analysis, "model": req.model or get_default_model()}


class ChatMsg(BaseModel):
    role: str
    content: str


class ChatReq(BaseModel):
    messages: list[ChatMsg]
    model: Optional[str] = None


_NETGEAR = {"router", "gateway", "switch", "unmanaged-switch", "firewall", "ap"}
_HOST_CAP = 80          # full host lines sent to the model; the rest are summarised
_CONN_CAP = 120


def _chat_context() -> str:
    """Build the chat system message: live network state + recent history."""
    with get_conn() as conn:
        hosts = [dict(h) for h in conn.execute("SELECT * FROM hosts ORDER BY ip")]
        host_entries = []                        # (priority, rendered_line, device_type)
        down_hosts, down_svcs = [], []
        mon_services, host_min = [], []          # for the recent-outages section
        open_by = _rows_by_host(conn, "SELECT host_id, port, service FROM ports WHERE state='open'")
        svc_by  = _rows_by_host(conn, "SELECT host_id, id, name, port, status, monitored, monitor_status FROM services")
        for h in hosts:
            label = h.get("hostname") or h.get("device_type") or "unknown"
            live = h.get("online")
            hstatus = "online" if live == 1 else "offline" if live == 0 else "unknown"
            host_min.append((h["id"], h["ip"], label))
            parts = [f"{h['ip']} ({label}, {h.get('device_type','?')}) status={hstatus}"]
            if h.get("vendor"):   parts.append(f"vendor={h['vendor']}")
            if h.get("os_guess"): parts.append(f"os={h['os_guess']}")
            if h.get("has_wifi"): parts.append("wifi=yes")
            if live == 0:
                down_hosts.append(f"{h['ip']} ({label})")
            ports = open_by.get(h["id"], [])
            if ports:
                _p = ports[:15]
                _ptail = f" +{len(ports) - 15} more" if len(ports) > 15 else ""
                parts.append("open=" + ",".join(f"{p['port']}/{p['service'] or '?'}" for p in _p) + _ptail)
            svc_rows = svc_by.get(h["id"], [])
            if svc_rows:
                svc_strs = []
                for s in svc_rows:
                    mon = s.get("monitored")
                    st = (s.get("monitor_status") if mon and s.get("monitor_status") else s.get("status")) or "?"
                    cell = f"{s['name']}:{s.get('port') or '?'}[{st}]"
                    if mon:
                        u = monitor.uptime(s["id"], 86400)
                        if u and u.get("pct") is not None:
                            cell += f" up24h={u['pct']:.0f}%"
                        u7 = monitor.uptime(s["id"], 7 * 86400)
                        if u7 and u7.get("pct") is not None:
                            cell += f" up7d={u7['pct']:.0f}%"
                        mon_services.append((s["id"], s["name"], h["ip"], label))
                        if s.get("monitor_status") == "down":
                            down_svcs.append(f"{s['name']} on {h['ip']} ({label})")
                    svc_strs.append(cell)
                parts.append("services=" + ",".join(svc_strs))
            dt = (h.get("device_type") or "").lower()
            host_down = live == 0 or any(s.get("monitored") and s.get("monitor_status") == "down" for s in svc_rows)
            has_mon = any(s.get("monitored") for s in svc_rows)
            prio = 4 if host_down else 3 if (dt in _NETGEAR or has_mon) else 2 if (ports or svc_rows) else 1
            host_entries.append((prio, "  " + "  ".join(parts), h.get("device_type") or "unknown"))

        # Trim: keep the most relevant hosts in full (down > infra/monitored > has
        # ports/services > plain clients); summarise the rest so a big network
        # doesn't overflow the model. Stable sort preserves IP order within a tier.
        host_entries.sort(key=lambda x: x[0], reverse=True)
        lines = [e[1] for e in host_entries[:_HOST_CAP]]
        _dropped = host_entries[_HOST_CAP:]
        if _dropped:
            from collections import Counter
            _cnt = ", ".join(f"{n} {t}" for t, n in Counter(e[2] for e in _dropped).most_common())
            lines.append(f"  ... and {len(_dropped)} more hosts not shown ({_cnt}). "
                         f"Ask about a specific IP for full detail.")

        conns = [dict(c) for c in conn.execute("SELECT * FROM connections ORDER BY src_ip")]
        conn_lines = []
        for c in conns:
            cl = f"  {c['src_ip']} ↔ {c['dst_ip']}"
            if c.get("speed"):     cl += f" {c['speed']}"
            if c.get("port_mode"): cl += f" mode={c['port_mode']}"
            vlans = conn.execute("""
                SELECT v.tag, v.name FROM vlans v
                JOIN connection_vlans cv ON cv.vlan_id=v.id
                WHERE cv.connection_id=? ORDER BY v.tag
            """, (c["id"],)).fetchall()
            if vlans:
                cl += " vlans=" + ",".join(f"VLAN{v['tag']}({v['name']})" for v in vlans)
            conn_lines.append(cl)
        if len(conn_lines) > _CONN_CAP:
            _extra = len(conn_lines) - _CONN_CAP
            conn_lines = conn_lines[:_CONN_CAP] + [f"  ... and {_extra} more connections not shown."]

        vlan_rows = conn.execute("SELECT * FROM vlans ORDER BY tag").fetchall()
        vlan_lines = ["  VLAN " + str(v["tag"]) + " " + v["name"] for v in vlan_rows]

        # Local-time helpers (timestamps are stored UTC; show them in the user's zone).
        _tzname = get_config().get("general", {}).get("timezone") or "UTC"
        try:
            from zoneinfo import ZoneInfo
            _tz = ZoneInfo(_tzname)
        except Exception:
            _tz = timezone.utc
        def _loc(iso):
            try:
                return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).astimezone(_tz).strftime("%Y-%m-%d %H:%M")
            except Exception:
                return str(iso)
        def _dur(sec):
            sec = int(sec or 0)
            if sec < 3600: return f"{max(1, sec // 60)}m"
            if sec < 86400: return f"{sec // 3600}h {sec % 3600 // 60}m"
            return f"{sec // 86400}d {sec % 86400 // 3600}h"

        # Recent changes (change-tracking feed), newest first.
        _CL = {"host_new": "new host", "host_offline": "went offline", "host_online": "back online",
               "port_opened": "port opened", "port_closed": "port closed",
               "mac_changed": "MAC changed", "hostname_changed": "hostname changed"}
        _since = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
        change_lines = []
        for e in conn.execute("SELECT ts, ip, type, port, old_value, new_value FROM change_events "
                              "WHERE ts >= ? ORDER BY ts DESC LIMIT 20", (_since,)):
            e = dict(e); t = e["type"]
            base = f"{e['ip']}:{e['port']}" if t in ("port_opened", "port_closed") and e.get("port") else e["ip"]
            extra = f" ({e.get('old_value') or '?'} -> {e.get('new_value') or '?'})" \
                if t in ("mac_changed", "hostname_changed") else ""
            change_lines.append(f"  {_loc(e['ts'])}  {_CL.get(t, t)}  {base}{extra}")

    # Recent outages (last 7 days) across monitored services and hosts, newest first.
    outage_items = []
    for sid, sname, sip, slabel in mon_services:
        for o in monitor.outages(sid, 7 * 86400, limit=5):
            outage_items.append((o.get("start") or "", f"{sname} on {sip} ({slabel})", o))
    for hid, hip, hlabel in host_min:
        for o in monitor.host_outages(hid, 7 * 86400, limit=5):
            outage_items.append((o.get("start") or "", f"HOST {hip} ({hlabel})", o))
    outage_items.sort(key=lambda x: x[0], reverse=True)
    outage_lines = []
    for _, name, o in outage_items[:15]:
        if o.get("ongoing"):
            outage_lines.append(f"  {name} — down since {_loc(o['start'])} (ongoing)")
        else:
            outage_lines.append(f"  {name} — down {_loc(o['start'])} for {_dur(o.get('seconds'))}")

    problems = []
    if down_hosts:
        problems.append("Offline hosts: " + "; ".join(down_hosts))
    if down_svcs:
        problems.append("Down monitored services: " + "; ".join(down_svcs))
    network_ctx = f"Current time: {datetime.now(_tz).strftime('%Y-%m-%d %H:%M %Z')}\n\n"
    network_ctx += "Currently down:\n  " + (
        "\n  ".join(problems) if problems else "Nothing — all monitored items are up.") + "\n\n"
    if lines:
        network_ctx += ("Hosts (status = live liveness state; up24h/up7d = uptime of monitored "
                        "services):\n" + "\n".join(lines) + "\n")
    if conn_lines:
        network_ctx += "\nConnections:\n" + "\n".join(conn_lines) + "\n"
    if vlan_lines:
        network_ctx += "\nVLANs:\n" + "\n".join(vlan_lines) + "\n"
    if change_lines:
        network_ctx += "\nRecent changes (last 7 days, newest first):\n" + "\n".join(change_lines) + "\n"
    if outage_lines:
        network_ctx += "\nRecent outages (last 7 days, newest first):\n" + "\n".join(outage_lines) + "\n"
    if not lines:
        network_ctx = "No hosts scanned yet."

    system_msg = (
        "You are Boltarr's network assistant. Below is the user's LIVE network state plus recent "
        "history: the device inventory, connections and VLANs, each host's current online/offline "
        "status, monitored services' up/down status with 24-hour and 7-day uptime, the recent "
        "change-tracking feed, and recent outages. Answer accurately from this data, lead with "
        "anything currently down or notably unstable when relevant, and reference specific IPs, "
        "hostnames and times. Be concise, and if the data doesn't cover something, say so rather "
        "than guessing.\n\n"
        + network_ctx
    )
    return system_msg


@app.post("/api/chat")
async def chat_endpoint(req: ChatReq):
    system_msg = _chat_context()
    messages = [{"role": m.role, "content": m.content} for m in req.messages]
    try:
        response = await chat(messages, model=req.model or get_default_model(), system=system_msg)
    except LLMError as e:
        raise HTTPException(503, str(e))
    return {"response": response, "model": req.model or get_default_model()}


@app.post("/api/chat/stream")
async def chat_stream_endpoint(req: ChatReq):
    system_msg = _chat_context()
    messages = [{"role": m.role, "content": m.content} for m in req.messages]
    model = req.model or get_default_model()

    async def gen():
        try:
            async for chunk in chat_stream(messages, model=model, system=system_msg):
                yield chunk
        except LLMError as e:
            yield f"\n\n[AI error: {e}]"

    return StreamingResponse(gen(), media_type="text/plain; charset=utf-8")


# ── Settings ─────────────────────────────────────────────────────────────────

class LLMSettingsIn(BaseModel):
    provider:     Optional[str] = None
    base_url:     Optional[str] = None
    api_key:      Optional[str] = None   # send existing masked value to leave unchanged
    model:        Optional[str] = None
    timeout:      Optional[int] = None
    long_timeout: Optional[int] = None


_MASKED = "••••••••"


class NotificationSettingsIn(BaseModel):
    enabled:              Optional[bool] = None
    server:               Optional[str]  = None
    topic:                Optional[str]  = None
    token:                Optional[str]  = None
    check_seconds:        Optional[int]  = None
    alert_after_minutes:  Optional[int]  = None
    quiet_enabled:        Optional[bool] = None
    quiet_start:          Optional[str]  = None
    quiet_end:            Optional[str]  = None
    suppress_when_host_down: Optional[bool] = None


class StatusPageSettingsIn(BaseModel):
    enabled: Optional[bool] = None
    url:     Optional[str]  = None
    token:   Optional[str]  = None


@app.get("/api/settings")
def get_settings():
    cfg = get_config()
    llm = dict(cfg["llm"])
    has_key = bool(llm.get("api_key"))
    llm["api_key"] = _MASKED if has_key else ""
    llm["configured"] = is_configured()

    ntfy = dict(cfg["notifications"])
    ntfy["token"] = _MASKED if ntfy.get("token") else ""
    mon = cfg["monitoring"]
    ntfy["check_seconds"] = mon.get("check_seconds", 60)
    ntfy["alert_after_minutes"] = mon.get("alert_after_minutes", 5)
    ntfy["quiet_enabled"] = mon.get("quiet_enabled", False)
    ntfy["quiet_start"]   = mon.get("quiet_start", "")
    ntfy["quiet_end"]     = mon.get("quiet_end", "")
    ntfy["suppress_when_host_down"] = mon.get("suppress_when_host_down", True)

    sp = dict(cfg["statuspage"])
    sp["token"] = _MASKED if sp.get("token") else ""
    ca = dict(cfg["change_alerts"])
    ca.pop("last_digest", None)   # runtime state, not a user setting
    return {"general": dict(cfg["general"]),
            "llm": llm, "notifications": ntfy, "statuspage": sp,
            "change_tracking": dict(cfg["change_tracking"]),
            "change_alerts": ca,
            "liveness": dict(cfg["liveness"]),
            "ip_history": dict(cfg["ip_history"]),
            "security": dict(cfg["security"])}


class ChangeTrackingIn(BaseModel):
    enabled:          Optional[bool] = None
    host_new:         Optional[bool] = None
    port_opened:      Optional[bool] = None
    port_closed:      Optional[bool] = None
    mac_changed:      Optional[bool] = None
    hostname_changed: Optional[bool] = None
    host_offline:     Optional[bool] = None
    host_online:      Optional[bool] = None
    retention_days:   Optional[int]  = None


class IpHistoryIn(BaseModel):
    stale_days: Optional[int] = None
    gone_days:  Optional[int] = None


class LivenessIn(BaseModel):
    enabled:          Optional[bool] = None
    interval_minutes: Optional[int]  = None
    offline_after:    Optional[int]  = None


class GeneralIn(BaseModel):
    timezone: Optional[str] = None


class ChangeAlertsIn(BaseModel):
    enabled:          Optional[bool] = None
    scope:            Optional[str]  = None   # static | dynamic | all
    host_new:         Optional[bool] = None
    port_opened:      Optional[bool] = None
    port_closed:      Optional[bool] = None
    mac_changed:      Optional[bool] = None
    hostname_changed: Optional[bool] = None
    host_offline:     Optional[bool] = None
    host_online:      Optional[bool] = None
    include_mac:      Optional[bool] = None
    include_aliases:  Optional[bool] = None
    on_scan:          Optional[bool] = None
    digest_enabled:   Optional[bool] = None
    digest_time:      Optional[str]  = None


# Each _apply_* validates one Settings section and writes it into `cfg` (a copy
# from get_config). They raise HTTPException on bad input and never save, so the
# combined PUT /api/settings/all can apply them all and save once — or nothing.

def _apply_general(cfg: dict, data: GeneralIn):
    if data.timezone:
        try:
            from zoneinfo import ZoneInfo
            ZoneInfo(data.timezone)   # validate the IANA name
        except Exception:
            raise HTTPException(422, f"Unknown timezone: {data.timezone}")
    g = cfg.setdefault("general", {})
    if data.timezone is not None:
        g["timezone"] = data.timezone


def _apply_llm(cfg: dict, data: LLMSettingsIn):
    llm = cfg.setdefault("llm", {})
    if data.provider     is not None: llm["provider"]     = data.provider
    if data.base_url     is not None: llm["base_url"]     = data.base_url.strip()
    if data.model        is not None: llm["model"]        = data.model.strip()
    if data.timeout      is not None: llm["timeout"]      = data.timeout
    if data.long_timeout is not None: llm["long_timeout"] = data.long_timeout
    # Only update api_key if it's not the masked placeholder
    if data.api_key is not None and data.api_key != _MASKED:
        llm["api_key"] = data.api_key


def _apply_notifications(cfg: dict, data: NotificationSettingsIn):
    ntfy = cfg.setdefault("notifications", {})
    if data.enabled is not None: ntfy["enabled"] = data.enabled
    if data.server  is not None: ntfy["server"]  = data.server.strip().rstrip("/")
    if data.topic   is not None: ntfy["topic"]   = data.topic.strip()
    # Only update token if it's not the masked placeholder
    if data.token is not None and data.token != _MASKED:
        ntfy["token"] = data.token.strip()
    mon = cfg.setdefault("monitoring", {})
    if data.check_seconds is not None:
        mon["check_seconds"] = max(15, min(600, int(data.check_seconds)))
    if data.alert_after_minutes is not None:
        mon["alert_after_minutes"] = max(0, int(data.alert_after_minutes))
    if data.quiet_enabled is not None:
        mon["quiet_enabled"] = data.quiet_enabled
    if data.quiet_start is not None:
        mon["quiet_start"] = data.quiet_start.strip()
    if data.quiet_end is not None:
        mon["quiet_end"] = data.quiet_end.strip()
    if data.suppress_when_host_down is not None:
        mon["suppress_when_host_down"] = data.suppress_when_host_down


def _apply_statuspage(cfg: dict, data: StatusPageSettingsIn):
    sp = cfg.setdefault("statuspage", {})
    if data.enabled is not None: sp["enabled"] = data.enabled
    if data.url     is not None: sp["url"]     = data.url.strip().rstrip("/")
    if data.token is not None and data.token != _MASKED:
        sp["token"] = data.token.strip()


def _apply_change_tracking(cfg: dict, data: ChangeTrackingIn):
    ct = cfg.setdefault("change_tracking", {})
    for f in ("enabled", "host_new", "port_opened", "port_closed", "mac_changed",
              "hostname_changed", "host_offline", "host_online"):
        v = getattr(data, f)
        if v is not None:
            ct[f] = v
    if data.retention_days is not None:
        ct["retention_days"] = max(1, int(data.retention_days))


def _apply_liveness(cfg: dict, data: LivenessIn):
    lv = cfg.setdefault("liveness", {})
    if data.enabled is not None:          lv["enabled"] = data.enabled
    if data.interval_minutes is not None: lv["interval_minutes"] = max(1, int(data.interval_minutes))
    if data.offline_after is not None:    lv["offline_after"] = max(1, int(data.offline_after))


def _apply_ip_history(cfg: dict, data: IpHistoryIn):
    ih = cfg.setdefault("ip_history", {})
    if data.stale_days is not None: ih["stale_days"] = max(1, int(data.stale_days))
    if data.gone_days is not None:  ih["gone_days"]  = max(1, int(data.gone_days))
    if ih.get("gone_days", 60) < ih.get("stale_days", 30):
        raise HTTPException(422, "'Gone after' must be at least 'Stale after'")


def _apply_change_alerts(cfg: dict, data: ChangeAlertsIn):
    ca = cfg.setdefault("change_alerts", {})
    for f in ("enabled", "host_new", "port_opened", "port_closed", "mac_changed",
              "hostname_changed", "host_offline", "host_online", "include_mac", "include_aliases",
              "on_scan", "digest_enabled"):
        v = getattr(data, f)
        if v is not None:
            ca[f] = v
    if data.digest_time is not None:
        ca["digest_time"] = data.digest_time.strip()
    if data.scope is not None and data.scope in ("static", "dynamic", "all"):
        ca["scope"] = data.scope


class SecurityIn(BaseModel):
    frame_origins: Optional[str] = None


def _apply_security(cfg: dict, data: SecurityIn):
    if data.frame_origins is not None:
        try:
            origins = security.parse_frame_origins(data.frame_origins)
        except ValueError as e:
            raise HTTPException(422, f"Allowed dashboards: {e}")
        cfg.setdefault("security", {})["frame_origins"] = ", ".join(origins)


class AllSettingsIn(BaseModel):
    general:         Optional[GeneralIn]              = None
    llm:             Optional[LLMSettingsIn]          = None
    notifications:   Optional[NotificationSettingsIn] = None
    statuspage:      Optional[StatusPageSettingsIn]   = None
    change_tracking: Optional[ChangeTrackingIn]       = None
    liveness:        Optional[LivenessIn]             = None
    ip_history:      Optional[IpHistoryIn]            = None
    change_alerts:   Optional[ChangeAlertsIn]         = None
    security:        Optional[SecurityIn]             = None


_SECTION_APPLY = {
    "general": _apply_general, "llm": _apply_llm, "notifications": _apply_notifications,
    "statuspage": _apply_statuspage, "change_tracking": _apply_change_tracking,
    "liveness": _apply_liveness, "ip_history": _apply_ip_history,
    "change_alerts": _apply_change_alerts, "security": _apply_security,
}


@app.put("/api/settings/all")
def update_all_settings(data: AllSettingsIn):
    """The Settings dialog's Save: validate every section first, then write the
    config file once. One bad value means nothing is saved."""
    cfg = get_config()
    for section, apply in _SECTION_APPLY.items():
        part = getattr(data, section)
        if part is not None:
            apply(cfg, part)
    save_config(cfg)
    return {"ok": True, **get_settings()}


@app.put("/api/settings/change-tracking")
def update_change_tracking(data: ChangeTrackingIn):
    cfg = get_config()
    _apply_change_tracking(cfg, data)
    save_config(cfg)
    return {"ok": True, "change_tracking": cfg["change_tracking"]}


@app.put("/api/settings/ip-history")
def update_ip_history(data: IpHistoryIn):
    cfg = get_config()
    _apply_ip_history(cfg, data)
    save_config(cfg)
    return {"ok": True, "ip_history": cfg["ip_history"]}


@app.put("/api/settings/general")
def update_general(data: GeneralIn):
    cfg = get_config()
    _apply_general(cfg, data)
    save_config(cfg)
    return {"ok": True, "general": cfg["general"]}


@app.put("/api/settings/liveness")
def update_liveness(data: LivenessIn):
    cfg = get_config()
    _apply_liveness(cfg, data)
    save_config(cfg)
    return {"ok": True, "liveness": cfg["liveness"]}


@app.put("/api/settings/change-alerts")
def update_change_alerts(data: ChangeAlertsIn):
    cfg = get_config()
    _apply_change_alerts(cfg, data)
    save_config(cfg)
    return {"ok": True, "change_alerts": get_settings()["change_alerts"]}


@app.put("/api/settings")
def update_settings(data: LLMSettingsIn):
    cfg = get_config()
    _apply_llm(cfg, data)
    save_config(cfg)
    return {"ok": True, "llm": get_settings()["llm"]}


@app.put("/api/settings/notifications")
def update_notification_settings(data: NotificationSettingsIn):
    cfg = get_config()
    _apply_notifications(cfg, data)
    save_config(cfg)
    return {"ok": True, "notifications": get_settings()["notifications"]}


@app.post("/api/notifications/test")
def test_notification(data: NotificationSettingsIn):
    # Build the config to test with: use posted values, but fall back to the
    # saved token when the field came in masked (user didn't retype it).
    cfg = get_notifications_config()
    test_cfg = {
        "server": (data.server or cfg.get("server") or "").strip().rstrip("/"),
        "topic":  (data.topic  or cfg.get("topic")  or "").strip(),
        "token":  cfg.get("token", ""),
    }
    if data.token is not None and data.token != _MASKED:
        test_cfg["token"] = data.token.strip()
    ok, err = notify.send_with(
        test_cfg,
        title="Boltarr",
        message="Test notification — your Boltarr alerts are working.",
        tags=["white_check_mark"],
    )
    return {"ok": ok, "error": err}


@app.put("/api/settings/statuspage")
def update_statuspage_settings(data: StatusPageSettingsIn):
    cfg = get_config()
    _apply_statuspage(cfg, data)
    save_config(cfg)
    return {"ok": True, "statuspage": get_settings()["statuspage"]}


@app.post("/api/statuspage/test")
def test_statuspage_push():
    ok, err = monitor.push_status()
    return {"ok": ok, "error": err}


@app.post("/api/settings/test")
async def test_llm_connection():
    try:
        models = await list_models()
        return {"ok": True, "models": models}
    except LLMError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/api/models")
async def get_models():
    """Models to pick from, plus the default from Settings → AI (every model
    picker starts on it). A default the provider doesn't list is kept first."""
    models = await list_models()
    default = get_llm_config().get("model") or ""
    if models and default and default not in models:
        models = [default, *models]
    return {"models": models, "default": default if models else ""}


# ── Graph ─────────────────────────────────────────────────────────────────────

@app.get("/api/graph")
def get_graph():
    with get_conn() as conn:
        hosts = [dict(h) for h in conn.execute("SELECT * FROM hosts")]
        host_ips = {h["ip"] for h in hosts}
        conns = [dict(c) for c in conn.execute("SELECT * FROM connections")]

        # Build per-connection VLAN map in one query
        cv_rows = conn.execute("""
            SELECT cv.connection_id, v.id, v.tag, v.name, v.color
            FROM connection_vlans cv JOIN vlans v ON cv.vlan_id = v.id
            ORDER BY cv.connection_id, v.tag
        """).fetchall()
        cv_map: dict = {}
        for row in cv_rows:
            cid = row["connection_id"]
            if cid not in cv_map:
                cv_map[cid] = []
            cv_map[cid].append({"id": row["id"], "tag": row["tag"],
                                 "name": row["name"], "color": row["color"]})

        # Build alias map for nodes
        alias_rows = conn.execute("SELECT host_id, ip FROM host_aliases ORDER BY ip").fetchall()
        node_alias_map: dict = {}
        for a in alias_rows:
            node_alias_map.setdefault(a["host_id"], []).append(a["ip"])

        nodes = []
        open_by = _rows_by_host(conn, "SELECT host_id, port, service FROM ports WHERE state='open'")
        for h in hosts:
            ports = open_by.get(h["id"], [])
            synthetic = h["ip"].startswith("node-")
            label = h.get("hostname") or ("" if synthetic else h["ip"])
            nodes.append({
                "data": {
                    "id": h["ip"],
                    "label": label,
                    "ip": h["ip"],
                    "synthetic": synthetic,
                    "device_type": h.get("device_type") or "unknown",
                    "os": h.get("os_guess") or "",
                    "vendor": h.get("vendor") or "",
                    "open_ports": len(ports),
                    "services": [p["service"] for p in ports if p["service"]],
                    "last_seen": h.get("last_seen") or "",
                    "pos_x": h.get("pos_x"),
                    "pos_y": h.get("pos_y"),
                    "tier": h.get("tier"),
                    "port_count": h.get("port_count") or 1,
                    "has_wifi": bool(h.get("has_wifi")),
                    "is_dns":  bool(h.get("is_dns")),
                    "is_dhcp": bool(h.get("is_dhcp")),
                    "dhcp_pool": h.get("dhcp_pool") or "",
                    "aliases": node_alias_map.get(h["id"], []),
                }
            })

        edges = [
            {
                "data": {
                    "id": f"e{c['id']}",
                    "source": c["src_ip"],
                    "target": c["dst_ip"],
                    "type": c["type"],
                    "label": c.get("label") or "",
                    "port_mode": c.get("port_mode") or "",
                    "speed": c.get("speed") or "",
                    "tagged_only": bool(c.get("tagged_only")),
                    "vlans": cv_map.get(c["id"], []),
                    "connection_id": c["id"],
                }
            }
            for c in conns
            if c["src_ip"] in host_ips and c["dst_ip"] in host_ips
        ]

    return JSONResponse({"nodes": nodes, "edges": edges})   # plain data: fast path


# ── SSH Key Management ────────────────────────────────────────────────────────

import base64, hashlib

def _ssh_fingerprint(public_key: str) -> str:
    try:
        key_data = base64.b64decode(public_key.strip().split()[1])
        digest = hashlib.sha256(key_data).digest()
        return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")
    except Exception:
        return ""

@app.get("/api/ssh-keys")
def list_ssh_keys():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, public_key, fingerprint, created_at FROM ssh_keys ORDER BY name"
        ).fetchall()
    return [dict(r) for r in rows]

@app.post("/api/ssh-keys", status_code=201)
def add_ssh_key(data: SshKeyIn):
    key = data.public_key.strip()
    if not key.startswith("ssh-"):
        raise HTTPException(400, "Invalid public key format")
    fp = _ssh_fingerprint(key)
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO ssh_keys (name, public_key, fingerprint) VALUES (?,?,?)",
            (data.name.strip(), key, fp)
        )
        conn.commit()
        row = conn.execute("SELECT * FROM ssh_keys WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(row)

@app.delete("/api/ssh-keys/{key_id}", status_code=204)
def delete_ssh_key(key_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM ssh_keys WHERE id=?", (key_id,))
        conn.commit()

# ── Backup & Restore ─────────────────────────────────────────────────────────

_DATA_DIR = Path(os.environ.get("BOLTARR_DATA_DIR") or (Path(__file__).parent.parent / "data"))

_BACKUP_MIN_PASSWORD = 8


def _build_backup(password: Optional[str] = None) -> bytes:
    """Zip of boltarr.db + config.yaml + manifest.json. With a password every
    file is AES-256 encrypted (a standard encrypted zip: 7-Zip/WinRAR open it)."""
    import pyzipper
    buf = io.BytesIO()
    if password:
        zf = pyzipper.AESZipFile(buf, "w", compression=pyzipper.ZIP_DEFLATED, encryption=pyzipper.WZ_AES)
        zf.setpassword(password.encode())
    else:
        zf = zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED)
    with zf:
        db_path = _DATA_DIR / "boltarr.db"
        cfg_path = _DATA_DIR / "config.yaml"
        if db_path.exists():
            # Checkpoint WAL so the main file is up to date
            try:
                conn = _sqlite3.connect(str(db_path))
                conn.execute("PRAGMA wal_checkpoint(FULL)")
                conn.close()
            except Exception:
                pass
            zf.write(db_path, "boltarr.db")
        if cfg_path.exists():
            zf.write(cfg_path, "config.yaml")
        # What this backup is — shown before a restore (older backups lack it)
        zf.writestr("manifest.json", json.dumps({
            "app": "boltarr", "version": APP_VERSION, "protected": bool(password),
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}))
    return buf.getvalue()


def _backup_response(data: bytes, protected: bool):
    date = datetime.now().strftime("%Y-%m-%d")
    name = f"boltarr-backup-{date}{'-protected' if protected else ''}.zip"
    return StreamingResponse(io.BytesIO(data), media_type="application/zip",
                             headers={"Content-Disposition": f"attachment; filename={name}"})


@app.get("/api/backup")
def backup():
    """Unprotected backup (scripts and older clients)."""
    return _backup_response(_build_backup(), False)


class BackupIn(BaseModel):
    password: Optional[str] = None   # empty/None = no protection


@app.post("/api/backup")
def backup_with_options(data: BackupIn):
    pw = data.password or None
    if pw and len(pw) < _BACKUP_MIN_PASSWORD:
        raise HTTPException(422, f"Backup password must be at least {_BACKUP_MIN_PASSWORD} characters")
    return _backup_response(_build_backup(pw), bool(pw))


# A restore is two calls: /api/restore/check uploads and inspects the backup
# (nothing live changes) and parks it; /api/restore/{token} then applies it.
# Only one backup is parked at a time, for up to 30 minutes.
_STAGE_TTL = 1800
_staged: dict = {}


def _db_counts(conn) -> dict:
    out = {}
    for key, table in (("hosts", "hosts"), ("services", "services"), ("subnets", "subnets"),
                       ("connections", "connections")):
        try:
            out[key] = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        except Exception:
            out[key] = None
    return out


def _backup_password_error(code: str, message: str):
    return HTTPException(422, {"code": code, "message": message})


def _inspect_backup(data: bytes, password: Optional[str] = None) -> tuple[dict, bytes, Optional[bytes]]:
    """Validate a backup zip without touching live data. Returns (summary,
    db bytes, config bytes or None); raises HTTPException(400) if unusable, or
    422 {code: password_required | wrong_password} for a protected backup."""
    import pyzipper
    try:
        zf = pyzipper.AESZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, pyzipper.BadZipFile):
        raise HTTPException(400, "Not a valid ZIP file")
    names = zf.namelist()
    protected = any(i.flag_bits & 0x1 for i in zf.infolist())
    if protected:
        if not password:
            raise _backup_password_error("password_required", "This backup is password-protected")
        zf.setpassword(password.encode())
        try:
            zf.read(names[0])
        except RuntimeError:
            raise _backup_password_error("wrong_password", "Wrong password for this backup")
    # Zip slip protection
    for name in names:
        if name.startswith("/") or ".." in name:
            raise HTTPException(400, "Invalid file in ZIP")
    if "boltarr.db" not in names:
        raise HTTPException(400, "ZIP does not contain boltarr.db")

    manifest = {}
    if "manifest.json" in names:
        try:
            manifest = json.loads(zf.read("manifest.json"))
        except Exception:
            manifest = {}
    db_bytes = zf.read("boltarr.db")
    cfg_bytes = zf.read("config.yaml") if "config.yaml" in names else None
    if cfg_bytes is not None:
        try:
            import yaml
            if not isinstance(yaml.safe_load(cfg_bytes) or {}, dict):
                raise ValueError
        except Exception:
            raise HTTPException(400, "config.yaml in the backup is not valid")

    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp:
        tmp.write(db_bytes)
        tmp_path = tmp.name
    try:
        conn = _sqlite3.connect(tmp_path)
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise HTTPException(400, "Database file is corrupt")
        tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        if "hosts" not in tables:
            raise HTTPException(400, "This doesn't look like a Boltarr database")
        counts = _db_counts(conn)
        conn.close()
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(400, "Database file is corrupt")
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    created = manifest.get("created_at")
    if not created:   # older backup: fall back to when the DB was zipped
        info = zf.getinfo("boltarr.db")
        created = datetime(*info.date_time).isoformat(timespec="seconds")
    return ({"created_at": created, "version": manifest.get("version"),
             "has_manifest": bool(manifest), "has_settings": cfg_bytes is not None,
             "protected": protected, "counts": counts}, db_bytes, cfg_bytes)


def _scan_running() -> bool:
    return any(j.get("status") == "running" for j in scan_jobs.values())


def _apply_restore(db_bytes: bytes, cfg_bytes: Optional[bytes]) -> None:
    """Copy the backup into the live database in place (SQLite backup API), so
    open connections see the restored data at once — no restart needed."""
    from . import maintenance
    with maintenance.exclusive():
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False, dir=str(_DATA_DIR)) as tmp:
            tmp.write(db_bytes)
            tmp_path = tmp.name
        try:
            src = _sqlite3.connect(tmp_path)
            dst = get_conn()
            try:
                src.backup(dst)          # one step: atomic for other readers/writers
            finally:
                src.close(); dst.close()
        finally:
            Path(tmp_path).unlink(missing_ok=True)
        if cfg_bytes is not None:
            cfg_tmp = _DATA_DIR / "config.yaml.tmp"
            cfg_tmp.write_bytes(cfg_bytes)
            os.replace(cfg_tmp, _DATA_DIR / "config.yaml")
            invalidate_config_cache()
        # Bring an older backup up to the current schema (idempotent, additive)
        init_db()


def _announce_restore(summary: dict) -> None:
    try:
        notify.send(title="Boltarr was restored from a backup",
                    message=f"Backup dated {summary['created_at'][:16].replace('T', ' ')}"
                            + (f" (Boltarr {summary['version']})" if summary.get("version") else "")
                            + f" — {summary['counts'].get('hosts') or 0} hosts, "
                              f"{summary['counts'].get('services') or 0} services.",
                    tags=["recycle"])
    except Exception:
        pass


@app.post("/api/restore/check")
async def restore_check(file: UploadFile = File(...), password: Optional[str] = Form(None)):
    """Step 1: inspect an uploaded backup. Nothing live changes."""
    summary, db_bytes, cfg_bytes = _inspect_backup(await file.read(), password)
    with get_conn() as conn:
        current = _db_counts(conn)
    token = uuid.uuid4().hex
    _staged.clear()
    _staged[token] = {"summary": summary, "db": db_bytes, "cfg": cfg_bytes,
                      "expires": datetime.now(timezone.utc) + timedelta(seconds=_STAGE_TTL)}
    return {"token": token, "backup": summary, "current": current,
            "current_version": APP_VERSION, "scan_running": _scan_running()}


@app.delete("/api/restore/{token}")
def restore_cancel(token: str):
    _staged.pop(token, None)
    return {"ok": True}


@app.post("/api/restore/{token}")
def restore_apply(token: str):
    """Step 2: apply a backup parked by /api/restore/check."""
    st = _staged.get(token)
    if not st or st["expires"] < datetime.now(timezone.utc):
        _staged.pop(token, None)
        raise HTTPException(410, "This upload has expired — please choose the backup file again")
    if _scan_running():
        raise HTTPException(409, "A scan is running — wait for it to finish (or cancel it), then restore")
    try:
        _apply_restore(st["db"], st["cfg"])
    except (TimeoutError, RuntimeError) as e:
        raise HTTPException(409, str(e))
    except _sqlite3.Error as e:   # the copy is all-or-nothing, so live data is untouched
        raise HTTPException(500, f"Restore failed, nothing was changed: {e}")
    _staged.pop(token, None)
    _announce_restore(st["summary"])
    return {"ok": True, "backup": st["summary"]}


@app.post("/api/restore")
async def restore(file: UploadFile = File(...), password: Optional[str] = Form(None)):
    """One-shot restore (check + apply) for scripts and older clients."""
    summary, db_bytes, cfg_bytes = _inspect_backup(await file.read(), password)
    if _scan_running():
        raise HTTPException(409, "A scan is running — wait for it to finish (or cancel it), then restore")
    try:
        _apply_restore(db_bytes, cfg_bytes)
    except (TimeoutError, RuntimeError) as e:
        raise HTTPException(409, str(e))
    except _sqlite3.Error as e:
        raise HTTPException(500, f"Restore failed, nothing was changed: {e}")
    _announce_restore(summary)
    return {"ok": True, "backup": summary}


class FactoryResetIn(BaseModel):
    keep_settings: bool = True   # keep config.yaml (ntfy/statuspage/timezone/LLM)


@app.post("/api/factory-reset")
def factory_reset(data: FactoryResetIn):
    """Wipe all network data. Row-deletes (no file swap) so no restart needed.
    keep_settings=False also resets config.yaml to defaults."""
    with get_conn() as conn:
        conn.execute("PRAGMA foreign_keys=OFF")
        tables = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        for t in tables:
            conn.execute(f"DELETE FROM {t}")
        conn.commit()
    init_db()   # re-ensure schema + re-seed the built-in scan profiles
    if not data.keep_settings:
        (_DATA_DIR / "config.yaml").unlink(missing_ok=True)   # back to defaults
        invalidate_config_cache()
    return {"ok": True, "settings_kept": data.keep_settings}


# ── Static files (must be last) ───────────────────────────────────────────────

app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
