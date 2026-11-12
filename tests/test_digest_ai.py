"""AI summary in the daily digest (AI Tier 3): off by default, goes at the top when
on, never blocks the digest, and the preview sends nothing and marks nothing."""
import asyncio

import pytest

from backend import changes, llm, notify
from backend.database import get_conn

NET = "10.78.0"


@pytest.fixture
def lab(client):
    """Subnet with a DHCP pool and one static host inside it → one DHCP warning."""
    with get_conn() as conn:
        sid = conn.execute("INSERT INTO subnets (name, cidr, dhcp_start, dhcp_end) VALUES ('Demo AI', ?, ?, ?)",
                           (f"{NET}.0/24", f"{NET}.100", f"{NET}.150")).lastrowid
        conn.execute("INSERT INTO hosts (ip, hostname, static_override, last_seen) VALUES (?, 'demo-nas', 'static', ?)",
                     (f"{NET}.100", "2000-01-01 00:00:00"))
        conn.commit()
    yield sid
    with get_conn() as conn:
        conn.execute("DELETE FROM hosts WHERE ip LIKE ?", (f"{NET}.%",))
        conn.execute("DELETE FROM subnets WHERE id=?", (sid,))
        conn.commit()


@pytest.fixture
def sent(monkeypatch):
    out = []
    monkeypatch.setattr(notify, "send", lambda **kw: out.append(kw))
    return out


def _ai(monkeypatch, reply=None, error=None):
    """Fake AI: answers `reply`, or raises `error`. Records the prompts it got."""
    calls = []

    async def fake_generate(prompt, model="", system="", timeout=0):
        calls.append({"prompt": prompt, "model": model, "system": system})
        if error:
            raise error
        return reply
    monkeypatch.setattr(llm, "generate", fake_generate)
    monkeypatch.setattr(llm, "is_configured", lambda: True)
    monkeypatch.setattr(llm, "get_default_model", lambda: "demo-default")
    return calls


def _settings(client, **ca):
    r = client.put("/api/settings/change-alerts", json=ca)
    assert r.status_code == 200, r.text


def _reset_dhcp_flags():
    with get_conn() as conn:
        conn.execute("UPDATE hosts SET dhcp_reported=NULL WHERE ip LIKE ?", (f"{NET}.%",))
        conn.execute("UPDATE subnets SET pool_reported=0")
        conn.commit()


def test_off_by_default(client):
    ca = client.get("/api/settings").json()["change_alerts"]
    assert ca["digest_ai"] is False and ca["digest_ai_model"] == ""


def test_settings_save_switch_and_model(client):
    _settings(client, digest_ai=True, digest_ai_model="demo-model:7b")
    ca = client.get("/api/settings").json()["change_alerts"]
    assert ca["digest_ai"] is True and ca["digest_ai_model"] == "demo-model:7b"
    _settings(client, digest_ai=False, digest_ai_model="")
    ca = client.get("/api/settings").json()["change_alerts"]
    assert ca["digest_ai"] is False and ca["digest_ai_model"] == ""


def test_summary_goes_on_top(client, lab, sent, monkeypatch):
    _reset_dhcp_flags()
    calls = _ai(monkeypatch, reply="<think>hmm</think> One **warning** about demo-nas.  Nothing needs attention.")
    monkeypatch.setattr(changes, "get_change_alerts_config",
                        lambda: {"enabled": True, "digest_ai": True, "digest_ai_model": "demo-model"})
    changes.send_digest()
    assert len(sent) == 1
    body = sent[0]["message"]
    assert body.startswith("🤖 AI summary\nOne warning about demo-nas. Nothing needs attention.\n\n")
    assert "DHCP warnings" in body and "demo-nas" in body          # the normal list stays
    assert calls[0]["model"] == "demo-model"
    assert "demo-nas" in calls[0]["prompt"]                         # the AI saw the facts


@pytest.mark.parametrize("error", [llm.LLMError("AI request failed"), asyncio.TimeoutError()])
def test_ai_failure_still_sends_the_digest(client, lab, sent, monkeypatch, error):
    _reset_dhcp_flags()
    _ai(monkeypatch, error=error)
    monkeypatch.setattr(changes, "get_change_alerts_config",
                        lambda: {"enabled": True, "digest_ai": True})
    changes.send_digest()
    assert len(sent) == 1
    assert "AI summary" not in sent[0]["message"] and "DHCP warnings" in sent[0]["message"]


def test_switch_off_never_calls_the_ai(client, lab, sent, monkeypatch):
    _reset_dhcp_flags()
    calls = _ai(monkeypatch, reply="should not be used")
    monkeypatch.setattr(changes, "get_change_alerts_config", lambda: {"enabled": True, "digest_ai": False})
    changes.send_digest()
    assert len(sent) == 1 and not calls


def test_preview_sends_nothing_and_marks_nothing(client, lab, sent, monkeypatch):
    _reset_dhcp_flags()
    _ai(monkeypatch, reply="Demo summary.")
    for _ in range(2):   # twice: a real digest would report the warning only once
        d = client.get("/api/digest/preview", params={"ai": 1, "model": "demo-model"}).json()
        assert d["body"].startswith("🤖 AI summary\nDemo summary.") and "demo-nas" in d["body"]
        assert d["ai_error"] is None
    assert not sent
    with get_conn() as conn:
        assert conn.execute("SELECT dhcp_reported FROM hosts WHERE ip=?", (f"{NET}.100",)).fetchone()[0] is None


def test_preview_reports_why_the_ai_was_left_out(client, lab, monkeypatch):
    _reset_dhcp_flags()
    _ai(monkeypatch, error=llm.LLMError("AI request failed (ollama): refused"))
    d = client.get("/api/digest/preview", params={"ai": 1}).json()
    assert "AI summary" not in d["body"] and "refused" in d["ai_error"]


def test_default_model_used_and_clear_message_without_one(client, lab, monkeypatch):
    _reset_dhcp_flags()
    calls = _ai(monkeypatch, reply="Demo summary.")
    client.get("/api/digest/preview", params={"ai": 1, "model": ""})
    assert calls[-1]["model"] == "demo-default"
    monkeypatch.setattr(llm, "get_default_model", lambda: "")
    d = client.get("/api/digest/preview", params={"ai": 1, "model": ""}).json()
    assert d["ai_error"].startswith("No AI model chosen")


def test_preview_with_nothing_to_report(client, monkeypatch):
    monkeypatch.setattr(changes, "build_digest", lambda mark=True, services=None: None)
    assert client.get("/api/digest/preview").json() == {"title": None, "body": None, "ai_error": None}


@pytest.fixture
def svc_outages(client):
    """Two monitored demo services: one was down 20 min and came back, one is still down."""
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    iso = lambda m: (now - timedelta(minutes=m)).isoformat(timespec="seconds")
    with get_conn() as conn:
        hid = conn.execute("INSERT INTO hosts (ip, hostname, last_seen) VALUES (?, 'demo-web', ?)",
                           (f"{NET}.20", "2000-01-01 00:00:00")).lastrowid
        a = conn.execute("INSERT INTO services (host_id, name, port, monitored, monitor_status) "
                         "VALUES (?, 'Demo API', 80, 1, 'up')", (hid,)).lastrowid
        b = conn.execute("INSERT INTO services (host_id, name, port, monitored, monitor_status) "
                         "VALUES (?, 'Demo DB', 5432, 1, 'down')", (hid,)).lastrowid
        conn.executemany("INSERT INTO monitor_events (service_id, status, ts) VALUES (?,?,?)",
                         [(a, "up", iso(300)), (a, "down", iso(120)), (a, "up", iso(100)),
                          (b, "up", iso(300)), (b, "down", iso(30))])
        conn.commit()
    yield
    with get_conn() as conn:
        conn.execute("DELETE FROM services WHERE host_id=?", (hid,))
        conn.execute("DELETE FROM hosts WHERE id=?", (hid,))
        conn.commit()


def test_services_section_in_the_list(client, svc_outages, sent, monkeypatch):
    monkeypatch.setattr(changes, "get_change_alerts_config", lambda: {"enabled": True, "digest_ai": False})
    changes.send_digest()
    assert len(sent) == 1
    assert "2 service outages" in sent[0]["title"]
    body = sent[0]["message"]
    assert "Services\n" in body
    assert "🟢 Demo API on demo-web: down at" in body and "for 20 min, back up" in body
    assert "🔴 Demo DB on demo-web: down since" in body and "still down" in body


def test_services_tick_off_leaves_them_out(client, svc_outages, sent, monkeypatch):
    assert client.get("/api/settings").json()["change_alerts"]["digest_services"] is True   # on by default
    monkeypatch.setattr(changes, "get_change_alerts_config",
                        lambda: {"enabled": True, "digest_services": False})
    changes.send_digest()
    assert all("Services" not in m["message"] and "service outage" not in m["title"] for m in sent)


def test_preview_follows_the_on_screen_services_tick(client, svc_outages):
    on = client.get("/api/digest/preview", params={"services": 1}).json()
    off = client.get("/api/digest/preview", params={"services": 0}).json()
    assert "Services\n" in on["body"]
    assert off["body"] is None or "Services\n" not in off["body"]
