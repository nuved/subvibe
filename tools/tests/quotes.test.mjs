import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/quotes.js";

const Q = globalThis.SV_QUOTES;

test("German-style quotes in a translated line become the target's convention", () => {
  assert.equal(Q.fix("„He stammers when he is nervous.“", "en"), "“He stammers when he is nervous.”");
  assert.equal(Q.fix("„He stammers when he is nervous.“", "fa"), "«He stammers when he is nervous.»");
  assert.equal(Q.fix("Er sagte: „ja“ und „nein“.", "en"), "Er sagte: “ja” und “nein”.");
});

test("lines without the German open-quote marker pass through untouched", () => {
  assert.equal(Q.fix("“Already correct.”", "en"), "“Already correct.”");
  assert.equal(Q.fix("No quotes at all", "fa"), "No quotes at all");
  assert.equal(Q.fix("", "en"), "");
  assert.equal(Q.fix(null, "en"), null);
});

test("unpaired German open-quote still converts", () => {
  assert.equal(Q.fix("„Half a quote", "en"), "“Half a quote");
  assert.equal(Q.fix("„Half a quote", "fa"), "«Half a quote");
});
