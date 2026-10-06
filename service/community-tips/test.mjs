// End-to-end check of the community tips service: node test.mjs [base URL] (default: wrangler dev on :8799).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const BASE = process.argv[2] || "http://localhost:8799";
const post = async (path, body, raw) => { const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
const key = (s) => createHash("sha256").update(s).digest("hex");
const tips = { tr: "ترجمه", simple: "Simpler words.", g: "a note", scene: "", who: [], spk: [], lang: "en",
  words: [{ w: "pay off", m: "نتیجه دادن", pos: "phrasal verb", level: "B2", forms: "", parts: ["pay", "off"], register: "neutral", tone: "positive", care: "" }] };
const k1 = key("test|" + Date.now() + "|" + Math.random());

// lookup before upload: nothing
assert.deepEqual((await post("/v1/lookup", { keys: [k1] })).json, { hits: {} });
// a valid upload is stored; a second one for the same chunk is not (first wins)
assert.equal((await post("/v1/tips", { k: k1, tl: "fa", tips })).json.stored, true);
assert.equal((await post("/v1/tips", { k: k1, tl: "fa", tips: { ...tips, tr: "another" } })).json.stored, false);
const hit = (await post("/v1/lookup", { keys: [k1, "nothex"] })).json.hits[k1];
assert.equal(hit.tr, "ترجمه"); assert.equal(hit.words[0].w, "pay off");
// shape checks: links, missing translation, bad key, unknown register, oversize body
assert.equal((await post("/v1/tips", { k: key("x1"), tl: "fa", tips: { ...tips, simple: "see https://spam.example" } })).status, 400);
assert.equal((await post("/v1/tips", { k: key("x2"), tl: "fa", tips: { ...tips, tr: "" } })).status, 400);
assert.equal((await post("/v1/tips", { k: "abc", tl: "fa", tips })).status, 400);
assert.equal((await post("/v1/tips", { k: key("x3"), tl: "fa", tips: { ...tips, words: [{ ...tips.words[0], register: "rude" }] } })).status, 400);
assert.equal((await post("/v1/tips", null, "{" + "x".repeat(20000))).status, 400);
// extra fields are dropped, not stored
await post("/v1/tips", { k: key("x4" + k1), tl: "fa", tips: { ...tips, evil: "<script>" } });
assert.equal((await post("/v1/lookup", { keys: [key("x4" + k1)] })).json.hits[key("x4" + k1)].evil, undefined);
// reports: the same person twice counts once, so the entry stays up
await post("/v1/report", { k: k1 }); await post("/v1/report", { k: k1 });
assert.ok((await post("/v1/lookup", { keys: [k1] })).json.hits[k1], "one person's two reports must not retire an entry");
console.log("ok: lookup, first-wins upload, validation, field stripping, one report per person");
