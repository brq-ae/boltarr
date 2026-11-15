"""F-20: hostname, vendor and OS you set (by hand or an AI card) stay. Scans
keep what the network reports in net_hostname / net_vendor / net_os and only
fill a field you haven't set. Clearing a field hands it back to the network
value. The MAC always comes from the scan."""

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
