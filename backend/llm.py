"""
Unified LLM client supporting Ollama, OpenAI-compatible APIs, and Anthropic.
Provider is configured via data/config.yaml or LLM_* environment variables.
"""
import httpx
from .config import get_llm_config

LONG_TIMEOUT = 600  # referenced by main.py


class LLMError(Exception):
    """Raised when AI is not configured or a provider call fails."""


# ── Provider helpers ──────────────────────────────────────────────────────────

def _cfg() -> dict:
    return get_llm_config()


def is_configured() -> bool:
    return _cfg().get("provider", "none") != "none"


def get_default_model() -> str:
    return _cfg().get("model") or ""


# ── Public API ────────────────────────────────────────────────────────────────

async def list_models() -> list[str]:
    cfg = _cfg()
    provider = cfg.get("provider", "none")
    if provider == "none":
        return []
    try:
        if provider == "ollama":
            async with httpx.AsyncClient(timeout=10) as c:
                r = await c.get(f"{cfg['base_url'].rstrip('/')}/api/tags")
                r.raise_for_status()
                return [m["name"] for m in r.json().get("models", [])]
        if provider == "openai":
            headers = {}
            if cfg.get("api_key"):
                headers["Authorization"] = f"Bearer {cfg['api_key']}"
            async with httpx.AsyncClient(timeout=10) as c:
                r = await c.get(f"{cfg['base_url'].rstrip('/')}/models", headers=headers)
                r.raise_for_status()
                data = r.json()
                items = data.get("data") or data.get("models") or []
                return sorted(m.get("id") or m.get("name", "") for m in items if isinstance(m, dict))
        if provider == "anthropic":
            return ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-7"]
    except LLMError:
        raise
    except Exception as e:
        raise LLMError(f"Failed to list models: {e}") from e
    return []


async def generate(prompt: str, model: str = "", system: str = "",
                   timeout: int = 0) -> str:
    cfg = _cfg()
    provider = cfg.get("provider", "none")
    if provider == "none":
        raise LLMError("No AI provider configured. Open ⚙ AI Settings to configure one.")
    model   = model   or cfg.get("model") or ""
    timeout = timeout or cfg.get("timeout", 120)

    try:
        if provider == "ollama":
            payload: dict = {"model": model, "prompt": prompt, "stream": False}
            if system:
                payload["system"] = system
            async with httpx.AsyncClient(timeout=timeout) as c:
                r = await c.post(f"{cfg['base_url'].rstrip('/')}/api/generate", json=payload)
                r.raise_for_status()
                return r.json().get("response", "")

        if provider == "openai":
            msgs = ([{"role": "system", "content": system}] if system else [])
            msgs.append({"role": "user", "content": prompt})
            headers = {"Content-Type": "application/json"}
            if cfg.get("api_key"):
                headers["Authorization"] = f"Bearer {cfg['api_key']}"
            async with httpx.AsyncClient(timeout=timeout) as c:
                r = await c.post(
                    f"{cfg['base_url'].rstrip('/')}/chat/completions",
                    json={"model": model, "messages": msgs}, headers=headers,
                )
                r.raise_for_status()
                return r.json()["choices"][0]["message"]["content"]

        if provider == "anthropic":
            payload = {
                "model": model, "max_tokens": 4096,
                "messages": [{"role": "user", "content": prompt}],
            }
            if system:
                payload["system"] = system
            async with httpx.AsyncClient(timeout=timeout) as c:
                r = await c.post(
                    "https://api.anthropic.com/v1/messages", json=payload,
                    headers={"x-api-key": cfg.get("api_key", ""),
                             "anthropic-version": "2023-06-01",
                             "content-type": "application/json"},
                )
                r.raise_for_status()
                return r.json()["content"][0]["text"]

    except LLMError:
        raise
    except Exception as e:
        raise LLMError(f"AI request failed ({provider}): {e}") from e

    raise LLMError(f"Unknown provider: {provider}")


async def chat(messages: list[dict], model: str = "", system: str = "") -> str:
    cfg = _cfg()
    provider = cfg.get("provider", "none")
    if provider == "none":
        raise LLMError("No AI provider configured. Open ⚙ AI Settings to configure one.")
    model   = model or cfg.get("model") or ""
    timeout = cfg.get("timeout", 120)

    try:
        if provider == "ollama":
            full = ([{"role": "system", "content": system}] if system else []) + messages
            async with httpx.AsyncClient(timeout=timeout) as c:
                r = await c.post(
                    f"{cfg['base_url'].rstrip('/')}/api/chat",
                    json={"model": model, "messages": full, "stream": False},
                )
                r.raise_for_status()
                return r.json().get("message", {}).get("content", "")

        if provider == "openai":
            full = ([{"role": "system", "content": system}] if system else []) + messages
            headers = {"Content-Type": "application/json"}
            if cfg.get("api_key"):
                headers["Authorization"] = f"Bearer {cfg['api_key']}"
            async with httpx.AsyncClient(timeout=timeout) as c:
                r = await c.post(
                    f"{cfg['base_url'].rstrip('/')}/chat/completions",
                    json={"model": model, "messages": full}, headers=headers,
                )
                r.raise_for_status()
                return r.json()["choices"][0]["message"]["content"]

        if provider == "anthropic":
            payload = {"model": model, "max_tokens": 4096, "messages": messages}
            if system:
                payload["system"] = system
            async with httpx.AsyncClient(timeout=timeout) as c:
                r = await c.post(
                    "https://api.anthropic.com/v1/messages", json=payload,
                    headers={"x-api-key": cfg.get("api_key", ""),
                             "anthropic-version": "2023-06-01",
                             "content-type": "application/json"},
                )
                r.raise_for_status()
                return r.json()["content"][0]["text"]

    except LLMError:
        raise
    except Exception as e:
        raise LLMError(f"AI request failed ({provider}): {e}") from e

    raise LLMError(f"Unknown provider: {provider}")


# ── Prompt builders (provider-agnostic) ───────────────────────────────────────

def build_host_prompt(host: dict, ports: list, services: list = None,
                      connections: list = None) -> str:
    port_lines = "\n".join(
        f"  {p['port']}/{p['protocol']}  {p['service'] or '?'}  {p['version'] or ''}"
        + ("  [manual]" if p.get("manual") else "")
        for p in ports
    ) or "  none detected"

    svc_lines = ""
    if services:
        svc_lines = "\nRegistered services:\n" + "\n".join(
            f"  {s['name']}  port={s.get('port') or '?'}/{s.get('protocol','tcp')}"
            f"  status={s.get('status','unknown')}"
            + (f"  url={s['url']}" if s.get('url') else "")
            + (f"  — {s['description']}" if s.get('description') else "")
            for s in services
        )

    conn_lines = ""
    if connections:
        conn_lines = "\nConnections:\n" + "\n".join(
            f"  ↔ {c['peer_ip']}"
            + (f" ({c['peer_label']})" if c.get('peer_label') else "")
            + (f"  {c['speed']}"         if c.get('speed')      else "")
            + (f"  mode={c['port_mode']}" if c.get('port_mode') else "")
            + (f"  vlans={c['vlan_summary']}" if c.get('vlan_summary') else "")
            + (f"  [{c['label']}]"        if c.get('label')     else "")
            for c in connections
        )

    meta = []
    if host.get('device_type') and host['device_type'] != 'unknown':
        meta.append(f"Device type: {host['device_type']}")
    if host.get('port_count') and host['port_count'] > 1:
        meta.append(f"Physical ports: {host['port_count']}")
    if host.get('has_wifi'):
        meta.append("Has WiFi capability")
    if host.get('notes'):
        meta.append(f"Notes: {host['notes']}")
    meta_lines = ("\n" + "\n".join(meta)) if meta else ""

    return f"""Analyze this network host and give a practical assessment.

IP: {host['ip']}
Hostname: {host.get('hostname') or 'unknown'}
MAC: {host.get('mac') or 'unknown'}
Vendor: {host.get('vendor') or 'unknown'}
OS: {host.get('os_guess') or 'unknown'}{meta_lines}

Open ports:
{port_lines}{svc_lines}{conn_lines}

Answer in 4-6 sentences covering:
1. What type of device this is and its role in the network
2. What services it provides (scanned ports + registered services)
3. How it fits into the network topology (connections, VLANs, speed)
4. Any notable security observations or recommendations"""


def build_network_prompt(hosts: list, connections: list,
                         vlans: list, subnets: list) -> str:
    subnet_lines = "\n".join(
        f"  {s['cidr']}  {s['name']}" + (f" — {s['description']}" if s.get('description') else "")
        for s in subnets
    ) or "  none defined"

    vlan_lines = "\n".join(
        f"  VLAN {v['tag']}  {v['name']}  color={v['color']}" for v in vlans
    ) or "  none defined"

    host_lines = []
    for h in hosts:
        parts = [f"\n[{h['ip']}]"]
        if h.get('hostname'):    parts.append(f"  hostname={h['hostname']}")
        if h.get('device_type'): parts.append(f"  type={h['device_type']}")
        if h.get('vendor'):      parts.append(f"  vendor={h['vendor']}")
        if h.get('os_guess'):    parts.append(f"  os={h['os_guess']}")
        if h.get('has_wifi'):    parts.append("  wifi=yes")
        if h.get('port_count') and h['port_count'] > 1:
            parts.append(f"  switch_ports={h['port_count']}")
        if h.get('notes'):       parts.append(f"  notes={h['notes']}")
        if h.get('ports'):
            open_ports = [p for p in h['ports'] if p.get('state') == 'open' or p.get('manual')]
            if open_ports:
                parts.append("  open_ports: " + ", ".join(
                    f"{p['port']}/{p['protocol']}({p.get('service') or '?'})" for p in open_ports
                ))
        if h.get('services'):
            parts.append("  services: " + ", ".join(
                f"{s['name']}:{s.get('port','?')}[{s.get('status','?')}]" for s in h['services']
            ))
        host_lines.append("\n".join(parts))

    conn_lines = []
    for c in connections:
        line = f"  {c['src_ip']} ↔ {c['dst_ip']}"
        if c.get('speed'):       line += f"  {c['speed']}"
        if c.get('port_mode'):   line += f"  mode={c['port_mode']}"
        if c.get('tagged_only'): line += "  tagged-only"
        if c.get('vlans'):
            line += "  vlans=" + ",".join(f"{v['tag']}({v['name']})" for v in c['vlans'])
        if c.get('label'):       line += f"  [{c['label']}]"
        conn_lines.append(line)

    return f"""Perform a comprehensive analysis of this network.

== Subnets ==
{subnet_lines}

== VLANs ==
{vlan_lines}

== Hosts ({len(hosts)}) ==
{"".join(host_lines)}

== Connections ({len(connections)}) ==
{chr(10).join(conn_lines) or "  none defined"}

Provide a structured analysis covering:
1. TOPOLOGY OVERVIEW — describe the network structure, tiers, and key infrastructure roles
2. DEVICE ROLES — for each significant device, what it does and its importance
3. VLAN & SEGMENTATION — how the network is segmented, whether it makes sense
4. SECURITY OBSERVATIONS — exposed services, missing segmentation, risky configurations, open ports of concern
5. RECOMMENDATIONS — specific actionable improvements (redundancy, segmentation, hardening)

Be specific and reference actual IPs, hostnames, and port numbers from the data above."""


def infer_device_type(analysis: str) -> str:
    lower = analysis.lower()
    if "access point" in lower or " ap " in lower:
        return "ap"
    for dtype in ["router", "gateway", "switch", "firewall", "server", "nas",
                  "container", "vm", "printer", "camera", "iot",
                  "workstation", "laptop", "phone", "tablet"]:
        if dtype in lower:
            return dtype
    return "unknown"
