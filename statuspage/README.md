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

The app listens on port **12102** (change the host port in
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
curl http://localhost:12102/healthz          # -> ok
# push a sample payload (use your token):
curl -X POST http://localhost:12102/push \
  -H "Authorization: Bearer <your STATUS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"updated_at":"2025-01-01T00:00:00Z","title":"Service Status","services":[{"key":"a","name":"Example","status":"up","uptime_24h":99.9,"ticks":["up","up","down","up"]}],"announcements":[]}'
```

Open `http://<this-host>:12102/` — you should see the sample service.

## Connect Boltarr to it

In Boltarr → **Settings → Public status page**:

- **Enabled:** on
- **Status app URL:** `http://<this-host-LAN-IP>:12102`
- **Token:** the same `STATUS_TOKEN` you set in `.env`

Then mark items to be sent to the status page in Boltarr. Boltarr pushes on
change plus a ~60-second heartbeat.

## Private sections & admin login

The page has three sections — **Services**, **Hosts**, **Networking** — and each
is either **Public** (anyone sees it) or **Private** (only you, logged in). You
control this from the **admin panel** on the page itself, including one-click
**Make all Public / Make all Private**. Defaults: Services public, Hosts and
Networking private.

Private data is still pushed here, but a **private section never appears in an
anonymous response** — the server only includes it once you hold a valid admin
session. So you can expose the page to the internet, keep hosts/networking
private, and still check them yourself from anywhere by logging in (no VPN).

To enable admin login, set **`STATUS_ADMIN_PASSWORD`** in `.env`. Leave it blank
to disable login entirely (the page then serves public sections only — fail
closed). Log in via the **Login** button; the session is a signed, HttpOnly,
`Secure` cookie (~30 days).

## Expose it publicly (reverse proxy)

Point a subdomain (e.g. `status.example.com`) at this host's `IP:12102` through
your reverse proxy, with HTTPS.

> **⚠️ Block the push path.** A reverse proxy forwards *all* paths by default, so
> `status.example.com/push` would let anyone on the internet post fake statuses.
> Deny `/push` at the proxy. In Nginx / Nginx Proxy Manager (Advanced tab):
>
> ```nginx
> location /push { deny all; }
> ```
>
> Boltarr's push goes directly to `IP:12102` over the LAN and bypasses the proxy,
> so it keeps working.

## Hardening for internet exposure

Because it guards your Hosts/Networking data from the open web, the login is
security-critical. What the app does for you, and what you must do:

**Built in:**
- Private sections are never sent to an anonymous client (gated server-side).
- Login is rate-limited (8 failures → 15-minute lockout, per IP) with a constant
  throttle, and passwords are compared in constant time.
- Session cookie is signed (HMAC), `HttpOnly`, `Secure`, `SameSite=Lax`;
  state-changing admin calls require a CSRF token.
- Strict security headers on every response: a locked-down `Content-Security-Policy`
  (no inline JS/CSS, no framing), `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy`, and HSTS (over HTTPS).
  API docs are disabled.

**You must:**
- **Serve over HTTPS** (terminate TLS at your reverse proxy) and keep
  `STATUS_COOKIE_SECURE=true` — otherwise the session cookie won't stick.
- Set a **long, unique `STATUS_ADMIN_PASSWORD`** (and, optionally, a fixed
  `STATUS_SESSION_SECRET`).
- **Block `/push`** at the proxy (above) so the internet can't post fake statuses.
- If you run behind a proxy, either set `TRUST_PROXY=true` **only** when the proxy
  sets a trustworthy `X-Forwarded-For`, or add rate limiting at the proxy too.

See `.env.example` for every setting.

## Endpoints

| Method | Path              | Access            | Purpose                              |
|--------|-------------------|-------------------|--------------------------------------|
| POST   | `/push`           | token (LAN)       | Boltarr pushes the status payload    |
| GET    | `/data`           | public / admin    | Payload as JSON — public sections for anyone, all sections when logged in |
| POST   | `/login`          | rate-limited      | Start an admin session (sets cookie) |
| POST   | `/logout`         | —                 | Clear the admin session              |
| POST   | `/api/visibility` | admin + CSRF      | Set section Public/Private           |
| GET    | `/`               | public            | The status page                      |
| GET    | `/healthz`        | public            | Health check                         |

## Data contract

Boltarr sends, and the page renders:

```json
{
  "updated_at": "2025-01-01T00:00:00Z",
  "title": "Service Status",
  "services":   [ { "name": "Photos", "status": "up", "uptime_24h": 99.8, "ticks": ["up","up","down","up"] } ],
  "hosts":      [ { "name": "Home Server", "status": "up", "uptime_24h": 100, "ticks": ["up"] } ],
  "networking": [ { "name": "Main Switch", "status": "up", "uptime_24h": 100, "ticks": ["up"] } ],
  "announcements": []
}
```

`status` is `"up" | "down" | "unknown"`; `ticks` is ~60 entries (last hour,
oldest→newest). Boltarr sends all three section arrays; **which are shown to the
public is decided here, per section, in the admin panel** — not by Boltarr. The
latest payload persists to `data/state.json`, and admin settings to
`data/statuspage.db`, so both survive restarts.
