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
  let frame = { frame: "card", badge: true, bg: "sunset" };
  // Card/Window backgrounds — fixed colours, so an export looks the same in
  // light and dark UI. Sunset is the original Daylight gradient.
  const FRAME_BGS = {
    sunset: ["#F7E6D6", "#E9D5F0", "#D4E9E4"], ocean: ["#D2ECF4", "#C3D9F7", "#DCD4F6"], ember: ["#FBD7C9", "#FCE3B9", "#F8D2DB"],
    meadow: ["#D8F1D3", "#CFECE1", "#E1EDC9"], stone: ["#EEEAE3", "#E2DCD3", "#ECE6DE"], ink: ["#2A2522", "#1F1B24", "#172826"],
  };
  const FRAME_BG_NAMES = { sunset: "Sunset", ocean: "Ocean", ember: "Ember", meadow: "Meadow", stone: "Stone", ink: "Ink" };
  const bgStops = () => FRAME_BGS[frame.bg] || FRAME_BGS.sunset;
  const UI_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  let exp = { size: "native", format: "png" };
  const bitmaps = {};          // "original" | "variant" → ImageBitmap
  // ── annotation layer (pen / highlighter / text / arrow / rect) ──
  let annots = [];             // {tool,color,size(frac of img.w),pts?,a?,b?,text?,at?,fontSize?}
  let annTool = "";            // "" = no drawing (select), else a tool
  let annColor = "#F45D48";
  let annSizeFrac = 0.006;
  let selected = -1;           // index into annots picked with the Select tool (move / delete)
  // A mark lives on the surface it was drawn on: a page view, the reading
  // card, the notes sheet or the side-by-side pair have different geometry.
  // Marks from before this rule (no `on`) show everywhere, as they always did.
  const surface = () => (view === "bilingual" ? (biLayout === "N" ? "bi-notes" : biLayout === "S" ? "bi-pages" : "bi-card") : view);
  const visibleAnnots = () => annots.filter((a) => a && (!a.on || a.on === surface()));
  let curLay = null;           // last drawFramed() layout (device px) for coord mapping
  const ANN_COLORS = ["#F45D48", "#FFC53D", "#22C55E", "#3B82F6", "#111827", "#FFFFFF"];
  // Non-destructive crop (rec.crop, full-image fractions) — applies to the page
  // image views only; the bilingual card is generated, not cropped.
  const curCrop = () => (rec && view !== "bilingual" && rec.crop && !S.isFullCrop(rec.crop) ? S.normCrop(rec.crop) : null);
  const edits = new Map();     // block id → edited translation
  let reshooting = false;
  let lastRenderedView = null; // the view whose pixels are actually on the canvas
  let tabAlive = true; // re-set on load via SHOT_TAB_ALIVE
  let pendingFont = null; // set by the Font control to re-render with a new font
  let biLayout = "B";     // bilingual: A blocks · B pairs · C columns (reading card) · N margin notes · S pages side by side
  let biStyle = "balanced"; // the translation line on the card / notes: quiet · balanced · equal
  let resumeView = null;  // view to return to after a re-shoot that only served as an ingredient (side by side)
  // Study card: grammar of one side (target = the translation, source = the
  // original), explained in "other" (your language) or "same" (immersion).
  let studySide = "", studyExpl = "";     // "" = derive the default per shot
  let nativeLang = "";                   // the popup's primary language (targets[0])
  let learnLang = "";                    // the popup's "I'm learning" language
  const BI_DESC = {
    A: "Whole original, then the whole translation.", B: "Each sentence, then its translation.", C: "Original and translation side by side, sentence by sentence.",
    G: "Grammar hints on every sentence: gender colours, numbered notes, a simpler version, a summary per paragraph.",
    N: "The original page, every translation as a numbered note in the margin.", S: "The original page and the translated page in one image.",
  };
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
  const fontStack = (rtl) => (rtl || (rec && rec.font === "vazirmatn")) ? '"SubVibe Vazirmatn", system-ui, -apple-system, sans-serif' : UI_FONT;
  const code = (c) => (c || "").split("-")[0].toUpperCase();

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
  // ── frame painters (shared by every view) ──
  const framed = () => frame.frame !== "plain";
  function paintBg(ctx, lay) {
    if (!framed()) return;
    const [a, b, c] = bgStops();
    const g = ctx.createLinearGradient(0, 0, lay.width, lay.height);
    g.addColorStop(0, a); g.addColorStop(0.55, b); g.addColorStop(1, c);
    ctx.fillStyle = g; ctx.fillRect(0, 0, lay.width, lay.height);
  }
  // The raised white sheet a page sits on (card + window); `box` includes the
  // title bar when there is one, so bar and page share one rounded outline.
  function paintPaper(ctx, box, radius, dpr, fill) {
    ctx.save();
    if (framed()) { ctx.shadowColor = "rgba(40,20,10,.33)"; ctx.shadowBlur = 30 * dpr; ctx.shadowOffsetY = 10 * dpr; }
    ctx.fillStyle = fill || "#fff"; roundRect(ctx, box.x, box.y, box.w, box.h, radius); ctx.fill();
    ctx.restore();
  }
  // Browser title bar: traffic lights + the host in an address pill. `label`
  // (optional) replaces the host — side by side names the language.
  function paintBar(ctx, bar, radius, pageH, dpr, label) {
    ctx.save();
    roundRect(ctx, bar.x, bar.y, bar.w, bar.h + pageH, radius); ctx.clip();
    ctx.fillStyle = "#F3F0EA"; ctx.fillRect(bar.x, bar.y, bar.w, bar.h);
    ctx.fillStyle = "rgba(0,0,0,.09)"; ctx.fillRect(bar.x, bar.y + bar.h - Math.max(1, dpr), bar.w, Math.max(1, dpr));
    const cy = bar.y + bar.h / 2, r = 5.5 * dpr;
    ["#FF5F57", "#FEBC2E", "#28C840"].forEach((c, i) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(bar.x + 16 * dpr + i * 18 * dpr, cy, r, 0, Math.PI * 2); ctx.fill(); });
    const text = label || (rec.host || "").replace(/^www\./, "") || "";
    ctx.font = "500 " + Math.round(12 * dpr) + "px " + UI_FONT;
    const tw = ctx.measureText(text).width, ph = Math.round(22 * dpr);
    const pw = Math.min(bar.w * 0.56, tw + 28 * dpr), px = bar.x + (bar.w - pw) / 2, py = cy - ph / 2;
    ctx.fillStyle = "rgba(0,0,0,.055)"; roundRect(ctx, px, py, pw, ph, ph / 2); ctx.fill();
    ctx.save(); roundRect(ctx, px, py, pw, ph, ph / 2); ctx.clip();
    ctx.fillStyle = "#6B6259"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.direction = "ltr";
    ctx.fillText(text, bar.x + bar.w / 2, cy + 0.5 * dpr); ctx.restore();
    ctx.restore();
  }
  function paintBadge(ctx, lay, dpr) {
    if (!lay.badge) return;
    const label = "SUBVIBE · " + code(rec.source === "xx" ? "" : rec.source) + (rec.source === "xx" ? "" : " → ") + code(rec.target);
    ctx.font = "600 " + Math.round(11 * dpr) + "px ui-monospace, Menlo, Consolas, monospace";
    const tw = ctx.measureText(label).width, bw = tw + lay.badge.padX * 2, bh = lay.badge.h;
    const bx = lay.badge.x - bw, by = lay.badge.y - bh / 2;
    ctx.fillStyle = "rgba(255,255,255,.72)"; roundRect(ctx, bx, by, bw, bh, bh / 2); ctx.fill();
    ctx.fillStyle = "#A93521"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillText(label, bx + lay.badge.padX, by + bh / 2 + 0.5 * dpr);
  }
  // Small language caption above a page (side by side) in the card padding.
  function paintCaption(ctx, x, y, w, text, dpr, rtl) {
    ctx.save();
    ctx.font = "700 " + Math.round(11 * dpr) + "px ui-monospace, Menlo, Consolas, monospace";
    ctx.fillStyle = frame.bg === "ink" ? "rgba(255,255,255,.72)" : "rgba(36,31,26,.62)";
    ctx.textBaseline = "alphabetic"; ctx.direction = "ltr"; ctx.textAlign = rtl ? "right" : "left";
    ctx.fillText(text.toUpperCase(), rtl ? x + w : x, y);
    ctx.restore();
  }
  // Paints `bmp` framed per `frame` into `canvas`; `scale` is relative to the
  // capture's device pixels (1 = native).
  function drawFramed(canvas, bmp, scale) {
    const dpr = (rec.dpr || 1) * scale;
    const { sx, sy, sw, sh } = S.cropSrc(curCrop(), bmp.width, bmp.height);
    const lay = S.frameLayout({ w: Math.round(sw * scale), h: Math.round(sh * scale), frame: frame.frame, badge: frame.badge, dpr });
    canvas.width = lay.width; canvas.height = lay.height;
    const ctx = canvas.getContext("2d");
    if (framed()) {
      paintBg(ctx, lay);
      const box = lay.bar ? { x: lay.bar.x, y: lay.bar.y, w: lay.bar.w, h: lay.bar.h + lay.img.h } : lay.img;
      paintPaper(ctx, box, lay.img.radius, dpr);
      if (lay.bar) paintBar(ctx, lay.bar, lay.img.radius, lay.img.h, dpr);
      ctx.save(); roundRect(ctx, box.x, box.y, box.w, box.h, lay.img.radius); ctx.clip();
      ctx.beginPath(); ctx.rect(lay.img.x, lay.img.y, lay.img.w, lay.img.h); ctx.clip();
      ctx.drawImage(bmp, sx, sy, sw, sh, lay.img.x, lay.img.y, lay.img.w, lay.img.h); ctx.restore();
      paintBadge(ctx, lay, dpr);
    } else {
      ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, lay.width, lay.height);
    }
    return lay;
  }

  // ── bilingual on the page: side by side / margin notes ──────────────────
  // Original | translated page in one picture. Needs both rasters; returns
  // null when the translated page hasn't been rendered yet.
  async function drawSideBySide(canvas, scale) {
    const o = await bitmapFor("original");
    const pt = await pageBitmap("translated"); const t = pt.bmp;
    if (!o || !t) return null;
    sideBySidePainted = pt.painted;
    const dpr = (rec.dpr || 1) * scale;
    const crop = curCrop();
    const so = S.cropSrc(crop, o.width, o.height), st = S.cropSrc(crop, t.width, t.height);
    const gap = Math.round(28 * dpr), barH = frame.frame === "window" ? Math.round(36 * dpr) : 0;
    const A = { w: Math.round(so.sw * scale), h: Math.round(so.sh * scale) }, B = { w: Math.round(st.sw * scale), h: Math.round(st.sh * scale) };
    const sb = S.sideBySide(A, B, gap);
    const capH = framed() ? Math.round(18 * dpr) : 0; // caption line above each page
    const lay = S.frameLayout({ w: sb.width, h: sb.height + barH + capH, frame: framed() ? "card" : "plain", badge: frame.badge, dpr });
    canvas.width = lay.width; canvas.height = lay.height;
    const ctx = canvas.getContext("2d");
    paintBg(ctx, lay);
    const top = lay.img.y + capH;
    const pages = [[sb.a, o, so, langName(rec.source === "xx" ? "" : rec.source) || "Original", false], [sb.b, t, st, langName(rec.target), S.isRtl(rec.target)]];
    for (const [box, bmp, src, caption, rtl] of pages) {
      const x = lay.img.x + box.x, y = top + barH;
      if (framed()) {
        paintPaper(ctx, { x, y: top, w: box.w, h: barH + box.h }, lay.img.radius, dpr);
        if (barH) paintBar(ctx, { x, y: top, w: box.w, h: barH }, lay.img.radius, box.h, dpr, caption);
        paintCaption(ctx, x, lay.img.y + Math.round(12 * dpr), box.w, caption, dpr, rtl);
      }
      ctx.save(); roundRect(ctx, x, top, box.w, barH + box.h, framed() ? lay.img.radius : 0); ctx.clip();
      ctx.beginPath(); ctx.rect(x, y, box.w, box.h); ctx.clip();
      ctx.drawImage(bmp, src.sx, src.sy, src.sw, src.sh, x, y, box.w, box.h); ctx.restore();
    }
    paintBadge(ctx, lay, dpr);
    // Annotations map over the whole two-page area.
    return { ...lay, img: { x: lay.img.x, y: top + barH, w: sb.width, h: sb.height, radius: 0 } };
  }
  // The original page with a margin column of numbered notes: one per text
  // block, level with the block when there's room, pushed down otherwise.
  async function drawNotes(canvas, scale) {
    const bmp = await bitmapFor("original"); if (!bmp) return null;
    await ensureBiFont();
    const dpr = (rec.dpr || 1) * scale;
    const c = S.normCrop(curCrop());
    const { sx, sy, sw, sh } = S.cropSrc(c, bmp.width, bmp.height);
    const pw = Math.round(sw * scale), ph = Math.round(sh * scale);
    const rtl = S.isRtl(rec.target);
    const mw = Math.round(Math.max(220, Math.min(360, Math.round((rec.w || 640) * 0.42))) * dpr);
    const PADN = Math.round(14 * dpr), GAPN = Math.round(10 * dpr), NR = Math.round(9 * dpr);
    const fs = Math.round((biStyle === "quiet" ? 12.5 : biStyle === "equal" ? 15 : 13.5) * dpr), LH = Math.round(fs * 1.45);
    const font = "400 " + fs + "px " + fontStack(rtl);
    const mc = canvas.getContext("2d"); mc.font = font;
    const textW = mw - PADN * 2 - NR * 2 - Math.round(6 * dpr);
    const items = [];
    for (const b of rec.blocks) {
      const tr = ((Array.isArray(b.pairs) && b.pairs.length) ? b.pairs.map((p) => (p && p.t) || "").filter(Boolean).join(" ") : b.tr) || "";
      if (!tr || !b.rect || !rec.rect) continue;
      const fx = (b.rect.x - rec.rect.x) / rec.rect.w, fy = (b.rect.y - rec.rect.y) / rec.rect.h;
      if (fy < c.y - 0.002 || fy > c.y + c.h || fx + b.rect.w / rec.rect.w < c.x || fx > c.x + c.w) continue; // outside the crop
      const px = (fx - c.x) / c.w * pw, py = (fy - c.y) / c.h * ph;
      const lines = wrapText(mc, tr, textW);
      items.push({ px, py, lines, h: lines.length * LH + Math.round(4 * dpr) });
    }
    const placed = S.layoutNotes(items.map((it) => ({ y: it.py, h: it.h })), GAPN);
    const contentH = Math.max(ph, placed.bottom + PADN);
    const lay = S.frameLayout({ w: pw + mw, h: contentH, frame: frame.frame, badge: frame.badge, dpr });
    canvas.width = lay.width; canvas.height = lay.height;
    const g = canvas.getContext("2d");
    paintBg(g, lay);
    const box = lay.bar ? { x: lay.bar.x, y: lay.bar.y, w: lay.bar.w, h: lay.bar.h + lay.img.h } : lay.img;
    if (framed()) paintPaper(g, box, lay.img.radius, dpr);
    if (lay.bar) paintBar(g, lay.bar, lay.img.radius, lay.img.h, dpr);
    g.save(); roundRect(g, box.x, box.y, box.w, box.h, framed() ? lay.img.radius : 0); g.clip();
    g.beginPath(); g.rect(lay.img.x, lay.img.y, lay.img.w, lay.img.h); g.clip();
    g.fillStyle = "#fff"; g.fillRect(lay.img.x, lay.img.y, pw, lay.img.h);
    g.drawImage(bmp, sx, sy, sw, sh, lay.img.x, lay.img.y, pw, ph);
    const mx = lay.img.x + pw;
    g.fillStyle = "#FFFDF7"; g.fillRect(mx, lay.img.y, mw, lay.img.h);
    g.fillStyle = "rgba(0,0,0,.09)"; g.fillRect(mx, lay.img.y, Math.max(1, dpr), lay.img.h);
    const coral = "#C93F2B", INK = "#2c6a64";
    const badge = (x, y, n) => {
      g.beginPath(); g.arc(x, y, NR, 0, Math.PI * 2); g.fillStyle = coral; g.fill();
      g.lineWidth = Math.max(1.5, 1.5 * dpr); g.strokeStyle = "rgba(255,255,255,.92)"; g.stroke();
      g.fillStyle = "#fff"; g.font = "700 " + Math.round(NR * 1.2) + "px " + UI_FONT; g.textAlign = "center"; g.textBaseline = "middle"; g.direction = "ltr";
      g.fillText(String(n), x, y + 0.5 * dpr);
    };
    biLineBoxes = [];
    items.forEach((it, i) => {
      const n = i + 1;
      const bx = lay.img.x + it.px, by = lay.img.y + it.py;
      badge(bx >= lay.img.x + NR * 2 ? bx - NR - 3 * dpr : bx + NR + 2 * dpr, by + NR + 2 * dpr, n);
      const top = lay.img.y + placed.tops[i];
      const nx = rtl ? mx + mw - PADN - NR : mx + PADN + NR;
      badge(nx, top + NR + 2 * dpr, n);
      g.font = font; g.fillStyle = INK; g.textBaseline = "top"; g.direction = rtl ? "rtl" : "ltr"; g.textAlign = rtl ? "right" : "left";
      const tx = rtl ? mx + mw - PADN - NR * 2 - Math.round(6 * dpr) : mx + PADN + NR * 2 + Math.round(6 * dpr);
      it.lines.forEach((ln, k) => {
        const ly = top + k * LH;
        g.fillText(ln, tx, ly);
        const w = g.measureText(ln).width;
        biLineBoxes.push({ x: ((rtl ? tx - w : tx) - lay.img.x) / lay.img.w, y: (ly - lay.img.y) / lay.img.h, w: w / lay.img.w, h: LH / lay.img.h });
      });
    });
    g.restore();
    paintBadge(g, lay, dpr);
    return lay;
  }
  // ── study card ────────────────────────────────────────────────────────────
  const studyLangOf = (side) => (side === "source" ? (rec.source && rec.source !== "xx" ? rec.source : "") : rec.target) || "";
  // Default side: the language you're learning if it is one of the two, else
  // the translation. Default explanation: your language when studying the
  // translation, the same language (immersion) when studying the original.
  function effStudySide() {
    if (studySide) return studySide;
    if (learnLang && studyLangOf("source") === learnLang) return "source";
    return "target";
  }
  function effStudyExpl() { return studyExpl || (effStudySide() === "source" ? "same" : "other"); }
  function studyExplainLang() {
    const side = effStudySide(), lang = studyLangOf(side);
    if (effStudyExpl() === "same") return lang;
    const other = side === "source" ? rec.target : (rec.source && rec.source !== "xx" ? rec.source : "");
    if (nativeLang && nativeLang !== lang.split("-")[0]) return nativeLang;
    return other && other !== lang ? other : lang;
  }
  const studyKeyNow = () => S.studyKey(effStudySide() + ":" + studyLangOf(effStudySide()), studyExplainLang());
  const isTips = () => !!(rec && rec.mode === "tips");
  const studyData = () => {
    if (!rec || !rec.study || typeof rec.study !== "object") return null;
    if (isTips() || rec.mode === "snap") { const k = Object.keys(rec.study)[0]; return k ? rec.study[k] : null; } // one ready-made analysis, no side/explain choice
    return rec.study[studyKeyNow()] || null;
  };
  let studying = false;
  async function fetchStudy() {
    const side = effStudySide(), lang = studyLangOf(side);
    const vn = $("viewNote");
    if (!lang) { vn.className = "note warn"; vn.textContent = "The original's language isn't known — translate first, or study the translation."; await ensureBiFont(); const lay = drawPairsCard($("stage"), 1); finishBilingual(lay); return; }
    studying = true; syncStudyRow();
    showBusy("Analysing " + langName(lang) + " grammar…");
    const res = await new Promise((r) => chrome.runtime.sendMessage({ type: "SHOT_STUDY", id: rec.id, side, explain: studyExplainLang() }, (x) => r(chrome.runtime.lastError ? null : x)));
    studying = false;
    hideBusy();
    if (!res || !res.ok) {
      const err = (res && res.error) || "network";
      vn.className = "note warn";
      vn.textContent = err === "no-key" ? "Add an API key in the SubVibe popup (or connect Claude Code) to analyse grammar."
        : err === "empty" || err === "no-lang" ? "Nothing to analyse on this side yet — translate first."
        : "Couldn't analyse the grammar (" + err + "). Try again.";
      await ensureBiFont(); const lay = drawPairsCard($("stage"), 1); finishBilingual(lay); return;
    }
    const fresh = await getShot(rec.id); if (fresh) { rec = fresh; try { S.validateRecord(rec); } catch (e) {} }
    if (view === "bilingual") renderBilingual();
  }
  // Stage bookkeeping shared by the fallback paths (mirrors renderBilingual's tail).
  function finishBilingual(lay) {
    const canvas = $("stage"); curLay = lay;
    canvas.style.width = Math.round(lay.width / (rec.dpr || 1)) + "px"; canvas.style.opacity = "1";
    lastRenderedView = "bilingual"; $("stageSkel").hidden = true; $("canvasWrap").hidden = false;
    setupAnnot(); $("annotBar").hidden = false; selected = -1; syncAnnot(); markViewButton("bilingual");
    for (const b of $("biPick").querySelectorAll("[data-bi]")) b.classList.toggle("on", b.dataset.bi === biLayout);
    syncStudyRow(); $("biPick").hidden = false; updateReshoot();
    for (const id of ["dlBtn", "copyBtn", "shareBtn"]) { const el = $(id); if (el) el.disabled = false; }
  }
  function syncStudyRow() {
    const row = $("studyRow"); if (!row) return;
    row.hidden = biLayout !== "G" || isTips() || rec.mode === "snap";
    if (row.hidden || !rec) return;
    const side = effStudySide(), lang = studyLangOf(side);
    for (const b of $("studySideBar").querySelectorAll("button")) {
      const l = studyLangOf(b.dataset.side);
      b.textContent = l ? langName(l) : (b.dataset.side === "source" ? "Original" : "Translation");
      b.classList.toggle("on", b.dataset.side === side);
      b.disabled = !l || studying;
    }
    const other = (() => { const o = side === "source" ? rec.target : (rec.source && rec.source !== "xx" ? rec.source : ""); return nativeLang && nativeLang !== lang.split("-")[0] ? nativeLang : (o && o !== lang ? o : ""); })();
    for (const b of $("studyExplBar").querySelectorAll("button")) {
      b.textContent = b.dataset.expl === "same" ? (lang ? langName(lang) : "Same language") : (other ? langName(other) : "Your language");
      b.classList.toggle("on", b.dataset.expl === effStudyExpl());
      b.disabled = studying || (b.dataset.expl === "other" && !other);
    }
  }
  const GENDER = { m: ["#2F6FE4", "#E8F0FD"], f: ["#D64550", "#FCE9EB"], n: ["#2E9E5B", "#E6F5EC"] };
  const STUDY_LABELS = {
    de: { m: "der · maskulin", f: "die · feminin", n: "das · neutrum", v: "zweiteiliges Verb", note: "Hinweis", simple: "Einfacher gesagt", notes: "Hinweise", summary: "Kurz gesagt" },
    fa: { m: "der · مذکر", f: "die · مؤنث", n: "das · خنثی", v: "فعل دوبخشی", note: "نکته", simple: "ساده‌تر", notes: "نکته‌ها", summary: "خلاصه" },
    en: { m: "der · masculine", f: "die · feminine", n: "das · neuter", v: "two-part verb", note: "note", simple: "Put simply", notes: "Notes", summary: "In short" },
  };
  const studyLabels = (lang) => STUDY_LABELS[(lang || "").split("-")[0]] || STUDY_LABELS.en;
  // A note = bold term + explanation. The term is its own run on the first
  // line; the explanation wraps as whole-line strings so the canvas can shape
  // mixed-direction text (Latin words inside Persian) correctly.
  function wrapNote(ctx, term, text, fTerm, fText, maxW) {
    ctx.font = fTerm; const termW = term ? ctx.measureText(term + " —").width + 6 : 0;
    const termAlone = termW > maxW * 0.7;
    ctx.font = fText;
    const words = String(text || "").split(" ").filter(Boolean);
    const lines = []; let cur = "", avail = termAlone ? maxW : maxW - termW;
    for (const wd of words) {
      const test = cur ? cur + " " + wd : wd;
      if (!cur || ctx.measureText(test).width <= avail) cur = test;
      else { lines.push(cur); cur = wd; avail = maxW; }
    }
    if (cur || !lines.length) lines.push(cur);
    return { termW: termAlone ? 0 : termW, termAlone, lines };
  }
  // The study card: per sentence the marked text, its meaning, a simpler
  // version and the numbered notes; per block a summary. Returns the frame
  // layout, or null when this side/language has no analysis yet.
  function drawStudyCard(canvas, scale) {
    const d = studyData(); if (!d) return null;
    const dpr = (rec.dpr || 1) * scale;
    const lang = d.lang, expl = d.explain || lang;
    const L = studyLabels(expl), Ls = studyLabels(lang);
    const rtlS = S.isRtl(lang), rtlE = S.isRtl(expl);
    const baseCss = Math.min(880, Math.max(640, Math.round((rec.rect && rec.rect.w) || 640)));
    const paperW = Math.round(baseCss * dpr), PAD = Math.round(28 * dpr), innerW = paperW - PAD * 2;
    const px = (n) => Math.round(n * dpr);
    const fS = "400 " + px(17.5) + "px " + fontStack(rtlS), lhS = px(17.5 * 1.75);
    const fSup = "700 " + px(10.5) + "px ui-monospace, Menlo, Consolas, monospace";
    const fM = "400 " + px(15) + "px " + fontStack(rtlE), lhM = px(15 * 1.6);
    const fSimple = "400 " + px(14.5) + "px " + fontStack(rtlS), lhSimple = px(14.5 * 1.55);
    const fNote = "400 " + px(13.5) + "px " + fontStack(rtlE), fTerm = "600 " + px(13.5) + "px " + fontStack(rtlS), lhNote = px(13.5 * 1.55);
    const fLbl = "600 " + px(10) + "px ui-monospace, Menlo, Consolas, monospace";
    const fLegend = "600 " + px(11) + "px ui-monospace, Menlo, Consolas, monospace";
    const INK = "#1f1c18", INK2 = "#3d362f", MUTED = "#8a7d6f", TEAL = "#2c6a64", CORAL = "#C93F2B", LINE = "#ebe4d9";
    const mc = canvas.getContext("2d");
    const ops = []; let y = 0;
    biLineBoxes = [];
    const boxes = []; const box = (x, yy, w, h) => boxes.push({ x, y: yy, w, h }); // text lines for the text-highlight tool
    // legend: only the marks that occur
    const marks = S.studyMarks(d.blocks);
    const legend = [];
    for (const g of ["m", "f", "n"]) if (marks[g]) legend.push({ dot: GENDER[g][0], text: L[g] });
    if (marks.v) legend.push({ bar: CORAL, text: L.v });
    if (marks.notes) legend.push({ sup: "1", text: L.note });
    if (legend.length) {
      let x = 0; mc.font = fLegend;
      for (const it of legend) {
        const w = mc.measureText(it.text).width + px(14) + px(16);
        if (x + w > innerW) { x = 0; y += px(18); }
        ops.push({ legend: it, x, y }); x += w;
      }
      y += px(18); ops.push({ rule: true, y }); y += px(14);
    }
    d.blocks.forEach((blk, bi) => {
      blk.sentences.forEach((snt, si) => {
        if (bi || si) { ops.push({ rule: true, y: y - px(6) }); }
        // 1) the marked sentence — wrap by tokens (a token = word + its superscript)
        mc.font = fS;
        const toks = snt.tokens.map((t) => { mc.font = fS; const tw = mc.measureText(t.w).width; mc.font = fSup; const sup = t.n && t.n.length ? t.n.join(",") : ""; const sw = sup ? mc.measureText(sup).width + px(2) : 0; return { w: t.w, g: t.g, v: t.v, tw, sup, sw }; });
        mc.font = fS; const sp = mc.measureText(" ").width;
        let x = 0; let line = [];
        const flush = () => { if (!line.length) return; ops.push({ tokens: line, y, rtl: rtlS }); box(0, y, innerW, lhS); y += lhS; line = []; x = 0; };
        for (const t of toks) { const need = t.tw + t.sw; if (x + need > innerW && line.length) flush(); line.push({ ...t, x }); x += need + sp; }
        flush(); y += px(4);
        // 2) meaning (the other side of the pair), teal
        if (snt.meaning && expl !== lang) {
          mc.font = fM; const rtlM = BI_RTL.test(snt.meaning);
          for (const ln of wrapText(mc, snt.meaning, innerW)) { ops.push({ text: ln, font: fM, color: TEAL, x: rtlM ? innerW : 0, y, align: rtlM ? "right" : "left", dir: rtlM ? "rtl" : "ltr" }); box(0, y, innerW, lhM); y += lhM; }
          y += px(6);
        }
        // 3) simpler version, in a soft box with a bar on the reading-start side
        if (snt.simple) {
          mc.font = fSimple; const lines = wrapText(mc, snt.simple, innerW - px(26));
          const h = px(8) + px(14) + lines.length * lhSimple + px(8);
          ops.push({ softbox: true, y, h, bar: "#E7B27C", fill: "#FBF7F0", rtl: rtlS });
          ops.push({ text: Ls.simple.toUpperCase(), font: fLbl, color: MUTED, x: rtlS ? innerW - px(12) : px(12), y: y + px(8), align: rtlS ? "right" : "left", dir: "ltr" });
          let yy = y + px(8) + px(14);
          for (const ln of lines) { ops.push({ text: ln, font: fSimple, color: INK, x: rtlS ? innerW - px(12) : px(12), y: yy, align: rtlS ? "right" : "left", dir: rtlS ? "rtl" : "ltr" }); box(px(12), yy, innerW - px(24), lhSimple); yy += lhSimple; }
          y += h + px(8);
        }
        // 4) notes: number, bold term, explanation
        if (snt.notes.length) {
          ops.push({ text: L.notes.toUpperCase(), font: fLbl, color: MUTED, x: rtlE ? innerW : 0, y, align: rtlE ? "right" : "left", dir: "ltr" }); y += px(14);
          const numW = px(16);
          for (const nt of snt.notes) {
            const maxW = innerW - numW - px(6), x0 = rtlE ? innerW - numW - px(6) : numW + px(6);
            const nl = wrapNote(mc, nt.term, nt.text, fTerm, fNote, maxW);
            ops.push({ text: String(nt.n), font: fSup, color: CORAL, x: rtlE ? innerW - numW / 2 : numW / 2, y: y + px(1), align: "center", dir: "ltr" });
            if (nt.term) {
              ops.push({ text: nt.term + " —", font: fTerm, color: INK, x: x0, y: y + px(2), align: rtlE ? "right" : "left", dir: "ltr" });
              if (nl.termAlone) { box(numW, y, innerW - numW, lhNote); y += lhNote; }
            }
            nl.lines.forEach((ln, i) => {
              const off = i === 0 ? nl.termW : 0;
              ops.push({ text: ln, font: fNote, color: INK2, x: rtlE ? x0 - off : x0 + off, y: y + px(2), align: rtlE ? "right" : "left", dir: rtlE ? "rtl" : "ltr" });
              box(numW, y, innerW - numW, lhNote); y += lhNote;
            });
            y += px(2);
          }
          y += px(4);
        }
        y += px(10);
      });
      if (blk.summary) {
        mc.font = fM; const lines = wrapText(mc, blk.summary, innerW - px(24));
        const h = px(8) + px(14) + lines.length * lhM + px(8);
        ops.push({ softbox: true, y, h, fill: "#F3EDE4" });
        ops.push({ text: L.summary.toUpperCase(), font: fLbl, color: MUTED, x: rtlE ? innerW - px(12) : px(12), y: y + px(8), align: rtlE ? "right" : "left", dir: "ltr" });
        let yy = y + px(8) + px(14);
        for (const ln of lines) { ops.push({ text: ln, font: fM, color: INK, x: rtlE ? innerW - px(12) : px(12), y: yy, align: rtlE ? "right" : "left", dir: rtlE ? "rtl" : "ltr" }); box(px(12), yy, innerW - px(24), lhM); yy += lhM; }
        y += h + px(16);
      }
    });
    const paperH = PAD * 2 + Math.max(y, lhS);
    const lay = S.frameLayout({ w: paperW, h: paperH, frame: frame.frame, badge: frame.badge, dpr });
    canvas.width = lay.width; canvas.height = lay.height;
    const g = canvas.getContext("2d");
    paintBg(g, lay);
    const outer = lay.bar ? { x: lay.bar.x, y: lay.bar.y, w: lay.bar.w, h: lay.bar.h + lay.img.h } : lay.img;
    paintPaper(g, outer, lay.img.radius, dpr);
    if (lay.bar) paintBar(g, lay.bar, lay.img.radius, lay.img.h, dpr);
    paintBadge(g, lay, dpr);
    g.save(); roundRect(g, outer.x, outer.y, outer.w, outer.h, lay.img.radius); g.clip();
    const ox = lay.img.x + PAD, oy = lay.img.y + PAD;
    const dashUnder = (x, yy, w) => { g.save(); g.strokeStyle = CORAL; g.lineWidth = Math.max(1.5, px(1.5)); g.setLineDash([px(2.5), px(2.5)]); g.beginPath(); g.moveTo(ox + x, oy + yy); g.lineTo(ox + x + w, oy + yy); g.stroke(); g.restore(); };
    for (const op of ops) {
      if (op.rule) { g.strokeStyle = LINE; g.lineWidth = Math.max(1, dpr); g.beginPath(); g.moveTo(ox, oy + op.y + 0.5); g.lineTo(ox + innerW, oy + op.y + 0.5); g.stroke(); continue; }
      if (op.softbox) { g.fillStyle = op.fill; roundRect(g, ox, oy + op.y, innerW, op.h, px(6)); g.fill(); if (op.bar) { g.fillStyle = op.bar; g.fillRect(op.rtl ? ox + innerW - px(3) : ox, oy + op.y, px(3), op.h); } continue; }
      if (op.legend) {
        let x = ox + op.x; const yy = oy + op.y + px(6);
        if (op.legend.dot) { g.fillStyle = op.legend.dot; g.beginPath(); g.arc(x + px(4.5), yy, px(4.5), 0, Math.PI * 2); g.fill(); x += px(14); }
        else if (op.legend.bar) { g.fillStyle = op.legend.bar; g.fillRect(x, yy - px(1.5), px(12), px(3)); x += px(16); }
        else if (op.legend.sup) { g.font = fSup; g.fillStyle = CORAL; g.textBaseline = "middle"; g.textAlign = "left"; g.direction = "ltr"; g.fillText(op.legend.sup, x, yy); x += px(10); }
        g.font = fLegend; g.fillStyle = MUTED; g.textBaseline = "middle"; g.textAlign = "left"; g.direction = "ltr"; g.fillText(op.legend.text, x, yy);
        continue;
      }
      if (op.tokens) {
        // RTL study language: lay the same line out from the right edge.
        for (const t of op.tokens) {
          const tx = op.rtl ? innerW - t.x - t.tw - t.sw : t.x, ty = op.y;
          const wordX = op.rtl ? tx + t.sw : tx; // in RTL the superscript sits to the LEFT of the word
          if (t.g && GENDER[t.g]) { g.fillStyle = GENDER[t.g][1]; roundRect(g, ox + wordX - px(3), oy + ty + px(2), t.tw + px(6), lhS - px(6), px(4)); g.fill(); }
          g.font = fS; g.fillStyle = t.g && GENDER[t.g] ? GENDER[t.g][0] : INK; g.textBaseline = "top"; g.textAlign = "left"; g.direction = "ltr";
          g.fillText(t.w, ox + wordX, oy + ty + px(4));
          if (t.v) dashUnder(wordX, ty + lhS - px(8), t.tw);
          if (t.sup) { g.font = fSup; g.fillStyle = CORAL; g.fillText(t.sup, ox + (op.rtl ? tx : tx + t.tw + px(2)), oy + ty + px(1)); }
        }
        continue;
      }
      g.font = op.font; g.fillStyle = op.color; g.textBaseline = "top"; g.textAlign = op.align; g.direction = op.dir;
      g.fillText(op.text, ox + op.x, oy + op.y);
    }
    g.restore();
    biLineBoxes = boxes.map((b) => ({ x: (PAD + b.x) / lay.img.w, y: (PAD + b.y) / lay.img.h, w: b.w / lay.img.w, h: b.h / lay.img.h }));
    return lay;
  }

  let sideBySidePainted = false; // last drawSideBySide used the painted page (set the note)
  // One entry for every bilingual layout; null when an ingredient is missing.
  async function drawBilingual(canvas, scale) {
    if (biLayout === "S") return drawSideBySide(canvas, scale);
    if (biLayout === "N") return drawNotes(canvas, scale);
    if (biLayout === "G") { await ensureBiFont(); return drawStudyCard(canvas, scale); }
    await ensureBiFont();
    return drawPairsCard(canvas, scale);
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
    const FS_O = Math.round(17 * dpr), FS_T = Math.round((biStyle === "quiet" ? 14.5 : biStyle === "equal" ? 17 : 15.5) * dpr);
    const LH_O = Math.round(FS_O * 1.58), LH_T = Math.round(FS_T * 1.5);
    const GAP_OT = Math.round(5 * dpr), GAP_PAIR = Math.round(18 * dpr), COL_GUT = Math.round(24 * dpr);
    const INK = "#1f1c18", LINE = "#ebe4d9"; // on the always-white paper
    const DE = biStyle === "quiet" ? "#6b918c" : biStyle === "equal" ? "#1f5a54" : "#2c6a64"; // the translation's teal, lighter when quiet
    const stack = fontStack;
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
    paintBg(g, lay);
    const box = lay.bar ? { x: lay.bar.x, y: lay.bar.y, w: lay.bar.w, h: lay.bar.h + lay.img.h } : lay.img;
    paintPaper(g, box, lay.img.radius, dpr);
    if (lay.bar) paintBar(g, lay.bar, lay.img.radius, lay.img.h, dpr);
    paintBadge(g, lay, dpr);
    g.save(); roundRect(g, box.x, box.y, box.w, box.h, lay.img.radius); g.clip();
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
  // ── translated page WITHOUT the source tab ──────────────────────────────
  // A true Translated view is a re-shoot of the page; when the tab is gone
  // (or not yet re-shot) we draw the translations onto the original raster:
  // each text block's box is filled with the colour sampled around it and the
  // translation is set inside it, sized to fit. Flat backgrounds (tweets,
  // articles) read cleanly; text over photos looks patched — the note says so.
  // Memoised per target/font/translations; never stored on the record.
  const paintedCache = { key: "", bmp: null };
  function sampleBg(g, x, y, w, h, W, H) {
    const x0 = Math.max(0, x - 2), y0 = Math.max(0, y - 2), x1 = Math.min(W, x + w + 2), y1 = Math.min(H, y + h + 2);
    if (x1 - x0 < 1 || y1 - y0 < 1) return { css: "#fff", lum: 1 };
    const d = g.getImageData(x0, y0, x1 - x0, y1 - y0), rw = x1 - x0, rh = y1 - y0;
    const rs = [], gs = [], bs = [];
    const take = (px, py) => { const i = (Math.min(rh - 1, Math.max(0, py)) * rw + Math.min(rw - 1, Math.max(0, px))) * 4; rs.push(d.data[i]); gs.push(d.data[i + 1]); bs.push(d.data[i + 2]); };
    for (let i = 0; i < 24; i++) { const t = i / 24; take(Math.round(t * (rw - 1)), 0); take(Math.round(t * (rw - 1)), rh - 1); take(0, Math.round(t * (rh - 1))); take(rw - 1, Math.round(t * (rh - 1))); }
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    const r = med(rs), gg = med(gs), bb = med(bs);
    return { css: "rgb(" + r + "," + gg + "," + bb + ")", lum: (0.2126 * r + 0.7152 * gg + 0.0722 * bb) / 255 };
  }
  // `paras` = the block's paragraphs (one string each); a blank line separates
  // them on the canvas. Largest size whose wrapped lines fit the box.
  function fitText(g, paras, w, h, k, rtl) {
    const stack = fontStack(rtl);
    const maxFs = Math.max(8, Math.min(h, Math.round(30 * k))), minFs = Math.max(6, Math.round(9 * k));
    const step = Math.max(1, Math.round(k));
    const layout = (fs) => {
      g.font = "400 " + fs + "px " + stack; const lh = Math.round(fs * 1.32);
      const lines = []; paras.forEach((p, i) => { if (i) lines.push(""); lines.push(...wrapText(g, p, w)); });
      return { font: g.font, lh, lines, height: lines.reduce((a, l) => a + (l ? lh : Math.round(lh * 0.5)), 0) };
    };
    for (let fs = maxFs; fs >= minFs; fs -= step) {
      const L = layout(fs);
      if (L.height <= h + Math.round(2 * k) && L.lines.every((l) => g.measureText(l).width <= w + 1)) return L;
    }
    return layout(minFs); // overflows at the floor size
  }
  async function paintedBitmap() {
    if (!rec || !isTranslated()) return null;
    const o = await bitmapFor("original"); if (!o) return null;
    const key = rec.target + "|" + (rec.font || "") + "|" + rec.blocks.map((b) => b.id + ":" + (b.tr || "")).join("\u0001");
    if (paintedCache.key === key && paintedCache.bmp) return paintedCache.bmp;
    await ensureBiFont();
    const c = document.createElement("canvas"); c.width = o.width; c.height = o.height;
    const g = c.getContext("2d"); g.drawImage(o, 0, 0);
    const k = o.width / ((rec.rect && rec.rect.w) || rec.w || o.width); // device px per CSS px, same on both axes
    const rtl = S.isRtl(rec.target);
    for (const b of rec.blocks) {
      const tr = String(b.tr || "").replace(/\s+/g, " ").trim();
      if (!tr || !b.rect || !rec.rect) continue;
      const x = Math.round((b.rect.x - rec.rect.x) * k), y = Math.round((b.rect.y - rec.rect.y) * k), w = Math.round(b.rect.w * k), h = Math.round(b.rect.h * k);
      if (w < 4 || h < 4 || x >= c.width || y >= c.height || x + w <= 0 || y + h <= 0) continue;
      const bg = sampleBg(g, x, y, w, h, c.width, c.height);
      const pad = Math.round(2 * k);
      g.fillStyle = bg.css; g.fillRect(x - pad, y - pad, w + 2 * pad, h + 2 * pad);
      // Paragraphs: shots that remember their text nodes (segs) get the
      // translation spread back per node, so a four-paragraph tweet paints as four.
      let paras = [tr];
      if (Array.isArray(b.segs) && b.segs.length > 1 && Array.isArray(b.pairs) && b.pairs.length) {
        const d = S.distributeTranslation(b.segs, b.pairs);
        if (d) { const ps = d.filter(Boolean); if (ps.length > 1) paras = ps; }
      }
      const f = fitText(g, paras, w, h, k, rtl);
      g.font = f.font; g.fillStyle = bg.lum > 0.5 ? "#141414" : "#F4F4F4";
      g.textBaseline = "top"; g.direction = rtl ? "rtl" : "ltr"; g.textAlign = rtl ? "right" : "left";
      let ly = y;
      for (const ln of f.lines) { if (ln) { g.fillText(ln, rtl ? x + w : x, ly); ly += f.lh; } else ly += Math.round(f.lh * 0.5); }
    }
    const bmp = await createImageBitmap(c);
    if (paintedCache.bmp) { try { paintedCache.bmp.close(); } catch (e) {} }
    paintedCache.key = key; paintedCache.bmp = bmp;
    return bmp;
  }
  // The raster for a page view: the real one, else (Translated only) the painted one.
  async function pageBitmap(v) {
    const real = await bitmapFor(v);
    if (real) return { bmp: real, painted: false };
    if (v === "translated") { const p = await paintedBitmap(); if (p) return { bmp: p, painted: true }; }
    return { bmp: null, painted: false };
  }
  const PAINTED_NOTE = "Translation drawn onto the screenshot — open the original tab and pick Translated for a true re-render.";

  // The stored blob that renders a view, or null when it hasn't been rendered
  // yet (fills in on first visit via re-shoot, then it's cached here forever).
  // `rec.views` is the per-view cache; the original/variant fields are the
  // fallback for shots stored before the cache existed.
  function viewBlob(v) {
    if (rec.views && typeof rec.views === "object") {
      // The per-view cache is authoritative: a language change deletes the
      // stale translated/bilingual entries, and the legacy `variant` (still the
      // OLD language) must not stand in for them — that showed a Persian page
      // under an "English" caption in Side by side.
      if (rec.views[v] instanceof Blob) return rec.views[v];
      return v === "original" && rec.original instanceof Blob ? rec.original : null;
    }
    if (v === "original") return rec.original instanceof Blob ? rec.original : null; // records from before the cache
    if (v === rec.layout) return rec.variant instanceof Blob ? rec.variant : null;
    return null;
  }
  async function bitmapFor(v) {
    if (!bitmaps[v]) { const b = viewBlob(v); if (!(b instanceof Blob)) return null; bitmaps[v] = await createImageBitmap(b); }
    return bitmaps[v];
  }
  function clearBitmaps() { for (const k of Object.keys(bitmaps)) { try { bitmaps[k].close(); } catch (e) {} delete bitmaps[k]; } paintedCache.key = ""; }

  const viewLabel = (v) => ({ translated: "Translated", bilingual: "Bilingual", original: "Original" }[v] || v);
  async function render() {
    if (view === "bilingual" && hasPairs()) return renderBilingual();
    let captured = !!viewBlob(view), painted = false;
    // Show the view's own image if we have it; for Translated with no re-shoot
    // possible (tab gone) draw the translation onto the screenshot instead;
    // else a dimmed placeholder while it renders (primary layout, then Original).
    let bmp = await bitmapFor(view);
    if (!bmp && view === "translated" && !tabAlive) { const p = await paintedBitmap(); if (p) { bmp = p; painted = true; captured = true; } }
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
    $("annTextmark").hidden = true; if (annTool === "textmark") setTool("");
    $("annCrop").hidden = false; $("annUncrop").hidden = !curCrop();
    selected = -1; syncAnnot();
    for (const b of $("viewSeg").querySelectorAll("button")) b.classList.toggle("on", b.dataset.view === view);
    const vn = $("viewNote");
    if (painted) { vn.className = "note"; vn.textContent = PAINTED_NOTE; }
    else if (captured && view === "original" && !isTranslated()) { vn.className = "note"; vn.textContent = "Original page — pick Translated or Bilingual to translate (uses your API key)."; }
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
    const canvas = $("stage");
    const vn = $("viewNote"); vn.className = "note"; vn.textContent = "";
    // Side by side with the tab open and no translated page yet: render the
    // real one first (a re-shoot), then come back here. Without the tab, the
    // translation is drawn onto the screenshot instead.
    if (biLayout === "S" && !viewBlob("translated") && isTranslated() && tabAlive && !reshooting) {
      resumeView = "bilingual"; view = "translated"; reshoot(); return;
    }
    sideBySidePainted = false;
    if (biLayout === "G" && !studyData()) { // first look at this side/language: analyse once, cache on the record
      if (!studying) { fetchStudy(); return; }
    }
    let lay = await drawBilingual(canvas, 1);
    if (!lay) { await ensureBiFont(); lay = drawPairsCard(canvas, 1); }
    else if (biLayout === "S" && sideBySidePainted) { vn.className = "note"; vn.textContent = PAINTED_NOTE; }
    else if (biLayout === "G") { const d = studyData(); if (d && d.truncated) { vn.className = "note"; vn.textContent = "Grammar hints cover the first " + d.count + " sentences."; } }
    curLay = lay;
    canvas.style.width = Math.round(lay.width / (rec.dpr || 1)) + "px";
    canvas.style.opacity = "1";
    lastRenderedView = "bilingual";
    $("stageSkel").hidden = true; $("canvasWrap").hidden = false;
    setupAnnot(); $("annotBar").hidden = false;
    const onPage = biLayout === "N" || biLayout === "S";
    $("annTextmark").hidden = biLayout === "S" || !biLineBoxes.length; if ($("annTextmark").hidden && annTool === "textmark") setTool("");
    $("annCrop").hidden = !onPage; $("annUncrop").hidden = !onPage || !curCrop(); if (!onPage && annTool === "crop") setTool("");
    selected = -1; syncAnnot();
    markViewButton("bilingual");
    for (const b of $("biPick").querySelectorAll("[data-bi]")) b.classList.toggle("on", b.dataset.bi === biLayout);
    for (const b of $("biStyleBar").querySelectorAll("button")) b.classList.toggle("on", b.dataset.bistyle === biStyle);
    $("biStyleRow").hidden = biLayout === "S" || biLayout === "G";
    syncStudyRow();
    $("biPick").hidden = false;
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
    const modeName = { visible: "Visible area", full: "Full page", area: "Select area", element: "Pick element", snap: "Video frame · one line", tips: "Tips sheet · " + rec.blocks.length + (rec.blocks.length === 1 ? " line" : " lines") }[rec.mode] || rec.mode;
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
    wrap.hidden = isTips(); // a sheet's lines are already translated; nothing to re-render
    if (isTips()) return;
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
    let want = layout === "bilingual" ? "bilingual" : "translated";
    // Side by side needs the translated PAGE in the new language, not just the
    // pairs: render it on the tab in the same round trip, then come back.
    if (want === "bilingual" && biLayout === "S" && tabAlive) { want = "translated"; resumeView = "bilingual"; }
    reshooting = true; markViewButton(layout === "bilingual" ? "bilingual" : want);
    showBusy("Translating to " + langName(newTarget) + "…");
    const res = await new Promise((r) => chrome.runtime.sendMessage({ type: "SHOT_RETRANSLATE", id: rec.id, target: newTarget, layout: want }, (x) => r(chrome.runtime.lastError ? null : x)));
    reshooting = false;
    if (!res || !res.ok) {
      const err = (res && res.error) || "network";
      const msg = err === "tab-gone" ? "Open the original tab to translate, then try again."
        : err === "no-key" ? "Add an API key in the SubVibe popup to translate."
        : "Couldn't translate (" + err + "). Try again.";
      resumeView = null;
      if (lastRenderedView) view = lastRenderedView; // stay on the view that's showing
      hideBusy(); setNote(msg, "warn"); markViewButton(view);
      return;
    }
    const fresh = await getShot(rec.id);
    if (fresh) { rec = fresh; try { S.validateRecord(rec); } catch (e) {} }
    edits.clear();
    clearBitmaps();
    view = want;
    if (resumeView) { view = resumeView; resumeView = null; }
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
      resumeView = null;
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
    if (resumeView) { view = resumeView; resumeView = null; }
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
    if (view === "bilingual" && hasPairs()) { lay = await drawBilingual(c, scale); if (!lay) { await ensureBiFont(); lay = drawPairsCard(c, scale); } }
    else { const bmp = view === "translated" ? (await pageBitmap("translated")).bmp : await bitmapFor(view); if (!bmp) return null; lay = drawFramed(c, bmp, scale); }
    renderAnnots(c.getContext("2d"), lay.img, c);
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

  function annPt(n, img) { return S.cropToView(n, img, curCrop()); }
  // View px → full-image fraction, unclamped (boxes may straddle the crop edge).
  function viewFrac(px, py, img) {
    const c = S.normCrop(curCrop());
    return { x: c.x + ((px - img.x) / img.w) * c.w, y: c.y + ((py - img.y) / img.h) * c.h };
  }
  // Pixelate the image under a blur rectangle. `src` holds the image pixels:
  // the stage canvas for the on-screen overlay, the export canvas itself when
  // exporting (same size, same coordinates either way).
  function pixelate(ctx, src, a, img, iw) {
    if (!src) return;
    const [x1, y1] = annPt(a.a, img), [x2, y2] = annPt(a.b, img);
    const x = Math.max(Math.min(x1, x2), img.x), y = Math.max(Math.min(y1, y2), img.y);
    const w = Math.min(Math.max(x1, x2), img.x + img.w) - x, h = Math.min(Math.max(y1, y2), img.y + img.h) - y;
    if (w < 1 || h < 1) return;
    const block = Math.max(6, Math.round(iw * 0.014));
    const tw = Math.max(1, Math.round(w / block)), th = Math.max(1, Math.round(h / block));
    const tmp = document.createElement("canvas"); tmp.width = tw; tmp.height = th;
    const tc = tmp.getContext("2d"); tc.imageSmoothingEnabled = true;
    tc.drawImage(src, x, y, w, h, 0, 0, tw, th);
    ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(tmp, 0, 0, tw, th, x, y, w, h); ctx.restore();
  }
  function renderAnnots(ctx, img, src) {
    // A crop zooms the image: sizes stored as full-image fractions scale by the
    // same factor, and shapes outside the crop window are clipped away.
    const c = S.normCrop(curCrop());
    const iw = img.w / c.w, ih = img.h / c.h;
    ctx.save(); ctx.beginPath(); ctx.rect(img.x, img.y, img.w, img.h); ctx.clip();
    const shown = visibleAnnots();
    for (const a of shown) if (a.tool === "blur") pixelate(ctx, src || $("stage"), a, img, iw); // blurs sit under every other mark
    for (const a of shown) {
      if (a.tool === "blur") continue;
      ctx.save();
      const col = a.color || "#F45D48";
      const lw = Math.max(1, (a.size || 0.006) * iw);
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
        const fs = Math.max(11, (a.fontSize || 0.03) * iw);
        ctx.font = "600 " + fs + "px system-ui, -apple-system, sans-serif";
        ctx.textBaseline = "top";
        ctx.direction = /[֐-ࣿ]/.test(a.text) ? "rtl" : "ltr";
        const [x, y] = annPt(a.at, img);
        const w = ctx.measureText(a.text).width;
        const bx = ctx.direction === "rtl" ? x - w : x;
        ctx.globalAlpha = 0.82; ctx.fillStyle = "#fff"; ctx.fillRect(bx - 4, y - 2, w + 8, fs + 6);
        ctx.globalAlpha = 1; ctx.fillStyle = col; ctx.fillText(a.text, x, y);
        const tl = viewFrac(bx - 4, y - 2, img); a.box = { x: tl.x, y: tl.y, w: (w + 8) / iw, h: (fs + 6) / ih }; // for Select
      } else if (a.tool === "num") {
        const r = Math.max(9, (a.size || 0.006) * iw * 2.2);
        const [x, y] = annPt(a.at, img);
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        ctx.lineWidth = Math.max(1.5, r * 0.12); ctx.strokeStyle = col === "#FFFFFF" ? "rgba(17,24,39,.6)" : "rgba(255,255,255,.9)"; ctx.stroke();
        ctx.fillStyle = col === "#FFFFFF" ? "#111827" : "#fff";
        ctx.font = "700 " + Math.round(r * 1.15) + "px " + UI_FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.direction = "ltr";
        ctx.fillText(String(a.n || 1), x, y + r * 0.06);
        a.r = r / iw; delete a.box;
      } else if (a.tool === "textmark") {
        ctx.globalAlpha = 0.3; ctx.fillStyle = col;
        for (const bx of a.boxes || []) { const [x, y] = annPt(bx, img); ctx.fillRect(x - 2, y - 1, bx.w * iw + 4, bx.h * ih + 1); }
      }
      ctx.restore();
    }
    ctx.restore();
  }
  function syncAnnot() {
    const stage = $("stage"), an = $("annot"); if (!an || !curLay) return;
    an.width = stage.width; an.height = stage.height;
    an.style.pointerEvents = "auto";
    an.style.cursor = annTool === "text" || annTool === "num" ? "text" : annTool ? "crosshair" : "default";
    const ctx = an.getContext("2d"); ctx.clearRect(0, 0, an.width, an.height);
    if (selected >= annots.length) selected = -1;
    renderAnnots(ctx, curLay.img, stage);
    if (selected >= 0) drawSelection(ctx, curLay.img, annots[selected]);
    const del = $("annDelete"); if (del) del.hidden = selected < 0;
  }
  // Dashed outline around the selected mark — the affordance for move / delete.
  function drawSelection(ctx, img, a) {
    const b = S.annBounds(a); if (!b) return;
    const [x1, y1] = annPt({ x: b.x, y: b.y }, img), [x2, y2] = annPt({ x: b.x + b.w, y: b.y + b.h }, img);
    const pad = Math.max(6, (rec.dpr || 1) * 6);
    ctx.save(); ctx.strokeStyle = "#C93F2B"; ctx.lineWidth = Math.max(1.5, (rec.dpr || 1) * 1.25); ctx.setLineDash([6, 4]);
    ctx.strokeRect(x1 - pad, y1 - pad, (x2 - x1) + pad * 2, (y2 - y1) + pad * 2); ctx.restore();
  }
  // Hit-test tolerance and the y-scale for it, in full-image fractions.
  function hitOpts() {
    const c = S.normCrop(curCrop()), iw = curLay.img.w / c.w, ih = curLay.img.h / c.h;
    return { tol: (8 * (rec.dpr || 1)) / iw, ky: ih / iw };
  }
  function deleteSelected() {
    if (selected < 0 || selected >= annots.length) return;
    annots.splice(selected, 1); selected = -1; S.renumber(visibleAnnots());
    syncAnnot(); saveAnnots();
  }
  // Global index of the visible mark under `p`, or -1.
  function pick(p) {
    const vis = visibleAnnots(), j = S.hitAnnot(vis, p, hitOpts());
    return j >= 0 ? annots.indexOf(vis[j]) : -1;
  }
  async function saveAnnots() {
    if (!rec) return; rec.annots = annots;
    try { await putShot(rec); } catch (e) {}
  }
  function evToNorm(e) {
    const an = $("annot"), r = an.getBoundingClientRect();
    const px = (e.clientX - r.left) * (an.width / r.width), py = (e.clientY - r.top) * (an.height / r.height);
    return S.viewToCrop(px, py, curLay.img, curCrop());
  }
  // Line boxes the drag from a→b crosses vertically — the text-highlight snaps
  // to whole lines (only meaningful on the bilingual card, where biLineBoxes is set).
  function coveredBoxes(a, b) {
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    return biLineBoxes.filter((bx) => bx.y < maxY + 0.002 && bx.y + bx.h > minY - 0.002);
  }
  let annBuilt = false, drawing = null;
  function setTool(t) {
    annTool = t; if (t) selected = -1;
    for (const x of $("annTools").querySelectorAll("button")) x.classList.toggle("on", (x.dataset.tool || "") === t);
    syncAnnot();
  }
  // Crop drag preview: dim everything outside the dragged window, dashed border.
  function drawCropPreview(ctx, img, a, b) {
    const [x1, y1] = annPt(a, img), [x2, y2] = annPt(b, img);
    const x = Math.min(x1, x2), y = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    ctx.save();
    ctx.beginPath(); ctx.rect(img.x, img.y, img.w, img.h); ctx.rect(x, y, w, h);
    ctx.fillStyle = "rgba(17,24,39,.45)"; ctx.fill("evenodd");
    ctx.strokeStyle = "#fff"; ctx.setLineDash([6, 4]); ctx.lineWidth = Math.max(1.5, (rec.dpr || 1) * 1.5);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }
  async function applyCrop(d) {
    const x = Math.min(d.a.x, d.b.x), y = Math.min(d.a.y, d.b.y), w = Math.abs(d.a.x - d.b.x), h = Math.abs(d.a.y - d.b.y);
    if (w < 0.01 || h < 0.01 || S.isFullCrop({ x, y, w, h })) { syncAnnot(); return; } // too small / whole image → no-op
    rec.crop = { x, y, w, h };
    setTool(""); // back to select so the next drag doesn't re-crop by surprise
    try { await putShot(rec); } catch (e) {}
    await render();
    toast("Cropped — Uncrop restores the full image");
  }
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
      setTool(b.dataset.tool || "");
    });
    $("annSize").addEventListener("input", (e) => { annSizeFrac = (+e.target.value || 5) / 850; });
    $("annUncrop").addEventListener("click", async () => {
      if (!rec || !rec.crop) return;
      rec.crop = null;
      try { await putShot(rec); } catch (e) {}
      await render();
      toast("Full image restored");
    });
    // Undo and Clear act on the marks of THIS view only.
    const undo = () => { const vis = visibleAnnots(); if (!vis.length) return; annots.splice(annots.lastIndexOf(vis[vis.length - 1]), 1); selected = -1; S.renumber(visibleAnnots()); syncAnnot(); saveAnnots(); };
    $("annUndo").addEventListener("click", undo);
    $("annDelete").addEventListener("click", deleteSelected);
    $("annClear").addEventListener("click", () => {
      if (!visibleAnnots().length || !confirm("Remove all marks on this view?")) return;
      const cur = surface(); annots = annots.filter((a) => a && a.on && a.on !== cur); selected = -1; syncAnnot(); saveAnnots();
    });
    // Hotkeys — never while typing (translation edits, the text mark, language search).
    const HOTKEYS = { v: "", p: "pen", h: "highlight", m: "textmark", t: "text", a: "arrow", r: "rect", b: "blur", n: "num", c: "crop" };
    document.addEventListener("keydown", (e) => {
      const t = e.target, typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (typing || !rec || $("annotBar").hidden) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") { if (selected >= 0) { selected = -1; syncAnnot(); } else if (annTool) setTool(""); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && selected >= 0) { e.preventDefault(); deleteSelected(); return; }
      const k = e.key.toLowerCase();
      if (!(k in HOTKEYS)) return;
      const btn = $("annTools").querySelector('[data-tool="' + HOTKEYS[k] + '"]');
      if (btn && !btn.hidden) { e.preventDefault(); setTool(HOTKEYS[k]); }
    });
    const an = $("annot");
    an.addEventListener("pointerdown", (e) => {
      if (!curLay || e.button !== 0) return; e.preventDefault(); an.setPointerCapture(e.pointerId);
      const p = evToNorm(e);
      if (!annTool) { // Select: pick the mark under the pointer, drag moves it
        const i = pick(p);
        selected = i;
        if (i >= 0) drawing = { tool: "move", idx: i, start: p, orig: annots[i] };
        syncAnnot(); return;
      }
      if (annTool === "text") { placeText(p); return; }
      const on = surface();
      if (annTool === "num") {
        annots.push({ tool: "num", on, color: annColor, size: annSizeFrac, at: p, n: visibleAnnots().filter((x) => x.tool === "num").length + 1 });
        syncAnnot(); saveAnnots(); return;
      }
      if (annTool === "crop") { drawing = { tool: "crop", a: p, b: p }; return; }
      if (annTool === "textmark") { drawing = { tool: "textmark", on, color: annColor, a: p, boxes: coveredBoxes(p, p) }; }
      else if (annTool === "pen" || annTool === "highlight") drawing = { tool: annTool, on, color: annColor, size: annSizeFrac, pts: [p] };
      else drawing = { tool: annTool, on, color: annColor, size: annSizeFrac, a: p, b: p };
    });
    an.addEventListener("pointermove", (e) => {
      if (!drawing) {
        if (!annTool && curLay) an.style.cursor = pick(evToNorm(e)) >= 0 ? "move" : "default";
        return;
      }
      const p = evToNorm(e);
      if (drawing.tool === "move") {
        annots[drawing.idx] = S.moveAnnot(drawing.orig, p.x - drawing.start.x, p.y - drawing.start.y);
        syncAnnot(); return;
      }
      if (drawing.tool === "crop") {
        drawing.b = p;
        const ctx = an.getContext("2d"); ctx.clearRect(0, 0, an.width, an.height);
        renderAnnots(ctx, curLay.img, $("stage")); drawCropPreview(ctx, curLay.img, drawing.a, drawing.b);
        return;
      }
      if (drawing.tool === "textmark") drawing.boxes = coveredBoxes(drawing.a, p);
      else if (drawing.pts) drawing.pts.push(p); else drawing.b = p;
      const ctx = an.getContext("2d"); ctx.clearRect(0, 0, an.width, an.height);
      annots.push(drawing); renderAnnots(ctx, curLay.img, $("stage")); annots.pop(); // preview the in-progress shape
    });
    function finish() {
      if (!drawing) return; const d = drawing; drawing = null;
      if (d.tool === "move") { syncAnnot(); saveAnnots(); return; }
      if (d.tool === "crop") { applyCrop(d); return; }
      const ok = d.tool === "textmark" ? (d.boxes && d.boxes.length > 0) : d.pts ? d.pts.length > 1 : (Math.abs(d.a.x - d.b.x) + Math.abs(d.a.y - d.b.y)) > 0.005;
      if (ok) { annots.push(d); saveAnnots(); }
      syncAnnot();
    }
    an.addEventListener("pointerup", finish);
    an.addEventListener("pointercancel", finish);
  }
  function placeText(p) {
    const inp = $("annotText"), an = $("annot"), r = an.getBoundingClientRect(), wrap = $("canvasWrap").getBoundingClientRect();
    const [px, py] = annPt(p, curLay.img);
    inp.style.left = (r.left - wrap.left + px * (r.width / an.width)) + "px";
    inp.style.top = (r.top - wrap.top + py * (r.height / an.height)) + "px";
    inp.style.color = annColor; inp.value = ""; inp.hidden = false; inp.focus();
    const commit = () => {
      inp.hidden = true; inp.onblur = null; inp.onkeydown = null;
      const t = inp.value.trim();
      if (t) { annots.push({ tool: "text", on: surface(), color: annColor, at: p, fontSize: Math.max(0.02, annSizeFrac * 4), text: t }); saveAnnots(); }
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
    const prefs = await chrome.storage.local.get(["shotFrame", "shotExport", "shotBilingual", "shotBiStyle", "shotStudySide", "shotStudyExplain", "targets", "learnLang"]);
    if (["target", "source"].includes(prefs.shotStudySide)) studySide = prefs.shotStudySide;
    if (["other", "same"].includes(prefs.shotStudyExplain)) studyExpl = prefs.shotStudyExplain;
    nativeLang = Array.isArray(prefs.targets) && prefs.targets.length ? String(prefs.targets[0]).split("-")[0] : "";
    learnLang = typeof prefs.learnLang === "string" ? prefs.learnLang.split("-")[0] : "";
    if (prefs.shotFrame && typeof prefs.shotFrame === "object") {
      const f = prefs.shotFrame;
      frame = { frame: ["plain", "card", "window"].includes(f.frame) ? f.frame : "card", badge: f.badge !== false, bg: FRAME_BGS[f.bg] ? f.bg : "sunset" };
    }
    if (["A", "B", "C", "N", "S", "G"].includes(prefs.shotBilingual)) biLayout = prefs.shotBilingual;
    if (["quiet", "balanced", "equal"].includes(prefs.shotBiStyle)) biStyle = prefs.shotBiStyle;
    buildSwatches();
    if (prefs.shotExport && typeof prefs.shotExport === "object") exp = { size: ["native", "2x", "1x", "half"].includes(prefs.shotExport.size) ? prefs.shotExport.size : "native", format: prefs.shotExport.format === "jpeg" ? "jpeg" : "png" };
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
    if (isTips()) { view = "bilingual"; biLayout = "G"; } // a tips sheet is its Study card; the other views have no page behind them
    document.body.classList.toggle("tips", isTips());
    if (view === "bilingual") ensureBiFont();
    for (const bn of $("fontSeg").querySelectorAll("button")) bn.classList.toggle("on", (bn.dataset.font || "") === (rec.font || ""));
    document.title = "SubVibe Shot · " + (rec.title || rec.host);
    renderHeader(); renderBlocks();
    await render();
    renderRecent();
  }

  $("viewSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || !rec || reshooting || isTips()) return;
    // ensureView translates on demand (if the shot has no translation yet) and
    // renders once on the page, then it's cached and every later switch is instant.
    ensureView(b.dataset.view);
  });
  // Bilingual pairing layout — switching just redraws the card (instant) and
  // saves the choice as the default for future shots.
  $("biPick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-bi], [data-bistyle], [data-side], [data-expl]"); if (!b || !rec || reshooting) return;
    if (b.dataset.bi) {
      const v = b.dataset.bi; if (!BI_DESC[v] || v === biLayout) return;
      biLayout = v;
      try { chrome.storage.local.set({ shotBilingual: v }); } catch (er) {}
      const hint = $("biHint"); if (hint) hint.textContent = BI_DESC[v] + " Saved as your default.";
    } else if (b.dataset.side) {
      if (b.dataset.side === effStudySide()) return;
      studySide = b.dataset.side; try { chrome.storage.local.set({ shotStudySide: studySide }); } catch (er) {}
    } else if (b.dataset.expl) {
      if (b.dataset.expl === effStudyExpl()) return;
      studyExpl = b.dataset.expl; try { chrome.storage.local.set({ shotStudyExplain: studyExpl }); } catch (er) {}
    } else {
      const st = b.dataset.bistyle; if (!["quiet", "balanced", "equal"].includes(st) || st === biStyle) return;
      biStyle = st;
      try { chrome.storage.local.set({ shotBiStyle: st }); } catch (er) {}
    }
    if (view === "bilingual") renderBilingual();
  });
  function buildSwatches() {
    const wrap = $("bgSwatches"); if (!wrap) return; wrap.textContent = "";
    for (const key of Object.keys(FRAME_BGS)) {
      const [a, b, c] = FRAME_BGS[key];
      const s = document.createElement("button"); s.type = "button"; s.className = "bgswatch" + (key === frame.bg ? " on" : "");
      s.dataset.bg = key; s.title = FRAME_BG_NAMES[key]; s.setAttribute("aria-label", FRAME_BG_NAMES[key] + " background");
      s.style.background = "linear-gradient(135deg, " + a + ", " + b + " 55%, " + c + ")";
      s.addEventListener("click", () => {
        if (!rec || reshooting || frame.bg === key) return;
        frame.bg = key;
        for (const x of wrap.querySelectorAll(".bgswatch")) x.classList.toggle("on", x.dataset.bg === key);
        chrome.storage.local.set({ shotFrame: frame }); render();
      });
      wrap.appendChild(s);
    }
    syncFrameUI();
  }
  function syncFrameUI() {
    for (const b of $("frameSeg").querySelectorAll("button")) b.classList.toggle("on", b.dataset.frame === frame.frame);
    const row = $("bgRow"); if (row) row.hidden = frame.frame === "plain";
  }
  $("frameSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || !rec || reshooting) return;
    frame.frame = ["plain", "card", "window"].includes(b.dataset.frame) ? b.dataset.frame : "card";
    syncFrameUI();
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
