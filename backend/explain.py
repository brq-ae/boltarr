"""Outage explanations (AI Tier 3, part 2).

For one outage of a service or a host, Boltarr gathers plain facts with simple
rules: was the whole host down, what else went down at the same moment, what sits
on the path to the router (Topology links), dependencies, repeats, and changes the
scans saw just before. The AI only puts those facts into words; without an AI the
facts are shown on their own. With AI history on (backend/ai_history.py) each
explanation is saved (ai_explanations), so it reopens instantly and builds a history.
"""
import asyncio
import json
from collections import deque
from datetime import datetime, timedelta, timezone

from .config import get_timezone, local_now
from .database import get_conn
from . import ai_history, monitor

NEAR = 5 * 60          # "at the same moment" = within 5 minutes of the start
REPEAT_DAYS = 30
NETGEAR = {"router", "gateway", "switch", "unmanaged-switch", "firewall", "ap"}
ROUTERS = {"router", "gateway", "firewall"}

_SYSTEM = (
    "You help the owner of a home network understand one outage. Use ONLY the facts "
    "given; never invent devices, times or causes the facts don't support. In 2 to 4 "
    "short, plain sentences: say the most likely cause and one or two things to check. "
    "If the facts don't point to a cause, say so plainly and suggest what to check. "
    "No lists, no markdown, no greeting."
)


def _ts(iso: str) -> float:
    return datetime.fromisoformat(iso).timestamp()


def _local(ts: float, with_day: bool = True) -> str:
    t = datetime.fromtimestamp(ts, timezone.utc).astimezone(get_timezone())
    return t.strftime("%d %b %H:%M") if with_day else t.strftime("%H:%M")


def _name(h: dict) -> str:
    return f"{h['hostname']} ({h['ip']})" if h.get("hostname") else h["ip"]


def _downs(conn, table: str, key: str, since: float, until: float) -> dict:
    """{id: first 'down' time} for every service/host that went down in [since, until]."""
    lo = datetime.fromtimestamp(since, timezone.utc).isoformat(timespec="seconds")
    hi = datetime.fromtimestamp(until, timezone.utc).isoformat(timespec="seconds")
    out = {}
    for r in conn.execute(f"SELECT {key} AS k, ts FROM {table} WHERE status='down' AND ts BETWEEN ? AND ? "
                          "ORDER BY ts", (lo, hi)):
        out.setdefault(r["k"], _ts(r["ts"]))
    return out


def _host_down_at(host_id: int, ts: float) -> dict | None:
    """The host outage covering `ts` (or starting within NEAR of it), if any."""
    for o in monitor.host_outages(host_id, REPEAT_DAYS * 86400, limit=500):
        s = _ts(o["start"])
        e = _ts(o["end"]) if o.get("end") else datetime.now(timezone.utc).timestamp()
        if s - NEAR <= ts <= e or abs(s - ts) <= NEAR:
            return o
    return None


def _path_to_router(conn, ip: str, hosts_by_ip: dict) -> list[str]:
    """IPs on the shortest Topology path from `ip` to a router (excluding `ip`), or []."""
    adj: dict[str, set] = {}
    for c in conn.execute("SELECT src_ip, dst_ip FROM connections"):
        adj.setdefault(c["src_ip"], set()).add(c["dst_ip"])
        adj.setdefault(c["dst_ip"], set()).add(c["src_ip"])
    prev, q = {ip: None}, deque([ip])
    while q:
        cur = q.popleft()
        if cur != ip and (hosts_by_ip.get(cur) or {}).get("device_type") in ROUTERS:
            path = []
            while cur != ip:
                path.append(cur)
                cur = prev[cur]
            return list(reversed(path))
        for n in adj.get(cur, ()):
            if n not in prev:
                prev[n] = cur
                q.append(n)
    return []


def _neighbours(conn, ip: str) -> set:
    out = set()
    for c in conn.execute("SELECT src_ip, dst_ip FROM connections WHERE src_ip=? OR dst_ip=?", (ip, ip)):
        out.add(c["dst_ip"] if c["src_ip"] == ip else c["src_ip"])
    return out


def _repeats(outs: list[dict], start: float) -> str | None:
    """'This happened N times…' (+ 'usually around HH:MM' when the starts cluster)."""
    others = [_ts(o["start"]) for o in outs if abs(_ts(o["start"]) - start) > 60]
    if not others:
        return f"It is the only outage of this item in the last {REPEAT_DAYS} days."
    n = len(others) + 1
    line = f"It went down {n} times in the last {REPEAT_DAYS} days."
    if n >= 3:
        tz = get_timezone()
        mins = [(lambda t: t.hour * 60 + t.minute)(datetime.fromtimestamp(x, timezone.utc).astimezone(tz))
                for x in [start, *others]]
        me = mins[0]
        close = sum(1 for m in mins if min(abs(m - me), 1440 - abs(m - me)) <= 45)
        if close >= max(3, (n * 2 + 2) // 3):
            line += f" {close} of those started around {_local(start, with_day=False)}, so it may be something scheduled (a reboot, backup or update)."
    return line


def gather(kind: str, target_id: int, start_iso: str) -> dict:
    """Facts about one outage: {title, facts[], start, end}. Raises LookupError if
    the item or the outage isn't found."""
    start = _ts(start_iso)
    with get_conn() as conn:
        hosts = [dict(r) for r in conn.execute("SELECT id, ip, hostname, device_type, online FROM hosts")]
        by_id = {h["id"]: h for h in hosts}
        by_ip = {h["ip"]: h for h in hosts}
        svcs = {r["id"]: dict(r) for r in conn.execute(
            "SELECT id, name, host_id, monitored FROM services")}
        if kind == "service":
            svc = svcs.get(target_id)
            if not svc:
                raise LookupError("Service not found")
            host = by_id.get(svc["host_id"]) or {}
            outs = monitor.outages(target_id, REPEAT_DAYS * 86400, limit=500)
            what = f"{svc['name']} on {_name(host)}" if host else svc["name"]
        elif kind == "host":
            host = by_id.get(target_id)
            if not host:
                raise LookupError("Host not found")
            svc = None
            outs = monitor.host_outages(target_id, REPEAT_DAYS * 86400, limit=500)
            what = f"the device {_name(host)}"
        else:
            raise LookupError("Unknown kind")
        o = next((x for x in outs if abs(_ts(x["start"]) - start) <= 60), None)
        if not o:
            raise LookupError("Outage not found (it may be older than 30 days, or uptime was reset)")
        end = _ts(o["end"]) if o.get("end") else None
        svc_downs = _downs(conn, "monitor_events", "service_id", start - NEAR, start + NEAR)
        host_downs = _downs(conn, "host_events", "host_id", start - NEAR, start + NEAR)
        path = _path_to_router(conn, host["ip"], by_ip) if host else []
        first_hop = path[0] if path else None
        hop_peers = (_neighbours(conn, first_hop) - {host.get("ip"), *path}) if first_hop else set()
        own_peers = (_neighbours(conn, host["ip"]) - set(path)) if kind == "host" else set()
        deps = [svcs[r["to_service_id"]] for r in conn.execute(
            "SELECT to_service_id FROM service_dependencies WHERE from_service_id=?", (target_id,))
            if r["to_service_id"] in svcs] if kind == "service" else []
        before = (datetime.fromtimestamp(start - 86400, timezone.utc).isoformat(timespec="seconds"),
                  datetime.fromtimestamp(start, timezone.utc).isoformat(timespec="seconds"))
        changes_before = [dict(r) for r in conn.execute(
            "SELECT type, port, ts FROM change_events WHERE ip=? AND ts BETWEEN ? AND ? "
            "AND type NOT IN ('host_offline', 'host_online') ORDER BY ts", (host.get("ip"), *before))] if host else []
        n_watched = (conn.execute("SELECT COUNT(DISTINCT host_id) FROM host_events").fetchone()[0]
                     + sum(1 for s in svcs.values() if s["monitored"]))

    dur = f"for {monitor._fmt_duration(end - start)}" if end else "and is still down"
    facts = [f"Outage: {what} went down at {_local(start)} {dur}."]

    # 1. the whole host (for a host outage, the device itself is down by definition)
    host_was_down = kind == "host"
    if kind == "service" and host:
        ho = _host_down_at(host["id"], start)
        host_was_down = bool(ho)
        facts.append(f"The device itself ({_name(host)}) was offline at the same time, so the whole device "
                     "was unreachable, not just this service." if ho else
                     f"The device {_name(host)} stayed online, so only this service stopped answering.")

    # 2. same moment
    others = [f"{s['name']} on {_name(by_id[s['host_id']])}" if s["host_id"] in by_id else s["name"]
              for sid, s in svcs.items() if sid in svc_downs and not (kind == "service" and sid == target_id)]
    other_hosts = [_name(by_id[hid]) for hid in host_downs
                   if hid in by_id and not (host and hid == host["id"])]
    together = others + other_hosts
    if together:
        shown = ", ".join(together[:8]) + (f" and {len(together) - 8} more" if len(together) > 8 else "")
        facts.append(f"Within 5 minutes of the start, {len(together)} other item(s) also went down: {shown}.")
    else:
        facts.append("Nothing else Boltarr watches went down within 5 minutes of the start.")

    # 3. the path to the router
    if path:
        names = [_name(by_ip[p]) if p in by_ip else p for p in path]
        facts.append("Path to the router (from Topology links): " + " → ".join(names) + ".")
        for p in path:
            ph = by_ip.get(p)
            if ph and _host_down_at(ph["id"], start):
                facts.append(f"{_name(ph)}, on that path, was offline at the same time.")
        hop = by_ip.get(first_hop)
        # Others behind the same switch only matter when this device was cut off too
        if host_was_down and hop and hop.get("device_type") in NETGEAR and hop_peers:
            peer_down = sorted(_name(by_ip[p]) for p in hop_peers if p in by_ip and by_ip[p]["id"] in host_downs)
            facts.append(f"Of the {len(hop_peers)} other device(s) connected to {_name(hop)}, "
                         f"{len(peer_down)} went down at the same time"
                         + (f": {', '.join(peer_down[:6])}." if peer_down else "."))
    elif host:
        facts.append("No Topology link connects this device to a router, so the path can't be checked.")
    # A switch/AP/router that went down: did the devices plugged into it go with it?
    if kind == "host" and host.get("device_type") in NETGEAR and own_peers:
        down = [_name(by_ip[p]) for p in own_peers if p in by_ip and by_ip[p]["id"] in host_downs]
        facts.append(f"{len(down)} of the {len(own_peers)} device(s) connected to it (Topology links) "
                     "went down at the same time" + (f": {', '.join(sorted(down)[:6])}." if down else "."))

    # 4. dependencies
    for d in deps:
        when = svc_downs.get(d["id"])
        where = f"{d['name']}" + (f" on {_name(by_id[d['host_id']])}" if d["host_id"] in by_id else "")
        if when is not None:
            lead = "before" if when < start - 30 else "at about the same time as"
            facts.append(f"It depends on {where}, which went down {lead} it ({_local(when, with_day=False)}).")
        elif not d["monitored"]:
            facts.append(f"It depends on {where}, which isn't monitored, so Boltarr can't tell if it was down.")
        else:
            facts.append(f"It depends on {where}, which did not go down around then.")

    # 5. repeats
    rep = _repeats(outs, start)
    if rep:
        facts.append(rep)

    # 6. scan changes in the 24h before
    if changes_before:
        label = {"host_new": "first seen", "port_opened": "port {port} opened", "port_closed": "port {port} closed",
                 "mac_changed": "MAC changed", "hostname_changed": "hostname changed"}
        items = [label.get(c["type"], c["type"]).format(port=c.get("port")) for c in changes_before[-6:]]
        facts.append("In the 24 hours before, scans saw on this device: " + "; ".join(items) + ".")

    # 7. almost everything at once
    if n_watched >= 4 and len(together) + 1 >= 0.7 * n_watched:
        facts.append(f"Almost everything Boltarr watches ({len(together) + 1} of {n_watched}) went down together. "
                     "That points to the router or Boltarr's own network connection.")

    return {"title": what, "facts": facts, "start": start_iso, "end": o.get("end")}


def _save(kind, target_id, start_iso, facts, summary, model, ai_error) -> dict:
    """Save the explanation (AI history on) and return it. With saving off it is
    only returned, so the reader sees it once and nothing is kept."""
    if not ai_history.enabled():
        return {"id": None, "kind": kind, "target_id": target_id, "outage_start": start_iso,
                "facts": facts, "summary": summary, "model": model, "ai_error": ai_error,
                "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")}
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO ai_explanations (kind, target_id, outage_start, facts, summary, model, ai_error) "
            "VALUES (?,?,?,?,?,?,?)",
            (kind, target_id, start_iso, json.dumps(facts), summary, model, ai_error))
        ai_history.prune(conn)
        return history(kind, target_id, start_iso, conn=conn)[0]


def history(kind: str, target_id: int, start_iso: str, conn=None) -> list[dict]:
    """Saved explanations for this outage (start matched within a minute), newest
    first. Empty while AI history is off."""
    if not ai_history.enabled():
        return []
    def q(c):
        start = _ts(start_iso)
        out = []
        for r in c.execute("SELECT * FROM ai_explanations WHERE kind=? AND target_id=? ORDER BY id DESC",
                           (kind, target_id)):
            if abs(_ts(r["outage_start"]) - start) <= 60:
                d = dict(r)
                d["facts"] = json.loads(d["facts"] or "[]")
                out.append(d)
        return out
    if conn is not None:
        return q(conn)
    with get_conn() as c:
        return q(c)


def latest(kind: str, target_id: int, start_iso: str) -> dict | None:
    """The newest saved explanation for this outage, if any."""
    h = history(kind, target_id, start_iso)
    return h[0] if h else None


def explain(kind: str, target_id: int, start_iso: str, model: str = "") -> dict:
    """Gather the facts, ask the AI to word them (if one is set up), save, return."""
    from .llm import generate, is_configured, get_default_model, get_llm_config, LLMError
    from .changes import _clean_ai_text
    g = gather(kind, target_id, start_iso)
    summary, ai_error, used = None, None, ""
    if not is_configured():
        ai_error = "No AI is set up (Settings → AI), so only the facts are shown."
    else:
        used = model or get_default_model()
        if not used:
            ai_error = "No AI model chosen: set a default model in Settings → AI, or pick one here."
        else:
            timeout = int(get_llm_config().get("timeout") or 120)
            prompt = (f"Now: {local_now().strftime('%d %b %H:%M')}\n\nFacts:\n- " + "\n- ".join(g["facts"])
                      + "\n\nWrite the explanation now.")
            try:
                summary = _clean_ai_text(asyncio.run(asyncio.wait_for(
                    generate(prompt, model=used, system=_SYSTEM, timeout=timeout), timeout + 5)))
                if not summary:
                    ai_error = "The AI sent back an empty answer."
            except Exception as e:
                msg = (str(e) or type(e).__name__).splitlines()[0]
                if isinstance(e, (asyncio.TimeoutError, TimeoutError)) or "Timeout" in msg:
                    msg = f"The AI took longer than {timeout} seconds."
                ai_error = msg
                if not isinstance(e, (LLMError, asyncio.TimeoutError, TimeoutError)):
                    print(f"[explain] AI failed: {msg}")
    return _save(kind, target_id, g["start"], g["facts"], summary or None, used, ai_error)
