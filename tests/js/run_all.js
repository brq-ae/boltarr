// Runs every *_check.js here (each loads Boltarr's pages in jsdom, no server
// needed) and fails if any check fails, crashes or hangs (F-39).
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const only = process.argv.slice(2);
const checks = fs.readdirSync(__dirname).filter(f => f.endsWith("_check.js") && (!only.length || only.includes(f))).sort();
const failed = [];
for (const f of checks) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: "utf8", timeout: 120000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const ok = r.status === 0 && !/\bFAIL\b/.test(out);
  console.log(`${ok ? "ok  " : "FAIL"}  ${f}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  if (!ok) {
    failed.push(f);
    console.log(out.split("\n").filter(l => /FAIL|Error|at .*_check\.js/.test(l)).slice(0, 15).map(l => "      " + l).join("\n"));
    if (r.error) console.log(`      ${r.error.message}`);
  }
}
console.log(`\n${checks.length - failed.length}/${checks.length} browser checks passed`);
process.exit(failed.length ? 1 : 0);
