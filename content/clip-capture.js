// content/clip-capture.js — on-demand (never manifest-registered). Records a clip
// of the video on this page and hands it to the Clip editor.
//
// Two sources:
//  • Video — HTMLVideoElement.captureStream(): clean frames at the video's own
//    resolution, no player UI, no page chrome (not on DRM video, which is black).
//  • Area — the reader draws a box; the box is recorded through a canvas. On an
//    ordinary player the frames come from the element (no picker); on protected
//    video (Netflix, Prime) they come from a screen capture of this tab
//    (getDisplayMedia — the browser asks once), which is what the area
//    screenshot uses too, so the picture is not black.
// A countdown (0 · 3 · 5 · 10 s) can precede the recording.
// The WebM is streamed to the background in base64 chunks (the content script is
// page-origin and can't reach the extension's IndexedDB), stored in the "clips"
// store, and opened in the Clip editor. Spec: docs/superpowers/specs/2026-08-26-clip-design.md
(function () {
  if (window.__svClipRec) { try { window.__svClipRec.toggle(); } catch (e) {} return; }

  const DRM = /(^|\.)(netflix\.com|primevideo\.com|amazon\.[a-z.]+)$/i.test(location.hostname);
  const send = (m) => new Promise((res) => { try { chrome.runtime.sendMessage(m, (r) => res(chrome.runtime.lastError ? null : r)); } catch (e) { res(null); } });
  const Z = 2147483647;
  const FONT = "system-ui,-apple-system,sans-serif";

  function findVideo() {
    const ad = window.__copilotAdapters || [];
    for (const a of ad) { try { const v = a && a.getVideoEl && a.getVideoEl(); if (v && v.videoWidth) return v; } catch (e) {} }
    const vids = [...document.querySelectorAll("video")].filter((v) => v.videoWidth > 0);
    vids.sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight);
    return vids[0] || null;
  }

  let rec = null, chunks = [], stream = null, mime = "", t0 = 0, startSec = 0, W = 0, H = 0;
  let mode = DRM ? "area" : "video", delay = 0, area = null; // area: {x, y, w, h} in viewport CSS px
  let disp = null, dispVideo = null, raf = 0, canvas = null, drawing = false;
  let pill = null, timer = null, toastEl = null, toastT = null, launcher = null, countEl = null, cancelled = false;

  function toast(msg, ms) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.cssText = "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:" + Z + ";background:rgba(20,16,12,.92);color:#fff;font:600 13px/1.35 " + FONT + ";padding:10px 15px;border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,.4);max-width:80vw;text-align:center;pointer-events:none;transition:opacity .2s;";
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = msg; toastEl.style.opacity = "1";
    clearTimeout(toastT); toastT = setTimeout(() => { if (toastEl) toastEl.style.opacity = "0"; }, ms || 2800);
  }
  const btn = (text, on, title) => { const b = document.createElement("button"); b.type = "button"; b.textContent = text; if (title) b.title = title; b.style.cssText = "border:1px solid rgba(255,255,255,.22);background:" + (on ? "#C93F2B" : "rgba(255,255,255,.08)") + ";color:#fff;font:600 12px/1 " + FONT + ";padding:7px 10px;border-radius:8px;cursor:pointer;"; return b; };

  // ── Launcher: source, countdown, Start ─────────────────────────────────────
  function showLauncher() {
    hideLauncher();
    launcher = document.createElement("div");
    launcher.style.cssText = "position:fixed;top:16px;left:16px;z-index:" + Z + ";background:rgba(20,16,12,.94);color:#fff;font:600 13px/1.3 " + FONT + ";padding:12px 14px;border-radius:14px;display:flex;flex-direction:column;gap:9px;box-shadow:0 8px 28px rgba(0,0,0,.5);user-select:none;min-width:300px;";
    const row = (label) => { const r = document.createElement("div"); r.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;"; const l = document.createElement("span"); l.textContent = label; l.style.cssText = "opacity:.7;font-size:11px;letter-spacing:.04em;text-transform:uppercase;min-width:64px;"; r.appendChild(l); return r; };
    const head = document.createElement("div"); head.style.cssText = "display:flex;align-items:center;gap:8px;"; head.innerHTML = '<span style="width:10px;height:10px;border-radius:50%;background:#ff4b4b;display:inline-block"></span><b>Record a clip</b>';
    const close = btn("×", false, "Cancel"); close.style.marginLeft = "auto"; close.style.padding = "4px 8px"; close.addEventListener("click", () => { cancelled = true; hideLauncher(); });
    head.appendChild(close);
    const r1 = row("Record"); const bVideo = btn("Video", mode === "video", DRM ? "Not on protected video — use Area" : "The video element itself: clean frames, no player controls"); const bArea = btn("Area", mode === "area", "Draw a box over what to record" + (DRM ? " (protected video: the browser asks once to share this tab)" : ""));
    if (DRM) { bVideo.disabled = true; bVideo.style.opacity = ".4"; }
    const areaNote = document.createElement("span"); areaNote.style.cssText = "opacity:.75;font-size:12px;"; areaNote.textContent = area ? Math.round(area.w) + "×" + Math.round(area.h) : "";
    const setMode = (m) => { mode = m; bVideo.style.background = m === "video" ? "#C93F2B" : "rgba(255,255,255,.08)"; bArea.style.background = m === "area" ? "#C93F2B" : "rgba(255,255,255,.08)"; };
    bVideo.addEventListener("click", () => setMode("video"));
    bArea.addEventListener("click", async () => { setMode("area"); launcher.style.display = "none"; const a = await selectArea(); launcher.style.display = "flex"; if (a) { area = a; areaNote.textContent = Math.round(a.w) + "×" + Math.round(a.h); } });
    r1.append(bVideo, bArea, areaNote);
    const r2 = row("Start in"); const dbs = [0, 3, 5, 10].map((d) => { const b = btn(d ? d + " s" : "now", delay === d, d ? "Count down " + d + " seconds, then record" : "Record right away"); b.addEventListener("click", () => { delay = d; dbs.forEach((x, i) => { x.style.background = [0, 3, 5, 10][i] === d ? "#C93F2B" : "rgba(255,255,255,.08)"; }); }); return b; }); r2.append(...dbs);
    const r3 = document.createElement("div"); r3.style.cssText = "display:flex;gap:8px;align-items:center;"; const go = btn("● Start", true, "Start recording (⌥⇧C stops)"); go.style.cssText += "padding:9px 16px;font-size:13px;"; const hint = document.createElement("span"); hint.style.cssText = "opacity:.6;font-size:11px;"; hint.textContent = "⌥⇧C stops · click the red pill too";
    go.addEventListener("click", () => { if (mode === "area" && !area) { toast("Draw the box first — click Area."); return; } hideLauncher(); beginWithDelay(); });
    r3.append(go, hint);
    launcher.append(head, r1, r2, r3);
    document.documentElement.appendChild(launcher);
    if (mode === "area" && !area) bArea.click();
  }
  function hideLauncher() { if (launcher) launcher.remove(); launcher = null; }

  // ── Area selection: a dimmed page and a drag box ───────────────────────────
  function selectArea() {
    return new Promise((res) => {
      const ov = document.createElement("div"); ov.style.cssText = "position:fixed;inset:0;z-index:" + Z + ";cursor:crosshair;background:rgba(0,0,0,.28);";
      const box = document.createElement("div"); box.style.cssText = "position:fixed;border:2px solid #ff4b4b;box-shadow:0 0 0 9999px rgba(0,0,0,.28);display:none;pointer-events:none;"; ov.appendChild(box);
      const tip = document.createElement("div"); tip.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);background:rgba(20,16,12,.92);color:#fff;font:600 13px/1.3 " + FONT + ";padding:8px 14px;border-radius:10px;pointer-events:none;"; tip.textContent = "Drag a box over what to record — Esc to cancel"; ov.appendChild(tip);
      let sx = 0, sy = 0, cur = null;
      const paint = (x, y) => { const l = Math.min(sx, x), t = Math.min(sy, y), w = Math.abs(x - sx), h = Math.abs(y - sy); box.style.display = "block"; box.style.left = l + "px"; box.style.top = t + "px"; box.style.width = w + "px"; box.style.height = h + "px"; ov.style.background = "transparent"; cur = { x: l, y: t, w, h }; };
      const done = (a) => { window.removeEventListener("keydown", onKey, true); ov.remove(); res(a); };
      const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); done(null); } };
      ov.addEventListener("mousedown", (e) => { e.preventDefault(); sx = e.clientX; sy = e.clientY; paint(sx, sy); });
      ov.addEventListener("mousemove", (e) => { if (e.buttons & 1) paint(e.clientX, e.clientY); });
      ov.addEventListener("mouseup", (e) => { paint(e.clientX, e.clientY); done(cur && cur.w > 24 && cur.h > 24 ? cur : null); });
      window.addEventListener("keydown", onKey, true);
      document.documentElement.appendChild(ov);
    });
  }

  // ── Countdown, then record ─────────────────────────────────────────────────
  async function beginWithDelay() {
    cancelled = false;
    if (delay > 0) {
      countEl = document.createElement("div");
      countEl.style.cssText = "position:fixed;inset:0;z-index:" + Z + ";display:flex;align-items:center;justify-content:center;pointer-events:none;";
      const n = document.createElement("div"); n.style.cssText = "min-width:150px;height:150px;border-radius:50%;background:rgba(20,16,12,.82);color:#fff;font:800 84px/150px " + FONT + ";text-align:center;box-shadow:0 0 0 6px rgba(255,75,75,.7),0 12px 40px rgba(0,0,0,.5);padding:0 20px;"; countEl.appendChild(n);
      const c = document.createElement("div"); c.style.cssText = "position:absolute;bottom:18%;left:50%;transform:translateX(-50%);color:#fff;font:600 13px/1.3 " + FONT + ";background:rgba(20,16,12,.8);padding:6px 12px;border-radius:8px;"; c.textContent = "Recording starts — Esc cancels"; countEl.appendChild(c);
      document.documentElement.appendChild(countEl);
      const onKey = (e) => { if (e.key === "Escape") { cancelled = true; } };
      window.addEventListener("keydown", onKey, true);
      for (let s = delay; s > 0 && !cancelled; s--) { n.textContent = String(s); await new Promise((r) => setTimeout(r, 1000)); }
      window.removeEventListener("keydown", onKey, true);
      countEl.remove(); countEl = null;
      if (cancelled) { toast("Cancelled."); return; }
    }
    if (mode === "area") await startArea(); else startVideo();
  }

  function showPill() {
    pill = document.createElement("div");
    pill.style.cssText = "position:fixed;top:16px;left:16px;z-index:" + Z + ";background:rgba(20,16,12,.9);color:#fff;font:600 13px/1 " + FONT + ";padding:9px 14px;border-radius:22px;display:flex;gap:9px;align-items:center;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.45);user-select:none;";
    pill.title = "Click to stop recording and open the editor";
    const st = document.createElement("style"); st.textContent = "@keyframes svclipblink{50%{opacity:.2}}";
    const dot = document.createElement("span"); dot.style.cssText = "width:10px;height:10px;border-radius:50%;background:#ff4b4b;animation:svclipblink 1s steps(2) infinite;";
    const label = document.createElement("span"); label.textContent = "REC 0:00";
    const stop = document.createElement("span"); stop.textContent = "◼ Stop"; stop.style.cssText = "margin-left:2px;padding-left:9px;border-left:1px solid rgba(255,255,255,.28);opacity:.92;";
    pill.append(st, dot, label, stop);
    pill.addEventListener("click", () => { stopRec(); });
    document.documentElement.appendChild(pill);
    t0 = Date.now();
    timer = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); label.textContent = "REC " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }, 250);
  }
  function hidePill() { if (timer) clearInterval(timer); timer = null; if (pill) pill.remove(); pill = null; }

  function sliceB64(blob) { return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1] || ""); fr.onerror = () => res(""); fr.readAsDataURL(blob); }); }

  async function transfer(blob) {
    const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const meta = { title: document.title, url: location.href, host: location.hostname, startSec, w: W, h: H, durationMs: Date.now() - t0, mime: (mime || "video/webm").split(";")[0], mode, area: mode === "area" ? area : null };
    const CH = 393216; // multiple of 3 → each non-last chunk's base64 has no padding, so concatenation stays valid
    const total = Math.ceil(blob.size / CH);
    if (!(await send({ type: "CLIP_BEGIN", id, total, meta }))) { toast("Couldn't save the clip."); return; }
    for (let i = 0; i < total; i++) {
      const b64 = await sliceB64(blob.slice(i * CH, (i + 1) * CH));
      const r = await send({ type: "CLIP_CHUNK", id, i, b64 });
      if (!r || !r.ok) { toast("Saving the clip failed — try a shorter clip."); return; }
    }
    const done = await send({ type: "CLIP_END", id });
    toast(done && done.ok ? "Clip saved — opening the editor…" : "Couldn't finish saving the clip.");
  }

  function pickMime() { return ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || ""; }
  function record(s, what) {
    mime = pickMime(); chunks = [];
    try { rec = new MediaRecorder(s, mime ? { mimeType: mime } : undefined); }
    catch (e) { toast("Recording isn't supported in this browser."); cleanup(); return false; }
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      hidePill(); cleanup();
      const blob = new Blob(chunks, { type: (mime || "video/webm").split(";")[0] });
      if (!blob.size) { toast("Recording was empty — try again while the video is playing."); return; }
      await transfer(blob);
    };
    rec.start(1000);
    showPill();
    toast("Recording " + what + " — click the red pill or ⌥⇧C to stop.", 3200);
    return true;
  }
  function cleanup() {
    if (raf) cancelAnimationFrame(raf); raf = 0; drawing = false;
    try { if (disp) disp.getTracks().forEach((t) => t.stop()); } catch (e) {} disp = null;
    if (dispVideo) { try { dispVideo.srcObject = null; dispVideo.remove(); } catch (e) {} dispVideo = null; }
    canvas = null;
  }

  // Video: the element's own stream.
  function startVideo() {
    if (rec) return;
    if (DRM) { toast("The video element is protected here — record an Area instead."); return; }
    const v = findVideo();
    if (!v || !v.videoWidth) { toast("No playing video found on this page."); return; }
    try { stream = v.captureStream ? v.captureStream() : (v.mozCaptureStream ? v.mozCaptureStream() : null); } catch (e) { stream = null; }
    if (!stream || !stream.getVideoTracks().length) { toast("This video can't be captured (it may be protected) — try Area."); return; }
    W = v.videoWidth; H = v.videoHeight; startSec = v.currentTime || 0;
    record(stream, "the video (" + W + "×" + H + ")");
  }

  // Area: the drawn box through a canvas — frames from the element, or from a
  // screen capture of this tab on protected video.
  async function startArea() {
    if (rec || !area) return;
    const v = findVideo();
    startSec = (v && v.currentTime) || 0;
    const dpr = window.devicePixelRatio || 1;
    let source = null, sx = 0, sy = 0, sw = 0, sh = 0, audio = [];
    if (!DRM && v && v.videoWidth) {
      // the element: map the box (viewport px) into video pixels
      const r = v.getBoundingClientRect(); const kx = v.videoWidth / r.width, ky = v.videoHeight / r.height;
      const ix = Math.max(area.x, r.left), iy = Math.max(area.y, r.top), ix2 = Math.min(area.x + area.w, r.right), iy2 = Math.min(area.y + area.h, r.bottom);
      if (ix2 - ix < 16 || iy2 - iy < 16) { toast("The box must cover part of the video."); return; }
      source = v; sx = (ix - r.left) * kx; sy = (iy - r.top) * ky; sw = (ix2 - ix) * kx; sh = (iy2 - iy) * ky;
      try { const s = v.captureStream ? v.captureStream() : null; if (s) audio = s.getAudioTracks(); } catch (e) {}
    } else {
      // a screen capture of this tab (the browser asks once); the box in capture pixels
      try { disp = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: true, preferCurrentTab: true, selfBrowserSurface: "include", surfaceSwitching: "exclude", systemAudio: "exclude", monitorTypeSurfaces: "exclude" }); }
      catch (e) { toast("Sharing this tab was declined — nothing recorded."); return; }
      dispVideo = document.createElement("video"); dispVideo.muted = true; dispVideo.playsInline = true; dispVideo.srcObject = disp; dispVideo.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;"; document.documentElement.appendChild(dispVideo);
      try { await dispVideo.play(); } catch (e) {}
      await new Promise((r) => { if (dispVideo.videoWidth) r(); else dispVideo.onloadedmetadata = () => r(); setTimeout(r, 1500); });
      const kx = dispVideo.videoWidth / window.innerWidth, ky = dispVideo.videoHeight / window.innerHeight;
      source = dispVideo; sx = area.x * kx; sy = area.y * ky; sw = area.w * kx; sh = area.h * ky; audio = disp.getAudioTracks();
      disp.getVideoTracks()[0].addEventListener("ended", () => stopRec());
    }
    W = Math.max(16, Math.round(sw)); H = Math.max(16, Math.round(sh));
    if (W % 2) W++; if (H % 2) H++;
    canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    drawing = true;
    const draw = () => { if (!drawing) return; try { ctx.drawImage(source, sx, sy, sw, sh, 0, 0, W, H); } catch (e) {} raf = requestAnimationFrame(draw); };
    draw();
    stream = canvas.captureStream(30);
    for (const t of audio) { try { stream.addTrack(t); } catch (e) {} }
    record(stream, "the area (" + W + "×" + H + ")" + (source === v ? "" : " from the screen"));
  }
  function stopRec() { try { if (rec && rec.state !== "inactive") { const r = rec; rec = null; r.stop(); } } catch (e) {} }

  window.__svClipRec = { toggle: () => (rec && rec.state === "recording" ? stopRec() : (launcher ? hideLauncher() : showLauncher())) };
  showLauncher(); // first injection: the launcher (source, countdown, Start)
})();
