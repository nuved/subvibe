import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/leitner.js";
import "../../shared/game.js";

const G = globalThis.SV_GAME;
const DAY = 86400000;
const NOW = 1e12;
const rng = (() => { let s = 42; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
const card = (o) => ({ word: o.w, lang: "de", cefr: o.c || "B1", pos: o.p || "noun",
  meaning: o.m || ("m-" + o.w), sentence: "s " + o.w, base: o.b || "youtube:v1",
  channel: o.ch || "Easy German", lemma: o.lm || o.w, ...o });

test("status: new / learning / mastered", () => {
  assert.equal(G.status(card({ w: "a" })), "new");
  assert.equal(G.status(card({ w: "b", lastGradedAt: 1, box: 2 })), "learning");
  assert.equal(G.status(card({ w: "c", lastGradedAt: 1, box: 5 })), "mastered");
});

test("scope: source, level floor, pos incl separable", () => {
  const c = card({ w: "aufstehen", p: "verb", lm: "auf|stehen", c: "A2" });
  assert.ok(G.matchesScope(c, { source: "", minLevel: "", pos: "sep" }));
  assert.ok(G.matchesScope(c, { source: "channel:Easy German", minLevel: "A2", pos: "" }));
  assert.ok(!G.matchesScope(c, { source: "channel:Other", minLevel: "", pos: "" }));
  assert.ok(!G.matchesScope(c, { source: "", minLevel: "B1", pos: "" }));
  assert.ok(!G.matchesScope(card({ w: "x", c: "?" }), { source: "", minLevel: "A2", pos: "" }));
  assert.ok(G.matchesScope(c, { source: "base:youtube:v1", minLevel: "", pos: "verb" }));
});

test("isSep: sep flag from enrichment (without pipe-lemma fallback)", () => {
  const sepViaFlag = card({ w: "aufstehen", p: "verb", lm: "aufstehen", sep: true, c: "A2" });
  assert.ok(G.isSep(sepViaFlag), "sep flag true identifies separable verb");

  const nonSepViaFlag = card({ w: "gehen", p: "verb", lm: "gehen", sep: false, c: "A2" });
  assert.ok(!G.isSep(nonSepViaFlag), "sep flag false is not separable");

  const noSepField = card({ w: "erreichen", p: "verb", lm: "erreichen", c: "B1" });
  assert.ok(!G.isSep(noSepField), "missing sep field defaults to false");
});

test("buildSession: due reviews first, new capped by pacing, size 10", () => {
  const due = Array.from({ length: 4 }, (_, i) => card({ w: "due" + i, lastGradedAt: 1, box: 1, nextDueAt: NOW - DAY }));
  const fresh = Array.from({ length: 30 }, (_, i) => card({ w: "new" + i }));
  const s = G.buildSession({ cards: [...fresh, ...due], scope: { source: "", minLevel: "", pos: "" },
    perDay: 20, introducedToday: 14, now: NOW, rng });
  assert.equal(s.items.length, 10);
  assert.deepEqual(s.items.slice(0, 4).map((c) => c.word).sort(), ["due0", "due1", "due2", "due3"]);
  assert.equal(s.newCount, 6);                       // 20/day − 14 already introduced
  assert.ok(s.items.slice(4).every((c) => G.status(c) === "new"));
});

test("buildSession: never introduces beyond allowance; mastered excluded", () => {
  const done = card({ w: "done", lastGradedAt: 1, box: 5, nextDueAt: NOW - DAY });
  const s = G.buildSession({ cards: [done, ...Array.from({ length: 9 }, (_, i) => card({ w: "n" + i }))],
    scope: { source: "", minLevel: "", pos: "" }, perDay: 20, introducedToday: 20, now: NOW, rng });
  assert.equal(s.newCount, 0);
  assert.ok(!s.items.some((c) => c.word === "done"), "mastered cards never appear");
  assert.equal(s.items.length, 0);
});

test("buildSession: unenriched cards (null/empty meaning) never enter a session, due or fresh", () => {
  const enrichedDue = card({ w: "d-e", lastGradedAt: 1, box: 1, nextDueAt: NOW - DAY });
  const unenrichedDue = card({ w: "d-u", lastGradedAt: 1, box: 1, nextDueAt: NOW - DAY, meaning: null });
  const enrichedFresh = card({ w: "f-e" });
  const unenrichedFresh1 = card({ w: "f-u1", meaning: "" });
  const unenrichedFresh2 = card({ w: "f-u2", meaning: "   " }); // whitespace-only counts as unenriched
  const s = G.buildSession({
    cards: [enrichedDue, unenrichedDue, enrichedFresh, unenrichedFresh1, unenrichedFresh2],
    scope: { source: "", minLevel: "", pos: "" }, perDay: 20, introducedToday: 0, now: NOW, rng,
  });
  assert.deepEqual(s.items.map((c) => c.word).sort(), ["d-e", "f-e"]);
});

test("buildSession: a deck with zero enriched cards yields an empty session", () => {
  const cards = [
    card({ w: "u0", meaning: null, lastGradedAt: 1, box: 1, nextDueAt: NOW - DAY }),
    card({ w: "u1", meaning: "" }),
    card({ w: "u2", meaning: "   " }),
  ];
  const s = G.buildSession({ cards, scope: { source: "", minLevel: "", pos: "" }, perDay: 20, introducedToday: 0, now: NOW, rng });
  assert.equal(s.items.length, 0);
  assert.equal(s.newCount, 0);
});

test("distractors: 3 unique meanings, never the answer, prefer same pos", () => {
  const target = card({ w: "t", m: "right", p: "verb" });
  const pool = [target, card({ w: "a", m: "right" }), card({ w: "b", m: "w1", p: "verb" }),
    card({ w: "c", m: "w2", p: "verb" }), card({ w: "d", m: "w3", p: "noun" }), card({ w: "e", m: "w1" })];
  const d = G.distractors(target, pool, rng);
  assert.equal(d.length, 3);
  assert.ok(!d.includes("right"));
  assert.equal(new Set(d).size, 3);
  assert.ok(d.includes("w1") && d.includes("w2"), "same-pos meanings preferred");
});

test("shuffle: permutation, deterministic under seeded rng, input untouched", () => {
  const a = [1, 2, 3, 4, 5];
  const out = G.shuffle(a, rng);
  assert.deepEqual([...out].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(a, [1, 2, 3, 4, 5]);
});

test("builderFor: tokens, permutation chips, punctuation attached, length bounds, missing sentence", () => {
  const c = card({ w: "gehen", sentence: "Ich gehe heute ins Kino." });
  const b = G.builderFor(c, rng);
  assert.deepEqual(b.solution, ["Ich", "gehe", "heute", "ins", "Kino."]);
  assert.equal(b.solution.join(" "), c.sentence, "solution rejoins into the source sentence");
  assert.deepEqual([...b.chips].sort(), [...b.solution].sort(), "chips are a permutation of solution");
  assert.equal(b.chips.length, b.solution.length);

  assert.equal(G.builderFor(card({ w: "x", sentence: "Zu kurz." }), rng), null, "2 tokens < 3 → null");
  assert.ok(G.builderFor(card({ w: "x", sentence: "Drei Wörter hier." }), rng), "3 tokens is the playable floor");
  const twelve = Array.from({ length: 12 }, (_, i) => "w" + i).join(" ");
  assert.ok(G.builderFor(card({ w: "x", sentence: twelve }), rng), "12 tokens is the playable ceiling");
  const thirteen = Array.from({ length: 13 }, (_, i) => "w" + i).join(" ");
  assert.equal(G.builderFor(card({ w: "x", sentence: thirteen }), rng), null, "13 tokens > 12 → null");
  assert.equal(G.builderFor(card({ w: "x", sentence: "" }), rng), null, "missing sentence → null");
  assert.equal(G.builderFor(card({ w: "x", sentence: null }), rng), null, "null sentence → null");
});

test("gapFor: blanks the article before the noun; options fixed; art/absence → null; case-insensitive", () => {
  const midSentence = card({ w: "Wortschatz", art: "der", sentence: "Ich finde, der Wortschatz ist schön." });
  const g1 = G.gapFor(midSentence);
  assert.deepEqual(g1.options, ["der", "die", "das"]);
  assert.equal(g1.correct, "der");
  // before/after are exact slices of the ORIGINAL sentence around the "der" occurrence —
  // spacing belongs to before/after, not reinserted by the caller.
  assert.equal(g1.before + "der" + g1.after, midSentence.sentence);
  assert.equal(g1.before + "___" + g1.after, midSentence.sentence.replace(/\bder\b/, "___"));

  // case-insensitivity: sentence-initial "Die" still matches art "die"; it disappears
  // entirely into the blank (before === "", no reinsertion needed for casing).
  const initial = card({ w: "Geduld", art: "die", sentence: "Die Geduld ist wichtig beim Lernen." });
  const g2 = G.gapFor(initial);
  assert.equal(g2.before, "");
  assert.equal(g2.correct, "die");
  assert.equal(g2.before + "___" + g2.after, initial.sentence.replace(/^Die\b/, "___"));

  assert.equal(G.gapFor(card({ w: "Zufall", sentence: "Der Zufall wollte es so." })), null, "no art field → null");
  assert.equal(
    G.gapFor(card({ w: "Erfahrung", art: "die", sentence: "Viele Erfahrungen prägen das Leben." })),
    null,
    "article not immediately before the noun (plural phrasing) → null",
  );
});

test("gapFor: exact noun match wins over a compound that merely contains the stem (two-pass)", () => {
  // "Freundeskreis" starts with "Freund" and sits behind a "Der" first — a plain
  // substring/stem match would blank the WRONG noun. The exact match ("der Freund")
  // must win even though it's the second candidate in the sentence.
  const compound = card({ w: "Freund", art: "der",
    sentence: "Der Freundeskreis war groß, aber der Freund blieb treu." });
  const g = G.gapFor(compound);
  assert.equal(g.correct, "der");
  assert.equal(g.before + "der" + g.after, compound.sentence);
  assert.ok(g.before.includes("Freundeskreis"), "the compound occurrence was passed over, not blanked");
  assert.ok(g.after.trim().startsWith("Freund "), "the exact-match occurrence was blanked");

  // Same failure mode with a 3-letter word, where the (length > 3 ? drop-last-char)
  // stem heuristic can't even shorten "Tag" — without the exact-match pass, ANY
  // compound starting with "Tag" trivially stem-matches.
  const compound3 = card({ w: "Tag", art: "der",
    sentence: "Der Tagesbericht war lang, doch der Tag blieb ruhig." });
  const g3 = G.gapFor(compound3);
  assert.equal(g3.before + "der" + g3.after, compound3.sentence);
  assert.ok(g3.before.includes("Tagesbericht"));
  assert.ok(g3.after.trim().startsWith("Tag "));

  // Pass 2 (stem tolerance) still fires when NO exact match exists anywhere —
  // declined/plural forms remain gap-able.
  const inflected = card({ w: "Freiheit", art: "die",
    sentence: "Die Freiheiten der Bürger sind geschützt." });
  const gi = G.gapFor(inflected);
  assert.equal(gi.correct, "die");
  assert.equal(gi.before, "");
  assert.ok(gi.after.trim().startsWith("Freiheiten "));
  assert.equal(gi.before + "___" + gi.after, inflected.sentence.replace(/^Die\b/, "___"));
});

test("findFor: separable prefix (last occurrence), plain verb token, else null, word-boundary discipline", () => {
  const sep = card({ w: "aufstehen", p: "verb", lm: "auf|stehen", sep: true,
    sentence: "Wenn ich auf Reisen bin, stehe ich immer früh auf." });
  const f1 = G.findFor(sep);
  assert.equal(f1.ask, "prefix");
  // "auf" appears at token 2 ("auf" before "Reisen") and again as the final token — LAST wins.
  assert.equal(f1.tokens[f1.answerIndex].replace(/[.,!?]+$/, ""), "auf");
  assert.equal(f1.answerIndex, f1.tokens.length - 1);

  const plainVerb = card({ w: "erreichen", p: "verb", sentence: "Wir haben unser Ziel erreicht." });
  const fStem = G.findFor(plainVerb);
  assert.equal(fStem.ask, "verb", "infinitive stem \"erreich\" matches the conjugated token \"erreicht\"");
  assert.equal(fStem.tokens[fStem.answerIndex], "erreicht.");

  const plainVerbToken = card({ w: "erreicht", p: "verb", sentence: "Wir haben unser Ziel erreicht." });
  const f2 = G.findFor(plainVerbToken);
  assert.equal(f2.ask, "verb");
  assert.equal(f2.tokens[f2.answerIndex], "erreicht.");

  const noun = card({ w: "Kino", p: "noun", sentence: "Wir gehen ins Kino heute." });
  assert.equal(G.findFor(noun), null, "word appears as a token but pos isn't verb → null");

  const buriedPrefix = card({ w: "aufmerksam", p: "adj", sep: true, lm: "auf|merksam",
    sentence: "Sie war sehr aufmerksam im Unterricht." });
  assert.equal(G.findFor(buriedPrefix), null, "prefix only inside another word, no standalone token → null");

  assert.equal(G.findFor(card({ w: "x", sentence: "" })), null, "missing sentence → null");
});

test("findFor: reunited-lemma fallback (real enrichment data has no pipe)", () => {
  // Real enrichment always returns the REUNITED lemma ("aufstehen"), never the
  // stub-only pipe form ("auf|stehen") — sep:true + a plain lemma must still work.
  const reunited = card({ w: "aufstehen", p: "verb", lm: "aufstehen", sep: true,
    sentence: "Ich stehe jeden Tag früh auf." });
  const f = G.findFor(reunited);
  assert.equal(f.ask, "prefix");
  assert.equal(f.tokens[f.answerIndex].replace(/[.,!?]+$/, ""), "auf");
  assert.equal(f.answerIndex, f.tokens.length - 1, "prefix sits clause-final in this sentence");

  // Longer prefix must win over a shorter one that's also a valid prefix on its
  // own ("zu" vs "zurück") — matching against the START of the reunited lemma.
  const longer = card({ w: "zurückkommen", p: "verb", lm: "zurückkommen", sep: true,
    sentence: "Er wollte unbedingt heute Abend nach Hause." });
  assert.equal(G.findFor(longer), null, "no standalone \"zurückkommen\"-prefix token in this sentence");
  const longerHit = card({ w: "zurückkommen", p: "verb", lm: "zurückkommen", sep: true,
    sentence: "Er kommt am Abend endlich zurück." });
  const fl = G.findFor(longerHit);
  assert.equal(fl.tokens[fl.answerIndex].replace(/[.,!?]+$/, ""), "zurück");

  // Prefix only embedded inside another word (no standalone token) → null, even
  // though the reunited lemma legitimately starts with that prefix.
  const buried = card({ w: "aufwachen", p: "verb", lm: "aufwachen", sep: true,
    sentence: "Sie war den ganzen Morgen aufmerksam und müde." });
  assert.equal(G.findFor(buried), null, "prefix only inside \"aufmerksam\", no standalone token");

  // Prefix genuinely absent from the sentence → null (fail closed).
  const absent = card({ w: "zurückkommen", p: "verb", lm: "zurückkommen", sep: true,
    sentence: "Er kommt heute Abend nach Hause." });
  assert.equal(G.findFor(absent), null, "prefix not in the sentence at all");

  // sep:true but the lemma matches no known prefix at all → null, not a crash.
  const noPrefix = card({ w: "reden", p: "verb", lm: "reden", sep: true,
    sentence: "Wir reden morgen darüber." });
  assert.equal(G.findFor(noPrefix), null, "lemma doesn't start with any known separable prefix");
});

test("findFor: carries the display target word (lemma preferred, pipes stripped); a word matching MULTIPLE tokens fails closed", () => {
  const verbCard = card({ w: "frisst", lm: "fressen", p: "verb",
    sentence: "Ich sehe nur noch dich, wenn der Lärm den Himmel frisst." });
  const f = G.findFor(verbCard);
  assert.equal(f.ask, "verb");
  assert.equal(f.word, "fressen", "the LEMMA names the target, not the bare conjugated surface form");

  const sepCard = card({ w: "aufstehen", lm: "auf|stehen", p: "verb", sep: true, sentence: "Ich stehe früh auf." });
  const fs = G.findFor(sepCard);
  assert.equal(fs.ask, "prefix");
  assert.equal(fs.word, "aufstehen", "stub-only pipe notation stripped for display");

  // The operator's repro, generalized: a sentence with the target word
  // appearing twice can't confirm a single unambiguous answer — the player
  // would be unfairly wrong for tapping "the other one" either way.
  const twoForms = card({ w: "geht", p: "verb", sentence: "Er geht, dann geht sie auch." });
  assert.equal(G.findFor(twoForms), null, "two occurrences of the target word — fail closed, not a coin flip");
});

test("findFor: verb-branch stemming — conjugated token matched via infinitive stem, only lowercase tokens qualify", () => {
  const erreichen = card({ w: "erreichen", p: "verb", sentence: "Wir haben unser Ziel erreicht." });
  const f1 = G.findFor(erreichen);
  assert.equal(f1.ask, "verb");
  assert.equal(f1.tokens[f1.answerIndex], "erreicht.", "\"erreichen\" stem \"erreich\" matches \"erreicht\"");

  const gehen = card({ w: "gehen", p: "verb", sentence: "Er geht heute ins Kino." });
  const f2 = G.findFor(gehen);
  assert.equal(f2.ask, "verb");
  assert.equal(f2.tokens[f2.answerIndex], "geht", "\"gehen\" stem \"geh\" matches \"geht\"");

  // The stem "geh" also prefixes the capitalized noun "Gehweg" — capitalized
  // tokens never qualify as verb candidates (conservative: German capitalizes
  // all nouns, so a capitalized stem-prefix match is never this card's verb).
  const nounFalsePositive = card({ w: "gehen", p: "verb", sentence: "Der Gehweg ist heute leer." });
  assert.equal(G.findFor(nounFalsePositive), null, "stem-prefixing capitalized noun doesn't count as a candidate");

  // Two lowercase tokens both stem-match — fail closed, same discipline as
  // the exact-match ambiguity guard, now applied across exact+stem together.
  const twoStemMatches = card({ w: "gehen", p: "verb", sentence: "Er geht, und sie geht auch." });
  assert.equal(G.findFor(twoStemMatches), null, "two stem-matching lowercase tokens — fail closed, not a coin flip");

  // The bare infinitive appears verbatim AND a different token elsewhere
  // stem-matches the same infinitive — just as ambiguous to the player as
  // two identical exact occurrences, so the guard must combine both pools
  // rather than short-circuit on the exact hit alone.
  const exactPlusStem = card({ w: "gehen", p: "verb", sentence: "Sie gehen gerne, wenn sie geht." });
  assert.equal(G.findFor(exactPlusStem), null, "exact match + a separate stem match — combined guard fails closed");
});

test("findTeaching: the operator's repro — a wenn-clause verb genuinely at the clause end gets the clause-final line", () => {
  const c = card({ w: "frisst", lm: "fressen", p: "verb",
    sentence: "Ich sehe nur noch dich, wenn der Lärm den Himmel frisst." });
  const found = G.findFor(c);
  const lines = G.findTeaching(c, found);
  assert.equal(lines[0], "frisst is the form of fressen here");
  assert.equal(lines[1], "In a 'wenn' clause the verb moves to the end.");
  assert.ok(!lines.join(" ").includes("„"));
});

test("findTeaching: no governing clause — a genuinely position-2 verb gets the verb-second line instead", () => {
  const c = card({ w: "geht", p: "verb", sentence: "Er geht heute ins Kino." });
  const lines = G.findTeaching(c, G.findFor(c));
  assert.equal(lines[1], "Das Verb steht an Position 2: 'Er geht …'");
});

test("findTeaching: neither clause condition verifiable → line 2 omitted, never a false claim", () => {
  const c = card({ w: "erreicht", p: "verb", sentence: "Wir haben unser Ziel erreicht." }); // not clause-final-after-a-conjunction, not position 2
  const lines = G.findTeaching(c, G.findFor(c));
  assert.deepEqual(lines, ["erreicht is the form of erreicht here"]);
});

test("findTeaching: sep-prefix line names what it belongs to, with the split shown when derivable; card.note rides as the final line", () => {
  const c = card({ w: "aufstehen", lm: "auf|stehen", p: "verb", sep: true, sentence: "Ich stehe jeden Tag früh auf." });
  const found = G.findFor(c);
  const lines = G.findTeaching(c, found);
  assert.equal(lines[0], "auf belongs to aufstehen (auf|stehen)");
  assert.equal(lines.length, 1, "no clause claim verifiable here — the prefix itself isn't at position 2 or clause-governed");

  const withNote = card({ w: "frisst", lm: "fressen", p: "verb", note: "irregular: du frisst, er frisst",
    sentence: "Ich sehe nur noch dich, wenn der Lärm den Himmel frisst." });
  const notedLines = G.findTeaching(withNote, G.findFor(withNote));
  assert.equal(notedLines[notedLines.length - 1], "irregular: du frisst, er frisst");
});

test("kindsFor / pickKind: kinds mirror *For nullability; mode-driven selection with fallback", () => {
  const full = card({ w: "aufstehen", p: "verb", lm: "auf|stehen", sep: true,
    sentence: "Ich stehe jeden Tag früh auf." });
  assert.deepEqual(G.kindsFor(full).sort(), ["builder", "find", "word"]);

  const nounGap = card({ w: "Geduld", art: "die", sentence: "Die Geduld ist wichtig beim Lernen." });
  const nounKinds = G.kindsFor(nounGap);
  assert.ok(nounKinds.includes("gap") && nounKinds.includes("builder") && nounKinds.includes("word"));
  assert.ok(!nounKinds.includes("find"));

  const bare = card({ w: "x", sentence: "kurz." });
  assert.deepEqual(G.kindsFor(bare), ["word"]);

  for (let i = 0; i < 10; i++) assert.equal(G.pickKind(full, "words", rng), "word");

  for (let i = 0; i < 20; i++) assert.notEqual(G.pickKind(full, "sentences", rng), "word");
  assert.equal(G.pickKind(bare, "sentences", rng), "word", "no sentence kind supported → falls back to word");

  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(G.pickKind(full, "mixed", rng));
  assert.ok(seen.has("word"), "mixed still lands on word sometimes");
  assert.ok(seen.has("builder") || seen.has("find"), "mixed reaches a sentence kind too");
});

test("builderHint: arrays — general rule always present; position-2/prefix-at-end lines ONLY when verified against real tokens", () => {
  // Genuine verb-second sentence: card.word ("gehe") is the sentence's ACTUAL
  // token at index 1 — the illustration is verified true and quoted verbatim.
  const plain = card({ w: "gehe", p: "verb", sentence: "Ich gehe heute ins Kino." });
  const plainHint = G.builderHint(plain);
  assert.equal(plainHint[1], "Das Verb steht an Position 2: 'Ich gehe …'", "line 2 illustrates the rule with THIS sentence's actual tokens");
  assert.equal(plainHint.length, 2, "no sep-prefix line, no note → exactly rule + verified illustration");

  // Separable verb, prefix genuinely the LAST token: both claims verified.
  const sepFinal = card({ w: "aufstehen", p: "verb", lm: "auf|stehen", sep: true, sentence: "Ich stehe früh auf." });
  const sepFinalHint = G.builderHint(sepFinal);
  assert.equal(sepFinalHint[1], "Das Verb steht an Position 2: 'Ich stehe …'");
  assert.equal(sepFinalHint[2], "Das Präfix 'auf' steht am Satzende: '… auf.'", "sep verbs get an extra line naming the actual prefix token");

  for (const h of [plainHint, sepFinalHint]) {
    const joined = h.join(" ");
    assert.ok(!joined.includes("„"));
    assert.ok(!/[<>]/.test(joined));
  }
  assert.notEqual(G.builderHint(sepFinal)[0], G.builderHint(plain)[0], "separable rule line differs from the generic verb-second line");

  const withNote = card({ w: "gehe", p: "verb", sentence: "Ich gehe heute ins Kino.", note: "irregular imperative" });
  const noted = G.builderHint(withNote);
  assert.equal(noted.length, 3);
  assert.equal(noted[noted.length - 1], "irregular imperative", "card.note rides verbatim as the final line when present");

  // Fragment-safety (playtest repro): a verb-final subordinate-clause
  // fragment must NEVER get a false "position 2" claim — omitted entirely,
  // not asserted for a sentence that doesn't demonstrate it.
  const verbFinal = card({ w: "ist", p: "verb", sentence: "bis nur noch deine Nähe ist." });
  const verbFinalHint = G.builderHint(verbFinal);
  assert.equal(verbFinalHint.length, 1, "verb sits at the end, not position 2 — line 2 omitted, never asserted falsely");
  assert.ok(!verbFinalHint.join(" ").includes("Position 2"));

  // Same fragment, a non-verb card — no verb identity to check at all, so
  // line 2 never even attempts a claim.
  const nonVerbFragment = card({ w: "Nähe", p: "noun", sentence: "bis nur noch deine Nähe ist." });
  assert.equal(G.builderHint(nonVerbFragment).length, 1);

  // Separable verb, prefix present but NOT the final token (a trailing
  // subordinate clause) — neither claim is verifiable, both omitted together.
  const sepNotFinal = card({ w: "aufstehen", p: "verb", lm: "auf|stehen", sep: true,
    sentence: "Ich stehe auf, wenn der Wecker klingelt." });
  assert.equal(G.builderHint(sepNotFinal).length, 1, "prefix isn't genuinely final — no false claim on either line");
});

test("gapRule: arrays — art/gender line, -ung/-heit/-keit pattern hint ONLY on a genuinely matching noun, optional note", () => {
  const matching = card({ w: "Freiheit", art: "die", sentence: "Die Freiheit ist wichtig." });
  const r1 = G.gapRule(matching);
  assert.ok(Array.isArray(r1) && r1.length >= 2);
  assert.equal(r1[0], "die Freiheit — feminine");
  assert.ok(r1[1].includes("-heit") && r1[1].toLowerCase().includes("feminin"), "pattern line names the noun's actual suffix");
  const joined1 = r1.join(" ");
  assert.ok(!joined1.includes("„"));
  assert.ok(!/[<>]/.test(joined1));

  const nonMatching = card({ w: "Geduld", art: "die", sentence: "Die Geduld ist wichtig." });
  const r2 = G.gapRule(nonMatching);
  assert.deepEqual(r2, ["die Geduld — feminine"], "no false pattern hint on a noun that doesn't end in -ung/-heit/-keit");

  const withNote = card({ w: "Freiheit", art: "die", note: "pl. Freiheiten", sentence: "Die Freiheit ist wichtig." });
  const r3 = G.gapRule(withNote);
  assert.equal(r3.length, 3);
  assert.equal(r3[r3.length - 1], "pl. Freiheiten", "card.note rides verbatim as the final line when present");

  assert.deepEqual(G.gapRule(card({ w: "x", sentence: "kurz." })), [], "no art → empty array, not an empty string");
});

test("null-safety: every new function tolerates null/undefined cards and pre-step2 cards missing fields", () => {
  const fns = [
    (c) => G.builderFor(c, rng),
    (c) => G.gapFor(c),
    (c) => G.findFor(c),
    (c) => G.kindsFor(c),
    (c) => G.pickKind(c, "mixed", rng),
    (c) => G.builderHint(c),
    (c) => G.gapRule(c),
    (c) => G.findTeaching(c, G.findFor(c)),
  ];
  for (const nullish of [null, undefined]) {
    for (const f of fns) assert.doesNotThrow(() => f(nullish));
  }
  // A card saved before step-2 shipped: no sentence, no art, no sep, no lemma, no pos.
  const ancient = { word: "Wort", lang: "de", cefr: "B1", meaning: "word" };
  for (const f of fns) assert.doesNotThrow(() => f(ancient));
  assert.equal(G.builderFor(ancient, rng), null);
  assert.equal(G.gapFor(ancient), null);
  assert.equal(G.findFor(ancient), null);
  assert.deepEqual(G.kindsFor(ancient), ["word"]);
  assert.equal(G.pickKind(ancient, "mixed", rng), "word");
  assert.ok(G.builderHint(ancient).length > 0);
  assert.deepEqual(G.gapRule(ancient), []);
  assert.deepEqual(G.findTeaching(ancient, G.findFor(ancient)), [], "no find match to teach → empty array, not a crash");
});

test("records: streak counts consecutive days; bests only improve; new-record labels", () => {
  let r = { };
  let u = G.updateRecords(r, { correct: 8, total: 10, seconds: 42, speedBonuses: 5, perfect: false }, "2026-08-11");
  assert.equal(u.records.streakDays, 1);
  assert.equal(u.records.bestRound, 8);
  assert.ok(u.newRecords.length >= 1);
  u = G.updateRecords(u.records, { correct: 7, total: 10, seconds: 50, speedBonuses: 1, perfect: false }, "2026-08-12");
  assert.equal(u.records.streakDays, 2);
  assert.equal(u.records.bestRound, 8, "a worse round never lowers a best");
  u = G.updateRecords(u.records, { correct: 10, total: 10, seconds: 39, speedBonuses: 2, perfect: true }, "2026-08-14");
  assert.equal(u.records.streakDays, 1, "a skipped day restarts the streak");
  assert.equal(u.records.fastestPerfectSec, 39);
});
