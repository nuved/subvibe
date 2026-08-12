import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/share.js";

const S = globalThis.SV_SHARE;

const enriched = (o) => ({
  word: o.w, lemma: o.lm || o.w, cefr: o.c || "B1", pos: o.p || "noun",
  sep: !!o.sep, art: o.art || "", meaning: o.m || ("m-" + o.w),
  sentence: o.s || ("s " + o.w), sentenceT: o.st || "", para: o.para || "",
  note: o.note || "", phrase: o.phrase || "", videoTitle: o.vt || "",
  channel: o.ch || "Easy German", ms: o.ms == null ? 1000 : o.ms,
});

// A "bloated" card mixing legit enrichment with everything it must never carry.
const bloated = (o) => ({
  ...enriched(o),
  box: 4, nextDueAt: 999999, lastGradedAt: 111, history: [{ at: 1, ok: true }],
  addedAt: 222, key: "de:haus", n: 3, gift: "Nima", foo: "unknown-field", lang: "de",
});

// ── exportDeck ──────────────────────────────────────────────────────────
test("exportDeck: whitelist only — review state and unknown fields never survive", () => {
  const { text } = S.exportDeck([bloated({ w: "Haus" })], "de", {});
  const data = JSON.parse(text);
  assert.equal(data.cards.length, 1);
  const c = data.cards[0];
  for (const f of ["box", "nextDueAt", "lastGradedAt", "history", "addedAt", "key", "n", "gift", "foo", "lang"]) {
    assert.equal(c[f], undefined, f + " must not survive export");
  }
  assert.equal(c.word, "Haus");
  assert.equal(c.meaning, "m-Haus");
  assert.equal(c.channel, "Easy German");
});

test("exportDeck: envelope shape v/kind/lang", () => {
  const { text } = S.exportDeck([enriched({ w: "Baum" })], "de", {});
  const data = JSON.parse(text);
  assert.equal(data.v, 1);
  assert.equal(data.kind, "svbox");
  assert.equal(data.lang, "de");
  assert.ok(Array.isArray(data.cards));
});

test("exportDeck: filename sanitization strips disallowed chars and caps length", () => {
  const r = S.exportDeck([enriched({ w: "a" })], "de", { name: "Nima <script>" });
  assert.equal(r.filename, "De-by-Nima script.svbox");
  assert.ok(!/[<>]/.test(r.filename));

  const long = "x".repeat(40);
  const r2 = S.exportDeck([enriched({ w: "a" })], "de", { name: long });
  const namePart = r2.filename.replace("De-by-", "").replace(".svbox", "");
  assert.equal(namePart.length, 24);
});

test("exportDeck: no-name variant omits '-by-' and the name key in the payload", () => {
  const r = S.exportDeck([enriched({ w: "a" })], "de", {});
  assert.equal(r.filename, "De.svbox");
  const data = JSON.parse(r.text);
  assert.equal(data.name, undefined);
});

test("exportDeck: name variant includes name key in payload", () => {
  const r = S.exportDeck([enriched({ w: "a" })], "de", { name: "Nima" });
  const data = JSON.parse(r.text);
  assert.equal(data.name, "Nima");
});

test("exportDeck: a card with no usable word is dropped, never written out malformed", () => {
  const wordless = { ...enriched({ w: "Baum" }) };
  delete wordless.word;
  const { text } = S.exportDeck([enriched({ w: "Haus" }), wordless], "de", {});
  const data = JSON.parse(text);
  assert.equal(data.cards.length, 1, "the wordless card must not appear at all");
  assert.equal(data.cards[0].word, "Haus");
});

test("exportDeck: round-trips cleanly through validateImport, including a bad-lang case that must not crash", () => {
  const cards = [enriched({ w: "Haus" }), enriched({ w: "Baum" })];
  const { text } = S.exportDeck(cards, "de", { name: "Nima" });
  const r = S.validateImport(text);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, 0);
  assert.equal(r.cards.length, 2);

  // A bad lang must not throw and must not produce a file at all.
  assert.equal(S.exportDeck(cards, "not-a-lang-code", {}), null);
  assert.equal(S.exportDeck(cards, "d", {}), null);
  assert.equal(S.exportDeck(cards, 123, {}), null);
  assert.equal(S.exportDeck(cards, "", {}), null);
});

test("exportDeck: an un-enriched card exports no empty-string fields, no sep:false, no ms:0 (review fix round 2)", () => {
  const bare = {
    word: "Katze", meaning: "cat", sentence: "Die Katze schläft.",
    sentenceT: "", videoTitle: "", channel: "", note: "", phrase: "", para: "", lemma: "", art: "", pos: "", cefr: "",
    sep: false, ms: 0,
  };
  const { text } = S.exportDeck([bare], "de", {});
  const c = JSON.parse(text).cards[0];
  for (const f of ["sentenceT", "videoTitle", "channel", "note", "phrase", "para", "lemma", "art", "pos", "cefr"]) {
    assert.equal(f in c, false, f + " must not be emitted as an empty string — reimporting it would blank a receiver's real value");
  }
  assert.equal("sep" in c, false, "sep:false must not be emitted — reimporting it would switch off a receiver's separable-verb flag");
  assert.equal("ms" in c, false, "ms:0 must not be emitted — reimporting it would zero a receiver's video timestamp");
  assert.equal(c.word, "Katze");
  assert.equal(c.meaning, "cat");
  assert.equal(c.sentence, "Die Katze schläft.");
});

test("exportDeck: lang is normalized to lowercase (uppercase input still succeeds)", () => {
  const { text } = S.exportDeck([enriched({ w: "Haus" })], "DE", {});
  const data = JSON.parse(text);
  assert.equal(data.lang, "de");
});

test("exportDeck: non-array cards param returns null instead of throwing (incl. an array-like probe)", () => {
  assert.equal(S.exportDeck(null, "de", {}), null);
  assert.equal(S.exportDeck(undefined, "de", {}), null);
  assert.equal(S.exportDeck({ 0: enriched({ w: "a" }), length: 1 }, "de", {}), null);
});

// ── validateImport ──────────────────────────────────────────────────────
function validFile(cards, extra) {
  return JSON.stringify({ v: 1, kind: "svbox", lang: "de", cards, ...extra });
}

test("validateImport: happy path", () => {
  const r = S.validateImport(validFile([{ word: "Haus", meaning: "house" }]));
  assert.equal(r.ok, true);
  assert.equal(r.lang, "de");
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].word, "Haus");
  assert.equal(r.cards[0].meaning, "house");
});

test("validateImport: malformed JSON rejected", () => {
  const r = S.validateImport("{not json");
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test("validateImport: wrong kind rejected", () => {
  const r = S.validateImport(JSON.stringify({ v: 1, kind: "nope", lang: "de", cards: [] }));
  assert.equal(r.ok, false);
});

test("validateImport: wrong version rejected", () => {
  const r = S.validateImport(JSON.stringify({ v: 2, kind: "svbox", lang: "de", cards: [] }));
  assert.equal(r.ok, false);
});

test("validateImport: bad lang code rejected (uppercase, too short, too long)", () => {
  assert.equal(S.validateImport(validFile([], { lang: undefined, lang2: 1 })).ok, false); // no lang at all below
  assert.equal(S.validateImport(JSON.stringify({ v: 1, kind: "svbox", lang: "DE", cards: [] })).ok, false);
  assert.equal(S.validateImport(JSON.stringify({ v: 1, kind: "svbox", lang: "d", cards: [] })).ok, false);
  assert.equal(S.validateImport(JSON.stringify({ v: 1, kind: "svbox", lang: "toolonglang", cards: [] })).ok, false);
});

test("validateImport: oversize cards array rejected", () => {
  const cards = Array.from({ length: 5001 }, (_, i) => ({ word: "w" + i }));
  const r = S.validateImport(validFile(cards));
  assert.equal(r.ok, false);
});

test("validateImport: exactly 5000 cards accepted", () => {
  const cards = Array.from({ length: 5000 }, (_, i) => ({ word: "w" + i }));
  const r = S.validateImport(validFile(cards));
  assert.equal(r.ok, true);
  assert.equal(r.cards.length, 5000);
});

test("validateImport: card with non-string word skipped, file still succeeds, skip count surfaced", () => {
  const r = S.validateImport(validFile([
    { word: "Haus", meaning: "house" },
    { word: 123, meaning: "bad word type" },
    { word: "", meaning: "empty word" },
    { meaning: "no word at all" },
  ]));
  assert.equal(r.ok, true);
  assert.equal(r.cards.length, 1);
  assert.equal(r.skipped, 3);
});

test("validateImport: string length caps enforced — oversize field dropped, card survives", () => {
  const r = S.validateImport(validFile([
    { word: "Haus", meaning: "x".repeat(501), sentence: "y".repeat(1001), lemma: "Haus" },
  ]));
  assert.equal(r.ok, true);
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].meaning, undefined, "oversize string field is dropped, not truncated");
  assert.equal(r.cards[0].sentence, undefined);
  assert.equal(r.cards[0].lemma, "Haus", "fields within cap survive");
});

test("validateImport: word itself over 80 chars is skipped (whole card, since word is required)", () => {
  const r = S.validateImport(validFile([{ word: "w".repeat(81) }, { word: "ok" }]));
  assert.equal(r.ok, true);
  assert.equal(r.cards.length, 1);
  assert.equal(r.skipped, 1);
});

test("validateImport: unknown per-card fields dropped", () => {
  const r = S.validateImport(validFile([{ word: "Haus", evil: "payload", box: 5 }]));
  assert.equal(r.ok, true);
  assert.equal(r.cards[0].evil, undefined);
  assert.equal(r.cards[0].box, undefined);
});

test("validateImport: type caps — sep must be boolean, ms must be finite number", () => {
  const r = S.validateImport(validFile([
    { word: "a", sep: "yes", ms: "123" },
    { word: "b", sep: true, ms: 456 },
    { word: "c", ms: Infinity },
  ]));
  assert.equal(r.ok, true);
  assert.equal(r.cards[0].sep, undefined);
  assert.equal(r.cards[0].ms, undefined);
  assert.equal(r.cards[1].sep, true);
  assert.equal(r.cards[1].ms, 456);
  assert.equal(r.cards[2].ms, undefined);
});

test("validateImport: prototype-pollution probe neutralized by whitelist-copy", () => {
  const text = '{"v":1,"kind":"svbox","lang":"de","cards":[{"word":"Haus","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}}}]}';
  const r = S.validateImport(text);
  assert.equal(r.ok, true);
  assert.equal(r.cards[0].word, "Haus");
  assert.equal(({}).polluted, undefined, "Object.prototype must not be polluted");
  assert.equal(({}).polluted2, undefined, "Object.prototype must not be polluted");
  assert.equal(Object.prototype.hasOwnProperty.call(r.cards[0], "__proto__"), false);
});

test("validateImport: oversize raw text rejected before JSON.parse ever runs", () => {
  const hugeCard = { word: "a", note: "x".repeat(500) };
  const cards = Array.from({ length: 5000 }, () => hugeCard); // well past 2MB serialized
  const text = validFile(cards);
  assert.ok(text.length > 2 * 1024 * 1024, "test fixture must actually exceed the cap");
  const r = S.validateImport(text);
  assert.equal(r.ok, false);
  assert.equal(r.error, "too-large");
});

test("validateImport: word exactly at the 80-char cap is accepted; 81 is not", () => {
  const r = S.validateImport(validFile([{ word: "w".repeat(80) }, { word: "w".repeat(81) }]));
  assert.equal(r.ok, true);
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].word.length, 80);
  assert.equal(r.skipped, 1);
});

test("validateImport: cards not an array rejected", () => {
  const r = S.validateImport(JSON.stringify({ v: 1, kind: "svbox", lang: "de", cards: "nope" }));
  assert.equal(r.ok, false);
});

test("validateImport: name is optional, sanitized, and capped like export", () => {
  const withName = S.validateImport(JSON.stringify({ v: 1, kind: "svbox", lang: "de", name: "Nima <script>", cards: [] }));
  assert.equal(withName.ok, true);
  assert.equal(withName.name, "Nima script");

  const noName = S.validateImport(validFile([]));
  assert.equal(noName.ok, true);
  assert.equal(noName.name, undefined);
});

// ── mergeImport ─────────────────────────────────────────────────────────
test("mergeImport: brand-new word goes to toAdd with no review fields", () => {
  const r = S.mergeImport([], [{ word: "Haus", meaning: "house", box: 5, key: "junk" }], "de");
  assert.equal(r.toAdd.length, 1);
  assert.equal(r.toAdd[0].word, "Haus");
  assert.equal(r.toAdd[0].meaning, "house");
  for (const f of ["box", "nextDueAt", "lastGradedAt", "history", "key"]) {
    assert.equal(r.toAdd[0][f], undefined);
  }
  assert.equal(r.toUpdate.length, 0);
});

test("mergeImport: existing word (case-insensitive dedupe) with new enrichment goes to toUpdate only", () => {
  const existing = [{ word: "haus", meaning: "", box: 3, nextDueAt: 555, lastGradedAt: 111, history: [1], key: "de:haus" }];
  const imported = [{ word: "Haus", meaning: "house" }];
  const r = S.mergeImport(existing, imported, "de");
  assert.equal(r.toAdd.length, 0);
  assert.equal(r.toUpdate.length, 1);
  assert.equal(r.toUpdate[0].key, "de:haus");
  assert.equal(r.toUpdate[0].fields.meaning, "house");
});

test("mergeImport: import wins on differing non-empty enrichment", () => {
  const existing = [{ word: "Haus", meaning: "old meaning", key: "de:haus" }];
  const imported = [{ word: "Haus", meaning: "new meaning" }];
  const r = S.mergeImport(existing, imported, "de");
  assert.equal(r.toUpdate[0].fields.meaning, "new meaning");
});

test("mergeImport: existing non-empty field is untouched when import field is empty/absent", () => {
  const existing = [{ word: "Haus", meaning: "house", note: "keep me", phrase: "keep this too", key: "de:haus" }];
  const imported = [{ word: "Haus", meaning: "house", sentence: "Das Haus ist groß.", phrase: "" }];
  const r = S.mergeImport(existing, imported, "de");
  assert.equal(r.toUpdate.length, 1);
  assert.equal(r.toUpdate[0].fields.sentence, "Das Haus ist groß.");
  assert.equal(r.toUpdate[0].fields.meaning, undefined, "identical value produces no update field");
  assert.equal(r.toUpdate[0].fields.note, undefined, "import didn't send note — existing note stays untouched");
  assert.equal(r.toUpdate[0].fields.phrase, undefined, "import sent an explicit empty string, not absent — existing phrase must stay untouched too");
});

test("mergeImport: incoming sep:false/ms:0 never lands in toUpdate.fields, even alongside a real change (review fix round 2)", () => {
  const existing = [{ word: "Katze", lang: "de", sep: true, ms: 45210, meaning: "old", key: "de:katze" }];
  const imported = [{ word: "Katze", sep: false, ms: 0, meaning: "new" }];
  const r = S.mergeImport(existing, imported, "de");
  assert.equal(r.toUpdate.length, 1);
  assert.equal(r.toUpdate[0].fields.meaning, "new", "the real change still comes through");
  assert.equal(r.toUpdate[0].fields.sep, undefined, "sep:false must never overwrite an existing sep:true");
  assert.equal(r.toUpdate[0].fields.ms, undefined, "ms:0 must never zero out an existing ms");
});

test("mergeImport: nothing to update yields no toUpdate entry", () => {
  const existing = [{ word: "Haus", meaning: "house", key: "de:haus" }];
  const imported = [{ word: "Haus", meaning: "house" }];
  const r = S.mergeImport(existing, imported, "de");
  assert.equal(r.toUpdate.length, 0);
});

test("mergeImport: review state fields never appear in any toUpdate.fields", () => {
  const existing = [{ word: "Haus", meaning: "", box: 2, nextDueAt: 1, lastGradedAt: 1, history: [1], key: "de:haus" }];
  const imported = [{ word: "Haus", meaning: "house", box: 5, nextDueAt: 999, lastGradedAt: 999, history: [9, 9], key: "hacked" }];
  const r = S.mergeImport(existing, imported, "de");
  const fields = r.toUpdate[0].fields;
  for (const f of ["box", "nextDueAt", "lastGradedAt", "history", "key"]) {
    assert.equal(fields[f], undefined, f + " must never appear in toUpdate.fields");
  }
});

test("mergeImport: existing card object itself is never mutated", () => {
  const existing = [{ word: "Haus", meaning: "", box: 2, key: "de:haus" }];
  const snapshot = JSON.stringify(existing[0]);
  S.mergeImport(existing, [{ word: "Haus", meaning: "house" }], "de");
  assert.equal(JSON.stringify(existing[0]), snapshot, "mergeImport must not mutate its inputs");
});

test("mergeImport: an existing card's own differing .lang excludes it from the match (guards a multi-language store)", () => {
  const existing = [{ word: "Haus", lang: "de", meaning: "house-de", key: "de:haus" }];
  const imported = [{ word: "Haus", meaning: "gift-en" }];
  const r = S.mergeImport(existing, imported, "en"); // existing is a German card; import targets English
  assert.equal(r.toAdd.length, 1, "no cross-language collision — treated as a brand-new English word");
  assert.equal(r.toUpdate.length, 0);
});

test("mergeImport: lang param is canonicalized — a differently-cased lang still matches an existing card and dedupeKey", () => {
  const existing = [{ word: "Haus", lang: "de", meaning: "", key: "de:haus" }];
  const imported = [{ word: "Haus", meaning: "house" }];
  const r = S.mergeImport(existing, imported, "DE"); // caller passes uppercase; existing card is lowercase "de"
  assert.equal(r.toAdd.length, 0, "must match despite the case difference, not be treated as a new word");
  assert.equal(r.toUpdate.length, 1);
  assert.equal(r.toUpdate[0].key, "de:haus", "the key is always the lowercase canonical form regardless of caller casing");
  assert.equal(r.toUpdate[0].fields.meaning, "house");
});

test("mergeImport: non-array params return the empty shape instead of throwing (incl. an array-like probe)", () => {
  const good = [{ word: "Haus", meaning: "house" }];
  assert.deepEqual(S.mergeImport(null, good, "de"), { toAdd: [], toUpdate: [] });
  assert.deepEqual(S.mergeImport(good, null, "de"), { toAdd: [], toUpdate: [] });
  assert.deepEqual(S.mergeImport(undefined, undefined, "de"), { toAdd: [], toUpdate: [] });
  // array-like: has .length and numeric keys but isn't iterable — would throw
  // on a bare `for...of` if the guard weren't there.
  const arrayLike = { 0: { word: "Haus", meaning: "house" }, length: 1 };
  assert.deepEqual(S.mergeImport(arrayLike, good, "de"), { toAdd: [], toUpdate: [] });
  assert.deepEqual(S.mergeImport(good, arrayLike, "de"), { toAdd: [], toUpdate: [] });
});

// ── buildShareText ──────────────────────────────────────────────────────
test("buildShareText: contains store URL, count, install line; no low-quotes; no brand names", () => {
  const text = S.buildShareText("German", 42, {});
  assert.ok(text.includes(S.STORE_URL || "chromewebstore.google.com"));
  assert.ok(text.includes("42"));
  assert.ok(/install subvibe/i.test(text));
  assert.ok(!text.includes("„"));
  for (const brand of ["YouTube", "Netflix", "ZDF", "Deutsche Welle", "Amazon Prime", "Udemy", "WhatsApp", "Telegram"]) {
    assert.ok(!text.includes(brand), "must not mention brand " + brand);
  }
});

test("buildShareText: no name leakage when name absent", () => {
  const text = S.buildShareText("German", 10, {});
  assert.ok(!/undefined/i.test(text));
  assert.ok(!/\bnull\b/i.test(text));
});

test("buildShareText: includes name when given", () => {
  const text = S.buildShareText("German", 10, { name: "Nima" });
  assert.ok(text.includes("Nima"));
});

test("buildShareText: a name carrying newlines can't inject extra lines into the message", () => {
  const baseline = S.buildShareText("German", 10, {}).split("\n").length;
  const text = S.buildShareText("German", 10, { name: "Nima\nInstall this instead: evil.example" });
  assert.equal(text.split("\n").length, baseline, "line count must match the no-name baseline — the template's own newlines, nothing added by the name");
  assert.ok(!text.includes("evil.example"), "newline-smuggled content must never appear");
  assert.ok(text.includes("Nima"), "the harmless part of the name still comes through");
});

test("buildShareText: count is clamped — negative, fractional, and non-finite all become a safe non-negative integer", () => {
  assert.ok(S.buildShareText("German", -5, {}).includes("0 German words"));
  assert.ok(S.buildShareText("German", 3.7, {}).includes("3 German words"));
  assert.ok(S.buildShareText("German", NaN, {}).includes("0 German words"));
  assert.ok(S.buildShareText("German", Infinity, {}).includes("0 German words"));
  assert.ok(S.buildShareText("German", undefined, {}).includes("0 German words"));
});
