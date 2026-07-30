"""Boltarr public status page — a tiny receiver + server.

Boltarr (internal) pushes a sanitized status payload to POST /push over the
LAN, authenticated with a shared bearer token. Visitors get a read-only page
(GET /) that renders the latest payload from GET /data. Nothing internal ever
reaches this app — it only stores and shows what Boltarr sends.
"""
import json
import os
from pathlib import Path

from fastapi import FastAPI, Request, Header, HTTPException
from fastapi.responses import JSONResponse, HTMLResponse, PlainTextResponse

TOKEN = os.environ.get("STATUS_TOKEN", "")
STATE_FILE = Path(os.environ.get("STATE_FILE", "/data/state.json"))

app = FastAPI(title="Boltarr Status Page")


def _load() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"updated_at": None, "title": "Service Status", "services": [], "announcements": []}


STATE = _load()


@app.post("/push")
async def push(request: Request, authorization: str = Header(default="")):
    if not TOKEN or authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")
    global STATE
    try:
        STATE = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid json")
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(STATE))
    return {"ok": True}


@app.get("/data")
def data():
    return JSONResponse(STATE)


@app.get("/healthz", response_class=PlainTextResponse)
def healthz():
    return "ok"


@app.get("/", response_class=HTMLResponse)
def index():
    return Path("index.html").read_text(encoding="utf-8")
