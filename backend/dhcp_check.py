"""DHCP warnings: hosts and pools that look wrong given each subnet's DHCP range.

Three checks (nothing here changes data; it only reads and reports):
  static_in_pool  a host marked static whose IP sits inside the DHCP pool,
                  so the DHCP server could hand that address to another device
  infra_in_pool   an important device (router, switch, AP, NAS, server, printer,
                  DNS/DHCP server, or anything with a monitored service) on a
                  pool address: a hint to reserve or fix its IP, not an error
  pool_full       90% or more of a pool's addresses answered in the last 7 days

A host can opt out (hosts.no_dhcp_warn) — e.g. a DHCP reservation inside the pool.
"""
import ipaddress
from datetime import datetime, timedelta, timezone

INFRA_TYPES = {"router", "gateway", "switch", "unmanaged-switch", "firewall", "ap", "server", "nas", "printer"}
POOL_FULL_PCT = 90
POOL_RECENT_DAYS = 7


def _pools(subnets: list[dict]) -> list[dict]:
    out = []
    for s in subnets:
        try:
            start, end = ipaddress.ip_address(s["dhcp_start"]), ipaddress.ip_address(s["dhcp_end"])
        except (TypeError, ValueError, KeyError):
            continue
        if end >= start and start.version == 4:
            out.append({**s, "_lo": int(start), "_hi": int(end)})
    return out


def _ip_int(ip_str: str):
    """IPv4 as an int, or None (fast path; aliases like node-7 and IPv6 → None)."""
    try:
        a, b, c, d = (int(x) for x in ip_str.split("."))
    except (ValueError, AttributeError):
        return None
    return (a << 24) | (b << 16) | (c << 8) | d if max(a, b, c, d) < 256 and min(a, b, c, d) >= 0 else None


def _pool_of(ip_str: str, pools: list[dict]):
    n = _ip_int(ip_str)
    if n is None:
        return None
    return next((p for p in pools if p["_lo"] <= n <= p["_hi"]), None)


def find_issues(conn) -> dict:
    """{"hosts": {ip: [{"code", "text"}]}, "pools": [{subnet_id, name, cidr, used, size, pct, text}]}"""
    subnets = [dict(s) for s in conn.execute("SELECT id, name, cidr, dhcp_start, dhcp_end FROM subnets")]
    pools = _pools(subnets)
    result = {"hosts": {}, "pools": []}
    if not pools:
        return result

    monitored = {r["host_id"] for r in conn.execute(
        "SELECT DISTINCT host_id FROM services WHERE monitored=1 AND host_id IS NOT NULL")}
    hosts = [dict(h) for h in conn.execute(
        "SELECT id, ip, hostname, device_type, static_override, is_dns, is_dhcp, no_dhcp_warn, last_seen FROM hosts")]

    for h in hosts:
        if h["ip"].startswith("node-") or h.get("no_dhcp_warn"):
            continue
        pool = _pool_of(h["ip"], pools)
        if not pool:
            continue
        rng = f'{pool["dhcp_start"]}–{pool["dhcp_end"]}'
        if h.get("static_override") == "static":
            result["hosts"].setdefault(h["ip"], []).append({
                "code": "static_in_pool",
                "text": f"Marked static, but {h['ip']} is inside the DHCP pool ({rng}). "
                        "The DHCP server could give this address to another device."})
        elif h.get("static_override") is None:
            why = None
            if (h.get("device_type") or "") in INFRA_TYPES:
                why = h["device_type"]
            elif h.get("is_dns") or h.get("is_dhcp"):
                why = "DNS/DHCP server"
            elif h["id"] in monitored:
                why = "has monitored services"
            if why:
                result["hosts"].setdefault(h["ip"], []).append({
                    "code": "infra_in_pool",
                    "text": f"Important device ({why}) on a DHCP pool address ({rng}). Its IP can change; "
                            "consider a DHCP reservation or a static IP outside the pool."})

    for p in pool_usage(conn, pools):
        if p["size"] and p["pct"] >= POOL_FULL_PCT:
            label = p.get("name") or p["cidr"]
            result["pools"].append({
                **{k: p[k] for k in ("subnet_id", "name", "cidr", "used", "size", "pct")},
                "text": f"DHCP pool on {label} is {p['pct']}% full ({p['used']} of {p['size']} addresses seen in the last "
                        f"{POOL_RECENT_DAYS} days). New devices may not get an address."})
    return result


def pool_usage(conn, pools: list[dict] | None = None) -> list[dict]:
    """Every DHCP pool: distinct pool addresses (host IPs and alias IPs) seen recently.
    [{subnet_id, name, cidr, used, size, pct}] — also shown on the Subnets page."""
    if pools is None:
        pools = _pools([dict(s) for s in conn.execute("SELECT id, name, cidr, dhcp_start, dhcp_end FROM subnets")])
    cutoff = (datetime.now(timezone.utc) - timedelta(days=POOL_RECENT_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
    seen = [r["ip"] for r in conn.execute("SELECT ip FROM hosts WHERE last_seen >= ? OR online=1", (cutoff,))]
    seen += [r["ip"] for r in conn.execute("SELECT ip FROM host_aliases WHERE last_seen >= ? OR online=1", (cutoff,))]
    seen_n = {n for n in map(_ip_int, seen) if n is not None}
    out = []
    for p in pools:
        size = p["_hi"] - p["_lo"] + 1
        used = sum(1 for n in seen_n if p["_lo"] <= n <= p["_hi"])
        out.append({"subnet_id": p["id"], "name": p.get("name"), "cidr": p["cidr"],
                    "used": used, "size": size, "pct": round(used * 100 / size) if size else 0})
    return out


def digest_lines(conn) -> list[str]:
    """Warnings not reported in an earlier digest (each is sent once, and again only
    if it clears and comes back). Marks them reported."""
    issues = find_issues(conn)
    lines = []
    host_rows = {r["ip"]: dict(r) for r in conn.execute("SELECT ip, hostname, dhcp_reported FROM hosts")}
    for ip, row in host_rows.items():
        codes = sorted(i["code"] for i in issues["hosts"].get(ip, []))
        before = set(filter(None, (row.get("dhcp_reported") or "").split(",")))
        for i in issues["hosts"].get(ip, []):
            if i["code"] not in before:
                name = f"{ip} ({row['hostname']})" if row.get("hostname") else ip
                short = "marked static but inside the DHCP pool" if i["code"] == "static_in_pool" \
                    else "important device on a DHCP pool address"
                lines.append(f"⚠ {name}: {short}")
        new = ",".join(codes) or None
        if new != (row.get("dhcp_reported") or None):
            conn.execute("UPDATE hosts SET dhcp_reported=? WHERE ip=?", (new, ip))
    full = {p["subnet_id"]: p for p in issues["pools"]}
    for s in conn.execute("SELECT id, pool_reported FROM subnets"):
        if s["id"] in full and not s["pool_reported"]:
            p = full[s["id"]]
            lines.append(f"⚠ DHCP pool on {p.get('name') or p['cidr']} is {p['pct']}% full ({p['used']}/{p['size']})")
        flag = 1 if s["id"] in full else 0
        if flag != (s["pool_reported"] or 0):
            conn.execute("UPDATE subnets SET pool_reported=? WHERE id=?", (flag, s["id"]))
    conn.commit()
    return lines
