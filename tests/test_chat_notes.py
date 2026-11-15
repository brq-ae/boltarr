"""F-33: what the chat AI and Analyze Network see — the ranking (4 down/recently
offline … 1 long gone), short reasons for offline hosts, full notes for hosts
the conversation is about, ongoing outages, grouped history queries, notes
built off the event loop, the same limits for Analyze Network, "data, never
instructions", and the note card's Add to note / Replace note."""
import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest

from backend import ai_actions, llm, main, monitor
from backend.database import get_conn

NET = "10.33.0"
NOW = datetime.now(timezone.utc)


def _iso(d):
    return d.isoformat(timespec="seconds")


@pytest.fixture
def lab(client):
    """A small network with offline hosts of every age."""
    ids = {}
    with get_conn() as conn:
        def host(last, name, **kw):
            cols = ["ip", "hostname"] + list(kw)
            conn.execute(f"INSERT INTO hosts ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                         [f"{NET}.{last}", name, *kw.values()])
            ids[name] = conn.execute("SELECT id FROM hosts WHERE ip=?", (f"{NET}.{last}",)).fetchone()[0]
            return ids[name]
        def went_down(hid, ago):
            conn.execute("INSERT INTO host_events (host_id, status, ts) VALUES (?, 'up', ?)", (hid, _iso(NOW - ago - timedelta(days=1))))
            conn.execute("INSERT INTO host_events (host_id, status, ts) VALUES (?, 'down', ?)", (hid, _iso(NOW - ago)))
        went_down(host(2, "demo-off-2h", online=0, device_type="phone"), timedelta(hours=2))
        went_down(host(3, "demo-off-10d", online=0, device_type="phone"), timedelta(days=10))
        host(4, "demo-gone", online=0, device_type="phone", last_seen=_iso(NOW - timedelta(days=45)).replace("T", " ")[:19])
        host(5, "demo-never", online=0, device_type="camera", source="manual")
        host(6, "demo-switch", online=1, device_type="switch")
        web = host(7, "demo-web", online=1, device_type="server")
        conn.execute("INSERT INTO ports (host_id, port, state, service) VALUES (?, 443, 'open', 'https')", (web,))
        host(8, "demo-quiet", online=1, device_type="pc")
        nas = host(9, "demo-nas", online=1, device_type="nas", notes="A" * 400 + " END-OF-NOTE")
        sid = conn.execute("INSERT INTO services (host_id, name, monitored, monitor_status) VALUES (?, 'Demo vault', 1, 'down')",
                           (nas,)).lastrowid
        conn.execute("INSERT INTO monitor_events (service_id, status, ts) VALUES (?, 'up', ?)", (sid, _iso(NOW - timedelta(hours=5))))
        conn.execute("INSERT INTO monitor_events (service_id, status, ts) VALUES (?, 'down', ?)", (sid, _iso(NOW - timedelta(minutes=30))))
        conn.commit()
    yield ids
    with get_conn() as conn:
        conn.execute("DELETE FROM services WHERE host_id IN (SELECT id FROM hosts WHERE ip LIKE ?)", (f"{NET}.%",))
        conn.execute("DELETE FROM hosts WHERE ip LIKE ?", (f"{NET}.%",))
        conn.commit()


def _ctx(*user):
    return main._chat_context([{"role": "user", "content": u} for u in user])


def _rank(ctx_ids, monkeypatch):
    """The order hosts go into the full block, as (priority, name)."""
    got = []
    real = main._rank_host
    monkeypatch.setattr(main, "_rank_host", lambda h, *a: got.append((h["hostname"], real(h, *a))) or got[-1][1])
    return got


# ── the ranking ─────────────────────────────────────────────────────────────────

def test_the_ranking(lab, monkeypatch):
    got = _rank(lab, monkeypatch)
    _ctx("hello")
    rank = {name: r for name, r in got if name and name.startswith("demo-") and name != "demo-tz"}
    assert rank["demo-off-2h"] == (4, "offline 2 h")
    assert rank["demo-nas"][0] == 4                                   # a monitored service is down
    assert rank["demo-switch"] == (3, "")                             # network gear
    assert rank["demo-off-10d"][0] == 2 and rank["demo-off-10d"][1].startswith("away since ")
    assert rank["demo-web"] == (2, "")                                # open ports
    assert rank["demo-gone"][0] == 1 and rank["demo-gone"][1].startswith("away since ")   # past stale_days (30)
    assert rank["demo-never"] == (1, "never seen online")
    assert rank["demo-quiet"] == (1, "")                              # nothing open


def test_stale_days_comes_from_the_setting(lab, monkeypatch):
    from backend import config
    cfg = config.get_config()
    cfg["ip_history"]["stale_days"] = 60
    config.save_config(cfg)
    try:
        got = _rank(lab, monkeypatch)
        _ctx("hello")
        assert dict(got)["demo-gone"][0] == 2                          # 45 days < 60
    finally:
        cfg["ip_history"]["stale_days"] = 30
        config.save_config(cfg)


def test_reasons_show_in_the_notes(lab, monkeypatch):
    monkeypatch.setattr(main, "_HOST_CAP", 2)
    c = _ctx("hello")
    full = c[c.index("Hosts in full detail"):c.index("Other hosts")]
    assert f"{NET}.2 (demo-off-2h" in full and "status=offline (offline 2 h)" in full     # top priority, in full
    other = c[c.index("Other hosts"):]
    assert ".5 demo-never camera [never seen online]" in other
    assert ".3 demo-off-10d phone [away since " in other
    assert f"{NET}.2 (demo-off-2h, offline 2 h)" in c[c.index("Currently down"):]


# ── notes ───────────────────────────────────────────────────────────────────────

def test_a_host_the_chat_is_about_gets_its_whole_note(lab):
    assert "END-OF-NOTE" in _ctx("what's the note on demo-nas?")
    short = _ctx("hello")
    assert "END-OF-NOTE" not in short and "…(note continues)" in short


# ── outages, framing, speed ─────────────────────────────────────────────────────

def test_an_ongoing_outage_is_called_ongoing(lab):
    c = _ctx("hello")
    out = c[c.index("Recent outages"):]
    assert "Demo vault on" in out and "(ongoing)" in out.split("Demo vault on")[1].splitlines()[0]


def test_network_data_is_framed_as_data(lab):
    assert main.UNTRUSTED_DATA_LINE in _ctx("hello")
    assert llm.UNTRUSTED in llm.build_host_prompt({"ip": "10.0.0.1"}, [])
    assert llm.UNTRUSTED in llm.build_network_prompt([], [], [], [])


def test_history_comes_from_grouped_queries(lab, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("per-item history query")
    for fn in ("uptime", "outages", "host_outages", "host_uptime"):
        monkeypatch.setattr(monitor, fn, boom)
    c = _ctx("hello")
    assert "up24h=" in c and "Recent outages" in c


def test_chat_notes_are_built_off_the_event_loop(client, monkeypatch):
    seen = {}

    def fake_prompt(messages):
        try:
            asyncio.get_running_loop()
            seen["on_loop"] = True
        except RuntimeError:
            seen["on_loop"] = False
        return "demo system"

    async def fake_stream(messages, model="", system=""):
        yield "ok"
    monkeypatch.setattr(main, "_chat_prompt", fake_prompt)
    monkeypatch.setattr(main, "chat_stream", fake_stream)
    assert client.post("/api/chat/stream", json={"messages": [{"role": "user", "content": "hi"}]}).text == "ok"
    assert seen["on_loop"] is False


# ── Analyze Network: the same limits ────────────────────────────────────────────

def test_analyze_network_sends_the_top_hosts_in_full_and_the_rest_short(client, lab, monkeypatch):
    with get_conn() as conn:
        for i in range(100, 160):
            conn.execute("INSERT INTO hosts (ip, hostname, device_type, online, notes) VALUES (?, ?, 'phone', 1, ?)",
                         (f"{NET}.{i}", f"demo-p{i}", "N" * 500))
        conn.commit()
    seen = {}

    async def fake_generate(prompt, model=None, timeout=0):
        seen["prompt"] = prompt
        return "Demo network answer."
    monkeypatch.setattr(main, "generate", fake_generate)
    try:
        assert client.post("/api/analyze/network", json={}).status_code == 200
        p = seen["prompt"]
        blocks = p.count("\n[")
        assert blocks == main._HOST_CAP and "most important in full" in p
        assert "== Other hosts" in p and f"{NET}.x:" in p
        assert "status=offline (offline 2 h)" in p                       # top priority made the full list
        assert "N" * 301 not in p                                       # notes cut to 300
        assert llm.UNTRUSTED in p
    finally:
        with get_conn() as conn:
            conn.execute("DELETE FROM llm_analyses WHERE analysis='Demo network answer.'")
            conn.commit()


# ── the note card: Add to note / Replace note ───────────────────────────────────

def _check(client, action):
    return client.post("/api/ai-actions/check", json={"actions": [json.dumps(action)]}).json()["cards"][0]


def _run(client, action):
    return client.post("/api/ai-actions/run", json={"action": action}).json()


def _note(name):
    with get_conn() as conn:
        return conn.execute("SELECT notes FROM hosts WHERE hostname=?", (name,)).fetchone()[0]


def test_note_card_offers_add_or_replace_with_the_full_result(client, lab):
    with get_conn() as conn:
        conn.execute("UPDATE hosts SET notes='Line one' WHERE hostname='demo-switch'")
        conn.commit()
    c = _check(client, {"do": "set_note", "host": "demo-switch", "note": "Line two"})
    assert c["ok"] and [x["mode"] for x in c["choices"]] == ["add", "replace"]
    assert c["detail"] == [["Now", "Line one"], ["Add to note →", "Line one\nLine two"], ["Replace note →", "Line two"]]
    assert _run(client, {**c["action"], "mode": "add"})["ok"] and _note("demo-switch") == "Line one\nLine two"
    c = _check(client, {"do": "set_note", "host": "demo-switch", "note": "Only this"})
    r = _run(client, {**c["action"], "mode": "replace"})
    assert r["ok"] and _note("demo-switch") == "Only this"


def test_note_card_without_a_note_is_a_plain_change(client, lab):
    c = _check(client, {"do": "set_note", "host": "demo-quiet", "note": "First note"})
    assert "choices" not in c and c["detail"] == [["From", "(no note)"], ["To", "First note"]]
    assert _run(client, c["action"])["ok"] and _note("demo-quiet") == "First note"


def test_adding_too_much_is_refused(client, lab):
    with get_conn() as conn:
        conn.execute("UPDATE hosts SET notes=? WHERE hostname='demo-switch'", ("x" * (ai_actions.NOTE_ADD_MAX - 5),))
        conn.commit()
    c = _check(client, {"do": "set_note", "host": "demo-switch", "note": "a longer addition"})
    assert [x["mode"] for x in c["choices"]] == ["replace"] and "too long" in c["detail"][1][1]
    r = _run(client, {**c["action"], "mode": "add"})
    assert not r["ok"] and "longer than" in r["error"]


# ── fitting the notes into the model's window ───────────────────────────────────

def test_currently_down_lists_only_the_recent_ones(lab):
    down = _ctx("hello").split("Currently down:")[1].split("\n\n")[0]
    assert f"{NET}.2 (demo-off-2h, offline 2 h)" in down and "demo-off-10d" not in down and "demo-gone" not in down
    assert "offline for a day or longer" in down


def _use_ollama(num_ctx):
    from backend import config
    cfg = config.get_config()
    old = dict(cfg["llm"])
    cfg["llm"].update(provider="ollama", num_ctx=num_ctx)
    config.save_config(cfg)
    return lambda: (cfg.__setitem__("llm", old), config.save_config(cfg))


def test_the_notes_shrink_to_fit_a_small_window(lab):
    msgs = [main.ChatMsg(role="user", content="Which devices are offline?")]
    undo = _use_ollama(1_000_000)
    try:
        big = main._chat_prompt(msgs)                        # a big window: everything fits
        assert big == main._chat_context(msgs, 0)
        undo(); undo = _use_ollama(1)                        # a tiny window: the smallest step is used
        small = main._chat_prompt(msgs)
        assert small == main._chat_context(msgs, len(main._FIT_STEPS) - 1) and small != big
        assert "of them offline" in small                    # the rest are still counted
    finally:
        undo()


def test_context_0_assumes_ollamas_default(lab):
    undo = _use_ollama(0)
    try:
        assert main._prompt_budget() == 3072                 # 4096, a quarter kept for the answer
    finally:
        undo()


def test_other_providers_are_not_trimmed(lab):
    from backend import config
    cfg = config.get_config()
    old = dict(cfg["llm"])
    cfg["llm"].update(provider="anthropic", num_ctx=1)
    config.save_config(cfg)
    try:
        assert main._prompt_budget() is None
    finally:
        cfg["llm"] = old
        config.save_config(cfg)


def test_roll_call_modes(lab):
    hosts = [{"id": 1, "ip": "10.1.0.5", "hostname": "demo-a", "device_type": "pc"},
             {"id": 2, "ip": "10.1.0.6", "hostname": "demo-b", "device_type": "phone"}]
    why = {2: "away since 1 Sep"}
    assert any("demo-a" in l for l in main._roll_call_lines(hosts, why))
    off = main._roll_call_lines(hosts, why, "offline")
    assert any("demo-b" in l and "[away since 1 Sep]" in l for l in off) and not any("demo-a" in l for l in off)
    assert "1 more online hosts" in off[-1]
    assert main._roll_call_lines(hosts, why, "count") == ["  2 more hosts (1 of them offline), not listed to save room (1 pc, 1 phone)."]
