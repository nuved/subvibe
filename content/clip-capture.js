// content/clip-capture.js — on-demand (never registered in the manifest).
// Records the playing video with SubVibe's live subtitles burned in, by drawing
// the <video> element + the current #copilot-subs text onto a canvas and
// recording canvas video + the element's audio via MediaRecorder. Non-DRM only
// (DRM video taints the canvas / yields black frames). This is the capture-test
// increment for the Clip feature; the full editor comes next.
// Spec: docs/superpowers/specs/2026-08-26-clip-design.md
(function () {
  // Re-injection toggles the existing session instead of starting a new one.
  if (window.__svClip) { try { window.__svClip.toggle(); } catch (e) {} return; }

  const DRM_HOSTS = /(^|\.)(netflix\.com|primevideo\.com|amazon\.[a-z.]+)$/i;

  function findVideo() {
    const ad = window.__copilotAdapters || [];
    for (const a of ad) { try { const v = a && a.getVideoEl && a.getVideoEl(); if (v && v.videoWidth) return v; } catch (e) {} }
    const vids = [...document.querySelectorAll("video")].filter((v) => v.videoWidth > 0);
    vids.sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight);
    return vids[0] || document.querySelector("video");
  }

  // The translated subtitle line(s) currently on screen, read straight from the
  // live overlay so the clip shows exactly what the viewer sees.
  function currentSubs() {
    const root = document.getElementById("copilot-subs");
    if (!root) return [];
    const out = [];
    for (const line of root.querySelectorAll(".copilot-subs__line")) {
      if (line.offsetParent === null) continue; // hidden line
      const txt = (line.textContent || "").replace(/\s+/g, " ").trim();
      if (txt) out.push({ text: txt, rtl: getComputedStyle(line).direction === "rtl" });
    }
    return out;
  }

  let toastEl = null, toastT = null;
  function toast(msg, ms) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.cssText = "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483647;background:rgba(20,16,12,.92);color:#fff;font:600 13px/1.3 system-ui,-apple-system,sans-serif;padding:10px 15px;border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,.4);max-width:80vw;text-align:center;pointer-events:none;";
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = msg; toastEl.style.opacity = "1";
    clearTimeout(toastT); toastT = setTimeout(() => { if (toastEl) toastEl.style.opacity = "0"; }, ms || 2600);
  }

  let pill = null, pillT = null, t0 = 0;
  function showPill() {
    pill = document.createElement("div");
    pill.style.cssText = "position:fixed;top:16px;left:16px;z-index:2147483647;background:rgba(20,16,12,.88);color:#fff;font:600 13px/1 system-ui,-apple-system,sans-serif;padding:9px 14px;border-radius:22px;display:flex;gap:8px;align-items:center;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4);user-select:none;";
    pill.title = "Click to stop recording";
    const dot = document.createElement("span"); dot.style.cssText = "width:10px;height:10px;border-radius:50%;background:#ff4b4b;animation:svclipblink 1s steps(2) infinite;";
    const st = document.createElement("style"); st.textContent = "@keyframes svclipblink{50%{opacity:.25}}";
    const label = document.createElement("span"); label.id = "svclip-t"; label.textContent = "REC 0:00";
    const stop = document.createElement("span"); stop.textContent = "◼ Stop"; stop.style.cssText = "margin-left:4px;padding-left:8px;border-left:1px solid rgba(255,255,255,.25);opacity:.9;";
    pill.append(st, dot, label, stop); document.documentElement.appendChild(pill);
    pill.addEventListener("click", () => { try { toggle(); } catch (e) {} });
    t0 = Date.now();
    pillT = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      label.textContent = "REC " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    }, 250);
  }
  function hidePill() { if (pillT) clearInterval(pillT); pillT = null; if (pill) pill.remove(); pill = null; }

  let rec = null, raf = 0, elStream = null;

  function drawSubs(ctx, w, h, lines) {
    if (!lines.length) return;
    const fs = Math.max(16, Math.round(h * 0.045));
    const pad = Math.round(fs * 0.4);
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    let y = h - Math.round(h * 0.06);
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i];
      ctx.font = (i === 0 ? "600 " : "500 ") + (i === 0 ? fs : Math.round(fs * 0.9)) + "px system-ui, -apple-system, 'Segoe UI', sans-serif";
      ctx.direction = ln.rtl ? "rtl" : "ltr";
      const metrics = ctx.measureText(ln.text);
      const tw = Math.min(w - 40, metrics.width);
      const lh = (i === 0 ? fs : Math.round(fs * 0.9)) + pad;
      // shadow band for legibility
      ctx.fillStyle = "rgba(0,0,0,.55)";
      ctx.fillRect(w / 2 - tw / 2 - pad, y - lh + pad / 2, tw + pad * 2, lh);
      ctx.fillStyle = i === 0 ? "#fff" : "#ffe0cf";
      ctx.shadowColor = "rgba(0,0,0,.8)"; ctx.shadowBlur = 4;
      ctx.fillText(ln.text, w / 2, y);
      ctx.shadowBlur = 0;
      y -= lh + 2;
    }
  }

  async function start() {
    if (DRM_HOSTS.test(location.hostname)) { toast("Clip isn't available on DRM-protected video (Netflix/Prime)."); return; }
    const v = findVideo();
    if (!v || !v.videoWidth) { toast("No playing video found on this page."); return; }
    const w = v.videoWidth, h = v.videoHeight;
    const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { alpha: false });
    // Prove the video is drawable (DRM taints the canvas).
    try { ctx.drawImage(v, 0, 0, w, h); } catch (e) { toast("This video is protected and can't be clipped."); return; }
    // audio from the element; video from the canvas
    try { elStream = v.captureStream ? v.captureStream() : (v.mozCaptureStream ? v.mozCaptureStream() : null); }
    catch (e) { elStream = null; }
    const canvasStream = canvas.captureStream(30);
    const audio = elStream ? elStream.getAudioTracks() : [];
    const mixed = new MediaStream([...canvasStream.getVideoTracks(), ...audio]);
    const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
    const chunks = [];
    try { rec = new MediaRecorder(mixed, mime ? { mimeType: mime } : undefined); }
    catch (e) { toast("Recording isn't supported in this browser."); return; }
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      cancelAnimationFrame(raf); hidePill();
      try { canvasStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      const blob = new Blob(chunks, { type: mime || "video/webm" });
      if (!blob.size) { toast("Recording was empty — the tab must stay in front while recording."); return; }
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
      a.download = "subvibe-clip-" + Date.now() + ".webm";
      document.documentElement.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      toast("Clip saved · " + (blob.size / 1048576).toFixed(1) + " MB · check your downloads", 4000);
    };
    // draw loop
    const tick = () => {
      try { ctx.drawImage(v, 0, 0, w, h); drawSubs(ctx, w, h, currentSubs()); } catch (e) {}
      raf = requestAnimationFrame(tick);
    };
    tick();
    rec.start();
    showPill();
    toast("Recording " + w + "×" + h + " — press Alt+Shift+C to stop.", 3200);
  }

  function stop() { try { if (rec && rec.state !== "inactive") rec.stop(); } catch (e) {} rec = null; }
  function toggle() { if (rec && rec.state === "recording") stop(); else start(); }

  window.__svClip = { toggle, stop };
  toggle(); // first injection starts recording
})();
