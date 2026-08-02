# Using Boltarr

A practical guide to operating Boltarr day-to-day. For installation, see the
[README](../README.md).

> All addresses below (`192.168.1.x`, `ntfy.example.com`, etc.) are examples —
> substitute your own.

---

## Contents

1. [First run](#first-run)
2. [Subnets & scanning](#subnets--scanning)
3. [Scheduled scans](#scheduled-scans)
4. [Change tracking & alerts](#change-tracking--alerts)
5. [Host liveness (offline/online)](#host-liveness-offlineonline)
6. [Timezone](#timezone)
7. [Topology view](#topology-view)
8. [Hosts](#hosts)
9. [Services](#services)
10. [Service monitor (uptime)](#service-monitor-uptime)
11. [Notifications (ntfy)](#notifications-ntfy)
12. [Public status page](#public-status-page)
13. [SSH key management](#ssh-key-management)
14. [Backup & restore](#backup--restore)

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

**The Scans tab** has four sub-tabs: **Run · Schedules · History · Changes.**

**Run** is a visual nmap builder. Pick a target subnet and a **scan profile**,
then tune the options — ports (none/top-1000/top-N/all/custom range), service &
version detection (`-sV`), OS detection (`-O`), timing (`T0`–`T5`), skip host
discovery (`-Pn`), UDP (`-sU`), and NSE scripts — with a live command preview.
Save any combination as a reusable **custom profile**. Built-in profiles: Quick
(discovery only), Standard (top-1000 + version/OS), Full (all ports).

**History** shows every run with live progress bars and elapsed timers while
running, the duration and timestamp when done, and skipped runs with their
reason. Scheduled runs are badged with the schedule name.

**Probe a single host:** from a host's detail panel you can re-probe just that
host — useful to refresh its open ports or pick up a newly-found MAC address.
Once a scan finds a host's MAC, the host is marked `scanned` (vs `manual`).

**Static vs DHCP:** set a subnet's DHCP pool range (edit a subnet via the ✎
pencil) so hosts inside it are classified **dynamic** and those outside
**static**. You can override a host's classification in its edit dialog.
Manually-added hosts are tagged `manual` until a scan confirms them.

---

## Scheduled scans

The **Scans → Schedules** sub-tab runs scans for you automatically. Findings
flow into Change tracking and alerts just like a manual scan.

Each schedule has:

- **Target** — all subnets or one specific subnet, and which hosts within it:
  *whole range* (the only mode that discovers brand-new devices), or just
  *static* / *dynamic* / *unknown* known hosts.
- **Profile** — any scan profile (built-in or your custom ones).
- **Timing** — either **every N hours** (optionally *starting at* a clock time,
  e.g. "every 6 hours from 03:00", which aligns the runs to the clock), or on
  **chosen weekdays at a time**.
- **Active window** (optional) — restrict a schedule to only run between two
  times, e.g. a daytime "07:00–22:00" for hourly sweeps so nothing light runs
  overnight. Outside the window a due run is silently skipped until it reopens
  (crosses midnight fine, e.g. 22:00–06:00). It only gates automatic firing —
  Run now and host liveness are unaffected.

Each row shows an enable/disable switch, **last run** and computed **next run**
(absolute + relative, e.g. "Aug 1, 3:00 AM · in 6h"), plus **Run now**, edit and
delete. Times are interpreted in your configured [timezone](#timezone). If a
schedule comes due while a scan of that subnet is still running, the run is
skipped (and logged in History) so scans never stack.

---

## Change tracking & alerts

Every scan is diffed against the last known state. **Settings → Change tracking**
controls what's recorded (new hosts, opened/closed ports, MAC/hostname changes,
offline/online) and how long to keep it (retention days). Recorded changes show
in the **Scans → Changes** feed and per-host **Changes** tab; click a row to jump
to that host.

**Settings → Change alerts** turns recorded changes into ntfy notifications,
delivered as a **per-scan summary** and/or a **daily digest** at a time you set.
Use **"Alert for"** to scope every alert type by host classification —
**Static / Dynamic / All** (unknown-classified hosts never alert). This only
controls the push; the Changes feed always keeps everything. Per-host opt-outs
(no-MAC-alert, no-offline-alert) still apply, and all alerts respect quiet hours.
**Attach device MAC** adds each host's MAC to alerts (offline/online, scan
summary, digest) — handy for spotting a roaming device that keeps its MAC while
its IP changes across access points.

*"Port closed" is only recorded for ports a scan actually covered, so a shallow
scan never false-flags a deeper scan's ports.*

---

## Host liveness (offline/online)

A light background **ping sweep** (`nmap -sn`) marks each known host online or
offline — the coloured dot next to each IP in the Hosts table (green online /
red offline / grey unknown). A host goes offline after a few consecutive missed
sweeps and back online on the first response, so brief blips don't false-alarm.

Configure it in **Settings → Liveness** (enable, sweep interval, offline-after
threshold). Offline/online transitions are recorded as changes and — for static
hosts, unless opted out — fire an immediate, quiet-hours-aware ntfy alert. First
activation is silent (no alert storm); alerts only fire on a real later
transition.

---

## Timezone

**Settings → General → Timezone** sets an IANA timezone (e.g. `Asia/Dubai`). It
drives all time-of-day logic — schedule fire times, quiet hours, the daily
digest — and how times are displayed throughout the app. Leave it as *Server
default* to use the server's own clock (UTC in most containers). Set it to your
local zone so "03:00" means 3 AM where you are.

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
- **Change its IP** — edit the **IP address** field in the same dialog. This is a
  full rename: the host keeps its notes, ports, services, SSH access, history and
  topology links, all of which follow it to the new IP. If the new IP already
  belongs to another host, the change is blocked (use Merge instead).
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

The status app ships with Boltarr in [`../statuspage/`](../statuspage) — a tiny
container you run **on a separate host**. See its
[README](../statuspage/README.md) to deploy it (copy `.env.example` → `.env`,
set a token, `docker compose up -d`). This section covers the **Boltarr side**
(marking services public and configuring the push).

**1. Mark services public.** In a service's detail panel, tick **Public status
page** and optionally set a **Public name** (what strangers see, e.g. "Photos"
instead of an internal hostname). Only services that are *both* monitored and
public appear.

**2. Configure the push** in ⚙ **Settings → Public status page**:

- **Enabled** — on/off.
- **Status app URL** — the LAN address of your status app, e.g.
  `http://192.168.1.20:12102`.
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
  the live files, then upgrades the restored database to the current schema, so
  a backup from an older version restores cleanly into a newer Boltarr.

The backup ZIP contains `config.yaml`, which holds your tokens and API keys —
treat it as sensitive and don't share it.

Mount `./data` as a Docker volume to persist across container restarts (the
provided compose files do this automatically).
