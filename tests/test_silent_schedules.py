"""Silent schedules (R-06): changes are recorded, no per-scan alert is sent,
and the daily digest still includes them."""
import pytest

from backend import changes
from backend.database import get_conn

SCHED = {"name": "Night deep scan", "timing_type": "interval", "interval_hours": 24}


@pytest.fixture
def sent(monkeypatch):
    out = []
    monkeypatch.setattr(changes.notify, "send", lambda **kw: out.append(kw))
    monkeypatch.setattr(changes, "get_change_alerts_config",
                        lambda: {"enabled": True, "on_scan": True, "digest_enabled": True})
    monkeypatch.setattr(changes, "is_alert_worthy", lambda conn, e, subnets: True)
    return out


def _run_with_change(sched_id):
    with get_conn() as conn:
        run_id = conn.execute("INSERT INTO scan_runs (schedule_id, status) VALUES (?, 'completed')",
                              (sched_id,)).lastrowid
        changes.record(conn, "10.9.1.5", "host_new", run_id=run_id)
        conn.commit()
    return run_id


def test_silent_flag_saved_and_listed(client):
    sid = client.post("/api/scan-schedules", json={**SCHED, "silent": True}).json()["id"]
    try:
        row = next(s for s in client.get("/api/scan-schedules").json() if s["id"] == sid)
        assert row["silent"] == 1
        # Turning it off again (the list's enable switch sends the whole row back)
        assert client.put(f"/api/scan-schedules/{sid}", json={**row, "silent": False}).status_code == 200
        row = next(s for s in client.get("/api/scan-schedules").json() if s["id"] == sid)
        assert row["silent"] == 0
    finally:
        client.delete(f"/api/scan-schedules/{sid}")


def test_silent_schedule_sends_no_scan_alert_but_digest_has_it(client, sent):
    loud = client.post("/api/scan-schedules", json=SCHED).json()["id"]
    quiet = client.post("/api/scan-schedules", json={**SCHED, "silent": True}).json()["id"]
    try:
        changes.send_scan_summary(_run_with_change(quiet))
        assert sent == []                                    # silent: nothing sent
        with get_conn() as conn:                             # but the change was recorded
            assert conn.execute("SELECT 1 FROM change_events WHERE ip='10.9.1.5'").fetchone()
        changes.send_scan_summary(_run_with_change(loud))
        assert len(sent) == 1                                # normal schedule still alerts
        changes.send_scan_summary(_run_with_change(None))
        assert len(sent) == 2                                # manual scans unchanged
        sent.clear()
        changes.send_digest()
        assert len(sent) == 1 and "10.9.1.5" in sent[0]["message"]   # silent run's change is in the digest
    finally:
        with get_conn() as conn:
            conn.execute("DELETE FROM change_events WHERE ip='10.9.1.5'")
            conn.commit()
        client.delete(f"/api/scan-schedules/{loud}")
        client.delete(f"/api/scan-schedules/{quiet}")
