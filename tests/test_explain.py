"""Explain on outages (AI Tier 3, part 2): the facts Boltarr gathers by rule, the AI
wording on top (or facts only without an AI), and saving each explanation."""
from datetime import datetime, timedelta, timezone

import pytest

from backend import llm
from backend.database import get_conn

NET = "10.79.0"
NOW = datetime.now(timezone.utc).replace(microsecond=0)
T0 = NOW - timedelta(hours=3)          # the switch outage starts here


def iso(dt):
    return dt.isoformat(timespec="seconds")


@pytest.fixture
def lab(client):
    """demo-router — demo-switch — demo-nas + 2 clients. The switch drops for 10 min
    and takes the others with it; demo-nas's SMB service goes down too. Demo Web on
    demo-web goes down at about the same time of day on 4 nights (host stays up)."""
    ids = {}
    with get_conn() as conn:
        for last, name, dt in [(1, "demo-router", "router"), (2, "demo-switch", "switch"),
                               (3, "demo-nas", "nas"), (4, "demo-c1", "phone"), (5, "demo-c2", "phone"),
                               (6, "demo-web", "server")]:
            ids[name] = conn.execute("INSERT INTO hosts (ip, hostname, device_type, online, last_seen) "
                                     "VALUES (?,?,?,1,?)", (f"{NET}.{last}", name, dt, "2000-01-01")).lastrowid
            conn.execute("INSERT INTO host_events (host_id, status, ts) VALUES (?, 'up', ?)",
                         (ids[name], iso(NOW - timedelta(days=20))))
        for a, b in [(2, 1), (3, 2), (4, 2), (5, 2), (6, 2)]:
            conn.execute("INSERT INTO connections (src_ip, dst_ip) VALUES (?,?)", (f"{NET}.{a}", f"{NET}.{b}"))
        for name, d in [("demo-switch", 0), ("demo-nas", 20), ("demo-c1", 30), ("demo-c2", 40)]:
            conn.execute("INSERT INTO host_events (host_id, status, ts) VALUES (?, 'down', ?)",
                         (ids[name], iso(T0 + timedelta(seconds=d))))
            conn.execute("INSERT INTO host_events (host_id, status, ts) VALUES (?, 'up', ?)",
                         (ids[name], iso(T0 + timedelta(minutes=10))))
        smb = conn.execute("INSERT INTO services (host_id, name, port, monitored) VALUES (?, 'Demo SMB', 445, 1)",
                           (ids["demo-nas"],)).lastrowid
        web = conn.execute("INSERT INTO services (host_id, name, port, monitored) VALUES (?, 'Demo Web', 80, 1)",
                           (ids["demo-web"],)).lastrowid
        api_ = conn.execute("INSERT INTO services (host_id, name, port, monitored) VALUES (?, 'Demo API', 81, 1)",
                            (ids["demo-web"],)).lastrowid
        conn.execute("INSERT INTO service_dependencies (from_service_id, to_service_id) VALUES (?,?)", (web, api_))
        ev = [(smb, "up", NOW - timedelta(days=20)), (smb, "down", T0 + timedelta(seconds=60)),
              (smb, "up", T0 + timedelta(minutes=11)), (web, "up", NOW - timedelta(days=20)),
              (api_, "up", NOW - timedelta(days=20))]
        night = (NOW - timedelta(days=1)).replace(hour=3, minute=0, second=0)
        for k in range(4):
            s = night - timedelta(days=k, minutes=k)      # 03:00, 02:59, 02:58, 02:57
            ev += [(web, "down", s), (web, "up", s + timedelta(minutes=5))]
        ev += [(api_, "down", night - timedelta(minutes=2)), (api_, "up", night + timedelta(minutes=6))]
        conn.executemany("INSERT INTO monitor_events (service_id, status, ts) VALUES (?,?,?)",
                         [(a, b, iso(c)) for a, b, c in ev])
        conn.commit()
    yield {**ids, "smb": smb, "web": web, "api": api_, "night": night}
    with get_conn() as conn:
        conn.execute("DELETE FROM ai_explanations")
        conn.execute("DELETE FROM services WHERE id IN (?,?,?)", (smb, web, api_))
        conn.execute("DELETE FROM connections WHERE src_ip LIKE ?", (f"{NET}.%",))
        conn.execute("DELETE FROM hosts WHERE ip LIKE ?", (f"{NET}.%",))
        conn.commit()


@pytest.fixture
def no_ai(monkeypatch):
    monkeypatch.setattr(llm, "is_configured", lambda: False)


def _ai(monkeypatch, reply="Demo explanation.", error=None):
    calls = []

    async def fake(prompt, model="", system="", timeout=0):
        calls.append({"prompt": prompt, "model": model})
        if error:
            raise error
        return reply
    monkeypatch.setattr(llm, "generate", fake)
    monkeypatch.setattr(llm, "is_configured", lambda: True)
    monkeypatch.setattr(llm, "get_default_model", lambda: "demo-default")
    return calls


def _explain(client, kind, id_, start, model=""):
    r = client.post("/api/explain", json={"kind": kind, "id": id_, "start": start, "model": model})
    assert r.status_code == 200, r.text
    return r.json()["explanation"]


def _facts(x):
    return "\n".join(x["facts"])


def test_switch_outage_points_at_the_switch(client, lab, no_ai):
    x = _explain(client, "service", lab["smb"], iso(T0 + timedelta(seconds=60)))
    f = _facts(x)
    assert "Demo SMB on demo-nas" in f
    assert "The device itself (demo-nas" in f and "was offline at the same time" in f
    assert "demo-switch" in f and "demo-c1" in f and "demo-c2" in f      # went down together
    assert "demo-switch (10.79.0.2) → demo-router (10.79.0.1)" in f       # the path
    assert "demo-switch (10.79.0.2), on that path, was offline" in f
    assert x["summary"] is None and "No AI is set up" in x["ai_error"]    # facts only


def test_host_view_of_the_switch_counts_what_went_with_it(client, lab, no_ai):
    x = _explain(client, "host", lab["demo-switch"], iso(T0))
    assert "3 of the 4 device(s) connected to it" in _facts(x)


def test_nightly_outage_is_called_out_as_scheduled(client, lab, no_ai):
    x = _explain(client, "service", lab["web"], iso(lab["night"]))
    f = _facts(x)
    assert "stayed online, so only this service stopped answering" in f
    assert "went down 4 times" in f and "may be something scheduled" in f
    assert "It depends on Demo API on demo-web" in f and "went down before it" in f
    assert "behind" not in f and "connected to demo-switch" not in f   # switch peers only matter if cut off


def test_ai_words_the_facts_and_it_is_saved(client, lab, monkeypatch):
    calls = _ai(monkeypatch, reply="<think>x</think> The **switch** likely restarted.")
    start = iso(T0 + timedelta(seconds=60))
    x = _explain(client, "service", lab["smb"], start, model="demo-b")
    assert x["summary"] == "The switch likely restarted." and x["model"] == "demo-b" and not x["ai_error"]
    assert "demo-switch" in calls[0]["prompt"]                          # the AI got the facts
    saved = client.get("/api/explain", params={"kind": "service", "id": lab["smb"], "start": start}).json()
    assert saved["explanation"]["id"] == x["id"]
    y = _explain(client, "service", lab["smb"], start)                  # Explain again → newest wins
    assert y["model"] == "demo-default" and y["id"] > x["id"]
    assert client.get("/api/explain", params={"kind": "service", "id": lab["smb"], "start": start}
                      ).json()["explanation"]["id"] == y["id"]


def test_ai_failure_still_returns_the_facts(client, lab, monkeypatch):
    _ai(monkeypatch, error=llm.LLMError("AI request failed (ollama): ReadTimeout"))
    x = _explain(client, "service", lab["smb"], iso(T0 + timedelta(seconds=60)))
    assert x["summary"] is None and "longer than" in x["ai_error"] and x["facts"]


def test_unknown_outage_or_item_is_404(client, lab, no_ai):
    r = client.post("/api/explain", json={"kind": "service", "id": lab["smb"], "start": iso(NOW - timedelta(days=5))})
    assert r.status_code == 404
    r = client.post("/api/explain", json={"kind": "service", "id": 999999, "start": iso(T0)})
    assert r.status_code == 404
    assert client.get("/api/explain", params={"kind": "service", "id": lab["smb"], "start": iso(T0)}
                      ).json() == {"explanation": None, "earlier": []}


def test_host_uptime_includes_host_id(client, lab):
    d = client.get(f"/api/hosts/{NET}.2/uptime").json()
    assert d["host_id"] == lab["demo-switch"] and d["outages"]
