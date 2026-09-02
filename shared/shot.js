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

  // Tokens whose trailing period does NOT end a sentence (lower-case, no dot).
  // Sentence-ending abbreviations (etc., usw.) are deliberately absent, as are
  // tokens that are also words (may, so, sat).
  const ABBR = new Set(("dr prof mr mrs ms jr sr st nr no vs vol fig abs art bd hr fr str tel mio mrd tsd inkl exkl zzgl ggf evtl sog vgl bspw geb gest " +
    "ca bzw approx dept inc ltd co corp univ ed eds pp cf al z.b u.a d.h e.g i.e u.s a.m p.m o.ä s.o s.u u.u z.t " +
    "jan feb mar apr jun jul aug sep sept oct okt nov dec dez").split(" "));
  // Does a sentence part ending in "." actually continue? Yes after a known
  // abbreviation ("Dr."), an initial ("J. K. Rowling") or a 1–2 digit number
  // (German ordinal dates: "2. September"). Four-digit years still end sentences.
  function joinsNext(part) {
    const m = /(\S+)\.$/.exec(part);
    if (!m) return false;
    const tok = m[1].replace(/^[("'„«‚]+/, "");
    if (/^\p{L}$/u.test(tok) || /^\d{1,2}$/.test(tok)) return true;
    return ABBR.has(tok.toLowerCase());
  }
  // Split a paragraph into sentences for pair-by-pair bilingual rendering.
  // Keeps trailing terminators; handles Latin, Persian/Arabic and CJK marks.
  // Never returns empties; a paragraph with no terminator is one sentence.
  function splitSentences(text) {
    const t = normText(text);
    if (!t) return [];
    // Split AFTER a terminator run that is followed by whitespace. (A match-based
    // regex silently dropped text before an inner dot — "Das gilt z.B. für" lost
    // "Das gilt z." — so this is a split, never a match.)
    const parts = t.split(/(?<=[.!?…؟۔।。！？])\s+/u).map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      let cur = parts[i];
      while (i + 1 < parts.length && joinsNext(cur)) cur += " " + parts[++i];
      out.push(cur);
    }
    return out.length ? out : [t];
  }

  // Spread a block's sentence pairs back over its text nodes so a swapped
  // translation keeps the block's structure (paragraph breaks, a bold run in
  // the middle of a sentence). Each pair's original is located in the nodes'
  // joined text; its translation goes to the node where the sentence starts,
  // nodes that only carry the tail of a sentence are emptied. A pair that
  // can't be found rides with the previous one. Returns one string per node,
  // or null when there is nothing to place.
  function distributeTranslation(nodeTexts, pairs) {
    const texts = (nodeTexts || []).map(normText);
    const out = texts.map(() => "");
    if (!texts.length || !Array.isArray(pairs) || !pairs.length) return null;
    const starts = []; let full = "";
    for (const t of texts) { starts.push(full.length + (full && t ? 1 : 0)); full += (full && t ? " " : "") + t; }
    const nodeAt = (i) => { let k = 0; for (let j = 0; j < starts.length; j++) if (texts[j] && starts[j] <= i) k = j; return k; };
    let pos = 0, last = 0, placed = 0;
    for (const p of pairs) {
      const o = normText(p && p.o), t = normText(p && p.t);
      let k = last;
      if (o) {
        let i = full.indexOf(o, pos); if (i < 0) i = full.indexOf(o);
        if (i >= 0) { k = nodeAt(i); pos = i + o.length; }
      }
      if (t) { out[k] = out[k] ? out[k] + " " + t : t; placed++; }
      last = k;
    }
    return placed ? out : null;
  }

  // Geometry (device px) of the exported picture: the bare capture, or a
  // padded card with rounded corners and a small badge under the image.
  // "window" = card plus a browser title bar (`bar`) sitting on the image; the
  // image then starts below the bar and shares the card's rounded outline.
  function frameLayout(o) {
    const w = o.w, h = o.h, dpr = o.dpr || 1;
    if (o.frame !== "card" && o.frame !== "window") return { width: w, height: h, img: { x: 0, y: 0, w, h, radius: 0 }, badge: null };
    const pad = Math.round((o.pad == null ? 48 : o.pad) * dpr);
    const radius = Math.round((o.radius == null ? 16 : o.radius) * dpr);
    const barH = o.frame === "window" ? Math.round((o.bar == null ? 36 : o.bar) * dpr) : 0;
    const width = w + 2 * pad, height = h + barH + 2 * pad;
    const badge = o.badge === false ? null
      : { x: width - pad, y: height - Math.round(pad / 2), h: Math.round(22 * dpr), padX: Math.round(9 * dpr), align: "right" };
    const bar = barH ? { x: pad, y: pad, w, h: barH, radius } : null;
    return { width, height, img: { x: pad, y: pad + barH, w, h, radius }, bar, badge };
  }

  // ── bilingual page layouts ────────────────────────────────────────────────
  // Two page images next to each other (original | translated), tops aligned.
  function sideBySide(a, b, gap) {
    const g = Math.max(0, Math.round(gap || 0));
    return { width: a.w + g + b.w, height: Math.max(a.h, b.h),
      a: { x: 0, y: 0, w: a.w, h: a.h }, b: { x: a.w + g, y: 0, w: b.w, h: b.h } };
  }
  // Margin notes: each note wants to sit level with its block (`y`), but never
  // overlaps the previous one — greedy push-down. `items` are in reading order
  // with `y` (wanted top) and `h` (note height); returns the placed tops and
  // the bottom edge of the last note.
  function layoutNotes(items, gap) {
    const g = Math.max(0, gap || 0);
    const tops = []; let bottom = -Infinity;
    for (const it of items) {
      const y = Math.max(it.y, bottom === -Infinity ? -Infinity : bottom + g);
      tops.push(y); bottom = y + it.h;
    }
    return { tops, bottom: bottom === -Infinity ? 0 : bottom };
  }

  // ── annotation geometry (full-image fractions) ────────────────────────────
  // Bounds of one annotation; text/num carry a `box` measured at render time
  // (fractions), a num falls back to its radius before its first render.
  function annBounds(a) {
    if (!a) return null;
    const rect = (p, q) => ({ x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) });
    if (a.box) return { x: a.box.x, y: a.box.y, w: a.box.w, h: a.box.h };
    if (a.tool === "num" && a.at) { const r = a.r || 0.02; return { x: a.at.x - r, y: a.at.y - r, w: 2 * r, h: 2 * r }; }
    if (a.tool === "text" && a.at) return { x: a.at.x, y: a.at.y, w: 0.1, h: 0.03 };
    if (Array.isArray(a.pts) && a.pts.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of a.pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    if (Array.isArray(a.boxes) && a.boxes.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const b of a.boxes) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    if (a.a && a.b) return rect(a.a, a.b);
    return null;
  }
  // Distances are measured in width-fractions: `ky` (= image h / w) converts
  // y-fractions so a tolerance means the same on-screen length either way.
  function segDist(p, a, b, ky) {
    const ax = a.x, ay = a.y * ky, bx = b.x, by = b.y * ky, px = p.x, py = p.y * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    const qx = ax + t * dx, qy = ay + t * dy;
    return Math.hypot(px - qx, py - qy);
  }
  // Topmost annotation under `p`, or -1. Strokes and arrows hit along their
  // line (not their bounding box); boxes, blurs, text, marks hit inside.
  function hitAnnot(annots, p, opt) {
    const tol = (opt && opt.tol) || 0.012, ky = (opt && opt.ky) || 1;
    for (let i = (annots || []).length - 1; i >= 0; i--) {
      const a = annots[i]; if (!a) continue;
      if (a.tool === "pen" || a.tool === "highlight" || a.tool === "arrow") {
        const pts = a.pts || (a.a && a.b ? [a.a, a.b] : []);
        const half = (a.size || 0.006) * (a.tool === "highlight" ? 1.6 : 0.5);
        let best = Infinity;
        if (pts.length === 1) best = segDist(p, pts[0], pts[0], ky);
        for (let k = 0; k + 1 < pts.length; k++) best = Math.min(best, segDist(p, pts[k], pts[k + 1], ky));
        if (best <= tol + half) return i;
        continue;
      }
      if (a.tool === "num" && a.at && !a.box) {
        if (segDist(p, a.at, a.at, ky) <= (a.r || 0.02) + tol) return i;
        continue;
      }
      const b = annBounds(a); if (!b) continue;
      const ty = tol / ky;
      if (p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - ty && p.y <= b.y + b.h + ty) return i;
    }
    return -1;
  }
  // A copy of `a` shifted by (dx, dy) fractions — every stored point moves.
  function moveAnnot(a, dx, dy) {
    const sh = (p) => (p ? { ...p, x: p.x + dx, y: p.y + dy } : p);
    const out = { ...a };
    if (out.pts) out.pts = out.pts.map(sh);
    if (out.boxes) out.boxes = out.boxes.map(sh);
    for (const k of ["a", "b", "at", "box"]) if (out[k]) out[k] = sh(out[k]);
    return out;
  }
  // Step markers count 1, 2, 3 … in stroke order; call after any removal.
  function renumber(annots) {
    let n = 0;
    for (const a of annots || []) if (a && a.tool === "num") a.n = ++n;
    return annots;
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
    if (!isBlob(rec.variant)) bad();
    if (rec.original != null && !isBlob(rec.original)) bad(); // original is optional (multi-tile shots render it via re-shoot)
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

  // ── study card (grammar hints) ───────────────────────────────────────────
  const STUDY_MAX_SENTENCES = 30;
  // Languages with grammatical gender; a gender mark on any other language
  // (English, Persian, Turkish, Japanese …) is a model slip and is dropped.
  const GENDERED = new Set(["de", "fr", "es", "it", "pt", "ro", "ca", "gl", "ru", "uk", "be", "pl", "cs", "sk", "bg", "sr", "hr", "bs", "sl", "mk", "nl", "sv", "da", "nb", "nn", "no", "is", "el", "ar", "he", "hi", "ur", "pa", "mr", "gu", "bn", "lt", "lv", "ga", "cy", "af", "lb", "yi"]);
  const isGendered = (lang) => GENDERED.has(String(lang || "").toLowerCase().split(/[-_]/)[0]);
  // The article that names each gender in the legend, per language; null when
  // the language shows gender without a distinct article.
  const ARTICLES = { de: { m: "der", f: "die", n: "das" }, fr: { m: "le", f: "la" }, es: { m: "el", f: "la" }, it: { m: "il", f: "la" }, pt: { m: "o", f: "a" }, ca: { m: "el", f: "la" }, ro: { m: "un", f: "o", n: "un" }, nl: { m: "de", f: "de", n: "het" }, sv: { m: "en", f: "en", n: "ett" }, da: { m: "en", f: "en", n: "et" }, nb: { m: "en", f: "ei", n: "et" }, no: { m: "en", f: "ei", n: "et" }, el: { m: "ο", f: "η", n: "το" }, ar: { m: "", f: "ة" }, he: { m: "", f: "ה" } };
  const articleFor = (lang, g) => { const a = ARTICLES[String(lang || "").toLowerCase().split(/[-_]/)[0]]; return a && a[g] ? a[g] : ""; };
  const studyKey = (lang, explain) => String(lang || "") + "|" + String(explain || "");
  // The sentences of one side of the shot, in reading order, each with the
  // other side as its meaning. `side` = "target" (study the translation) or
  // "source" (study the original). Capped; `truncated` says so.
  function studySentences(rec, side, cap) {
    const max = cap || STUDY_MAX_SENTENCES;
    const blocks = []; let n = 0, truncated = false;
    for (const b of (rec && rec.blocks) || []) {
      const pairs = Array.isArray(b.pairs) && b.pairs.length ? b.pairs : (b.tr ? [{ o: b.text, t: b.tr }] : []);
      const sents = [];
      for (const p of pairs) {
        const text = normText(side === "source" ? p.o : p.t), meaning = normText(side === "source" ? p.t : p.o);
        if (!text) continue;
        if (n >= max) { truncated = true; break; }
        sents.push({ i: n++, text, meaning });
      }
      if (sents.length) blocks.push({ b: String(b.id), sentences: sents });
      if (truncated) break;
    }
    return { blocks, count: n, truncated };
  }
  // Model output → per-block card data, defensively. Tokens must be strings;
  // gender ∈ m/f/n; note numbers are kept only when the note exists; a
  // sentence the model skipped falls back to plain tokens (no marks).
  const POS = new Set(["noun", "verb", "phrasal verb", "adjective", "adverb", "idiom", "expression", "preposition", "conjunction", "pronoun", "article", "number", "other"]);
  const TOKPOS = new Set(["n", "v", "adj", "adv", "prep", "conj", "pron", "art", "num", "int", "part", "aux"]); // per-word "character" codes
  const LEVELS = new Set(["A1", "A2", "B1", "B2", "C1", "C2"]);
  // A note as the card shows it: what, part of speech, level, forms, why.
  function cleanNote(nt, k) {
    return { n: Number.isInteger(nt && nt.n) ? nt.n : k + 1, term: normText(nt && nt.term), text: normText(nt && nt.text),
      pos: POS.has(String(nt && nt.pos || "").toLowerCase()) ? String(nt.pos).toLowerCase() : "", level: LEVELS.has(String(nt && nt.level || "").toUpperCase()) ? String(nt.level).toUpperCase() : "", forms: normText(nt && nt.forms) };
  }
  // Model output → card data. Version 2: the tips (grammar points, the simpler
  // version, the numbered notes) belong to the BLOCK — a chunk, a passage of a
  // few sentences — and the sentences carry only their marks. Tokens are
  // strings; gender only for gendered languages; note numbers only when the
  // note exists; a sentence the model skipped falls back to plain tokens.
  function buildStudy(input, out, lang) {
    const gendered = lang == null ? true : isGendered(lang);
    const byBlock = new Map();
    for (const b of (out && Array.isArray(out.blocks)) ? out.blocks : []) if (b && b.b != null) byBlock.set(String(b.b), b);
    const blocks = [];
    for (const blk of input.blocks) {
      const m = byBlock.get(String(blk.b)) || {};
      const notes = (Array.isArray(m.notes) ? m.notes : []).map(cleanNote).filter((nt) => nt.text).slice(0, 10);
      const ids = new Set(notes.map((nt) => nt.n));
      const bySent = new Map();
      for (const sm of Array.isArray(m.sentences) ? m.sentences : []) if (sm && Number.isInteger(sm.i)) bySent.set(sm.i, sm);
      const sentences = blk.sentences.map((src) => {
        const sm = bySent.get(src.i) || {};
        let tokens = (Array.isArray(sm.tokens) ? sm.tokens : []).map((t) => ({
          w: normText(t && t.w), g: gendered && ["m", "f", "n"].includes(t && t.g) ? t.g : "", v: Number.isInteger(t && t.v) && t.v > 0 ? t.v : 0,
          n: (Array.isArray(t && t.n) ? t.n : []).filter((x) => ids.has(x)).slice(0, 2),
          p: TOKPOS.has(String(t && t.p || "").toLowerCase()) ? String(t.p).toLowerCase() : "",
        })).filter((t) => t.w);
        if (!tokens.length) tokens = src.text.split(" ").map((w) => ({ w, g: "", v: 0, n: [], p: "" }));
        return { text: src.text, meaning: src.meaning, tokens };
      });
      blocks.push({ b: blk.b, grammar: normText(m.grammar), simple: normText(m.simple), notes, sentences });
    }
    return blocks;
  }
  // Older analyses kept the tips on each sentence: lift them so every sentence
  // becomes its own block — the card then draws one shape for both.
  function normalizeStudy(blocks) {
    const out = [];
    for (const b of blocks || []) {
      const v1 = (b.sentences || []).some((snt) => snt && (Array.isArray(snt.notes) || snt.simple != null || snt.grammar != null)) && !Array.isArray(b.notes);
      if (!v1) { out.push({ b: b.b, grammar: b.grammar || "", simple: b.simple || "", notes: (b.notes || []).map(cleanNote), sentences: b.sentences || [] }); continue; }
      (b.sentences || []).forEach((snt, i) => out.push({ b: String(b.b) + "." + i, grammar: snt.grammar || "", simple: snt.simple || "", notes: (snt.notes || []).map(cleanNote), sentences: [{ text: snt.text, meaning: snt.meaning, tokens: snt.tokens || [] }] }));
    }
    return out;
  }
  // Which marks a study actually uses (the legend shows only those).
  function studyMarks(blocks) {
    const marks = { m: false, f: false, n: false, v: false, notes: false };
    for (const b of blocks || []) for (const s of b.sentences || []) {
      for (const t of s.tokens || []) { if (t.g) marks[t.g] = true; if (t.v) marks.v = true; if (t.n && t.n.length) marks.notes = true; }
    }
    return marks;
  }

  // ── tips sheet: the ﹖ explanations of one video as a Study card ──────────
  // entries: [{ s: sentence, tr, g: grammar note, words: [{w, m}] }] in the
  // order they were explained. Returns the shot blocks (sentence pairs) and
  // the study blocks the editor's Study card draws without another call:
  // each word note lands on the token that carries the word (the last word
  // of a phrase); the grammar note is the sentence's `grammar` box, unnumbered.
  function tipsSheet(entries) {
    // Lines explained before the sentence-level cut could overlap their
    // neighbours; a line contained in another one is dropped.
    const raw = (entries || []).filter((e) => e && e.s && e.tr).map((e) => ({ ...e, s: normText(e.s) }));
    const clean = raw.filter((e, i) => !raw.some((o, j) => j !== i && o.s.length > e.s.length && o.s.includes(e.s)));
    const blocks = [], study = [];
    clean.forEach((e, i) => {
      const s = normText(e.s), tr = normText(e.tr);
      blocks.push({ id: "t" + i, text: s, tr, rect: { x: 0, y: i * 40, w: 640, h: 36 }, pairs: [{ o: s, t: tr }] });
      // A chunk entry may carry its sentences (with their own translations); a
      // line entry is one sentence. Tokens per sentence, notes on the chunk.
      const sents = Array.isArray(e.sentences) && e.sentences.length ? e.sentences.map((x) => ({ text: normText(x.s), meaning: normText(x.tr) })).filter((x) => x.text) : [{ text: s, meaning: tr }];
      const sentences = sents.map((x) => ({ text: x.text, meaning: x.meaning, tokens: x.text.split(" ").filter(Boolean).map((w) => ({ w, g: "", v: 0, n: [] })) }));
      const notes = []; let n = 0; // words are the numbered notes; the grammar note gets its own box
      const bare = (w) => String(w || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      for (const x of (Array.isArray(e.words) ? e.words : []).filter((x) => x && x.w && x.m).slice(0, 8)) {
        const num = ++n;
        notes.push(cleanNote({ n: num, term: normText(x.w), text: normText(x.m), pos: x.pos, level: x.level, forms: x.forms }, num - 1));
        const last = bare(normText(x.w).split(" ").pop());
        for (const snt of sentences) {
          const tok = last ? snt.tokens.find((t) => bare(t.w) === last) || snt.tokens.find((t) => bare(t.w).includes(last) || last.includes(bare(t.w)) && bare(t.w).length > 3) : null;
          if (tok && tok.n.length < 2) { tok.n.push(num); break; }
        }
      }
      study.push({ b: "t" + i, grammar: normText(e.g), simple: normText(e.simple), notes, sentences });
    });
    return { blocks, study };
  }

  // ── crop ──────────────────────────────────────────────────────────────────
  // A crop is non-destructive: {x,y,w,h} normalized to the FULL image, stored
  // on the record; views and exports draw only that window, the blobs and the
  // annotations (also full-image coords) stay untouched.
  function normCrop(crop) {
    const full = { x: 0, y: 0, w: 1, h: 1 };
    if (!crop) return full;
    const x = Math.min(Math.max(+crop.x || 0, 0), 1), y = Math.min(Math.max(+crop.y || 0, 0), 1);
    const w = Math.min(Math.max(+crop.w || 0, 0), 1 - x), h = Math.min(Math.max(+crop.h || 0, 0), 1 - y);
    if (w < 0.01 || h < 0.01) return full; // degenerate → full image
    return { x, y, w, h };
  }
  const isFullCrop = (c) => !c || normCrop(c).w === 1 && normCrop(c).h === 1 && normCrop(c).x === 0 && normCrop(c).y === 0;
  // Source-pixel rect drawImage reads from the bitmap.
  function cropSrc(crop, bmpW, bmpH) {
    const c = normCrop(crop);
    return { sx: c.x * bmpW, sy: c.y * bmpH, sw: Math.max(1, c.w * bmpW), sh: Math.max(1, c.h * bmpH) };
  }
  // Full-image fraction → px inside the on-screen image box (which shows only the crop).
  function cropToView(n, img, crop) {
    const c = normCrop(crop);
    return [img.x + ((n.x - c.x) / c.w) * img.w, img.y + ((n.y - c.y) / c.h) * img.h];
  }
  // Inverse: pointer px inside the image box → full-image fraction, clamped to the crop.
  function viewToCrop(px, py, img, crop) {
    const c = normCrop(crop);
    const x = c.x + ((px - img.x) / img.w) * c.w, y = c.y + ((py - img.y) / img.h) * c.h;
    return { x: Math.min(Math.max(x, c.x), c.x + c.w), y: Math.min(Math.max(y, c.y), c.y + c.h) };
  }

  g.SV_SHOT = {
    MAX_BLOCKS, MAX_CHARS, MAX_TILES, MIN_WORDS_BILINGUAL, CAPTURE_GAP_MS,
    planTiles, stitchLayout, prepBlocks, mapTranslations, isBilingualBlock, isRtl, splitSentences,
    frameLayout, filename, exportScale, validateRecord, newId,
    normCrop, isFullCrop, cropSrc, cropToView, viewToCrop,
    sideBySide, layoutNotes, annBounds, hitAnnot, moveAnnot, renumber, distributeTranslation,
    STUDY_MAX_SENTENCES, studyKey, studySentences, buildStudy, normalizeStudy, studyMarks, tipsSheet, isGendered, articleFor, TOKPOS,
  };
})(globalThis);
