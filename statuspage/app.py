"""Boltarr public status page — receiver + hardened server.

Boltarr (internal) pushes a sanitized payload to POST /push over the LAN,
authenticated with a shared bearer token. Visitors get a read-only page (GET /)
that renders the latest payload from GET /data.

Section visibility (Services / Hosts / Networking) is Public or Private, set from
the admin panel. Private sections are pushed here but only ever served to an
authenticated admin — an anonymous /data response never contains them. The app
is designed to be safe when exposed to the internet; see README (Hardening).
"""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, Response

# ── Config (all from env; secrets live in .env, never committed) ───────────────
TOKEN          = os.environ.get("STATUS_TOKEN", "")
ADMIN_PASSWORD = os.environ.get("STATUS_ADMIN_PASSWORD", "")
STATE_FILE     = Path(os.environ.get("STATE_FILE", "/data/state.json"))
DB_FILE        = Path(os.environ.get("DB_FILE", "/data/statuspage.db"))
SESSION_TTL    = int(os.environ.get("STATUS_SESSION_TTL", str(30 * 24 * 3600)))  # 30 days
# Secure cookies require HTTPS. Keep the default TRUE for internet exposure; set
# STATUS_COOKIE_SECURE=false only for local http testing.
COOKIE_SECURE  = os.environ.get("STATUS_COOKIE_SECURE", "true").lower() not in ("0", "false", "no")
# Only trust X-Forwarded-For if you run behind a proxy you control (else an
# attacker can spoof it to dodge the login rate limit).
TRUST_PROXY    = os.environ.get("TRUST_PROXY", "false").lower() in ("1", "true", "yes")

COOKIE_NAME = "boltarr_session"
SECTIONS    = ("services", "hosts", "networking")
BASE_DIR    = Path(__file__).parent
STATIC_DIR  = BASE_DIR / "static"

# No interactive/API docs surface on a public box.
app = FastAPI(title="Boltarr Status Page", docs_url=None, redoc_url=None, openapi_url=None)


# ── Storage: SQLite for admin-owned settings; JSON blob for the last push ──────
def _db() -> sqlite3.Connection:
    DB_FILE.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _db() as c:
        c.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)")
        for k, v in {"vis_services": "public", "vis_hosts": "private",
                     "vis_networking": "private"}.items():
            c.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (k, v))
        if not c.execute("SELECT 1 FROM settings WHERE key='session_secret'").fetchone():
            c.execute("INSERT INTO settings (key, value) VALUES ('session_secret', ?)",
                      (secrets.token_hex(32),))
        c.commit()


def get_setting(key: str, default: str | None = None) -> str | None:
    with _db() as c:
        row = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    with _db() as c:
        c.execute("INSERT INTO settings (key, value) VALUES (?, ?) "
                  "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))
        c.commit()


def get_visibility() -> dict:
    return {s: get_setting(f"vis_{s}", "private") for s in SECTIONS}


def set_visibility(vis: dict) -> None:
    for s in SECTIONS:
        if vis.get(s) in ("public", "private"):
            set_setting(f"vis_{s}", vis[s])


# ── Sessions: stateless HMAC-signed cookie (stdlib only) ───────────────────────
def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _secret() -> bytes:
    env = os.environ.get("STATUS_SESSION_SECRET", "")
    if env:
        return hashlib.sha256(env.encode()).digest()
    return bytes.fromhex(get_setting("session_secret"))  # persisted random fallback


def _sign(body: str) -> str:
    return _b64e(hmac.new(_secret(), body.encode(), hashlib.sha256).digest())


def make_session() -> str:
    payload = {"iat": int(time.time()), "exp": int(time.time()) + SESSION_TTL}
    body = _b64e(json.dumps(payload, separators=(",", ":")).encode())
    return f"{body}.{_sign(body)}"


def verify_session(token: str) -> bool:
    if not token or token.count(".") != 1:
        return False
    body, sig = token.split(".")
    if not hmac.compare_digest(sig, _sign(body)):
        return False
    try:
        return int(json.loads(_b64d(body)).get("exp", 0)) > int(time.time())
    except Exception:
        return False


def csrf_for(token: str) -> str:
    # Deterministic CSRF token bound to the session cookie (double-submit).
    return _b64e(hmac.new(_secret(), f"csrf:{token}".encode(), hashlib.sha256).digest())


def is_admin(request: Request) -> bool:
    return verify_session(request.cookies.get(COOKIE_NAME, ""))


# ── Login brute-force limiter (in-memory) ──────────────────────────────────────
_ATTEMPTS: dict[str, list[float]] = {}
_MAX_FAILS = 8       # failures within the window before lockout
_WINDOW    = 600     # 10 min sliding window
_LOCKOUT   = 900     # 15 min lock once tripped


def _client_ip(request: Request) -> str:
    if TRUST_PROXY:
        xff = request.headers.get("x-forwarded-for", "")
        if xff:
            return xff.split(",")[0].strip()
    return request.client.host if request.client else "?"


def _locked_for(ip: str) -> float:
    now = time.time()
    fails = [t for t in _ATTEMPTS.get(ip, []) if now - t < _LOCKOUT]
    _ATTEMPTS[ip] = fails
    recent = [t for t in fails if now - t < _WINDOW]
    if len(recent) >= _MAX_FAILS:
        return _LOCKOUT - (now - min(recent))
    return 0.0


def _record_fail(ip: str) -> None:
    _ATTEMPTS.setdefault(ip, []).append(time.time())


# ── Security headers on every response ─────────────────────────────────────────
_CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["Content-Security-Policy"] = _CSP
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=(), payment=(), usb=()"
    resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    resp.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    if COOKIE_SECURE:  # only meaningful over HTTPS
        resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return resp


# ── Pushed payload (blob) ──────────────────────────────────────────────────────
def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"updated_at": None, "title": "Service Status",
            "services": [], "hosts": [], "networking": [], "announcements": []}


STATE = load_state()


@app.on_event("startup")
def _startup() -> None:
    init_db()


# ── Endpoints ──────────────────────────────────────────────────────────────────
@app.post("/push")
async def push(request: Request, authorization: str = Header(default="")):
    if not TOKEN or not hmac.compare_digest(authorization, f"Bearer {TOKEN}"):
        raise HTTPException(status_code=401, detail="unauthorized")
    body = await request.body()
    if len(body) > 512 * 1024:
        raise HTTPException(status_code=413, detail="payload too large")
    global STATE
    try:
        STATE = json.loads(body)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid json")
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(STATE))
    return {"ok": True}


@app.get("/data")
def data(request: Request):
    admin = is_admin(request)
    vis = get_visibility()
    out = {
        "updated_at": STATE.get("updated_at"),
        "title": STATE.get("title", "Service Status"),
        "announcements": STATE.get("announcements", []),
        "admin": admin,
    }
    # A private section is simply absent from an anonymous response.
    for s in SECTIONS:
        out[s] = STATE.get(s, []) if (admin or vis[s] == "public") else []
    if admin:
        out["visibility"] = vis
        out["private_sections"] = [s for s in SECTIONS if vis[s] == "private"]
        out["csrf"] = csrf_for(request.cookies.get(COOKIE_NAME, ""))
    resp = JSONResponse(out)
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.post("/login")
async def login(request: Request):
    ip = _client_ip(request)
    wait = _locked_for(ip)
    if wait > 0:
        raise HTTPException(status_code=429, detail="too many attempts",
                            headers={"Retry-After": str(int(wait) + 1)})
    if not ADMIN_PASSWORD:  # fail closed — admin access disabled until a password is set
        raise HTTPException(status_code=403, detail="admin login disabled")
    try:
        pw = str((await request.json()).get("password", ""))
    except Exception:
        pw = ""
    await asyncio.sleep(0.4)  # constant throttle to slow scripted guessing
    if not hmac.compare_digest(pw, ADMIN_PASSWORD):
        _record_fail(ip)
        raise HTTPException(status_code=401, detail="invalid credentials")
    _ATTEMPTS.pop(ip, None)
    resp = JSONResponse({"ok": True})
    resp.set_cookie(COOKIE_NAME, make_session(), max_age=SESSION_TTL, httponly=True,
                    secure=COOKIE_SECURE, samesite="lax", path="/")
    return resp


@app.post("/logout")
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp


@app.post("/api/visibility")
async def update_visibility(request: Request, x_csrf: str = Header(default="")):
    if not is_admin(request):
        raise HTTPException(status_code=401, detail="unauthorized")
    if not hmac.compare_digest(x_csrf, csrf_for(request.cookies.get(COOKIE_NAME, ""))):
        raise HTTPException(status_code=403, detail="bad csrf")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid json")
    vis = get_visibility()
    for s in SECTIONS:
        if body.get(s) in ("public", "private"):
            vis[s] = body[s]
    set_visibility(vis)
    return {"ok": True, "visibility": vis}


def _static(path: Path, media_type: str) -> Response:
    if not path.exists():
        raise HTTPException(status_code=404)
    resp = Response(path.read_text(encoding="utf-8"), media_type=media_type)
    resp.headers["Cache-Control"] = "public, max-age=300"
    return resp


@app.get("/static/app.js")
def static_js():
    return _static(STATIC_DIR / "app.js", "application/javascript")


@app.get("/static/style.css")
def static_css():
    return _static(STATIC_DIR / "style.css", "text/css")


@app.get("/healthz", response_class=PlainTextResponse)
def healthz():
    return "ok"


@app.get("/", response_class=HTMLResponse)
def index():
    return (BASE_DIR / "index.html").read_text(encoding="utf-8")
