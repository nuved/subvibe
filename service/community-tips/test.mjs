// End-to-end check of the community tips service: node test.mjs [base URL] (default: wrangler dev on :8799).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const BASE = process.argv[2] || "http://localhost:8799";
const post = async (path, body, raw) => { const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
const key = (s) => createHash("sha256").update(s).digest("hex");
const tips = { tr: "ترجمه", simple: "Simpler words.", g: "a note", scene: "", who: [], spk: [], lang: "en",
  words: [{ w: "pay off", m: "نتیجه دادن", pos: "phrasal verb", level: "B2", forms: "", parts: ["pay", "off"], register: "neutral", tone: "positive", care: "" }] };
const k1 = key("test|" + Date.now() + "|" + Math.random());
const V = key("video|" + Math.random());

// no token: nothing
assert.equal((await post("/v1/lookup", { v: V, keys: [k1] })).status, 401);
assert.equal((await post("/v1/tips", { k: k1, tl: "fa", tips })).status, 401);
assert.equal((await post("/v1/lookup", { t: "forged.token", v: V, keys: [k1] })).status, 401);
// a passed check (wrangler dev uses Turnstile's always-pass test secret) gives a token
const tok = (await post("/v1/token", { ts: "XXXX.DUMMY.TOKEN.XXXX" })).json.token;
assert.ok(tok && tok.includes("."), "token");
const T = (o) => ({ t: tok, ...o });

// lookup before upload: nothing
assert.deepEqual((await post("/v1/lookup", T({ v: V, keys: [k1] }))).json.hits, {});
// a valid upload is stored; a second one for the same chunk is not (first wins)
assert.equal((await post("/v1/tips", { t: tok, k: k1, tl: "fa", tips })).json.stored, true);
assert.equal((await post("/v1/tips", { t: tok, k: k1, tl: "fa", tips: { ...tips, tr: "another" } })).json.stored, false);
const hit = (await post("/v1/lookup", T({ v: V, keys: [k1, "nothex"] }))).json.hits[k1];
assert.equal(hit.tr, "ترجمه"); assert.equal(hit.words[0].w, "pay off");
// shape checks: links, missing translation, bad key, unknown register, oversize body
assert.equal((await post("/v1/tips", { t: tok, k: key("x1"), tl: "fa", tips: { ...tips, simple: "see https://spam.example" } })).status, 400);
assert.equal((await post("/v1/tips", { t: tok, k: key("x2"), tl: "fa", tips: { ...tips, tr: "" } })).status, 400);
assert.equal((await post("/v1/tips", { t: tok, k: "abc", tl: "fa", tips })).status, 400);
assert.equal((await post("/v1/tips", { t: tok, k: key("x3"), tl: "fa", tips: { ...tips, words: [{ ...tips.words[0], register: "rude" }] } })).status, 400);
assert.equal((await post("/v1/tips", null, "{" + "x".repeat(30000))).status, 401); // unreadable body: no token in it
// extra fields are dropped, not stored
await post("/v1/tips", { t: tok, k: key("x4" + k1), tl: "fa", tips: { ...tips, evil: "<script>" } });
assert.equal((await post("/v1/lookup", T({ v: V, keys: [key("x4" + k1)] }))).json.hits[key("x4" + k1)].evil, undefined);
// reports: the same person twice counts once, so the entry stays up
await post("/v1/report", T({ k: k1 })); await post("/v1/report", T({ k: k1 }));
assert.ok((await post("/v1/lookup", T({ v: V, keys: [k1] }))).json.hits[k1], "one person's two reports must not retire an entry");
// pacing: a fresh video gives 3 chunks at once, the rest wait
const V2 = key("video2|" + Math.random()), ks = [1, 2, 3, 4, 5].map((i) => key("c" + i + V2));
const p1 = (await post("/v1/lookup", T({ v: V2, keys: ks }))).json;
assert.equal(p1.later.length, 2, "3 at once, 2 later"); assert.ok(p1.nextInMs > 0 && p1.nextInMs <= 15000);
const p2 = (await post("/v1/lookup", T({ v: V2, keys: ks.slice(0, 3) }))).json;
assert.equal(p2.later.length, 0, "chunks already given stay free");
assert.equal((await post("/v1/lookup", T({ v: V2, keys: ks.slice(3) }))).json.later.length, 2, "still paced");
console.log("waiting 15 s for the pace…"); await new Promise((r) => setTimeout(r, 15500));
assert.equal((await post("/v1/lookup", T({ v: V2, keys: ks.slice(3) }))).json.later.length, 1, "one more after 15 s");
console.log("ok: token required, lookup, first-wins upload, validation, field stripping, one report per person, pacing");
