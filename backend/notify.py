"""Alert delivery: ntfy push notifications and Telegram (S-24).

Small helper the rest of Boltarr calls to alert the user's phone. Every alert goes
to each channel that is on (ntfy, Telegram); it counts as sent when at least one
got it. Config (server, topic, token, bot token, chat ID) comes from
data/config.yaml via config.py — nothing is hardcoded here.
"""
import html
import re
import threading
import time
from datetime import datetime, timezone

import httpx

from .config import get_notifications_config, get_telegram_config

# F-27: the last send result per channel, shown in Settings → Alerts. After a
# failure, deliver() skips that channel for BACKOFF seconds, so a dead ntfy (or
# Telegram) can't make every alert in one check round wait for its own time-out.
BACKOFF = 30
_lock = threading.Lock()
_health = {"last_ok": None, "last_error": None, "last_error_at": None}      # ntfy
_tg_health = {"last_ok": None, "last_error": None, "last_error_at": None}   # Telegram
_fail_mono = 0.0       # ntfy
_tg_fail_mono = 0.0    # Telegram

TELEGRAM_API = "https://api.telegram.org"
_TG_MAX = 4096         # Telegram's limit for one message

# ntfy shows these tags as emoji; Telegram gets the same emoji in front of the title
_TAG_EMOJI = {
    "satellite_antenna": "📡", "red_circle": "🔴", "green_circle": "🟢",
    "rotating_light": "🚨", "white_check_mark": "✅", "bell": "🔔",
    "sunrise": "🌅", "recycle": "♻️",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def health(channel: str = "ntfy") -> dict:
    with _lock:
        return dict(_tg_health if channel == "telegram" else _health)


def _note(ok: bool, err: str = "", channel: str = "ntfy") -> None:
    global _fail_mono, _tg_fail_mono
    h = _tg_health if channel == "telegram" else _health
    with _lock:
        if ok:
            h["last_ok"] = _now_iso()
            if channel == "telegram":
                _tg_fail_mono = 0.0
            else:
                _fail_mono = 0.0
        else:
            h["last_error"] = (err or "unknown error")[:300]
            h["last_error_at"] = _now_iso()
            if channel == "telegram":
                _tg_fail_mono = time.monotonic()
            else:
                _fail_mono = time.monotonic()


def _in_backoff() -> set[str]:
    """Channels that failed less than BACKOFF seconds ago."""
    now = time.monotonic()
    with _lock:
        return ({"ntfy"} if _fail_mono and now - _fail_mono < BACKOFF else set()) | \
               ({"telegram"} if _tg_fail_mono and now - _tg_fail_mono < BACKOFF else set())


# ── ntfy ──────────────────────────────────────────────────────────────────────

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


def _ntfy_on(cfg: dict) -> bool:
    return bool(cfg.get("enabled") and cfg.get("server") and cfg.get("topic"))


def _post_ntfy(cfg: dict, title: str, message: str, priority: str,
               tags: list[str] | None) -> tuple[bool, str]:
    headers = _build_headers(cfg, title, priority, tags)
    try:
        with httpx.Client(timeout=10) as client:
            r = client.post(_endpoint(cfg), data=message.encode("utf-8"), headers=headers)
            r.raise_for_status()
    except Exception as e:
        return False, str(e) or type(e).__name__
    return True, ""


# ── Telegram ──────────────────────────────────────────────────────────────────

def telegram_on(cfg: dict | None = None) -> bool:
    cfg = get_telegram_config() if cfg is None else cfg
    return bool(cfg.get("enabled") and cfg.get("token") and str(cfg.get("chat_id") or "").strip())


def _scrub(text: str, token: str = "") -> str:
    """Telegram puts the bot token in the request address, so an error message can
    carry it. Never let it reach a log line or the Settings page."""
    if token:
        text = text.replace(token, "<token>")
    return re.sub(r"bot\d+:[A-Za-z0-9_-]+", "bot<token>", text)


def _tg_call(token: str, method: str, payload: dict) -> tuple[bool, dict | str]:
    """One Bot API call. (True, result) or (False, a readable error without the token)."""
    try:
        with httpx.Client(timeout=10) as client:
            r = client.post(f"{TELEGRAM_API}/bot{token}/{method}", json=payload)
        try:
            body = r.json()
        except ValueError:
            body = {}
        if r.status_code == 200 and body.get("ok"):
            return True, body.get("result")
        desc = body.get("description") or f"HTTP {r.status_code}"
        if r.status_code in (401, 404):
            return False, "Telegram didn't accept the bot token. Copy it again from @BotFather."
        if "chat not found" in desc.lower():
            return False, "Chat not found. Check the chat ID, and send your bot a message first."
        if r.status_code == 403:
            return False, f"Telegram: {desc}. Start the bot again (or add it back to the group)."
        return False, _scrub(f"Telegram: {desc}", token)
    except Exception as e:
        return False, _scrub(str(e) or type(e).__name__, token)


def _tg_text(title: str, message: str, tags: list[str] | None) -> str:
    emoji = next((_TAG_EMOJI[t] for t in (tags or []) if t in _TAG_EMOJI), "")
    head = f"{emoji} <b>{html.escape(title)}</b>" if emoji else f"<b>{html.escape(title)}</b>"
    body = html.escape(message)
    room = _TG_MAX - len(head) - 2
    if len(body) > room:
        body = body[:max(0, room - 1)] + "…"
    return f"{head}\n{body}" if body else head


def _post_telegram(cfg: dict, title: str, message: str, priority: str,
                   tags: list[str] | None) -> tuple[bool, str]:
    ok, res = _tg_call(cfg["token"], "sendMessage", {
        "chat_id": str(cfg["chat_id"]).strip(),
        "text": _tg_text(title, message, tags),
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
        "disable_notification": priority in ("low", "min"),   # silent, like ntfy's low priorities
    })
    return (True, "") if ok else (False, res)


def telegram_send_with(cfg: dict, title: str, message: str,
                       tags: list[str] | None = None) -> tuple[bool, str]:
    """Send using explicit settings (the Test button, before they're saved)."""
    if not cfg.get("token") or not str(cfg.get("chat_id") or "").strip():
        return False, "Bot token or chat ID missing"
    ok, err = _post_telegram(cfg, title, message, "default", tags)
    _note(ok, err, "telegram")
    return ok, err


def telegram_find_chat(token: str) -> tuple[bool, dict | str]:
    """'Find my chat ID': the newest chat that messaged the bot (last 24 hours).
    Reads the bot's messages once, only when asked; doesn't mark them as read."""
    if not token:
        return False, "Paste the bot token first"
    ok, res = _tg_call(token, "getUpdates", {"limit": 100, "allowed_updates": ["message", "my_chat_member"]})
    if not ok:
        if "webhook" in str(res).lower():
            return False, "This bot is set up for another app (a webhook). Use a new bot for Boltarr."
        return False, res
    for upd in reversed(res or []):
        chat = ((upd.get("message") or upd.get("my_chat_member") or {}).get("chat")) or {}
        if chat.get("id") is not None:
            name = chat.get("title") or " ".join(x for x in (chat.get("first_name"), chat.get("last_name")) if x) \
                   or chat.get("username") or ""
            return True, {"chat_id": str(chat["id"]), "name": name, "type": chat.get("type", "")}
    return False, "No messages yet. Send any message to your bot in Telegram, then press Find again."


# ── Sending ───────────────────────────────────────────────────────────────────

def send(title: str, message: str, priority: str = "default",
         tags: list[str] | None = None, skip: set[str] | frozenset = frozenset()) -> tuple[bool, str]:
    """Send a notification to every channel that's on (except `skip`).
    Returns (ok, error_message): ok when at least one channel got it.

    A no-op returning (False, reason) if no channel is on — callers can ignore
    the result for fire-and-forget.
    """
    ncfg, tcfg = get_notifications_config(), get_telegram_config()
    tried, errors = 0, []
    if "ntfy" not in skip and ncfg.get("enabled"):
        if not ncfg.get("server") or not ncfg.get("topic"):
            errors.append("ntfy: server or topic not configured")
        else:
            tried += 1
            ok, err = _post_ntfy(ncfg, title, message, priority, tags)
            _note(ok, err, "ntfy")
            if ok:
                errors.append("")
            else:
                print(f"[notify] ntfy send failed: {err}")
                errors.append(f"ntfy: {err}")
    if "telegram" not in skip and telegram_on(tcfg):
        tried += 1
        ok, err = _post_telegram(tcfg, title, message, priority, tags)
        _note(ok, err, "telegram")
        if ok:
            errors.append("")
        else:
            print(f"[notify] Telegram send failed: {err}")
            errors.append(f"Telegram: {err}")
    if not tried:
        return False, next((e for e in errors if e), "notifications disabled")
    if "" in errors:
        return True, ""
    return False, "; ".join(e for e in errors if e)


def deliver(title: str, message: str, priority: str = "default",
            tags: list[str] | None = None) -> str:
    """send() for alerts that must not get lost: 'sent', 'off' (no channel is on or
    set up, so there is nothing to deliver) or 'failed' (the caller retries or queues
    it). A channel that failed within BACKOFF seconds is skipped; when every channel
    that's on is in that wait, it fails at once."""
    if not is_on():
        return "off"
    skip = _in_backoff()
    on = _channels_on()
    if on and on <= skip:
        return "failed"
    ok, _ = send(title=title, message=message, priority=priority, tags=tags, skip=skip)
    return "sent" if ok else "failed"


def _channels_on() -> set[str]:
    return ({"ntfy"} if _ntfy_on(get_notifications_config()) else set()) | \
           ({"telegram"} if telegram_on() else set())


def is_on() -> bool:
    return bool(_channels_on())


def send_with(cfg: dict, title: str, message: str, priority: str = "default",
              tags: list[str] | None = None) -> tuple[bool, str]:
    """Send to ntfy using an explicit config dict (used by the 'test' button before
    the settings are saved). Returns (ok, error_message)."""
    if not cfg.get("server") or not cfg.get("topic"):
        return False, "server or topic not configured"
    ok, err = _post_ntfy(cfg, title, message, priority, tags)
    _note(ok, err, "ntfy")
    return ok, err
