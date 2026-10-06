// SubVibe community tips: explanations learners chose to share, served to other learners so the same
// chunk is never paid for twice. Users' own data, shown to users only — no accounts, no ads, no resale.
// The extension sends a fingerprint (SHA-256 of video id + chunk words + tips language), never the
// video id or the subtitle text; this service stores no address, only a salted daily hash for limits.

const KEY = /^[0-9a-f]{64}$/;
const LANG = /^(?:same|[a-z]{2,3}(?:-[a-z0-9]{2,8})?)$/i;
const REG = new Set(["", "formal", "neutral", "informal", "slang", "vulgar"]);
const TONE = new Set(["", "positive", "neutral", "negative"]);
const LINK = /https?:\/\/|www\.|\.(?:com|net|org|io|ru|xyz)\b/i; // tips never carry links — a link is spam
const MAX_BODY = 24 * 1024;
const HIDE_AT = 2; // reports from different people before an entry is retired
const SITE_KEY = "0x4AAAAAAFPIR_es7wYO8tyt"; // Turnstile widget for tips.nimanou.com (public; its secret is TURNSTILE_SECRET)
const TOKEN_DAYS = 30;
const PACE_START = 3, PACE_MS = 15000;     // a video gives out 3 chunks at once, then one more every 15 s
const SESSION_MS = 6 * 3600 * 1000;        // a session older than this starts over (a second viewing)
const DAY_CAP = 3000;                      // new chunks one token may unlock per UTC day

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

// A string field: trimmed, capped, no links. Returns null when it breaks a rule.
const str = (v, max, required) => {
  if (v == null) v = "";
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length > max || (required && !s) || LINK.test(s)) return null;
  return s;
};
const strList = (v, n, max) => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > n) return null;
  const out = [];
  for (const x of v) { const s = str(x, max, false); if (s === null) return null; out.push(s); }
  return out;
};

// The explanation's shape, field by field (the extension's EXPLAIN_SCHEMA); anything else is dropped.
// withTr = false (SHARE_TRANSLATIONS=off) keeps the learning layer only: the passage translation, the
// retelling and the per-sentence translations are dropped.
export function cleanTips(p, withTr = true) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const tr = str(p.tr, 2000, true), simple = str(p.simple, 2000, false), g = str(p.g, 3000, false), scene = str(p.scene, 240, false);
  const who = strList(p.who, 4, 60), spk = strList(p.spk, 8, 60), lang = str(p.lang, 12, false);
  const lines = strList(p.lines, 8, 600); // the chunk's sentences translated, in order
  if ([tr, simple, g, scene, who, spk, lang, lines].some((x) => x === null)) return null;
  if (lang && !LANG.test(lang)) return null;
  if (!Array.isArray(p.words) || p.words.length > 8) return null;
  const words = [];
  for (const w of p.words) {
    if (!w || typeof w !== "object") return null;
    const x = { w: str(w.w, 60, true), m: str(w.m, 200, true), pos: str(w.pos, 30, false), level: str(w.level, 4, false), forms: str(w.forms, 160, false), parts: strList(w.parts, 4, 40), register: str(w.register, 12, false), tone: str(w.tone, 12, false), care: str(w.care, 160, false) };
    if (Object.values(x).some((v) => v === null) || !REG.has(x.register) || !TONE.has(x.tone)) return null;
    words.push(x);
  }
  return withTr ? { tr, simple, g, scene, who, spk, lang, words, lines } : { tr: "", simple: "", g, scene, who, spk, lang, words, lines: [] };
}
const shareTr = (env) => env.SHARE_TRANSLATIONS !== "off";
// Served entries pass the switch too, so turning it off stops translations already stored from going out.
const serve = (body, env) => { const t = JSON.parse(body); return shareTr(env) ? t : { ...t, tr: "", simple: "", lines: [] }; };

// ── Install tokens: base64url(JSON {i, e}) "." base64url(HMAC-SHA256), signed with TOKEN_KEY ──
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const hmacKey = (env) => crypto.subtle.importKey("raw", new TextEncoder().encode(env.TOKEN_KEY || "dev-token-key"), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
async function makeToken(env) {
  const body = b64u(new TextEncoder().encode(JSON.stringify({ i: crypto.randomUUID(), e: Date.now() + TOKEN_DAYS * 86400000 })));
  return body + "." + b64u(await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(body)));
}
async function readToken(t, env) {
  if (typeof t !== "string" || t.length > 400 || !t.includes(".")) return null;
  const [body, sig] = t.split(".");
  try {
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(env), unb64u(sig), new TextEncoder().encode(body)))) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
    if (!p || typeof p.i !== "string" || !(p.e > Date.now())) return null;
    if (await env.DB.prepare("SELECT 1 FROM revoked WHERE tid = ?").bind(p.i).first()) return null;
    return p;
  } catch { return null; }
}

// The human check: Turnstile on a page of this site. A pass gives the install its token, handed to the
// extension that opened the page (externally_connectable) — the page never shows it.
const humanPage = (ext) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SubVibe · Community tips</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#17140F;color:#F4EEE6;font:15px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif}main{max-width:380px;padding:24px;text-align:center}h1{font-size:18px;margin:0 0 8px}p{color:#D3C9BC;margin:0 0 16px}#st{margin-top:14px;color:#4FD1BF;min-height:1.5em}</style></head>
<body><main><h1>One quick check</h1><p>Community tips are for people, not robots. This check runs once; your tips then arrive as you watch.</p>
<div class="cf-turnstile" data-sitekey="${SITE_KEY}" data-callback="done" data-theme="dark"></div><div id="st"></div></main>
<script>
const EXT = ${JSON.stringify(ext)};
async function done(ts) {
  const st = document.getElementById("st"); st.textContent = "Checking…";
  const r = await fetch("/v1/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ts }) }).then((x) => x.json()).catch(() => ({}));
  if (!r.token) { st.textContent = "That didn't work — reload the page to try again."; return; }
  try { chrome.runtime.sendMessage(EXT, { type: "SV_COMMUNITY_TOKEN", token: r.token }, () => { st.textContent = "Done — you can close this window."; setTimeout(() => window.close(), 1200); }); }
  catch (e) { st.textContent = "Open this page from SubVibe's story board to finish."; }
}
</script></body></html>`;

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// The caller as a salted hash that changes every day — enough to rate-limit and to count one report per person.
const caller = (req, env) => sha256((env.SALT || "dev") + "|" + new Date().toISOString().slice(0, 10) + "|" + (req.headers.get("cf-connecting-ip") || "local"));

async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try { return JSON.parse(text); } catch { return null; }
}
async function limited(limiter, who) {
  if (!limiter) return false; // local dev without the binding
  const { success } = await limiter.limit({ key: who });
  return !success;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method === "GET" && url.pathname === "/v1/human") {
      const ext = url.searchParams.get("ext") || "";
      if (!/^[a-p]{32}$/.test(ext)) return new Response("Open this page from SubVibe.", { status: 400 });
      return new Response(humanPage(ext), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (req.method === "GET" && url.pathname === "/v1/health") {
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM tips WHERE hidden = 0").first();
      return json({ ok: true, tips: row ? row.n : 0 });
    }
    if (req.method !== "POST") return json({ error: "not found" }, 404);
    const who = await caller(req, env);

    if (url.pathname === "/v1/token") { // a passed Turnstile check → a 30-day install token
      if (await limited(env.WRITE_LIMIT, who)) return json({ error: "slow down" }, 429);
      const body = await readJson(req);
      if (!body || typeof body.ts !== "string" || body.ts.length > 4096) return json({ error: "no check" }, 400);
      const form = new FormData(); form.append("secret", env.TURNSTILE_SECRET || ""); form.append("response", body.ts);
      const ip = req.headers.get("cf-connecting-ip"); if (ip) form.append("remoteip", ip);
      const v = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form }).then((r) => r.json()).catch(() => ({}));
      if (!v.success) return json({ error: "the check did not pass" }, 403);
      return json({ token: await makeToken(env) });
    }

    // Everything below needs a token from the human check.
    const body = await readJson(req);
    const tok = await readToken(body && body.t, env);
    if (!tok) return json({ error: "token" }, 401);

    if (url.pathname === "/v1/lookup") {
      if (await limited(env.READ_LIMIT, tok.i)) return json({ error: "slow down" }, 429);
      const v = body && typeof body.v === "string" && KEY.test(body.v) ? body.v : null;
      if (!v) return json({ error: "bad video" }, 400);
      const keys = Array.isArray(body.keys) ? [...new Set(body.keys)].filter((k) => typeof k === "string" && KEY.test(k)).slice(0, 10) : [];
      if (!keys.length) return json({ hits: {}, later: [] });
      // Pace: this token may have this video's chunks only as fast as it plays.
      const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
      let ses = await env.DB.prepare("SELECT started_at FROM sessions WHERE tid = ? AND v = ?").bind(tok.i, v).first();
      if (!ses || now - ses.started_at > SESSION_MS) {
        await env.DB.batch([env.DB.prepare("INSERT OR REPLACE INTO sessions (tid, v, started_at) VALUES (?, ?, ?)").bind(tok.i, v, now), env.DB.prepare("DELETE FROM session_keys WHERE tid = ? AND v = ?").bind(tok.i, v)]);
        ses = { started_at: now };
      }
      const allowed = PACE_START + Math.floor((now - ses.started_at) / PACE_MS);
      const { results: had } = await env.DB.prepare("SELECT k FROM session_keys WHERE tid = ? AND v = ?").bind(tok.i, v).all();
      const granted = new Set((had || []).map((r) => r.k));
      const dayRow = await env.DB.prepare("SELECT n FROM token_days WHERE tid = ? AND day = ?").bind(tok.i, day).first();
      let room = Math.min(allowed - granted.size, DAY_CAP - (dayRow ? dayRow.n : 0));
      const ok = [], later = [], fresh = [];
      for (const k of keys) { if (granted.has(k)) ok.push(k); else if (room > 0) { ok.push(k); fresh.push(k); room--; } else later.push(k); }
      if (fresh.length) await env.DB.batch([
        ...fresh.map((k) => env.DB.prepare("INSERT OR IGNORE INTO session_keys (tid, v, k) VALUES (?, ?, ?)").bind(tok.i, v, k)),
        env.DB.prepare("INSERT INTO token_days (tid, day, n) VALUES (?, ?, ?) ON CONFLICT(tid, day) DO UPDATE SET n = n + excluded.n").bind(tok.i, day, fresh.length),
      ]);
      const hits = {};
      if (ok.length) {
        const { results } = await env.DB.prepare(`SELECT k, body FROM tips WHERE hidden = 0 AND k IN (${ok.map(() => "?").join(",")})`).bind(...ok).all();
        for (const r of results || []) { try { hits[r.k] = serve(r.body, env); } catch {} }
      }
      return json({ hits, later, nextInMs: later.length ? PACE_MS - ((now - ses.started_at) % PACE_MS) : 0 });
    }

    if (url.pathname === "/v1/tips") {
      if (await limited(env.WRITE_LIMIT, tok.i)) return json({ error: "slow down" }, 429);
      if (!body || typeof body.k !== "string" || !KEY.test(body.k)) return json({ error: "bad key" }, 400);
      const tl = typeof body.tl === "string" && LANG.test(body.tl) ? body.tl.toLowerCase() : null;
      if (!tl) return json({ error: "bad language" }, 400);
      const tips = cleanTips(body.tips, shareTr(env));
      if (!tips) return json({ error: "these tips do not have the expected shape" }, 400);
      // First valid entry wins; a retired (reported) one is replaced and its reports cleared.
      const res = await env.DB.prepare(
        `INSERT INTO tips (k, tl, src, body, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(k) DO UPDATE SET body = excluded.body, src = excluded.src, created_at = excluded.created_at, reports = 0, hidden = 0 WHERE tips.hidden = 1`
      ).bind(body.k, tl, tips.lang || "", JSON.stringify(tips), Date.now()).run();
      const stored = !!(res.meta && res.meta.changes);
      if (stored) await env.DB.prepare("DELETE FROM reports WHERE k = ?").bind(body.k).run();
      return json({ ok: true, stored });
    }

    if (url.pathname === "/v1/report") {
      if (await limited(env.WRITE_LIMIT, tok.i)) return json({ error: "slow down" }, 429);
      if (!body || typeof body.k !== "string" || !KEY.test(body.k)) return json({ error: "bad key" }, 400);
      const ins = await env.DB.prepare("INSERT OR IGNORE INTO reports (k, who, at) VALUES (?, ?, ?)").bind(body.k, who, Date.now()).run();
      if (ins.meta && ins.meta.changes) {
        await env.DB.prepare("UPDATE tips SET reports = reports + 1, hidden = CASE WHEN reports + 1 >= ? THEN 1 ELSE hidden END WHERE k = ?").bind(HIDE_AT, body.k).run();
      }
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  },
};
