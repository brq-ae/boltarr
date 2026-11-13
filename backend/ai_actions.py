"""AI actions (v0.26.0, AI Tier 4): the chat AI can *suggest* an action by writing
one line in its reply:

    [[action {"do": "set_note", "host": "10.0.0.5", "note": "Backup NAS"}]]

The browser turns each line into a card. Boltarr — never the AI — checks the
suggestion against the fixed list below (check), shows what it would do, and only
does it when you click (run, which checks again). Nothing destructive is on the list.

kind "open"   → only shows something on screen; one click, nothing changes.
kind "change" → changes data or starts a scan; needs "Do it".
"""
import json
import re
from datetime import datetime, timedelta, timezone

from .config import get_timezone
from .database import get_conn

# The browser (ai-actions.js) finds the suggestions in a reply and sends each one
# here as text: '{json}' or 'word {json}' (the word from a '[[word {...}]]' slip,
# used as "do" when the JSON has none). It also catches the JSON in a code block.

DEVICE_TYPES = ["router", "gateway", "switch", "unmanaged-switch", "firewall", "server", "nas",
                "workstation", "pc", "laptop", "iot", "camera", "printer", "phone", "tablet", "tv",
                "container", "vm", "ap", "unknown"]
NOTE_MAX = 500
NAME_MAX = 100
PAUSE_MAX_DAYS = 30


class ActionError(ValueError):
    """A suggestion Boltarr won't carry out; the message is shown on the card."""


# ── Finding things ───────────────────────────────────────────────────────────

def _host(conn, ref) -> dict:
    """A host by IP or exact hostname (any case)."""
    ref = str(ref or "").strip()
    if not ref:
        raise ActionError("No host given.")
    r = conn.execute("SELECT * FROM hosts WHERE ip=?", (ref,)).fetchone()
    if r:
        return dict(r)
    rows = conn.execute("SELECT * FROM hosts WHERE lower(hostname)=lower(?)", (ref,)).fetchall()
    if len(rows) == 1:
        return dict(rows[0])
    if rows:
        raise ActionError(f"Several hosts are called '{ref}'; ask again using the IP address.")
    raise ActionError(f"There's no host '{ref}' in Boltarr.")


def _service(conn, name, host_ref=None) -> dict:
    name = str(name or "").strip()
    if not name:
        raise ActionError("No service given.")
    q = ("SELECT s.*, h.ip AS host_ip, h.hostname AS host_name FROM services s "
         "LEFT JOIN hosts h ON h.id = s.host_id WHERE lower(s.name)=lower(?)")
    rows = [dict(r) for r in conn.execute(q, (name,))]
    if host_ref:
        h = _host(conn, host_ref)
        rows = [r for r in rows if r["host_id"] == h["id"]]
    if len(rows) == 1:
        return rows[0]
    if rows:
        raise ActionError(f"Several services are called '{name}'; ask again naming the host.")
    raise ActionError(f"There's no service '{name}'" + (f" on {host_ref}" if host_ref else "") + " in Boltarr.")


def _label(h: dict) -> str:
    return f"{h['hostname']} ({h['ip']})" if h.get("hostname") else h["ip"]


def _svc_label(s: dict) -> str:
    on = s.get("host_name") or s.get("host_ip")
    return f"{s['name']} on {on}" if on else s["name"]


def _text(p: dict, key: str, limit: int) -> str:
    v = p.get(key)
    if v is None:
        raise ActionError(f"No {key} given.")
    v = str(v).strip()
    if len(v) > limit:
        raise ActionError(f"The {key} is longer than {limit} characters.")
    return v


def _profile(conn, name) -> dict:
    """A scan profile by name (any case); Standard when none is given."""
    name = str(name or "Standard").strip()
    r = conn.execute("SELECT * FROM scan_profiles WHERE lower(name)=lower(?)", (name,)).fetchone()
    if not r:
        names = ", ".join(x["name"] for x in conn.execute("SELECT name FROM scan_profiles ORDER BY builtin DESC, name"))
        raise ActionError(f"There's no scan profile '{name}'. Profiles: {names}.")
    try:
        opts = json.loads(r["options"] or "{}")
    except ValueError:
        opts = {}
    return {"name": r["name"], "options": opts}


def _subnet(conn, ref) -> dict:
    """A subnet by CIDR or name (any case)."""
    ref = str(ref or "").strip()
    if not ref:
        raise ActionError("No subnet given.")
    rows = conn.execute("SELECT * FROM subnets WHERE cidr=? OR lower(name)=lower(?)", (ref, ref)).fetchall()
    if len(rows) == 1:
        return dict(rows[0])
    if rows:
        raise ActionError(f"Several subnets match '{ref}'; ask again using the CIDR.")
    raise ActionError(f"There's no subnet '{ref}' in Boltarr.")


def _tz():
    """Boltarr's timezone; UTC when none is set (the same as the chat's data)."""
    return get_timezone() or timezone.utc


def local_str(iso) -> str:
    """A stored UTC time as 'YYYY-MM-DD HH:MM' in Boltarr's timezone, marked UTC when none is set."""
    try:
        t = datetime.fromisoformat(str(iso).replace("Z", "+00:00")).astimezone(_tz()).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return str(iso)
    return t if get_timezone() else t + " UTC"


def _until(v) -> str | None:
    """The AI's 'until' (local 'YYYY-MM-DD HH:MM' or 'HH:MM' = next time that comes)
    as UTC ISO, or None for no end."""
    if v in (None, ""):
        return None
    v, tz, now = re.sub(r"\s*UTC$", "", str(v).strip(), flags=re.I), _tz(), datetime.now(timezone.utc)
    try:
        if re.fullmatch(r"\d{1,2}:\d{2}", v):
            h, m = map(int, v.split(":"))
            t = now.astimezone(tz).replace(hour=h, minute=m, second=0, microsecond=0)
            if t <= now:
                t += timedelta(days=1)
        else:
            t = datetime.fromisoformat(v.replace("T", " "))
            t = t.replace(tzinfo=tz) if t.tzinfo is None else t
    except ValueError:
        raise ActionError(f"Boltarr couldn't read the time '{v}'. Use YYYY-MM-DD HH:MM.")
    t = t.astimezone(timezone.utc)
    if t <= now:
        raise ActionError(f"{local_str(t.isoformat())} is in the past.")
    if t - now > timedelta(days=PAUSE_MAX_DAYS):
        raise ActionError(f"A pause can last at most {PAUSE_MAX_DAYS} days.")
    return t.isoformat(timespec="seconds")


def _probe_running(ip) -> bool:
    from .scanner import scan_jobs
    with get_conn() as conn:
        ids = [r["id"] for r in conn.execute(
            "SELECT id FROM scan_runs WHERE type='probe' AND host_ip=? AND status='running'", (ip,))]
    return any(scan_jobs.get(i, {}).get("status") not in (None, "completed", "error", "cancelled") for i in ids)


# ── The actions ──────────────────────────────────────────────────────────────
# Each check(conn, p) returns the card: {kind, title, detail?, target?} or raises
# ActionError. Each run(conn, p) does it and returns a short "done" message.

def _check_open_host(conn, p):
    h = _host(conn, p.get("host"))
    return {"kind": "open", "title": f"Open {_label(h)}", "target": {"type": "host", "ip": h["ip"]}}


def _check_open_service(conn, p):
    s = _service(conn, p.get("service"), p.get("host"))
    return {"kind": "open", "title": f"Open {_svc_label(s)}", "target": {"type": "service", "id": s["id"]}}


def _check_explain(conn, p):
    from . import monitor
    if p.get("service"):
        s = _service(conn, p.get("service"), p.get("host"))
        outs = monitor.outages(s["id"], 30 * 86400, 1)
        what, target = _svc_label(s), {"type": "service", "id": s["id"]}
    else:
        h = _host(conn, p.get("host"))
        outs = monitor.host_outages(h["id"], 30 * 86400, 1)
        what, target = _label(h), {"type": "host", "ip": h["ip"]}
    if not outs:
        raise ActionError(f"{what} has no outages in the last 30 days.")
    target["explain"] = True
    return {"kind": "open", "title": f"Explain the latest outage of {what}", "target": target}


def _check_set_note(conn, p):
    h = _host(conn, p.get("host"))
    note = _text(p, "note", NOTE_MAX)
    old = h.get("notes") or ""
    if note == old:
        raise ActionError(f"{_label(h)} already has that note.")
    return {"kind": "change", "item": f"host:{h['id']}", "title": f"Change the note on {_label(h)}",
            "detail": [["From", old or "(no note)"], ["To", note or "(no note)"]]}


def _run_set_note(conn, p):
    h = _host(conn, p.get("host"))
    conn.execute("UPDATE hosts SET notes=? WHERE id=?", (_text(p, "note", NOTE_MAX) or None, h["id"]))
    return f"Note on {_label(h)} changed."


def _check_set_host(conn, p):
    h = _host(conn, p.get("host"))
    rows, new = [], _host_fields(p)
    if "hostname" in new and (h.get("hostname") or "") != new["hostname"]:          # only what changes
        rows.append(["Name", f"{h.get('hostname') or '(none)'} → {new['hostname'] or '(none)'}"])
    if "device_type" in new and (h.get("device_type") or "") != new["device_type"]:
        rows.append(["Type", f"{h.get('device_type') or 'unknown'} → {new['device_type']}"])
    if all((h.get(k) or "") == (v or "") for k, v in new.items()):
        raise ActionError(f"{_label(h)} already has that name and type.")
    return {"kind": "change", "item": f"host:{h['id']}", "title": f"Change {_label(h)}", "detail": rows}


def _host_fields(p) -> dict:
    new = {}
    if p.get("hostname") is not None:
        new["hostname"] = _text(p, "hostname", NAME_MAX)
    if p.get("device_type") is not None:
        t = str(p["device_type"]).strip().lower()
        if t not in DEVICE_TYPES:
            raise ActionError(f"'{t}' isn't a device type Boltarr knows. Types: {', '.join(DEVICE_TYPES)}.")
        new["device_type"] = t
    if not new:
        raise ActionError("Nothing to change: give a hostname and/or a device_type.")
    return new


def _run_set_host(conn, p):
    h = _host(conn, p.get("host"))
    new = _host_fields(p)
    if "hostname" in new:
        new["hostname"] = new["hostname"] or None
    cols = ", ".join(f"{k}=?" for k in new)
    conn.execute(f"UPDATE hosts SET {cols} WHERE id=?", (*new.values(), h["id"]))
    return f"{_label(h)} changed."


def _check_scan(conn, p):
    from .scanner import build_command, is_subnet_scanning
    sn, pr = _subnet(conn, p.get("subnet")), _profile(conn, p.get("profile"))
    if is_subnet_scanning(sn["id"]):
        raise ActionError(f"A scan of {sn['cidr']} is already running.")
    return {"kind": "change", "item": f"subnet:{sn['id']}", "title": f"Scan {sn['name']} ({sn['cidr']}) with {pr['name']}",
            "detail": [["Profile", pr["name"]], ["Command", build_command(pr["options"], sn["cidr"])]],
            "then": {"type": "scans"}}


def _run_scan(conn, p):
    from .scanner import start_scan
    sn, pr = _subnet(conn, p.get("subnet")), _profile(conn, p.get("profile"))
    run_id = conn.execute("INSERT INTO scan_runs (subnet_id) VALUES (?)", (sn["id"],)).lastrowid
    conn.commit()
    start_scan(run_id, sn["cidr"], pr["options"])
    return {"message": f"Scan of {sn['cidr']} with {pr['name']} started.", "run_id": run_id, "subnet_id": sn["id"]}


def _check_probe(conn, p):
    from .scanner import build_command
    h, pr = _host(conn, p.get("host")), _profile(conn, p.get("profile"))
    if (pr["options"] or {}).get("ports") == "none":
        raise ActionError(f"{pr['name']} only finds hosts, it doesn't look at ports; probe with Standard or Full.")
    if _probe_running(h["ip"]):
        raise ActionError(f"{_label(h)} is already being probed.")
    return {"kind": "change", "item": f"host:{h['id']}", "title": f"Probe {_label(h)} with {pr['name']}",
            "detail": [["Profile", pr["name"]], ["Command", build_command(pr["options"], h["ip"])]],
            "then": {"type": "scans"}}


def _run_probe(conn, p):
    from .scanner import start_probe
    h, pr = _host(conn, p.get("host")), _profile(conn, p.get("profile"))
    run_id = conn.execute("INSERT INTO scan_runs (type, host_ip, status) VALUES ('probe', ?, 'running')",
                          (h["ip"],)).lastrowid
    conn.commit()
    start_probe(run_id, h["ip"], pr["options"])
    return {"message": f"Probe of {_label(h)} with {pr['name']} started.", "run_id": run_id, "ip": h["ip"]}


def _check_pause(conn, p):
    s = _service(conn, p.get("service"), p.get("host"))
    if not s.get("monitored"):
        raise ActionError(f"{_svc_label(s)} isn't being monitored, so there's nothing to pause.")
    until = _until(p.get("until"))
    return {"kind": "change", "item": f"service:{s['id']}", "title": f"Pause monitoring of {_svc_label(s)}",
            "detail": [["Until", local_str(until) if until else "you turn it back on"]]}


def _run_pause(conn, p):
    from . import monitor
    s = _service(conn, p.get("service"), p.get("host"))
    until = _until(p.get("until"))
    monitor.set_monitored(conn, s["id"], False, until)
    return {"message": f"Monitoring of {_svc_label(s)} paused" +
                       (f" until {local_str(until)}." if until else "."), "service_id": s["id"]}


def _check_resume(conn, p):
    s = _service(conn, p.get("service"), p.get("host"))
    if s.get("monitored"):
        raise ActionError(f"{_svc_label(s)} is already being monitored.")
    was = s.get("monitor_resume_at")
    return {"kind": "change", "item": f"service:{s['id']}", "title": f"Turn monitoring of {_svc_label(s)} back on",
            "detail": [["Paused until", local_str(was)]] if was else []}


def _run_resume(conn, p):
    from . import monitor
    s = _service(conn, p.get("service"), p.get("host"))
    monitor.set_monitored(conn, s["id"], True)
    return {"message": f"Monitoring of {_svc_label(s)} is back on.", "service_id": s["id"], "resumed": True}


def _after_monitor(res):
    """Once the change is saved: check the service now and update the status page."""
    from . import monitor
    try:
        if res.get("resumed"):
            monitor.check_now(res["service_id"])
        monitor.push_status()
    except Exception:
        pass


ACTIONS = {
    "open_host":    {"check": _check_open_host,
                     "help": 'open a host\'s panel: {"do":"open_host","host":"<IP>"}'},
    "open_service": {"check": _check_open_service,
                     "help": 'open a service\'s panel: {"do":"open_service","service":"<name>","host":"<IP>"}'},
    "explain":      {"check": _check_explain,
                     "help": 'explain the latest outage of a service {"do":"explain","service":"<name>","host":"<IP>"} '
                             'or of a whole host {"do":"explain","host":"<IP>"}'},
    "set_note":     {"check": _check_set_note, "run": _run_set_note,
                     "help": 'replace a host\'s note (keep any old text you want to keep): '
                             '{"do":"set_note","host":"<IP>","note":"<text>"}'},
    "set_host":     {"check": _check_set_host, "run": _run_set_host,
                     "help": 'change a host\'s name and/or device type: '
                             '{"do":"set_host","host":"<IP>","hostname":"<name>","device_type":"<type>"}'},
    "scan":         {"check": _check_scan, "run": _run_scan,
                     "help": 'scan a whole subnet: {"do":"scan","subnet":"<subnet name or CIDR>","profile":"<profile>"}'},
    "probe":        {"check": _check_probe, "run": _run_probe,
                     "help": 'scan one host (a probe): {"do":"probe","host":"<IP>","profile":"<profile>"}'},
    "pause_monitor": {"check": _check_pause, "run": _run_pause, "after": _after_monitor,
                      "help": 'pause monitoring of a service, optionally until a local time: '
                              '{"do":"pause_monitor","service":"<name>","host":"<IP>","until":"YYYY-MM-DD HH:MM"} '
                              '(leave out "until" to pause until the user turns it back on; '
                              'the time is in the same timezone as "Current time")'},
    "resume_monitor": {"check": _check_resume, "run": _run_resume, "after": _after_monitor,
                       "help": 'turn monitoring of a service back on: '
                               '{"do":"resume_monitor","service":"<name>","host":"<IP>"}'},
}


_LEAD = re.compile(r"^\s*([A-Za-z_]+)\s*(?=\{)")


def _loads_lenient(text: str):
    """json.loads, then again with small mistakes fixed: single quotes, a trailing comma."""
    try:
        return json.loads(text)
    except ValueError:
        pass
    fixed = re.sub(r",\s*([}\]])", r"\1", text)
    if '"' not in fixed:
        fixed = fixed.replace("'", '"')
    return json.loads(fixed)


def _parse(raw) -> dict:
    p = raw
    if isinstance(raw, str):
        word, text = None, raw
        m = _LEAD.match(raw)
        if m:
            word, text = m.group(1).lower(), raw[m.end():]
        try:
            p = _loads_lenient(text.strip())
        except ValueError:
            raise ActionError("Boltarr couldn't read this suggestion.")
        if isinstance(p, dict) and not p.get("do") and word and word != "action":
            p = {"do": word, **p}
    if isinstance(p, dict) and isinstance(p.get("do"), str):
        p = {**p, "do": p["do"].strip().lower()}
    if not isinstance(p, dict) or p.get("do") not in ACTIONS:
        raise ActionError("Boltarr can't do this: it isn't one of the actions the AI may suggest.")
    return p


def check(raw) -> dict:
    """The card for one suggestion: {ok: True, action, kind, title, ...} or {ok: False, error}."""
    try:
        p = _parse(raw)
        with get_conn() as conn:
            card = ACTIONS[p["do"]]["check"](conn, p)
        return {"ok": True, "action": p, **card}
    except ActionError as e:
        return {"ok": False, "error": str(e)}


def run(raw, model: str = "", asked: str = "") -> dict:
    """Do a "change" action after the user clicked Do it. Checks it again first,
    since the data may have changed since the card was shown. Recorded in the AI
    actions record (done or failed), with the model and what the user asked."""
    card = {}
    try:
        p = _parse(raw)
        a = ACTIONS[p["do"]]
        if "run" not in a:
            raise ActionError("This action only opens something on screen.")
        with get_conn() as conn:
            card = a["check"](conn, p)
            res = a["run"](conn, p)
            conn.commit()
        res = res if isinstance(res, dict) else {"message": res}
        if "after" in a:
            a["after"](res)
        _record(raw, card, "done", res["message"], model, asked)
        return {"ok": True, **res}
    except ActionError as e:
        _record(raw, card, "failed", str(e), model, asked)
        return {"ok": False, "error": str(e)}


def cancel(raw, model: str = "", asked: str = "") -> dict:
    """The user clicked Cancel: nothing is done, only recorded."""
    c = check(raw)
    if c["ok"] and c["kind"] == "change":
        _record(raw, c, "cancelled", "Nothing was changed.", model, asked)
    return {"ok": True}


def _record(raw, card: dict, result: str, message: str, model: str, asked: str) -> None:
    from . import ai_history
    p = raw if isinstance(raw, dict) else {}
    if not p:
        try:
            p = json.loads(raw)
        except (TypeError, ValueError):
            p = {}
    do = str(p.get("do") or "?") if isinstance(p, dict) else "?"
    try:
        ai_history.save_action(card.get("item", "other"), do, card.get("title") or do.replace("_", " "),
                               card.get("detail"), result, message, model, asked)
    except Exception:
        pass         # the record must never stop the action itself


def prompt_section() -> str:
    """The part of the chat system message that teaches the AI the marker."""
    lines = "\n".join(f"- {k}: {a['help']}" for k, a in ACTIONS.items())
    with get_conn() as conn:
        subnets = "; ".join(f"\"{r['name']}\" = {r['cidr']}" for r in conn.execute("SELECT cidr, name FROM subnets ORDER BY id"))
        profiles = ", ".join(r["name"] for r in conn.execute("SELECT name FROM scan_profiles ORDER BY builtin DESC, name"))
    return (
        "ACTIONS: you can't change anything yourself, but you can suggest an action. Boltarr shows it "
        "to the user as a card with a button, and only does it if they click. Suggest one only when the "
        "user asks you to do, change or show something. Put each suggestion on its own line, exactly like:\n"
        '[[action {"do":"set_note","host":"10.0.0.5","note":"Backup NAS"}]]\n'
        "The line ALWAYS starts with [[action (never [[set_note or another action name), the action's "
        'name goes in "do", the JSON uses double quotes, and the line ends with ]]. No code block.\n'
        "Use IPs and names exactly as they appear in the data. Never say an action is done; say you've "
        "suggested it. Available actions:\n" + lines + "\n"
        f"Device types: {', '.join(DEVICE_TYPES)}.\n"
        f"Subnets: {subnets or 'none'}.\n"
        f"Scan profiles: {profiles} (Standard if the user doesn't say; Quick only finds hosts, so never "
        "use it for a probe). After a scan or probe starts, you don't know its results until the user tells you.\n"
        "Anything else (deleting, settings, SSH keys, backups) isn't possible: say the user can do it in Boltarr."
    )
