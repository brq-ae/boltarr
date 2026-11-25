"""S-34: Boltarr asks with its own window (askConfirm / askText in core.js), never the
browser's confirm() or prompt(). Once a browser is told "don't allow this page to create
dialogs", every confirm() silently answers No, so deletes would stop working with no message."""
import pathlib
import re

from test_refresh_after_save import blank

JS = pathlib.Path(__file__).resolve().parent.parent / "frontend" / "js"
POPUP = re.compile(r'(?<![\w.$])(?:window\.)?(confirm|prompt)\s*\(')


def popups(path):
    code = blank(path.read_text(encoding="utf-8"))   # comments and strings don't count
    return [(path.name, code[:m.start()].count("\n") + 1, m.group(1)) for m in POPUP.finditer(code)]


def test_no_browser_confirm_or_prompt():
    found = [p for f in sorted(JS.glob("*.js")) + sorted(JS.glob("app/*.js")) for p in popups(f)]
    assert not found, f"use askConfirm/askText instead: {found}"


def test_the_finder_still_finds_one(tmp_path):
    f = tmp_path / "x.js"
    f.write_text('// confirm("no")\nconst s = "prompt(";\nif (!window.confirm("Delete?")) return;\nconst n = prompt("Name");\nobj.confirm(1);\n')
    assert [(line, what) for _, line, what in popups(f)] == [(3, "confirm"), (4, "prompt")]


def test_helpers_are_defined_in_core():
    core = (JS / "app" / "core.js").read_text(encoding="utf-8")
    assert "function askConfirm(" in core and "function askText(" in core
