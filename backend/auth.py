"""Login: one admin account, signed session cookies, optional trusted auth proxy.

Off until a password is set (upgrades keep working as before). A fresh install
starts with `setup_pending`, which shows the "create password" screen first.

- Passwords: scrypt (stdlib), stored as "scrypt$n$r$p$salt$hash".
- Sessions: a stateless cookie "<payload>.<hmac>" signed with auth.secret. The
  payload carries a fingerprint of the password hash, so changing the password
  logs out every other browser.
- Forged requests from other sites: the cookie is SameSite=Lax, and every
  state-changing /api call must carry the X-Boltarr header, which a browser
  only lets Boltarr's own pages send (cross-site it needs CORS, which we don't
  allow).
- Trusted proxy: when on, a request from a listed proxy IP that carries the
  proxy's user header (e.g. Remote-User from Authelia/Authentik) is logged in.
"""
import base64
import hashlib
import hmac
import ipaddress
import json
import secrets
import threading
import time
from typing import Optional

from .config import get_config, save_config

COOKIE = "boltarr_session"
CSRF_HEADER = "x-boltarr"
MIN_PASSWORD = 8

# Reachable without logging in: the login page and what it needs, the version
# endpoint (Docker health checks), and the browser's security reports.
OPEN_PATHS = {"/login.html", "/js/login.js", "/js/peek.js", "/css/style.css", "/api/version",
              "/api/auth/status", "/api/auth/login", "/api/auth/setup", "/api/auth/skip-setup",
              "/api/auth/logout", "/api/csp-report"}
OPEN_PREFIXES = ("/img/", "/vendor/")


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


# ── Passwords ─────────────────────────────────────────────────────────────────

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    n, r, p = 2 ** 14, 8, 1
    h = hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, dklen=32)
    return f"scrypt${n}${r}${p}${_b64(salt)}${_b64(h)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, h = stored.split("$")
        if algo != "scrypt":
            return False
        got = hashlib.scrypt(password.encode(), salt=_unb64(salt), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(got, _unb64(h))
    except Exception:
        return False


# ── Sessions ──────────────────────────────────────────────────────────────────

def ensure_secret(cfg: dict) -> str:
    a = cfg.setdefault("auth", {})
    if not a.get("secret"):
        a["secret"] = secrets.token_hex(32)
    return a["secret"]


def _pw_fingerprint(a: dict) -> str:
    return hashlib.sha256((a.get("password_hash") or "").encode()).hexdigest()[:16]


def _sign(secret: str, payload: str) -> str:
    return _b64(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())


def make_session(a: dict) -> str:
    payload = _b64(json.dumps({"u": a.get("username") or "admin",
                               "exp": int(time.time()) + int(a.get("session_days") or 30) * 86400,
                               "pv": _pw_fingerprint(a)}).encode())
    return f"{payload}.{_sign(a['secret'], payload)}"


def read_session(a: dict, token: Optional[str]) -> Optional[str]:
    """Username from a valid session cookie, else None."""
    if not token or "." not in token or not a.get("secret"):
        return None
    payload, sig = token.rsplit(".", 1)
    if not hmac.compare_digest(sig, _sign(a["secret"], payload)):
        return None
    try:
        data = json.loads(_unb64(payload))
    except Exception:
        return None
    if data.get("exp", 0) < time.time() or data.get("pv") != _pw_fingerprint(a):
        return None
    return data.get("u")


# ── Trusted proxy ─────────────────────────────────────────────────────────────

def parse_proxies(text: str) -> list:
    """'10.0.0.5, 172.18.0.0/16' -> networks. Raises ValueError on a bad entry."""
    nets = []
    for part in (text or "").replace("\n", ",").split(","):
        part = part.strip()
        if part:
            nets.append(ipaddress.ip_network(part, strict=False))
    return nets


def proxy_user(a: dict, client_ip: Optional[str], headers) -> Optional[str]:
    if not a.get("trust_proxy") or not client_ip:
        return None
    try:
        ip = ipaddress.ip_address(client_ip)
        if not any(ip in n for n in parse_proxies(a.get("trusted_proxies", ""))):
            return None
    except ValueError:
        return None
    user = headers.get(a.get("proxy_header") or "Remote-User")
    return user.strip() if user and user.strip() else None


# ── State helpers ─────────────────────────────────────────────────────────────

def auth_config() -> dict:
    return get_config()["auth"]


def login_required(a: dict) -> bool:
    """Is the app gated right now? (login on, or a fresh install awaiting setup)"""
    return bool((a.get("enabled") and a.get("password_hash")) or a.get("setup_pending"))


def current_user(a: dict, request) -> Optional[str]:
    if not (a.get("enabled") and a.get("password_hash")):
        return None
    client = request.client.host if request.client else None
    return proxy_user(a, client, request.headers) or read_session(a, request.cookies.get(COOKIE))


def set_password(username: str, password: str) -> dict:
    """Turn login on with these credentials. Returns the saved auth section."""
    cfg = get_config()
    a = cfg["auth"]
    a.update({"enabled": True, "username": username.strip() or "admin",
              "password_hash": hash_password(password), "setup_pending": False})
    ensure_secret(cfg)
    save_config(cfg)
    return cfg["auth"]


def clear_password(rotate_secret: bool = True) -> None:
    """Turn login off (also what the reset-password command does)."""
    cfg = get_config()
    cfg["auth"].update({"enabled": False, "password_hash": "", "setup_pending": False,
                        "trust_proxy": False})
    if rotate_secret:
        cfg["auth"]["secret"] = secrets.token_hex(32)
    save_config(cfg)


# ── Wrong-password slowdown ───────────────────────────────────────────────────
# After 5 wrong tries from one address, each further try is refused for a
# growing wait (15s, 30s, 60s … capped at 5 minutes). A success clears it.

_FREE_TRIES = 5
_fails: dict[str, tuple[int, float]] = {}
_fails_lock = threading.Lock()


_FAILS_MAX = 10000                  # addresses remembered (memory stays bounded)


def retry_after(ip: str) -> int:
    with _fails_lock:
        _, until = _fails.get(ip, (0, 0.0))
    return max(0, int(until - time.time() + 0.999))


def record_failure(ip: str) -> None:
    with _fails_lock:
        if ip not in _fails and len(_fails) >= _FAILS_MAX:
            now = time.time()
            for k in [k for k, (_, u) in _fails.items() if u < now]:
                _fails.pop(k, None)
            if len(_fails) >= _FAILS_MAX:
                _fails.pop(next(iter(_fails)))
        count, _ = _fails.get(ip, (0, 0.0))
        count += 1
        wait = min(300, 15 * 2 ** (count - _FREE_TRIES)) if count >= _FREE_TRIES else 0
        _fails[ip] = (count, time.time() + wait)


def record_success(ip: str) -> None:
    with _fails_lock:
        _fails.pop(ip, None)
