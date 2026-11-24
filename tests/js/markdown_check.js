// R-05: formatter output + safety.  node markdown_check.js
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM } = require("jsdom");
const fs = require("fs");
const dom = new JSDOM(`<body></body>`, { runScripts: "outside-only" });
dom.window.eval(fs.readFileSync(`${BOLTARR}/frontend/js/markdown.js`, "utf8"));
const md = dom.window.renderMarkdown, d = dom.window.document;
let fail = 0;
const check = (ok, msg, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}${ok ? "" : "  → " + extra}`); if (!ok) fail++; };
const html = s => { const el = d.createElement("div"); el.innerHTML = md(s); return el; };

let h = md("**Bold** and *it* and `code` and __b2__");
check(h.includes("<strong>Bold</strong>") && h.includes("<em>it</em>") && h.includes("<code>code</code>") && h.includes("<strong>b2</strong>"), "bold / italic / code", h);
h = md("Hosts:\n- one\n- **two**\n\n1. first\n2. second");
check(/<ul><li>one<\/li><li><strong>two<\/strong><\/li><\/ul>/.test(h) && /<ol><li>first<\/li><li>second<\/li><\/ol>/.test(h), "lists", h);
h = md("## Summary\ntext");
check(h.startsWith("<h4>Summary</h4>"), "heading", h);
h = md("| IP | Ports |\n|---|---|\n| 10.0.0.1 | 22, 80 |\n| 10.0.0.2 | `443` |");
check(html("| IP | Ports |\n|---|---|\n| 10.0.0.1 | 22, 80 |\n| 10.0.0.2 | `443` |").querySelectorAll("tbody tr").length === 2 && h.includes("<code>443</code>"), "table", h);
h = md("Run:\n```bash\nnmap -sn 10.0.0.0/24 && echo '<done>'\n```\nafter");
check(h.includes('<pre><code>nmap -sn 10.0.0.0/24 &amp;&amp; echo &#39;&lt;done&gt;&#39;</code></pre>') && h.includes("data-md-copy") && h.includes("<p>after</p>"), "code block + copy button, content escaped", h);
h = md("streaming ```\npartial code");
check(h.includes("<pre><code>partial code</code></pre>"), "unclosed code block while streaming", h);
check(!md("snake_case_name and 2 * 3 * 4").includes("<em>"), "no stray italics in snake_case or maths");
check(!md("**not closed").includes("<strong>"), "half-typed bold stays plain");

// Safety
const evil = [
  "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "[click](javascript:alert(1))",
  "[x](https://evil.example/\" onmouseover=\"alert(1))", "**<b onclick=alert(1)>x</b>**",
  "| a |\n|---|\n| <svg onload=alert(1)> |", "```\n</code></pre><script>alert(1)</script>\n```",
  "`<iframe src=//evil>`", "# <a href=//evil>hi</a>", "\u0000 0 \u0000 <x>",
];
for (const e of evil) {
  const el = html(e);
  const bad = el.querySelector("script, img, svg, iframe, a, b, [onerror], [onload], [onclick], [onmouseover], [href], [src]");
  const attrs = [...el.querySelectorAll("*")].flatMap(n => [...n.attributes].map(a => a.name)).filter(a => !["class", "type", "data-md-copy"].includes(a));
  check(!bad && !attrs.length, `safe: ${JSON.stringify(e).slice(0, 50)}`, el.innerHTML);
}
h = md("See [docs](https://example.com/x) and https://example.com/y");
check(h.includes("docs (https://example.com/x)") && !html("See [docs](https://example.com/x)").querySelector("a"), "links shown as plain text, not clickable", h);
const tags = new Set([...html("**a** *b* `c`\n# h\n- l\n1. o\n---\n| t |\n|---|\n| d |\n```\nx\n```").querySelectorAll("*")].map(n => n.tagName.toLowerCase()));
const allowed = new Set(["strong","em","code","pre","ul","ol","li","h4","hr","p","br","div","table","thead","tbody","tr","th","td","button"]);
check([...tags].every(t => allowed.has(t)), "only the fixed tag set is produced", [...tags].join(","));
console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
process.exit(fail ? 1 : 0);
