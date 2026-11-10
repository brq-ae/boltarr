"""S-12: model pickers start on the Settings → AI default model."""
import backend.main as m
from backend import config


def _set_model(name):
    cfg = config.get_config()
    cfg["llm"]["model"] = name
    config.save_config(cfg)


def test_models_include_default(client, monkeypatch):
    async def fake():
        return ["a", "b:latest"]
    monkeypatch.setattr(m, "list_models", fake)
    _set_model("b:latest")
    assert client.get("/api/models").json() == {"models": ["a", "b:latest"], "default": "b:latest"}


def test_unlisted_default_is_offered_first(client, monkeypatch):
    async def fake():
        return ["a", "b"]
    monkeypatch.setattr(m, "list_models", fake)
    _set_model("typed-by-hand")
    assert client.get("/api/models").json() == {"models": ["typed-by-hand", "a", "b"], "default": "typed-by-hand"}


def test_no_models_no_default(client, monkeypatch):
    async def fake():
        return []
    monkeypatch.setattr(m, "list_models", fake)
    _set_model("x")
    assert client.get("/api/models").json() == {"models": [], "default": ""}
    _set_model("")


def test_password_eye_loads_before_login(client):
    from fastapi.testclient import TestClient
    from backend import auth
    from backend.main import app
    auth.set_password("admin", "correct-horse-1")
    try:
        anon = TestClient(app)
        assert anon.get("/js/peek.js").status_code == 200        # the login page needs it
        assert 'src="/js/peek.js"' in anon.get("/login.html").text
    finally:
        auth.clear_password()


def test_reply_formatter_loads_before_chat(client):
    page = client.get("/").text
    assert page.index("/js/markdown.js") < page.index("/js/chat.js")
    assert client.get("/js/markdown.js").status_code == 200


def test_export_loads_before_chat_and_has_buttons(client):
    page = client.get("/").text
    assert page.index("/js/export.js") < page.index("/js/chat.js")   # chat's Download uses downloadFile
    assert client.get("/js/export.js").status_code == 200
    for kind in ("hosts", "services", "iphistory"):
        assert f'data-export="{kind}" data-fmt="csv"' in page and f'data-export="{kind}" data-fmt="json"' in page


def test_global_search_box_and_script(client):
    page = client.get("/").text
    assert 'id="gsInput"' in page and 'id="gsResults"' in page
    assert page.index("/js/app.js") < page.index("/js/search.js")   # uses hostMatches/svcMatches
    assert client.get("/js/search.js").status_code == 200


def test_column_fit_script_loaded(client):
    page = client.get("/").text
    assert page.index("/js/app.js") < page.index("/js/fitcols.js")
    assert client.get("/js/fitcols.js").status_code == 200
    assert 'class="col-svc-name"' in page          # Services' flexible column
