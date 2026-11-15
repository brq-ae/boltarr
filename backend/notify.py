"""ntfy push notifications.

Small helper the rest of Boltarr calls to alert the user's phone.
Config (server, topic, token) comes from data/config.yaml via config.py —
nothing is hardcoded here.
"""
import threading
import time
from datetime import datetime, timezone

import httpx

from .config import get_notifications_config

# F-27: the last send result, shown in Settings → Notifications. After a failure,
# deliver() skips the network for BACKOFF seconds, so a dead ntfy can't make every
# alert in one check round wait for its own time-out.
BACKOFF = 30
_lock = threading.Lock()
_health = {"last_ok": None, "last_error": None, "last_error_at": None}
_fail_mono = 0.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def health() -> dict:
    with _lock:
        return dict(_health)


def _note(ok: bool, err: str = "") -> None:
    global _fail_mono
    with _lock:
        if ok:
            _health["last_ok"] = _now_iso()
            _fail_mono = 0.0
        else:
            _health["last_error"] = (err or "unknown error")[:300]
            _health["last_error_at"] = _now_iso()
            _fail_mono = time.monotonic()


def _endpoint(cfg: dict) -> str:
    server = (cfg.get("server") or "").rstrip("/")
    topic = (cfg.get("topic") or "").strip()
    return f"{server}/{topic}"


def _safe_header(s: str) -> str:
    """HTTP header values must be ASCII (httpx/h11 reject anything else).
    Titles may contain emoji/unicode (service names, etc.), so drop
    non-ASCII and trim rather than letting the whole request crash. The
    full unicode text still shows in the message body (sent as UTF-8);
    put emoji in `tags`, not titles."""
    return s.encode("ascii", "ignore").decode("ascii").strip()


def _build_headers(cfg: dict, title: str, priority: str, tags: list[str] | None) -> dict:
    headers = {"Title": _safe_header(title), "Priority": priority}
    if tags:
        headers["Tags"] = ",".join(tags)
    if cfg.get("token"):
        headers["Authorization"] = f"Bearer {cfg['token']}"
    return headers


def send(title: str, message: str, priority: str = "default",
         tags: list[str] | None = None) -> tuple[bool, str]:
    """Send a notification. Returns (ok, error_message).

    A no-op returning (False, reason) if notifications are disabled or
    not configured — callers can ignore the result for fire-and-forget.
    """
    cfg = get_notifications_config()
    if not cfg.get("enabled"):
        return False, "notifications disabled"
    if not cfg.get("server") or not cfg.get("topic"):
        return False, "server or topic not configured"

    headers = _build_headers(cfg, title, priority, tags)
    try:
        with httpx.Client(timeout=10) as client:
            r = client.post(_endpoint(cfg), data=message.encode("utf-8"), headers=headers)
            r.raise_for_status()
    except Exception as e:
        err = str(e) or type(e).__name__
        _note(False, err)
        print(f"[notify] send failed: {err}")
        return False, err
    _note(True)
    return True, ""


def deliver(title: str, message: str, priority: str = "default",
            tags: list[str] | None = None) -> str:
    """send() for alerts that must not get lost: 'sent', 'off' (notifications are
    off or not set up, so there is nothing to deliver) or 'failed' (the caller
    retries or queues it). Within BACKOFF seconds of a failure it fails at once."""
    if not is_on():
        return "off"
    with _lock:
        recent = _fail_mono and time.monotonic() - _fail_mono < BACKOFF
    if recent:
        return "failed"
    ok, _ = send(title=title, message=message, priority=priority, tags=tags)
    return "sent" if ok else "failed"


def is_on() -> bool:
    cfg = get_notifications_config()
    return bool(cfg.get("enabled") and cfg.get("server") and cfg.get("topic"))


def send_with(cfg: dict, title: str, message: str, priority: str = "default",
              tags: list[str] | None = None) -> tuple[bool, str]:
    """Send using an explicit config dict (used by the 'test' button before
    the settings are saved). Returns (ok, error_message)."""
    if not cfg.get("server") or not cfg.get("topic"):
        return False, "server or topic not configured"
    headers = _build_headers(cfg, title, priority, tags)
    try:
        with httpx.Client(timeout=10) as client:
            r = client.post(_endpoint(cfg), data=message.encode("utf-8"), headers=headers)
            r.raise_for_status()
    except Exception as e:
        _note(False, str(e) or type(e).__name__)
        return False, str(e)
    _note(True)
    return True, ""
