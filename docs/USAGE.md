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
9. [Search & export](#search--export)
10. [Services](#services)
11. [Service monitor (uptime)](#service-monitor-uptime)
12. [Notifications (ntfy)](#notifications-ntfy)
13. [Public status page](#public-status-page)
14. [SSH key management](#ssh-key-management)
15. [AI assistant](#ai-assistant)
16. [Login & security](#login--security)
17. [Backup & restore](#backup--restore)

For every feature in more detail, see the
[Boltarr wiki](https://github.com/brq-ae/boltarr/wiki).

---

## First run

Open Boltarr at `http://<your-host>:12100`. On a new install it first asks you
to **create your admin login** (or **Skip for now — set it later in Settings**);
see [Login & security](#login--security).

The left sidebar holds the main pages — **Topology, Services, Hosts, Subnets,
Scans, SSH Keys** — and the ⚙ **Settings** button at the bottom. The top bar has
the **search box** and **💬 Chat**. On a phone the main pages are in a bar at the
bottom.

Nothing is scanned yet. Start by adding a subnet.

---

## Subnets & scanning

**Add a subnet:** open **⊞ Subnets**, click **+ Add subnet** and enter a name
and a CIDR (e.g. `192.168.1.0/24`), plus the DHCP pool if you have one. Each
subnet row shows:

- **DHCP pool** — the range and a bar showing how full it is (addresses seen in
  the last 7 days; amber from 75%, red from 90%).
- **Hosts** — how many are in the subnet and how many are online. Click the
  number to see just those hosts on the Hosts page.
- **Last scan** — when it ran and how many hosts it found.
- **Map 👁** — show/hide the subnet on Topology (remembered).
- **Scan** — runs an nmap discovery scan across that range. While it runs, the
  button turns into **Stop**, with progress. Discovered hosts appear in **Hosts**
  and as nodes in **Topology**.
- **⋮ menu** — Edit, Show on map, IP History, Delete. Delete asks first and names
  the schedules that go with the subnet. Click a row to edit it.

**The Scans page** has four sub-tabs: **Run · Schedules · Scan Log · Changes.**

**Run** is a visual nmap builder. Pick a target subnet and a **scan profile**,
then tune the options — ports (none/top-1000/top-N/all/custom range), service &
version detection (`-sV`), OS detection (`-O`), timing (`T0`–`T5`), skip host
discovery (`-Pn`), UDP (`-sU`), and NSE scripts — with a live command preview.
Save any combination as a reusable **custom profile**. Built-in profiles: Quick
(discovery only), Standard (top-1000 + version/OS), Full (all ports). **Time limit
per host** (default 15 minutes, 0 = no limit) skips a host that takes too long and
leaves its ports as they were. Scan options are checked before they reach nmap;
anything nmap doesn't expect is refused with a message naming the setting.

Scans never overlap: a second scan waits in a queue.

**Scan Log** shows every run with live progress bars and elapsed timers while
running, the duration and timestamp when done, and skipped runs with their
reason. Scheduled runs are badged with the schedule name. A failed scan shows
nmap's own words in red; a scan where some hosts timed out shows **completed with
problems**. Old runs are cleaned up after 90 days.

**Probe a single host:** from a host's detail panel you can re-probe just that
host — useful to refresh its open ports or pick up a newly-found MAC address.
Once a scan finds a host's MAC, the host is marked `scanned` (vs `manual`).

**Static vs DHCP:** set a subnet's DHCP pool range (edit a subnet via the ✎
pencil) so hosts inside it are classified **dynamic** and those outside
**static**. You can override a host's classification in its edit dialog.
Manually-added hosts are tagged `manual` until a scan confirms them.

**DHCP warnings:** with a pool set, Boltarr flags a host marked static whose IP
is inside the pool, an important device (router, switch, server, NAS, printer, a
host with monitored services…) on a pool address, and a pool 90% or more full.
You see a **⚠** next to the host's type, an amber **DHCP pool N% full** chip on the
Hosts toolbar, and a **⚠ DHCP warnings** filter. Has a DHCP reservation inside the
pool? Use **Don't warn about this host**.

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
- **🔕 Silent** (optional) — the scan runs and records changes as usual, but sends
  no ntfy alert. Its changes still show in the Changes tab and the daily digest.
- **Active window** (optional) — restrict a schedule to only run between two
  times, e.g. a daytime "07:00–22:00" for hourly sweeps so nothing light runs
  overnight. Outside the window a due run is silently skipped until it reopens
  (crosses midnight fine, e.g. 22:00–06:00). It only gates automatic firing —
  Run now and host liveness are unaffected.

Each row shows an enable/disable switch, **last run** and computed **next run**
(absolute + relative, e.g. "Aug 1, 3:00 AM · in 6h"), plus **Run now**, edit and
delete. Times are interpreted in your configured [timezone](#timezone). If a
schedule comes due while a scan of that subnet is still running, the run is
skipped (and logged in Scan Log) so scans never stack. Repeating schedules keep
their clock time across daylight-saving changes, and a missed run is caught up
within 5 minutes.

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

**The daily digest** can also list monitored-service outages (**Include service
outages**), DHCP warnings, and an optional short **AI summary** at the top (**Add a
short AI summary to the digest**, off by default). **Preview digest** shows what it
would say right now; nothing is sent.

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
hosts, unless opted out — fire an immediate ntfy alert. During quiet hours they
are sent together as one summary when quiet hours end. First activation is silent
(no alert storm); alerts only fire on a real later transition. If a subnet's sweep
fails or runs too long, that round is skipped instead of marking every host there
offline.

**Host uptime.** A host's panel (**Info** tab → **Liveness**) shows its current
up/down plus **24h / 7d / 30d uptime %** and recent **outages**, built from the
same up/down history — the host equivalent of the service uptime view.

---

## Timezone

**Settings → General → Timezone** sets an IANA timezone (e.g. `Europe/London`). It
drives all time-of-day logic — schedule fire times, quiet hours, the daily
digest — and how times are displayed throughout the app. Leave it as *Server
default* to use the server's own clock (UTC in most containers). Set it to your
local zone so "03:00" means 3 AM where you are. With no timezone set, the AI chat
says its times are UTC.

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
- Switch **Graph | Hierarchy** at the top for a tiered, printable view derived from
  your connections.
- **⬡ Analyze Network** asks the AI for a big-picture look (see
  [AI assistant](#ai-assistant)).

---

## Hosts

The **Hosts** page has two views: **List** and **IP History**.

**List** is a sortable, filterable table of every discovered or manually-added
device. **Columns ▾** shows/hides columns; **📌 Pin** keeps one visible on narrow
screens (others hide by themselves when there's no room). Click a row to open the
**host detail panel**, with tabs for Info, Links, Ports, Services, Analysis, SSH
and Changes. The panel remembers your tab when you switch hosts.

**IP History** lists every static-range IP (outside the DHCP pool) as *In use /
Recent / Stale / Gone / Never seen*, so you can tell which addresses are free.
**Settings → 🕓 IP History** sets when an unseen IP reads as stale (default 30
days) or gone (default 60).

From the detail panel you can:

- **Edit** the host — hostname, device type, vendor, notes, MAC address (typing
  auto-inserts the `:` separators), classification, and more.
- **Names you set stay.** Scans never overwrite a hostname, vendor or OS you typed
  in (or set with an AI card). The name the network reports is kept separately:
  hover a name with a dotted underline to see it. Clear the name to go back to the
  network's name.
- **Change its IP** — edit the **IP address** field in the same dialog. This is a
  full rename: the host keeps its notes, ports, services, SSH access, history and
  topology links, all of which follow it to the new IP. If the new IP already
  belongs to another host, the change is blocked (use Merge instead).
- **Merge** a multi-homed device — if the same physical machine has two IPs,
  merge them so it shows as one host with alias IPs. In the Hosts table, a
  merged host shows a collapsible **▶ +N** toggle listing its alias IPs.
- **Add/manage services** running on the host.
- Manage **SSH access** for the host (see [SSH key management](#ssh-key-management)).
- **⟳ Probe** the host with a scan profile, or **Analyze** it with the AI.

---

## Search & export

**Search:** the box in the top bar (`/` or `Ctrl+K`; 🔍 on phones) finds hosts and
services as you type: IP, alias IPs, hostname, MAC (with or without separators),
vendor, type, OS, notes, open-port services, service name, port and URL. Pick a
result to open it. **See all N results** (or **Shift+Enter**) opens a Search page
with every match. The Hosts and Services filter boxes use the same matching.

**Export:** **⤓ Export ▾** on Hosts, Services and IP History downloads the rows you
see (search, filters and sort applied) as **CSV** or **JSON**, with every column,
hidden ones included. The CSV opens cleanly in Excel or Google Sheets.

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

- Boltarr checks the service on a timer — **every 60 seconds by default,
  configurable 15–600s** in Settings → Notifications (*"Probe each service every
  N seconds"*). A longer interval is lighter but slower to notice an outage; the
  interval also sets the width of one tick on the status page's 1-hour bar.
- **Monitor check** picks how: **HTTP(S)** (a web request to the URL), **TCP** (a
  connection to the port) or **Ping (ICMP)**. **Monitor target IP** checks another
  address than the host's, e.g. a container's own IP.
- **Web checks:** any reply below 500 counts as up (401, 403, 404 and redirects
  too); **5xx replies such as 502 and 503 count as down**. Need something else?
  Fill in **Accepted replies** (e.g. `200-299` or `200,404`; **hints** explains it).
  A monitored service with no address shows grey **Not set up** and sends no alert.
- **Pause** monitoring (the pause button next to the Monitor switch) with an
  optional **Reason** and **Until** (at most 30 days). Without a reason the service
  shows grey **Paused**; with one it shows orange **Maintenance**, with the reason
  on the status page. Paused time is left out of uptime figures.
- A live **dot** shows current status — green (up) / red (down) — in both the
  services table and the detail panel. It flips the instant a check fails.
- The detail panel shows **uptime** for the last **24h / 7d / 30d**, plus a list
  of recent **outages** with durations. History is kept for a rolling ~31 days
  and pruned automatically.
- **Host correlation** — each service's host up/down shows in the list, and a
  down service on an offline host is tagged **"host offline"** so you can see the
  root cause at a glance. When a host goes offline, its services' down-alerts are
  **suppressed** (you get the one host-offline alert instead of a flood) — a
  toggle in Settings → Notifications, on by default.

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
time). During it, alerts are held — but anything still down when the window
*ends* alerts you then, so you wake up to what's actually broken instead of a
3am buzz or a silent night. Devices going offline or online and services coming
back are sent together in one summary.

**Delivery:** an alert counts as sent only once ntfy accepts it; failures are
retried for a few rounds, and Settings shows the last notification error.

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

The page has up to three sections: **Services**, **Hosts**, and **Networking**
(router/AP/switch/firewall gear) — each only shown when it has something public.

**1. Mark services public.** In a service's detail panel, tick **Public status
page** and optionally set a **Public name** (what strangers see, e.g. "Photos"
instead of an internal hostname). Only services that are *both* monitored and
public appear.

**1b. Mark hosts public.** In a host's **Edit** dialog, tick **Show on public
status page** and set a **Public name**. The host's up/down + uptime appears on
the page (under **Networking** if its device type is router/gateway/switch/
unmanaged-switch/firewall/AP, otherwise under **Hosts**). As with services, only
the public name, status, uptime and ticks are pushed — never the IP.

**2. Configure the push** in ⚙ **Settings → Public status page**:

- **Enabled** — on/off.
- **Status app URL** — the LAN address of your status app, e.g.
  `http://192.168.1.20:12102`.
- **Token** — a shared secret sent with each push.
- **Push now** — sends immediately so you can verify the page updates.
- **Show "may be out of date" after** — minutes without an update (default 5)
  before the status page shows a yellow banner.

Changing the **Status app URL** while a token is saved? See
[Saved secrets](#login--security): type the token again or tick **Send my saved
status page token to this new address.**

Boltarr pushes on any status change plus a heartbeat at least every ~60s (so the
page stays fresh even if you lengthen the probe interval). The payload per item
is: public name, up/down, uptime %, and tick bars for 1h / 24h / 7d / 30d, plus a
sanitized incident list.

> **Security:** the push travels only over your LAN. If you put the status app
> behind a reverse proxy for the public subdomain, block its receive path (e.g.
> deny `/push`) so the internet can't post fake statuses — the LAN push bypasses
> the proxy and keeps working.

### Status-page admin panel

The status app has its own **admin panel** — log in from the page (set
`STATUS_ADMIN_PASSWORD` in the status app's `.env`). It's cookie-session + CSRF
protected and rate-limits logins, so it's safe to expose. Logged in, you get:

- **Visibility (gating)** — mark each section (Services / Hosts / Networking)
  **Public** or **Private**. A private section is received but shown only to a
  logged-in admin — check private things from anywhere by logging in, while the
  public sees only what you choose. Per *section*, not per item.
- **Display** — pick the **uptime %** window and **bar period** independently,
  each `1h / 24h / 7d / 30d`. The 1-hour bar shows one tick per probe.
- **Branding** — name, tagline, footer, logo, and the full colour palette (with a
  colour legend). Stored on the status app; the repo ships neutral defaults.
- **Announcements** — a banner (info / maintenance / critical) with optional
  start/end times.
- **Maintenance calendar** — planned, announced maintenance: one-off or recurring
  (daily / weekly / monthly-by-date / monthly-Nth-weekday) with a time window;
  visitors see upcoming + a calendar + an "in progress" banner.
- **Automated maintenance** — recurring **expected** downtime you don't announce
  (e.g. a nightly backup). Target the services/hosts it covers + the days/time;
  while a covered item dips inside its window the incident, tick, and dot turn
  **amber "Scheduled maintenance"** instead of red. The downtime still counts
  toward uptime — only the cause is relabelled; an overrun past the window stays
  red. Never on the public calendar.
- **Past incidents** — the timeline (down → back → duration). **Clear past
  incidents** hides everything resolved up to now (ongoing stays; new ones still
  appear).

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
  **Download** the ready `authorized_keys` file. Key names, keys and usernames are
  checked, so the command can't carry unsafe text.

---

## AI assistant

AI is optional. Set it up in **⚙ Settings → 🤖 AI**: **Provider** (Ollama,
OpenAI-compatible, or Anthropic), **Base URL**, **API Key**, **Default Model**,
**Timeout / Long timeout**, and for Ollama **Context (tokens)**. **⚡ Test AI**
checks the connection. Environment variables (`LLM_*`) override these.

- **Chat** (**💬 Chat** in the top bar) — ask about your network. Each question is
  sent with notes about your **live** network: what's down now, the most
  important devices in full detail and a short line for every other one, an
  open-ports index, connections, VLANs, and changes and outages from the last 7
  days. Devices you mention (by IP, hostname, service name or vendor) get full
  detail. Replies stream in and are formatted; **■ Stop** (or Esc) stops one;
  **⤢** widens the chat; **⧉** copies and **⤓** downloads the conversation; **＋**
  (click twice) starts a new chat.
- **AI cards** — ask the chat to show or change something and it adds a card:
  open a host or service, explain an outage, set a host's note (**Add to note** or
  **Replace note**), name or type, scan a subnet, probe a host, pause or resume
  monitoring (optionally until a time). Boltarr checks each card, and changes
  happen only when you click **Do it**. Deleting, settings, SSH keys, backups and
  restore are never possible.
- **Analyze** (host panel) — what the device likely is. It fills in the device type
  only if it's still unknown. **⬡ Analyze Network** (Topology) looks at
  everything.
- **Explain** — every outage in a service or host panel has an Explain link:
  Boltarr gathers the facts and the AI words a likely cause. Without AI you still
  get the facts.
- **AI history** (**Settings → 🤖 AI → AI history**) — keeps earlier results and
  the **AI actions record** (every Do it and Cancel). **Keep up to** N per item
  (default 10), **Delete after** N days (default 90, 0 = no limit), **🗑 Clean
  history**.
- **Context (Ollama)** — default 8192 tokens. Boltarr keeps about a quarter of the
  window for the answer and trims its notes to fit; if the AI still runs out of
  room it says so. Under the box you see the model's maximum context and whether
  it's loaded fully on the GPU.
- **Errors** are shown in the provider's own words; an empty or failed reply is
  not kept in the conversation, and a thinking model's `<think>` text is hidden.

With Ollama nothing leaves your network; with an online provider the network
notes go to that provider.

---

## Login & security

- **Login** (**Settings → 🔒 Login**) — optional, one admin account. Password 8+
  characters; browsers stay logged in for 30 days. **Change password** logs out
  other browsers. Behind Authelia/Authentik? Under **Login service in front**, enter
  **Its IP address(es)** and the **User header** (default `Remote-User`) and tick
  **Trust the login service**. Use the service's own address, not a whole range.
- **Forgot the password?** `docker exec boltarr reset-password` (Unraid: the
  container's Console; without Docker: `venv/bin/python -m backend.reset_password`)
  turns login off. Then set a new one in Settings.
- **API scripts** must send the header `X-Boltarr: 1` on every change
  (POST/PUT/PATCH/DELETE), with login on or off. This blocks forged requests from
  other websites.
- **Strict browser security** — Boltarr's pages load nothing from outside and the
  browser refuses code written into the page. **Settings → 🛡 Security** lists
  anything blocked and lets you allow dashboards (Homarr, Home Assistant…) to show
  Boltarr in a frame. Off-switch if a button breaks:
  `BOLTARR_ALLOW_INLINE_SCRIPTS=1` (and please open an issue).
- **Saved secrets** — a saved AI key, ntfy token or status page token is never sent
  to a new address on its own. Type it again, or tick **Send my saved … to this new
  address**.

---

## Backup & restore

Everything is in **⚙ Settings → 🗄 Data**. Boltarr's data lives in `data/`
(`boltarr.db` + `config.yaml`).

- **⬇ Backup** — downloads a zip of the database and settings. **Protect with a
  password** is on by default (8+ characters; a standard AES-encrypted zip that
  7-Zip/WinRAR can open). The password can't be recovered. A backup holds your
  tokens, keys and login, so keep the password on.
- **⬆ Restore** — pick a backup zip. Boltarr first uploads and **checks** it
  (nothing changes yet), asks for the password if it has one, and shows when it
  was made, by which version, whether it includes settings, and the number of
  hosts/services/subnets/links **now** and **after restore**. **Restore now**
  replaces everything; the page reloads by itself, **no restart needed**. A backup
  from an older Boltarr is upgraded while restoring.
- **Refused, with nothing changed:** while a scan is running; a file over 500 MB
  or unpacking to over 1 GB; a file that isn't a valid Boltarr backup; a backup
  that can't be upgraded to this version.
- **↺ Reset all uptime** — starts every uptime history fresh.
- **↺ Factory reset** wipes all network data (hosts, services, subnets, scans,
  schedules, history, VLANs, SSH keys). Tick *Keep settings* to preserve
  ntfy/status-page/timezone/AI, or untick for a full reset; you must type `DELETE`
  to confirm. Refused while a scan is running.

**Bulk delete:** the Hosts and Services tables have a checkbox column + *Select
all* + *Delete selected* for clearing many at once.

**From a script:** `GET /api/backup` downloads an unprotected backup;
`POST /api/restore` (with the `X-Boltarr: 1` header) restores in one step.

Mount `./data` as a Docker volume to persist across container restarts (the
provided compose files do this automatically).
