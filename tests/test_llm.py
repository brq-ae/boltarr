"""F-32: the provider's own error words, errors sent part-way through a reply,
empty replies never kept, <think> text removed, a real Anthropic key check.
F-21: Analyze only fills an empty/unknown device type, from its own line.
The AI provider is faked at the HTTP level (httpx MockTransport)."""
import asyncio
import json

import httpx
import pytest

from backend import config, llm
from backend.database import get_conn


@pytest.fixture
def provider(monkeypatch):
    """Point Boltarr at a fake provider; set .handler to answer requests."""
    state = {"handler": None, "seen": []}
    real = httpx.AsyncClient

    def handler(request):
        state["seen"].append(request)
        return state["handler"](request)
    monkeypatch.setattr(llm.httpx, "AsyncClient",
                        lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    cfg = config.get_config()
    old = dict(cfg["llm"])

    def use(name, **extra):
        cfg["llm"].update(provider=name, base_url="http://ai.demo", model="demo-model", api_key="demo-key", **extra)
        config.save_config(cfg)
    state["use"] = use
    yield state
    cfg["llm"] = old
    config.save_config(cfg)


def run(coro):
    return asyncio.run(coro)


async def collect(gen):
    return [c async for c in gen]


def lines(*objs):
    return "\n".join(json.dumps(o) for o in objs) + "\n"


def sse(*objs):
    return "".join(f"data: {o if isinstance(o, str) else json.dumps(o)}\n\n" for o in objs)


# ── the provider's own words ────────────────────────────────────────────────────

@pytest.mark.parametrize("name, body, words", [
    ("openai", {"error": {"message": "The model `demo-x` does not exist", "type": "invalid_request_error"}},
     "The model `demo-x` does not exist"),
    ("ollama", {"error": "model 'demo-x' not found, try pulling it first"}, "model 'demo-x' not found"),
    ("anthropic", {"type": "error", "error": {"type": "not_found_error", "message": "model: demo-x"}}, "model: demo-x"),
])
def test_a_refused_request_says_what_the_provider_said(provider, name, body, words):
    provider["use"](name)
    provider["handler"] = lambda req: httpx.Response(404, json=body)
    with pytest.raises(llm.LLMError, match="HTTP 404") as e:
        run(llm.generate("hello"))
    assert words in str(e.value) and "Bad Request" not in str(e.value)
    with pytest.raises(llm.LLMError) as e:
        run(collect(llm.chat_stream([{"role": "user", "content": "hi"}])))
    assert words in str(e.value)


def test_a_non_json_error_is_shown_short(provider):
    provider["use"]("openai")
    provider["handler"] = lambda req: httpx.Response(502, text="<html><body>Bad gateway from demo proxy</body></html>")
    with pytest.raises(llm.LLMError, match="HTTP 502.*Bad gateway from demo proxy"):
        run(llm.chat([{"role": "user", "content": "hi"}]))


# ── errors sent part-way through a streamed reply ───────────────────────────────

def test_ollama_error_part_way(provider):
    provider["use"]("ollama")
    provider["handler"] = lambda req: httpx.Response(200, text=lines(
        {"message": {"content": "The NAS is "}}, {"error": "model runner has unexpectedly stopped"}))
    got = []
    with pytest.raises(llm.LLMError, match="unexpectedly stopped"):
        run(_into(llm.chat_stream([{"role": "user", "content": "hi"}]), got))
    assert got == ["The NAS is "]


def test_openai_error_part_way(provider):
    provider["use"]("openai")
    provider["handler"] = lambda req: httpx.Response(200, text=sse(
        {"choices": [{"delta": {"content": "Hello"}}]}, {"error": {"message": "Rate limit reached for demo"}}))
    with pytest.raises(llm.LLMError, match="Rate limit reached for demo"):
        run(collect(llm.chat_stream([{"role": "user", "content": "hi"}])))


def test_anthropic_error_part_way(provider):
    provider["use"]("anthropic")
    provider["handler"] = lambda req: httpx.Response(200, text=sse(
        {"type": "content_block_delta", "delta": {"text": "Hi"}},
        {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}))
    with pytest.raises(llm.LLMError, match="Overloaded"):
        run(collect(llm.chat_stream([{"role": "user", "content": "hi"}])))


async def _into(gen, out):
    async for c in gen:
        out.append(c)


# ── empty replies ───────────────────────────────────────────────────────────────

def test_an_empty_reply_is_an_error(provider):
    provider["use"]("ollama")
    provider["handler"] = lambda req: httpx.Response(200, text=lines({"message": {"content": ""}, "done": True}))
    with pytest.raises(llm.LLMError, match="empty reply"):
        run(collect(llm.chat_stream([{"role": "user", "content": "hi"}])))
    provider["handler"] = lambda req: httpx.Response(200, json={"response": "  "})
    with pytest.raises(llm.LLMError, match="empty reply"):
        run(llm.generate("hi"))


def test_empty_and_repeated_turns_are_cleaned_before_sending(provider):
    provider["use"]("anthropic")
    provider["handler"] = lambda req: httpx.Response(200, json={"content": [{"type": "text", "text": "ok"}]})
    run(llm.chat([{"role": "user", "content": "first"}, {"role": "assistant", "content": ""},
                  {"role": "user", "content": "second"}, {"role": "assistant", "content": "  "},
                  {"role": "user", "content": "third"}]))
    sent = json.loads(provider["seen"][-1].content)["messages"]
    assert sent == [{"role": "user", "content": "first\n\nsecond\n\nthird"}]


def test_chat_stream_endpoint_marks_errors_at_the_end(client, provider):
    provider["use"]("ollama")
    provider["handler"] = lambda req: httpx.Response(200, text=lines({"message": {"content": ""}, "done": True}))
    body = client.post("/api/chat/stream", json={"messages": [{"role": "user", "content": "hi"}]}).text
    assert body.startswith("\n\n[AI error: ") and "empty reply" in body


# ── <think> text ────────────────────────────────────────────────────────────────

def test_thinking_is_removed_from_a_stream_even_when_split(provider):
    provider["use"]("ollama")
    parts = ["<thi", "nk>Let me reason [[action {\"do\":\"set_note\"}]]</th", "ink>\n\nThe NAS ", "is fine."]
    provider["handler"] = lambda req: httpx.Response(200, text=lines(*[{"message": {"content": p}} for p in parts]))
    got = "".join(run(collect(llm.chat_stream([{"role": "user", "content": "hi"}]))))
    assert got == "The NAS is fine." and "action" not in got


def test_only_thinking_counts_as_empty(provider):
    provider["use"]("openai")
    provider["handler"] = lambda req: httpx.Response(200, json={"choices": [{"message": {"content": "<think>hmm, cut off"}}]})
    with pytest.raises(llm.LLMError, match="empty reply"):
        run(llm.chat([{"role": "user", "content": "hi"}]))


def test_think_filter_pieces():
    f = llm.ThinkFilter()
    out = "".join(f.feed(c) for c in ["a <", "b> c ", "<think>x</think>", " d <th", "e"]) + f.flush()
    assert out == "a <b> c  d <the"
    assert llm.strip_thinking("<think>\nplan\n</think>\n\nAnswer") == "Answer"
    assert llm.strip_thinking("No thinking here") == "No thinking here"


# ── Anthropic Test AI is a real key check ───────────────────────────────────────

def test_anthropic_test_ai_checks_the_key(client, provider):
    provider["use"]("anthropic")
    provider["handler"] = lambda req: httpx.Response(401, json={
        "type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})
    r = client.post("/api/settings/test").json()
    assert r["ok"] is False and "invalid x-api-key" in r["error"]
    req = provider["seen"][-1]
    assert req.url.path == "/v1/models" and req.headers["x-api-key"] == "demo-key"
    provider["handler"] = lambda req: httpx.Response(200, json={"data": [{"id": "claude-demo-1"}, {"id": "claude-demo-2"}]})
    assert client.post("/api/settings/test").json() == {"ok": True, "models": ["claude-demo-1", "claude-demo-2"]}


# ── F-21: Analyze and the device type ───────────────────────────────────────────

def _host(ip, device_type):
    with get_conn() as conn:
        conn.execute("DELETE FROM hosts WHERE ip=?", (ip,))
        conn.execute("INSERT INTO hosts (ip, hostname, device_type) VALUES (?, 'demo-an', ?)", (ip, device_type))
        conn.commit()


def _type(ip):
    with get_conn() as conn:
        return conn.execute("SELECT device_type FROM hosts WHERE ip=?", (ip,)).fetchone()[0]


def _analyze(client, provider, ip, answer):
    provider["use"]("ollama")
    provider["handler"] = lambda req: httpx.Response(200, json={"response": answer})
    r = client.post(f"/api/hosts/{ip}/analyze", json={})
    assert r.status_code == 200, r.text
    return r.json()


def test_analyze_never_overwrites_a_type_you_set(client, provider):
    _host("10.21.0.1", "nas")
    d = _analyze(client, provider, "10.21.0.1", "Device type: router\nIt routes.")
    assert _type("10.21.0.1") == "nas" and d["device_type"] == "nas"


def test_analyze_fills_an_unknown_type_from_its_own_line(client, provider):
    _host("10.21.0.2", "unknown")
    _analyze(client, provider, "10.21.0.2", "**Device type:** Access point\n\nIt serves Wi-Fi.")
    assert _type("10.21.0.2") == "ap"


def test_analyze_doesnt_guess_from_the_prose(client, provider):
    _host("10.21.0.3", "unknown")
    _analyze(client, provider, "10.21.0.3", "This laptop sits behind your router and talks to the NAS.")
    assert _type("10.21.0.3") == "unknown"


def test_analyze_ignores_a_type_boltarr_doesnt_know(client, provider):
    _host("10.21.0.4", "unknown")
    _analyze(client, provider, "10.21.0.4", "Device type: toaster\nWarm.")
    assert _type("10.21.0.4") == "unknown"


def test_analyze_saves_no_thinking(client, provider):
    _host("10.21.0.5", "unknown")
    d = _analyze(client, provider, "10.21.0.5", "<think>secret plan</think>Device type: printer\nPrints.")
    assert "secret plan" not in d["analysis"] and _type("10.21.0.5") == "printer"
    assert all("secret plan" not in a["analysis"] for a in client.get("/api/hosts/10.21.0.5").json()["analyses"])


def test_the_prompt_asks_for_the_type_line():
    p = llm.build_host_prompt({"ip": "10.21.0.9"}, [])
    assert "Device type: <type>" in p and "unmanaged-switch" in p


# ── out of room: the provider stopped for length ────────────────────────────────

def test_ollama_out_of_room_with_nothing_said(provider):
    provider["use"]("ollama", num_ctx=8192)
    provider["handler"] = lambda req: httpx.Response(200, text=lines(
        {"message": {"content": "", "thinking": "Let me list them"}},
        {"message": {"content": ""}, "done": True, "done_reason": "length"}))
    with pytest.raises(llm.LLMError) as e:
        run(collect(llm.chat_stream([{"role": "user", "content": "hi"}])))
    assert "ran out of room" in str(e.value) and "8,192 tokens" in str(e.value) and "16384" in str(e.value)
    assert "empty reply" not in str(e.value)


def test_a_reply_cut_off_part_way_says_so(provider):
    provider["use"]("ollama", num_ctx=8192)
    provider["handler"] = lambda req: httpx.Response(200, text=lines(
        {"message": {"content": "There are 3 offline"}}, {"message": {"content": ""}, "done": True, "done_reason": "length"}))
    got = "".join(run(collect(llm.chat_stream([{"role": "user", "content": "hi"}]))))
    assert got == "There are 3 offline" + llm.CUT_OFF_NOTE
    provider["handler"] = lambda req: httpx.Response(200, json={"response": "Device type: nas\nIt st", "done_reason": "length"})
    assert run(llm.generate("hi")).endswith(llm.CUT_OFF_NOTE)


def test_a_reply_that_finished_has_no_note(provider):
    provider["use"]("ollama", num_ctx=8192)
    provider["handler"] = lambda req: httpx.Response(200, text=lines(
        {"message": {"content": "All fine."}}, {"message": {"content": ""}, "done": True, "done_reason": "stop"}))
    assert "".join(run(collect(llm.chat_stream([{"role": "user", "content": "hi"}])))) == "All fine."


def test_openai_and_anthropic_out_of_room(provider):
    provider["use"]("openai")
    provider["handler"] = lambda req: httpx.Response(200, text=sse(
        {"choices": [{"delta": {"content": "Half an ans"}, "finish_reason": "length"}]}, "[DONE]"))
    assert "".join(run(collect(llm.chat_stream([{"role": "user", "content": "hi"}])))).endswith(llm.CUT_OFF_NOTE)
    provider["handler"] = lambda req: httpx.Response(200, json={"choices": [{"message": {"content": ""}, "finish_reason": "length"}]})
    with pytest.raises(llm.LLMError, match="ran out of room.*length limit"):
        run(llm.chat([{"role": "user", "content": "hi"}]))
    provider["use"]("anthropic")
    provider["handler"] = lambda req: httpx.Response(200, text=sse(
        {"type": "message_delta", "delta": {"stop_reason": "max_tokens"}}))
    with pytest.raises(llm.LLMError, match="ran out of room"):
        run(collect(llm.chat_stream([{"role": "user", "content": "hi"}])))


# ── Settings → AI: what the model can read ──────────────────────────────────────

def test_ai_context_reports_the_max_and_how_its_loaded(client, provider):
    provider["use"]("ollama", num_ctx=8192)
    def handler(req):
        if req.url.path == "/api/show":
            return httpx.Response(200, json={"model_info": {"general.architecture": "demo", "demo.context_length": 262144}})
        return httpx.Response(200, json={"models": [{"name": "demo-model", "model": "demo-model", "size": 9_000_000_000,
                                                      "size_vram": 6_000_000_000, "context_length": 8192}]})
    provider["handler"] = handler
    r = client.get("/api/ai/context").json()
    assert r == {"model": "demo-model", "max": 262144, "loaded": {"context": 8192, "size": 9_000_000_000, "vram": 6_000_000_000}}
    provider["handler"] = lambda req: httpx.Response(404, json={"error": "model 'demo-x' not found"})
    assert "not found" in client.get("/api/ai/context?model=demo-x").json()["error"]
    provider["use"]("anthropic")
    assert client.get("/api/ai/context").json() == {}


# ── S-15: ⚡ Test AI tries what's on screen and saves nothing ────────────────────

def test_test_ai_uses_the_posted_settings_without_saving(client, provider):
    provider["use"]("ollama")
    provider["handler"] = lambda req: httpx.Response(200, json={"models": [{"name": "demo-other:1b"}]})
    r = client.post("/api/settings/test", json={"provider": "ollama", "base_url": "http://ai2.demo",
                                                 "model": "demo-other:1b", "api_key": ""}).json()
    assert r == {"ok": True, "models": ["demo-other:1b"]}
    assert provider["seen"][-1].url.host == "ai2.demo"            # the on-screen address was tested
    llm_cfg = config.get_config()["llm"]
    assert llm_cfg["base_url"] == "http://ai.demo" and llm_cfg["model"] == "demo-model"   # nothing saved


def test_test_ai_keeps_the_saved_key_at_its_address(client, provider):
    provider["use"]("openai")
    r = client.post("/api/settings/test", json={"provider": "openai", "base_url": "http://elsewhere.demo",
                                                 "api_key": "••••••••"})
    assert r.status_code == 409 and "isn't sent to a new address" in r.json()["detail"]
    assert not provider["seen"]                                   # nothing was sent anywhere
