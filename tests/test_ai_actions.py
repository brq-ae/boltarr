"""AI actions (AI Tier 4): the AI only suggests; Boltarr checks each suggestion
against a fixed list, shows what it would do, and does it only on Do it."""
import json
from datetime import datetime, timedelta, timezone

import pytest

from backend import ai_actions
from backend.database import get_conn

NET = "10.76.0"


@pytest.fixture
def lab(client):
    now = datetime.now(timezone.utc)
    with get_conn() as conn:
        a = conn.execute("INSERT INTO hosts (ip, hostname, device_type, notes, last_seen) VALUES (?, 'demo-nas', 'nas', 'old note', ?)",
                         (f"{NET}.2", "2000-01-01")).lastrowid
        b = conn.execute("INSERT INTO hosts (ip, hostname, last_seen) VALUES (?, 'demo-twin', ?)", (f"{NET}.3", "2000-01-01")).lastrowid
        c = conn.execute("INSERT INTO hosts (ip, hostname, last_seen) VALUES (?, 'demo-twin', ?)", (f"{NET}.4", "2000-01-01")).lastrowid
        s = conn.execute("INSERT INTO services (host_id, name, port, monitored) VALUES (?, 'Demo SMB', 445, 1)", (a,)).lastrowid
        conn.execute("INSERT INTO services (host_id, name, port) VALUES (?, 'Demo Web', 80)", (b,))
        conn.execute("INSERT INTO services (host_id, name, port) VALUES (?, 'Demo Web', 80)", (c,))
        iso = lambda m: (now - timedelta(minutes=m)).isoformat(timespec="seconds")
        conn.executemany("INSERT INTO monitor_events (service_id, status, ts) VALUES (?,?,?)",
                         [(s, "up", iso(300)), (s, "down", iso(60)), (s, "up", iso(50))])
        conn.commit()
    yield {"nas": a, "smb": s}
    with get_conn() as conn:
        conn.execute("DELETE FROM services WHERE host_id IN (?,?,?)", (a, b, c))
        conn.execute("DELETE FROM hosts WHERE ip LIKE ?", (f"{NET}.%",))
        conn.execute("DELETE FROM ai_action_log")
        conn.commit()


def _check(client, *actions):
    r = client.post("/api/ai-actions/check", json={"actions": [json.dumps(a) if isinstance(a, dict) else a for a in actions]})
    assert r.status_code == 200, r.text
    return r.json()["cards"]


def _run(client, action):
    return client.post("/api/ai-actions/run", json={"action": action}).json()


def _note():
    with get_conn() as conn:
        return conn.execute("SELECT notes FROM hosts WHERE ip=?", (f"{NET}.2",)).fetchone()[0]


def test_note_card_shows_the_change_and_changes_nothing(client, lab):
    [c] = _check(client, {"do": "set_note", "host": f"{NET}.2", "note": "Backup NAS"})
    assert c["ok"] and c["kind"] == "change" and c["title"] == f"Change the note on demo-nas ({NET}.2)"
    assert c["detail"] == [["Now", "old note"], ["Add to note →", "old note\nBackup NAS"], ["Replace note →", "Backup NAS"]]
    assert _note() == "old note"                                   # checking does nothing
    r = _run(client, {"do": "set_note", "host": "DEMO-NAS", "note": "Backup NAS"})   # hostname, any case
    assert r == {"ok": True, "message": f"Note on demo-nas ({NET}.2) changed."} and _note() == "Backup NAS"


def test_set_host_name_and_type(client, lab):
    [c] = _check(client, {"do": "set_host", "host": f"{NET}.2", "hostname": "demo-store", "device_type": "Server"})
    assert c["ok"] and c["detail"] == [["Name", "demo-nas → demo-store"], ["Type", "nas → server"]]
    assert _run(client, c["action"])["ok"]
    with get_conn() as conn:
        assert tuple(conn.execute("SELECT hostname, device_type FROM hosts WHERE id=?", (lab["nas"],)).fetchone()) == ("demo-store", "server")
    [bad] = _check(client, {"do": "set_host", "host": f"{NET}.2", "device_type": "toaster"})
    assert not bad["ok"] and "isn't a device type" in bad["error"]


def test_open_and_explain_cards(client, lab):
    h, s, e, none = _check(client, {"do": "open_host", "host": f"{NET}.2"},
                           {"do": "open_service", "service": "demo smb"},
                           {"do": "explain", "service": "Demo SMB", "host": f"{NET}.2"},
                           {"do": "explain", "host": f"{NET}.2"})
    assert h["kind"] == "open" and h["target"] == {"type": "host", "ip": f"{NET}.2"}
    assert s["target"] == {"type": "service", "id": lab["smb"]}
    assert e["target"] == {"type": "service", "id": lab["smb"], "explain": True}
    assert not none["ok"] and "no outages" in none["error"]
    assert not _run(client, h["action"])["ok"]                     # open actions are never "run"


def test_refuses_unknown_unclear_and_bad_suggestions(client, lab):
    cards = _check(client, {"do": "delete_host", "host": f"{NET}.2"}, "not json",
                   {"do": "open_host", "host": "demo-twin"}, {"do": "open_service", "service": "Demo Web"},
                   {"do": "open_host", "host": "10.76.0.99"}, {"do": "set_note", "host": f"{NET}.2", "note": "x" * 501},
                   {"do": "set_note", "host": f"{NET}.2", "note": "old note"})
    errs = [c["error"] for c in cards]
    assert all(not c["ok"] for c in cards)
    assert "isn't one of the actions" in errs[0] and "couldn't read" in errs[1]
    assert "Several hosts" in errs[2] and "Several services" in errs[3]
    assert "no host" in errs[4] and "longer than 500" in errs[5] and "already has that note" in errs[6]
    assert not _run(client, {"do": "delete_host", "host": f"{NET}.2"})["ok"]
    assert _note() == "old note"


def test_run_checks_again(client, lab):
    with get_conn() as conn:
        conn.execute("DELETE FROM hosts WHERE ip=?", (f"{NET}.3",))
        conn.commit()
    r = _run(client, {"do": "set_note", "host": f"{NET}.3", "note": "x"})
    assert not r["ok"] and "no host" in r["error"]


def test_chat_prompt_teaches_the_marker(client, lab):
    p = ai_actions.prompt_section()
    assert "[[action {" in p and "ALWAYS starts with [[action" in p and all(k in p for k in ai_actions.ACTIONS)


def test_common_slips_are_still_read(client, lab):
    """The AI doesn't always write the line exactly as taught; the same checks apply."""
    cards = _check(client,
                   'set_host {"host":"demo-nas","hostname":"demo-nas2"}',          # [[set_host {...}]], no "do"
                   'set_host {"do":"set_host","host":"demo-nas","hostname":"demo-nas2"}',
                   "{'do': 'open_host', 'host': 'demo-nas'}",                       # single quotes
                   '{"do":"Open_Host","host":"demo-nas",}',                          # trailing comma, any case
                   'action {"host":"demo-nas"}',                                     # no "do" at all
                   'delete_host {"host":"demo-nas"}',                                # the word can't add actions
                   '{"do":"open_host" "host"}')                                      # beyond repair
    assert [c["ok"] for c in cards] == [True, True, True, True, False, False, False]
    assert cards[0]["title"] == f"Change demo-nas ({NET}.2)" and cards[0]["action"]["do"] == "set_host"
    [same_type] = _check(client, {"do": "set_host", "host": "demo-nas", "hostname": "demo-nas2", "device_type": "nas"})
    assert same_type["detail"] == [["Name", "demo-nas → demo-nas2"]]                 # unchanged type isn't shown
    assert "isn't one of the actions" in cards[4]["error"] and "isn't one of the actions" in cards[5]["error"]
    assert "couldn't read" in cards[6]["error"]


# ── Part 2: scan, probe, pause / resume monitoring ───────────────────────────

@pytest.fixture
def demo_subnet(client):
    with get_conn() as conn:
        sid = conn.execute("INSERT INTO subnets (name, cidr) VALUES ('Demo LAN', ?)", (f"{NET}.0/24",)).lastrowid
        conn.commit()
    yield sid
    with get_conn() as conn:
        conn.execute("DELETE FROM scan_runs WHERE subnet_id=? OR host_ip LIKE ?", (sid, f"{NET}.%"))
        conn.execute("DELETE FROM subnets WHERE id=?", (sid,))
        conn.commit()


@pytest.fixture
def no_side_effects(monkeypatch):
    """Record scans/probes/checks instead of really running them."""
    from backend import monitor, scanner
    calls = []
    monkeypatch.setattr(scanner, "start_scan", lambda rid, cidr, o: calls.append(("scan", cidr, o)))
    monkeypatch.setattr(scanner, "start_probe", lambda rid, ip, o: calls.append(("probe", ip, o)))
    monkeypatch.setattr(monitor, "check_now", lambda sid: calls.append(("check", sid)))
    monkeypatch.setattr(monitor, "push_status", lambda: None)
    return calls


def test_scan_card_shows_the_command_and_runs_on_do_it(client, lab, demo_subnet, no_side_effects, monkeypatch):
    [c] = _check(client, {"do": "scan", "subnet": "demo lan", "profile": "full"})
    assert c["ok"] and c["kind"] == "change" and c["title"] == f"Scan Demo LAN ({NET}.0/24) with Full"
    assert c["detail"][0] == ["Profile", "Full"] and f"{NET}.0/24" in c["detail"][1][1] and "-p-" in c["detail"][1][1]
    assert c["then"] == {"type": "scans"} and no_side_effects == []        # checking starts nothing
    r = _run(client, {"do": "scan", "subnet": f"{NET}.0/24"})               # no profile → Standard
    assert r["ok"] and r["subnet_id"] == demo_subnet and r["message"] == f"Scan of {NET}.0/24 with Standard started."
    assert no_side_effects == [("scan", f"{NET}.0/24", {})]
    from backend import scanner
    monkeypatch.setattr(scanner, "is_subnet_scanning", lambda sid: True)
    [busy] = _check(client, {"do": "scan", "subnet": f"{NET}.0/24"})
    assert not busy["ok"] and "already running" in busy["error"]
    [bad] = _check(client, {"do": "scan", "subnet": f"{NET}.0/24", "profile": "Turbo"})
    assert not bad["ok"] and "no scan profile 'Turbo'" in bad["error"]


def test_probe_refuses_discovery_only_profile(client, lab, demo_subnet, no_side_effects):
    [q] = _check(client, {"do": "probe", "host": "demo-nas", "profile": "Quick"})
    assert not q["ok"] and "only finds hosts" in q["error"]
    [c] = _check(client, {"do": "probe", "host": "demo-nas"})
    assert c["ok"] and c["title"] == f"Probe demo-nas ({NET}.2) with Standard" and f"{NET}.2" in c["detail"][1][1]
    r = _run(client, {"do": "probe", "host": "demo-nas"})
    assert r["ok"] and r["ip"] == f"{NET}.2" and no_side_effects == [("probe", f"{NET}.2", {})]


def _svc():
    with get_conn() as conn:
        return dict(conn.execute("SELECT monitored, monitor_resume_at FROM services WHERE name='Demo SMB'").fetchone())


def test_pause_until_then_resumes_by_itself(client, lab, no_side_effects):
    from backend import monitor
    later = (datetime.now(timezone.utc) + timedelta(hours=3)).strftime("%Y-%m-%d %H:%M")   # no timezone set → UTC
    [c] = _check(client, {"do": "pause_monitor", "service": "Demo SMB", "until": later})
    assert c["ok"] and c["title"] == "Pause monitoring of Demo SMB on demo-nas" and c["detail"] == [["Until", later + " UTC"]]
    r = _run(client, {"do": "pause_monitor", "service": "demo smb", "until": later + " UTC"})      # the AI may echo "UTC"
    assert r["ok"] and r["message"].endswith(f"paused until {later} UTC.")
    s = _svc()
    assert s["monitored"] == 0 and s["monitor_resume_at"]
    assert monitor.resume_due() == [] and _svc()["monitored"] == 0             # not yet
    with get_conn() as conn:                                                    # time passes
        conn.execute("UPDATE services SET monitor_resume_at=? WHERE name='Demo SMB'",
                     ((datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(timespec="seconds"),))
        conn.commit()
    client.get("/api/services")                                                 # listing resumes overdue ones
    assert _svc() == {"monitored": 1, "monitor_resume_at": None}


def test_pause_and_resume_rules(client, lab, no_side_effects):
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%d %H:%M")
    far = (datetime.now(timezone.utc) + timedelta(days=40)).strftime("%Y-%m-%d %H:%M")
    cards = _check(client,
                   {"do": "pause_monitor", "service": "Demo SMB", "until": past},
                   {"do": "pause_monitor", "service": "Demo SMB", "until": far},
                   {"do": "pause_monitor", "service": "Demo SMB", "until": "soon"},
                   {"do": "pause_monitor", "service": "Demo Web", "host": f"{NET}.3"},
                   {"do": "resume_monitor", "service": "Demo SMB"},
                   {"do": "pause_monitor", "service": "Demo SMB", "until": "23:59"})
    assert "in the past" in cards[0]["error"] and "at most 30 days" in cards[1]["error"]
    assert "couldn't read the time 'soon'" in cards[2]["error"] and "isn't being monitored" in cards[3]["error"]
    assert "already being monitored" in cards[4]["error"] and cards[5]["ok"]   # HH:MM = next time it comes
    assert _run(client, {"do": "pause_monitor", "service": "Demo SMB"})["message"] == \
        "Monitoring of Demo SMB on demo-nas paused."                            # no end time
    assert _svc() == {"monitored": 0, "monitor_resume_at": None}
    [back] = _check(client, {"do": "resume_monitor", "service": "Demo SMB"})
    assert back["ok"] and back["detail"] == []
    r = _run(client, {"do": "resume_monitor", "service": "Demo SMB"})
    assert r["ok"] and _svc()["monitored"] == 1 and ("check", lab["smb"]) in no_side_effects


def test_turning_monitoring_on_by_hand_ends_a_timed_pause(client, lab, no_side_effects):
    later = (datetime.now(timezone.utc) + timedelta(hours=3)).strftime("%Y-%m-%d %H:%M")
    _run(client, {"do": "pause_monitor", "service": "Demo SMB", "until": later})
    client.post(f"/api/services/{lab['smb']}/monitor", json={"enabled": False})
    assert _svc() == {"monitored": 0, "monitor_resume_at": None}


def test_prompt_lists_subnets_and_profiles(client, demo_subnet):
    p = ai_actions.prompt_section()
    assert f'"Demo LAN" = {NET}.0/24' in p and "Standard" in p and "pause_monitor" in p


def test_chat_says_times_are_utc_without_a_timezone(client, lab, monkeypatch):
    from backend import main
    assert "All times in this data are UTC" in main._chat_context()
    real = main.get_config
    monkeypatch.setattr(main, "get_config", lambda: {**real(), "general": {"timezone": "Europe/London"}})
    assert "All times in this data are UTC" not in main._chat_context()


# ── Part 3: the AI actions record ────────────────────────────────────────────

def _log(client):
    return client.get("/api/ai-actions/log").json()["actions"]


def _settings(client, **ah):
    r = client.put("/api/settings/all", json={"ai_history": {"enabled": True, "keep_per_item": 10, "keep_days": 90, **ah}})
    assert r.status_code == 200, r.text


def test_do_it_and_cancel_are_recorded(client, lab):
    note = {"do": "set_note", "host": f"{NET}.2", "note": "Backup NAS"}
    asked = "Please set the note " + "x" * 400
    client.post("/api/ai-actions/cancel", json={"action": note, "model": "demo-model", "asked": asked})
    client.post("/api/ai-actions/run", json={"action": note, "model": "demo-model", "asked": "set the note"})
    client.post("/api/ai-actions/run", json={"action": {"do": "set_note", "host": "nope", "note": "x"}, "model": "demo-model"})
    client.post("/api/ai-actions/cancel", json={"action": {"do": "open_host", "host": f"{NET}.2"}})   # opens aren't recorded
    failed, done, cancelled = _log(client)
    assert cancelled["result"] == "cancelled" and cancelled["item"] == f"host:{lab['nas']}"
    assert cancelled["detail"] == [["Now", "old note"], ["Add to note →", "old note\nBackup NAS"], ["Replace note →", "Backup NAS"]] and cancelled["model"] == "demo-model"
    assert len(cancelled["asked"]) == 300 and cancelled["asked"].endswith("…")
    assert done["result"] == "done" and done["title"] == f"Change the note on demo-nas ({NET}.2)"
    assert done["message"] == f"Note on demo-nas ({NET}.2) changed." and done["asked"] == "set the note"
    assert failed["result"] == "failed" and failed["item"] == "other" and "no host 'nope'" in failed["message"]


def test_record_follows_the_ai_history_rules(client, lab):
    run = lambda n: client.post("/api/ai-actions/run", json={"action": {"do": "set_note", "host": f"{NET}.2", "note": f"n{n}"}})
    try:
        _settings(client, keep_per_item=2)
        for n in range(4):
            run(n)
        assert [a["message"] for a in _log(client)] == [f"Note on demo-nas ({NET}.2) changed."] * 2   # newest 2 per host
        assert client.get("/api/ai-history").json()["count"] == 2
        _settings(client, enabled=False)
        run(9)
        assert _log(client) == []                                            # off: nothing saved, saved ones hidden
        _settings(client)
        assert len(_log(client)) == 2
        client.post("/api/ai-history/clean")
        assert _log(client) == []
    finally:
        _settings(client)


# ── F-42: one odd suggestion fails only its own card ────────────────────────────

def test_an_odd_suggestion_fails_only_its_card(client, lab, monkeypatch):
    cards = _check(client, {"do": ["set_note"]}, {"do": "open_host", "host": "demo-nas"}, {"do": {"x": 1}},
                   '{"do": "set_note", "host": {"bad": 1}, "note": 5}')
    assert [c["ok"] for c in cards] == [False, True, False, False]
    assert all(c["error"] for c in cards if not c["ok"])
    # an unexpected error inside one action's check is caught the same way
    real = ai_actions.ACTIONS["open_host"]["check"]
    monkeypatch.setitem(ai_actions.ACTIONS["open_host"], "check",
                        lambda conn, p: (_ for _ in ()).throw(KeyError("boom")) if p.get("host") == "demo-twin" else real(conn, p))
    cards = _check(client, {"do": "open_host", "host": "demo-twin"}, {"do": "open_host", "host": "demo-nas"})
    assert cards[0] == {"ok": False, "error": "Boltarr couldn't read this suggestion."} and cards[1]["ok"]


def test_an_odd_suggestion_on_do_it_is_a_failed_card_not_a_crash(client, lab, monkeypatch):
    monkeypatch.setitem(ai_actions.ACTIONS["set_note"], "run", lambda conn, p: 1 / 0)
    r = _run(client, {"do": "set_note", "host": "demo-nas", "note": "x"})
    assert r == {"ok": False, "error": "Boltarr couldn't do this suggestion — nothing was changed."}


def test_analyze_network_uses_the_long_timeout_setting(client, monkeypatch):
    import backend.main as m
    from backend import config
    seen = {}

    async def fake_generate(prompt, model=None, timeout=0):
        seen["timeout"] = timeout
        return "Demo network answer."
    monkeypatch.setattr(m, "generate", fake_generate)
    cfg = config.get_config()
    cfg["llm"]["long_timeout"] = 1234
    config.save_config(cfg)
    try:
        assert client.post("/api/analyze/network", json={}).status_code == 200
        assert seen["timeout"] == 1234
    finally:
        cfg["llm"]["long_timeout"] = 600
        config.save_config(cfg)
        with get_conn() as conn:                     # the tests share one database
            conn.execute("DELETE FROM llm_analyses WHERE analysis='Demo network answer.'")
            conn.commit()


# ── F-31: Do it does exactly what the card showed ───────────────────────────────

def test_card_pins_what_it_shows(client, lab, demo_subnet, no_side_effects):
    later = (datetime.now(timezone.utc) + timedelta(hours=2)).strftime("%Y-%m-%d %H:%M")
    [c] = _check(client, {"do": "pause_monitor", "service": "Demo SMB", "until": later})
    a = c["action"]
    assert a["service_id"] == lab["smb"] and a["until_utc"].startswith(later.replace(" ", "T"))
    [sc] = _check(client, {"do": "scan", "subnet": "demo lan", "profile": "full"})
    assert sc["action"]["subnet_id"] == demo_subnet and sc["action"]["profile_options"] == {"ports": "all"}
    [n] = _check(client, {"do": "set_note", "host": "demo-nas", "note": "Demo pinned"})
    assert n["action"]["host_id"] == lab["nas"]


def test_a_pause_end_that_passed_is_refused_not_moved_to_tomorrow(client, lab, no_side_effects):
    [c] = _check(client, {"do": "pause_monitor", "service": "Demo SMB", "until": "23:59"})
    action = dict(c["action"], until_utc=(datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(timespec="seconds"))
    r = _run(client, action)                                     # clicked after the time it showed
    assert not r["ok"] and "has already passed" in r["error"]
    assert _svc()["monitored"] == 1                              # nothing was done


def test_do_it_uses_the_exact_end_time_shown(client, lab, no_side_effects):
    [c] = _check(client, {"do": "pause_monitor", "service": "Demo SMB", "until": "23:59"})
    assert _run(client, c["action"])["ok"]
    assert _svc()["monitor_resume_at"] == c["action"]["until_utc"]


def test_a_renamed_host_doesnt_send_the_change_to_another(client, lab, no_side_effects):
    [c] = _check(client, {"do": "set_note", "host": "demo-nas", "note": "Demo for the first one"})
    with get_conn() as conn:                    # after the card: names swap around
        conn.execute("UPDATE hosts SET hostname='demo-old-nas' WHERE id=?", (lab["nas"],))
        conn.execute("UPDATE hosts SET hostname='demo-nas' WHERE ip=?", (f"{NET}.3",))
        conn.commit()
    assert _run(client, c["action"])["ok"]
    with get_conn() as conn:
        notes = dict(conn.execute("SELECT id, notes FROM hosts WHERE ip IN (?, ?)", (f"{NET}.2", f"{NET}.3")).fetchall())
    assert notes[lab["nas"]] == "Demo for the first one" and None in notes.values()


def test_a_deleted_host_is_refused(client, lab, no_side_effects):
    [c] = _check(client, {"do": "set_host", "host": f"{NET}.4", "device_type": "camera"})
    with get_conn() as conn:
        conn.execute("DELETE FROM services WHERE host_id=(SELECT id FROM hosts WHERE ip=?)", (f"{NET}.4",))
        conn.execute("DELETE FROM hosts WHERE ip=?", (f"{NET}.4",))
        conn.commit()
    r = _run(client, c["action"])
    assert not r["ok"] and "no longer in Boltarr" in r["error"]


def test_an_edited_profile_doesnt_change_what_runs(client, lab, demo_subnet, no_side_effects):
    with get_conn() as conn:
        conn.execute("INSERT INTO scan_profiles (name, options) VALUES ('Demo pinned', ?)", (json.dumps({"ports": "top1000"}),))
        conn.commit()
    try:
        [c] = _check(client, {"do": "scan", "subnet": "demo lan", "profile": "Demo pinned"})
        with get_conn() as conn:
            conn.execute("UPDATE scan_profiles SET options=? WHERE name='Demo pinned'", (json.dumps({"ports": "all"}),))
            conn.commit()
        assert _run(client, c["action"])["ok"]
        assert no_side_effects[-1] == ("scan", f"{NET}.0/24", {"ports": "top1000"})     # what the card showed
    finally:
        with get_conn() as conn:
            conn.execute("DELETE FROM scan_profiles WHERE name='Demo pinned'")
            conn.commit()


def test_a_pinned_profile_is_still_checked(client, lab, demo_subnet, no_side_effects):
    r = _run(client, {"do": "scan", "subnet_id": demo_subnet, "profile_options": {"scripts": "/etc/demo.nse"}})
    assert not r["ok"] and "won't run" in r["error"] and no_side_effects == []


def test_note_card_still_applies_when_the_old_note_changed(client, lab, no_side_effects):
    """v0.26.0 rule kept: a note card doesn't refuse because "From" changed."""
    [c] = _check(client, {"do": "set_note", "host": "demo-nas", "note": "Demo new note"})
    with get_conn() as conn:
        conn.execute("UPDATE hosts SET notes='changed meanwhile' WHERE id=?", (lab["nas"],))
        conn.commit()
    assert _run(client, c["action"])["ok"]
