// SubVibe community tips: explanations learners chose to share, served to other learners so the same
// chunk is never paid for twice. Users' own data, shown to users only — no accounts, no ads, no resale.
// The extension sends a fingerprint (SHA-256 of video id + chunk words + tips language), never the
// video id or the subtitle text; this service stores no address, only a salted daily hash for limits.

const KEY = /^[0-9a-f]{64}$/;
const LANG = /^(?:same|[a-z]{2,3}(?:-[a-z0-9]{2,8})?)$/i;
const REG = new Set(["", "formal", "neutral", "informal", "slang", "vulgar"]);
const TONE = new Set(["", "positive", "neutral", "negative"]);
const LINK = /https?:\/\/|www\.|\.(?:com|net|org|io|ru|xyz)\b/i; // tips never carry links — a link is spam
const MAX_BODY = 16 * 1024;
const HIDE_AT = 2; // reports from different people before an entry is retired

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
export function cleanTips(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const tr = str(p.tr, 2000, true), simple = str(p.simple, 2000, false), g = str(p.g, 3000, false), scene = str(p.scene, 240, false);
  const who = strList(p.who, 4, 60), spk = strList(p.spk, 8, 60), lang = str(p.lang, 12, false);
  if ([tr, simple, g, scene, who, spk, lang].some((x) => x === null)) return null;
  if (lang && !LANG.test(lang)) return null;
  if (!Array.isArray(p.words) || p.words.length > 8) return null;
  const words = [];
  for (const w of p.words) {
    if (!w || typeof w !== "object") return null;
    const x = { w: str(w.w, 60, true), m: str(w.m, 200, true), pos: str(w.pos, 30, false), level: str(w.level, 4, false), forms: str(w.forms, 160, false), parts: strList(w.parts, 4, 40), register: str(w.register, 12, false), tone: str(w.tone, 12, false), care: str(w.care, 160, false) };
    if (Object.values(x).some((v) => v === null) || !REG.has(x.register) || !TONE.has(x.tone)) return null;
    words.push(x);
  }
  return { tr, simple, g, scene, who, spk, lang, words };
}

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
    if (req.method === "GET" && url.pathname === "/v1/health") {
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM tips WHERE hidden = 0").first();
      return json({ ok: true, tips: row ? row.n : 0 });
    }
    if (req.method !== "POST") return json({ error: "not found" }, 404);
    const who = await caller(req, env);

    if (url.pathname === "/v1/lookup") {
      if (await limited(env.READ_LIMIT, who)) return json({ error: "slow down" }, 429);
      const body = await readJson(req);
      const keys = body && Array.isArray(body.keys) ? [...new Set(body.keys)].filter((k) => typeof k === "string" && KEY.test(k)).slice(0, 50) : [];
      if (!keys.length) return json({ hits: {} });
      const { results } = await env.DB.prepare(`SELECT k, body FROM tips WHERE hidden = 0 AND k IN (${keys.map(() => "?").join(",")})`).bind(...keys).all();
      const hits = {};
      for (const r of results || []) { try { hits[r.k] = JSON.parse(r.body); } catch {} }
      return json({ hits });
    }

    if (url.pathname === "/v1/tips") {
      if (await limited(env.WRITE_LIMIT, who)) return json({ error: "slow down" }, 429);
      const body = await readJson(req);
      if (!body || typeof body.k !== "string" || !KEY.test(body.k)) return json({ error: "bad key" }, 400);
      const tl = typeof body.tl === "string" && LANG.test(body.tl) ? body.tl.toLowerCase() : null;
      if (!tl) return json({ error: "bad language" }, 400);
      const tips = cleanTips(body.tips);
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
      if (await limited(env.WRITE_LIMIT, who)) return json({ error: "slow down" }, 429);
      const body = await readJson(req);
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
