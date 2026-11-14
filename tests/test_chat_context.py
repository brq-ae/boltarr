"""AI look-ups (R-21): the chat AI gets full detail for the hosts the conversation
mentions, a short roll-call line for every other host, and an open-ports index."""
import pytest

from backend import llm, main
from backend.database import get_conn

NET = "10.77.0"


@pytest.fixture
def big_lab(client, monkeypatch):
    """60 plain clients + one router with SSH, so the full block (cap 5 here) can't hold them all."""
    monkeypatch.setattr(main, "_HOST_CAP", 5)
    with get_conn() as conn:
        r = conn.execute("INSERT INTO hosts (ip, hostname, device_type) VALUES (?, 'demo-gw', 'router')",
                         (f"{NET}.1",)).lastrowid
        conn.execute("INSERT INTO ports (host_id, port, state, service) VALUES (?, 22, 'open', 'ssh')", (r,))
        for i in range(10, 70):
            h = conn.execute("INSERT INTO hosts (ip, hostname, device_type, vendor, notes) VALUES (?, ?, 'phone', ?, ?)",
                             (f"{NET}.{i}", f"demo-phone-{i}.lan", "Initech Inc." if i == 66 else "Acme",
                              f"demo note {i}")).lastrowid
            if i in (50, 60):
                conn.execute("INSERT INTO ports (host_id, port, state, service) VALUES (?, 22, 'open', 'ssh')", (h,))
        conn.execute("UPDATE hosts SET online=0 WHERE ip=?", (f"{NET}.69",))
        conn.commit()
    yield
    with get_conn() as conn:
        conn.execute("DELETE FROM ports WHERE host_id IN (SELECT id FROM hosts WHERE ip LIKE ?)", (f"{NET}.%",))
        conn.execute("DELETE FROM hosts WHERE ip LIKE ?", (f"{NET}.%",))
        conn.commit()


def _ctx(*user):
    return main._chat_context([{"role": "user", "content": u} for u in user])


def test_every_host_is_listed_even_past_the_cap(big_lab, monkeypatch):
    monkeypatch.setattr(main, "_HOST_CAP", 0)                      # offline .69 would be in full detail
    c = _ctx("hello")
    assert "more hosts not shown" not in c and "Ask about a specific IP" not in c
    assert f"{NET}.x:" in c
    assert "    .42 demo-phone-42.lan phone Acme" in c            # roll-call line
    assert "    .69 demo-phone-69.lan phone Acme [off]" in c
    assert "demo note 42" not in c                                 # notes only in full detail


def test_hosts_the_user_names_get_full_detail(big_lab):
    c = _ctx(f"what is {NET}.42?", "and demo-phone-43?")          # IP, hostname without its domain
    assert "demo note 42" in c and "demo note 43" in c
    assert "    .42 demo-phone-42" not in c                        # not listed twice


def test_follow_up_finds_the_host_from_the_ai_reply(big_lab):
    c = main._chat_context([{"role": "user", "content": "anything odd?"},
                            {"role": "assistant", "content": "demo-phone-44.lan looks odd."},
                            {"role": "user", "content": "pause it"}])
    assert "demo note 44" in c


def test_vendor_matches_and_short_words_dont(big_lab):
    assert "demo note 66" in _ctx("what is that initech thing?")
    full = lambda c: c.split("Other hosts")[0].split("Hosts in full detail")[1]
    assert full(_ctx("is acm ok? and phone 4?")) == full(_ctx("hi"))   # too short / not a whole name


def test_pins_are_capped(big_lab, monkeypatch):
    monkeypatch.setattr(main, "_HOST_CAP", 4)                      # .69 .1 .50 .60 only
    c = _ctx(" ".join(f"{NET}.{i}" for i in range(10, 40)))
    assert sum(f"demo note {i}'" in c for i in range(10, 40)) == main._PIN_CAP


def test_ports_index_lists_every_host_with_the_port(big_lab):
    c = _ctx("which devices have ssh open?")
    assert f"22/ssh: {NET}.1 {NET}.50 {NET}.60" in c


def test_roll_call_falls_back_to_a_count(big_lab, monkeypatch):
    monkeypatch.setattr(main, "_ROLL_CAP", 10)
    assert "more hosts, too many to list (" in _ctx("hi")


def test_ollama_gets_the_context_window(monkeypatch):
    assert llm._ollama_opts({"num_ctx": 8192}) == {"options": {"num_ctx": 8192}}
    assert llm._ollama_opts({"num_ctx": 0}) == {} and llm._ollama_opts({}) == {}


def test_context_window_setting_saves(client):
    r = client.put("/api/settings", json={"num_ctx": 16384})
    assert r.status_code == 200, r.text
    assert client.get("/api/settings").json()["llm"]["num_ctx"] == 16384
    client.put("/api/settings", json={"num_ctx": 8192})
