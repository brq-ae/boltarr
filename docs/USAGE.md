# Using Boltarr

A practical guide to operating Boltarr day-to-day. For installation, see the
[README](../README.md).

> All addresses below (`192.168.1.x`, `ntfy.example.com`, etc.) are examples —
> substitute your own.

---

## Contents

1. [First run](#first-run)
2. [Subnets & scanning](#subnets--scanning)
3. [Topology view](#topology-view)
4. [Hosts](#hosts)
5. [Services](#services)
6. [Service monitor (uptime)](#service-monitor-uptime)
7. [Notifications (ntfy)](#notifications-ntfy)
8. [Public status page](#public-status-page)
9. [SSH key management](#ssh-key-management)
10. [Backup & restore](#backup--restore)

---

## First run

Open Boltarr at `http://<your-host>:12100`. The left sidebar holds the main
tabs — **Topology, Hierarchy, Services, Hosts, Scans, SSH Keys** — plus a
**Subnets** section and a ⚙ **Settings** button.

Nothing is scanned yet. Start by adding a subnet.

---

## Subnets & scanning

**Add a subnet:** in the sidebar **Subnets** section, click **+** and enter a
name and a CIDR (e.g. `192.168.1.0/24`). Each subnet row has:

- **▶ Scan** — runs an nmap discovery scan across that range. Discovered hosts
  appear in the **Hosts** tab and as nodes in **Topology**.
- **👁 eye** — show/hide that subnet's nodes in the topology graph.
- **✕** — remove the subnet (this does *not* delete already-discovered hosts).

**Scan progress** is shown live in the **Scans** tab, which also keeps a history
of past runs.

**Probe a single host:** from a host's detail panel you can re-probe just that
host — useful to refresh its open ports or pick up a newly-found MAC address.
Once a scan finds a host's MAC, the host is marked `scanned` (vs `manual`).

**Static vs DHCP:** set a subnet's DHCP pool range so hosts outside it are
treated as static. Manually-added hosts are tagged `manual` until a scan
confirms them.

---

## Topology view

The **Topology** tab is an interactive graph of your network (Cytoscape).

- **Drag** nodes to arrange them; the layout is saved.
- **Click** a node to open its host detail panel.
- Node **color** reflects device type (router, server, container, workstation,
  IoT, etc.); the legend explains the colors.
- **Connections** between hosts can be drawn and labeled (wired / wifi / fiber /
  DAC / virtual), with speed and VLAN tags.
- **VLANs** are defined once and can be assigned to connections, which colors
  them on the graph.
- Use **Hierarchy** for a tiered, printable view derived from your connections.

---

## Hosts

The **Hosts** tab is a sortable, filterable table of every discovered or
manually-added device. Click a row to open the **host detail panel** at the
bottom, with tabs for host info, open ports, services, and SSH.

From the detail panel you can:

- **Edit** the host — hostname, device type, vendor, notes, MAC address (typing
  auto-inserts the `:` separators), DHCP pool, and more.
- **Merge** a multi-homed device — if the same physical machine has two IPs,
  merge them so it shows as one host with alias IPs. In the Hosts table, a
  merged host shows a collapsible **▶ +N** toggle listing its alias IPs.
- **Add/manage services** running on the host.
- Manage **SSH access** for the host (see [SSH key management](#ssh-key-management)).

---

## Services

The **Services** tab tracks the things running on your hosts (web apps,
databases, media servers, etc.). It has two sub-tabs:

- **List** — a table of all services. Click a row to open the **service detail
  panel**.
- **Topology** — a force-directed graph of services grouped by host, with
  dependency arrows. Drag a host and its services follow.

**Add a service:** click **+ Service**, pick the host it *runs on*, and fill in
name, port, URL, etc. A **container quick-pick** lets you attach services to
container hosts fast, and **⊕ Bulk** imports many container services at once.

**Nested containers:** the "runs on" dropdown includes container hosts (grouped
separately), so you can register services that live inside a container that
itself runs on another host.

**Dependencies:** from a service's ⊕ Dependencies menu, tag which other services
it depends on. These render as arrows in the services topology.

**Service detail panel** (click any service row) lets you edit everything, set
its live-check status, toggle **Monitor** and **Public status page**, and view
its **uptime**.

---

## Service monitor (uptime)

Boltarr can actively watch a service and tell you when it goes down — like a
built-in Uptime-Kuma.

**Turn it on:** open a service's detail panel and tick **Monitor**. It's off by
default, so you only watch the services you care about.

- Boltarr checks the service every **60 seconds**. If the service has a **URL**
  it does an HTTP request; otherwise it opens a **TCP** connection to its port.
  *Reachable = up.*
- A live **dot** shows current status — green (up) / red (down) — in both the
  services table and the detail panel. It flips the instant a check fails.
- The detail panel shows **uptime** for the last **24h / 7d / 30d**, plus a list
  of recent **outages** with durations. History is kept for a rolling ~31 days
  and pruned automatically.

Alerts are configured under Settings → Notifications (below).

---

## Notifications (ntfy)

Boltarr sends push notifications via [ntfy](https://ntfy.sh) — the public
`ntfy.sh` or your own self-hosted server.

**Set up** in ⚙ **Settings → Notifications**:

- **Enabled** — master on/off.
- **Server** — `https://ntfy.sh` or your self-hosted URL (e.g.
  `https://ntfy.example.com`).
- **Topic** — the channel to publish to. With no auth, *the topic name is the
  secret*, so pick a long, unguessable one (e.g. `myapp_a1b2c3d4e5`).
- **Access token** — optional, only if your ntfy requires a login.
- **Send test** — fires a test notification so you can confirm your phone
  receives it.

> **Reliable delivery:** on a self-hosted ntfy, enable **Instant Delivery** for
> the topic in the ntfy app and exempt the app from battery optimization —
> otherwise Android may drop background pushes.

**Down / recovery alerts:** once a monitored service is down for longer than the
**"Alert after service down for N minutes"** grace period (default 5), you get a
down alert; when it recovers, a recovery alert with how long it was down. The
grace period stops brief blips from nagging you. `0` = alert immediately.

**Quiet hours:** tick **Quiet hours** and set a `from`–`to` window (your local
time). During it, alerts are muted — but anything still down when the window
*ends* alerts you then, so you wake up to what's actually broken instead of a
3am buzz or a silent night. Something that broke and recovered on its own during
the window stays silent.

---

## Public status page

Boltarr can feed a **separate, public status page** — showing your users which
services are up — **without exposing Boltarr itself**. Boltarr only ever pushes
a sanitized summary (public name, up/down, uptime, ticks — *no IPs, ports, or
internal detail*) one-way over your LAN to a small separate status app.

The status app is a tiny container you run yourself on a separate host — a
minimal web app that accepts the pushed JSON on a token-protected endpoint and
serves it as a read-only page. This guide covers the **Boltarr side** (marking
services public and configuring the push).

**1. Mark services public.** In a service's detail panel, tick **Public status
page** and optionally set a **Public name** (what strangers see, e.g. "Photos"
instead of an internal hostname). Only services that are *both* monitored and
public appear.

**2. Configure the push** in ⚙ **Settings → Public status page**:

- **Enabled** — on/off.
- **Status app URL** — the LAN address of your status app, e.g.
  `http://192.168.1.20:8081`.
- **Token** — a shared secret sent with each push.
- **Push now** — sends immediately so you can verify the page updates.

Boltarr pushes on any status change plus a ~60-second heartbeat. The payload per
service is: public name, up/down, 24-hour uptime %, and ~60 "ticks" (one per
minute for the last hour).

> **Security:** the push travels only over your LAN. If you put the status app
> behind a reverse proxy for the public subdomain, block its receive path (e.g.
> deny `/push`) so the internet can't post fake statuses — the LAN push bypasses
> the proxy and keeps working.

---

## SSH key management

Boltarr can act as a small registry of SSH public keys and which hosts/users
they should have access to.

- **SSH Keys** tab — register public keys (name + key). Each key is hidden by
  default; use the 👁 to reveal, the copy button to copy it. On mobile these are
  in a ⋮ menu.
- **Per host** (host detail → SSH) — grant a registered key access to a specific
  **username** on that host, then use **Copy deploy cmd** to get a one-liner
  that installs the key into *that user's* `~/.ssh/authorized_keys` with correct
  permissions and ownership (works for `root` or any user, run as root/sudo), or
  **Download** the ready `authorized_keys` file.

---

## Backup & restore

Boltarr's data lives in `data/` (`boltarr.db` + `config.yaml`).

- **Backup** — `GET /api/backup` streams a ZIP of the database and config; the UI
  has a download button.
- **Restore** — upload a backup ZIP; Boltarr validates and atomically replaces
  the live files.

Mount `./data` as a Docker volume to persist across container restarts (the
provided compose files do this automatically).
