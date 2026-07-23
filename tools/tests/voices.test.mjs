import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/voices.js";

const V = globalThis.SV_VOICES;

test("single-voice mode always returns the user's voice", () => {
  assert.equal(V.voiceForSpeaker({ id: 3, g: "m" }, "coral", false), "coral");
  assert.equal(V.voiceForSpeaker(undefined, "coral", true), "coral");
});

test("speaker 1 (or untagged) keeps the user's voice even in multi-voice", () => {
  assert.equal(V.voiceForSpeaker({ id: 1, g: "f" }, "marin", true), "marin");
  assert.equal(V.voiceForSpeaker({ id: 0, g: "?" }, "marin", true), "marin");
});

test("multi-voice: same speaker id → same voice, and never the user's voice", () => {
  const a = V.voiceForSpeaker({ id: 2, g: "m" }, "marin", true);
  const b = V.voiceForSpeaker({ id: 2, g: "m" }, "marin", true);
  assert.equal(a, b);
  assert.notEqual(a, "marin");
});

test("multi-voice: gender guess picks from the matching palette", () => {
  assert.ok(["cedar", "onyx", "echo"].includes(V.voiceForSpeaker({ id: 2, g: "m" }, "marin", true)));
  assert.ok(["coral", "shimmer"].includes(V.voiceForSpeaker({ id: 2, g: "f" }, "marin", true)));
});

test("instructions flag questions, shouting, asides, and Persian", () => {
  assert.match(V.ttsInstructions("چطوری؟", "fa"), /question/i);
  assert.match(V.ttsInstructions("چطوری؟", "fa"), /Persian/);
  assert.match(V.ttsInstructions("RUN! NOW!", "en"), /energy/i);
  assert.match(V.ttsInstructions("(whispering) come here", "en"), /softly/i);
  assert.doesNotMatch(V.ttsInstructions("Hello there.", "de"), /question|energy|softly/i);
});

test("estimate: 20 minutes of speech ≈ $0.30", () => {
  assert.ok(Math.abs(V.dubEstimateUSD(20 * 60000) - 0.30) < 1e-9);
});
