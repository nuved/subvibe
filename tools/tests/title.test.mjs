import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/title.js";

const clean = globalThis.SV_TITLE.clean;

test("strips a tab notification counter and the YouTube suffix", () => {
  assert.equal(clean("(4) Barack Obama | Full Episode - YouTube"), "Barack Obama | Full Episode");
});
test("counter alone is stripped even without the suffix", () => {
  assert.equal(clean("(99) Some clip"), "Some clip");
});
test("a 4-digit '(2024)' year prefix is NOT a counter", () => {
  assert.equal(clean("(2024) Year in review - YouTube"), "(2024) Year in review");
});
test("RTL Persian title with a counter", () => {
  assert.equal(clean("(4) ورزش زبان با shadowing"), "ورزش زبان با shadowing");
});
test("plain titles pass through untouched", () => {
  assert.equal(clean("Deine Liebe, Mein Atem"), "Deine Liebe, Mein Atem");
});
test("counter with nothing after it survives (never clean to empty)", () => {
  assert.equal(clean("(99) "), "(99)");
});
test("null/undefined → empty string", () => {
  assert.equal(clean(null), "");
});
