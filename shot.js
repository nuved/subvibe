// shot.js — the Shot editor page (shot.html?id=…). Reads and writes the
// `shots` store in IndexedDB directly (blobs can't cross runtime messages);
// asks background only for re-shoots. Spec:
// docs/superpowers/specs/2026-08-24-shot-translate-design.md
(function () {
  const S = window.SV_SHOT;
  const $ = (id) => document.getElementById(id);
  const RECENT = 12;

  // ── IndexedDB (same DB/version as background.js; upgrade mirrors it) ──────
  let dbP = null;
  function db() {
    if (!dbP) {
      dbP = new Promise((resolve, reject) => {
        const req = indexedDB.open("copilot-subs", 5);
        req.onupgradeneeded = () => {
          const d = req.result;
          for (const s of ["tracks", "audio", "vocab", "shots", "clips"]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbP;
  }
  const tx = (mode) => db().then((d) => d.transaction("shots", mode).objectStore("shots"));
  const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const getShot = (id) => tx("readonly").then((s) => wrap(s.get(id)));
  const putShot = (rec) => tx("readwrite").then((s) => wrap(s.put(rec, rec.id)));
  const delShot = (id) => tx("readwrite").then((s) => wrap(s.delete(id)));
  const listShots = () => tx("readonly").then((s) => wrap(s.getAll())).then((all) =>
    (all || []).filter((r) => r && typeof r.ts === "number").sort((a, b) => b.ts - a.ts));

  // ── state ─────────────────────────────────────────────────────────────────
  let rec = null;
  let view = "translated";
  let frame = { frame: "card", badge: true };
  let exp = { size: "native", format: "png" };
  const bitmaps = {};          // "original" | "variant" → ImageBitmap
  // ── annotation layer (pen / highlighter / text / arrow / rect) ──
  let annots = [];             // {tool,color,size(frac of img.w),pts?,a?,b?,text?,at?,fontSize?}
  let annTool = "";            // "" = no drawing (select), else a tool
  let annColor = "#F45D48";
  let annSizeFrac = 0.006;
  let curLay = null;           // last drawFramed() layout (device px) for coord mapping
  const ANN_COLORS = ["#F45D48", "#FFC53D", "#22C55E", "#3B82F6", "#111827", "#FFFFFF"];
  const edits = new Map();     // block id → edited translation
  let reshooting = false;
  let lastRenderedView = null; // the view whose pixels are actually on the canvas
  let tabAlive = true; // re-set on load via SHOT_TAB_ALIVE
  let pendingFont = null; // set by the Font control to re-render with a new font
  let biLayout = "B";     // bilingual pairing: A block-under-block · B stacked pairs · C side-by-side columns
  let biLineBoxes = [];   // per-line boxes (normalized to the paper) for the text-highlight tool
  const BI_RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/; // Hebrew/Arabic/Persian ranges
  let biFontP = null;     // bundled Vazirmatn for pretty RTL text on the pairs canvas
  function ensureBiFont() {
    if (biFontP) return biFontP;
    biFontP = (async () => {
      try {
        for (const [w, f] of [["400", "Vazirmatn-Regular.woff2"], ["700", "Vazirmatn-Bold.woff2"]]) {
          const ff = new FontFace("SubVibe Vazirmatn", "url(" + chrome.runtime.getURL("fonts/" + f) + ")", { weight: w });
          await ff.load(); document.fonts.add(ff);
        }
      } catch (e) { /* fall back to system fonts */ }
    })();
    return biFontP;
  }

  const langName = (c) => (window.svLangMeta ? window.svLangMeta((c || "").split("-")[0])[1] : (c || "").toUpperCase());
  const code = (c) => (c || "").split("-")[0].toUpperCase();
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  let toastT = null;
  function toast(text) {
    const t = $("toast"); t.textContent = text; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 1800);
  }
  // Transition overlay — the current view stays on screen (image + toolbar)
  // while the next one renders, so there's no blank flash.
  function showBusy(text) { const b = $("stageBusy"); if (b) { $("stageBusyLabel").textContent = text || "Rendering…"; b.classList.add("on"); } }
  function hideBusy() { const b = $("stageBusy"); if (b) b.classList.remove("on"); }
  const markViewButton = (v) => { for (const b of $("viewSeg").querySelectorAll("button")) b.classList.toggle("on", b.dataset.view === v); };

  // ── drawing ───────────────────────────────────────────────────────────────
  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y); ctx.arcTo(x + w, y, x + w, y + h, rr); ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr); ctx.arcTo(x, y, x + w, y, rr); ctx.closePath();
  }
  // Paints `bmp` framed per `frame` into `canvas`; `scale` is relative to the
  // capture's device pixels (1 = native).
  function drawFramed(canvas, bmp, scale) {
    const dpr = (rec.dpr || 1) * scale;
    const lay = S.frameLayout({ w: Math.round(bmp.width * scale), h: Math.round(bmp.height * scale), frame: frame.frame, badge: frame.badge, dpr });
    canvas.width = lay.width; canvas.height = lay.height;
    const ctx = canvas.getContext("2d");
    if (frame.frame === "card") {
      const g = ctx.createLinearGradient(0, 0, lay.width, lay.height);
      g.addColorStop(0, cssVar("--frame-a")); g.addColorStop(0.55, cssVar("--frame-b")); g.addColorStop(1, cssVar("--frame-c"));
      ctx.fillStyle = g; ctx.fillRect(0, 0, lay.width, lay.height);
      ctx.save();
      ctx.shadowColor = "rgba(40,20,10,.35)"; ctx.shadowBlur = 30 * dpr; ctx.shadowOffsetY = 10 * dpr;
      ctx.fillStyle = "#fff"; roundRect(ctx, lay.img.x, lay.img.y, lay.img.w, lay.img.h, lay.img.radius); ctx.fill();
      ctx.restore();
      ctx.save(); roundRect(ctx, lay.img.x, lay.img.y, lay.img.w, lay.img.h, lay.img.radius); ctx.clip();
      ctx.drawImage(bmp, lay.img.x, lay.img.y, lay.img.w, lay.img.h); ctx.restore();
      if (lay.badge) {
        const label = "SUBVIBE · " + code(rec.source === "xx" ? "" : rec.source) + (rec.source === "xx" ? "" : " → ") + code(rec.target);
        ctx.font = "600 " + Math.round(11 * dpr) + "px ui-monospace, Menlo, Consolas, monospace";
        const tw = ctx.measureText(label).width;
        const bw = tw + lay.badge.padX * 2, bh = lay.badge.h;
        const bx = lay.badge.x - bw, by = lay.badge.y - bh / 2;
        ctx.fillStyle = "rgba(255,255,255,.72)"; roundRect(ctx, bx, by, bw, bh, bh / 2); ctx.fill();
        ctx.fillStyle = "#A93521"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
        ctx.fillText(label, bx + lay.badge.padX, by + bh / 2 + 0.5 * dpr);
      }
    } else {
      ctx.drawImage(bmp, 0, 0, lay.width, lay.height);
    }
    return lay;
  }

  // ── bilingual pairs card (generated, not a page screenshot) ────────────────
  // Sentence pairs to render: per-sentence when we have them, else one pair per
  // block (older shots translated before sentence-alignment existed).
  function biPairs() {
    const out = [];
    for (const b of rec.blocks) {
      if (Array.isArray(b.pairs) && b.pairs.length) {
        for (const p of b.pairs) { const o = (p && p.o) || "", t = (p && p.t) || ""; if (o || t) out.push({ o, t }); }
      } else if (b.tr) out.push({ o: b.text, t: b.tr });
    }
    return out;
  }
  const hasPairs = () => !!(rec && rec.blocks.some((b) => (Array.isArray(b.pairs) && b.pairs.length) || b.tr));
  function wrapText(ctx, text, maxW) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = []; let cur = "";
    for (const w of words) {
      const test = cur ? cur + " " + w : w;
      if (!cur || ctx.measureText(test).width <= maxW) cur = test;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  }
  // Paints the sentence pairs as a clean reading card in layout A/B/C. Returns
  // the frame layout (device px) so annotations can map onto it.
  function drawPairsCard(canvas, scale) {
    const dpr = (rec.dpr || 1) * scale;
    const pairs = biPairs();
    const baseCss = Math.min(860, Math.max(560, Math.round((rec.rect && rec.rect.w) || 640)));
    const paperW = Math.round(baseCss * dpr);
    const PAD = Math.round(28 * dpr);
    const innerW = paperW - PAD * 2;
    const FS_O = Math.round(17 * dpr), FS_T = Math.round(15.5 * dpr);
    const LH_O = Math.round(FS_O * 1.58), LH_T = Math.round(FS_T * 1.5);
    const GAP_OT = Math.round(5 * dpr), GAP_PAIR = Math.round(18 * dpr), COL_GUT = Math.round(24 * dpr);
    const INK = "#1f1c18", DE = "#2c6a64", LINE = "#ebe4d9"; // on the always-white paper
    const useVazir = rec.font === "vazirmatn";
    const stack = (rtl) => (rtl || useVazir) ? '"SubVibe Vazirmatn", system-ui, -apple-system, sans-serif' : 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    const oFont = (rtl) => "400 " + FS_O + "px " + stack(rtl);
    const tFont = (rtl) => "400 " + FS_T + "px " + stack(rtl);

    const mc = canvas.getContext("2d");
    const items = []; // {text,x,y,font,color,align,dir} or {divider,y,x1,x2}
    let contentH = 0;

    if (biLayout === "C") {
      const colW = Math.max(40, Math.floor((innerW - COL_GUT) / 2));
      let y = 0;
      pairs.forEach((p, i) => {
        const oRtl = BI_RTL.test(p.o), tRtl = BI_RTL.test(p.t);
        mc.font = oFont(oRtl); const oL = wrapText(mc, p.o, colW);
        mc.font = tFont(tRtl); const tL = wrapText(mc, p.t, colW);
        if (i) { items.push({ divider: true, y: Math.round(y - GAP_PAIR / 2), x1: 0, x2: innerW }); }
        oL.forEach((ln, k) => items.push({ text: ln, x: innerW, y: y + k * LH_O, font: oFont(oRtl), color: INK, align: "right", dir: "rtl" }));
        tL.forEach((ln, k) => items.push({ text: ln, x: 0, y: y + k * LH_T, font: tFont(tRtl), color: DE, align: "left", dir: "ltr" }));
        y += Math.max(oL.length * LH_O, tL.length * LH_T) + GAP_PAIR;
      });
      contentH = Math.max(0, y - GAP_PAIR);
    } else if (biLayout === "A") {
      const oRtl = pairs.some((p) => BI_RTL.test(p.o)), oText = pairs.map((p) => p.o).join(" ");
      const tText = pairs.map((p) => p.t).join(" "), tRtl = BI_RTL.test(tText);
      let y = 0;
      mc.font = oFont(oRtl); wrapText(mc, oText, innerW).forEach((ln, k) => items.push({ text: ln, x: oRtl ? innerW : 0, y: y + k * LH_O, font: oFont(oRtl), color: INK, align: oRtl ? "right" : "left", dir: oRtl ? "rtl" : "ltr" }));
      y += wrapText(mc, oText, innerW).length * LH_O + Math.round(10 * dpr);
      items.push({ divider: true, y: Math.round(y - 5 * dpr), x1: 0, x2: innerW }); y += Math.round(6 * dpr);
      mc.font = tFont(tRtl); wrapText(mc, tText, innerW).forEach((ln, k) => items.push({ text: ln, x: tRtl ? innerW : 0, y: y + k * LH_T, font: tFont(tRtl), color: DE, align: tRtl ? "right" : "left", dir: tRtl ? "rtl" : "ltr" }));
      y += wrapText(mc, tText, innerW).length * LH_T;
      contentH = y;
    } else { // "B" — stacked pairs
      let y = 0;
      pairs.forEach((p, i) => {
        const oRtl = BI_RTL.test(p.o), tRtl = BI_RTL.test(p.t);
        if (i) { items.push({ divider: true, y: Math.round(y - GAP_PAIR / 2), x1: 0, x2: innerW }); }
        mc.font = oFont(oRtl); const oL = wrapText(mc, p.o, innerW);
        oL.forEach((ln, k) => items.push({ text: ln, x: oRtl ? innerW : 0, y: y + k * LH_O, font: oFont(oRtl), color: INK, align: oRtl ? "right" : "left", dir: oRtl ? "rtl" : "ltr" }));
        y += oL.length * LH_O + GAP_OT;
        mc.font = tFont(tRtl); const tL = wrapText(mc, p.t, innerW);
        tL.forEach((ln, k) => items.push({ text: ln, x: tRtl ? innerW : 0, y: y + k * LH_T, font: tFont(tRtl), color: DE, align: tRtl ? "right" : "left", dir: tRtl ? "rtl" : "ltr" }));
        y += tL.length * LH_T + GAP_PAIR;
      });
      contentH = Math.max(0, y - GAP_PAIR);
    }

    const paperH = PAD * 2 + Math.max(contentH, LH_O);
    const lay = S.frameLayout({ w: paperW, h: paperH, frame: frame.frame, badge: frame.badge, dpr });
    canvas.width = lay.width; canvas.height = lay.height;
    const g = canvas.getContext("2d");
    if (frame.frame === "card") {
      const grad = g.createLinearGradient(0, 0, lay.width, lay.height);
      grad.addColorStop(0, cssVar("--frame-a")); grad.addColorStop(0.55, cssVar("--frame-b")); grad.addColorStop(1, cssVar("--frame-c"));
      g.fillStyle = grad; g.fillRect(0, 0, lay.width, lay.height);
      g.save(); g.shadowColor = "rgba(40,20,10,.28)"; g.shadowBlur = 28 * dpr; g.shadowOffsetY = 10 * dpr;
      g.fillStyle = "#fff"; roundRect(g, lay.img.x, lay.img.y, lay.img.w, lay.img.h, lay.img.radius); g.fill(); g.restore();
    } else {
      g.fillStyle = "#fff"; roundRect(g, lay.img.x, lay.img.y, lay.img.w, lay.img.h, lay.img.radius); g.fill();
    }
    if (lay.badge) {
      const label = "SUBVIBE · " + code(rec.source === "xx" ? "" : rec.source) + (rec.source === "xx" ? "" : " → ") + code(rec.target);
      g.font = "600 " + Math.round(11 * dpr) + "px ui-monospace, Menlo, Consolas, monospace";
      const tw = g.measureText(label).width, bw = tw + lay.badge.padX * 2, bh = lay.badge.h;
      const bx = lay.badge.x - bw, by = lay.badge.y - bh / 2;
      g.fillStyle = "rgba(255,255,255,.72)"; roundRect(g, bx, by, bw, bh, bh / 2); g.fill();
      g.fillStyle = "#A93521"; g.textBaseline = "middle"; g.textAlign = "left";
      g.fillText(label, bx + lay.badge.padX, by + bh / 2 + 0.5 * dpr);
    }
    g.save(); roundRect(g, lay.img.x, lay.img.y, lay.img.w, lay.img.h, lay.img.radius); g.clip();
    const ox = lay.img.x + PAD, oy = lay.img.y + PAD;
    for (const it of items) {
      if (it.divider) { g.strokeStyle = LINE; g.lineWidth = Math.max(1, dpr); g.beginPath(); g.moveTo(ox + it.x1, oy + it.y + 0.5); g.lineTo(ox + it.x2, oy + it.y + 0.5); g.stroke(); continue; }
      g.font = it.font; g.fillStyle = it.color; g.textAlign = it.align; g.textBaseline = "top"; g.direction = it.dir;
      g.fillText(it.text, ox + it.x, oy + it.y);
    }
    g.restore();
    // Per-line boxes (normalized to the paper) so the text-highlight tool can
    // snap to whole lines instead of freehand smearing.
    biLineBoxes = items.filter((it) => it.text).map((it) => {
      mc.font = it.font; const w = mc.measureText(it.text).width;
      const lh = it.font.indexOf(" " + FS_O + "px") >= 0 ? LH_O : LH_T;
      const bx = it.align === "right" ? it.x - w : it.x;
      return { x: (PAD + bx) / lay.img.w, y: (PAD + it.y) / lay.img.h, w: w / lay.img.w, h: lh / lay.img.h };
    });
    return lay;
  }
  // The stored blob that renders a view, or null when it hasn't been rendered
  // yet (fills in on first visit via re-shoot, then it's cached here forever).
  // `rec.views` is the per-view cache; the original/variant fields are the
  // fallback for shots stored before the cache existed.
  function viewBlob(v) {
    if (rec.views && rec.views[v] instanceof Blob) return rec.views[v];
    if (v === "original") return rec.original instanceof Blob ? rec.original : null;
    if (v === rec.layout) return rec.variant instanceof Blob ? rec.variant : null;
    return null;
  }
  async function bitmapFor(v) {
    if (!bitmaps[v]) { const b = viewBlob(v); if (!(b instanceof Blob)) return null; bitmaps[v] = await createImageBitmap(b); }
    return bitmaps[v];
  }
  function clearBitmaps() { for (const k of Object.keys(bitmaps)) { try { bitmaps[k].close(); } catch (e) {} delete bitmaps[k]; } }

  const viewLabel = (v) => ({ translated: "Translated", bilingual: "Bilingual", original: "Original" }[v] || v);
  async function render() {
    if (view === "bilingual" && hasPairs()) return renderBilingual();
    const captured = !!viewBlob(view);
    // Show the view's own image if we have it, else a dimmed placeholder while
    // it renders (fall back to the primary layout, then Original).
    let bmp = await bitmapFor(view);
    if (!bmp) bmp = (await bitmapFor(rec.layout)) || (await bitmapFor("original"));
    const canvas = $("stage");
    if (bmp) {
      const lay = drawFramed(canvas, bmp, 1); curLay = lay;
      canvas.style.width = Math.round(lay.width / (rec.dpr || 1)) + "px";
    }
    canvas.style.opacity = captured ? "1" : ".55";
    if (captured) lastRenderedView = view;
    $("stageSkel").hidden = true; $("canvasWrap").hidden = false;
    setupAnnot(); $("annotBar").hidden = !captured;
    { const tm = $("annTextmark"); if (tm) tm.hidden = true; if (annTool === "textmark") { annTool = ""; for (const x of $("annTools").querySelectorAll("button")) x.classList.toggle("on", (x.dataset.tool||"") === ""); } }
    syncAnnot();
    for (const b of $("viewSeg").querySelectorAll("button")) b.classList.toggle("on", b.dataset.view === view);
    const vn = $("viewNote");
    if (captured && view === "original" && !isTranslated()) { vn.className = "note"; vn.textContent = "Original page — pick Translated or Bilingual to translate (uses your API key)."; }
    else if (!captured && !tabAlive) { vn.className = "note warn"; vn.textContent = "Open the original tab to add the " + viewLabel(view) + " view."; }
    else { vn.className = "note"; vn.textContent = ""; } // the busy overlay signals in-progress renders
    updateReshoot();
    for (const id of ["dlBtn", "copyBtn", "shareBtn"]) { const el = $(id); if (el) el.disabled = !captured; }
    $("biPick").hidden = true;
    $("fileNote").textContent = S.filename({ host: rec.host, ts: rec.ts, view, size: exp.size, format: exp.format });
  }
  // Bilingual view: a generated pairs card (no blob, no tab). Switching the A/B/C
  // layout just redraws — instant.
  async function renderBilingual() {
    await ensureBiFont();
    const canvas = $("stage");
    const lay = drawPairsCard(canvas, 1); curLay = lay;
    canvas.style.width = Math.round(lay.width / (rec.dpr || 1)) + "px";
    canvas.style.opacity = "1";
    lastRenderedView = "bilingual";
    $("stageSkel").hidden = true; $("canvasWrap").hidden = false;
    setupAnnot(); $("annotBar").hidden = false;
    { const tm = $("annTextmark"); if (tm) tm.hidden = false; }
    syncAnnot();
    markViewButton("bilingual");
    for (const b of $("biBar").querySelectorAll("button")) b.classList.toggle("on", b.dataset.bi === biLayout);
    $("biPick").hidden = false;
    const vn = $("viewNote"); vn.className = "note"; vn.textContent = "";
    updateReshoot();
    for (const id of ["dlBtn", "copyBtn", "shareBtn"]) { const el = $(id); if (el) el.disabled = false; }
    $("fileNote").textContent = S.filename({ host: rec.host, ts: rec.ts, view, size: exp.size, format: exp.format });
  }

  // ── panel ─────────────────────────────────────────────────────────────────
  function renderHeader() {
    const link = $("pageLink"); link.textContent = rec.title || rec.url; link.href = rec.url; link.title = rec.url;
    const chip = $("srcChip");
    chip.hidden = false;
    chip.textContent = (rec.source && rec.source !== "xx" ? code(rec.source) : "Auto") + " →";
    chip.title = (rec.source && rec.source !== "xx" ? langName(rec.source) : "Detected language") + " → " + langName(rec.target);
    setupLangPick();
    const d = new Date(rec.ts);
    const modeName = { visible: "Visible area", full: "Full page", area: "Select area", element: "Pick element" }[rec.mode] || rec.mode;
    $("metaLine").textContent = d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " · " + modeName + " · " + Math.round(rec.w) + " × " + Math.round(rec.h);
    const notes = [];
    if (rec.noKey) notes.push("Captured without translation — add an API key in the SubVibe popup to translate.");
    if (rec.sameLang) notes.push("This page is already in " + langName(rec.target) + ".");
    if (rec.partial) notes.push("Some text couldn't be swapped on this page.");
    if (rec.truncated === "text") notes.push("Long page — only the first " + S.MAX_BLOCKS + " text blocks were translated.");
    if (rec.truncated === "height") notes.push("Very tall page — cut at " + S.MAX_TILES + " screens.");
    $("noteBar").hidden = !notes.length; $("noteBar").textContent = notes.join(" ");
  }
  function kindOf(b) {
    const el = b.rect && b.rect.h > 0 && b.text.length < 60 && b.rect.h > 28 ? "Heading" : b.text.split(" ").length < 4 ? "Label" : "Paragraph";
    return el;
  }
  // Type-to-search language picker in the header. Changing it re-translates
  // the whole shot to the chosen language.
  const langMeta = (c) => (window.svLangMeta ? window.svLangMeta(c) : [c, (c || "").toUpperCase(), "\ud83c\udff3\ufe0f"]);
  const flagOf = (m) => (m[2] && m[2].length <= 4 ? m[2] : "\ud83c\udf10");
  function langOptions() {
    const langs = (window.SV_LANGS || []).slice();
    if (rec.target && !langs.some((l) => l[0] === rec.target)) langs.unshift([rec.target, langName(rec.target), ""]);
    return langs.map((l) => l[0]);
  }
  function setupLangPick() {
    const wrap = $("langPick"); if (!wrap) return;
    wrap.hidden = false;
    const btn = $("langBtn"), pop = $("langPop"), search = $("langSearch"), list = $("langList");
    const m = langMeta(rec.target);
    $("langBtnLabel").textContent = m[1];
    let active = -1, rows = [];
    function render(q) {
      const codes = langOptions().filter((c) => {
        if (!q) return true;
        const name = langMeta(c)[1].toLowerCase();
        // match "germa" (prefix), "german" (contains), AND "germany" (query starts with the name — country vs language)
        return name.includes(q) || q.startsWith(name) || c.toLowerCase().includes(q);
      });
      list.textContent = ""; rows = [];
      if (!codes.length) { const e = document.createElement("div"); e.className = "langpick__empty"; e.textContent = "No match"; list.appendChild(e); return; }
      codes.forEach((c, i) => {
        const mm = langMeta(c);
        const o = document.createElement("button"); o.type = "button"; o.className = "langpick__opt" + (c === rec.target ? " on" : "");
        o.setAttribute("role", "option"); o.dataset.code = c;
        o.innerHTML = '<span class="flag"></span><span></span>';
        o.firstChild.textContent = flagOf(mm); o.lastChild.textContent = mm[1];
        o.addEventListener("click", () => choose(c));
        o.addEventListener("mousemove", () => setActive(i));
        list.appendChild(o); rows.push(o);
      });
      setActive(0);
    }
    function setActive(i) { rows.forEach((r, k) => r.classList.toggle("active", k === i)); active = i; if (rows[i]) rows[i].scrollIntoView({ block: "nearest" }); }
    function open() { pop.hidden = false; btn.setAttribute("aria-expanded", "true"); search.value = ""; render(""); search.focus(); document.addEventListener("mousedown", onDoc, true); }
    function close() { pop.hidden = true; btn.setAttribute("aria-expanded", "false"); document.removeEventListener("mousedown", onDoc, true); }
    function onDoc(e) { if (!wrap.contains(e.target)) close(); }
    function choose(c) { close(); retranslate(c, view === "original" ? "translated" : view); }
    btn.onclick = () => (pop.hidden ? open() : close());
    search.oninput = () => render(search.value.trim().toLowerCase());
    search.onkeydown = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); btn.focus(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(active + 1, rows.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(active - 1, 0)); }
      else if (e.key === "Enter") { e.preventDefault(); const r = rows[active]; if (r) choose(r.dataset.code); }
    };
  }
  const isTranslated = () => !!(rec && rec.blocks.some((b) => b.tr));
  // Translate the shot's original text to `newTarget` and render it as `layout`
  // (translated | bilingual). This is the ONLY place a shot spends an API call —
  // capture no longer translates. Used for the first translation (target ==
  // current) and for language changes (target differs).
  async function retranslate(newTarget, layout) {
    if (reshooting || !rec || !newTarget) return;
    if (newTarget === rec.target && isTranslated() && (!layout || viewBlob(layout))) return; // already there
    const want = layout === "bilingual" ? "bilingual" : "translated";
    reshooting = true; markViewButton(want);
    showBusy("Translating to " + langName(newTarget) + "…");
    const res = await new Promise((r) => chrome.runtime.sendMessage({ type: "SHOT_RETRANSLATE", id: rec.id, target: newTarget, layout: want }, (x) => r(chrome.runtime.lastError ? null : x)));
    reshooting = false;
    if (!res || !res.ok) {
      const err = (res && res.error) || "network";
      const msg = err === "tab-gone" ? "Open the original tab to translate, then try again."
        : err === "no-key" ? "Add an API key in the SubVibe popup to translate."
        : "Couldn't translate (" + err + "). Try again.";
      if (lastRenderedView) view = lastRenderedView; // stay on the view that's showing
      hideBusy(); setNote(msg, "warn"); markViewButton(view);
      return;
    }
    const fresh = await getShot(rec.id);
    if (fresh) { rec = fresh; try { S.validateRecord(rec); } catch (e) {} }
    edits.clear();
    clearBitmaps();
    view = want;
    renderHeader(); renderBlocks(); await render();
    hideBusy();
    toast("Now in " + langName(rec.target));
  }
  // Show a view, translating first if the shot has no translation yet.
  async function ensureView(v) {
    if (reshooting || !rec) return;
    if (v !== "original") chrome.storage.local.set({ shotLayout: v });
    if (v === "bilingual") {
      // Generated pairs card — no tab needed. Translate first if we have no pairs.
      view = v; markViewButton(v);
      if (hasPairs()) { await render(); return; }
      if (rec.target) { retranslate(rec.target, "bilingual"); return; }
      await render(); return;
    }
    if (viewBlob(v) || !tabAlive) { view = v; await render(); return; } // instant, or note (no tab)
    // Renders on the page: keep the current image + toolbar visible; the busy
    // overlay covers the wait and the new view fades in when it's ready.
    view = v; markViewButton(v);
    if (v !== "original" && !isTranslated()) retranslate(rec.target, v); // first translation on demand
    else reshoot();                                  // render from text we already have
  }
  function setNote(text, cls) {
    const bar = $("noteBar"); bar.hidden = !text; bar.textContent = text || ""; bar.className = "notebar" + (cls ? " " + cls : "");
  }
  function renderBlocks() {
    const wrap = $("blocks"); wrap.textContent = "";
    $("blockCount").textContent = rec.blocks.length + (rec.blocks.length === 1 ? " block" : " blocks");
    if (!rec.blocks.length) { const e = document.createElement("div"); e.className = "note"; e.textContent = "No page text inside this shot."; wrap.appendChild(e); return; }
    for (const b of rec.blocks) {
      const row = document.createElement("div"); row.className = "blk"; row.dataset.id = b.id;
      const k = document.createElement("span"); k.className = "k"; k.textContent = kindOf(b);
      const o = document.createElement("div"); o.className = "o"; o.textContent = b.text;
      const t = document.createElement("div"); t.className = "t"; t.contentEditable = "true"; t.dir = "auto"; t.spellcheck = false;
      t.textContent = edits.has(b.id) ? edits.get(b.id) : b.tr;
      t.addEventListener("input", () => {
        const v = t.textContent.replace(/\s+/g, " ").trim();
        if (v === b.tr) edits.delete(b.id); else edits.set(b.id, v);
        row.classList.toggle("edited", edits.has(b.id));
        k.textContent = kindOf(b) + (edits.has(b.id) ? " · edited" : "");
        updateReshoot();
      });
      t.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); t.blur(); } });
      row.append(k, o, t); wrap.appendChild(row);
    }
  }
  // The Apply button now serves translation edits only — switching views renders
  // automatically. It bakes edited translations back onto the current view.
  function updateReshoot() {
    const btn = $("reshootBtn"), note = $("reshootNote");
    note.className = "note";
    if (reshooting) { btn.disabled = true; note.textContent = "Rendering on the original tab…"; return; }
    const n = view === "original" ? 0 : edits.size; // edits are translations; they don't touch Original
    if (view === "bilingual") { // the card redraws locally — no tab needed
      btn.disabled = !n;
      note.textContent = n ? n + (n === 1 ? " translation edited" : " translations edited") + " · apply to redraw the card."
        : "Edit any translation above, then apply to redraw the card.";
      return;
    }
    if (!tabAlive) {
      btn.disabled = true; note.className = n ? "note warn" : "note";
      note.textContent = n ? "Open the original tab to apply your text changes." : "The original tab is closed — views already rendered still export.";
      return;
    }
    btn.disabled = !n;
    if (n) note.textContent = n + (n === 1 ? " translation edited" : " translations edited") + " · apply to re-render this view.";
    else note.textContent = "Edit any translation above, then apply to re-render it.";
  }
  // Bilingual is a generated card, so applying edited translations folds them
  // back into the sentence pairs and redraws — no page re-shoot.
  async function applyBilingualEdits() {
    if (!edits.size) return;
    for (const [id, tr] of edits) {
      const b = rec.blocks.find((x) => x.id === id); if (!b) continue;
      const oSents = S.splitSentences(b.text), tSents = S.splitSentences(tr);
      b.tr = tr;
      b.pairs = oSents.map((o, i) => ({ o, t: (oSents.length === tSents.length ? tSents[i] : (i === 0 ? tr : "")) || "" }));
    }
    edits.clear();
    try { await putShot(rec); } catch (e) {}
    renderBlocks(); await render();
    toast("Applied");
  }
  async function reshoot() {
    if (reshooting || !rec) return;
    if (view === "bilingual") return applyBilingualEdits(); // card, not a page re-shoot
    const layout = view; // translated | bilingual | original — the view the user is on
    const font = pendingFont != null ? pendingFont : (rec.font || "");
    const hadEdits = edits.size > 0;
    reshooting = true; updateReshoot();
    showBusy(hadEdits ? "Applying changes…" : "Rendering the " + viewLabel(layout) + " view…");
    const res = await new Promise((r) => chrome.runtime.sendMessage({ type: "SHOT_RESHOOT", id: rec.id, layout, blocks: [...edits].map(([id, tr]) => ({ id, tr })), font }, (x) => r(chrome.runtime.lastError ? null : x)));
    reshooting = false; pendingFont = null;
    const note = $("reshootNote");
    if (!res || !res.ok) {
      const err = (res && res.error) || "network";
      if (err === "tab-gone") tabAlive = false;
      if (lastRenderedView) view = lastRenderedView; // stay on the view still on screen
      hideBusy(); updateReshoot(); markViewButton(view);
      note.className = "note err";
      note.textContent = err === "tab-gone" ? "Original tab was closed — take a new shot to re-render."
        : err === "busy" ? "The original tab is still busy — try again in a moment."
        : "Re-shoot failed (" + err + "). Try again.";
      return; // the view that was showing stays put — no blank
    }
    const fresh = await getShot(rec.id);
    if (fresh) { rec = fresh; try { S.validateRecord(rec); } catch (e) { /* keep showing what we have */ } }
    if (layout !== "original") edits.clear(); // Original re-shoot doesn't consume translation edits
    clearBitmaps();
    renderHeader(); renderBlocks(); await render();
    hideBusy();
    toast(res.missing ? "Rendered · " + res.missing + " block" + (res.missing === 1 ? "" : "s") + " no longer on the page"
      : hadEdits ? "Applied" : "Rendered");
  }

  // ── export ────────────────────────────────────────────────────────────────
  async function exportBlob(format) {
    const c = document.createElement("canvas");
    const scale = S.exportScale(exp.size, rec.dpr || 1);
    let lay;
    if (view === "bilingual" && hasPairs()) { await ensureBiFont(); lay = drawPairsCard(c, scale); }
    else { const bmp = await bitmapFor(view); if (!bmp) return null; lay = drawFramed(c, bmp, scale); }
    renderAnnots(c.getContext("2d"), lay.img);
    const type = format === "jpeg" ? "image/jpeg" : "image/png";
    return new Promise((res) => c.toBlob((b) => res(b), type, 0.9));
  }
  const fileName = (format) => S.filename({ host: rec.host, ts: rec.ts, view, size: exp.size, format });
  async function download() {
    const blob = await exportBlob(exp.format);
    if (!blob) return toast("Re-shoot this view before exporting.");
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fileName(exp.format);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("Downloaded");
  }
  async function copy() {
    try {
      const blob = await exportBlob("png");
      if (!blob) return toast("Re-shoot this view before copying.");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("Copied");
    } catch (e) { toast("Copy failed — " + ((e && e.message) || "clipboard blocked")); }
  }
  async function share() {
    try {
      const blob = await exportBlob(exp.format);
      if (!blob) return toast("Re-shoot this view before sharing.");
      const file = new File([blob], fileName(exp.format), { type: blob.type });
      await navigator.share({ files: [file], title: rec.title || "SubVibe shot" });
    } catch (e) { if (!e || e.name !== "AbortError") toast("Share failed"); }
  }
  function shareSupported() {
    try {
      const f = new File([new Blob(["x"], { type: "image/png" })], "x.png", { type: "image/png" });
      return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [f] }));
    } catch (e) { return false; }
  }

  function annPt(n, img) { return [img.x + n.x * img.w, img.y + n.y * img.h]; }
  function renderAnnots(ctx, img) {
    for (const a of annots) {
      ctx.save();
      const col = a.color || "#F45D48";
      const lw = Math.max(1, (a.size || 0.006) * img.w);
      if (a.tool === "pen" || a.tool === "highlight") {
        ctx.strokeStyle = col; ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.lineWidth = a.tool === "highlight" ? lw * 3.2 : lw;
        if (a.tool === "highlight") ctx.globalAlpha = 0.35;
        ctx.beginPath();
        (a.pts || []).forEach((p, i) => { const [x, y] = annPt(p, img); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        if ((a.pts || []).length === 1) { const [x, y] = annPt(a.pts[0], img); ctx.lineTo(x + 0.1, y); }
        ctx.stroke();
      } else if (a.tool === "rect") {
        ctx.strokeStyle = col; ctx.lineWidth = lw;
        const [x1, y1] = annPt(a.a, img), [x2, y2] = annPt(a.b, img);
        ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      } else if (a.tool === "arrow") {
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = lw; ctx.lineCap = "round";
        const [x1, y1] = annPt(a.a, img), [x2, y2] = annPt(a.b, img);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        const ang = Math.atan2(y2 - y1, x2 - x1), head = Math.max(10, lw * 3.2);
        ctx.beginPath(); ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(ang - 0.42), y2 - head * Math.sin(ang - 0.42));
        ctx.lineTo(x2 - head * Math.cos(ang + 0.42), y2 - head * Math.sin(ang + 0.42));
        ctx.closePath(); ctx.fill();
      } else if (a.tool === "text" && a.text) {
        const fs = Math.max(11, (a.fontSize || 0.03) * img.w);
        ctx.font = "600 " + fs + "px system-ui, -apple-system, sans-serif";
        ctx.textBaseline = "top";
        ctx.direction = /[֐-ࣿ]/.test(a.text) ? "rtl" : "ltr";
        const [x, y] = annPt(a.at, img);
        const w = ctx.measureText(a.text).width;
        const bx = ctx.direction === "rtl" ? x - w : x;
        ctx.globalAlpha = 0.82; ctx.fillStyle = "#fff"; ctx.fillRect(bx - 4, y - 2, w + 8, fs + 6);
        ctx.globalAlpha = 1; ctx.fillStyle = col; ctx.fillText(a.text, x, y);
      } else if (a.tool === "textmark") {
        ctx.globalAlpha = 0.3; ctx.fillStyle = col;
        for (const bx of a.boxes || []) { const [x, y] = annPt(bx, img); ctx.fillRect(x - 2, y - 1, bx.w * img.w + 4, bx.h * img.h + 1); }
      }
      ctx.restore();
    }
  }
  function syncAnnot() {
    const stage = $("stage"), an = $("annot"); if (!an || !curLay) return;
    an.width = stage.width; an.height = stage.height;
    an.style.pointerEvents = annTool ? "auto" : "none";
    an.style.cursor = annTool === "text" ? "text" : annTool ? "crosshair" : "default";
    const ctx = an.getContext("2d"); ctx.clearRect(0, 0, an.width, an.height);
    renderAnnots(ctx, curLay.img);
  }
  async function saveAnnots() {
    if (!rec) return; rec.annots = annots;
    try { await putShot(rec); } catch (e) {}
  }
  function evToNorm(e) {
    const an = $("annot"), r = an.getBoundingClientRect();
    const px = (e.clientX - r.left) * (an.width / r.width), py = (e.clientY - r.top) * (an.height / r.height);
    const img = curLay.img;
    const nx = (px - img.x) / img.w, ny = (py - img.y) / img.h;
    return { x: Math.max(0, Math.min(1, nx)), y: Math.max(0, Math.min(1, ny)) };
  }
  // Line boxes the drag from a→b crosses vertically — the text-highlight snaps
  // to whole lines (only meaningful on the bilingual card, where biLineBoxes is set).
  function coveredBoxes(a, b) {
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    return biLineBoxes.filter((bx) => bx.y < maxY + 0.002 && bx.y + bx.h > minY - 0.002);
  }
  let annBuilt = false, drawing = null;
  function setupAnnot() {
    if (annBuilt) return; annBuilt = true;
    const colors = $("annColors");
    ANN_COLORS.forEach((c) => {
      const b = document.createElement("button"); b.className = "annswatch" + (c === annColor ? " on" : "");
      b.style.background = c; b.title = c; b.dataset.color = c;
      b.addEventListener("click", () => { annColor = c; for (const x of colors.querySelectorAll(".annswatch")) x.classList.toggle("on", x.dataset.color === c); });
      colors.appendChild(b);
    });
    $("annTools").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      annTool = b.dataset.tool || "";
      for (const x of $("annTools").querySelectorAll("button")) x.classList.toggle("on", x === b);
      syncAnnot();
    });
    $("annSize").addEventListener("input", (e) => { annSizeFrac = (+e.target.value || 5) / 850; });
    $("annUndo").addEventListener("click", () => { annots.pop(); syncAnnot(); saveAnnots(); });
    $("annClear").addEventListener("click", () => { if (annots.length && confirm("Remove all annotations?")) { annots = []; syncAnnot(); saveAnnots(); } });
    const an = $("annot");
    an.addEventListener("pointerdown", (e) => {
      if (!annTool || !curLay) return; e.preventDefault(); an.setPointerCapture(e.pointerId);
      const p = evToNorm(e);
      if (annTool === "text") { placeText(p); return; }
      if (annTool === "textmark") { drawing = { tool: "textmark", color: annColor, a: p, boxes: coveredBoxes(p, p) }; }
      else if (annTool === "pen" || annTool === "highlight") drawing = { tool: annTool, color: annColor, size: annSizeFrac, pts: [p] };
      else drawing = { tool: annTool, color: annColor, size: annSizeFrac, a: p, b: p };
    });
    an.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      const p = evToNorm(e);
      if (drawing.tool === "textmark") drawing.boxes = coveredBoxes(drawing.a, p);
      else if (drawing.pts) drawing.pts.push(p); else drawing.b = p;
      const ctx = an.getContext("2d"); ctx.clearRect(0, 0, an.width, an.height); renderAnnots(ctx, curLay.img);
      annots.push(drawing); renderAnnots(ctx, curLay.img); annots.pop(); // preview the in-progress shape
    });
    function finish() { if (!drawing) return; const d = drawing; drawing = null; const ok = d.tool === "textmark" ? (d.boxes && d.boxes.length > 0) : d.pts ? d.pts.length > 1 : (Math.abs(d.a.x - d.b.x) + Math.abs(d.a.y - d.b.y)) > 0.005; if (ok) { annots.push(d); saveAnnots(); } syncAnnot(); }
    an.addEventListener("pointerup", finish);
    an.addEventListener("pointercancel", finish);
  }
  function placeText(p) {
    const inp = $("annotText"), an = $("annot"), r = an.getBoundingClientRect(), wrap = $("canvasWrap").getBoundingClientRect();
    const px = p.x * curLay.img.w + curLay.img.x, py = p.y * curLay.img.h + curLay.img.y;
    inp.style.left = (r.left - wrap.left + px * (r.width / an.width)) + "px";
    inp.style.top = (r.top - wrap.top + py * (r.height / an.height)) + "px";
    inp.style.color = annColor; inp.value = ""; inp.hidden = false; inp.focus();
    const commit = () => {
      inp.hidden = true; inp.onblur = null; inp.onkeydown = null;
      const t = inp.value.trim();
      if (t) { annots.push({ tool: "text", color: annColor, at: p, fontSize: Math.max(0.02, annSizeFrac * 4), text: t }); saveAnnots(); }
      syncAnnot();
    };
    inp.onblur = commit;
    inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } else if (e.key === "Escape") { inp.hidden = true; inp.onblur = null; } };
  }

  // ── recent strip ──
  async function renderRecent() {
    const wrap = $("recent");
    for (const old of wrap.querySelectorAll(".thumb")) { URL.revokeObjectURL(old.src); old.remove(); }
    const all = (await listShots()).slice(0, RECENT);
    for (const r of all) {
      if (!(r.variant instanceof Blob)) continue;
      const img = document.createElement("img"); img.className = "thumb" + (rec && r.id === rec.id ? " on" : "");
      img.src = URL.createObjectURL(r.variant); img.alt = r.title || ""; img.title = r.title || r.url;
      img.addEventListener("click", () => { location.search = "?id=" + encodeURIComponent(r.id); });
      wrap.appendChild(img);
    }
  }

  // ── boot ──────────────────────────────────────────────────────────────────
  function showEmpty(msg) {
    $("stageSkel").hidden = true; $("stage").hidden = true;
    const e = $("emptyState"); e.hidden = false; if (msg) e.textContent = msg;
    document.querySelector(".panel").hidden = true;
  }
  async function load() {
    const id = new URLSearchParams(location.search).get("id") || "";
    const prefs = await chrome.storage.local.get(["shotFrame", "shotExport", "shotBilingual"]);
    if (prefs.shotFrame && typeof prefs.shotFrame === "object") frame = { frame: prefs.shotFrame.frame === "plain" ? "plain" : "card", badge: prefs.shotFrame.badge !== false };
    if (["A", "B", "C"].includes(prefs.shotBilingual)) biLayout = prefs.shotBilingual;
    if (prefs.shotExport && typeof prefs.shotExport === "object") exp = { size: ["native", "2x", "1x", "half"].includes(prefs.shotExport.size) ? prefs.shotExport.size : "native", format: prefs.shotExport.format === "jpeg" ? "jpeg" : "png" };
    for (const b of $("frameSeg").querySelectorAll("button")) b.classList.toggle("on", b.dataset.frame === frame.frame);
    $("badgeSw").checked = frame.badge; $("sizeSel").value = exp.size; $("fmtSel").value = exp.format;
    $("shareBtn").hidden = !shareSupported();

    let r = null;
    try { r = id ? await getShot(id) : null; } catch (e) { r = null; }
    if (!r) {
      const newest = (await listShots())[0];
      if (newest && !id) { location.search = "?id=" + encodeURIComponent(newest.id); return; }
      showEmpty(id ? "This shot no longer exists." : undefined);
      await renderRecent();
      return;
    }
    try { S.validateRecord(r); } catch (e) { showEmpty("This shot is damaged and can't be opened."); return; }
    rec = r; annots = Array.isArray(rec.annots) ? rec.annots : [];
    try { const a = await new Promise((res) => chrome.runtime.sendMessage({ type: "SHOT_TAB_ALIVE", id: rec.id }, (x) => res(chrome.runtime.lastError ? null : x))); tabAlive = !a || a.alive !== false; } catch (e) { tabAlive = true; }
    view = rec.layout === "original" ? "original" : rec.layout;
    if (view === "bilingual" && !hasPairs()) view = "original"; // nothing to pair yet
    if (view === "bilingual") ensureBiFont();
    for (const bn of $("fontSeg").querySelectorAll("button")) bn.classList.toggle("on", (bn.dataset.font || "") === (rec.font || ""));
    document.title = "SubVibe Shot · " + (rec.title || rec.host);
    renderHeader(); renderBlocks();
    await render();
    renderRecent();
  }

  $("viewSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || !rec || reshooting) return;
    // ensureView translates on demand (if the shot has no translation yet) and
    // renders once on the page, then it's cached and every later switch is instant.
    ensureView(b.dataset.view);
  });
  // Bilingual pairing layout — switching just redraws the card (instant) and
  // saves the choice as the default for future shots.
  $("biBar").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || !rec) return;
    const v = b.dataset.bi; if (!["A", "B", "C"].includes(v) || v === biLayout) return;
    biLayout = v;
    try { chrome.storage.local.set({ shotBilingual: v }); } catch (er) {}
    for (const x of $("biBar").querySelectorAll("button")) x.classList.toggle("on", x === b);
    const hint = $("biHint"); if (hint) hint.textContent = "Saved as your default.";
    if (view === "bilingual") renderBilingual();
  });
  $("frameSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || !rec || reshooting) return;
    frame.frame = b.dataset.frame === "plain" ? "plain" : "card";
    for (const x of $("frameSeg").querySelectorAll("button")) x.classList.toggle("on", x === b);
    chrome.storage.local.set({ shotFrame: frame }); render();
  });
  $("badgeSw").addEventListener("change", () => { if (reshooting) return; frame.badge = $("badgeSw").checked; chrome.storage.local.set({ shotFrame: frame }); render(); });
  $("sizeSel").addEventListener("change", () => { if (reshooting) return; exp.size = $("sizeSel").value; chrome.storage.local.set({ shotExport: exp }); render(); });
  $("fmtSel").addEventListener("change", () => { if (reshooting) return; exp.format = $("fmtSel").value; chrome.storage.local.set({ shotExport: exp }); render(); });
  $("fontSeg").addEventListener("click", async (e) => {
    const bn = e.target.closest("button"); if (!bn || !rec) return;
    const f = bn.dataset.font || "";
    if (f === (rec.font || "")) return;
    for (const x of $("fontSeg").querySelectorAll("button")) x.classList.toggle("on", x === bn);
    try { chrome.storage.local.set({ shotFont: f }); } catch (er) {} // remember for next shots
    rec.font = f; try { await putShot(rec); } catch (er) {} // persist so the next render (here or on first translate) uses it
    if (view === "bilingual") { await ensureBiFont(); renderBilingual(); return; } // the card redraws instantly
    if (!isTranslated()) { setNote("The font applies to translated text \u2014 pick Translated or Bilingual first.", ""); return; }
    if (!tabAlive) { setNote("Open the original tab to change the font.", "warn"); return; }
    if (view === "original") view = rec.layout === "original" ? "translated" : rec.layout;
    pendingFont = f; setNote("Applying " + (f ? "Vazirmatn" : "the site font") + "\u2026", ""); reshoot();
  });
  $("reshootBtn").addEventListener("click", reshoot);
  $("dlBtn").addEventListener("click", download);
  $("copyBtn").addEventListener("click", copy);
  $("shareBtn").addEventListener("click", share);
  $("delBtn").addEventListener("click", async () => {
    if (!rec || !confirm("Delete this shot? This can't be undone.")) return;
    const gone = rec.id;
    await delShot(gone);
    const next = (await listShots()).find((r) => r.id !== gone);
    if (next) location.search = "?id=" + encodeURIComponent(next.id);
    else { rec = null; showEmpty(); await renderRecent(); }
  });

  load().catch((e) => { console.error("[SubVibe shot] load failed", e); showEmpty("Couldn't open this shot."); });
})();
