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
        const req = indexedDB.open("copilot-subs", 4);
        req.onupgradeneeded = () => {
          const d = req.result;
          for (const s of ["tracks", "audio", "vocab", "shots"]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
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
  const edits = new Map();     // block id → edited translation
  let reshooting = false;

  const langName = (c) => (window.svLangMeta ? window.svLangMeta((c || "").split("-")[0])[1] : (c || "").toUpperCase());
  const code = (c) => (c || "").split("-")[0].toUpperCase();
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  let toastT = null;
  function toast(text) {
    const t = $("toast"); t.textContent = text; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 1800);
  }

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
  async function bitmapFor(which) {
    if (!bitmaps[which]) bitmaps[which] = await createImageBitmap(which === "original" ? rec.original : rec.variant);
    return bitmaps[which];
  }
  // Which stored blob renders the current view, or null when it needs a re-shoot.
  const blobKeyFor = (v) => (v === "original" ? "original" : v === rec.layout ? "variant" : null);

  async function render() {
    const key = blobKeyFor(view);
    const bmp = await bitmapFor(key || "original");
    const canvas = $("stage");
    const lay = drawFramed(canvas, bmp, 1);
    canvas.style.width = Math.round(lay.width / (rec.dpr || 1)) + "px";
    canvas.style.opacity = key ? "1" : ".35";
    $("stageSkel").hidden = true; canvas.hidden = false;
    for (const b of $("viewSeg").querySelectorAll("button")) b.classList.toggle("on", b.dataset.view === view);
    const vn = $("viewNote");
    if (key) { vn.className = "note"; vn.textContent = "Captured with this shot."; }
    else { vn.className = "note warn"; vn.textContent = "Not captured yet — Apply & re-shoot renders the " + view + " view from the original tab."; }
    updateReshoot();
    $("fileNote").textContent = S.filename({ host: rec.host, ts: rec.ts, view, size: exp.size, format: exp.format });
  }

  // ── panel ─────────────────────────────────────────────────────────────────
  function renderHeader() {
    const link = $("pageLink"); link.textContent = rec.title || rec.url; link.href = rec.url; link.title = rec.url;
    const chip = $("langChip");
    chip.hidden = false;
    chip.textContent = (rec.source && rec.source !== "xx" ? code(rec.source) + " → " : "→ ") + code(rec.target);
    chip.title = (rec.source && rec.source !== "xx" ? langName(rec.source) + " → " : "") + langName(rec.target);
    const d = new Date(rec.ts);
    const modeName = { visible: "Visible area", full: "Full page", area: "Select area", element: "Pick element" }[rec.mode] || rec.mode;
    $("metaLine").textContent = d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " · " + modeName + " · " + Math.round(rec.w) + " × " + Math.round(rec.h);
    const notes = [];
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
  function updateReshoot() {
    const btn = $("reshootBtn"), note = $("reshootNote");
    if (reshooting) { btn.disabled = true; note.className = "note"; note.textContent = "Re-shooting on the original tab…"; return; }
    const needsView = !blobKeyFor(view);
    const n = edits.size;
    btn.disabled = !(n || needsView);
    note.className = "note";
    if (n && needsView) note.textContent = n + (n === 1 ? " translation changed" : " translations changed") + " · renders the " + view + " view.";
    else if (n) note.textContent = n + (n === 1 ? " translation changed." : " translations changed.") + " Re-shoot renders it on the original tab.";
    else if (needsView) note.textContent = "Renders the " + view + " view on the original tab (~1 s).";
    else note.textContent = "Edit any translation, then re-shoot to render it on the original tab.";
  }
  async function reshoot() {
    if (reshooting || !rec) return;
    const layout = view === "original" ? (rec.layout === "original" ? "translated" : rec.layout) : view;
    reshooting = true; updateReshoot();
    const res = await new Promise((r) => chrome.runtime.sendMessage({ type: "SHOT_RESHOOT", id: rec.id, layout, blocks: [...edits].map(([id, tr]) => ({ id, tr })) }, (x) => r(chrome.runtime.lastError ? null : x)));
    reshooting = false;
    const note = $("reshootNote");
    if (!res || !res.ok) {
      updateReshoot();
      const err = (res && res.error) || "network";
      note.className = "note err";
      note.textContent = err === "tab-gone" ? "Original tab was closed — take a new shot to re-render."
        : err === "busy" ? "The original tab is still busy — try again in a moment."
        : "Re-shoot failed (" + err + "). Try again.";
      if (err === "tab-gone") $("reshootBtn").disabled = true;
      return;
    }
    const fresh = await getShot(rec.id);
    if (fresh) { rec = fresh; try { S.validateRecord(rec); } catch (e) { /* keep showing what we have */ } }
    edits.clear(); if (bitmaps.variant) { bitmaps.variant.close(); delete bitmaps.variant; }
    if (view !== "original") view = rec.layout;
    renderHeader(); renderBlocks(); await render();
    toast(res.missing ? "Re-shot · " + res.missing + " block" + (res.missing === 1 ? "" : "s") + " no longer on the page" : "Re-shot");
  }

  // ── export ────────────────────────────────────────────────────────────────
  async function exportBlob(format) {
    const key = blobKeyFor(view) || "original";
    const bmp = await bitmapFor(key);
    const c = document.createElement("canvas");
    drawFramed(c, bmp, S.exportScale(exp.size, rec.dpr || 1));
    const type = format === "jpeg" ? "image/jpeg" : "image/png";
    return new Promise((res) => c.toBlob((b) => res(b), type, 0.9));
  }
  const fileName = (format) => S.filename({ host: rec.host, ts: rec.ts, view, size: exp.size, format });
  async function download() {
    const blob = await exportBlob(exp.format);
    if (!blob) return toast("Export failed");
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fileName(exp.format);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("Downloaded");
  }
  async function copy() {
    try {
      const blob = await exportBlob("png");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("Copied");
    } catch (e) { toast("Copy failed — " + ((e && e.message) || "clipboard blocked")); }
  }
  async function share() {
    try {
      const blob = await exportBlob(exp.format);
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

  // ── recent strip ──────────────────────────────────────────────────────────
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
    const prefs = await chrome.storage.local.get(["shotFrame", "shotExport"]);
    if (prefs.shotFrame && typeof prefs.shotFrame === "object") frame = { frame: prefs.shotFrame.frame === "plain" ? "plain" : "card", badge: prefs.shotFrame.badge !== false };
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
    rec = r;
    view = rec.layout === "original" ? "original" : rec.layout;
    document.title = "SubVibe Shot · " + (rec.title || rec.host);
    renderHeader(); renderBlocks();
    await render();
    renderRecent();
  }

  $("viewSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || !rec) return;
    view = b.dataset.view;
    if (view !== "original") chrome.storage.local.set({ shotLayout: view });
    render();
  });
  $("frameSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || !rec) return;
    frame.frame = b.dataset.frame === "plain" ? "plain" : "card";
    for (const x of $("frameSeg").querySelectorAll("button")) x.classList.toggle("on", x === b);
    chrome.storage.local.set({ shotFrame: frame }); render();
  });
  $("badgeSw").addEventListener("change", () => { frame.badge = $("badgeSw").checked; chrome.storage.local.set({ shotFrame: frame }); render(); });
  $("sizeSel").addEventListener("change", () => { exp.size = $("sizeSel").value; chrome.storage.local.set({ shotExport: exp }); render(); });
  $("fmtSel").addEventListener("change", () => { exp.format = $("fmtSel").value; chrome.storage.local.set({ shotExport: exp }); render(); });
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
