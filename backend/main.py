import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .database import init_db, get_conn
from .scanner import start_scan, scan_jobs
from .config import get_config, get_llm_config, save_config
from .llm import (
    list_models, generate, chat, is_configured, get_default_model,
    build_host_prompt, build_network_prompt, infer_device_type, LLMError, LONG_TIMEOUT,
)

app = FastAPI(title="Boltarr")

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


@app.on_event("startup")
def startup():
    init_db()


# ── Subnets ───────────────────────────────────────────────────────────────────

class SubnetIn(BaseModel):
    name: str
    cidr: str
    description: Optional[str] = None


@app.get("/api/subnets")
def list_subnets():
    with get_conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM subnets ORDER BY id")]


@app.post("/api/subnets", status_code=201)
def create_subnet(data: SubnetIn):
    try:
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO subnets (name, cidr, description) VALUES (?,?,?)",
                (data.name, data.cidr, data.description),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM subnets WHERE cidr=?", (data.cidr,)).fetchone()
            return dict(row)
    except Exception as e:
        raise HTTPException(400, str(e))


@app.delete("/api/subnets/{subnet_id}")
def delete_subnet(subnet_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM subnets WHERE id=?", (subnet_id,))
        conn.commit()
    return {"ok": True}


# ── Scans ─────────────────────────────────────────────────────────────────────

@app.post("/api/scan/{subnet_id}")
def trigger_scan(subnet_id: int):
    with get_conn() as conn:
        subnet = conn.execute("SELECT * FROM subnets WHERE id=?", (subnet_id,)).fetchone()
        if not subnet:
            raise HTTPException(404, "Subnet not found")
        conn.execute("INSERT INTO scan_runs (subnet_id) VALUES (?)", (subnet_id,))
        conn.commit()
        run_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    start_scan(run_id, subnet["cidr"])
    return {"run_id": run_id, "status": "started"}


@app.get("/api/scan/{run_id}/status")
def scan_status(run_id: int):
    if run_id in scan_jobs:
        return scan_jobs[run_id]
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM scan_runs WHERE id=?", (run_id,)).fetchone()
        if row:
            return dict(row)
    raise HTTPException(404, "Run not found")


@app.get("/api/scans")
def list_scans():
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT sr.*, s.name AS subnet_name, s.cidr
            FROM scan_runs sr
            JOIN subnets s ON sr.subnet_id = s.id
            ORDER BY sr.started_at DESC
            LIMIT 30
        """).fetchall()
        return [dict(r) for r in rows]


# ── Hosts ─────────────────────────────────────────────────────────────────────

def _resolve_host(conn, ip: str):
    """Return host row by primary IP or alias IP. Returns None if not found."""
    row = conn.execute("SELECT * FROM hosts WHERE ip=?", (ip,)).fetchone()
    if row:
        return row
    return conn.execute("""
        SELECT h.* FROM hosts h
        JOIN host_aliases a ON a.host_id = h.id
        WHERE a.ip = ?
    """, (ip,)).fetchone()


def _get_aliases(conn, host_id: int) -> list[str]:
    return [r["ip"] for r in conn.execute(
        "SELECT ip FROM host_aliases WHERE host_id=? ORDER BY ip", (host_id,)
    ).fetchall()]


@app.get("/api/hosts")
def list_hosts():
    with get_conn() as conn:
        hosts = [dict(h) for h in conn.execute("SELECT * FROM hosts ORDER BY ip")]
        alias_rows = conn.execute("SELECT host_id, ip FROM host_aliases ORDER BY ip").fetchall()
        alias_map: dict = {}
        for a in alias_rows:
            alias_map.setdefault(a["host_id"], []).append(a["ip"])
        for h in hosts:
            h["ports"]   = [dict(p) for p in conn.execute(
                "SELECT * FROM ports WHERE host_id=? ORDER BY port", (h["id"],)
            )]
            h["aliases"] = alias_map.get(h["id"], [])
        return hosts


@app.get("/api/hosts/{ip:path}")
def get_host(ip: str):
    ip = ip.rstrip("/")
    with get_conn() as conn:
        host = _resolve_host(conn, ip)
        if not host:
            raise HTTPException(404, "Host not found")
        host = dict(host)
        host["ports"] = [
            dict(p) for p in conn.execute(
                "SELECT * FROM ports WHERE host_id=? ORDER BY port", (host["id"],)
            )
        ]
        host["analyses"] = [
            dict(a) for a in conn.execute(
                "SELECT * FROM llm_analyses WHERE host_id=? ORDER BY created_at DESC LIMIT 5",
                (host["id"],),
            )
        ]
        host["services"] = [
            dict(s) for s in conn.execute(
                "SELECT * FROM services WHERE host_id=? ORDER BY name", (host["id"],)
            )
        ]
        host["aliases"] = _get_aliases(conn, host["id"])
        return host


class HostCreate(BaseModel):
    ip:          Optional[str] = None
    hostname:    Optional[str] = None
    mac:         Optional[str] = None
    vendor:      Optional[str] = None
    os_guess:    Optional[str] = None
    device_type: Optional[str] = "unknown"
    notes:       Optional[str] = None


@app.post("/api/hosts", status_code=201)
def create_host(data: HostCreate):
    ip = (data.ip or "").strip()
    if not ip:
        ip = "node-" + uuid.uuid4().hex[:8]
    with get_conn() as conn:
        existing = conn.execute("SELECT id FROM hosts WHERE ip=?", (ip,)).fetchone()
        if existing:
            raise HTTPException(400, f"Host {ip} already exists")
        conn.execute(
            "INSERT INTO hosts (ip, hostname, mac, vendor, os_guess, device_type, notes) "
            "VALUES (?,?,?,?,?,?,?)",
            (ip, data.hostname or None, data.mac or None, data.vendor or None,
             data.os_guess or None, data.device_type or "unknown", data.notes or None),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM hosts WHERE ip=?", (ip,)).fetchone()
        return dict(row)


class HostUpdate(BaseModel):
    hostname:    Optional[str] = None
    device_type: Optional[str] = None
    vendor:      Optional[str] = None
    os_guess:    Optional[str] = None
    notes:       Optional[str] = None
    tier:        Optional[int] = None
    set_tier:    bool = False
    port_count:  Optional[int] = None
    has_wifi:    Optional[bool] = None
    is_dns:      Optional[bool] = None
    is_dhcp:     Optional[bool] = None
    dhcp_pool:   Optional[str] = None
    set_dhcp:    bool = False


@app.put("/api/hosts/{ip}")
def update_host(ip: str, data: HostUpdate):
    with get_conn() as conn:
        host = conn.execute("SELECT id FROM hosts WHERE ip=?", (ip,)).fetchone()
        if not host:
            raise HTTPException(404, "Host not found")
        conn.execute("""
            UPDATE hosts SET
                hostname    = COALESCE(?, hostname),
                device_type = COALESCE(?, device_type),
                vendor      = COALESCE(?, vendor),
                os_guess    = COALESCE(?, os_guess),
                notes       = ?,
                port_count  = COALESCE(?, port_count),
                has_wifi    = COALESCE(?, has_wifi),
                is_dns      = COALESCE(?, is_dns),
                is_dhcp     = COALESCE(?, is_dhcp)
            WHERE ip=?
        """, (data.hostname, data.device_type, data.vendor, data.os_guess,
              data.notes, data.port_count,
              1 if data.has_wifi else (0 if data.has_wifi is not None else None),
              1 if data.is_dns  else (0 if data.is_dns  is not None else None),
              1 if data.is_dhcp else (0 if data.is_dhcp is not None else None),
              ip))
        if data.set_tier:
            conn.execute("UPDATE hosts SET tier=? WHERE ip=?", (data.tier, ip))
        if data.set_dhcp:
            conn.execute("UPDATE hosts SET dhcp_pool=? WHERE ip=?", (data.dhcp_pool, ip))
        conn.commit()
        row = conn.execute("SELECT * FROM hosts WHERE ip=?", (ip,)).fetchone()
        return dict(row)


@app.delete("/api/hosts/{ip}")
def delete_host(ip: str):
    with get_conn() as conn:
        host = conn.execute("SELECT id FROM hosts WHERE ip=?", (ip,)).fetchone()
        if not host:
            raise HTTPException(404, "Host not found")
        conn.execute("DELETE FROM hosts WHERE ip=?", (ip,))
        conn.execute("DELETE FROM connections WHERE src_ip=? OR dst_ip=?", (ip, ip))
        conn.commit()
    return {"ok": True}


class MergeReq(BaseModel):
    merge_ip: str


@app.post("/api/hosts/{ip}/merge")
def merge_host(ip: str, data: MergeReq):
    merge_ip = data.merge_ip.strip()
    if ip == merge_ip:
        raise HTTPException(400, "Cannot merge a host with itself")
    with get_conn() as conn:
        primary = conn.execute("SELECT * FROM hosts WHERE ip=?", (ip,)).fetchone()
        victim  = conn.execute("SELECT * FROM hosts WHERE ip=?", (merge_ip,)).fetchone()
        if not primary: raise HTTPException(404, f"Host {ip} not found")
        if not victim:  raise HTTPException(404, f"Host {merge_ip} not found")

        pid = primary["id"]
        vid = victim["id"]

        # 1. Delete any direct connection between the two (would become self-loop)
        conn.execute("""
            DELETE FROM connections
            WHERE (src_ip=? AND dst_ip=?) OR (src_ip=? AND dst_ip=?)
        """, (ip, merge_ip, merge_ip, ip))

        # 2. Rewrite connections referencing merge_ip → ip, drop duplicates
        for col, other in [("src_ip", "dst_ip"), ("dst_ip", "src_ip")]:
            dupes = conn.execute(f"""
                SELECT v.id FROM connections v
                JOIN connections p ON p.{col}=? AND p.{other}=v.{other}
                WHERE v.{col}=?
            """, (ip, merge_ip)).fetchall()
            for d in dupes:
                conn.execute("DELETE FROM connections WHERE id=?", (d["id"],))
            conn.execute(f"UPDATE connections SET {col}=? WHERE {col}=?", (ip, merge_ip))

        # 3. Reparent ports (INSERT OR IGNORE skips duplicates)
        for p in conn.execute("SELECT * FROM ports WHERE host_id=?", (vid,)).fetchall():
            conn.execute("""
                INSERT OR IGNORE INTO ports
                    (host_id, port, protocol, state, service, version, manual)
                VALUES (?,?,?,?,?,?,?)
            """, (pid, p["port"], p["protocol"], p["state"],
                  p["service"], p["version"], p["manual"]))

        # 4. Reparent services, analyses
        conn.execute("UPDATE services     SET host_id=? WHERE host_id=?", (pid, vid))
        conn.execute("UPDATE llm_analyses SET host_id=? WHERE host_id=?", (pid, vid))

        # 5. Transfer victim's existing aliases to primary, then add merge_ip itself
        conn.execute("UPDATE host_aliases SET host_id=? WHERE host_id=?", (pid, vid))
        conn.execute("INSERT OR IGNORE INTO host_aliases (host_id, ip) VALUES (?,?)",
                     (pid, merge_ip))

        # 6. Delete victim (cascades its ports; services/analyses already reparented)
        conn.execute("DELETE FROM hosts WHERE id=?", (vid,))
        conn.commit()

        row = dict(conn.execute("SELECT * FROM hosts WHERE ip=?", (ip,)).fetchone())
        row["aliases"] = _get_aliases(conn, pid)
        return row


@app.delete("/api/hosts/{ip}/aliases/{alias_ip:path}")
def remove_alias(ip: str, alias_ip: str):
    with get_conn() as conn:
        host = conn.execute("SELECT id FROM hosts WHERE ip=?", (ip,)).fetchone()
        if not host:
            raise HTTPException(404, "Host not found")
        conn.execute(
            "DELETE FROM host_aliases WHERE host_id=? AND ip=?",
            (host["id"], alias_ip)
        )
        conn.commit()
    return {"ok": True}


# ── Ports ─────────────────────────────────────────────────────────────────────

class PortIn(BaseModel):
    port:     int
    protocol: Optional[str] = "tcp"
    state:    Optional[str] = "open"
    service:  Optional[str] = None
    version:  Optional[str] = None


@app.post("/api/hosts/{ip}/ports", status_code=201)
def add_port(ip: str, data: PortIn):
    with get_conn() as conn:
        host = conn.execute("SELECT id FROM hosts WHERE ip=?", (ip,)).fetchone()
        if not host:
            raise HTTPException(404, "Host not found")
        try:
            conn.execute("""
                INSERT INTO ports (host_id, port, protocol, state, service, version, manual)
                VALUES (?,?,?,?,?,?,1)
                ON CONFLICT(host_id, port, protocol) DO UPDATE SET
                    state   = excluded.state,
                    service = excluded.service,
                    version = excluded.version,
                    manual  = 1
            """, (host["id"], data.port, data.protocol, data.state,
                  data.service, data.version))
            conn.commit()
            row = conn.execute(
                "SELECT * FROM ports WHERE host_id=? AND port=? AND protocol=?",
                (host["id"], data.port, data.protocol)
            ).fetchone()
            return dict(row)
        except Exception as e:
            raise HTTPException(400, str(e))


@app.delete("/api/ports/{port_id}")
def delete_port(port_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM ports WHERE id=?", (port_id,))
        conn.commit()
    return {"ok": True}


# ── Services ──────────────────────────────────────────────────────────────────

class ServiceIn(BaseModel):
    name:        str
    description: Optional[str] = None
    port:        Optional[int] = None
    protocol:    Optional[str] = "tcp"
    status:      Optional[str] = "unknown"
    url:         Optional[str] = None
    icon:        Optional[str] = None


class ServiceUpdate(BaseModel):
    name:        Optional[str] = None
    description: Optional[str] = None
    port:        Optional[int] = None
    protocol:    Optional[str] = None
    status:      Optional[str] = None
    url:         Optional[str] = None
    icon:        Optional[str] = None


@app.get("/api/services")
def list_all_services():
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT s.*, h.ip, h.hostname
            FROM services s
            JOIN hosts h ON s.host_id = h.id
            ORDER BY h.ip, s.name
        """).fetchall()
        return [dict(r) for r in rows]


@app.post("/api/hosts/{ip}/services", status_code=201)
def add_service(ip: str, data: ServiceIn):
    with get_conn() as conn:
        host = conn.execute("SELECT id FROM hosts WHERE ip=?", (ip,)).fetchone()
        if not host:
            raise HTTPException(404, "Host not found")
        conn.execute(
            "INSERT INTO services (host_id, name, description, port, protocol, status, url, icon)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (host["id"], data.name, data.description, data.port, data.protocol,
             data.status, data.url, data.icon),
        )
        conn.commit()
        row = conn.execute("""
            SELECT s.*, h.ip, h.hostname FROM services s
            JOIN hosts h ON s.host_id = h.id
            WHERE s.id = last_insert_rowid()
        """).fetchone()
        return dict(row)


@app.put("/api/services/{svc_id}")
def update_service(svc_id: int, data: ServiceUpdate):
    with get_conn() as conn:
        s = conn.execute("SELECT id FROM services WHERE id=?", (svc_id,)).fetchone()
        if not s:
            raise HTTPException(404, "Service not found")
        conn.execute("""
            UPDATE services SET
                name        = COALESCE(?, name),
                description = ?,
                port        = ?,
                protocol    = COALESCE(?, protocol),
                status      = COALESCE(?, status),
                url         = ?,
                icon        = COALESCE(?, icon)
            WHERE id=?
        """, (data.name, data.description, data.port, data.protocol,
              data.status, data.url, data.icon, svc_id))
        conn.commit()
        row = conn.execute("""
            SELECT s.*, h.ip, h.hostname FROM services s
            JOIN hosts h ON s.host_id = h.id WHERE s.id=?
        """, (svc_id,)).fetchone()
        return dict(row)


@app.delete("/api/services/{svc_id}")
def delete_service_endpoint(svc_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM services WHERE id=?", (svc_id,))
        conn.commit()
    return {"ok": True}


# ── VLANs ─────────────────────────────────────────────────────────────────────

class VlanIn(BaseModel):
    tag:   int
    name:  str
    color: str = "#888888"


class VlanUpdate(BaseModel):
    tag:   Optional[int] = None
    name:  Optional[str] = None
    color: Optional[str] = None


@app.get("/api/vlans")
def list_vlans():
    with get_conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM vlans ORDER BY tag")]


@app.post("/api/vlans", status_code=201)
def create_vlan(data: VlanIn):
    try:
        with get_conn() as conn:
            conn.execute("INSERT INTO vlans (tag, name, color) VALUES (?,?,?)",
                         (data.tag, data.name, data.color))
            conn.commit()
            row = conn.execute("SELECT * FROM vlans WHERE tag=?", (data.tag,)).fetchone()
            return dict(row)
    except Exception as e:
        raise HTTPException(400, str(e))


@app.put("/api/vlans/{vlan_id}")
def update_vlan(vlan_id: int, data: VlanUpdate):
    with get_conn() as conn:
        v = conn.execute("SELECT id FROM vlans WHERE id=?", (vlan_id,)).fetchone()
        if not v:
            raise HTTPException(404, "VLAN not found")
        conn.execute("""
            UPDATE vlans SET
                tag   = COALESCE(?, tag),
                name  = COALESCE(?, name),
                color = COALESCE(?, color)
            WHERE id=?
        """, (data.tag, data.name, data.color, vlan_id))
        conn.commit()
        row = conn.execute("SELECT * FROM vlans WHERE id=?", (vlan_id,)).fetchone()
        return dict(row)


@app.delete("/api/vlans/{vlan_id}")
def delete_vlan(vlan_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM vlans WHERE id=?", (vlan_id,))
        conn.commit()
    return {"ok": True}


# ── Connections ───────────────────────────────────────────────────────────────

def _conn_with_vlans(conn, conn_id):
    row = dict(conn.execute("SELECT * FROM connections WHERE id=?", (conn_id,)).fetchone())
    vlans = conn.execute("""
        SELECT v.* FROM vlans v
        JOIN connection_vlans cv ON cv.vlan_id = v.id
        WHERE cv.connection_id=? ORDER BY v.tag
    """, (conn_id,)).fetchall()
    row["vlans"] = [dict(v) for v in vlans]
    return row


class ConnectionIn(BaseModel):
    src_ip:      str
    dst_ip:      str
    type:        Optional[str] = "wired"
    label:       Optional[str] = None
    port_mode:   Optional[str] = None
    speed:       Optional[str] = None
    tagged_only: Optional[bool] = None
    vlan_ids:    Optional[list[int]] = None


@app.get("/api/connections")
def list_connections():
    with get_conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM connections ORDER BY id")]


@app.post("/api/connections", status_code=201)
def create_connection(data: ConnectionIn):
    if data.src_ip == data.dst_ip:
        raise HTTPException(400, "Cannot connect a device to itself")
    try:
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO connections (src_ip, dst_ip, type, label, port_mode, speed, tagged_only)"
                " VALUES (?,?,?,?,?,?,?)",
                (data.src_ip, data.dst_ip, data.type, data.label, data.port_mode, data.speed,
                 int(bool(data.tagged_only)) if data.tagged_only is not None else 0),
            )
            conn_id = conn.execute("SELECT last_insert_rowid() as id").fetchone()["id"]
            if data.vlan_ids:
                for vid in data.vlan_ids:
                    try:
                        conn.execute("INSERT INTO connection_vlans (connection_id, vlan_id) VALUES (?,?)",
                                     (conn_id, vid))
                    except Exception:
                        pass
            conn.commit()
            return _conn_with_vlans(conn, conn_id)
    except Exception as e:
        raise HTTPException(400, str(e))


@app.delete("/api/connections/{conn_id}")
def delete_connection(conn_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM connections WHERE id=?", (conn_id,))
        conn.commit()
    return {"ok": True}


class ConnectionUpdate(BaseModel):
    type:        Optional[str] = None
    label:       Optional[str] = None
    port_mode:   Optional[str] = None
    speed:       Optional[str] = None
    tagged_only: Optional[bool] = None
    vlan_ids:    Optional[list[int]] = None
    set_vlans:   bool = False


@app.put("/api/connections/{conn_id}")
def update_connection(conn_id: int, data: ConnectionUpdate):
    with get_conn() as conn:
        c = conn.execute("SELECT id FROM connections WHERE id=?", (conn_id,)).fetchone()
        if not c:
            raise HTTPException(404, "Connection not found")
        tagged_only_val = (int(bool(data.tagged_only)) if data.tagged_only is not None else None)
        conn.execute("""
            UPDATE connections SET
                type        = COALESCE(?, type),
                label       = ?,
                port_mode   = ?,
                speed       = ?,
                tagged_only = COALESCE(?, tagged_only)
            WHERE id=?
        """, (data.type, data.label, data.port_mode, data.speed, tagged_only_val, conn_id))
        if data.set_vlans:
            conn.execute("DELETE FROM connection_vlans WHERE connection_id=?", (conn_id,))
            if data.vlan_ids:
                for vid in data.vlan_ids:
                    try:
                        conn.execute("INSERT INTO connection_vlans (connection_id, vlan_id) VALUES (?,?)",
                                     (conn_id, vid))
                    except Exception:
                        pass
        conn.commit()
        return _conn_with_vlans(conn, conn_id)


# ── Layout ────────────────────────────────────────────────────────────────────

class LayoutIn(BaseModel):
    positions: dict  # {ip: {x: float, y: float}}


@app.put("/api/layout")
def save_layout(data: LayoutIn):
    with get_conn() as conn:
        for ip, pos in data.positions.items():
            conn.execute(
                "UPDATE hosts SET pos_x=?, pos_y=? WHERE ip=?",
                (pos.get("x"), pos.get("y"), ip),
            )
        conn.commit()
    return {"ok": True, "saved": len(data.positions)}


# ── LLM ──────────────────────────────────────────────────────────────────────

class AnalyzeReq(BaseModel):
    model: Optional[str] = None


@app.post("/api/hosts/{ip}/analyze")
async def analyze_host(ip: str, req: AnalyzeReq):
    with get_conn() as conn:
        host = conn.execute("SELECT * FROM hosts WHERE ip=?", (ip,)).fetchone()
        if not host:
            raise HTTPException(404, "Host not found")
        host = dict(host)
        ports = [dict(p) for p in conn.execute(
            "SELECT * FROM ports WHERE host_id=? ORDER BY port", (host["id"],)
        )]
        services = [dict(s) for s in conn.execute(
            "SELECT * FROM services WHERE host_id=? ORDER BY name", (host["id"],)
        )]

        # Connections involving this host with peer info and VLANs
        raw_conns = [dict(c) for c in conn.execute(
            "SELECT * FROM connections WHERE src_ip=? OR dst_ip=?", (ip, ip)
        )]
        connections = []
        for c in raw_conns:
            peer_ip = c["dst_ip"] if c["src_ip"] == ip else c["src_ip"]
            peer = conn.execute("SELECT hostname, device_type FROM hosts WHERE ip=?", (peer_ip,)).fetchone()
            peer_label = ""
            if peer:
                peer_label = peer["hostname"] or peer["device_type"] or ""
            vlans = conn.execute("""
                SELECT v.tag, v.name FROM vlans v
                JOIN connection_vlans cv ON cv.vlan_id = v.id
                WHERE cv.connection_id=? ORDER BY v.tag
            """, (c["id"],)).fetchall()
            connections.append({
                "peer_ip": peer_ip,
                "peer_label": peer_label,
                "speed": c.get("speed"),
                "port_mode": c.get("port_mode"),
                "label": c.get("label"),
                "tagged_only": c.get("tagged_only"),
                "vlan_summary": ", ".join(f"VLAN{v['tag']}({v['name']})" for v in vlans) if vlans else "",
            })

    try:
        analysis = await generate(
            build_host_prompt(host, ports, services, connections),
            model=req.model or get_default_model(),
        )
    except LLMError as e:
        raise HTTPException(503, str(e))
    device_type = infer_device_type(analysis)

    with get_conn() as conn:
        conn.execute(
            "INSERT INTO llm_analyses (host_id, model, analysis) VALUES (?,?,?)",
            (host["id"], req.model, analysis),
        )
        conn.execute(
            "UPDATE hosts SET device_type=? WHERE id=?",
            (device_type, host["id"]),
        )
        conn.commit()

    return {"analysis": analysis, "model": req.model or get_default_model(), "device_type": device_type}


@app.post("/api/analyze/network")
async def analyze_network(req: AnalyzeReq):
    with get_conn() as conn:
        subnets = [dict(r) for r in conn.execute("SELECT * FROM subnets ORDER BY id")]
        vlans   = [dict(r) for r in conn.execute("SELECT * FROM vlans ORDER BY tag")]
        hosts   = [dict(h) for h in conn.execute("SELECT * FROM hosts ORDER BY ip")]

        # Attach ports and services to each host
        for h in hosts:
            h["ports"] = [dict(p) for p in conn.execute(
                "SELECT * FROM ports WHERE host_id=? ORDER BY port", (h["id"],)
            )]
            h["services"] = [dict(s) for s in conn.execute(
                "SELECT * FROM services WHERE host_id=? ORDER BY name", (h["id"],)
            )]

        # Connections with full VLAN info
        raw_conns = [dict(c) for c in conn.execute("SELECT * FROM connections ORDER BY id")]
        connections = []
        for c in raw_conns:
            vlans_for_conn = conn.execute("""
                SELECT v.tag, v.name FROM vlans v
                JOIN connection_vlans cv ON cv.vlan_id = v.id
                WHERE cv.connection_id=? ORDER BY v.tag
            """, (c["id"],)).fetchall()
            c["vlans"] = [dict(v) for v in vlans_for_conn]
            connections.append(c)

    prompt = build_network_prompt(hosts, connections, vlans, subnets)
    try:
        analysis = await generate(prompt, model=req.model or get_default_model(), timeout=LONG_TIMEOUT)
    except LLMError as e:
        raise HTTPException(503, str(e))
    return {"analysis": analysis, "model": req.model or get_default_model()}


class ChatMsg(BaseModel):
    role: str
    content: str


class ChatReq(BaseModel):
    messages: list[ChatMsg]
    model: Optional[str] = None


@app.post("/api/chat")
async def chat_endpoint(req: ChatReq):
    with get_conn() as conn:
        hosts = [dict(h) for h in conn.execute("SELECT * FROM hosts ORDER BY ip")]
        lines = []
        for h in hosts:
            label = h.get("hostname") or h.get("device_type") or "unknown"
            parts = [f"{h['ip']} ({label}, {h.get('device_type','?')})"]
            if h.get("vendor"):   parts.append(f"vendor={h['vendor']}")
            if h.get("os_guess"): parts.append(f"os={h['os_guess']}")
            if h.get("has_wifi"): parts.append("wifi=yes")
            ports = conn.execute(
                "SELECT port, service FROM ports WHERE host_id=? AND state='open'",
                (h["id"],),
            ).fetchall()
            if ports:
                parts.append("open=" + ",".join(f"{p['port']}/{p['service'] or '?'}" for p in ports))
            services = conn.execute(
                "SELECT name, port, status FROM services WHERE host_id=?", (h["id"],)
            ).fetchall()
            if services:
                parts.append("services=" + ",".join(f"{s['name']}:{s['port'] or '?'}[{s['status']}]" for s in services))
            lines.append("  " + "  ".join(parts))

        conns = [dict(c) for c in conn.execute("SELECT * FROM connections ORDER BY src_ip")]
        conn_lines = []
        for c in conns:
            cl = f"  {c['src_ip']} ↔ {c['dst_ip']}"
            if c.get("speed"):     cl += f" {c['speed']}"
            if c.get("port_mode"): cl += f" mode={c['port_mode']}"
            vlans = conn.execute("""
                SELECT v.tag, v.name FROM vlans v
                JOIN connection_vlans cv ON cv.vlan_id=v.id
                WHERE cv.connection_id=? ORDER BY v.tag
            """, (c["id"],)).fetchall()
            if vlans:
                cl += " vlans=" + ",".join(f"VLAN{v['tag']}({v['name']})" for v in vlans)
            conn_lines.append(cl)

        vlan_rows = conn.execute("SELECT * FROM vlans ORDER BY tag").fetchall()
        vlan_lines = ["  VLAN " + str(v["tag"]) + " " + v["name"] for v in vlan_rows]

    network_ctx = ""
    if lines:
        network_ctx += "Hosts:\n" + "\n".join(lines) + "\n"
    if conn_lines:
        network_ctx += "\nConnections:\n" + "\n".join(conn_lines) + "\n"
    if vlan_lines:
        network_ctx += "\nVLANs:\n" + "\n".join(vlan_lines) + "\n"
    if not network_ctx:
        network_ctx = "No hosts scanned yet."

    system_msg = (
        "You are a helpful network assistant with full knowledge of the user's network topology, "
        "devices, services, connections, VLANs, and security posture. "
        "Answer questions accurately using the data below. Reference specific IPs and hostnames.\n\n"
        + network_ctx
    )

    messages = [{"role": m.role, "content": m.content} for m in req.messages]
    try:
        response = await chat(messages, model=req.model or get_default_model(), system=system_msg)
    except LLMError as e:
        raise HTTPException(503, str(e))
    return {"response": response, "model": req.model or get_default_model()}


# ── Settings ─────────────────────────────────────────────────────────────────

class LLMSettingsIn(BaseModel):
    provider:     Optional[str] = None
    base_url:     Optional[str] = None
    api_key:      Optional[str] = None   # send existing masked value to leave unchanged
    model:        Optional[str] = None
    timeout:      Optional[int] = None
    long_timeout: Optional[int] = None


_MASKED = "••••••••"


@app.get("/api/settings")
def get_settings():
    cfg = get_config()
    llm = dict(cfg["llm"])
    has_key = bool(llm.get("api_key"))
    llm["api_key"] = _MASKED if has_key else ""
    llm["configured"] = is_configured()
    return {"llm": llm}


@app.put("/api/settings")
def update_settings(data: LLMSettingsIn):
    cfg = get_config()
    llm = cfg.get("llm", {})
    if data.provider     is not None: llm["provider"]     = data.provider
    if data.base_url     is not None: llm["base_url"]     = data.base_url.strip()
    if data.model        is not None: llm["model"]        = data.model.strip()
    if data.timeout      is not None: llm["timeout"]      = data.timeout
    if data.long_timeout is not None: llm["long_timeout"] = data.long_timeout
    # Only update api_key if it's not the masked placeholder
    if data.api_key is not None and data.api_key != _MASKED:
        llm["api_key"] = data.api_key
    cfg["llm"] = llm
    save_config(cfg)
    result = dict(llm)
    result["api_key"] = _MASKED if llm.get("api_key") else ""
    result["configured"] = llm.get("provider", "none") != "none"
    return {"ok": True, "llm": result}


@app.post("/api/settings/test")
async def test_llm_connection():
    try:
        models = await list_models()
        return {"ok": True, "models": models}
    except LLMError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/api/models")
async def get_models():
    return {"models": await list_models()}


# ── Graph ─────────────────────────────────────────────────────────────────────

@app.get("/api/graph")
def get_graph():
    with get_conn() as conn:
        hosts = [dict(h) for h in conn.execute("SELECT * FROM hosts")]
        host_ips = {h["ip"] for h in hosts}
        conns = [dict(c) for c in conn.execute("SELECT * FROM connections")]

        # Build per-connection VLAN map in one query
        cv_rows = conn.execute("""
            SELECT cv.connection_id, v.id, v.tag, v.name, v.color
            FROM connection_vlans cv JOIN vlans v ON cv.vlan_id = v.id
            ORDER BY cv.connection_id, v.tag
        """).fetchall()
        cv_map: dict = {}
        for row in cv_rows:
            cid = row["connection_id"]
            if cid not in cv_map:
                cv_map[cid] = []
            cv_map[cid].append({"id": row["id"], "tag": row["tag"],
                                 "name": row["name"], "color": row["color"]})

        # Build alias map for nodes
        alias_rows = conn.execute("SELECT host_id, ip FROM host_aliases ORDER BY ip").fetchall()
        node_alias_map: dict = {}
        for a in alias_rows:
            node_alias_map.setdefault(a["host_id"], []).append(a["ip"])

        nodes = []
        for h in hosts:
            ports = conn.execute(
                "SELECT port, service FROM ports WHERE host_id=? AND state='open'",
                (h["id"],),
            ).fetchall()
            synthetic = h["ip"].startswith("node-")
            label = h.get("hostname") or ("" if synthetic else h["ip"])
            nodes.append({
                "data": {
                    "id": h["ip"],
                    "label": label,
                    "ip": h["ip"],
                    "synthetic": synthetic,
                    "device_type": h.get("device_type") or "unknown",
                    "os": h.get("os_guess") or "",
                    "vendor": h.get("vendor") or "",
                    "open_ports": len(ports),
                    "services": [p["service"] for p in ports if p["service"]],
                    "last_seen": h.get("last_seen") or "",
                    "pos_x": h.get("pos_x"),
                    "pos_y": h.get("pos_y"),
                    "tier": h.get("tier"),
                    "port_count": h.get("port_count") or 1,
                    "has_wifi": bool(h.get("has_wifi")),
                    "is_dns":  bool(h.get("is_dns")),
                    "is_dhcp": bool(h.get("is_dhcp")),
                    "dhcp_pool": h.get("dhcp_pool") or "",
                    "aliases": node_alias_map.get(h["id"], []),
                }
            })

        edges = [
            {
                "data": {
                    "id": f"e{c['id']}",
                    "source": c["src_ip"],
                    "target": c["dst_ip"],
                    "type": c["type"],
                    "label": c.get("label") or "",
                    "port_mode": c.get("port_mode") or "",
                    "speed": c.get("speed") or "",
                    "tagged_only": bool(c.get("tagged_only")),
                    "vlans": cv_map.get(c["id"], []),
                    "connection_id": c["id"],
                }
            }
            for c in conns
            if c["src_ip"] in host_ips and c["dst_ip"] in host_ips
        ]

    return {"nodes": nodes, "edges": edges}


# ── SSH Key Management ────────────────────────────────────────────────────────

import base64, hashlib

def _ssh_fingerprint(public_key: str) -> str:
    try:
        key_data = base64.b64decode(public_key.strip().split()[1])
        digest = hashlib.sha256(key_data).digest()
        return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")
    except Exception:
        return ""

class SshKeyIn(BaseModel):
    name: str
    public_key: str

class SshAccessIn(BaseModel):
    ssh_key_id: int
    username: str = "root"

@app.get("/api/ssh-keys")
def list_ssh_keys():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, public_key, fingerprint, created_at FROM ssh_keys ORDER BY name"
        ).fetchall()
    return [dict(r) for r in rows]

@app.post("/api/ssh-keys", status_code=201)
def add_ssh_key(data: SshKeyIn):
    key = data.public_key.strip()
    if not key.startswith("ssh-"):
        raise HTTPException(400, "Invalid public key format")
    fp = _ssh_fingerprint(key)
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO ssh_keys (name, public_key, fingerprint) VALUES (?,?,?)",
            (data.name.strip(), key, fp)
        )
        conn.commit()
        row = conn.execute("SELECT * FROM ssh_keys WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(row)

@app.delete("/api/ssh-keys/{key_id}", status_code=204)
def delete_ssh_key(key_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM ssh_keys WHERE id=?", (key_id,))
        conn.commit()

@app.get("/api/hosts/{ip}/ssh-access")
def get_host_ssh_access(ip: str):
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT a.id, a.ssh_key_id, a.username, k.name, k.fingerprint
            FROM ssh_access a JOIN ssh_keys k ON k.id = a.ssh_key_id
            WHERE a.host_ip = ? ORDER BY a.username, k.name
        """, (ip,)).fetchall()
    return [dict(r) for r in rows]

@app.post("/api/hosts/{ip}/ssh-access", status_code=201)
def add_host_ssh_access(ip: str, data: SshAccessIn):
    with get_conn() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO ssh_access (ssh_key_id, host_ip, username) VALUES (?,?,?)",
                (data.ssh_key_id, ip, data.username.strip())
            )
            conn.commit()
        except Exception:
            raise HTTPException(409, "Access entry already exists")
        row = conn.execute("""
            SELECT a.id, a.ssh_key_id, a.username, k.name, k.fingerprint
            FROM ssh_access a JOIN ssh_keys k ON k.id = a.ssh_key_id WHERE a.id=?
        """, (cur.lastrowid,)).fetchone()
    return dict(row)

@app.delete("/api/ssh-access/{access_id}", status_code=204)
def delete_ssh_access(access_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM ssh_access WHERE id=?", (access_id,))
        conn.commit()

@app.get("/api/hosts/{ip}/authorized-keys")
def get_authorized_keys(ip: str, user: str = "root"):
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT k.public_key, k.name
            FROM ssh_access a JOIN ssh_keys k ON k.id = a.ssh_key_id
            WHERE a.host_ip = ? AND a.username = ?
            ORDER BY k.name
        """, (ip, user)).fetchall()
    lines = [f"{r['public_key']} {r['name']}" for r in rows]
    from fastapi.responses import PlainTextResponse
    return PlainTextResponse("\n".join(lines) + ("\n" if lines else ""))


# ── Static files (must be last) ───────────────────────────────────────────────

app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
