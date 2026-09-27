import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import "../../shared/shots-list.js";

const L = globalThis.SV_SHOTS_LIST;
const png = (n = 8) => new Blob([new Uint8Array(n)], { type: "image/png" });

test("picture: the primary view (variant) first, then the view cache, then the legacy original", () => {
  const v = png(), o = png(), t = png();
  assert.equal(L.pickBlob({ mode: "full", layout: "translated", variant: v, original: o, views: { original: o, translated: t } }), v);
  assert.equal(L.pickBlob({ mode: "full", layout: "translated", variant: null, views: { original: o, translated: t } }), t);
  assert.equal(L.pickBlob({ mode: "area", layout: "original", views: { original: o } }), o);
  assert.equal(L.pickBlob({ mode: "area", layout: "original", original: o }), o);
});

test("picture: none for a tips sheet (its raster is a generated title card), an empty blob, or no blob at all", () => {
  assert.equal(L.pickBlob({ mode: "tips", variant: png(), views: { original: png() } }), null);
  assert.equal(L.pickBlob({ mode: "full", variant: png(0) }), null);
  assert.equal(L.pickBlob({ mode: "full", variant: "data:image/png;base64,xx", views: "nope" }), null);
  assert.equal(L.pickBlob(null), null);
});

test("first sentence pair: from pairs, else the block's text and translation, whitespace squeezed", () => {
  assert.deepEqual(L.firstPair({ blocks: [{ text: "x", tr: "y", pairs: [{ o: "Hallo  Welt", t: "سلام\nدنیا" }] }] }), { o: "Hallo Welt", t: "سلام دنیا" });
  assert.deepEqual(L.firstPair({ blocks: [{ text: "", tr: "" }, { text: "Die Stadt", tr: "" }] }), { o: "Die Stadt", t: "" });
  assert.equal(L.firstPair({ blocks: [] }), null);
  assert.equal(L.firstPair({}), null);
});

test("language pair: codes upper-cased, unknown source (xx) shows the target only", () => {
  assert.equal(L.langPair("de", "fa"), "DE → FA");
  assert.equal(L.langPair("xx", "fa"), "FA");
  assert.equal(L.langPair("", "en-US"), "EN");
  assert.equal(L.langPair("pt-BR", "en"), "PT → EN");
  assert.equal(L.langPair("de", ""), "DE");
});

test("kind: every capture mode has a plain name, unknown modes still say something", () => {
  assert.equal(L.kindLabel("visible"), "Visible");
  assert.equal(L.kindLabel("full"), "Full page");
  assert.equal(L.kindLabel("area"), "Area");
  assert.equal(L.kindLabel("element"), "Element");
  assert.equal(L.kindLabel("snap"), "Video frame");
  assert.equal(L.kindLabel("tips"), "Tips sheet");
  assert.equal(L.kindLabel("weird"), "Shot");
  assert.equal(L.kindLabel(undefined), "Shot");
});

test("summary: keyed by the store key, strings coerced, the heavy fields left behind", () => {
  const v = png();
  const s = L.summarize("abc-1", { id: "other", ts: 5, title: "T", host: "h.example", url: "https://h.example/a", source: "de", target: "fa", mode: "full",
    variant: v, blocks: [{ text: "a", tr: "b" }], study: { big: "x".repeat(1000) }, annots: [1, 2] });
  assert.equal(s.id, "abc-1");
  assert.equal(s.blob, v);
  assert.deepEqual(s.pair, { o: "a", t: "b" });
  assert.equal(s.study, undefined);
  assert.equal(s.blocks, undefined);
  const bare = L.summarize("k", { title: 42 });
  assert.equal(bare.title, "");
  assert.equal(bare.ts, 0);
  assert.equal(bare.blob, null);
});

test("newest first; a record without a time goes last, ties keep a stable order", () => {
  const list = [{ id: "a", ts: 0 }, { id: "b", ts: 30 }, { id: "c", ts: 10 }, { id: "d", ts: 30 }];
  assert.deepEqual(L.sortNewest(list).map((s) => s.id), ["b", "d", "c", "a"]);
});

test("search: title, host, URL, language code or name, kind; every word must match; case-insensitive", () => {
  const names = { de: "German", fa: "Persian" };
  const langName = (c) => names[c] || "";
  const s = { title: "Wie Berlin seine Straßen kühler machen will", host: "tagesblick.example", url: "https://tagesblick.example/berlin/strassen", source: "de", target: "fa", mode: "full" };
  for (const q of ["", "  ", "berlin", "TAGESBLICK", "/strassen", "fa", "persian", "German", "de → fa", "full page", "berlin persian"])
    assert.ok(L.matches(s, q, langName), `"${q}" should match`);
  for (const q of ["netflix", "berlin netflix", "english"])
    assert.ok(!L.matches(s, q, langName), `"${q}" should not match`);
  const rtl = { title: "چگونه برلین می‌خواهد خیابان‌هایش را خنک‌تر کند", host: "x.example", url: "", source: "xx", target: "fa", mode: "snap" };
  assert.ok(L.matches(rtl, "برلین", langName));
  assert.ok(L.matches(rtl, "video frame", langName));
  assert.ok(!L.matches(rtl, "xx", langName), "the unknown-language marker is not searchable text");
});

test("sites: most shots first, alphabetical on ties, capped, blanks skipped", () => {
  const list = ["b.com", "a.com", "b.com", "", "c.com", "a.com", "b.com"].map((host) => ({ host }));
  assert.deepEqual(L.hostCounts(list, 2), [["b.com", 3], ["a.com", 2]]);
  assert.deepEqual(L.hostCounts(list), [["b.com", 3], ["a.com", 2], ["c.com", 1]]);
});

test("site names drop a leading www., and ties sort by the name shown", () => {
  assert.equal(L.siteName("www.spiegel.de"), "spiegel.de");
  assert.equal(L.siteName("news.ycombinator.com"), "news.ycombinator.com");
  assert.equal(L.siteName("wwwx.example"), "wwwx.example");
  assert.equal(L.siteName(undefined), "");
  const list = ["tagesblick.example", "www.spiegel.de", "tagesblick.example", "www.spiegel.de"].map((host) => ({ host }));
  assert.deepEqual(L.hostCounts(list), [["www.spiegel.de", 2], ["tagesblick.example", 2]]);
});

test("every id shots.js touches exists in shots.html", () => {
  const js = fs.readFileSync(new URL("../../shots.js", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../../shots.html", import.meta.url), "utf8");
  const ids = new Set();
  for (const m of js.matchAll(/\bel\(\s*"([^"]+)"\s*\)/g)) ids.add(m[1]);
  for (const m of js.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) ids.add(m[1]);
  const defined = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...ids].filter((id) => !defined.has(id));
  assert.ok(ids.size > 0, "no ids found — the pattern drifted");
  assert.deepEqual(missing, [], `shots.js references missing ids: ${missing.join(", ")}`);
});

test("every way in points at the gallery: popup button, Library nav, editor History strip", () => {
  const read = (p) => fs.readFileSync(new URL("../../" + p, import.meta.url), "utf8");
  assert.match(read("popup.js"), /getURL\("shots\.html"\)/);
  assert.match(read("library.html"), /<a class="navlink" href="shots\.html"/);
  assert.match(read("shot.html"), /href="shots\.html"/);
});
