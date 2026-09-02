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
  assert.deepEqual(S.splitSentences("Go.\n\nStop."), ["Go.", "Stop."]);
  // inner dots never lose text (the old match-based regex dropped "Das gilt z.")
  assert.deepEqual(S.splitSentences("Kostet 3.5 Euro. Siehe www.beispiel.de. Ende."), ["Kostet 3.5 Euro.", "Siehe www.beispiel.de.", "Ende."]);
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

// ── splitSentences: abbreviations, initials, ordinal dates ───────────────────
test("splitSentences: a period after an abbreviation, an initial or a short number does not end the sentence", () => {
  assert.deepEqual(S.splitSentences("Dr. Anna Meier vom Senat sagt, dass es geht. Die ersten Bäume kommen im Herbst."),
    ["Dr. Anna Meier vom Senat sagt, dass es geht.", "Die ersten Bäume kommen im Herbst."]);
  assert.deepEqual(S.splitSentences("Von Lena Hartmann · 2. September 2026"), ["Von Lena Hartmann · 2. September 2026"]);
  assert.deepEqual(S.splitSentences("J. K. Rowling wrote it. It sold well."), ["J. K. Rowling wrote it.", "It sold well."]);
  assert.deepEqual(S.splitSentences("Das gilt z.B. für Berlin, bzw. für Wien. Paris auch."), ["Das gilt z.B. für Berlin, bzw. für Wien.", "Paris auch."]);
  assert.deepEqual(S.splitSentences("We met Mr. Smith at 5 p.m. today. He left."), ["We met Mr. Smith at 5 p.m. today.", "He left."]);
  // sentence-ending cases stay split: years, etc., ordinary words
  assert.deepEqual(S.splitSentences("It was founded in 1999. It grew fast."), ["It was founded in 1999.", "It grew fast."]);
  assert.deepEqual(S.splitSentences("Bring pens, paper etc. We start at nine."), ["Bring pens, paper etc.", "We start at nine."]);
  // a trailing abbreviation with nothing after it stays as it is
  assert.deepEqual(S.splitSentences("Ask Dr."), ["Ask Dr."]);
  // "?" and "!" are never joined
  assert.deepEqual(S.splitSentences("Really, Dr.? Yes."), ["Really, Dr.?", "Yes."]);
});

// ── frameLayout: window chrome ───────────────────────────────────────────────
test("frameLayout: window = card + a 36px title bar above the image, badge below", () => {
  const win = S.frameLayout({ w: 560, h: 400, frame: "window" });
  assert.equal(win.width, 560 + 96);
  assert.equal(win.height, 400 + 96 + 36);
  assert.deepEqual(win.bar, { x: 48, y: 48, w: 560, h: 36, radius: 16 });
  assert.deepEqual(win.img, { x: 48, y: 48 + 36, w: 560, h: 400, radius: 16 });
  assert.ok(win.badge && win.badge.y > win.img.y + win.img.h);
  const hi = S.frameLayout({ w: 560, h: 400, frame: "window", dpr: 2 });
  assert.equal(hi.bar.h, 72); assert.equal(hi.img.y, 96 + 72);
  const card = S.frameLayout({ w: 560, h: 400, frame: "card" });
  assert.equal(card.bar, null);
  assert.equal(S.frameLayout({ w: 560, h: 400, frame: "plain" }).bar, undefined);
});

// ── bilingual page layouts ───────────────────────────────────────────────────
test("sideBySide: tops aligned, gap between, height = the taller page", () => {
  const l = S.sideBySide({ w: 700, h: 900 }, { w: 700, h: 1100 }, 40);
  assert.equal(l.width, 1440); assert.equal(l.height, 1100);
  assert.deepEqual(l.a, { x: 0, y: 0, w: 700, h: 900 });
  assert.deepEqual(l.b, { x: 740, y: 0, w: 700, h: 1100 });
});

test("layoutNotes: notes sit level with their block unless the previous note is in the way", () => {
  const r = S.layoutNotes([{ y: 0, h: 50 }, { y: 20, h: 40 }, { y: 200, h: 30 }], 10);
  assert.deepEqual(r.tops, [0, 60, 200]);
  assert.equal(r.bottom, 230);
  assert.deepEqual(S.layoutNotes([], 10), { tops: [], bottom: 0 });
});

// ── annotation geometry ──────────────────────────────────────────────────────
test("annBounds: every tool yields a box in full-image fractions", () => {
  assert.deepEqual(S.annBounds({ tool: "rect", a: { x: 0.75, y: 0.75 }, b: { x: 0.25, y: 0.25 } }), { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  assert.deepEqual(S.annBounds({ tool: "pen", pts: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.125 }] }), { x: 0.25, y: 0.125, w: 0.5, h: 0.375 });
  assert.deepEqual(S.annBounds({ tool: "num", at: { x: 0.5, y: 0.5 }, r: 0.03125 }), { x: 0.46875, y: 0.46875, w: 0.0625, h: 0.0625 });
  assert.deepEqual(S.annBounds({ tool: "text", at: { x: 0.1, y: 0.1 }, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.03 } }), { x: 0.1, y: 0.1, w: 0.2, h: 0.03 });
  assert.deepEqual(S.annBounds({ tool: "textmark", boxes: [{ x: 0.125, y: 0.125, w: 0.5, h: 0.03125 }, { x: 0.125, y: 0.15625, w: 0.25, h: 0.03125 }] }), { x: 0.125, y: 0.125, w: 0.5, h: 0.0625 });
  assert.equal(S.annBounds(null), null);
});

test("hitAnnot: strokes hit along the line, boxes inside, topmost wins", () => {
  const rect = { tool: "rect", a: { x: 0.1, y: 0.1 }, b: { x: 0.3, y: 0.3 } };
  const pen = { tool: "pen", size: 0.006, pts: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }] };
  const num = { tool: "num", at: { x: 0.5, y: 0.5 }, r: 0.02 };
  const blur = { tool: "blur", a: { x: 0.6, y: 0.2 }, b: { x: 0.8, y: 0.4 } };
  const annots = [rect, pen, num, blur];
  assert.equal(S.hitAnnot(annots, { x: 0.2, y: 0.2 }), 1, "the diagonal pen crosses the rect and is on top");
  assert.equal(S.hitAnnot(annots, { x: 0.12, y: 0.25 }), 0, "inside the rect, off the pen line");
  assert.equal(S.hitAnnot(annots, { x: 0.5, y: 0.1 }), -1, "inside the pen's bounding box but far from its line");
  assert.equal(S.hitAnnot(annots, { x: 0.505, y: 0.5 }), 2);
  assert.equal(S.hitAnnot(annots, { x: 0.6, y: 0.5 }), -1);
  assert.equal(S.hitAnnot(annots, { x: 0.7, y: 0.3 }), 3);
  // ky: a tall image (h = 3w) makes a y-fraction three times longer — 0.01 in y is 0.03 on screen
  assert.equal(S.hitAnnot([rect], { x: 0.2, y: 0.31 }, { tol: 0.012, ky: 3 }), -1);
  assert.equal(S.hitAnnot([rect], { x: 0.2, y: 0.31 }, { tol: 0.012, ky: 1 }), 0);
  assert.equal(S.hitAnnot([], { x: 0.2, y: 0.2 }), -1);
});

test("moveAnnot shifts every stored point; renumber restores 1, 2, 3", () => {
  const m = S.moveAnnot({ tool: "pen", pts: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }, 0.05, -0.05);
  assert.deepEqual(m.pts, [{ x: 0.15000000000000002, y: 0.05 }, { x: 0.25, y: 0.15000000000000002 }]);
  const r = S.moveAnnot({ tool: "rect", a: { x: 0.1, y: 0.1 }, b: { x: 0.3, y: 0.3 } }, 0.1, 0.1);
  assert.deepEqual([r.a, r.b], [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 }]);
  const t = S.moveAnnot({ tool: "text", at: { x: 0.1, y: 0.1 }, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.03 } }, 0.1, 0);
  assert.deepEqual([t.at, t.box], [{ x: 0.2, y: 0.1 }, { x: 0.2, y: 0.1, w: 0.2, h: 0.03 }]);
  const list = [{ tool: "num", n: 1 }, { tool: "rect" }, { tool: "num", n: 3 }];
  S.renumber(list);
  assert.deepEqual(list.map((a) => a.n), [1, undefined, 2]);
});

// ── distributeTranslation ────────────────────────────────────────────────────
test("distributeTranslation: each sentence's translation lands on the node where the sentence starts", () => {
  // a tweet: four paragraphs = four text nodes; pairs derived per paragraph
  const nodes = ["Erster Absatz hier.", "Zweiter Absatz:", "Dritter Absatz!", "Vierter."];
  const pairs = [{ o: "Erster Absatz hier.", t: "First paragraph here." }, { o: "Zweiter Absatz:", t: "Second paragraph:" }, { o: "Dritter Absatz!", t: "Third paragraph!" }, { o: "Vierter.", t: "Fourth." }];
  assert.deepEqual(S.distributeTranslation(nodes, pairs), ["First paragraph here.", "Second paragraph:", "Third paragraph!", "Fourth."]);
  // a sentence split across nodes by inline formatting (a <b> run): its translation goes to the
  // node where it STARTS, the bold run is emptied, and the next sentence stays in its own node
  assert.deepEqual(S.distributeTranslation(["Das ist ", "wichtig", " für alle. Ende."], [{ o: "Das ist wichtig für alle.", t: "This matters to all." }, { o: "Ende.", t: "End." }]),
    ["This matters to all.", "", "End."]);
  // two sentences in one node, one in the next
  assert.deepEqual(S.distributeTranslation(["A one. B two.", "C three."], [{ o: "A one.", t: "1" }, { o: "B two.", t: "2" }, { o: "C three.", t: "3" }]), ["1 2", "3"]);
  // a pair that can't be located rides with the previous one; nothing placeable → null
  assert.deepEqual(S.distributeTranslation(["Hallo.", "Welt."], [{ o: "Hallo.", t: "Hello." }, { o: "???", t: "stray" }, { o: "Welt.", t: "World." }]), ["Hello. stray", "World."]);
  assert.equal(S.distributeTranslation(["Hallo."], [{ o: "Hallo.", t: "" }]), null);
  assert.equal(S.distributeTranslation([], [{ o: "x", t: "y" }]), null);
});

// ── study card ───────────────────────────────────────────────────────────────
test("studySentences: one side of the pairs in reading order, the other side as meaning, capped", () => {
  const rec = { blocks: [
    { id: "b0", text: "Hallo Welt.", tr: "سلام دنیا.", pairs: [{ o: "Hallo Welt.", t: "سلام دنیا." }] },
    { id: "b1", text: "A. B.", tr: "آ. ب.", pairs: [{ o: "A.", t: "آ." }, { o: "B.", t: "ب." }] },
    { id: "b2", text: "Nur tr.", tr: "فقط ترجمه." }, // no pairs → the block itself
  ] };
  const t = S.studySentences(rec, "target");
  assert.deepEqual(t.blocks.map((b) => b.sentences.map((s) => s.text)), [["سلام دنیا."], ["آ.", "ب."], ["فقط ترجمه."]]);
  assert.equal(t.blocks[1].sentences[0].meaning, "A."); assert.equal(t.count, 4); assert.equal(t.truncated, false);
  const s = S.studySentences(rec, "source", 2);
  assert.deepEqual(s.blocks.map((b) => b.sentences.map((x) => x.text)), [["Hallo Welt."], ["A."]]);
  assert.equal(s.truncated, true); assert.equal(s.blocks[0].sentences[0].i, 0); assert.equal(s.blocks[1].sentences[0].i, 1);
  assert.equal(S.studyKey("de", "fa"), "de|fa");
});

test("buildStudy (v2): tips live on the chunk, marks on the sentences; invalid marks and unknown notes are dropped; skipped sentences fall back", () => {
  const input = { blocks: [{ b: "b0", sentences: [{ i: 0, text: "Das Modell hat gebrochen.", meaning: "مدل شکست." }, { i: 1, text: "Zweiter Satz.", meaning: "دوم." }] }] };
  const out = { blocks: [{ b: "b0", grammar: "Perfekt • Verbklammer", simple: "Das Modell brach. Zweiter Satz.",
    notes: [{ n: 1, term: "Das Modell", pos: "noun", level: "A2", forms: "das Modell · die Modelle", text: "فاعل، خنثی." }, { n: 2, term: "hat … gebrochen", pos: "verb", level: "B1", forms: "brechen · brach · gebrochen · irregular", text: "Perfekt." }, { n: 3, term: "", pos: "x", level: "Z9", forms: "", text: "" }],
    sentences: [{ i: 0, tokens: [{ w: "Das", g: "n", v: 0, n: [1], p: "art" }, { w: "Modell", g: "n", v: 0, n: [1], p: "n" }, { w: "hat", g: "", v: 1, n: [], p: "aux" }, { w: "gebrochen.", g: "x", v: 1, n: [2, 9], p: "v" }] }] }] };
  const blocks = S.buildStudy(input, out, "de");
  assert.equal(blocks.length, 1);
  const b0 = blocks[0];
  assert.equal(b0.grammar, "Perfekt • Verbklammer"); assert.equal(b0.simple, "Das Modell brach. Zweiter Satz.");
  assert.deepEqual(b0.notes.map((x) => [x.n, x.pos, x.level, x.forms]), [[1, "noun", "A2", "das Modell · die Modelle"], [2, "verb", "B1", "brechen · brach · gebrochen · irregular"]], "empty note dropped; pos/level/forms kept");
  const s0 = b0.sentences[0];
  assert.deepEqual(s0.tokens.map((t) => t.g), ["n", "n", "", ""], "invalid gender x dropped");
  assert.deepEqual(s0.tokens.map((t) => t.p), ["art", "n", "aux", "v"], "per-word character kept");
  assert.deepEqual(s0.tokens[3].n, [2], "note 9 does not exist → dropped");
  assert.equal(s0.meaning, "مدل شکست."); assert.equal(s0.simple, undefined, "no per-sentence tips in v2");
  const s1 = b0.sentences[1];
  assert.deepEqual(s1.tokens.map((t) => t.w), ["Zweiter", "Satz."]);
  assert.deepEqual(S.studyMarks(blocks), { m: false, f: false, n: true, v: true, notes: true });
});

test("normalizeStudy: a v1 analysis (tips per sentence) becomes one block per sentence; v2 passes through", () => {
  const v1 = [{ b: "b0", summary: "x", sentences: [{ text: "A.", meaning: "آ.", tokens: [{ w: "A.", g: "", v: 0, n: [1] }], notes: [{ n: 1, term: "A", text: "first" }], simple: "A!", grammar: "g" }, { text: "B.", meaning: "ب.", tokens: [], notes: [], simple: "", grammar: "" }] }];
  const n = S.normalizeStudy(v1);
  assert.equal(n.length, 2); assert.equal(n[0].b, "b0.0"); assert.equal(n[0].simple, "A!"); assert.equal(n[0].grammar, "g"); assert.deepEqual(n[0].notes.map((x) => x.term), ["A"]); assert.equal(n[0].sentences[0].text, "A.");
  const v2 = [{ b: "c0", grammar: "", simple: "", notes: [], sentences: [{ text: "C.", meaning: "", tokens: [] }] }];
  assert.deepEqual(S.normalizeStudy(v2).map((b) => b.b), ["c0"]);
});
test("tipsSheet: explained lines become sentence pairs and a ready-made study card, word notes attached to their tokens", () => {
  const r = S.tipsSheet([
    { s: "Ich muss nach Hause gehen.", tr: "باید برم خونه.", g: "Modal + Infinitiv am Ende.", words: [{ w: "nach Hause", m: "به خانه" }, { w: "gehen", m: "رفتن" }] },
    { s: "", tr: "x" }, // dropped
    { s: "Die Tasse ist rot.", tr: "فنجان قرمز است.", g: "", words: [] },
  ]);
  assert.equal(r.blocks.length, 2);
  assert.deepEqual(r.blocks[0].pairs, [{ o: "Ich muss nach Hause gehen.", t: "باید برم خونه." }]);
  const b0 = r.study[0], s0 = b0.sentences[0];
  assert.deepEqual(b0.notes.map((x) => [x.n, x.term]), [[1, "nach Hause"], [2, "gehen"]], "words are numbered from 1, on the chunk");
  assert.equal(b0.grammar, "Modal + Infinitiv am Ende.", "the grammar note is the chunk's box");
  assert.deepEqual(s0.tokens.map((t) => t.n), [[], [], [], [1], [2]], "phrase note on its last word, punctuation ignored");
  assert.equal(s0.meaning, "باید برم خونه.");
  assert.equal(r.study[1].notes.length, 0); assert.equal(r.study[1].grammar, "");
  // a chunk entry with its own sentences keeps them apart, notes on the chunk
  const c = S.tipsSheet([{ s: "Hallo. Wie geht es?", tr: "سلام. چطوری؟", g: "", words: [{ w: "geht", m: "می‌رود", pos: "verb", level: "A1", forms: "gehen · ging · gegangen · irregular" }], sentences: [{ s: "Hallo.", tr: "سلام." }, { s: "Wie geht es?", tr: "چطوری؟" }] }]);
  assert.equal(c.study[0].sentences.length, 2); assert.deepEqual(c.study[0].sentences[1].tokens.map((t) => t.n), [[], [1], []]); assert.equal(c.study[0].notes[0].forms, "gehen · ging · gegangen · irregular");
});

test("tipsSheet: a line contained in a longer explained line is dropped (pre-sentence-cut overlaps)", () => {
  const r = S.tipsSheet([
    { s: "along with putting you on a spot and being shocked,", tr: "…", g: "", words: [] },
    { s: "the correction that you will have, along with putting you on a spot and being shocked, will make you never forget.", tr: "…2", g: "", words: [] },
  ]);
  assert.equal(r.blocks.length, 1); assert.equal(r.blocks[0].tr, "…2");
});

test("gender marks exist only for languages that have grammatical gender; the legend article comes from the language", () => {
  const input = { blocks: [{ b: "b0", sentences: [{ i: 0, text: "The cat sleeps.", meaning: "گربه می‌خوابد." }] }] };
  const out = { blocks: [{ b: "b0", grammar: "", simple: "", notes: [], sentences: [{ i: 0, tokens: [{ w: "The", g: "f", v: 0, n: [] }, { w: "cat", g: "f", v: 0, n: [] }, { w: "sleeps.", g: "", v: 0, n: [] }] }] }] };
  assert.deepEqual(S.buildStudy(input, out, "en")[0].sentences[0].tokens.map((t) => t.g), ["", "", ""], "English: a model's gender slip is dropped");
  assert.deepEqual(S.buildStudy(input, out, "de")[0].sentences[0].tokens.map((t) => t.g), ["f", "f", ""], "German keeps it");
  assert.equal(S.isGendered("en"), false); assert.equal(S.isGendered("fa"), false); assert.equal(S.isGendered("de-DE"), true); assert.equal(S.isGendered("fr"), true);
  assert.equal(S.articleFor("de", "f"), "die"); assert.equal(S.articleFor("fr", "m"), "le"); assert.equal(S.articleFor("es", "n"), ""); assert.equal(S.articleFor("en", "f"), "");
});
