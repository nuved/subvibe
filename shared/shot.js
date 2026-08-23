// shared/shot.js
// Pure helpers for the Shot feature (translated screenshots): tile planning
// for scroll-and-stitch captures, crop/stitch geometry, DOM text-block prep
// and caps, translation mapping, the bilingual rule, RTL languages, the
// export frame layout, export filenames, record validation. No chrome.* and
// no DOM so tools/tests/shot.test.mjs can load it in node. Used by
// background.js (worker), content/shot-capture.js and shot.js (editor).
// Spec: docs/superpowers/specs/2026-08-24-shot-translate-design.md
(function (g) {
  const MAX_BLOCKS = 400;
  const MAX_CHARS = 20000;
  const MAX_TILES = 25;
  const MIN_WORDS_BILINGUAL = 4;
  const CAPTURE_GAP_MS = 550; // Chrome allows 2 captureVisibleTab calls per second
  const RTL = new Set(["ar", "fa", "he", "ur", "ps", "sd", "ug", "yi", "dv", "ckb"]);

  // scrollY offsets whose [o, o+viewportH) windows cover [top, bottom). The
  // last window is bottom-aligned (it may overlap the previous one; the
  // stitcher paints each row once). Offsets are clamped to what the page can
  // actually scroll to.
  function planTiles(top, bottom, viewportH, maxScroll, maxTiles = MAX_TILES) {
    const clamp = (v) => Math.max(0, Math.min(maxScroll, Math.round(v)));
    const out = [];
    if (bottom - top <= viewportH) {
      out.push(clamp(top));
    } else {
      let y = top;
      while (y + viewportH < bottom) { out.push(clamp(y)); y += viewportH; }
      out.push(clamp(bottom - viewportH));
    }
    const offsets = [...new Set(out)].sort((a, b) => a - b);
    const truncated = offsets.length > maxTiles;
    return { offsets: truncated ? offsets.slice(0, maxTiles) : offsets, truncated };
  }

  // Draw ops (device pixels) that assemble `rect` (document CSS px) from
  // viewport tiles captured at `offsets`. Rows already painted by an earlier
  // tile are skipped, so overlapping tiles never double-paint.
  function stitchLayout(rect, offsets, viewport, scrollX, dpr) {
    const ops = [];
    let drawnUntil = rect.y;
    const visW = Math.max(0, Math.min(rect.w, viewport.w - (rect.x - scrollX)));
    for (let i = 0; i < offsets.length; i++) {
      const o = offsets[i];
      const y0 = Math.max(o, rect.y, drawnUntil);
      const y1 = Math.min(o + viewport.h, rect.y + rect.h);
      if (y1 <= y0) continue;
      ops.push({
        i,
        sx: Math.round((rect.x - scrollX) * dpr), sy: Math.round((y0 - o) * dpr),
        sw: Math.round(visW * dpr), sh: Math.round((y1 - y0) * dpr),
        dx: 0, dy: Math.round((y0 - rect.y) * dpr),
      });
      drawnUntil = y1;
    }
    return { width: Math.round(rect.w * dpr), height: Math.round(rect.h * dpr), ops };
  }

  const LETTER = /\p{L}/u;
  function normText(t) { return String(t || "").replace(/\s+/g, " ").trim(); }

  // Keeps translatable blocks in document order, dedupes identical texts into
  // `lines` (one translation per distinct text), and enforces both caps.
  function prepBlocks(raw, caps) {
    const maxBlocks = (caps && caps.maxBlocks) || MAX_BLOCKS;
    const maxChars = (caps && caps.maxChars) || MAX_CHARS;
    const keep = [], lines = [], lineOf = [];
    const index = new Map();
    let chars = 0, truncated = "";
    for (const b of Array.isArray(raw) ? raw : []) {
      const text = normText(b && b.text);
      if (text.length < 2 || !LETTER.test(text)) continue;
      if (keep.length >= maxBlocks) { truncated = "text"; break; }
      let li = index.get(text);
      if (li == null) {
        if (chars + text.length > maxChars) { truncated = "text"; break; }
        li = lines.length; lines.push(text); index.set(text, li); chars += text.length;
      }
      keep.push({ id: String(b.id), text, rect: b.rect });
      lineOf.push(li);
    }
    return { keep, lines, lineOf, truncated };
  }

  function mapTranslations(keep, lineOf, tr) {
    let missing = 0;
    const blocks = keep.map((b, i) => {
      const t = Array.isArray(tr) ? tr[lineOf[i]] : undefined;
      const s = typeof t === "string" ? t.trim() : "";
      if (!s) missing++;
      return { id: b.id, text: b.text, tr: s, rect: b.rect };
    });
    return { blocks, missing };
  }

  function isBilingualBlock(text) {
    const t = normText(text);
    return t ? t.split(" ").length >= MIN_WORDS_BILINGUAL : false;
  }

  function isRtl(lang) {
    const base = String(lang || "").toLowerCase().split(/[-_]/)[0];
    return RTL.has(base);
  }

  // Geometry (device px) of the exported picture: the bare capture, or a
  // padded card with rounded corners and a small badge under the image.
  function frameLayout(o) {
    const w = o.w, h = o.h, dpr = o.dpr || 1;
    if (o.frame !== "card") return { width: w, height: h, img: { x: 0, y: 0, w, h, radius: 0 }, badge: null };
    const pad = Math.round((o.pad == null ? 48 : o.pad) * dpr);
    const radius = Math.round((o.radius == null ? 16 : o.radius) * dpr);
    const width = w + 2 * pad, height = h + 2 * pad;
    const badge = o.badge === false ? null
      : { x: width - pad, y: height - Math.round(pad / 2), h: Math.round(22 * dpr), padX: Math.round(9 * dpr), align: "right" };
    return { width, height, img: { x: pad, y: pad, w, h, radius }, badge };
  }

  const SIZE_SUFFIX = { native: "", "2x": "-2x", "1x": "-1x", half: "-half" };
  function pad2(n) { return String(n).padStart(2, "0"); }
  function filename(o) {
    const host = String(o.host || "").toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "page";
    const d = new Date(o.ts || 0);
    const stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "-" + pad2(d.getHours()) + pad2(d.getMinutes());
    const suffix = SIZE_SUFFIX[o.size] || "";
    const ext = o.format === "jpeg" ? "jpg" : "png";
    return "subvibe-" + host + "-" + stamp + "-" + (o.view || "translated") + suffix + "." + ext;
  }

  // Multiplier for the framed canvas: "native" keeps the capture's device
  // pixels; the others are CSS-pixel multiples, so they divide by dpr.
  function exportScale(size, dpr) {
    const d = dpr || 1;
    if (size === "2x") return 2 / d;
    if (size === "1x") return 1 / d;
    if (size === "half") return 0.5 / d;
    return 1;
  }

  const isStr = (v) => typeof v === "string";
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const isBlob = (v) => typeof Blob !== "undefined" && v instanceof Blob;
  function validateRecord(rec) {
    const bad = () => { throw new Error("bad-record"); };
    if (!rec || typeof rec !== "object") bad();
    for (const f of ["id", "url", "title", "host", "target", "mode", "layout"]) if (!isStr(rec[f])) bad();
    if (!isNum(rec.ts)) bad();
    for (const f of ["dpr", "w", "h"]) if (!isNum(rec[f]) || rec[f] <= 0) bad();
    if (!isBlob(rec.original) || !isBlob(rec.variant)) bad();
    if (!rec.rect) bad();
    for (const k of ["x", "y", "w", "h"]) if (!isNum(rec.rect[k])) bad();
    if (!Array.isArray(rec.blocks)) bad();
    for (const b of rec.blocks) {
      if (!b || !isStr(b.id) || !isStr(b.text) || !isStr(b.tr) || !b.rect) bad();
      for (const k of ["x", "y", "w", "h"]) if (!isNum(b.rect[k])) bad();
    }
    return rec;
  }

  function newId() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  }

  g.SV_SHOT = {
    MAX_BLOCKS, MAX_CHARS, MAX_TILES, MIN_WORDS_BILINGUAL, CAPTURE_GAP_MS,
    planTiles, stitchLayout, prepBlocks, mapTranslations, isBilingualBlock, isRtl,
    frameLayout, filename, exportScale, validateRecord, newId,
  };
})(globalThis);
