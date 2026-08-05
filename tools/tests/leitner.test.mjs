import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/leitner.js";

const L = globalThis.SV_LEITNER;
const DAY = 86400000;
const T0 = 1_754_000_000_000; // fixed epoch — no wall-clock in tests

const card = (over = {}) => ({ word: "Hund", lang: "de", box: 1, nextDueAt: T0, addedAt: T0, history: [], ...over });

test("intervals are [1,2,4,8,16] days and box 5 caps at 16", () => {
  assert.deepEqual(L.INTERVALS, [1, 2, 4, 8, 16]);
});

test("good grades climb 1→2→3→4→5 and stay at 5", () => {
  let c = card();
  for (const [box, days] of [[2, 2], [3, 4], [4, 8], [5, 16], [5, 16]]) {
    c = L.grade(c, true, T0);
    assert.equal(c.box, box);
    assert.equal(c.nextDueAt, T0 + days * DAY);
  }
});

test("a wrong answer sends any box back to 1, due tomorrow", () => {
  const c = L.grade(card({ box: 4 }), false, T0);
  assert.equal(c.box, 1);
  assert.equal(c.nextDueAt, T0 + 1 * DAY);
});

test("grade returns a NEW object and stamps lastGradedAt + history", () => {
  const before = card();
  const after = L.grade(before, true, T0);
  assert.notEqual(after, before);
  assert.equal(before.box, 1); // input untouched
  assert.equal(after.lastGradedAt, T0);
  assert.deepEqual(after.history, [{ at: T0, ok: true }]);
});

test("history keeps only the last 20 grades", () => {
  let c = card();
  for (let i = 0; i < 25; i++) c = L.grade(c, i % 2 === 0, T0 + i);
  assert.equal(c.history.length, 20);
  assert.equal(c.history[0].at, T0 + 5); // oldest 5 dropped
});

test("dueCards: due exactly now counts, future does not, missing nextDueAt counts", () => {
  const cs = [card({ nextDueAt: T0 }), card({ nextDueAt: T0 + 1 }), card({ nextDueAt: undefined })];
  assert.deepEqual(L.dueCards(cs, T0).map((c) => c.nextDueAt), [T0, undefined]);
});

test("due math across a day boundary: graded at 23:59 is due next day, not same day", () => {
  const lateNight = T0; // any instant — intervals are pure ms, no calendar rounding
  const c = L.grade(card(), true, lateNight); // box 2 → +2 days
  assert.equal(c.nextDueAt - lateNight, 2 * DAY);
});

test("sessionOrder: lowest box first, then oldest due, then word (stable)", () => {
  const cs = [
    card({ word: "b", box: 2, nextDueAt: T0 }),
    card({ word: "c", box: 1, nextDueAt: T0 + 5 }),
    card({ word: "a", box: 1, nextDueAt: T0 }),
    card({ word: "d", box: 1, nextDueAt: T0 }),
  ];
  assert.deepEqual(L.sessionOrder(cs).map((c) => c.word), ["a", "d", "c", "b"]);
});
