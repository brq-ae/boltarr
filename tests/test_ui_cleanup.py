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


APP_FILES = ["core", "levels", "hosts", "host-detail", "scans", "services", "services-detail", "maintenance",
             "explain", "ai-actions", "topology", "subnets", "settings", "ssh", "welcome", "boot"]


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


def test_no_inline_code_anywhere():
    """F-08 part B (done in v0.23.5): strict mode blocks inline code, so no page or
    script may use on…= handlers, inline <script> blocks or javascript: links."""
    import pathlib
    import re
    fe = pathlib.Path(__file__).resolve().parent.parent / "frontend"
    html = (fe / "index.html").read_text()
    files = [*fe.glob("*.html"), *(fe / "js").glob("*.js"), *(fe / "js" / "app").glob("*.js")]
    for f in files:
        text = f.read_text()
        assert not re.findall(r"\son[a-z]+\s*=\s*[\"'`$]", text), f.name
        assert "javascript:" not in text.replace("javascript:/data:", ""), f.name
        if f.suffix == ".html":
            assert not re.findall(r"<script(?![^>]*\bsrc=)[^>]*>", text), f.name
    # every action named in the page is registered by some app file
    registered = _registered_actions(fe)
    for name in set(re.findall(r'data-(?:click|change|input)="([A-Za-z_$][\w$]*)"', html + "".join(
            (fe / "js" / "app" / f"{f}.js").read_text() for f in APP_FILES))):
        assert name in registered, name


# Scripts index.html loads before and with the app files, in order (F-39)
_PAGE_JS = ["graph", "markdown", "export", "chat", "peek"]


def _top_level_entries(body):
    """Split the inside of an object literal at its top-level commas."""
    parts, depth, cur, quote = [], 0, "", None
    for ch in body:
        if quote:
            quote = None if ch == quote else quote
        elif ch in "\"'`":
            quote = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
            continue
        cur += ch
    parts.append(cur)
    return [p.strip() for p in parts if p.strip()]


def _registered_actions(fe):
    """{name: file} for every registerActions({...}) entry. A shorthand entry
    (`saveHost,`) must name a function defined in that file or one loaded before
    it, or the page breaks at load (F-39: the old check only looked for the word)."""
    import re
    order = [fe / "js" / f"{f}.js" for f in _PAGE_JS] + [fe / "js" / "app" / f"{f}.js" for f in APP_FILES]
    defined, names = set(), {}
    for path in order:
        text = path.read_text()
        defined |= set(re.findall(r"(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(", text))
        defined |= set(re.findall(r"(?:^|\n)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=", text))
        for m in re.finditer(r"registerActions\(\{", text):
            i, depth = m.end(), 1
            while depth:
                depth += {"{": 1, "}": -1}.get(text[i], 0)
                i += 1
            body = re.sub(r"//[^\n]*", "", text[m.end():i - 1])
            for entry in _top_level_entries(body):
                key = re.match(r"([A-Za-z_$][\w$]*)\s*(:)?", entry)
                assert key, (path.name, entry)
                if not key.group(2):
                    assert key.group(1) in defined, f"{path.name}: {key.group(1)} isn't defined in it or before it"
                names[key.group(1)] = path.name
        # registerActions(Object.fromEntries(["a", "b"].map(...))): looked up on window when clicked
        for m in re.finditer(r"registerActions\(Object\.fromEntries\(\[(.*?)\]", text, re.S):
            for n in re.findall(r"[\"']([A-Za-z_$][\w$]*)[\"']", m.group(1)):
                assert n in defined, f"{path.name}: {n} isn't defined in it or before it"
                names[n] = path.name
    return names


def test_registered_actions_are_real_functions():
    """F-39: every registered action resolves, and the page's buttons all have one."""
    import pathlib
    fe = pathlib.Path(__file__).resolve().parent.parent / "frontend"
    reg = _registered_actions(fe)
    assert len(reg) > 100                                   # the parser really found them
    assert {"saveSubnet", "deleteHost", "aiActionDo", "printPage"} <= set(reg)


def test_every_element_id_is_unique():
    """F-26: two elements shared id="svcDeleteBtn", so the Edit Service dialog's
    Delete button never showed. Every id in each page must be used once."""
    import collections
    import re
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    for page in [*(root / "frontend").glob("*.html"), root / "statuspage" / "index.html"]:
        ids = re.findall(r'\bid="([^"]+)"', page.read_text(encoding="utf-8"))
        dup = sorted(k for k, n in collections.Counter(ids).items() if n > 1)
        assert not dup, f"{page.name}: ids used more than once: {dup}"


def test_service_dialog_and_toolbar_delete_buttons_are_separate():
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent / "frontend"
    html = (root / "index.html").read_text(encoding="utf-8")
    js = (root / "js" / "app" / "services.js").read_text(encoding="utf-8")
    assert 'id="svcModalDeleteBtn" data-click="deleteServiceFromModal"' in html
    assert 'id="svcDeleteBtn"' in html and 'data-click="svcDeleteSelected"' in html
    assert js.count('getElementById("svcModalDeleteBtn")') == 2      # shown on Edit, hidden on Add
