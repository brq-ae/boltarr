"""ntfy push notifications.

Small helper the rest of Boltarr calls to alert the user's phone.
Config (server, topic, token) comes from data/config.yaml via config.py —
nothing is hardcoded here.
"""
import httpx

from .config import get_notifications_config


def _endpoint(cfg: dict) -> str:
    server = (cfg.get("server") or "").rstrip("/")
    topic = (cfg.get("topic") or "").strip()
    return f"{server}/{topic}"


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

    headers = {
        "Title": title,
        "Priority": priority,
    }
    if tags:
        headers["Tags"] = ",".join(tags)
    if cfg.get("token"):
        headers["Authorization"] = f"Bearer {cfg['token']}"

    try:
        with httpx.Client(timeout=10) as client:
            r = client.post(_endpoint(cfg), data=message.encode("utf-8"), headers=headers)
            r.raise_for_status()
        return True, ""
    except Exception as e:
        return False, str(e)


def send_with(cfg: dict, title: str, message: str, priority: str = "default",
              tags: list[str] | None = None) -> tuple[bool, str]:
    """Send using an explicit config dict (used by the 'test' button before
    the settings are saved). Returns (ok, error_message)."""
    if not cfg.get("server") or not cfg.get("topic"):
        return False, "server or topic not configured"
    headers = {"Title": title, "Priority": priority}
    if tags:
        headers["Tags"] = ",".join(tags)
    if cfg.get("token"):
        headers["Authorization"] = f"Bearer {cfg['token']}"
    try:
        with httpx.Client(timeout=10) as client:
            r = client.post(_endpoint(cfg), data=message.encode("utf-8"), headers=headers)
            r.raise_for_status()
        return True, ""
    except Exception as e:
        return False, str(e)
