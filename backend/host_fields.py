"""F-20: hostname, vendor and OS you set (by hand or an AI card) stay. Scans
keep what the network reports in net_hostname / net_vendor / net_os and only
fill a field you haven't set. Clearing a field hands it back to the network
value. The MAC always comes from the scan."""
import ipaddress

# field -> (flag column, network column)
USER_FIELDS = {
    "hostname": ("hostname_set", "net_hostname"),
    "vendor":   ("vendor_set",   "net_vendor"),
    "os_guess": ("os_set",       "net_os"),
}


def set_by_user(conn, host_id: int, field: str, value) -> None:
    """Set one of the fields as the user's own; empty = back to the network's."""
    flag, net = USER_FIELDS[field]
    v = (value or "").strip() if isinstance(value, str) else value
    if v:
        conn.execute(f"UPDATE hosts SET {field}=?, {flag}=1 WHERE id=?", (v, host_id))
    else:
        conn.execute(f"UPDATE hosts SET {field}={net}, {flag}=0 WHERE id=?", (host_id,))


def scan_update_sql(field: str) -> str:
    """The ON CONFLICT … DO UPDATE part for one field: the network value is
    always kept; the shown value changes only if the user hasn't set it."""
    flag, net = USER_FIELDS[field]
    return (f"{field} = CASE WHEN {flag}=1 THEN {field} ELSE COALESCE(excluded.{field}, {field}) END, "
            f"{net} = COALESCE(excluded.{field}, {net})")


# ── Short names (S-27) ──
# Names the network reports often carry the local domain ("phone-1.lan.example.com",
# "nas.unknown.home.arpa"). Boltarr shows only the first part unless Settings → General
# says full names. Only for display: the stored name never changes, and a name you set
# is shown as you typed it.

def display_name(hostname, set_by_user=False, short=None) -> str:
    """The name to show for a device (alerts, the app, the map)."""
    name = (hostname or "").strip()
    if not name or set_by_user:
        return name
    if short is None:
        from .config import get_config
        short = get_config()["general"].get("short_names", True) is not False
    if not short or "." not in name:
        return name
    try:
        ipaddress.ip_address(name)       # an address used as a name stays whole
        return name
    except ValueError:
        pass
    return name.split(".", 1)[0] or name


def add_display_names(rows, key="hostname", flag="hostname_set", out="name") -> list:
    """Give each row (dicts) its shown name under `out`, reading the setting once."""
    from .config import get_config
    short = get_config()["general"].get("short_names", True) is not False
    for r in rows:
        r[out] = display_name(r.get(key), r.get(flag), short)
    return rows
