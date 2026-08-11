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
