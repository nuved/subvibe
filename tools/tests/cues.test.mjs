// tools/tests/cues.test.mjs — overlay cue helpers (shared/cues.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/cues.js";

const C = globalThis.SV_CUES;
const cue = (startMs, endMs, words) => ({ startMs, endMs, text: words.map((x) => x[1]).join(" "), w: words.map(([o, t]) => ({ o, t })) });

test("rechunkTimed: YouTube windows become sentence lines, spanning windows where a sentence does", () => {
  // window 1: "… in Udine. Ud"  window 2: "italienische Stadt, ungefähr 5 Stunden entfernt."  — the creator's captions are the two sentences
  const w1 = cue(10000, 13000, [[0, "Hallo,"], [400, "wir"], [700, "sind"], [900, "heute"], [1200, "in"], [1400, "Udine."], [2600, "Ud"]]);
  const w2 = cue(13000, 17000, [[0, "italienische"], [500, "Stadt,"], [900, "ungefähr"], [1300, "5"], [1500, "Stunden"], [1900, "entfernt."]]);
  const out = C.rechunkTimed([w1, w2]);
  assert.deepEqual(out.map((p) => p.text), ["Hallo, wir sind heute in Udine.", "Ud italienische Stadt, ungefähr 5 Stunden entfernt."]);
  assert.deepEqual(out.map((p) => [p.startMs, p.endMs]), [[10000, 12599], [12600, 17000]]);
  assert.deepEqual(out[1].w.slice(0, 2), [{ o: 0, t: "Ud" }, { o: 400, t: "italienische" }], "word offsets re-based to the new line");
});

test("rechunkTimed: a silence long for this speaker ends a line; ordinary pauses don't", () => {
  const c = cue(0, 8000, [[0, "der"], [300, "Schlüssel"], [2200, "eine"], [2500, "Tasse"], [4200, "die"], [4500, "Tasse"]]); // 1.9 s and 1.7 s silences, 300 ms words
  assert.deepEqual(C.rechunkTimed([c]).map((p) => p.text), ["der Schlüssel", "eine Tasse", "die Tasse"]);
  const flowing = cue(0, 3000, [[0, "wir"], [250, "gehen"], [900, "heute"], [1200, "nach"], [1400, "Hause"]]); // a 650 ms pause stays inside the line
  assert.deepEqual(C.rechunkTimed([flowing]).map((p) => p.text), ["wir gehen heute nach Hause"]);
});

test("rechunkTimed: a slow learner video (real timings) keeps its sentences whole, like the creator's captions", () => {
  // youtube.com/watch?v=uzNrP5ZyH0A, json3 ASR, first 70 s — words 1–2.5 s apart, "Ud" is the ASR mishearing "Udine"
  const W = [
    cue(300, 10140, [[0, "[Musik]"]]),
    cue(3400, 14241, [[0, "Hallo,"], [1360, "wir"], [1880, "sind"], [2400, "heute"], [3241, "in"], [3841, "Udine."], [5160, "Ud"]]),
    cue(10200, 18720, [[0, "italienische"], [760, "Stadt"], [1960, "ungefähr"], [3120, "5"], [3559, "Stunden"]]),
    cue(14200, 20360, [[0, "von"], [639, "München"], [1160, "entfernt."], [2360, "Wir"], [2640, "sind"], [3080, "also"], [3720, "in"]]),
    cue(18700, 28219, [[0, "Italien."]]),
    cue(20400, 34680, [[0, "Ich"], [1200, "sitze"], [2400, "auf"], [3320, "einer"], [4119, "Bank,"], [5160, "die"], [6000, "Parkbank."]]),
    cue(28200, 41080, [[0, "Ich"], [1400, "sitze"], [2320, "im"], [3201, "Schatten,"], [4360, "der"], [5241, "Schatten,"]]),
    cue(34700, 43820, [[0, "denn"], [760, "heute"], [1800, "ist"], [2120, "es"], [3039, "sehr"], [4440, "heiß."], [5520, "Und"], [6080, "guck"]]),
    cue(41100, 45981, [[0, "mal,"]]), cue(43800, 47559, [[0, "Taco"]]), cue(46000, 51560, [[0, "liegt"]]),
    cue(47600, 58321, [[0, "unter"], [1281, "der"], [2361, "Bank."]]),
    cue(51500, 61179, [[0, "Taco"], [1039, "liegt"], [2240, "unter"], [2879, "der"], [3320, "Bank"], [3879, "und"], [4359, "ich"], [5359, "sitze"]]),
    cue(58300, 66700, [[0, "auf"], [840, "der"], [1320, "Bank"]]),
    cue(61200, 68480, [[0, "und"], [1200, "wir"], [2360, "ruhen"], [2920, "uns"], [3280, "jetzt"], [3960, "ein"], [4361, "bisschen"]]),
    cue(66700, 72340, [[0, "aus,"], [900, "denn"], [1500, "es"], [1900, "ist"], [2400, "warm."]]),
  ];
  const lines = C.rechunkTimed(W).map((p) => p.text);
  assert.deepEqual(lines, [
    "[Musik] Hallo, wir sind heute in Udine.",
    "Ud italienische Stadt ungefähr 5 Stunden von München entfernt.",
    "Wir sind also in Italien.",
    "Ich sitze auf einer Bank, die Parkbank.",
    "Ich sitze im Schatten, der Schatten, denn heute ist es sehr heiß.",
    "Und guck mal, Taco liegt unter der Bank.",
    "Taco liegt unter der Bank und ich sitze auf der Bank und wir ruhen uns jetzt ein bisschen aus,", // past the length cap: cut at the clause end, "aus" stays with "ruhen"
    "denn es ist warm.",
  ]);
  assert.ok(lines.every((l) => l.split(" ").length >= 2 || /[.!?]$/.test(l)), "no dangling one-word lines");
});

test("rechunkTimed: past maxChars a line breaks at a clause end or a breath, and at the hard cap regardless", () => {
  const words = []; let t = 0;
  for (let i = 0; i < 40; i++) { words.push([t, "wort" + i + (i === 14 ? "," : "")]); t += 250; } // ~ 270 chars, one comma after word 15, no breaths
  const out = C.rechunkTimed([cue(0, 12000, words)], { maxChars: 84, hardChars: 120 });
  assert.ok(out.length >= 3, "pieces: " + out.length);
  assert.ok(out[0].text.endsWith("wort14,"), "first break at the comma once past maxChars: " + out[0].text.slice(-12));
  assert.ok(out[1].text.length >= 120 && out[1].text.length <= 128, "second piece is cut by the hard cap: " + out[1].text.length);
  assert.equal(out.map((p) => p.text).join(" "), words.map((x) => x[1]).join(" "), "no word lost or duplicated");
});

test("rechunkTimed: untimed cues pass through in place; isTimed tells them apart", () => {
  const plain = { startMs: 0, endMs: 2000, text: "no timing here" };
  const timed = cue(3000, 5000, [[0, "Hallo."], [800, "Welt."]]);
  const out = C.rechunkTimed([plain, timed]);
  assert.deepEqual(out.map((p) => p.text), ["no timing here", "Hallo.", "Welt."]);
  assert.equal(out[0], plain);
  assert.equal(C.isTimed(timed), true); assert.equal(C.isTimed(plain), false);
  assert.equal(C.isTimed({ startMs: 0, endMs: 1, text: "x y", w: [{ o: 0, t: "x" }, { o: 0, t: "y" }] }), false, "all-zero offsets are not word timing");
});

test("chunkCues: lines group into passages at long silences or the caps, never inside a line", () => {
  const L = (startMs, endMs, original) => ({ startMs, endMs, original });
  const lines = [
    L(0, 2000, "Hallo, wir sind heute in Udine."), L(2300, 5000, "Udine ist eine italienische Stadt."), L(5200, 7000, "Wir sind also in Italien."),
    L(12000, 14000, "Ich sitze auf einer Bank."), L(14300, 16000, "Die Parkbank."), // 5 s silence before → new chunk
    L(16200, 18000, "A."), L(18100, 20000, "B."), L(20100, 22000, "C."), L(22100, 24000, "D."), L(24100, 26000, "E."), // 4-line cap
  ];
  const ch = C.chunkCues(lines);
  assert.deepEqual(ch.map((c) => [c.from, c.to]), [[0, 2], [3, 6], [7, 9]], "silence before line 3; then the 4-line cap");
  assert.deepEqual([ch[0].startMs, ch[0].endMs], [0, 7000]);
  assert.equal(C.chunkOf(ch, 4), 1); assert.equal(C.chunkOf(ch, 9), 2); assert.equal(C.chunkOf(ch, 99), -1);
  // a long passage without silences breaks on characters
  const long = Array.from({ length: 3 }, (_, i) => L(i * 3000, i * 3000 + 2800, "x".repeat(140) + "."));
  assert.deepEqual(C.chunkCues(long, { maxChars: 300, maxSents: 10 }).map((c) => [c.from, c.to]), [[0, 1], [2, 2]]);
  assert.deepEqual(C.chunkCues([]), []);
});

test("chunkCues: a speaker change (>>) starts a new chunk; stripSpeakerMarks cleans the text", () => {
  const mk = (i, t) => ({ startMs: i * 2000, endMs: i * 2000 + 1500, original: t });
  const list = [mk(0, "I think so."), mk(1, "Really."), mk(2, ">> I don't think so."), mk(3, "&gt;&gt; It's like you can do it."), mk(4, "Sure.")];
  const ch = C.chunkCues(list, { maxSents: 10, maxChars: 900, silenceMs: 60000 });
  assert.deepEqual(ch.map((c) => [c.from, c.to]), [[0, 1], [2, 2], [3, 4]]);
  assert.equal(C.stripSpeakerMarks(">> I don't think so."), "I don't think so.");
  assert.equal(C.stripSpeakerMarks("Yes. >> No. » Maybe."), "Yes. No. Maybe.");
});
