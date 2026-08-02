import os
from pathlib import Path
from datetime import datetime
try:
    from zoneinfo import ZoneInfo
except Exception:   # pragma: no cover
    ZoneInfo = None
import yaml

_DATA_DIR = Path(__file__).parent.parent / "data"
CONFIG_PATH = _DATA_DIR / "config.yaml"

_DEFAULTS: dict = {
    # General app settings. `timezone` is an IANA name (e.g. "Asia/Dubai"); empty
    # means the server's own clock. It drives all time-of-day logic — schedule
    # fire times, quiet hours, the daily digest — and how times are displayed.
    "general": {
        "timezone": "",
    },
    "llm": {
        "provider": "none",   # none | ollama | openai | anthropic
        "base_url": "",       # ollama: http://localhost:11434  openai-compat: https://api.openai.com/v1
        "api_key": "",        # openai / anthropic
        "model": "",
        "timeout": 120,
        "long_timeout": 600,
    },
    # ntfy push notifications. Real values live in data/config.yaml (gitignored),
    # never here — keep these generic so nothing private is committed.
    "notifications": {
        "enabled": False,
        "server": "",         # e.g. https://ntfy.sh or your self-hosted ntfy
        "topic": "",          # the ntfy topic (channel) to publish to
        "token": "",          # optional ntfy access token, if the server needs auth
    },
    # Service-monitor behaviour.
    "monitoring": {
        # Minutes a service must be continuously down before a down-alert fires.
        "alert_after_minutes": 5,
        # Global quiet window (do-not-disturb): alerts are muted during it, in
        # local time. Anything still down when it ends alerts then.
        "quiet_enabled": False,
        "quiet_start": "",    # "HH:MM"
        "quiet_end": "",      # "HH:MM"
    },
    # Public status page push (LAN → separate status container). Real values
    # live in data/config.yaml (gitignored) — keep generic here.
    "statuspage": {
        "enabled": False,
        "url": "",            # base URL of the status app, e.g. http://192.168.1.20:12102
        "token": "",          # shared secret; sent as Bearer on /push
    },
    # Host liveness (ping tier): an nmap -sn sweep every interval to detect
    # online/offline of known hosts.
    "liveness": {
        "enabled": True,
        "interval_minutes": 3,
        "offline_after": 3,     # consecutive missed sweeps before 'offline'
    },
    # Scan change-tracking: which changes to record, and how long to keep them.
    "change_tracking": {
        "enabled": True,
        "host_new": True,
        "port_opened": True,
        "port_closed": True,
        "mac_changed": True,
        "hostname_changed": True,
        "host_offline": True,
        "host_online": True,
        "retention_days": 90,
    },
    # Change alerts: which recorded changes also notify (ntfy). New-host and
    # MAC-change alerts are scoped to static IPs. Delivered as a per-scan summary
    # and/or a daily digest.
    "change_alerts": {
        "enabled": True,
        "scope": "static",         # which hosts alert: static | dynamic | all (unknown never alerts)
        "host_new": True,          # per-type alert toggles
        "port_opened": True,
        "port_closed": False,
        "mac_changed": False,
        "hostname_changed": False,
        "host_offline": True,      # immediate, static-scoped
        "host_online": True,
        "on_scan": True,           # send a summary when a scan finishes
        "digest_enabled": True,    # daily morning digest
        "digest_time": "08:00",
        "last_digest": "",         # runtime: last digest sent (ISO)
    },
}


def get_config() -> dict:
    cfg: dict = {
        "general": dict(_DEFAULTS["general"]),
        "llm": dict(_DEFAULTS["llm"]),
        "notifications": dict(_DEFAULTS["notifications"]),
        "monitoring": dict(_DEFAULTS["monitoring"]),
        "statuspage": dict(_DEFAULTS["statuspage"]),
        "liveness": dict(_DEFAULTS["liveness"]),
        "change_tracking": dict(_DEFAULTS["change_tracking"]),
        "change_alerts": dict(_DEFAULTS["change_alerts"]),
    }
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH) as f:
            raw = yaml.safe_load(f) or {}
        if "general" in raw:
            cfg["general"].update({k: v for k, v in raw["general"].items() if v is not None})
        if "llm" in raw:
            cfg["llm"].update({k: v for k, v in raw["llm"].items() if v is not None})
        if "notifications" in raw:
            cfg["notifications"].update({k: v for k, v in raw["notifications"].items() if v is not None})
        if "monitoring" in raw:
            cfg["monitoring"].update({k: v for k, v in raw["monitoring"].items() if v is not None})
        if "statuspage" in raw:
            cfg["statuspage"].update({k: v for k, v in raw["statuspage"].items() if v is not None})
        if "liveness" in raw:
            cfg["liveness"].update({k: v for k, v in raw["liveness"].items() if v is not None})
        if "change_tracking" in raw:
            cfg["change_tracking"].update({k: v for k, v in raw["change_tracking"].items() if v is not None})
        if "change_alerts" in raw:
            cfg["change_alerts"].update({k: v for k, v in raw["change_alerts"].items() if v is not None})

    # Env vars override file — useful for Docker deployments
    env_map = {
        "LLM_PROVIDER":     "provider",
        "LLM_BASE_URL":     "base_url",
        "LLM_API_KEY":      "api_key",
        "LLM_MODEL":        "model",
        "LLM_TIMEOUT":      "timeout",
        "LLM_LONG_TIMEOUT": "long_timeout",
    }
    for env_key, cfg_key in env_map.items():
        val = os.environ.get(env_key)
        if val:
            cfg["llm"][cfg_key] = int(val) if cfg_key in ("timeout", "long_timeout") else val

    # ntfy env overrides
    ntfy_env = {
        "NTFY_SERVER": "server",
        "NTFY_TOPIC":  "topic",
        "NTFY_TOKEN":  "token",
    }
    for env_key, cfg_key in ntfy_env.items():
        val = os.environ.get(env_key)
        if val:
            cfg["notifications"][cfg_key] = val
    if os.environ.get("NTFY_ENABLED"):
        cfg["notifications"]["enabled"] = os.environ["NTFY_ENABLED"].lower() in ("1", "true", "yes", "on")

    if os.environ.get("MONITOR_ALERT_MINUTES"):
        try:
            cfg["monitoring"]["alert_after_minutes"] = int(os.environ["MONITOR_ALERT_MINUTES"])
        except ValueError:
            pass
    if os.environ.get("MONITOR_QUIET_ENABLED"):
        cfg["monitoring"]["quiet_enabled"] = os.environ["MONITOR_QUIET_ENABLED"].lower() in ("1", "true", "yes", "on")
    if os.environ.get("MONITOR_QUIET_START"):
        cfg["monitoring"]["quiet_start"] = os.environ["MONITOR_QUIET_START"]
    if os.environ.get("MONITOR_QUIET_END"):
        cfg["monitoring"]["quiet_end"] = os.environ["MONITOR_QUIET_END"]

    # status page push env overrides
    if os.environ.get("STATUSPAGE_ENABLED"):
        cfg["statuspage"]["enabled"] = os.environ["STATUSPAGE_ENABLED"].lower() in ("1", "true", "yes", "on")
    if os.environ.get("STATUSPAGE_URL"):
        cfg["statuspage"]["url"] = os.environ["STATUSPAGE_URL"]
    if os.environ.get("STATUSPAGE_TOKEN"):
        cfg["statuspage"]["token"] = os.environ["STATUSPAGE_TOKEN"]

    return cfg


def get_llm_config() -> dict:
    return get_config()["llm"]


def get_monitoring_config() -> dict:
    return get_config()["monitoring"]


def get_statuspage_config() -> dict:
    return get_config()["statuspage"]


def get_change_tracking_config() -> dict:
    return get_config()["change_tracking"]


def get_change_alerts_config() -> dict:
    return get_config()["change_alerts"]


def get_liveness_config() -> dict:
    return get_config()["liveness"]


def get_notifications_config() -> dict:
    return get_config()["notifications"]


def get_timezone():
    """Configured IANA timezone as a ZoneInfo, or None to use the server clock."""
    name = (get_config().get("general", {}) or {}).get("timezone", "")
    if name and ZoneInfo is not None:
        try:
            return ZoneInfo(name)
        except Exception:
            pass
    return None


def local_now() -> datetime:
    """Now in the configured timezone (aware); naive server-local if unset."""
    tz = get_timezone()
    return datetime.now(tz) if tz else datetime.now()


def save_config(cfg: dict) -> None:
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        yaml.dump(cfg, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
