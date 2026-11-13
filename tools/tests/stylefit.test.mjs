// tools/tests/stylefit.test.mjs — the "fits this video" style suggestion (shared/stylefit.js) on synthetic frames.
import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/stylefit.js";

const F = globalThis.SV_STYLEFIT;
// A w×h frame whose pixel colour comes from fn(x, y) → [r, g, b].
function frame(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = fn(x, y), i = (y * w + x) * 4; data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
  return { data, w, h };
}

test("a flat black frame (protected video) gets no suggestion", () => {
  assert.equal(F.suggest(frame(160, 90, () => [0, 0, 0])).protected, true);
});
test("a bright bottom gets the dark box", () => {
  const s = F.suggest(frame(160, 90, (x, y) => (y > 50 ? [235, 230, 220] : [60, 60, 60])));
  assert.equal(s.preset, "classic"); assert.match(s.why, /bright/);
});
test("a dark calm bottom gets Cinema", () => {
  const s = F.suggest(frame(160, 90, (x, y) => (y > 50 ? [20, 22, 30] : [120, 110, 100])));
  assert.equal(s.preset, "cinema");
});
test("a busy bottom gets a box per line", () => {
  const s = F.suggest(frame(160, 90, (x) => ((x >> 1) % 2 ? [200, 200, 200] : [40, 40, 40])));
  assert.equal(s.preset, "youtube");
});
test("an upright video gets TikTok", () => {
  assert.equal(F.suggest(frame(90, 160, () => [100, 90, 80])).preset, "tiktok");
});
test("the highlight sits opposite the picture's colour", () => {
  assert.equal(F.suggest(frame(160, 90, () => [200, 80, 40])).hl, "neon-cyan");   // warm
  assert.equal(F.suggest(frame(160, 90, () => [40, 160, 60])).hl, "neon-magenta"); // green
  assert.equal(F.suggest(frame(160, 90, () => [30, 70, 190])).hl, "ember");        // blue
  assert.equal(F.suggest(frame(160, 90, () => [120, 120, 120])).hl, "classic");    // grey
});
test("black bars baked into a wide film are not read as a busy bottom", () => {
  const s = F.suggest(frame(160, 90, (x, y) => (y < 12 || y > 77 ? [0, 0, 0] : y > 55 ? [18, 20, 26] : [110, 100, 90])));
  assert.equal(s.preset, "cinema");
});
