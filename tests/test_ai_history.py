"""AI history (AI Tier 3, part 3): saving AI results is a setting; off means
nothing is saved and saved results are hidden; keep-N and keep-days clean up
every result; Clean history deletes them all."""
from datetime import datetime, timedelta, timezone

import pytest

from backend import ai_history, changes, llm, notify
from backend.database import get_conn

NET = "10.77.0"


def iso(dt):
    return dt.isoformat(timespec="seconds")


@pytest.fixture
def lab(client, monkeypatch):
    """A demo host with one finished service outage, and a fake AI."""
    now = datetime.now(timezone.utc).replace(microsecond=0)
    start = now - timedelta(hours=2)
    with get_conn() as conn:
        hid = conn.execute("INSERT INTO hosts (ip, hostname, online, last_seen) VALUES (?, 'demo-box', 1, ?)",
                           (f"{NET}.5", "2000-01-01")).lastrowid
        sid = conn.execute("INSERT INTO services (host_id, name, port, monitored) VALUES (?, 'Demo Web', 80, 1)",
                           (hid,)).lastrowid
        conn.executemany("INSERT INTO monitor_events (service_id, status, ts) VALUES (?,?,?)",
                         [(sid, "up", iso(now - timedelta(days=3))), (sid, "down", iso(start)),
                          (sid, "up", iso(start + timedelta(minutes=5)))])
        conn.commit()

    n = {"i": 0}
    async def fake(prompt, model="", system="", timeout=0):
        n["i"] += 1
        return f"Demo answer {n['i']}."
    import backend.main as main
    monkeypatch.setattr(llm, "generate", fake)
    monkeypatch.setattr(main, "generate", fake)
    monkeypatch.setattr(llm, "is_configured", lambda: True)
    monkeypatch.setattr(llm, "get_default_model", lambda: "demo-default")
    monkeypatch.setattr(main, "get_default_model", lambda: "demo-default")
    yield {"host": hid, "svc": sid, "start": iso(start), "ip": f"{NET}.5"}
    ai_history.clean()
    with get_conn() as conn:
        conn.execute("DELETE FROM services WHERE id=?", (sid,))
        conn.execute("DELETE FROM hosts WHERE id=?", (hid,))
        conn.commit()
    _set(client, enabled=True, keep_per_item=10, keep_days=90)


def _set(client, **ah):
    r = client.put("/api/settings/all", json={"ai_history": ah})
    assert r.status_code == 200, r.text
    return r.json()["ai_history"]


def _explain(client, lab):
    r = client.post("/api/explain", json={"kind": "service", "id": lab["svc"], "start": lab["start"]})
    assert r.status_code == 200, r.text
    return r.json()


def test_defaults(client):
    ah = client.get("/api/settings").json()["ai_history"]
    assert ah == {"enabled": True, "keep_per_item": 10, "keep_days": 90}


def test_every_kind_is_saved_with_earlier_ones(client, lab):
    first = _explain(client, lab)
    second = _explain(client, lab)
    assert second["explanation"]["summary"] == "Demo answer 2."
    assert [e["summary"] for e in second["earlier"]] == ["Demo answer 1."]
    got = client.get("/api/explain", params={"kind": "service", "id": lab["svc"], "start": lab["start"]}).json()
    assert got["explanation"]["id"] == second["explanation"]["id"] and len(got["earlier"]) == 1
    assert first["earlier"] == []

    for _ in range(2):
        a = client.post(f"/api/hosts/{lab['ip']}/analyze", json={"model": ""}).json()
    assert a["model"] == "demo-default" and len(a["earlier"]) == 1
    host = client.get(f"/api/hosts/{lab['ip']}").json()
    assert [x["analysis"] for x in host["analyses"]] == ["Demo answer 4.", "Demo answer 3."]

    for _ in range(2):
        n = client.post("/api/analyze/network", json={"model": "demo-b"}).json()
    assert n["model"] == "demo-b" and len(n["earlier"]) == 1
    assert len(client.get("/api/analyze/network").json()["analyses"]) == 2
    assert client.get("/api/ai-history").json()["count"] == 6


def test_off_saves_nothing_and_hides_what_is_saved(client, lab):
    _explain(client, lab)
    client.post(f"/api/hosts/{lab['ip']}/analyze", json={"model": ""})
    _set(client, enabled=False)
    x = _explain(client, lab)
    assert x["explanation"]["summary"] and x["explanation"]["id"] is None and x["earlier"] == []
    a = client.post(f"/api/hosts/{lab['ip']}/analyze", json={"model": ""}).json()
    assert a["analysis"] and a["earlier"] == []
    assert client.get(f"/api/hosts/{lab['ip']}").json()["analyses"] == []
    assert client.get("/api/explain", params={"kind": "service", "id": lab["svc"], "start": lab["start"]}
                      ).json() == {"explanation": None, "earlier": []}
    assert client.get("/api/ai-history").json()["count"] == 2          # kept, not deleted
    _set(client, enabled=True)                                          # back on: they show again
    assert len(client.get(f"/api/hosts/{lab['ip']}").json()["analyses"]) == 1


def test_keep_per_item_applies_on_save_and_on_apply(client, lab):
    for _ in range(4):
        _explain(client, lab)
    _set(client, keep_per_item=2)                                       # Apply trims straight away
    got = client.get("/api/explain", params={"kind": "service", "id": lab["svc"], "start": lab["start"]}).json()
    assert got["explanation"]["summary"] == "Demo answer 4." and len(got["earlier"]) == 1
    _explain(client, lab)
    assert len(_explain(client, lab)["earlier"]) == 1


def test_keep_days_deletes_old_ones_including_the_newest(client, lab):
    _explain(client, lab)
    client.post(f"/api/hosts/{lab['ip']}/analyze", json={"model": ""})
    with get_conn() as conn:
        for t in ("ai_explanations", "llm_analyses"):
            conn.execute(f"UPDATE {t} SET created_at=datetime('now', '-40 days')")
        conn.commit()
    _set(client, keep_days=60)
    assert client.get("/api/ai-history").json()["count"] == 2
    _set(client, keep_days=30)
    assert client.get("/api/ai-history").json()["count"] == 0
    _explain(client, lab)
    with get_conn() as conn:
        conn.execute("UPDATE ai_explanations SET created_at=datetime('now', '-4000 days')")
        conn.commit()
    _set(client, keep_days=0)                                           # 0 = no time limit
    assert client.get("/api/ai-history").json()["count"] == 1


def test_clean_history_deletes_everything(client, lab):
    _explain(client, lab)
    client.post("/api/analyze/network", json={"model": ""})
    r = client.post("/api/ai-history/clean").json()
    assert r == {"ok": True, "deleted": 2} and client.get("/api/ai-history").json()["count"] == 0


def test_digest_summary_is_saved_for_past_digests(client, lab, monkeypatch):
    sent = []
    monkeypatch.setattr(notify, "send", lambda **kw: sent.append(kw))
    monkeypatch.setattr(changes, "build_digest", lambda mark=True, services=None: ("Daily digest: demo", "Services\n🟢 Demo Web"))
    monkeypatch.setattr(changes, "get_change_alerts_config", lambda: {"enabled": True, "digest_ai": True})
    changes.send_digest()
    d = client.get("/api/digest/history").json()["digests"]
    assert len(sent) == 1 and len(d) == 1
    assert d[0]["title"] == "Daily digest: demo" and d[0]["summary"] == "Demo answer 1." and d[0]["model"] == "demo-default"
    assert client.get("/api/digest/preview", params={"ai": 1}).json()["body"]   # preview is not saved
    assert len(client.get("/api/digest/history").json()["digests"]) == 1
    _set(client, enabled=False)
    changes.send_digest()
    assert len(sent) == 2 and client.get("/api/digest/history").json()["digests"] == []
    assert client.get("/api/ai-history").json()["count"] == 1
