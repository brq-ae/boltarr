import os
from pathlib import Path
import yaml

_DATA_DIR = Path(__file__).parent.parent / "data"
CONFIG_PATH = _DATA_DIR / "config.yaml"

_DEFAULTS: dict = {
    "llm": {
        "provider": "none",   # none | ollama | openai | anthropic
        "base_url": "",       # ollama: http://localhost:11434  openai-compat: https://api.openai.com/v1
        "api_key": "",        # openai / anthropic
        "model": "",
        "timeout": 120,
        "long_timeout": 600,
    }
}


def get_config() -> dict:
    cfg: dict = {"llm": dict(_DEFAULTS["llm"])}
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH) as f:
            raw = yaml.safe_load(f) or {}
        if "llm" in raw:
            cfg["llm"].update({k: v for k, v in raw["llm"].items() if v is not None})

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

    return cfg


def get_llm_config() -> dict:
    return get_config()["llm"]


def save_config(cfg: dict) -> None:
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        yaml.dump(cfg, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
