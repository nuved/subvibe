// Separate file (Node's test runner runs each file in its own process) so
// loading shared/langs.js here never leaks svLangMeta into share.test.mjs,
// which deliberately tests the fallback (no-langMeta) path.
import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/langs.js";
import "../../shared/share.js";

const S = globalThis.SV_SHARE;

test("exportDeck: filename uses the langMeta display name when shared/langs.js is loaded", () => {
  const r = S.exportDeck([{ word: "Haus", meaning: "house" }], "de", { name: "Nima" });
  assert.equal(r.filename, "German-by-Nima.svbox");
});

test("exportDeck: filename falls back to svLangMeta's own uppercased-code fallback for an unknown lang", () => {
  // svLangMeta's fallback for an unrecognized code returns [code, code.toUpperCase(), flag] —
  // share.js takes that display name verbatim (it's app-internal, not attacker-controlled),
  // so "xx" reads "XX" here, not share.js's own "Xx" capitalize-first-letter fallback.
  const r = S.exportDeck([{ word: "a", meaning: "m" }], "xx", {});
  assert.equal(r.filename, "XX.svbox");
});

test("exportDeck: filename guards a leading '-' even from a hostile/misbehaving svLangMeta", () => {
  const original = globalThis.svLangMeta;
  globalThis.svLangMeta = () => ["de", "-hacked", "🏳️"];
  try {
    const r = S.exportDeck([{ word: "a", meaning: "m" }], "de", {});
    assert.ok(!r.filename.startsWith("-"), "filename must never start with a dash");
    assert.equal(r.filename, "_-hacked.svbox");
  } finally {
    globalThis.svLangMeta = original;
  }
});

test("exportDeck: round-trips through validateImport with the langMeta filename path active", () => {
  const { text, filename } = S.exportDeck([{ word: "Haus", meaning: "house" }], "de", { name: "Nima" });
  assert.equal(filename, "German-by-Nima.svbox");
  const r = S.validateImport(text);
  assert.equal(r.ok, true);
  assert.equal(r.cards.length, 1);
});
