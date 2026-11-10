"""DHCP warnings: static-in-pool, important device on a pool IP, pool almost full;
per-host opt-out; the daily digest reports each warning once."""
import pytest

from backend import changes
from backend.database import get_conn

NET = "10.77.0"


@pytest.fixture
def lab(client):
    """Subnet 10.77.0.0/24 with a 10-address pool (.100–.109) and a few hosts."""
    with get_conn() as conn:
        sid = conn.execute("INSERT INTO subnets (name, cidr, dhcp_start, dhcp_end) VALUES ('Lab', ?, ?, ?)",
                           (f"{NET}.0/24", f"{NET}.100", f"{NET}.109")).lastrowid
        def host(last, **kw):
            cols = {"ip": f"{NET}.{last}", "last_seen": "2000-01-01 00:00:00", **kw}
            conn.execute(f"INSERT INTO hosts ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", tuple(cols.values()))
        host(100, hostname="pinned-nas", static_override="static")         # static, but in the pool
        host(101, hostname="core-switch", device_type="switch")              # important device in the pool
        host(102, hostname="phone", device_type="phone")                     # normal DHCP client
        host(103, hostname="mon-box", device_type="pc")                      # has a monitored service
        host(104, hostname="ok-dyn", device_type="router", static_override="dynamic")  # owner says it's fine
        host(10, hostname="fixed-server", device_type="server")             # outside the pool: fine
        hid = conn.execute("SELECT id FROM hosts WHERE ip=?", (f"{NET}.103",)).fetchone()["id"]
        conn.execute("INSERT INTO services (host_id, name, port, monitored) VALUES (?, 'web', 80, 1)", (hid,))
        conn.commit()
    yield sid
    with get_conn() as conn:
        conn.execute("DELETE FROM hosts WHERE ip LIKE ?", (f"{NET}.%",))
        conn.execute("DELETE FROM subnets WHERE id=?", (sid,))
        conn.commit()


def _codes(client):
    return {h["ip"].rsplit(".", 1)[1]: [w["code"] for w in h["dhcp_warnings"]]
            for h in client.get("/api/hosts").json() if h["ip"].startswith(NET)}


def test_host_warnings(client, lab):
    c = _codes(client)
    assert c["100"] == ["static_in_pool"]
    assert c["101"] == ["infra_in_pool"]
    assert c["103"] == ["infra_in_pool"]                # monitored service counts as important
    assert c["102"] == [] and c["104"] == [] and c["10"] == []


def test_opt_out_hides_the_warning(client, lab):
    assert client.put(f"/api/hosts/{NET}.101", json={"no_dhcp_warn": True}).status_code == 200
    assert _codes(client)["101"] == []
    client.put(f"/api/hosts/{NET}.101", json={"no_dhcp_warn": False})
    assert _codes(client)["101"] == ["infra_in_pool"]


def test_pool_full(client, lab):
    assert not [p for p in client.get("/api/dhcp-warnings").json()["pools"] if p["subnet_id"] == lab]
    with get_conn() as conn:                            # 9 of 10 pool addresses answer now → 90%
        for last in range(100, 109):
            conn.execute("INSERT INTO hosts (ip, last_seen) VALUES (?, datetime('now')) "
                         "ON CONFLICT(ip) DO UPDATE SET last_seen=datetime('now')", (f"{NET}.{last}",))
        conn.commit()
    pool = next(p for p in client.get("/api/dhcp-warnings").json()["pools"] if p["subnet_id"] == lab)
    assert (pool["used"], pool["size"], pool["pct"]) == (9, 10, 90)


def test_digest_reports_each_warning_once(client, lab, monkeypatch):
    sent = []
    monkeypatch.setattr(changes.notify, "send", lambda **kw: sent.append(kw))
    monkeypatch.setattr(changes, "_worthy_events", lambda conn, where, params: [])
    changes.send_digest()
    assert len(sent) == 1 and "DHCP warning" in sent[0]["title"]
    msg = sent[0]["message"]
    assert f"{NET}.100 (pinned-nas): marked static" in msg and f"{NET}.101 (core-switch)" in msg
    sent.clear()
    changes.send_digest()                                # nothing new → no digest
    assert sent == []
    with get_conn() as conn:                             # it clears, then comes back → reported again
        conn.execute("UPDATE hosts SET static_override=NULL WHERE ip=?", (f"{NET}.100",))
        conn.commit()
    changes.send_digest()
    with get_conn() as conn:
        conn.execute("UPDATE hosts SET static_override='static' WHERE ip=?", (f"{NET}.100",))
        conn.commit()
    sent.clear()
    changes.send_digest()
    assert len(sent) == 1 and f"{NET}.100" in sent[0]["message"] and f"{NET}.101" not in sent[0]["message"]
