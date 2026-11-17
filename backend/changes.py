"""Scan change-tracking.

Records what a scan found different vs. the last known state: new hosts,
opened/closed ports, MAC changes, hostname changes. Each type is individually
toggleable (config), and "port closed" is only recorded for ports the scan
actually covered so a shallow scan never false-flags a deeper scan's port.
"""
import os
import re
import asyncio
import ipaddress
from datetime import datetime, timezone, timedelta, time as _time
from typing import Optional

from .config import get_change_tracking_config, get_change_alerts_config, get_config, save_config, local_now, get_timezone
from .database import get_conn
from . import notify, dhcp_check


def classify_host(ip_str: str, subnets: list[dict], override: Optional[str]) -> str:
    """static | dynamic | unknown — override wins; else in a subnet's DHCP range = dynamic."""
    if override in ("static", "dynamic"):
        return override
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return "unknown"
    for s in subnets:
        try:
            net = ipaddress.ip_network(s.get("cidr", ""), strict=False)
        except ValueError:
            continue
        if ip in net:
            start, end = s.get("dhcp_start"), s.get("dhcp_end")
            if start and end:
                try:
                    return "dynamic" if ipaddress.ip_address(start) <= ip <= ipaddress.ip_address(end) else "static"
                except ValueError:
                    return "unknown"
            return "unknown"
    return "unknown"

_NMAP_SERVICES_PATHS = [
    "/usr/share/nmap/nmap-services",
    "/usr/local/share/nmap/nmap-services",
    "/opt/homebrew/share/nmap/nmap-services",
]
_ranked_tcp: list[int] | None = None
_top_cache: dict[int, set[int]] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _cfg() -> dict:
    return get_change_tracking_config()


# ── nmap top-ports (so 'port closed' is scoped to what a scan covered) ─────────

def _load_ranked_tcp() -> list[int]:
    global _ranked_tcp
    if _ranked_tcp is not None:
        return _ranked_tcp
    path = next((p for p in _NMAP_SERVICES_PATHS if os.path.exists(p)), None)
    ranked: list[tuple[float, int]] = []
    if path:
        try:
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    parts = line.split()
                    if len(parts) < 3 or not parts[1].endswith("/tcp"):
                        continue
                    try:
                        ranked.append((float(parts[2]), int(parts[1].split("/")[0])))
                    except ValueError:
                        continue
            # highest frequency first; ties broken by lower port number (so the
            # top-N favours common ports, matching nmap's intent, not obscure
            # high ports that merely share a boundary frequency)
            ranked.sort(key=lambda x: (-x[0], x[1]))
        except Exception:
            ranked = []
    _ranked_tcp = [p for _, p in ranked]
    return _ranked_tcp


def top_ports(n: int) -> set[int]:
    if n not in _top_cache:
        _top_cache[n] = set(_load_ranked_tcp()[:n])
    return _top_cache[n]


def _parse_port_range(spec: str) -> set[int]:
    """TCP ports in an nmap -p list: 22,80,8000-8100, open ends (-1024, 60000-)
    and protocol parts (T:80,U:53 — U:/S:/P: parts aren't TCP) (F-42)."""
    out: set[int] = set()
    proto = "T"
    for part in (spec or "").split(","):
        part = part.strip().upper()
        if not part:
            continue
        if len(part) > 1 and part[1] == ":" and part[0] in "TUSP":
            proto, part = part[0], part[2:].strip()
        if proto != "T" or not part:
            continue
        try:
            if "-" in part:
                a, b = part.split("-", 1)
                lo, hi = int(a or 1), int(b or 65535)
                out.update(range(max(1, lo), min(65535, hi) + 1))
            else:
                out.add(int(part))
        except ValueError:
            pass
    return out


def scanned_ports(opts: dict) -> set[int] | None:
    """TCP ports a scan with these options covers. None = all; empty = none."""
    p = (opts or {}).get("ports", "top1000")
    if p == "all":
        return None
    if p == "none":
        return set()
    if p == "custom":
        return _parse_port_range(opts.get("port_range", ""))
    if p == "topN":
        return top_ports(int(opts.get("top_n") or 100))
    return top_ports(1000)   # top1000 (default)


# ── Recording ─────────────────────────────────────────────────────────────────

def record(conn, ip: str, type_: str, port=None, old=None, new=None, run_id=None) -> None:
    c = _cfg()
    if not c.get("enabled") or not c.get(type_, True):
        return
    conn.execute(
        "INSERT INTO change_events (ts, ip, type, port, old_value, new_value, run_id) VALUES (?,?,?,?,?,?,?)",
        (_now(), ip, type_, port, old, new, run_id))


def record_meta(conn, ip, existed, old_mac, new_mac, old_host, new_host, run_id=None) -> None:
    if not _cfg().get("enabled"):
        return
    if not existed:
        record(conn, ip, "host_new", run_id=run_id)
        return
    if new_mac and old_mac and new_mac.lower() != old_mac.lower():
        record(conn, ip, "mac_changed", old=old_mac, new=new_mac, run_id=run_id)
    if new_host and old_host and old_host != new_host:   # only a real rename, not first discovery
        record(conn, ip, "hostname_changed", old=old_host, new=new_host, run_id=run_id)


def record_ports(conn, ip, host_id, old_open: set[int], new_open: set[int], scanned: set[int] | None,
                 run_id=None, alias_id=None) -> None:
    """old_open/new_open are one address's ports: a host's main address, or its
    second address when alias_id is given (F-24: never compared with each other)."""
    if not _cfg().get("enabled"):
        return
    for p in sorted(new_open - old_open):
        record(conn, ip, "port_opened", port=p, run_id=run_id)
    closed = [p for p in sorted(old_open - new_open) if scanned is None or p in scanned]
    for p in closed:
        record(conn, ip, "port_closed", port=p, run_id=run_id)
        # mark it closed in the DB so it's not re-detected next scan and the
        # host's port list stays accurate
        if alias_id:
            conn.execute("UPDATE alias_ports SET state='closed' WHERE alias_id=? AND port=? AND protocol='tcp'",
                         (alias_id, p))
        else:
            conn.execute("UPDATE ports SET state='closed' WHERE host_id=? AND port=? AND protocol='tcp'", (host_id, p))


def note_new_host_ports(conn, ip, open_ports: set[int], run_id=None) -> None:
    """A brand-new device: its open ports go on its one 'new device' event
    instead of a 'port opened' event each (F-42)."""
    if not open_ports or not _cfg().get("enabled"):
        return
    conn.execute("UPDATE change_events SET new_value=? WHERE ip=? AND type='host_new' AND run_id IS ?",
                 (",".join(str(p) for p in sorted(open_ports)), ip, run_id))


def prune(retention_days: int | None = None) -> None:
    days = retention_days if retention_days is not None else int(_cfg().get("retention_days", 90))
    cutoff = (datetime.now(timezone.utc) - timedelta(days=max(1, days))).isoformat(timespec="seconds")
    with get_conn() as conn:
        conn.execute("DELETE FROM change_events WHERE ts < ?", (cutoff,))
        conn.commit()


# ── Alerting (ntfy summary per scan + daily digest) ───────────────────────────

_LABEL = {
    "host_new":         ("🆕", "new device",      "new devices"),
    "host_offline":     ("🔴", "went offline",    "went offline"),
    "host_online":      ("🟢", "back online",     "back online"),
    "port_opened":      ("🔓", "port opened",     "ports opened"),
    "port_closed":      ("🔒", "port closed",     "ports closed"),
    "mac_changed":      ("🔀", "MAC change",      "MAC changes"),
    "hostname_changed": ("🏷️", "hostname change", "hostname changes"),
}
_ORDER = ["host_new", "host_offline", "host_online", "port_opened", "port_closed", "mac_changed", "hostname_changed"]


def _detail(ev: dict, mac_map: dict | None = None) -> str:
    t = ev["type"]
    base = f"{ev['ip']}:{ev['port']}" if t in ("port_opened", "port_closed") else ev["ip"]
    if mac_map:
        mac = mac_map.get(ev["ip"])
        if mac:
            base += f" [{mac}]"
    return base


def _mac_map(conn, events: list[dict]) -> dict:
    """{ip: mac} for the events' hosts that have a known MAC."""
    ips = {e["ip"] for e in events}
    if not ips:
        return {}
    q = ",".join("?" * len(ips))
    return {r["ip"]: r["mac"] for r in
            conn.execute(f"SELECT ip, mac FROM hosts WHERE ip IN ({q})", tuple(ips)) if r["mac"]}


# A device counts as "flapping" when it toggled both ways repeatedly in the
# window — pulled into its own rollup instead of spamming the offline/online
# lists. Tunable here (not yet a user setting).
FLAP_MIN = 2   # needs >= this many offline AND >= this many online


def ip_key(ip: str):
    """Sort key for IPs, shared by every server-side list: numeric, so .9 < .80 < .100
    (IPv4 before IPv6); anything that isn't an address sorts last, by name."""
    try:
        a = ipaddress.ip_address(str(ip))
        return (0, a.version, int(a), "")
    except ValueError:
        return (1, 0, 0, str(ip))


def _label_key(ev: dict) -> str:
    """Aggregation identity: ip:port for port events, else ip. Events are IP-keyed
    (the schema stores no per-event MAC), so a reused dynamic IP collapses together
    — the shown MAC is whatever currently holds that IP."""
    t = ev["type"]
    if t == "host_new" and ev.get("new_value"):       # new device with its ports (F-42)
        ports = ev["new_value"].split(",")
        more = f" +{len(ports) - 6}" if len(ports) > 6 else ""
        return f"{ev['ip']} (ports {', '.join(ports[:6])}{more})"
    return f"{ev['ip']}:{ev['port']}" if t in ("port_opened", "port_closed") and ev.get("port") is not None else ev["ip"]


def _mac_suffix(ip: str, mac_map: dict | None) -> str:
    mac = (mac_map or {}).get(ip)
    return f" [{mac}]" if mac else ""


def _agg_line(icon: str, sing: str, plur: str, events: list[dict], mac_map, cap: int) -> str:
    """One summary line: dedupe by identity, count per device, noisiest first."""
    counts: dict[str, int] = {}
    ip_of: dict[str, str] = {}
    for e in events:
        k = _label_key(e)
        counts[k] = counts.get(k, 0) + 1
        ip_of[k] = e["ip"]
    keys = sorted(counts, key=lambda k: (-counts[k], ip_key(ip_of[k])))
    devices, total = len(keys), sum(counts.values())
    shown = keys[:cap]
    parts = [f"{k}{_mac_suffix(ip_of[k], mac_map)}" + (f" ×{counts[k]}" if counts[k] > 1 else "") for k in shown]
    more = f" +{devices - cap} more" if devices > cap else ""
    noun = sing if devices == 1 else plur
    # Clarify device-vs-event count only when they differ (the old confusion).
    head = f"{devices} {noun}" + (f" ({total} events)" if total != devices else "")
    return f"{icon} {head}: {', '.join(parts)}{more}"


def summarize(events: list[dict], cap: int = 8, mac_map: dict | None = None) -> str:
    by: dict[str, list] = {}
    for e in events:
        by.setdefault(e["type"], []).append(e)

    # Flapping rollup: IPs with >= FLAP_MIN offline AND >= FLAP_MIN online.
    off_by, on_by = {}, {}
    for e in by.get("host_offline", []):
        off_by[e["ip"]] = off_by.get(e["ip"], 0) + 1
    for e in by.get("host_online", []):
        on_by[e["ip"]] = on_by.get(e["ip"], 0) + 1
    flappers = {ip for ip in off_by if off_by[ip] >= FLAP_MIN and on_by.get(ip, 0) >= FLAP_MIN}

    lines = []
    if flappers:
        keys = sorted(flappers, key=lambda ip: (-(off_by[ip] + on_by[ip]), ip_key(ip)))
        shown = keys[:cap]
        parts = [f"{ip}{_mac_suffix(ip, mac_map)} {off_by[ip]}↓ {on_by[ip]}↑" for ip in shown]
        more = f" +{len(keys) - cap} more" if len(keys) > cap else ""
        noun = "device" if len(keys) == 1 else "devices"
        lines.append(f"🔁 Flapping ({len(keys)} {noun}): {', '.join(parts)}{more}")

    for t in _ORDER:
        evs = by.get(t)
        if not evs:
            continue
        if t in ("host_offline", "host_online") and flappers:
            evs = [e for e in evs if e["ip"] not in flappers]   # flappers shown above
            if not evs:
                continue
        icon, sing, plur = _LABEL[t]
        lines.append(_agg_line(icon, sing, plur, evs, mac_map, cap))
    return "\n".join(lines)


def is_alert_worthy(conn, ev: dict, subnets: list[dict]) -> bool:
    a = get_change_alerts_config()
    if not a.get("enabled") or not a.get(ev["type"], True):
        return False
    row = conn.execute(
        "SELECT static_override, no_mac_alert, no_offline_alert FROM hosts WHERE ip=?",
        (ev["ip"],)).fetchone()
    if not row:   # an alias IP: follow its host's settings
        row = conn.execute(
            "SELECT h.static_override, h.no_mac_alert, h.no_offline_alert FROM hosts h "
            "JOIN host_aliases a ON a.host_id = h.id WHERE a.ip=?", (ev["ip"],)).fetchone()
        if row and ev["type"] in ("host_offline", "host_online") and not a.get("include_aliases", True):
            return False
    override = row["static_override"] if row else None
    cls = classify_host(ev["ip"], subnets, override)
    # Host-scope filter — applies to every alert type. 'unknown' never alerts.
    scope = (a.get("scope") or "static").lower()
    if scope == "static" and cls != "static":
        return False
    if scope == "dynamic" and cls != "dynamic":
        return False
    if scope == "all" and cls not in ("static", "dynamic"):
        return False
    # Per-host opt-outs (still honoured within the chosen scope).
    if ev["type"] == "mac_changed" and row and row["no_mac_alert"]:
        return False
    if ev["type"] in ("host_offline", "host_online") and row and row["no_offline_alert"]:
        return False
    if ev["type"] in ("host_offline", "host_online"):
        from . import planned      # R-22: a device in planned maintenance doesn't alert
        if planned.host_in_window(conn, ev["ip"]):
            return False
    return True


def _worthy_events(conn, where_sql: str, params: tuple) -> list[dict]:
    subnets = [dict(s) for s in conn.execute("SELECT cidr, dhcp_start, dhcp_end FROM subnets")]
    evs = [dict(r) for r in conn.execute(f"SELECT * FROM change_events WHERE {where_sql}", params)]
    return [e for e in evs if is_alert_worthy(conn, e, subnets)]


def send_scan_summary(run_id: int, target_label: str = "") -> None:
    """One ntfy summary of a scan's alert-worthy changes (respects quiet hours).
    Skipped for runs of a silent schedule; the daily digest still includes them."""
    a = get_change_alerts_config()
    if not a.get("enabled") or not a.get("on_scan") or run_id is None:
        return
    with get_conn() as conn:
        if conn.execute("SELECT 1 FROM scan_runs r JOIN scan_schedules sc ON sc.id = r.schedule_id "
                        "WHERE r.id=? AND sc.silent=1", (run_id,)).fetchone():
            return
        worthy = _worthy_events(conn, "run_id=?", (run_id,))
        mac_map = _mac_map(conn, worthy) if a.get("include_mac") else None
    if not worthy:
        return
    try:   # quiet hours (lazy import avoids a module cycle)
        from .monitor import in_quiet_window
        if in_quiet_window(local_now().time()):
            return
    except Exception:
        pass
    n = len(worthy)
    title = f"{n} network change{'s' if n != 1 else ''}" + (f" on {target_label}" if target_label else "")
    notify.send(title=title, message=summarize(worthy, mac_map=mac_map), tags=["satellite_antenna"])


def alert_transition(conn, ip: str, event_type: str) -> str:
    """Immediate ntfy alert for a single offline/online transition. Returns 'sent',
    'queued' (quiet hours, or ntfy failed: it goes out later in the held-alerts
    summary), 'off' (notifications off) or 'skipped' (not alert-worthy).
    F-17: quiet hours no longer drop it."""
    subnets = [dict(s) for s in conn.execute("SELECT cidr, dhcp_start, dhcp_end FROM subnets")]
    if not is_alert_worthy(conn, {"type": event_type, "ip": ip}, subnets):
        return "skipped"
    icon, sing, _ = _LABEL.get(event_type, ("•", event_type, ""))
    host = conn.execute("SELECT hostname, mac FROM hosts WHERE ip=?", (ip,)).fetchone()
    label = ip + (f" ({host['hostname']})" if host and host["hostname"] else "")
    if not host:   # alias IP: name the host it belongs to
        host = conn.execute("SELECT h.ip, h.hostname, h.mac FROM hosts h JOIN host_aliases a "
                            "ON a.host_id = h.id WHERE a.ip=?", (ip,)).fetchone()
        if host:
            label = f"{ip} (alias of {host['hostname'] or host['ip']})"
    from . import monitor          # monitor imports changes; import here, not at the top
    if not notify.is_on():
        return "off"
    line = f"{icon} {label} {sing}"
    if monitor.in_quiet_window(local_now().time()):
        monitor.queue_alert(line, "quiet")
        return "queued"
    message = f"{label} {sing}."
    # Optionally attach the MAC — a roaming device keeps its MAC across IPs/APs.
    if get_change_alerts_config().get("include_mac") and host and host["mac"]:
        message += f"\nMAC: {host['mac']}"
    res = notify.deliver(title=f"{label} {sing}",
                         message=message,
                         priority="high" if event_type == "host_offline" else "default",
                         tags=["red_circle"] if event_type == "host_offline" else ["green_circle"])
    if res == "failed":
        monitor.queue_alert(line, "failed")
        return "queued"
    return res


def service_lines() -> list[str]:
    """Monitored services that were down in the last 24h, or are down now — one line
    each, newest outage first (a service down several times shows each outage)."""
    from . import monitor          # monitor imports changes; import here, not at the top
    tz = get_timezone()
    today = local_now().date()

    def at(iso):
        t = datetime.fromisoformat(iso).astimezone(tz)
        return t.strftime("%H:%M") + ("" if t.date() == today else " yesterday")

    lines = []
    with get_conn() as conn:
        svcs = [dict(r) for r in conn.execute(
            "SELECT s.id, s.name, s.monitor_status, h.ip, h.hostname FROM services s "
            "JOIN hosts h ON h.id = s.host_id WHERE s.monitored = 1 ORDER BY s.name")]
    for s in svcs:
        where = f"{s['name']} on {s['hostname'] or s['ip']}"
        outs = monitor.outages(s["id"], 86400, limit=5)
        for o in outs:
            if o.get("end"):
                lines.append(f"🟢 {where}: down at {at(o['start'])} for {monitor.fmt_duration(o['seconds'])}, back up")
            else:
                lines.append(f"🔴 {where}: down since {at(o['start'])}, still down")
        if s.get("monitor_status") == "down" and not any(not o.get("end") for o in outs):
            lines.append(f"🔴 {where}: down right now")
    return lines


def build_digest(mark: bool = True, services: bool | None = None) -> tuple[str, str] | None:
    """(title, body) of the daily digest: alert-worthy changes from the last 24h, new
    DHCP warnings and monitored-service outages. None when there is nothing to report.
    mark=False (preview) leaves the DHCP warnings unreported so the real digest still
    sends them."""
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat(timespec="seconds")
    with get_conn() as conn:
        worthy = _worthy_events(conn, "ts > ?", (since,))
        mac_map = _mac_map(conn, worthy) if get_change_alerts_config().get("include_mac") else None
        dhcp = dhcp_check.digest_lines(conn, mark=mark)   # new DHCP warnings only
    if services is None:
        services = get_change_alerts_config().get("digest_services", True)
    svc = service_lines() if services else []
    if not worthy and not dhcp and not svc:
        return None
    n = len(worthy)
    parts = [f"{n} network change{'s' if n != 1 else ''}"] if worthy else []
    if svc:
        k = len(svc)
        parts.append(f"{k} service outage{'s' if k != 1 else ''}")
    if dhcp:
        parts.append(f"{len(dhcp)} DHCP warning{'s' if len(dhcp) != 1 else ''}")
    sections = [summarize(worthy, mac_map=mac_map)] if worthy else []
    if svc:
        sections.append("Services\n" + "\n".join(svc))
    if dhcp:
        sections.append("DHCP warnings\n" + "\n".join(dhcp))
    return "Daily digest: " + ", ".join(parts), "\n\n".join(sections)


# ── AI summary for the digest (AI Tier 3) ─────────────────────────────────────

DIGEST_AI_TIMEOUT = 60      # the digest never waits longer than this for the AI
_DIGEST_AI_SYSTEM = (
    "You write the opening lines of a daily report about a home network. "
    "Use ONLY the facts given; never guess causes or invent devices. "
    "Write 2 or 3 short, plain sentences for a non-technical reader: no lists, "
    "no markdown, no greeting, no sign-off. Mention what matters most first. "
    "If nothing needs action, end with: Nothing needs attention."
)


def _clean_ai_text(text: str) -> str:
    from .llm import strip_thinking
    text = strip_thinking(text or "")                                   # reasoning models (also unclosed)
    text = " ".join(text.replace("*", "").split())
    return text[:600].strip()


def digest_ai_summary(title: str, body: str, model: str = "") -> str:
    """2-3 plain sentences about the digest, written by the AI. Raises LLMError
    (or TimeoutError) when the AI is off, unreachable or too slow."""
    from .llm import generate, is_configured, get_default_model, LLMError
    if not is_configured():
        raise LLMError("No AI provider is set up in Settings → AI.")
    model = model or get_default_model()
    if not model:
        raise LLMError("No AI model chosen: set a default model in Settings → AI, or pick one here.")
    facts = f"{title}\n\n{body}"     # exactly what the digest lists, nothing more
    prompt = (f"Report time: {local_now().strftime('%A %d %B, %H:%M')}\n\n"
              f"Facts:\n{facts}\n\nWrite the 2-3 sentence summary now.")
    text = asyncio.run(asyncio.wait_for(
        generate(prompt, model=model, system=_DIGEST_AI_SYSTEM, timeout=DIGEST_AI_TIMEOUT),
        DIGEST_AI_TIMEOUT + 5))
    text = _clean_ai_text(text)
    if not text:
        raise LLMError("The AI sent back an empty answer.")
    return text


def compose_digest(mark: bool = True, ai: bool | None = None, model: str | None = None,
                   services: bool | None = None) -> dict | None:
    """The digest as it would be sent: {title, body, ai_error}. With the AI summary
    on, it goes at the top; any AI failure just leaves it out (ai_error says why).
    ai/model/services default to the saved settings (the preview passes what is on screen)."""
    d = build_digest(mark=mark, services=services)
    if not d:
        return None
    title, body = d
    a = get_change_alerts_config()
    ai = a.get("digest_ai", False) if ai is None else ai
    model = (a.get("digest_ai_model") or "") if model is None else model
    ai_error = summary = None
    if ai:
        try:
            summary = digest_ai_summary(title, body, model)
            body = f"🤖 AI summary\n{summary}\n\n{body}"
            from .llm import get_default_model
            model = model or get_default_model()
        except Exception as e:
            ai_error = (str(e) or type(e).__name__).splitlines()[0]
            if isinstance(e, (asyncio.TimeoutError, TimeoutError)) or "Timeout" in ai_error:
                ai_error = f"The AI took longer than {DIGEST_AI_TIMEOUT} seconds."
            print(f"[digest] AI summary skipped: {ai_error}")
    return {"title": title, "body": body, "ai_error": ai_error, "summary": summary, "model": model}


def send_digest(d: dict | None = None) -> str | None:
    """Daily digest: alert-worthy changes from the last 24h (+ AI summary if on).
    Returns the deliver() result ('sent' | 'off' | 'failed'), None = nothing to send."""
    d = d if d is not None else compose_digest()
    if not d:
        return None
    res = notify.deliver(title=d["title"], message=d["body"], tags=["sunrise"])
    if res == "sent" and d["summary"]:          # keep it for "Past digests" (AI history)
        try:
            from . import ai_history
            ai_history.save_digest(d["title"], d["body"], d["summary"], d["model"])
        except Exception as e:
            print(f"[digest] could not save to AI history: {e}")
    return res


# F-27: today's digest, composed once (the AI summary and the DHCP "reported" marks
# happen only once) and re-sent each minute until ntfy takes it, for the rest of the day.
_pending_digest: dict = {}


def _mark_digest_sent(today: str) -> None:
    cfg = get_config()
    cfg.setdefault("change_alerts", {})["last_digest"] = today
    save_config(cfg)


def maybe_send_digest() -> None:
    """Called periodically; sends the digest once per local day, past digest_time.
    Marked as sent only once it really went out (or there was nothing to send)."""
    a = get_change_alerts_config()
    if not a.get("enabled") or not a.get("digest_enabled"):
        return
    try:
        hh, mm = (a.get("digest_time") or "08:00").split(":")
        target = _time(int(hh), int(mm))
    except Exception:
        return
    now_local = local_now()
    today = now_local.strftime("%Y-%m-%d")
    if now_local.time() < target or (a.get("last_digest") or "") == today:
        return
    if _pending_digest.get("day") != today:
        _pending_digest.clear()
        _pending_digest.update(day=today, digest=compose_digest(), tries=0)
    d = _pending_digest["digest"]
    res = send_digest(d) if d else None
    _pending_digest["tries"] += 1
    if res == "failed":
        if _pending_digest["tries"] == 1:
            print("[digest] could not be sent; trying again every minute today")
        return
    _mark_digest_sent(today)
    _pending_digest.clear()
