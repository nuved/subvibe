// tools/tests/shot.test.mjs — pure helpers for the Shot feature (shared/shot.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/shot.js";

const S = globalThis.SV_SHOT;

// ── planTiles ────────────────────────────────────────────────────────────────
test("planTiles: a range that fits one viewport is a single tile at its top", () => {
  assert.deepEqual(S.planTiles(0, 500, 800, 2000), { offsets: [0], truncated: false });
  assert.deepEqual(S.planTiles(300, 900, 800, 2000), { offsets: [300], truncated: false });
});

test("planTiles: exact multiple of the viewport → no overlap", () => {
  assert.deepEqual(S.planTiles(0, 1600, 800, 2000).offsets, [0, 800]);
});

test("planTiles: remainder → last tile bottom-aligned (overlaps the previous one)", () => {
  assert.deepEqual(S.planTiles(0, 2000, 800, 1200).offsets, [0, 800, 1200]);
});

test("planTiles: offsets are clamped to [0, maxScroll]", () => {
  assert.deepEqual(S.planTiles(100, 900, 800, 0).offsets, [0]);
  assert.deepEqual(S.planTiles(0, 2000, 800, 1000).offsets, [0, 800, 1000]);
});

test("planTiles: caps at maxTiles and flags truncation", () => {
  const r = S.planTiles(0, 800 * 50, 800, 1e6);
  assert.equal(r.truncated, true);
  assert.equal(r.offsets.length, S.MAX_TILES);
  assert.equal(S.MAX_TILES, 25);
  const small = S.planTiles(0, 800 * 3, 800, 1e6, 2);
  assert.deepEqual(small, { offsets: [0, 800], truncated: true });
});

// ── stitchLayout ─────────────────────────────────────────────────────────────
test("stitchLayout: single tile crop at dpr 1 and 2", () => {
  const rect = { x: 100, y: 50, w: 300, h: 200 };
  const vp = { w: 1280, h: 800 };
  const one = S.stitchLayout(rect, [0], vp, 0, 1);
  assert.equal(one.width, 300); assert.equal(one.height, 200);
  assert.deepEqual(one.ops, [{ i: 0, sx: 100, sy: 50, sw: 300, sh: 200, dx: 0, dy: 0 }]);
  const two = S.stitchLayout(rect, [0], vp, 0, 2);
  assert.equal(two.width, 600); assert.equal(two.height, 400);
  assert.deepEqual(two.ops, [{ i: 0, sx: 200, sy: 100, sw: 600, sh: 400, dx: 0, dy: 0 }]);
});

test("stitchLayout: overlapping tiles paint each document row once", () => {
  const rect = { x: 0, y: 0, w: 1000, h: 1200 };
  const vp = { w: 1280, h: 800 };
  const r = S.stitchLayout(rect, [0, 400], vp, 0, 1);
  assert.deepEqual(r.ops, [
    { i: 0, sx: 0, sy: 0, sw: 1000, sh: 800, dx: 0, dy: 0 },
    { i: 1, sx: 0, sy: 400, sw: 1000, sh: 400, dx: 0, dy: 800 },
  ]);
});

test("stitchLayout: a rect wider than the viewport clips to what was captured; horizontal scroll shifts sx", () => {
  const r = S.stitchLayout({ x: 200, y: 0, w: 2000, h: 100 }, [0], { w: 1280, h: 800 }, 0, 1);
  assert.equal(r.ops[0].sw, 1080);
  const s = S.stitchLayout({ x: 300, y: 0, w: 100, h: 100 }, [0], { w: 1280, h: 800 }, 250, 1);
  assert.equal(s.ops[0].sx, 50);
});

test("stitchLayout: tiles that don't intersect the rect produce no op", () => {
  const r = S.stitchLayout({ x: 0, y: 1000, w: 100, h: 100 }, [0, 800], { w: 1280, h: 800 }, 0, 1);
  assert.deepEqual(r.ops.map((o) => o.i), [1]);
});

// ── prepBlocks ───────────────────────────────────────────────────────────────
const blk = (id, text) => ({ id, text, rect: { x: 0, y: 0, w: 10, h: 10 } });

test("prepBlocks: normalises whitespace, drops non-text, keeps order", () => {
  const r = S.prepBlocks([blk("b0", "  Hallo\n   Welt "), blk("b1", "42"), blk("b2", "4a"), blk("b3", "x")]);
  assert.deepEqual(r.keep.map((b) => b.id), ["b0", "b2"]);
  assert.deepEqual(r.lines, ["Hallo Welt", "4a"]);
  assert.deepEqual(r.lineOf, [0, 1]);
  assert.equal(r.truncated, "");
});

test("prepBlocks: identical texts share one line", () => {
  const r = S.prepBlocks([blk("b0", "Politik"), blk("b1", "Politik"), blk("b2", "Kultur")]);
  assert.deepEqual(r.lines, ["Politik", "Kultur"]);
  assert.deepEqual(r.lineOf, [0, 0, 1]);
});

test("prepBlocks: caps blocks and characters with truncated:'text'", () => {
  const many = Array.from({ length: 401 }, (_, i) => blk("b" + i, "Satz " + i));
  const r = S.prepBlocks(many);
  assert.equal(r.keep.length, S.MAX_BLOCKS);
  assert.equal(r.truncated, "text");
  const big = Array.from({ length: 5 }, (_, i) => blk("b" + i, ("w" + i).padEnd(5000, "a")));
  const c = S.prepBlocks(big);
  assert.equal(c.keep.length, 4); // 4 × 5000 = 20 000 fits, the fifth would exceed
  assert.equal(c.truncated, "text");
  assert.equal(S.prepBlocks(big.slice(0, 4)).truncated, "");
});

// ── mapTranslations ──────────────────────────────────────────────────────────
test("mapTranslations: aligns by lineOf and counts missing", () => {
  const keep = [blk("b0", "Politik"), blk("b1", "Politik"), blk("b2", "Kultur")];
  const r = S.mapTranslations(keep, [0, 0, 1], ["سیاست"]);
  assert.deepEqual(r.blocks.map((b) => b.tr), ["سیاست", "سیاست", ""]);
  assert.equal(r.missing, 1);
  assert.equal(r.blocks[2].text, "Kultur");
  assert.deepEqual(r.blocks[2].rect, keep[2].rect);
});

// ── small rules ──────────────────────────────────────────────────────────────
test("isBilingualBlock: four words or more", () => {
  assert.equal(S.isBilingualBlock("Mehr Geld für"), false);
  assert.equal(S.isBilingualBlock("Mehr Geld für Bildung"), true);
  assert.equal(S.MIN_WORDS_BILINGUAL, 4);
});

test("isRtl: right-to-left languages by base code", () => {
  for (const l of ["fa", "ar", "he", "ur", "fa-IR", "AR"]) assert.equal(S.isRtl(l), true, l);
  for (const l of ["de", "en", "", undefined, "zh"]) assert.equal(S.isRtl(l), false, String(l));
});

// ── frameLayout ──────────────────────────────────────────────────────────────
test("frameLayout: plain is the bare image, card adds padding, radius and a badge", () => {
  const plain = S.frameLayout({ w: 560, h: 400, frame: "plain" });
  assert.deepEqual(plain, { width: 560, height: 400, img: { x: 0, y: 0, w: 560, h: 400, radius: 0 }, badge: null });
  const card = S.frameLayout({ w: 560, h: 400, frame: "card" });
  assert.equal(card.width, 560 + 96); assert.equal(card.height, 400 + 96);
  assert.deepEqual(card.img, { x: 48, y: 48, w: 560, h: 400, radius: 16 });
  assert.ok(card.badge && card.badge.x > 0 && card.badge.y > card.img.y + card.img.h);
  const nb = S.frameLayout({ w: 560, h: 400, frame: "card", badge: false });
  assert.equal(nb.badge, null);
  const hi = S.frameLayout({ w: 560, h: 400, frame: "card", dpr: 2 });
  assert.equal(hi.img.x, 96); assert.equal(hi.img.radius, 32);
});

// ── filename / exportScale ───────────────────────────────────────────────────
test("filename: host sanitised, local time, size suffix and extension", () => {
  const ts = new Date(2026, 7, 24, 14, 7).getTime();
  assert.equal(S.filename({ host: "www.spiegel.de", ts, view: "translated" }), "subvibe-spiegel-de-20260824-1407-translated.png");
  assert.equal(S.filename({ host: "X.com", ts, view: "original", size: "2x", format: "jpeg" }), "subvibe-x-com-20260824-1407-original-2x.jpg");
  assert.equal(S.filename({ host: "de.wikipedia.org", ts, view: "bilingual", size: "half" }), "subvibe-de-wikipedia-org-20260824-1407-bilingual-half.png");
  assert.equal(S.filename({ host: "", ts, view: "translated" }), "subvibe-page-20260824-1407-translated.png");
});

test("exportScale: native is 1, others are CSS-pixel multiples divided by dpr", () => {
  assert.equal(S.exportScale("native", 2), 1);
  assert.equal(S.exportScale("2x", 2), 1);
  assert.equal(S.exportScale("1x", 2), 0.5);
  assert.equal(S.exportScale("half", 1), 0.5);
  assert.equal(S.exportScale("bogus", 2), 1);
});

// ── validateRecord / newId ───────────────────────────────────────────────────
function goodRecord() {
  return {
    id: "abc-123", ts: 1, url: "https://www.spiegel.de/x", title: "T", host: "www.spiegel.de", source: "de", target: "fa",
    mode: "area", layout: "translated", dpr: 2, rect: { x: 10, y: 20, w: 560, h: 400 }, w: 560, h: 400,
    original: new Blob(["a"]), variant: new Blob(["b"]),
    blocks: [{ id: "b0", text: "Politik", tr: "سیاست", rect: { x: 0, y: 0, w: 1, h: 1 } }],
    partial: false, truncated: "", tabId: 1, windowId: 1,
  };
}

test("validateRecord: accepts a good record, rejects broken ones", () => {
  const ok = goodRecord();
  assert.equal(S.validateRecord(ok), ok);
  const noBlob = goodRecord(); noBlob.variant = "nope";
  assert.throws(() => S.validateRecord(noBlob), /bad-record/);
  const noVariant = goodRecord(); delete noVariant.variant;
  assert.throws(() => S.validateRecord(noVariant), /bad-record/);
  const nullOriginal = goodRecord(); nullOriginal.original = null; // multi-tile shot: original rendered via re-shoot
  assert.equal(S.validateRecord(nullOriginal), nullOriginal);
  const badOriginal = goodRecord(); badOriginal.original = "nope";
  assert.throws(() => S.validateRecord(badOriginal), /bad-record/);
  const badBlocks = goodRecord(); badBlocks.blocks = "x";
  assert.throws(() => S.validateRecord(badBlocks), /bad-record/);
  const badBlock = goodRecord(); badBlock.blocks = [{ id: "b0", text: "x" }];
  assert.throws(() => S.validateRecord(badBlock), /bad-record/);
  const zero = goodRecord(); zero.w = 0;
  const noRect = goodRecord(); delete noRect.rect;
  assert.throws(() => S.validateRecord(noRect), /bad-record/);
  assert.throws(() => S.validateRecord(zero), /bad-record/);
  assert.throws(() => S.validateRecord(null), /bad-record/);
});

test("newId: unique-looking, url-safe", () => {
  const a = S.newId(), b = S.newId();
  assert.notEqual(a, b);
  assert.match(a, /^[a-z0-9]+-[a-z0-9]{6}$/);
});

test("splitSentences: sentence-aligned pairing input", () => {
  assert.deepEqual(S.splitSentences("Hello world. How are you? I am fine!"),
    ["Hello world.", "How are you?", "I am fine!"]);
  // Persian: two sentences ending in Latin '.'
  const fa = "من قبلاً مقایسه کردم، چون شباهت دیده می‌شود. احتمال وقوع را تصور می‌کنم.";
  assert.equal(S.splitSentences(fa).length, 2);
  // no terminator → one sentence; empty → none
  assert.deepEqual(S.splitSentences("just one line"), ["just one line"]);
  assert.deepEqual(S.splitSentences("   "), []);
  // whitespace is normalized, terminators kept
  assert.deepEqual(S.splitSentences("A.\n\nB."), ["A.", "B."]);
});

// ── crop (non-destructive: rect normalized to the full image) ────────────────
test("normCrop: null/degenerate/out-of-range all collapse to the full image", () => {
  const full = { x: 0, y: 0, w: 1, h: 1 };
  assert.deepEqual(S.normCrop(null), full);
  assert.deepEqual(S.normCrop(undefined), full);
  assert.deepEqual(S.normCrop({ x: 0.4, y: 0.4, w: 0.001, h: 0.5 }), full); // sliver
  assert.deepEqual(S.normCrop({ x: 2, y: 2, w: 1, h: 1 }), full);           // fully outside
});

test("normCrop: clamps a rect that hangs past the right/bottom edge", () => {
  assert.deepEqual(S.normCrop({ x: 0.8, y: 0.9, w: 0.5, h: 0.5 }),
    { x: 0.8, y: 0.9, w: 0.19999999999999996, h: 0.09999999999999998 });
});

test("cropSrc: source-pixel rect for drawImage, full image when crop is null", () => {
  assert.deepEqual(S.cropSrc(null, 1000, 800), { sx: 0, sy: 0, sw: 1000, sh: 800 });
  assert.deepEqual(S.cropSrc({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 1000, 800),
    { sx: 250, sy: 400, sw: 500, sh: 200 });
});

test("cropToView/viewToCrop: identity mapping with no crop", () => {
  const img = { x: 10, y: 20, w: 200, h: 100 };
  assert.deepEqual(S.cropToView({ x: 0.5, y: 0.5 }, img, null), [110, 70]);
  assert.deepEqual(S.viewToCrop(110, 70, img, null), { x: 0.5, y: 0.5 });
});

test("cropToView: a point at the crop's corners lands on the image box corners", () => {
  const img = { x: 0, y: 0, w: 400, h: 300 };
  const crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  assert.deepEqual(S.cropToView({ x: 0.25, y: 0.25 }, img, crop), [0, 0]);
  assert.deepEqual(S.cropToView({ x: 0.75, y: 0.75 }, img, crop), [400, 300]);
  assert.deepEqual(S.cropToView({ x: 0.5, y: 0.5 }, img, crop), [200, 150]);
});

test("viewToCrop: inverse of cropToView, clamped to the crop window", () => {
  const img = { x: 50, y: 60, w: 400, h: 300 };
  const crop = { x: 0.2, y: 0.1, w: 0.6, h: 0.8 };
  const [px, py] = S.cropToView({ x: 0.5, y: 0.5 }, img, crop);
  const back = S.viewToCrop(px, py, img, crop);
  assert.ok(Math.abs(back.x - 0.5) < 1e-9 && Math.abs(back.y - 0.5) < 1e-9);
  // a pointer outside the image box clamps to the crop bounds, not 0..1
  assert.deepEqual(S.viewToCrop(-999, -999, img, crop), { x: 0.2, y: 0.1 });
  const hi = S.viewToCrop(9999, 9999, img, crop);
  assert.ok(Math.abs(hi.x - 0.8) < 1e-9 && Math.abs(hi.y - 0.9) < 1e-9);
});
