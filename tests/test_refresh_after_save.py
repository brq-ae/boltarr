"""F-45: after a change that worked, the screen refresh goes through refreshAfterSave(),
so a failed refresh says "Done, but couldn't refresh" instead of "Error".

This test reads the app's own code: a try { } block that makes a change (POST/PUT/DELETE/PATCH)
and then reloads something (load…(), showHostDetail(), showSvcDetail()) outside refreshAfterSave,
while its catch shows an error, would bring the misleading "Error" back."""
import pathlib
import re

FE = pathlib.Path(__file__).resolve().parent.parent / "frontend"


def blank(src):
    """Same length as src, with comments, strings, templates and regexes blanked to spaces
    (newlines kept), so brace matching sees only code."""
    out, i, n = list(src), 0, len(src)
    stack = []            # template-literal ${ depth tracking
    def wipe(a, b):
        for k in range(a, b):
            if out[k] != "\n": out[k] = " "
    prev = ""             # last significant code char
    while i < n:
        c = src[i]
        if stack and c == "}" and stack[-1] == 0:
            stack.pop(); i += 1
            j = i
            while i < n and src[i] != "`":
                if src[i] == "\\": i += 2; continue
                if src[i] == "$" and i + 1 < n and src[i+1] == "{": break
                i += 1
            wipe(j, i)
            if i < n and src[i] == "$": stack.append(0); i += 2
            else: i += 1
            prev = "x"; continue
        if c in "{(" and stack: stack[-1] += 1
        if c in "})" and stack: stack[-1] -= 1
        if src.startswith("//", i):
            j = src.find("\n", i); j = n if j < 0 else j; wipe(i, j); i = j; continue
        if src.startswith("/*", i):
            j = src.find("*/", i) + 2; wipe(i, j); i = j; continue
        if c in "\"'":
            j = i + 1
            while src[j] != c:
                j += 2 if src[j] == "\\" else 1
            wipe(i + 1, j); i = j + 1; prev = "x"; continue
        if c == "`":
            j = i + 1
            while j < n and src[j] != "`":
                if src[j] == "\\": j += 2; continue
                if src[j] == "$" and src[j+1] == "{": break
                j += 1
            wipe(i + 1, j)
            if j < n and src[j] == "$": stack.append(0); i = j + 2
            else: i = j + 1
            prev = "x"; continue
        kw = re.search(r'\b(return|typeof|case|in|of|delete|void|throw)\s*$', src[max(0, i - 12):i])
        if c == "/" and (prev in "(,=:[!&|?{};+-*%<>~^" or prev == "" or kw):
            j, cls = i + 1, False
            while j < n and (src[j] != "/" or cls) and src[j] != "\n":
                if src[j] == "\\": j += 2; continue
                if src[j] == "[": cls = True
                elif src[j] == "]": cls = False
                j += 1
            wipe(i + 1, j); i = j + 1; prev = "x"; continue
        if not c.isspace(): prev = c
        i += 1
    return "".join(out)

def match(code, i, o, c):
    d = 0
    for k in range(i, len(code)):
        if code[k] == o: d += 1
        elif code[k] == c:
            d -= 1
            if d == 0: return k
    raise ValueError("unbalanced")

SAVE = re.compile(r'\bapi\(\s*["\'`](POST|PUT|DELETE|PATCH)')
REFRESH = re.compile(r'\b(load[A-Z]\w*|showHostDetail|showSvcDetail)\s*\(')
TELL = re.compile(r'\b(alert|showToast)\s*\(')

def without_helper(src, code, a, b):
    """src[a:b] with every refreshAfterSave(...) argument removed."""
    keep, k = [], a
    for m in re.finditer(r'\brefreshAfterSave\s*\(', code[a:b]):
        s = a + m.end() - 1
        if s < k: continue
        e = match(code, s, "(", ")")
        keep.append(src[k:s]); k = e + 1
    keep.append(src[k:b]); return "".join(keep)

def sites(path):
    src = pathlib.Path(path).read_text(encoding="utf-8")
    code = blank(src)
    for m in re.finditer(r'\btry\s*\{', code):
        o = m.end() - 1; e = match(code, o, "{", "}")
        cm = re.compile(r'\s*catch\s*(\([^)]*\))?\s*\{').match(code, e + 1)
        if not cm: continue
        co = cm.end() - 1; ce = match(code, co, "{", "}")
        body_src = src[o:e]; catch_src = src[co:ce]
        if not SAVE.search(body_src) or not TELL.search(catch_src): continue
        # only refresh calls AFTER the first save count
        first = o + SAVE.search(body_src).start()
        after = without_helper(src, code, first, e)
        r = REFRESH.search(after)
        if r:
            yield src[:o].count("\n") + 1, r.group(1)


def test_reloads_after_a_change_go_through_the_helper():
    found = [f"{p.relative_to(FE)}:{line} ({what})"
             for p in sorted([*FE.glob("js/app/*.js"), *FE.glob("js/*.js")])
             for line, what in sites(p)]
    assert not found, "reload after a change outside refreshAfterSave(): " + ", ".join(found)


def test_the_finder_still_finds_the_old_mistake(tmp_path):
    """The check above must still be able to see the problem it guards against."""
    bad = tmp_path / "bad.js"
    bad.write_text("""async function demo(ip) {
  // don't be fooled by quotes in comments, /regexes/ or `templates ${ip}`
  try {
    await api("DELETE", `/api/hosts/${ip}`);
    if (/x'y/.test(ip)) return;
    await loadHosts();
  } catch (e) { alert("Error: " + e.message); }
}
async function fine(ip) {
  try {
    await api("DELETE", `/api/hosts/${ip}`);
    await refreshAfterSave(async () => { await loadHosts(); });
  } catch (e) { alert("Error: " + e.message); }
}
""")
    assert [what for _, what in sites(bad)] == ["loadHosts"]


def test_helper_is_defined_in_core():
    core = (FE / "js/app/core.js").read_text()
    assert "async function refreshAfterSave(fn)" in core
    assert "Done, but couldn't refresh the page." in core
