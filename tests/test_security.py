"""F-08 (part A): security headers, allowed dashboards, strict-mode reports."""
import json

import pytest

from backend import config, security


def _csp(r):
    return r.headers["content-security-policy"]


def test_headers_on_pages_and_api(client):
    for path in ("/", "/api/version", "/login.html"):
        r = client.get(path)
        csp = _csp(r)
        assert "script-src 'self' 'unsafe-inline'" in csp and "connect-src 'self'" in csp
        assert "object-src 'none'" in csp and "frame-ancestors 'self'" in csp
        assert "report-uri /api/csp-report" in csp and "report-to" not in csp   # report-to is HTTPS-only
        assert r.headers["content-security-policy-report-only"].startswith("script-src 'self' 'report-sample'")
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["referrer-policy"] == "same-origin"
        assert r.headers["x-frame-options"] == "SAMEORIGIN"


def test_no_outside_scripts_or_fonts_needed(client):
    page = client.get("/").text + client.get("/login.html").text + client.get("/css/style.css").text
    assert "cdnjs" not in page and "googleapis" not in page
    assert client.get("/vendor/cytoscape.min.js").status_code == 200
    assert client.get("/vendor/fonts/fonts.css").status_code == 200
    assert client.get("/vendor/fonts/inter-latin.woff2").status_code == 200


def test_allowed_dashboards_saved_and_sent(client):
    r = client.put("/api/settings/all", json={"security": {"frame_origins": "https://homarr.example/, http://10.0.0.5:7575"}})
    assert r.status_code == 200
    assert r.json()["security"]["frame_origins"] == "https://homarr.example, http://10.0.0.5:7575"
    r = client.get("/")
    assert "frame-ancestors 'self' https://homarr.example http://10.0.0.5:7575" in _csp(r)
    assert "x-frame-options" not in r.headers
    client.put("/api/settings/all", json={"security": {"frame_origins": ""}})
    assert client.get("/").headers["x-frame-options"] == "SAMEORIGIN"


@pytest.mark.parametrize("bad", ["homarr.example", "https://homarr.example/path", "javascript:x",
                                 "https://a.example; script-src *", "ftp://x.example"])
def test_bad_dashboard_address_saves_nothing(client, bad):
    before = config.get_config()
    r = client.put("/api/settings/all", json={"security": {"frame_origins": bad},
                                              "ip_history": {"stale_days": 3, "gone_days": 9}})
    assert r.status_code == 422 and "Allowed dashboards" in r.json()["detail"]
    assert config.get_config() == before


def test_reports_both_formats_deduped(client):
    client.delete("/api/security/reports")
    old = {"csp-report": {"effective-directive": "script-src-attr", "disposition": "report",
                          "blocked-uri": "inline", "source-file": "http://t/index.html?token=abc",
                          "line-number": 42, "script-sample": "saveSettings()"}}
    for _ in range(3):
        assert client.post("/api/csp-report", content=json.dumps(old),
                           headers={"Content-Type": "application/csp-report"}).status_code == 204
    new = [{"type": "csp-violation", "body": {"effectiveDirective": "connect-src", "disposition": "enforce",
                                              "blockedURL": "https://evil.example/x?d=1", "sourceFile": "http://t/js/app.js",
                                              "lineNumber": 7, "sample": ""}}]
    client.post("/api/csp-report", content=json.dumps(new), headers={"Content-Type": "application/reports+json"})
    rows = client.get("/api/security/reports").json()
    assert len(rows) == 2
    assert rows[0]["mode"] == "enforced" and rows[0]["blocked"] == "https://evil.example/x"   # query dropped
    strict = rows[1]
    assert strict["mode"] == "strict-check" and strict["count"] == 3 and strict["sample"] == "saveSettings()"
    assert "token" not in strict["source"]


def test_reports_junk_and_cap(client, monkeypatch):
    client.delete("/api/security/reports")
    for body in (b"not json", b"{}", b"[1,2]", b"x" * 20000):
        assert client.post("/api/csp-report", content=body).status_code == 204
    assert client.get("/api/security/reports").json() == []
    monkeypatch.setattr(security, "_MAX_ROWS", 5)
    for i in range(12):
        client.post("/api/csp-report", content=json.dumps(
            {"csp-report": {"effective-directive": "script-src-attr", "disposition": "report", "line-number": i}}))
    assert len(client.get("/api/security/reports").json()) == 5
    client.delete("/api/security/reports")


def test_report_endpoint_works_with_login_on(client):
    from backend import auth
    auth.set_password("admin", "correct-horse-1")
    try:
        from fastapi.testclient import TestClient
        from backend.main import app
        anon = TestClient(app)
        r = anon.post("/api/csp-report", content=json.dumps(
            {"csp-report": {"effective-directive": "script-src-attr", "disposition": "report"}}))
        assert r.status_code == 204                                   # no login, no X-Boltarr needed
        assert anon.get("/api/security/reports").status_code == 401   # but reading them needs login
        assert anon.get("/vendor/fonts/fonts.css").status_code == 200  # login page needs the fonts
        assert "content-security-policy" in anon.get("/").headers     # redirects carry headers too
    finally:
        auth.clear_password()
        client.delete("/api/security/reports")
