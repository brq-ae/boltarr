<p align="center">
  <img src="frontend/img/BoltarrLogo.svg" width="120" alt="Boltarr">
</p>

# Boltarr

A self-hosted network dashboard for mapping, monitoring, and analyzing your local network. Scan subnets on a schedule, track what changes between scans, detect when hosts go offline, visualize topology, manage VLANs, monitor service uptime, and chat with an AI assistant that knows your network.

**📖 New here? See the [Usage guide](docs/USAGE.md)** for how to operate Boltarr day-to-day.

## Features

- **Topology view** — interactive Cytoscape.js graph with drag-and-drop layout, VLAN coloring, connection types (wired/wifi/fiber/DAC/virtual)
- **Network scanning** — nmap-powered host and port discovery with a visual scan builder and reusable scan profiles (Quick/Standard/Full + custom)
- **Scheduled scans** — run scans automatically on an interval (optionally clock-anchored) or on chosen weekdays, with an optional active-hours window; target all subnets or one, and the whole range or just static/dynamic hosts
- **Change tracking** — records what each scan finds different vs. before (new hosts, opened/closed ports, MAC/hostname changes), with a per-type retention window
- **Change alerts** — ntfy notifications for recorded changes as a per-scan summary and/or a daily digest; scope alerts by host classification (static / dynamic / all) with per-host opt-outs
- **Host liveness & uptime** — a light background ping tier marks hosts online/offline, tracks per-host uptime %/outages, alerts on transitions, and correlates service outages to a down host (with alert suppression)
- **Timezone-aware** — a configurable timezone drives schedule times, quiet hours, the digest, and how times are displayed
- **DHCP-aware classification** — per-subnet DHCP range classifies hosts as static or dynamic
- **Device management** — add/edit/delete hosts, merge multi-homed devices, annotate with notes
- **Services registry** — track running services per host, with a services topology and dependencies
- **Service uptime monitor** — up/down checks, ntfy alerts with a grace period, quiet hours, and 24h/7d/30d uptime history
- **Public status page** — push a sanitized status summary (services, hosts, and networking gear) to a separate, internet-facing page over your LAN — public names only, never internal IPs
- **VLAN management** — define VLANs, assign them to connections, visualize on topology
- **AI analysis** — per-host and network-wide analysis; AI chat assistant with full network context
- **AI optional** — works without AI; supports Ollama, OpenAI-compatible APIs, and Anthropic

## Quick start (Docker)

> [!NOTE]
> **Deployment is now a single file.** `docker-compose.yml` uses **host networking
> by default** so scanning works out of the box, with commented one-line toggles
> for unprivileged **LXC** (AppArmor) and **bridge**-only. If you previously used
> `docker-compose.host.yml` or `docker-compose.lxc.yml`, switch to
> `docker-compose.yml` — see the table below.

```bash
curl -O https://raw.githubusercontent.com/brq-ae/boltarr/master/docker-compose.yml
docker compose up -d
```

Open **http://\<host-ip\>:12100** — with host networking Boltarr binds `:12100`
directly on the host (no port mapping).

**Why host networking?** Boltarr scans your LAN with nmap (host discovery, MAC
addresses, the liveness ping tier). Docker's default **bridge** network sandboxes
the container, so nmap can't reach your LAN — you'd get no host discovery, no MAC
addresses, and degraded liveness. So host networking is the default; bridge is a
commented toggle for the "I only track things manually" case.

**Pick your setup** (all in the one `docker-compose.yml`):

| Your environment | Want LAN scanning? | What to do |
|---|---|---|
| Normal Docker host | Yes (recommended) | Use it as-is |
| Unprivileged **LXC** (Proxmox) | Yes | Uncomment the `security_opt: apparmor=unconfined` toggle |
| Anywhere | No (manual only) | Switch to the commented bridge toggle |

> **Tip:** run Boltarr on its own box, separate from any internet-facing service
> (e.g. the public status page) — it holds your network map and SSH keys.

> Prefer to clone the full repo? `git clone … && cd boltarr && docker compose up -d`.

### With bundled Ollama (local AI)

```bash
docker compose -f docker-compose.ollama.yml up -d

# Pull a model after startup
docker exec boltarr-ollama-1 ollama pull llama3.2
```

Then open **⚙ AI Settings** in the app and set the model to `llama3.2`.

## AI configuration

AI is optional. Configure it from the **⚙ AI Settings** button in the sidebar, or via environment variables.

### Supported providers

| Provider | Notes |
|----------|-------|
| **Ollama** | Local/self-hosted. Set Base URL to your Ollama instance (e.g. `http://192.168.1.10:11434`) |
| **OpenAI-compatible** | OpenAI, LM Studio, Groq, Together AI, Mistral, LocalAI, etc. Set Base URL + API key |
| **Anthropic** | Claude API. Set API key only |

### Environment variable configuration (Docker)

```yaml
# in docker-compose.yml environment section:
LLM_PROVIDER: ollama          # none | ollama | openai | anthropic
LLM_BASE_URL: http://my-ollama:11434
LLM_MODEL: llama3.2
LLM_API_KEY: ""               # only for openai / anthropic
LLM_TIMEOUT: 120
LLM_LONG_TIMEOUT: 600
```

Env vars override the UI settings when set.

### AI chat behind a reverse proxy

If you access Boltarr through a reverse proxy (Nginx Proxy Manager, Caddy, Traefik, etc.) and see errors in the AI chat — especially with larger models — the proxy is likely timing out before the model responds. Increase the proxy timeout for `/api/chat` to at least 120–300 seconds.

**Nginx Proxy Manager:** add `proxy_read_timeout 300;` and `proxy_send_timeout 300;` as custom Nginx config for the proxy host.

**Caddy:** add `timeouts { read 5m }` to the reverse_proxy block.

### Config file

Copy `data/config.yaml.example` to `data/config.yaml` and edit:

```yaml
llm:
  provider: openai
  base_url: https://api.openai.com/v1
  api_key: sk-...
  model: gpt-4o
```

## Proxmox / LXC

Running Docker inside an **unprivileged LXC**? Use the standard `docker-compose.yml`
and **uncomment the AppArmor toggle** in it:

```yaml
security_opt:
  - apparmor=unconfined
```

Without it you'll hit `docker-default profile could not be loaded` — unprivileged
LXC containers can't load AppArmor profiles into the host kernel. Uncommenting it
is safe: Proxmox applies its own AppArmor profile to the entire LXC, and
user-namespace mapping ensures root inside the container has no privileges on the
Proxmox host. (Keep `network_mode: host` for LAN scanning.)

### LXC pre-requisites (Proxmox UI → your LXC → Options)

- Enable **Nesting** (`nesting=1`)
- Enable **keyctl** (`keyctl=1`)

**Note:** Ubuntu LXC templates often ship without `curl`. If the Docker install script fails immediately, run `apt install -y curl` first.

## Unraid

Install via **Community Applications** (search `boltarr`) once the template is listed, or add it manually:

1. In Unraid, go to **Docker → Add Container → Template URL**
2. Paste:
   ```
   https://raw.githubusercontent.com/brq-ae/boltarr/master/templates/unraid.xml
   ```
3. Set your data path (default: `/mnt/user/appdata/boltarr`) and optionally fill in AI settings
4. Click **Apply**

The template sets **Network Type: Host** (and adds `--cap-add=NET_RAW --cap-add=NET_ADMIN`) so nmap can scan your LAN — leave that as-is. Data persists in the mapped appdata folder. AI is optional — configure it from the ⚙ AI Settings button in the app.

## Manual install (without Docker)

Requires Python 3.11+ and nmap.

```bash
# Install nmap
sudo apt install nmap       # Debian/Ubuntu
brew install nmap           # macOS

# Run
bash run.sh
```

App starts at **http://localhost:12100**

## Data

All data is stored in `data/`:
- `boltarr.db` — SQLite database (hosts, ports, connections, VLANs, scan history)
- `config.yaml` — AI settings (auto-created by the UI, or copy from `config.yaml.example`)

Mount `./data` as a Docker volume to persist data across container restarts (done automatically in the provided compose files).

## Updating

```bash
git pull
docker compose up -d --build
```

## License

Apache 2.0

---

> This project was built with the assistance of AI tools.
