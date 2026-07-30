# Boltarr Status Page

A tiny public status page for [Boltarr](../). Boltarr pushes a **sanitized**
summary of the services you mark "public" — public name, up/down, 24-hour
uptime, and a last-hour tick bar — to this app over your LAN. Visitors get a
clean read-only page. **No IPs, ports, or internal detail ever leave Boltarr.**

Run this **on a separate host from Boltarr** (e.g. a lightweight VM/LXC in your
DMZ or wherever your public sites live). Boltarr stays internal; only this app is
exposed to the internet.

```
Boltarr (internal)  --LAN push /push (token)-->  status app  --HTTPS-->  visitors
```

## Deploy (Docker)

The compose file pulls a prebuilt image (`brqae/boltarr-statuspage:latest`) —
no build step needed.

```bash
# from this folder
cp .env.example .env
# edit .env and set STATUS_TOKEN (see "Token" below)
docker compose up -d
```

> Prefer to build from source? Comment the `image:` line in
> `docker-compose.yml` and uncomment `build: .`, then run
> `docker compose up -d --build`.

The app listens on port **8080** (change the host port in
`docker-compose.yml` if that's taken).

### Token

`STATUS_TOKEN` is a shared secret — the same value goes in this app's `.env`
**and** in Boltarr (Settings → Public status page → Token). Generate one either
way:

- **In Boltarr:** Settings → Public status page → **Generate** — copy the value
  into `.env` here.
- **On the CLI:** `openssl rand -hex 32`

Test it:

```bash
curl http://localhost:8080/healthz          # -> ok
# push a sample payload (use your token):
curl -X POST http://localhost:8080/push \
  -H "Authorization: Bearer <your STATUS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"updated_at":"2025-01-01T00:00:00Z","title":"Service Status","services":[{"key":"a","name":"Example","status":"up","uptime_24h":99.9,"ticks":["up","up","down","up"]}],"announcements":[]}'
```

Open `http://<this-host>:8080/` — you should see the sample service.

## Connect Boltarr to it

In Boltarr → **Settings → Public status page**:

- **Enabled:** on
- **Status app URL:** `http://<this-host-LAN-IP>:8080`
- **Token:** the same `STATUS_TOKEN` you set in `.env`

Then mark services **public** in each service's detail panel. Boltarr pushes on
change plus a ~60-second heartbeat.

## Expose it publicly (reverse proxy)

Point a subdomain (e.g. `status.example.com`) at this host's `IP:8080` through
your reverse proxy, with HTTPS.

> **⚠️ Block the push path.** A reverse proxy forwards *all* paths by default, so
> `status.example.com/push` would let anyone on the internet post fake statuses.
> Deny `/push` at the proxy. In Nginx / Nginx Proxy Manager (Advanced tab):
>
> ```nginx
> location /push { deny all; }
> ```
>
> Boltarr's push goes directly to `IP:8080` over the LAN and bypasses the proxy,
> so it keeps working.

## Endpoints

| Method | Path       | Access        | Purpose                          |
|--------|------------|---------------|----------------------------------|
| POST   | `/push`    | token (LAN)   | Boltarr pushes the status payload |
| GET    | `/data`    | public        | Latest payload as JSON            |
| GET    | `/`        | public        | The status page                  |
| GET    | `/healthz` | public        | Health check                     |

## Data contract

Boltarr sends, and the page renders:

```json
{
  "updated_at": "2025-01-01T00:00:00Z",
  "title": "Service Status",
  "services": [
    { "key": "svc-7", "name": "Photos", "status": "up",
      "uptime_24h": 99.8, "ticks": ["up","up","down","up"] }
  ],
  "announcements": []
}
```

`status` is `"up" | "down" | "unknown"`; `ticks` is ~60 entries (last hour,
oldest→newest). The latest payload persists to `data/state.json` so it survives
restarts.
