// The app's own script files in the order index.html loads them (js/app/*.js after the F-08 split).
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const fs = require("fs");
const html = fs.readFileSync(`${BOLTARR}/frontend/index.html`, "utf8");
module.exports = [...html.matchAll(/<script src="\/js\/(app\/[^"]+)\.js"><\/script>/g)].map(m => m[1]);
