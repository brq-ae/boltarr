# Boltarr

A self-hosted network dashboard for mapping, monitoring, and analyzing your local network. Scan subnets, visualize topology, track devices, manage VLANs, and chat with an AI assistant that knows your network.

## Features

- **Topology view** — interactive Cytoscape.js graph with drag-and-drop layout, VLAN coloring, connection types (wired/wifi/fiber/DAC/virtual)
- **Network scanning** — nmap-powered host and port discovery
- **Device management** — add/edit/delete hosts, merge multi-homed devices, annotate with notes
- **Services registry** — track running services per host with status and URLs
- **VLAN management** — define VLANs, assign them to connections, visualize on topology
- **AI analysis** — per-host and network-wide analysis; AI chat assistant with full network context
- **AI optional** — works without AI; supports Ollama, OpenAI-compatible APIs, and Anthropic

## Quick start (Docker)

```bash
git clone https://github.com/your-username/boltarr.git
cd boltarr
docker compose up -d
```

Open **http://localhost:8000**

### With bundled Ollama (local AI)

```bash
docker compose -f docker-compose.ollama.yml up -d

# Pull a model after startup
docker exec netmap-ollama-1 ollama pull llama3.2
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

### Config file

Copy `data/config.yaml.example` to `data/config.yaml` and edit:

```yaml
llm:
  provider: openai
  base_url: https://api.openai.com/v1
  api_key: sk-...
  model: gpt-4o
```

## Manual install (without Docker)

Requires Python 3.11+ and nmap.

```bash
# Install nmap
sudo apt install nmap       # Debian/Ubuntu
brew install nmap           # macOS

# Run
bash run.sh
```

App starts at **http://localhost:8000**

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
