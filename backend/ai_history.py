"""AI history (v0.25.0, AI Tier 3 part 3): saved AI results and their clean-up.

Five kinds of result are kept, each grouped into "items":
  - host Analyze        llm_analyses, host_id = the host        (one item per host)
  - Analyze Network     llm_analyses, host_id IS NULL           (one item)
  - outage Explain      ai_explanations                         (one item per outage)
  - digest AI summary   ai_digests                              (one item)
  - AI actions record   ai_action_log                           (one item per host/service/subnet)

Settings → AI → AI history: `enabled` off means nothing new is saved and saved
results are hidden (not deleted). `keep_per_item` keeps the newest N per item and
`keep_days` (0 = no limit) deletes anything older — both apply to every result,
the newest included, whether saving is on or off. "Clean history" deletes it all.
"""
import json

from .config import get_ai_history_config
from .database import get_conn

TABLES = ("llm_analyses", "ai_explanations", "ai_digests", "ai_action_log")

# How each table's rows are grouped into items, for "keep the newest N per item"
_ITEM_KEY = {
    "llm_analyses":    "COALESCE(host_id, -1)",
    "ai_explanations": "kind, target_id, outage_start",
    "ai_digests":      "1",
    "ai_action_log":   "item",
}


def settings() -> dict:
    c = get_ai_history_config()
    return {"enabled": bool(c.get("enabled", True)),
            "keep_per_item": max(1, int(c.get("keep_per_item") or 10)),
            "keep_days": max(0, int(c.get("keep_days") or 0))}


def enabled() -> bool:
    return settings()["enabled"]


def prune(conn=None) -> int:
    """Apply the count and age rules to every saved result. Returns rows deleted."""
    s = settings()
    def run(c):
        n = 0
        for t in TABLES:
            if s["keep_days"]:
                n += c.execute(f"DELETE FROM {t} WHERE created_at < datetime('now', ?)",
                               (f"-{s['keep_days']} days",)).rowcount
            n += c.execute(f"""DELETE FROM {t} WHERE id IN (
                SELECT id FROM (SELECT id, ROW_NUMBER() OVER (
                    PARTITION BY {_ITEM_KEY[t]} ORDER BY id DESC) AS rn FROM {t})
                WHERE rn > ?)""", (s["keep_per_item"],)).rowcount
        c.commit()
        return n
    if conn is not None:
        return run(conn)
    with get_conn() as c:
        return run(c)


def count() -> int:
    with get_conn() as c:
        return sum(c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in TABLES)


def clean() -> int:
    """Clean history: delete every saved AI result. Returns how many."""
    with get_conn() as c:
        n = sum(c.execute(f"DELETE FROM {t}").rowcount for t in TABLES)
        c.commit()
    return n


# ── Analyze (host + network) ─────────────────────────────────────────────────

def save_analysis(host_id: int | None, model: str, text: str) -> int | None:
    """Save a host (host_id) or network (None) analysis, if saving is on."""
    if not enabled():
        return None
    with get_conn() as c:
        rid = c.execute("INSERT INTO llm_analyses (host_id, model, analysis) VALUES (?,?,?)",
                        (host_id, model, text)).lastrowid
        prune(c)
    return rid


def analyses(host_id: int | None) -> list[dict]:
    """Saved analyses for a host (or the network when None), newest first."""
    if not enabled():
        return []
    with get_conn() as c:
        where = "host_id=?" if host_id is not None else "host_id IS NULL"
        return [dict(r) for r in c.execute(
            f"SELECT * FROM llm_analyses WHERE {where} ORDER BY id DESC",
            (host_id,) if host_id is not None else ())]


# ── Digest summaries ─────────────────────────────────────────────────────────

def save_digest(title: str, body: str, summary: str, model: str) -> None:
    if not enabled():
        return
    with get_conn() as c:
        c.execute("INSERT INTO ai_digests (title, body, summary, model) VALUES (?,?,?,?)",
                  (title, body, summary, model))
        prune(c)


def digests() -> list[dict]:
    if not enabled():
        return []
    with get_conn() as c:
        return [dict(r) for r in c.execute("SELECT * FROM ai_digests ORDER BY id DESC")]


# ── AI actions record ────────────────────────────────────────────────────────

ASKED_MAX = 300


def save_action(item: str, action: str, title: str, detail, result: str,
                message: str = "", model: str = "", asked: str = "") -> None:
    """Record a Do it (result done/failed) or Cancel on a chat action card."""
    if not enabled():
        return
    asked = (asked or "").strip()
    if len(asked) > ASKED_MAX:
        asked = asked[:ASKED_MAX - 1] + "…"
    with get_conn() as c:
        c.execute("INSERT INTO ai_action_log (item, action, title, detail, result, message, model, asked) "
                  "VALUES (?,?,?,?,?,?,?,?)",
                  (item or "other", action, title, json.dumps(detail or []), result, message, model, asked))
        prune(c)


def actions() -> list[dict]:
    """The AI actions record, newest first."""
    if not enabled():
        return []
    with get_conn() as c:
        rows = [dict(r) for r in c.execute("SELECT * FROM ai_action_log ORDER BY id DESC")]
    for r in rows:
        try:
            r["detail"] = json.loads(r["detail"] or "[]")
        except ValueError:
            r["detail"] = []
    return rows
