"""Status page: LAN-only push (R-18), font + favicon branding (R-16/R-17),
per-item incidents (R-14) on both the Boltarr and status-page side."""
import importlib.util
import json
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import monitor
from backend.database import get_conn

_SP = Path(__file__).resolve().parent.parent / "statuspage"
TOKEN = "test-token-123"


@pytest.fixture(scope="module")
def sp():
    d = tempfile.mkdtemp(prefix="statuspage-test-")
    os.environ.update(STATUS_TOKEN=TOKEN, STATUS_ADMIN_PASSWORD="admin-pass-1",
                      STATUS_COOKIE_SECURE="false", STATE_FILE=f"{d}/state.json", DB_FILE=f"{d}/sp.db")
    spec = importlib.util.spec_from_file_location("statuspage_app", _SP / "app.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    with TestClient(mod.app) as c:
        c.mod = mod
        yield c


def _push(sp, payload, **headers):
    return sp.post("/push", content=json.dumps(payload),
                   headers={"Authorization": f"Bearer {TOKEN}", **headers})


def _admin(sp):
    assert sp.post("/login", json={"password": "admin-pass-1"}).status_code == 200
    return sp.get("/data").json()["csrf"]


def _ts(minutes_ago):
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()


# ── R-18 ──────────────────────────────────────────────────────────────────────
def test_direct_push_accepted(sp):
    assert _push(sp, {"services": []}).status_code == 200


@pytest.mark.parametrize("h", [{"X-Forwarded-For": "203.0.113.9"}, {"X-Real-IP": "203.0.113.9"},
                               {"Forwarded": "for=203.0.113.9"}, {"X-Forwarded-Proto": "https"}])
def test_push_through_proxy_refused_even_with_token(sp, h):
    r = _push(sp, {"services": [{"key": "x", "name": "Fake", "status": "down"}]}, **h)
    assert r.status_code == 403
    assert sp.get("/data").json()["services"] == []      # nothing was stored


def test_push_via_proxy_switch(sp, monkeypatch):
    monkeypatch.setattr(sp.mod, "PUSH_VIA_PROXY", True)
    assert _push(sp, {"services": []}, **{"X-Forwarded-For": "10.0.0.2"}).status_code == 200


def test_bad_token_still_refused(sp):
    assert sp.post("/push", content="{}", headers={"Authorization": "Bearer nope"}).status_code == 401


# ── R-16 / R-17 ───────────────────────────────────────────────────────────────
def test_font_and_favicon_branding(sp):
    csrf = _admin(sp)
    fav = "data:image/png;base64,iVBORw0KGgo="
    r = sp.post("/api/branding", json={"font": "cairo", "favicon": fav}, headers={"X-CSRF": csrf})
    b = r.json()["branding"]
    assert b["font"] == "cairo" and b["favicon"] == fav
    # Unknown fonts and non-image favicons are ignored, the old value stays
    b = sp.post("/api/branding", json={"font": "comic", "favicon": "javascript:alert(1)"},
                headers={"X-CSRF": csrf}).json()["branding"]
    assert b["font"] == "cairo" and b["favicon"] == fav
    assert sp.get("/data").json()["branding"]["font"] == "cairo"   # visitors get it too
    sp.post("/logout")


def test_bundled_fonts_served_locally(sp):
    for f in ("inter-latin", "cairo-latin", "cairo-arabic"):
        r = sp.get(f"/static/fonts/{f}.woff2")
        assert r.status_code == 200 and r.headers["content-type"] == "font/woff2"
        assert r.content[:4] == b"wOF2"
    assert sp.get("/static/fonts/../app.py").status_code == 404
    assert sp.get("/static/fonts/nope.woff2").status_code == 404
    csp = sp.get("/").headers["content-security-policy"]
    assert "font-src 'self'" in csp
    css = sp.get("/static/style.css").text
    assert "googleapis" not in css and "/static/fonts/cairo-arabic.woff2" in css


# ── R-14 ──────────────────────────────────────────────────────────────────────
def test_status_page_keeps_per_item_incidents_and_cutoff(sp):
    old = {"key": "svc-1", "name": "Web", "section": "services", "start": _ts(600), "end": _ts(590),
           "seconds": 600, "ongoing": False}
    new = {**old, "start": _ts(30), "end": _ts(20)}
    payload = {"services": [{"key": "svc-1", "name": "Web", "status": "up", "incidents": [new, old]}],
               "hosts": [{"key": "host-1", "name": "Box", "status": "up", "incidents": [old]}],
               "incidents": [new, old]}
    assert _push(sp, payload).status_code == 200
    d = sp.get("/data").json()
    assert len(d["services"][0]["incidents"]) == 2
    assert d["hosts"] == []                         # private section: its incidents stay hidden too
    # "Clear past incidents" applies to each card's own list as well
    sp.mod.set_setting("incidents_since", _ts(60))
    d = sp.get("/data").json()
    assert [i["start"] for i in d["services"][0]["incidents"]] == [new["start"]]
    assert len(d["incidents"]) == 1
    assert len(sp.mod.STATE["services"][0]["incidents"]) == 2   # stored payload untouched
    sp.mod.set_setting("incidents_since", "")


def test_boltarr_sends_keyed_incidents_per_item(client):
    with get_conn() as conn:
        hid = conn.execute("INSERT INTO hosts (ip, hostname) VALUES ('10.9.0.1', 'sp-host')").lastrowid
        sid = conn.execute("""INSERT INTO services (host_id, name, public, monitored, monitor_status)
                              VALUES (?, 'sp-web', 1, 1, 'up')""", (hid,)).lastrowid
        # 12 short outages: the item list holds the newest 10
        for i in range(12):
            conn.execute("INSERT INTO monitor_events (service_id, status, ts) VALUES (?, 'down', ?)",
                         (sid, _ts(300 - i * 20)))
            conn.execute("INSERT INTO monitor_events (service_id, status, ts) VALUES (?, 'up', ?)",
                         (sid, _ts(295 - i * 20)))
        conn.commit()
    try:
        p = monitor.build_status_payload()
        item = next(s for s in p["services"] if s["key"] == f"svc-{sid}")
        assert len(item["incidents"]) == monitor.ITEM_INCIDENTS == 10
        assert all(i["key"] == item["key"] for i in item["incidents"])
        starts = [i["start"] for i in item["incidents"]]
        assert starts == sorted(starts, reverse=True)           # newest first
        assert all(i.get("key") for i in p["incidents"])
        assert "10.9.0.1" not in json.dumps(p)                  # still no IPs
    finally:
        with get_conn() as conn:
            conn.execute("DELETE FROM hosts WHERE id=?", (hid,))
            conn.commit()
