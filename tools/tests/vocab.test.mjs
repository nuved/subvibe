import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/stopwords.js";
import "../../shared/vocab.js";

const S = globalThis.SV_STOPWORDS;
const V = globalThis.SV_VOCAB;

test("tokenize: unicode letters, umlauts/ß, in-word apostrophes and hyphens, no numbers", () => {
  assert.deepEqual(V.tokenize("Der Fußgängerübergang, geht's — 42 U-Bahn!"),
    ["Der", "Fußgängerübergang", "geht's", "U-Bahn"]);
  assert.deepEqual(V.tokenize(""), []);
});

test("stopword sets: 'der' is a de stopword, 'the' is en; unknown lang → empty set", () => {
  assert.ok(S.set("de").has("der"));
  assert.ok(S.set("en").has("the"));
  assert.equal(S.set("tr").size, 0);
  assert.ok(S.set("de-DE").has("der")); // region tags normalize
});

test("detect: German sentence → de, English → en, name soup → null", () => {
  assert.equal(S.detect(V.tokenize("Ich habe das nicht gewusst und wir gehen jetzt nach Hause")), "de");
  assert.equal(S.detect(V.tokenize("I did not know that and we are going home now")), "en");
  assert.equal(S.detect(V.tokenize("Balrog Mithrandir Lothlorien Galadriel")), null);
  assert.equal(S.detect([]), null);
});

test("detect: Persian sentence → fa (the native-clip skip depends on this)", () => {
  assert.equal(S.detect(V.tokenize("اینجا شلوغ میشه و شاید سخت باشه ویدیو ریکورد کردن")), "fa");
});

test("tokenize: ZWNJ keeps a Persian compound as ONE token", () => {
  assert.deepEqual(V.tokenize("می‌شه"), ["می‌شه"]);
});

test("extractInboxWords: stopwords filtered, counts accumulate, FIRST sentence kept", () => {
  const sentences = [
    { o: "Der Hund läuft schnell.", t: "The dog runs fast." },
    { o: "Der Hund schläft.", t: "The dog sleeps." },
  ];
  const out = V.extractInboxWords(sentences, "de");
  const hund = out.find((e) => e.w === "Hund");
  assert.equal(hund.n, 2);
  assert.equal(hund.sentence, "Der Hund läuft schnell."); // first occurrence wins
  assert.equal(hund.st, "The dog runs fast.");
  assert.ok(!out.find((e) => e.w.toLowerCase() === "der")); // stopword gone
  assert.equal(out[0].w, "Hund"); // sorted by count desc
});

test("extractInboxWords: dismissed and already-known words never appear", () => {
  const sentences = [{ o: "Der Hund läuft schnell.", t: "" }];
  const out = V.extractInboxWords(sentences, "de", new Set(["schnell"]), new Set(["hund"]));
  assert.deepEqual(out.map((e) => e.w), ["läuft"]);
});

test("mergeCueSentences: cues sharing one group translation re-join into the full sentence", () => {
  const merged = V.mergeCueSentences([
    { o: "wenn der Morgen kommt", t: "وقتی صبح می‌رسد و اولین نور روز نامت را دارد." },
    { o: "und selbst das erste Tageslicht", t: "وقتی صبح می‌رسد و اولین نور روز نامت را دارد." },
    { o: "deinen Namen trägt.", t: "وقتی صبح می‌رسد و اولین نور روز نامت را دارد." },
    { o: "Nächster Satz.", t: "جملهٔ بعدی." },
    { o: "ohne Übersetzung", t: "" },
    { o: "auch ohne", t: "" }, // empty translations never merge — no mega-sentences
  ]);
  assert.equal(merged.length, 4);
  assert.equal(merged[0].o, "wenn der Morgen kommt und selbst das erste Tageslicht deinen Namen trägt.");
  assert.equal(merged[1].o, "Nächster Satz.");
  assert.equal(merged[2].o, "ohne Übersetzung");
});

test("extractInboxWords: maxSamples collects extra DISTINCT sentences, capped, first stays put", () => {
  const sentences = [
    { o: "Der Hund bellt laut.", t: "fa1" },
    { o: "Der Hund bellt laut.", t: "fa1" },        // duplicate — never a sample
    { o: "Ein Hund schläft hier.", t: "fa2" },
    { o: "Der Hund frisst gern.", t: "fa3" },
    { o: "Mein Hund tanzt.", t: "fa4" },            // over the cap of 3 total
  ];
  const [hund] = V.extractInboxWords(sentences, "de", null, null, 3);
  assert.equal(hund.w, "Hund");
  assert.equal(hund.sentence, "Der Hund bellt laut.");
  assert.deepEqual(hund.samples.map((s) => s.o), ["Ein Hund schläft hier.", "Der Hund frisst gern."]);
  // default keeps entries lean — no samples array at all
  const [lean] = V.extractInboxWords(sentences, "de");
  assert.equal(lean.samples, undefined);
});

test("extractInboxWords: bracketed non-speech tags never become words", () => {
  const out = V.extractInboxWords([{ o: "[musik] Herz [singen] schlägt [applaus]", t: "" }], "de");
  assert.deepEqual(out.map((e) => e.w).sort(), ["Herz", "schlägt"]);
});

test("extractInboxWords: unknown language passes everything through (no stopword list)", () => {
  const out = V.extractInboxWords([{ o: "el perro corre", t: "" }], "es");
  assert.deepEqual(out.map((e) => e.w).sort(), ["corre", "el", "perro"]);
});

test("mergeEnrichment: aligned entries land on the cards, '-' fields become null", () => {
  const cards = [{ word: "Hund", lang: "de" }, { word: "laufen", lang: "de" }];
  const merged = V.mergeEnrichment(cards, [
    { lemma: "Hund", pos: "noun", art: "der", plural: "Hunde", cefr: "A1", meaning: "dog", phrase: "Der Hund bellt.", note: "-" },
    { lemma: "laufen", pos: "verb", art: "-", plural: "-", cefr: "A1", meaning: "to run", phrase: "Ich laufe gern.", note: "läuft, lief, gelaufen" },
  ]);
  assert.equal(merged[0].art, "der");
  assert.equal(merged[0].note, null);
  assert.equal(merged[1].art, null);
  assert.equal(merged[1].plural, null);
  assert.equal(merged[1].note, "läuft, lief, gelaufen");
  assert.equal(cards[0].art, undefined); // inputs untouched
});

test("mergeEnrichment: short array back-fills pos:'other', cefr:'?' — still enrichable", () => {
  const merged = V.mergeEnrichment([{ word: "a" }, { word: "b" }],
    [{ lemma: "a", pos: "noun", art: "-", plural: "-", cefr: "A2", meaning: "x", phrase: "y", note: "-" }]);
  assert.equal(merged[1].pos, "other");
  assert.equal(merged[1].cefr, "?");
});

test("mergeCueSentences + extract carry the START time — the shadowing jump point", () => {
  const merged = V.mergeCueSentences([
    { o: "wenn der Morgen", t: "صبح", ms: 61000 },
    { o: "kommt", t: "صبح", ms: 62500 },
    { o: "Neuer Satz.", t: "نو", ms: 70000 },
  ]);
  assert.equal(merged[0].ms, 61000); // group keeps its FIRST cue's time
  const words = V.extractInboxWords(merged, "de", null, null, 3);
  const kommt = words.find((e) => e.w === "kommt");
  assert.equal(kommt.ms, 61000);
});

test("parseLooseJSON: verbatim, fenced, and prose-wrapped JSON all parse; garbage throws", () => {
  assert.deepEqual(V.parseLooseJSON('{"e":[1]}'), { e: [1] });
  assert.deepEqual(V.parseLooseJSON('```json\n{"e":[1]}\n```'), { e: [1] });
  assert.deepEqual(V.parseLooseJSON('Here is the table:\n{"forms":{"a":"b"}}\nHope this helps!'), { forms: { a: "b" } });
  assert.throws(() => V.parseLooseJSON("no json here"));
});

test("rankLearnable: content words beat high-frequency filler", () => {
  const ranked = V.rankLearnable([
    { w: "going", n: 40 },        // frequent filler: 5 + 2*5 = 15
    { w: "exaggerate", n: 2 },    // long content word: 10 + 2*2 = 14 … loses to going by 1
    { w: "subsidies", n: 3 },     // 9 + 6 = 15, ties going → higher n wins for going
    { w: "infrastructure", n: 2 } // 12 + 4 = 16 — content wins
  ]);
  assert.equal(ranked[0].w, "infrastructure");
  // repetition still counts, but is capped: ×40 can't bury every long word
  assert.ok(ranked.findIndex((e) => e.w === "exaggerate") <= 3);
});

test("pickClipTrack: a clip cached only in a non-target language is out of scope", () => {
  const rows = [{ tg: "en", cues: [{ o: "Der Hund.", text: "The dog." }] }];
  assert.equal(V.pickClipTrack(rows, ["fa"]), null);
});

test("pickClipTrack: primary target beats a secondary-target row with more originals", () => {
  const fa = { tg: "fa", cues: [{ o: "Der Hund.", text: "سگ." }] };
  const en = { tg: "en", cues: [{ o: "Der Hund.", text: "The dog." }, { o: "Die Katze.", text: "The cat." }] };
  const pick = V.pickClipTrack([en, fa], ["fa", "en"]);
  assert.equal(pick.tg, "fa");
  assert.equal(pick.row, fa);
});

test("pickClipTrack: falls back to the secondary target when the primary row has no originals", () => {
  const fa = { tg: "fa", cues: [{ text: "سگ." }] }; // pre-`o` row
  const en = { tg: "en", cues: [{ o: "Der Hund.", text: "The dog." }] };
  const pick = V.pickClipTrack([fa, en], ["fa", "en"]);
  assert.equal(pick.tg, "en");
  assert.equal(pick.o, 1);
});

test("pickClipTrack: a stream row qualifies via any cue's t-map and resolves its target", () => {
  const stream = { tg: null, cues: [{ original: "Der Hund.", t: { fa: "سگ." } }] };
  const pick = V.pickClipTrack([stream], ["fa"]);
  assert.equal(pick.tg, "fa");
  assert.equal(pick.o, 1);
});

test("pickClipTrack: no configured targets → nothing qualifies; all-o-less clips report o:0", () => {
  const fa = { tg: "fa", cues: [{ text: "سگ." }] };
  assert.equal(V.pickClipTrack([fa], []), null);
  const pick = V.pickClipTrack([fa], ["fa"]); // in scope, but no original text
  assert.equal(pick.o, 0);
});

test("mergeEnrichment: garbage enums are sanitized, never stored raw", () => {
  const [m] = V.mergeEnrichment([{ word: "a" }],
    [{ lemma: "a", pos: "verbish", art: "los", plural: "-", cefr: "Z9", meaning: "x", phrase: "y", note: "-" }]);
  assert.equal(m.pos, "other");
  assert.equal(m.art, null);
  assert.equal(m.cefr, "?");
});
