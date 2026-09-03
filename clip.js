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
  let cropDraw = false;
  function setCropDraw(on) {
    cropDraw = on; $("cropdraw").hidden = !on;
    $("cropDrawBtn").classList.toggle("on", on);
    $("cropDrawBtn").textContent = on ? "Done" : "Draw box";
  }
  function setupCrop() {
    const layer = $("cropdraw"); let start = null;
    const norm = (e) => { const r = layer.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) }; };
    layer.addEventListener("pointerdown", (e) => { start = norm(e); layer.setPointerCapture(e.pointerId); });
    layer.addEventListener("pointermove", (e) => {
      if (!start) return; const p = norm(e);
      crop = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      paintCrop();
    });
    const end = () => { if (start && crop && (crop.w < 0.02 || crop.h < 0.02)) crop = null; start = null; setCropDraw(false); paintCrop(); };
    layer.addEventListener("pointerup", end);
    layer.addEventListener("pointercancel", end);
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
  // MP4 (H.264 + AAC) when the browser can record it — Instagram takes MP4,
  // not WebM; the original layout stays WebM unless MP4 is the only option.
  const MP4S = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4"];
  const WEBMS = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  function pickMime(preferMp4) { return (preferMp4 ? [...MP4S, ...WEBMS] : [...WEBMS, ...MP4S]).find((m) => MediaRecorder.isTypeSupported(m)) || ""; }
  const extOf = (mime) => (/mp4/.test(mime || "") ? "mp4" : "webm");
  // ── Instagram layouts: the video on a card, the lines in a band BELOW it ──
  // (never over the picture, so a creator's own burned-in captions stay clear).
  let layoutMode = "orig"; // orig | ig45 | reel
  const LAYOUTS = { ig45: { W: 1080, H: 1350, top: 60, videoMax: 0.6 }, reel: { W: 1080, H: 1920, top: 200, videoMax: 0.52 } };
  const BG = ["#D8F1D3", "#CFECE1", "#E1EDC9"]; // Meadow — the Shot editor's gradient family
  function layoutGeom(sw, sh) {
    const L = LAYOUTS[layoutMode]; if (!L) return null;
    const EDGE = 48, maxW = L.W - EDGE * 2, maxH = Math.round(L.H * L.videoMax);
    const k = Math.min(maxW / sw, maxH / sh);
    const bw = Math.round(sw * k) & ~1, bh = Math.round(sh * k) & ~1;
    return { W: L.W, H: L.H, box: { x: Math.round((L.W - bw) / 2), y: L.top, w: bw, h: bh }, bandY: L.top + bh + 44, bandH: L.H - (L.top + bh + 44) - 90, EDGE };
  }
  function wrapLines(ctx, text, maxW, max) {
    const words = String(text || "").split(/\s+/).filter(Boolean), out = []; let cur = "";
    for (const w of words) { const t = cur ? cur + " " + w : w; if (!cur || ctx.measureText(t).width <= maxW) cur = t; else { out.push(cur); cur = w; if (out.length === max - 1) break; } }
    if (cur && out.length < max) out.push(cur);
    return out;
  }
  function composeFrame(ctx, src, geom, sx, sy, sw, sh, clipMs) {
    const { W, H, box, EDGE } = geom;
    const grad = ctx.createLinearGradient(0, 0, W, H); grad.addColorStop(0, BG[0]); grad.addColorStop(0.55, BG[1]); grad.addColorStop(1, BG[2]);
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.shadowColor = "rgba(40,20,10,.3)"; ctx.shadowBlur = 30; ctx.shadowOffsetY = 10; ctx.fillStyle = "#000";
    ctx.beginPath(); ctx.roundRect(box.x, box.y, box.w, box.h, 24); ctx.fill(); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.roundRect(box.x, box.y, box.w, box.h, 24); ctx.clip();
    try { ctx.drawImage(src, sx, sy, sw, sh, box.x, box.y, box.w, box.h); } catch (e) {}
    ctx.restore();
    const c = subsMode !== "off" ? cueAt(clipMs) : null;
    if (c) {
      const lines = [];
      if (subsMode === "both" && c.o) lines.push({ t: c.o, font: "600 44px system-ui, -apple-system, 'Segoe UI', sans-serif", lh: 56, color: "#241F1A" });
      if (c.text) lines.push({ t: c.text, font: (subsMode === "both" ? "500 40px" : "600 44px") + " system-ui, -apple-system, 'Segoe UI', sans-serif", lh: subsMode === "both" ? 52 : 56, color: subsMode === "both" ? "#2c6a64" : "#241F1A" });
      let y = geom.bandY + 8;
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      for (const ln of lines) {
        ctx.font = ln.font; ctx.fillStyle = ln.color; ctx.direction = RTL_RE.test(ln.t) ? "rtl" : "ltr";
        for (const row of wrapLines(ctx, ln.t, W - EDGE * 2, 2)) { ctx.fillText(row, W / 2, y); y += ln.lh; }
        y += 10;
      }
    }
    ctx.font = "700 20px ui-monospace, Menlo, Consolas, monospace"; ctx.textAlign = "right"; ctx.textBaseline = "alphabetic"; ctx.direction = "ltr"; ctx.fillStyle = "#A93521";
    ctx.fillText("SUBVIBE · " + ((rec.target || "").split("-")[0] || "").toUpperCase(), W - EDGE, H - 36);
  }
  function downloadBlob(blob, name) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  // ── dub: lay the translated voice onto the clip (reuses SubVibe's TTS) ──
  const send = (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => res(chrome.runtime.lastError ? null : r)));
  function bufFromB64(b64) { const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a.buffer; }
  function clipBase(u0) {
    let u; try { u = new URL(u0); } catch (e) { return null; }
    const h = u.hostname.replace(/^www\./, "");
    let site = null;
    for (const [d, s] of [["youtube.com", "youtube"], ["youtu.be", "youtube"], ["dw.com", "dw"], ["zdf.de", "zdf"], ["udemy.com", "udemy"], ["primevideo.com", "prime"], ["netflix.com", "netflix"]]) if (h.endsWith(d)) { site = s; break; }
    if (!site && /amazon\./.test(h)) site = "prime";
    if (!site) return null;
    const clipId = site === "youtube" ? "/watch?v=" + (u.searchParams.get("v") || "") : u.pathname;
    return site + ":" + clipId;
  }
  // Translated lines for this clip, mapped to clip-local time (shared by
  // subtitles and dubbing). `text` = translation, `o` = original, `dt` =
  // condensed dub rendition, `absStart` = source-video ms (for TTS cache keys).
  let cues = null;
  async function ensureCues() {
    if (cues) return cues;
    const base = clipBase(rec.url); if (!base) return (cues = []);
    const r = await send({ type: "CACHE_GET", key: base + ":auto:" + (rec.target || "") });
    const track = r && r.track;
    const from = (rec.startSec || 0) * 1000, to = from + durMs;
    cues = (((track && track.cues) || [])
      .filter((c) => c && c.startMs < to && (c.endMs || c.startMs + 2500) > from && (c.text || c.o))
      .map((c) => ({ tMs: c.startMs - from, endMs: (c.endMs || c.startMs + 2500) - from, absStart: c.startMs, text: c.text || "", o: c.o || "", dt: c.dt || "" }))
      .sort((a, b) => a.tMs - b.tMs));
    return cues;
  }
  // Chunks — passages of a few sentences, cut at natural breaks — over this
  // clip's lines. The unit tips are given for, and the unit "Trim to chunks"
  // snaps to, so a passage is never cut in the middle.
  function chunksOfClip() {
    const list = cues || [];
    const C = window.SV_CUES;
    // Consecutive cues that share one translation are the windows of one
    // sentence (the group translation is stamped on each of them) — one unit.
    const units = [];
    const strip = (t) => (C && C.stripSpeakerMarks ? C.stripSpeakerMarks(t) : String(t || ""));
    for (const c of list) {
      const last = units[units.length - 1];
      if (last && c.text && last.cue.text === c.text) { last.endMs = Math.max(last.endMs, c.endMs); last.original = (last.original + " " + (c.o || "")).replace(/\s+/g, " ").trim(); continue; }
      units.push({ startMs: c.tMs, endMs: c.endMs, original: c.o || c.text, cue: c });
    }
    // speaker marks are read as a boundary (chunkCues) and then dropped from the text
    const ranges = C && C.chunkCues ? C.chunkCues(units, { maxSents: 4, maxChars: 300 }) : units.map((u, i) => ({ from: i, to: i, startMs: u.startMs, endMs: u.endMs }));
    return ranges.map((r, k) => { const us = units.slice(r.from, r.to + 1); return { k, startMs: r.startMs, endMs: r.endMs, cues: us.map((u) => u.cue),
      text: strip(us.map((u) => u.original).join(" ")), sentences: us.map((u) => ({ s: strip(u.original), tr: strip(u.cue.text) })) }; });
  }
  // Trim to n whole chunks from the in-point.
  function trimToChunks(n) {
    const list = chunksOfClip(); if (!list.length) return false;
    let k0 = list.findIndex((ch) => ch.endMs > inMs); if (k0 < 0) k0 = list.length - 1;
    const k1 = Math.min(list.length - 1, k0 + n - 1);
    inMs = Math.max(0, list[k0].startMs - 150); outMs = Math.min(durMs, list[k1].endMs + 300);
    if (outMs - inMs < 200) outMs = Math.min(durMs, inMs + 200);
    paintTrim();
    const sents = list.slice(k0, k1 + 1).reduce((s, ch) => s + ch.sentences.length, 0);
    $("chunkNote").textContent = "Chunk " + (k0 + 1) + (k1 > k0 ? "–" + (k1 + 1) : "") + " of " + list.length + " · " + sents + (sents === 1 ? " sentence" : " sentences");
    for (const b of $("chunkSel").querySelectorAll("button")) b.className = +b.dataset.n === n ? "on" : "";
    return true;
  }
  function cueAt(ms) {
    if (!cues || !cues.length) return null;
    let ans = null;
    for (const c of cues) { if (c.tMs <= ms) ans = c; else break; }
    return ans && ms <= ans.endMs + 300 ? ans : null;
  }
  let subsMode = "target"; // target | both | off
  function renderSub() {
    if (!$("subov")) return;
    const c = subsMode !== "off" ? cueAt(curMs()) : null;
    const t = c ? c.text : "", o = (c && subsMode === "both") ? c.o : "";
    $("subT").textContent = t; $("subT").dir = "auto";
    $("subO").textContent = o; $("subO").dir = "auto";
    $("subov").hidden = !(t || o);
  }
  const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
  function drawSubOnCanvas(ctx, w, h, clipMs) {
    if (subsMode === "off") return;
    const c = cueAt(clipMs); if (!c) return;
    const lines = [];
    if (c.text) lines.push({ t: c.text, big: true });
    if (subsMode === "both" && c.o) lines.push({ t: c.o, big: false });
    if (!lines.length) return;
    ctx.save(); ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    let y = h - Math.round(h * 0.07);
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i], fs = Math.max(13, Math.round(h * (ln.big ? 0.052 : 0.044))), pad = Math.round(fs * 0.32);
      ctx.font = (ln.big ? "600 " : "500 ") + fs + "px system-ui, -apple-system, 'Segoe UI', sans-serif";
      ctx.direction = RTL_RE.test(ln.t) ? "rtl" : "ltr";
      const tw = Math.min(w - 20, ctx.measureText(ln.t).width);
      ctx.fillStyle = "rgba(0,0,0,.4)"; ctx.fillRect(w / 2 - tw / 2 - pad, y - fs, tw + pad * 2, fs + pad);
      ctx.fillStyle = ln.big ? "#fff" : "#ffe0cf"; ctx.shadowColor = "rgba(0,0,0,.85)"; ctx.shadowBlur = 4;
      ctx.fillText(ln.t, w / 2, y - pad * 0.4); ctx.shadowBlur = 0;
      y -= fs + pad + Math.round(fs * 0.35);
    }
    ctx.restore();
  }

  let dubSegs = null, audioMode = "orig", dubbing = false;
  let actx = null, vGain = null, dubGain = null, liveSrcs = [];
  function ensureActx() {
    if (actx) return;
    actx = new (window.AudioContext || window.webkitAudioContext)();
    try { const s = actx.createMediaElementSource(v()); vGain = actx.createGain(); s.connect(vGain).connect(actx.destination); } catch (e) { vGain = null; }
    dubGain = actx.createGain(); dubGain.connect(actx.destination);
  }
  function stopLiveDub() { for (const s of liveSrcs) { try { s.stop(); } catch (e) {} } liveSrcs = []; }
  function scheduleDub(fromMs, dest) {
    stopLiveDub(); if (!dubSegs || !actx) return;
    const now = actx.currentTime;
    for (const seg of dubSegs) {
      if (seg.tMs + seg.buf.duration * 1000 < fromMs) continue;
      const s = actx.createBufferSource(); s.buffer = seg.buf; s.connect(dest);
      const when = now + (seg.tMs - fromMs) / 1000;
      if (when >= now) s.start(when); else s.start(now, (fromMs - seg.tMs) / 1000);
      liveSrcs.push(s);
    }
  }
  function applyAudioMode() {
    for (const b of $("audioSel").querySelectorAll("button")) b.classList.toggle("on", b.dataset.a === audioMode);
    const dub = audioMode === "dub" && !!dubSegs;
    if (!actx) { if (dub && !v().paused) ensureActx(); else return; }
    if (vGain) vGain.gain.value = dub ? 0.12 : 1;
    if (dub && !v().paused) { try { actx.resume(); } catch (e) {} scheduleDub(curMs(), dubGain); } else stopLiveDub();
  }
  async function generateDub() {
    if (dubbing || !rec) return;
    const base = clipBase(rec.url);
    if (!base) { toast("Dubbing isn't available for this site."); return; }
    dubbing = true; $("dubBtn").disabled = true; $("dubProg").hidden = false; $("dubBar").style.width = "6%";
    try {
      const cs = (await ensureCues()).filter((c) => c.dt || c.text);
      if (!cs.length) { toast("No cached subtitles for this clip — watch the video with SubVibe subtitles on, then re-record."); return; }
      ensureActx();
      const prefs = await new Promise((res) => chrome.storage.local.get(["ttsProvider", "dubVoice", "dubGeminiVoice"], res));
      const V = window.SV_VOICES || {};
      const voice = prefs.ttsProvider === "gemini" ? (prefs.dubGeminiVoice || V.GEMINI_DEFAULT_VOICE || "Kore") : (prefs.dubVoice || V.DEFAULT_VOICE || "marin");
      const segs = [];
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i], text = String(c.dt || c.text || "").trim(); if (!text) continue;
        const instr = (window.SV_VOICES && SV_VOICES.ttsInstructions) ? SV_VOICES.ttsInstructions(text, rec.target) : "";
        const resp = await send({ type: "TTS", key: base + ":clipdub:" + rec.id + ":" + voice + "#" + c.absStart, text, voice, instructions: instr, durMs: c.endMs - c.tMs, base, site: base.split(":")[0], title: rec.title, target: rec.target });
        $("dubBar").style.width = (10 + (i / cs.length) * 86) + "%";
        if (resp && resp.error) { toast("Dub: " + resp.error); return; }
        if (!resp || !resp.b64) continue;
        try { segs.push({ tMs: Math.max(0, c.tMs), buf: await actx.decodeAudioData(bufFromB64(resp.b64)) }); } catch (e) {}
      }
      if (!segs.length) { toast("Couldn't generate the dubbed audio."); return; }
      dubSegs = segs; audioMode = "dub"; $("audioRow").hidden = false; applyAudioMode();
      $("dubNote").textContent = segs.length + " lines dubbed. Play to hear it; Export bakes it in.";
      toast("Dubbed voice ready · " + segs.length + " lines");
    } catch (e) { toast("Dub failed — " + ((e && e.message) || e)); }
    finally { dubbing = false; $("dubBtn").disabled = false; $("dubProg").hidden = true; $("dubBar").style.width = "0"; }
  }

  async function doExport() {
    if (exporting || !rec) return;
    exporting = true; $("exportBtn").disabled = true; $("exportLbl").textContent = "Exporting…"; $("prog").hidden = false;
    v().pause(); stopLiveDub();
    const src = document.createElement("video"); src.src = url; src.muted = false; src.playsInline = true; src.preload = "auto";
    try {
      await new Promise((res, rej) => { src.onloadeddata = res; src.onerror = () => rej(new Error("load")); });
      const vw = src.videoWidth, vh = src.videoHeight;
      const cr = crop || { x: 0, y: 0, w: 1, h: 1 };
      const sx = Math.round(cr.x * vw), sy = Math.round(cr.y * vh);
      const sw = Math.max(2, Math.round(cr.w * vw)) & ~1, sh = Math.max(2, Math.round(cr.h * vh)) & ~1; // even dims
      const geom = layoutGeom(sw, sh);
      const canvas = document.createElement("canvas"); canvas.width = geom ? geom.W : sw; canvas.height = geom ? geom.H : sh;
      const ctx = canvas.getContext("2d");
      const cstream = canvas.captureStream(30);
      const dub = audioMode === "dub" && !!dubSegs;
      let audio = [], recDest = null;
      if (dub) { // mix ducked original + the translated voice into the export
        ensureActx();
        recDest = actx.createMediaStreamDestination();
        try { const ss = actx.createMediaElementSource(src); const g = actx.createGain(); g.gain.value = 0.12; ss.connect(g).connect(recDest); } catch (e) {}
        audio = recDest.stream.getAudioTracks();
      } else {
        try { const ss = src.captureStream ? src.captureStream() : src.mozCaptureStream(); audio = ss.getAudioTracks(); } catch (e) {}
      }
      const mime = pickMime(!!geom);
      const mixed = new MediaStream([...cstream.getVideoTracks(), ...audio]);
      const chunks = []; const mr = new MediaRecorder(mixed, mime ? { mimeType: mime } : undefined);
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise((res) => { mr.onstop = res; });
      const inS = inMs / 1000, outS = outMs / 1000;
      src.currentTime = inS;
      await new Promise((res) => { src.onseeked = res; });
      mr.start();
      await src.play().catch(() => {});
      if (dub && recDest) { try { actx.resume(); } catch (e) {} scheduleDub(inMs, recDest); }
      await new Promise((res) => {
        const step = () => {
          if (src.currentTime >= outS || src.ended) { res(); return; }
          try {
            if (geom) composeFrame(ctx, src, geom, sx, sy, sw, sh, src.currentTime * 1000);
            else { ctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh); drawSubOnCanvas(ctx, sw, sh, src.currentTime * 1000); }
          } catch (e) {}
          $("progBar").style.width = Math.min(100, ((src.currentTime - inS) / Math.max(0.1, outS - inS)) * 100) + "%";
          requestAnimationFrame(step);
        };
        step();
      });
      src.pause(); try { cstream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      mr.stop(); await stopped;
      const blob = new Blob(chunks, { type: (mime || "video/webm").split(";")[0] });
      if (!blob.size) toast("Export was empty — keep this tab in front while exporting.");
      else { downloadBlob(blob, "subvibe-clip-" + (rec.host || "video") + "-" + Date.now() + (geom ? "-" + layoutMode : "") + "." + extOf(mime)); toast("Exported · " + (blob.size / 1048576).toFixed(1) + " MB · " + extOf(mime).toUpperCase()); }
    } catch (e) { toast("Export failed — " + ((e && e.message) || e)); }
    finally { stopLiveDub(); exporting = false; $("exportBtn").disabled = false; $("exportLbl").textContent = "Export & download"; $("prog").hidden = true; $("progBar").style.width = "0"; }
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
    crop = (r.crop && typeof r.crop === "object" && r.crop.w > 0) ? { x: +r.crop.x || 0, y: +r.crop.y || 0, w: +r.crop.w, h: +r.crop.h } : null;
    $("editor").hidden = false;
    $("ctitle").textContent = r.title || r.url || "";
    document.title = "SubVibe Clip · " + (r.title || r.host || "");
    const vid = v(); vid.src = url;
    vid.addEventListener("loadedmetadata", () => {
      if ((!durMs || !isFinite(durMs))) {
        if (isFinite(vid.duration) && vid.duration > 0) durMs = vid.duration * 1000;
        else { // MediaRecorder WebM often reports Infinity until you seek to the end
          const fix = () => { if (isFinite(vid.duration) && vid.duration > 0) { durMs = vid.duration * 1000; if (!outMs) outMs = durMs; } vid.removeEventListener("seeked", fix); vid.currentTime = 0; paintTrim(); };
          vid.addEventListener("seeked", fix); try { vid.currentTime = 1e7; } catch (e) {}
        }
      }
      if (!outMs) outMs = durMs;
      paintTrim(); paintPlayhead(); paintCrop();
    });
    // Native controls drive playback; the trim bar is just markers. No auto-pause.
    vid.addEventListener("timeupdate", () => { paintPlayhead(); renderSub(); });
    vid.addEventListener("play", () => { paintPlayhead(); applyAudioMode(); });
    vid.addEventListener("pause", () => { paintPlayhead(); stopLiveDub(); });
    vid.addEventListener("seeking", stopLiveDub);
    vid.addEventListener("seeked", () => { renderSub(); if (!vid.paused) applyAudioMode(); });
    const mb = Math.round((r.blob.size || 0) / 1048576 * 10) / 10;
    $("meta").textContent = (r.w ? r.w + "×" + r.h + " · " : "") + fmt(durMs) + " · " + mb + " MB · " + new Date(r.ts).toLocaleString();
    setupScrub(); setupCrop();
    paintTrim();
    ensureCues().then(() => { renderSub(); if (!cues.length) $("subNote").textContent = "No cached subtitles found for this video — turn SubVibe subtitles on while watching, then re-record."; else { const n = chunksOfClip().length; $("chunkRow").hidden = !n; $("chunkNote").textContent = n + (n === 1 ? " chunk" : " chunks") + " in this recording"; } });
    renderRecent();
  }

  $("setIn").addEventListener("click", () => { inMs = Math.min(curMs(), outMs - 200); paintTrim(); });
  $("chunkSel").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b || exporting) return; trimToChunks(+b.dataset.n); });
  $("setOut").addEventListener("click", () => { outMs = Math.max(curMs(), inMs + 200); paintTrim(); });
  $("cropDrawBtn").addEventListener("click", () => setCropDraw(!cropDraw));
  $("cropReset").addEventListener("click", () => { crop = null; setCropDraw(false); paintCrop(); });
  $("dubBtn").addEventListener("click", generateDub);
  $("audioSel").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b || !dubSegs) return; audioMode = b.dataset.a; applyAudioMode(); });
  $("subSel").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; subsMode = b.dataset.s; for (const x of $("subSel").querySelectorAll("button")) x.classList.toggle("on", x === b); renderSub(); });
  function syncLayout() {
    for (const b of $("layoutSel").querySelectorAll("button")) b.classList.toggle("on", b.dataset.l === layoutMode);
    const L = LAYOUTS[layoutMode], mime = pickMime(!!L);
    $("fmtNote").textContent = L ? (extOf(mime).toUpperCase() + " · " + L.W + "×" + L.H + " · the video on a card, the subtitle lines in the band below it — nothing over the picture." + (extOf(mime) !== "mp4" ? " (This browser can't record MP4; Instagram needs a conversion.)" : ""))
      : (extOf(mime).toUpperCase() + " · re-cut to your in/out and crop.");
  }
  $("layoutSel").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b || exporting) return; layoutMode = b.dataset.l; syncLayout(); });
  syncLayout();
  // Tips for this clip: every line in the trim range, explained (cached per line), as one sheet.
  $("clipTipsBtn").addEventListener("click", async () => {
    if (!rec) return;
    const base = clipBase(rec.url); if (!base) { $("clipTipsNote").textContent = "Tips aren't available for this site."; return; }
    await ensureCues();
    // Tips are given once per CHUNK (a passage), for every chunk the trim range touches.
    const lines = chunksOfClip().filter((ch) => ch.text && ch.startMs < outMs && ch.endMs > inMs).map((ch) => ({ s: ch.text, tr: ch.sentences.map((x) => x.tr).join(" ").trim(), sentences: ch.sentences }));
    if (!lines.length) { $("clipTipsNote").textContent = "No subtitle lines in this range — turn SubVibe subtitles on while watching, then re-record."; return; }
    const sample = (cues || []).map((c) => c.o || c.text).filter(Boolean).slice(0, 40);
    $("clipTipsBtn").disabled = true; $("clipTipsNote").textContent = "Explaining " + lines.length + (lines.length === 1 ? " chunk" : " chunks") + "… (a few seconds each, cached afterwards)";
    const r = await send({ type: "CLIP_TIPS", clipId: rec.id, base, lines, sample, title: rec.title, url: rec.url, target: rec.target });
    $("clipTipsBtn").disabled = false;
    $("clipTipsNote").textContent = r && r.ok ? r.count + (r.count === 1 ? " chunk" : " chunks") + " explained — opened as a sheet. Use Slides for Instagram there for the carousel pages."
      : r && r.error === "no-key" ? "Add an API key in the popup (or connect Claude Code) first." : "Couldn't explain the lines. Try again.";
  });
  window.__svClipDebug = { layoutGeom, composeFrame, LAYOUTS, setLayout: (l) => { layoutMode = l; syncLayout(); }, chunksOfClip, trimToChunks, range: () => ({ inMs, outMs, durMs }) }; // harness / verification hook (extension page only)
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
