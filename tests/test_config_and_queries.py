"""F-05 (config cache) and F-06 (hosts list in one query)."""
import time

import yaml

from backend import config


def test_config_cache_returns_copies(client):
    a = config.get_config()
    a["general"]["timezone"] = "Mutated/Zone"
    assert config.get_config()["general"].get("timezone") != "Mutated/Zone"


def test_config_cache_sees_saves(client):
    cfg = config.get_config()
    cfg["ip_history"]["stale_days"] = 41
    config.save_config(cfg)
    assert config.get_config()["ip_history"]["stale_days"] == 41


def test_config_cache_sees_outside_edits(client, data_dir):
    config.get_config()
    path = data_dir / "config.yaml"
    raw = yaml.safe_load(path.read_text()) if path.exists() else {}
    raw.setdefault("ip_history", {})["gone_days"] = 77
    time.sleep(0.01)                      # make sure the file signature changes
    path.write_text(yaml.dump(raw))
    assert config.get_config()["ip_history"]["gone_days"] == 77


def test_config_cache_avoids_reparsing(client, monkeypatch):
    config.get_config()
    calls = []
    real = config._load_config
    monkeypatch.setattr(config, "_load_config", lambda: calls.append(1) or real())
    for _ in range(50):
        config.get_config()
    assert calls == []                    # served from memory, file not re-read


def test_hosts_list_ports_attached_correctly(client):
    for i, ports in ((21, [22, 80]), (22, [443]), (23, [])):
        ip = f"10.2.0.{i}"
        client.post("/api/hosts", json={"ip": ip})
        for p in ports:
            client.post(f"/api/hosts/{ip}/ports", json={"port": p, "service": f"s{p}"})
    hosts = {h["ip"]: h for h in client.get("/api/hosts").json()}
    assert [p["port"] for p in hosts["10.2.0.21"]["ports"]] == [22, 80]
    assert [p["port"] for p in hosts["10.2.0.22"]["ports"]] == [443]
    assert hosts["10.2.0.23"]["ports"] == []


def test_hosts_list_is_one_ports_query(client, monkeypatch):
    import sqlite3
    import backend.main as m
    for i in range(30, 40):
        client.post("/api/hosts", json={"ip": f"10.2.0.{i}"})
    seen = []
    real_get = m.get_conn

    def counting_conn():
        c = real_get()
        c.set_trace_callback(lambda sql: seen.append(sql) if "FROM ports" in sql else None)
        return c
    monkeypatch.setattr(m, "get_conn", counting_conn)
    client.get("/api/hosts")
    assert len(seen) == 1, seen           # was one query per host


def test_topology_graph_still_renders(client):
    r = client.get("/api/graph")
    assert r.status_code == 200
    nodes = {n["data"]["ip"]: n["data"] for n in r.json()["nodes"] if "ip" in n["data"]}
    assert nodes["10.2.0.21"]["open_ports"] == 2
