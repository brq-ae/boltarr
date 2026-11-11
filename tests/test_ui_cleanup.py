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
        assert 'src="/js/peek.js?v=' in anon.get("/login.html").text
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
    assert page.index("/js/app/boot.js") < page.index("/js/search.js")   # uses hostMatches/svcMatches
    assert client.get("/js/search.js").status_code == 200


def test_column_fit_script_loaded(client):
    page = client.get("/").text
    assert page.index("/js/app/boot.js") < page.index("/js/fitcols.js")
    assert client.get("/js/fitcols.js").status_code == 200
    assert 'class="col-svc-name"' in page          # Services' flexible column


APP_FILES = ["core", "hosts", "host-detail", "scans", "services", "services-detail",
             "topology", "settings", "ssh", "boot"]


def test_app_split_files_load_in_order(client):
    """app.js was split into js/app/*.js (F-08). The files share globals, so the
    order matters: core first, boot last (its DOMContentLoaded starts the app)."""
    page = client.get("/").text
    assert "/js/app.js" not in page
    pos = [page.index(f'<script src="/js/app/{f}.js?v=') for f in APP_FILES]
    assert pos == sorted(pos)
    assert page.index("/js/peek.js") < pos[0] and pos[-1] < page.index("/js/fitcols.js")
    for f in APP_FILES:
        assert client.get(f"/js/app/{f}.js").status_code == 200, f


def test_assets_fingerprinted_and_cached(client):
    """Pages link scripts/styles as file?v=<content hash>; those URLs may be kept
    by the browser for good, the pages themselves are always re-checked."""
    import re
    r = client.get("/")
    assert r.headers["cache-control"] == "no-cache"
    links = re.findall(r'(?:src|href)="(/(?:js|css|vendor)/[^"]+)"', r.text)
    assert links and all(re.search(r"\?v=[0-9a-f]{10}$", u) for u in links), links
    core = next(u for u in links if "/js/app/core.js" in u)
    a = client.get(core)
    assert a.status_code == 200 and "immutable" in a.headers["cache-control"]
    assert client.get("/js/app/core.js").headers["cache-control"] == "no-cache"   # without ?v=
    assert client.get("/index.html").text == r.text
    assert client.get("/", headers={"If-None-Match": r.headers["etag"]}).status_code == 304   # unchanged page: tiny reply
    assert client.get("/api/version").headers.get("cache-control") != "public, max-age=31536000, immutable"


def test_no_inline_handlers_in_converted_areas():
    """F-08 part B: converted areas use data-click/-change/-input, not on…= (CSP step)."""
    import pathlib
    import re
    fe = pathlib.Path(__file__).resolve().parent.parent / "frontend"
    html = (fe / "index.html").read_text()
    for start, end in [('id="factoryResetModal"', 'class="topbar"'),
                       ('id="panel-sshkeys"', 'id="panel-search"'),
                       ('id="settingsModal"', 'id="svcDetailPanel"')]:
        a = html.index(start)
        part = html[a:html.index(end, a)]
        assert not re.findall(r"\son[a-z]+=", part), start
    for f in ["settings", "ssh"]:
        assert not re.findall(r"\son[a-z]+=", (fe / "js" / "app" / f"{f}.js").read_text()), f
    # every action named in the page is registered by some app file
    js = "".join((fe / "js" / "app" / f"{f}.js").read_text() for f in APP_FILES)
    reg = "".join(re.findall(r"registerActions\(\{(.*?)\}\);", js, re.S))
    for name in set(re.findall(r'data-(?:click|change|input)="([A-Za-z]+)"', html + js)):
        assert re.search(rf"\b{name}\b", reg), name
