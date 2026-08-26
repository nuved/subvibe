// clip.js — the Clip editor (clip.html?id=…). Loads a recorded clip from the
// IndexedDB "clips" store, plays it, and lets the user trim (in/out) and crop,
// then export a re-cut WebM. The recording is WYSIWYG (real subtitles + the
// audio the viewer heard), so nothing is re-rendered here — just trimmed/cropped.
// Spec: docs/superpowers/specs/2026-08-26-clip-design.md
(function () {
  const $ = (id) => document.getElementById(id);

  // ── IndexedDB (same DB/version as background.js) ──
  let dbP = null;
  function db() {
    if (!dbP) dbP = new Promise((resolve, reject) => {
      const req = indexedDB.open("copilot-subs", 5);
      req.onupgradeneeded = () => { const d = req.result; for (const s of ["tracks", "audio", "vocab", "shots", "clips"]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    return dbP;
  }
  const store = (mode) => db().then((d) => d.transaction("clips", mode).objectStore("clips"));
  const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const getClip = (id) => store("readonly").then((s) => wrap(s.get(id)));
  const delClip = (id) => store("readwrite").then((s) => wrap(s.delete(id)));
  const listClips = () => store("readonly").then((s) => wrap(s.getAll())).then((all) => (all || []).filter((r) => r && typeof r.ts === "number").sort((a, b) => b.ts - a.ts));

  // ── state ──
  let rec = null, url = null, durMs = 0, inMs = 0, outMs = 0;
  let crop = null; // {x,y,w,h} normalized 0..1 of the video frame, or null = full
  let exporting = false;

  const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  let toastT = null;
  function toast(t) { const el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 2600); }

  const v = () => $("v");
  function curMs() { return (v().currentTime || 0) * 1000; }
  function seek(ms) { v().currentTime = Math.max(0, Math.min(durMs, ms)) / 1000; }

  function paintTrim() {
    const sc = $("scrub"), w = sc.clientWidth;
    const a = durMs ? inMs / durMs : 0, b = durMs ? outMs / durMs : 1;
    $("scrubSel").style.left = a * w + "px";
    $("scrubSel").style.width = (b - a) * w + "px";
    $("hIn").style.left = a * w + "px";
    $("hOut").style.left = b * w + "px";
    $("inT").textContent = fmt(inMs); $("outT").textContent = fmt(outMs);
    $("trimNote").textContent = "Clip length " + ((outMs - inMs) / 1000).toFixed(1) + "s of " + (durMs / 1000).toFixed(1) + "s.";
  }
  function paintPlayhead() {
    const sc = $("scrub"), w = sc.clientWidth;
    const p = durMs ? Math.min(1, curMs() / durMs) : 0;
    $("scrubPlay").style.left = p * w + "px";
    $("tcode").textContent = fmt(curMs()) + " / " + fmt(durMs);
    $("playBtn").textContent = v().paused ? "▶" : "⏸";
  }

  // ── crop marquee on the video ──
  function paintCrop() {
    const box = $("crop"), wrapEl = $("stagewrap"), vid = v();
    if (!crop) { box.hidden = true; $("cropInfo").textContent = "Full frame."; return; }
    const rw = vid.clientWidth, rh = vid.clientHeight;
    box.hidden = false;
    box.style.left = crop.x * rw + "px"; box.style.top = crop.y * rh + "px";
    box.style.width = crop.w * rw + "px"; box.style.height = crop.h * rh + "px";
    const vw = vid.videoWidth || 0, vh = vid.videoHeight || 0;
    $("cropInfo").textContent = vw ? Math.round(crop.w * vw) + "×" + Math.round(crop.h * vh) : "";
  }
  function setupCrop() {
    const wrapEl = $("stagewrap"); let start = null;
    wrapEl.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".transport")) return;
      const r = v().getBoundingClientRect();
      start = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
      wrapEl.setPointerCapture(e.pointerId);
    });
    wrapEl.addEventListener("pointermove", (e) => {
      if (!start) return;
      const r = v().getBoundingClientRect();
      const x2 = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y2 = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      crop = { x: Math.min(start.x, x2), y: Math.min(start.y, y2), w: Math.abs(x2 - start.x), h: Math.abs(y2 - start.y) };
      paintCrop();
    });
    const end = () => { if (start && crop && (crop.w < 0.02 || crop.h < 0.02)) crop = null; start = null; paintCrop(); };
    wrapEl.addEventListener("pointerup", end);
    wrapEl.addEventListener("pointercancel", end);
  }

  // ── trim handle drag + scrub seek ──
  function setupScrub() {
    const sc = $("scrub");
    const posMs = (e) => { const r = sc.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * durMs; };
    let drag = null;
    $("hIn").addEventListener("pointerdown", (e) => { drag = "in"; $("hIn").setPointerCapture(e.pointerId); e.stopPropagation(); });
    $("hOut").addEventListener("pointerdown", (e) => { drag = "out"; $("hOut").setPointerCapture(e.pointerId); e.stopPropagation(); });
    window.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const m = posMs(e);
      if (drag === "in") inMs = Math.min(m, outMs - 200);
      else outMs = Math.max(m, inMs + 200);
      inMs = Math.max(0, inMs); outMs = Math.min(durMs, outMs);
      paintTrim();
    });
    window.addEventListener("pointerup", () => { drag = null; });
    sc.addEventListener("click", (e) => { if (e.target.classList.contains("handle")) return; seek(posMs(e)); });
  }

  // ── export: replay in→out through a cropped canvas, record to WebM ──
  function pickMime() { return ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || ""; }
  function downloadBlob(blob, name) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  async function doExport() {
    if (exporting || !rec) return;
    exporting = true; $("exportBtn").disabled = true; $("exportLbl").textContent = "Exporting…"; $("prog").hidden = false;
    const src = document.createElement("video"); src.src = url; src.muted = false; src.playsInline = true; src.preload = "auto";
    try {
      await new Promise((res, rej) => { src.onloadeddata = res; src.onerror = () => rej(new Error("load")); });
      const vw = src.videoWidth, vh = src.videoHeight;
      const cr = crop || { x: 0, y: 0, w: 1, h: 1 };
      const sx = Math.round(cr.x * vw), sy = Math.round(cr.y * vh);
      const sw = Math.max(2, Math.round(cr.w * vw)) & ~1, sh = Math.max(2, Math.round(cr.h * vh)) & ~1; // even dims
      const canvas = document.createElement("canvas"); canvas.width = sw; canvas.height = sh;
      const ctx = canvas.getContext("2d");
      const cstream = canvas.captureStream(30);
      let audio = [];
      try { const ss = src.captureStream ? src.captureStream() : src.mozCaptureStream(); audio = ss.getAudioTracks(); } catch (e) {}
      const mime = pickMime();
      const mixed = new MediaStream([...cstream.getVideoTracks(), ...audio]);
      const chunks = []; const mr = new MediaRecorder(mixed, mime ? { mimeType: mime } : undefined);
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise((res) => { mr.onstop = res; });
      const inS = inMs / 1000, outS = outMs / 1000;
      src.currentTime = inS;
      await new Promise((res) => { src.onseeked = res; });
      mr.start();
      await src.play().catch(() => {});
      await new Promise((res) => {
        const step = () => {
          if (src.currentTime >= outS || src.ended) { res(); return; }
          try { ctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh); } catch (e) {}
          $("progBar").style.width = Math.min(100, ((src.currentTime - inS) / Math.max(0.1, outS - inS)) * 100) + "%";
          requestAnimationFrame(step);
        };
        step();
      });
      src.pause(); try { cstream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      mr.stop(); await stopped;
      const blob = new Blob(chunks, { type: (mime || "video/webm").split(";")[0] });
      if (!blob.size) toast("Export was empty — keep this tab in front while exporting.");
      else { downloadBlob(blob, "subvibe-clip-" + (rec.host || "video") + "-" + Date.now() + ".webm"); toast("Exported · " + (blob.size / 1048576).toFixed(1) + " MB"); }
    } catch (e) { toast("Export failed — " + ((e && e.message) || e)); }
    finally { exporting = false; $("exportBtn").disabled = false; $("exportLbl").textContent = "Export & download"; $("prog").hidden = true; $("progBar").style.width = "0"; }
  }

  // ── recent strip ──
  async function renderRecent() {
    const wrapEl = $("recent"); wrapEl.textContent = "";
    const all = (await listClips()).slice(0, 8);
    for (const c of all) {
      if (!(c.blob instanceof Blob)) continue;
      const img = document.createElement("img"); img.className = rec && c.id === rec.id ? "on" : "";
      img.title = c.title || c.host || ""; img.alt = "";
      // draw one frame as a thumbnail
      try {
        const tv = document.createElement("video"); tv.src = URL.createObjectURL(c.blob); tv.muted = true;
        tv.addEventListener("loadeddata", () => { tv.currentTime = Math.min(0.5, (c.durationMs || 1000) / 2000); });
        tv.addEventListener("seeked", () => {
          const cv = document.createElement("canvas"); cv.width = 104; cv.height = 60;
          try { cv.getContext("2d").drawImage(tv, 0, 0, 104, 60); img.src = cv.toDataURL("image/jpeg", 0.6); } catch (e) {}
          URL.revokeObjectURL(tv.src);
        });
      } catch (e) {}
      img.addEventListener("click", () => { location.search = "?id=" + encodeURIComponent(c.id); });
      wrapEl.appendChild(img);
    }
  }

  // ── boot ──
  async function load() {
    const id = new URLSearchParams(location.search).get("id") || "";
    let r = null; try { r = id ? await getClip(id) : null; } catch (e) {}
    if (!r) { const newest = (await listClips())[0]; if (newest && !id) { location.search = "?id=" + encodeURIComponent(newest.id); return; } }
    if (!r || !(r.blob instanceof Blob)) { $("empty").hidden = false; renderRecent(); return; }
    rec = r; url = URL.createObjectURL(r.blob); durMs = r.durationMs || 0; inMs = 0; outMs = durMs;
    $("editor").hidden = false;
    $("ctitle").textContent = r.title || r.url || "";
    document.title = "SubVibe Clip · " + (r.title || r.host || "");
    const vid = v(); vid.src = url;
    vid.addEventListener("loadedmetadata", () => {
      if ((!durMs || !isFinite(durMs)) && isFinite(vid.duration)) durMs = vid.duration * 1000;
      if (!outMs) outMs = durMs;
      paintTrim(); paintPlayhead(); paintCrop();
    });
    vid.addEventListener("timeupdate", () => { if (curMs() >= outMs - 30 && !vid.paused) { vid.pause(); } paintPlayhead(); });
    vid.addEventListener("play", paintPlayhead); vid.addEventListener("pause", paintPlayhead);
    const mb = Math.round((r.blob.size || 0) / 1048576 * 10) / 10;
    $("meta").textContent = (r.w ? r.w + "×" + r.h + " · " : "") + fmt(durMs) + " · " + mb + " MB · " + new Date(r.ts).toLocaleString();
    setupScrub(); setupCrop();
    paintTrim();
    renderRecent();
  }

  $("playBtn").addEventListener("click", () => { const vid = v(); if (vid.paused) { if (curMs() >= outMs - 30) seek(inMs); vid.play(); } else vid.pause(); });
  $("setIn").addEventListener("click", () => { inMs = Math.min(curMs(), outMs - 200); paintTrim(); });
  $("setOut").addEventListener("click", () => { outMs = Math.max(curMs(), inMs + 200); paintTrim(); });
  $("cropReset").addEventListener("click", () => { crop = null; paintCrop(); });
  $("exportBtn").addEventListener("click", doExport);
  $("dlOrig").addEventListener("click", () => { if (rec) downloadBlob(rec.blob, "subvibe-clip-full-" + Date.now() + ".webm"); });
  $("delBtn").addEventListener("click", async () => {
    if (!rec || !confirm("Delete this clip? This can't be undone.")) return;
    const gone = rec.id; await delClip(gone);
    const next = (await listClips()).find((c) => c.id !== gone);
    if (next) location.search = "?id=" + encodeURIComponent(next.id);
    else { location.search = ""; }
  });
  window.addEventListener("resize", () => { if (rec) { paintTrim(); paintPlayhead(); paintCrop(); } });

  load().catch((e) => { console.error("[SubVibe clip] load failed", e); $("empty").hidden = false; });
})();
