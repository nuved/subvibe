import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/textslice.js";

const S = globalThis.SV_TEXTSLICE;

test("distributes every word, in order, proportionally to original lengths", () => {
  const parts = S.split("a b c d e f g h", [40, 40, 20]);
  assert.equal(parts.length, 3);
  assert.equal(parts.join(" "), "a b c d e f g h"); // nothing lost, order kept
  assert.ok(parts[0].split(" ").length >= parts[2].split(" ").length, "bigger cue gets more words");
});

test("edge cases: single cue, empty text, more cues than words, zero weights", () => {
  assert.deepEqual(S.split("hello world", [10]), ["hello world"]);
  assert.deepEqual(S.split("", [10, 20]), ["", ""]);
  assert.deepEqual(S.split(null, [10, 20]), ["", ""]);
  const sparse = S.split("one two", [5, 5, 5, 5]);
  assert.equal(sparse.length, 4);
  assert.equal(sparse.filter(Boolean).join(" "), "one two");
  const zeros = S.split("x y z", [0, 0, 0]);
  assert.equal(zeros.join(" ").trim().replace(/\s+/g, " "), "x y z");
  assert.deepEqual(S.split("anything", []), []);
});

test("Persian text splits on spaces like any other", () => {
  const parts = S.split("بله ذهنم منفجر شد بسیار متشکرم", [10, 10]);
  assert.equal(parts.length, 2);
  assert.equal(parts.join(" "), "بله ذهنم منفجر شد بسیار متشکرم");
  assert.ok(parts[0] && parts[1], "both cues get a share");
});
