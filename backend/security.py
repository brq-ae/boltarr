"""Browser security headers, plus a record of what a stricter policy would block.

Every response carries a Content-Security-Policy that only lets the page load
scripts, styles, fonts and data from Boltarr itself, so injected code can't
pull more code in or send data out. Inline code (onclick="…") is still allowed
because the UI uses it throughout.

A second, report-only policy has inline code switched off. The browser blocks
nothing for it, only reports what it would have blocked to /api/csp-report.
Those reports are the to-do list for moving the UI off inline code; once they
stop, the enforced policy can drop 'unsafe-inline'.

Dashboards (Homarr, Organizr, Home Assistant…) may show Boltarr in a frame only
when their address is listed in Settings → Security.
"""
import json
import threading
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlsplit

from .database import get_conn

REPORT_PATH = "/api/csp-report"
_MAX_REPORT_BYTES = 16 * 1024
_MAX_ROWS = 300            # distinct reports kept; repeats only bump a count

_BASE = ("default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
         "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; "
         "form-action 'self'")
# report-uri only: when report-to is also present Chrome ignores report-uri, and
# report-to (the Reporting API) only works over HTTPS — most LAN installs are HTTP.
_REPORT = f"report-uri {REPORT_PATH}"


def parse_frame_origins(text: str) -> list[str]:
    """'https://homarr.lan, http://10.0.0.5:7575' -> clean origins.
    Raises ValueError naming the first entry that isn't a plain http(s) origin."""
    out = []
    for part in (text or "").replace("\n", ",").replace(" ", ",").split(","):
        part = part.strip().rstrip("/")
        if not part:
            continue
        u = urlsplit(part)
        if u.scheme not in ("http", "https") or not u.hostname or u.path or u.query or u.fragment \
                or u.username or any(c in part for c in ";'\""):
            raise ValueError(f"'{part}' isn't a site address like https://homarr.example or http://10.0.0.5:7575")
        if part not in out:
            out.append(part)
    return out


_cache_lock = threading.Lock()
_cache: tuple = ("\0", {})


def headers_for(frame_origins: str) -> dict:
    """Headers for every response. Cached per frame_origins setting."""
    global _cache
    with _cache_lock:
        if _cache[0] == frame_origins:
            return _cache[1]
    try:
        origins = parse_frame_origins(frame_origins)
    except ValueError:
        origins = []                       # a bad saved value fails closed
    ancestors = " ".join(["'self'", *origins])
    h = {
        "Content-Security-Policy":
            f"{_BASE}; script-src 'self' 'unsafe-inline'; frame-ancestors {ancestors}; {_REPORT}",
        "Content-Security-Policy-Report-Only":
            f"script-src 'self' 'report-sample'; {_REPORT}",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    }
    if not origins:
        h["X-Frame-Options"] = "SAMEORIGIN"   # older browsers that ignore frame-ancestors
    with _cache_lock:
        _cache = (frame_origins, h)
    return h


# ── Reports ───────────────────────────────────────────────────────────────────

def _strip_url(u: str) -> str:
    """Drop query strings and fragments — they could carry tokens."""
    if not u or "://" not in u:
        return (u or "")[:200]
    s = urlsplit(u)
    return f"{s.scheme}://{s.netloc}{s.path}"[:200]


def _normalise(r: dict) -> Optional[dict]:
    """Both report formats (report-uri and report-to) -> one shape."""
    directive = r.get("effectiveDirective") or r.get("effective-directive") or r.get("violated-directive") or ""
    if not directive:
        return None
    line = r.get("lineNumber") or r.get("line-number") or 0
    return {
        "mode":      "enforced" if (r.get("disposition") or "enforce") == "enforce" else "strict-check",
        "directive": str(directive).split(" ")[0][:40],
        "blocked":   _strip_url(str(r.get("blockedURL") or r.get("blocked-uri") or "")),
        "source":    _strip_url(str(r.get("sourceFile") or r.get("source-file") or "")),
        "line":      int(line) if str(line).isdigit() else 0,
        "sample":    str(r.get("sample") or r.get("script-sample") or "")[:80],
    }


def parse_reports(raw: bytes) -> list[dict]:
    if len(raw) > _MAX_REPORT_BYTES:
        return []
    try:
        data = json.loads(raw)
    except ValueError:
        return []
    items = []
    if isinstance(data, dict) and isinstance(data.get("csp-report"), dict):
        items = [data["csp-report"]]
    elif isinstance(data, list):
        items = [d.get("body") for d in data[:20]
                 if isinstance(d, dict) and d.get("type") == "csp-violation" and isinstance(d.get("body"), dict)]
    return [n for n in (_normalise(i) for i in items) if n]


def record(reports: list[dict]) -> None:
    if not reports:
        return
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with get_conn() as conn:
        for r in reports:
            key = (r["mode"], r["directive"], r["blocked"], r["source"], r["line"], r["sample"])
            cur = conn.execute(
                """UPDATE csp_reports SET count = count + 1, last_seen = ?
                   WHERE mode=? AND directive=? AND blocked=? AND source=? AND line=? AND sample=?""",
                (now, *key))
            if cur.rowcount == 0:
                (n,) = conn.execute("SELECT COUNT(*) FROM csp_reports").fetchone()
                if n < _MAX_ROWS:
                    conn.execute(
                        """INSERT INTO csp_reports (mode, directive, blocked, source, line, sample,
                                                    count, first_seen, last_seen)
                           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)""", (*key, now, now))
        conn.commit()


def list_reports() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT mode, directive, blocked, source, line, sample, count, first_seen, last_seen
               FROM csp_reports ORDER BY mode = 'enforced' DESC, count DESC, last_seen DESC""").fetchall()
    return [dict(r) for r in rows]


def clear_reports() -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM csp_reports")
        conn.commit()
