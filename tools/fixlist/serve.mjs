#!/usr/bin/env node
// Serves docs/fixlist (the reported-issues page) and saves its order/notes to docs/fixlist/prefs.json. No dependencies.
//   node tools/fixlist/serve.mjs [port]      (default 4317; HOST=192.168.127.1 so the home cluster can reach it)
//   then tools/fixlist/tunnel.yaml publishes it at https://novid-subvibefixes.fromnovid.com behind the tunnel's Cloudflare Access login
import http from "node:http";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../docs/fixlist/", import.meta.url));
const PREFS = join(ROOT, "prefs.json");
const PORT = Number(process.argv[2] || 4317);
const TYPES = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json" };
const IDS = /^[a-z0-9-]{1,40}$/, PRIOS = new Set(["now", "next", "later", "skip"]);

// Only the three known fields, bounded, so a visitor can't write anything else into the repo.
function clean(d) {
  const order = Array.isArray(d.order) ? d.order.filter((x) => IDS.test(x)).slice(0, 100) : [];
  const prio = {}, notes = {};
  for (const [k, v] of Object.entries(d.prio || {})) if (IDS.test(k) && PRIOS.has(v)) prio[k] = v;
  for (const [k, v] of Object.entries(d.notes || {})) if (IDS.test(k) && typeof v === "string") notes[k] = v.slice(0, 4000);
  return { order, prio, notes, updatedAt: new Date().toISOString() };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/prefs") {
      if (req.method === "GET") { res.writeHead(200, { "content-type": TYPES[".json"], "cache-control": "no-store" }); return res.end(await readFile(PREFS)); }
      if (req.method === "PUT") {
        let body = ""; for await (const c of req) { body += c; if (body.length > 200000) { res.writeHead(413); return res.end(); } }
        const tmp = PREFS + ".tmp"; await writeFile(tmp, JSON.stringify(clean(JSON.parse(body)), null, 2) + "\n"); await rename(tmp, PREFS);
        res.writeHead(204); return res.end();
      }
      res.writeHead(405); return res.end();
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "") || "index.html";
    if (rel.includes("..") || rel === "prefs.json" || !TYPES[extname(rel)]) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[extname(rel)] }); res.end(await readFile(join(ROOT, rel)));
  } catch (e) { res.writeHead(e.code === "ENOENT" ? 404 : 400); res.end(); }
}).listen(PORT, process.env.HOST || "127.0.0.1", () => console.log(`fix list on http://${process.env.HOST || "127.0.0.1"}:${PORT}`));
