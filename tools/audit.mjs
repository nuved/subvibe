#!/usr/bin/env node
// SubVibe local security/release audit — no dependencies, no network.
//   Run from the extension dir:  node tools/audit.mjs
// Exits non-zero if any FAIL, so it can gate a release. Excludes tools/ itself.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const C = { red: "\x1b[31m", grn: "\x1b[32m", yel: "\x1b[33m", dim: "\x1b[2m", rst: "\x1b[0m", b: "\x1b[1m" };
let fails = 0, warns = 0;
const rel = (f) => path.relative(ROOT, f);
const pass = (n) => console.log(`  ${C.grn}✓${C.rst} ${n}`);
const fail = (n, d) => { fails++; console.log(`  ${C.red}✗ ${n}${C.rst}${d ? "\n      " + C.dim + d + C.rst : ""}`); };
const warn = (n, d) => { warns++; console.log(`  ${C.yel}⚠ ${n}${C.rst}${d ? "\n      " + C.dim + d + C.rst : ""}`); };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["tools", "node_modules", ".git", "icons", "fonts"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const files = walk(ROOT);
const js = files.filter((f) => f.endsWith(".js"));
const html = files.filter((f) => f.endsWith(".html"));
const read = (f) => fs.readFileSync(f, "utf8");
const manifest = JSON.parse(read(path.join(ROOT, "manifest.json")));

console.log(`${C.b}SubVibe security & release audit${C.rst}  ${C.dim}(${rel(path.join(ROOT, "manifest.json"))}, ${js.length} JS files)${C.rst}\n`);

// 1 — no remotely-loaded or dynamically-evaluated code (MV3 forbids it)
const remote = [...js, ...html].filter((f) => /\beval\s*\(|new Function\s*\(|<script[^>]+src=["']https?:|import\s*\(\s*["']https?:/.test(read(f)));
remote.length ? fail("Remote/dynamic code (eval, new Function, remote <script>)", remote.map(rel).join(", ")) : pass("No remote or dynamically-evaluated code");

// 2 — no hardcoded secrets / API keys
const secretRe = /sk-[A-Za-z0-9]{24,}|AIza[A-Za-z0-9_\-]{30,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}/;
const secrets = files.filter((f) => secretRe.test(read(f)));
secrets.length ? fail("Hardcoded secret/API key found", secrets.map(rel).join(", ")) : pass("No hardcoded secrets / API keys");

// 3 — the BYOK key must never enter a content script (page context)
const keyInContent = js.filter((f) => /[\\/]content[\\/]/.test(f) && /\bapiKey\b/i.test(read(f)));
keyInContent.length ? fail("API key referenced inside a content script (page-reachable!)", keyInContent.map(rel).join(", ")) : pass("API key never in a content script (page context)");

// 4 — key must not be logged
const keyLog = js.filter((f) => /console\.\w+\([^)]*\b(apikey|bearer)\b/i.test(read(f)));
keyLog.length ? fail("API key may be written to the console", keyLog.map(rel).join(", ")) : pass("API key is never logged");

// 5 — no shipped third-party dependencies / minified blobs to rot
const vendor = js.filter((f) => /sourceMappingURL|\/\*![\s\S]{0,40}(license|jquery|lodash|react)|^\s*!function\(/im.test(read(f)));
const hasNodeModules = fs.existsSync(path.join(ROOT, "node_modules"));
vendor.length || hasNodeModules ? fail("Third-party / minified code shipped", (vendor.map(rel).concat(hasNodeModules ? ["node_modules/"] : [])).join(", ")) : pass("Zero third-party libraries shipped (vanilla JS)");

// 6 — strict CSP on extension pages
const csp = (manifest.content_security_policy && manifest.content_security_policy.extension_pages) || "";
if (!csp) fail("No content_security_policy.extension_pages declared");
else if (/unsafe-inline|unsafe-eval|https?:|\bdata:/.test(csp.replace(/object-src[^;]*/, ""))) fail("CSP allows unsafe-inline / unsafe-eval / remote", csp);
else if (!/script-src\s+'self'/.test(csp)) fail("CSP script-src is not 'self'", csp);
else pass(`Strict CSP on extension pages (${csp})`);

// 7 — permissions hygiene
const broadHost = (manifest.host_permissions || []).filter((h) => /<all_urls>|^\*:\/\/|http:\/\//.test(h));
broadHost.length ? fail("Over-broad host permission (<all_urls>/http/wildcard)", broadHost.join(", ")) : pass(`host_permissions scoped to ${(manifest.host_permissions || []).length} hosts (no <all_urls>)`);
const powerful = (manifest.permissions || []).filter((p) => ["tabCapture", "scripting", "activeTab", "<all_urls>", "webRequest", "cookies", "downloads"].includes(p));
if (powerful.length) warn(`Powerful permissions present — confirm each is still used: ${powerful.join(", ")}`, "drop any you don't ship (e.g. activeTab if unused)");

// 8 — web_accessible_resources must not leak code/manifest broadly
const war = (manifest.web_accessible_resources || []).flatMap((w) => w.resources || []);
const leaky = war.filter((r) => /\.js$|manifest|\*$|^\*/.test(r) && r !== "fonts/*");
leaky.length ? fail("web_accessible_resources exposes code/broad globs", leaky.join(", ")) : pass(`web_accessible_resources limited to assets (${war.join(", ") || "none"})`);

// 9 — innerHTML review (warn): page-supplied data must use textContent
const ih = [];
for (const f of js) read(f).split("\n").forEach((ln, i) => { if (/\.innerHTML\s*=/.test(ln) && !/=\s*["'`]\s*["'`]\s*;?\s*$/.test(ln)) ih.push(`${rel(f)}:${i + 1}`); });
if (ih.length) warn(`Review ${ih.length} innerHTML assignment(s) — only use on trusted data; render page-supplied text (e.g. cached video titles) with textContent`, ih.join("  "));

// 10 — network egress: code should only talk to declared hosts
const fetchHosts = new Set();
for (const f of js) for (const m of read(f).matchAll(/(?:fetch|WebSocket)\(\s*[`"']((?:https?|wss?):\/\/[^/`"'$]+)/g)) fetchHosts.add(m[1]);
const declared = (manifest.host_permissions || []).map((h) => h.replace(/^https?:\/\//, "").replace(/\/\*$/, ""));
const undeclared = [...fetchHosts].filter((h) => { const host = h.replace(/^(https?|wss?):\/\//, ""); return !declared.some((d) => host === d || host.endsWith(d.replace(/^\*\./, "."))) && !/openai\.com$/.test(host); });
undeclared.length ? warn("Network calls to hosts not in host_permissions — verify intentional", undeclared.join(", ")) : pass("All literal network calls target declared hosts / OpenAI");

console.log(`\n${C.b}${fails ? C.red : C.grn}${fails ? "✗ " + fails + " failed" : "✓ all critical checks passed"}${C.rst}${warns ? `${C.yel}, ${warns} to review${C.rst}` : ""}\n`);
process.exit(fails ? 1 : 0);
