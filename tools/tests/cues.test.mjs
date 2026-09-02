// tools/tests/cues.test.mjs — overlay cue helpers (shared/cues.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/cues.js";

const C = globalThis.SV_CUES;
const cue = (startMs, endMs, words) => ({ startMs, endMs, text: words.map((x) => x[1]).join(" "), w: words.map(([o, t]) => ({ o, t })) });

test("splitAtPauses: a YouTube window that spans a pause becomes one line per spoken phrase", () => {
  // "Schlüssel" (tail of the previous item) · pause · "eine Tasse" · pause · "die" (head of the next)
  const c = cue(10000, 14000, [[0, "Schlüssel"], [1200, "eine"], [1500, "Tasse"], [2900, "die"]]);
  const out = C.splitAtPauses(c);
  assert.deepEqual(out.map((p) => p.text), ["Schlüssel", "eine Tasse", "die"]);
  assert.deepEqual(out.map((p) => [p.startMs, p.endMs]), [[10000, 11199], [11200, 12899], [12900, 14000]]);
  assert.deepEqual(out[1].w, [{ o: 0, t: "eine" }, { o: 300, t: "Tasse" }], "word offsets re-based to the piece");
});

test("splitAtPauses: continuous speech stays one cue; no word timing stays as is", () => {
  const flowing = cue(0, 3000, [[0, "wir"], [250, "gehen"], [520, "heute"], [800, "nach"], [1000, "Hause"]]);
  assert.equal(C.splitAtPauses(flowing).length, 1);
  assert.deepEqual(C.splitAtPauses(flowing)[0], flowing);
  const plain = { startMs: 0, endMs: 2000, text: "no timing here" };
  assert.deepEqual(C.splitAtPauses(plain), [plain]);
  assert.deepEqual(C.splitAtPauses({ startMs: 0, endMs: 2000, text: "one", w: [{ o: 0, t: "one" }] }).length, 1);
});

test("splitAtPauses: a long run cuts at the next soft gap once it passes maxChars", () => {
  const words = []; let t = 0;
  for (let i = 0; i < 16; i++) { words.push([t, "wort" + i]); t += i === 9 ? 400 : 250; } // one 400 ms breath after the 10th word
  const out = C.splitAtPauses(cue(0, 6000, words), { maxChars: 40 });
  assert.equal(out.length, 2);
  assert.equal(out[0].w.length, 10, "cut at the breath after passing 40 chars");
  assert.ok(out[0].endMs < out[1].startMs);
});
