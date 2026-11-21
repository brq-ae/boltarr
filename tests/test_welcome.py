"""U-01: the welcome window shows once, on a brand-new install only (no networks
or devices yet); finished or skipped is saved on the server. Its network guess
comes from the machine Boltarr runs on."""
import ipaddress
import sqlite3
from contextlib import contextmanager

from backend import config, main
from backend.database import get_conn


def _set_done(done):
    cfg = config.get_config()
    cfg["ui"]["welcome_done"] = done
    config.save_config(cfg)


@contextmanager
def _empty_db():
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE hosts (ip TEXT)")
    conn.execute("CREATE TABLE subnets (cidr TEXT)")
    try:
        yield conn
    finally:
        conn.close()


def test_a_new_install_sees_the_welcome(client, monkeypatch):
    monkeypatch.setattr(main, "get_conn", _empty_db)
    _set_done(False)
    assert client.get("/api/ui/welcome").json()["show"] is True


def test_finished_or_skipped_is_kept(client, monkeypatch):
    monkeypatch.setattr(main, "get_conn", _empty_db)
    _set_done(False)
    assert client.post("/api/ui/welcome/done").json() == {"ok": True}
    assert config.get_config()["ui"]["welcome_done"] is True
    assert client.get("/api/ui/welcome").json()["show"] is False


def test_an_install_with_devices_never_sees_it(client):
    with get_conn() as conn:
        conn.execute("INSERT OR IGNORE INTO hosts (ip, hostname, last_seen) VALUES ('10.9.0.1', 'demo-box', '2026-01-01')")
    _set_done(False)
    assert client.get("/api/ui/welcome").json()["show"] is False


def test_it_sends_the_saved_timezone(client):
    client.put("/api/settings/all", json={"general": {"timezone": "Europe/Berlin"}})
    assert client.get("/api/ui/welcome").json()["timezone"] == "Europe/Berlin"


class _Sock:
    def __init__(self, ip): self.ip = ip
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def connect(self, addr): pass
    def getsockname(self): return (self.ip, 50000)


def _route_file(tmp_path, rows):
    """A /proc/net/route stand-in; rows are (destination, mask) as dotted quads."""
    le = lambda a: int(ipaddress.IPv4Address(a)).to_bytes(4, "little").hex().upper()
    lines = ["Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT"]
    for dest, mask in rows:
        lines.append(f"eth0\t{le(dest)}\t00000000\t0001\t0\t0\t0\t{le(mask)}\t0\t0\t0")
    p = tmp_path / "route"
    p.write_text("\n".join(lines) + "\n")
    return p


def _guess(monkeypatch, tmp_path, ip, rows):
    monkeypatch.setattr(main.socket, "socket", lambda *a: _Sock(ip))
    real_open = open
    route = _route_file(tmp_path, rows)
    monkeypatch.setattr("builtins.open", lambda f, *a, **k: real_open(route if f == "/proc/net/route" else f, *a, **k))
    return main.suggest_network()


def test_network_guess_uses_the_machines_own_network(monkeypatch, tmp_path):
    rows = [("0.0.0.0", "0.0.0.0"), ("10.9.0.0", "255.255.255.0")]
    assert _guess(monkeypatch, tmp_path, "10.9.0.20", rows) == "10.9.0.0/24"


def test_a_wide_network_is_narrowed_to_its_slash_24(monkeypatch, tmp_path):
    rows = [("0.0.0.0", "0.0.0.0"), ("10.9.0.0", "255.255.0.0")]
    assert _guess(monkeypatch, tmp_path, "10.9.4.20", rows) == "10.9.4.0/24"


def test_dockers_own_bridge_gives_no_guess(monkeypatch, tmp_path):
    rows = [("172.17.0.0", "255.255.0.0")]
    assert _guess(monkeypatch, tmp_path, "172.17.0.2", rows) is None
