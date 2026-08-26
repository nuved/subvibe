// content/clip-capture.js — on-demand (never manifest-registered). Records JUST
// the video element via HTMLVideoElement.captureStream() — clean frames at the
// video's own resolution, with NO player UI/controls and NO page chrome, and
// (unlike tabCapture) no collision with Live Translate. The recorded WebM is
// streamed to the background in base64 chunks (the content script is page-origin
// and can't reach the extension's IndexedDB directly), stored in the "clips"
// store, and opened in the Clip editor. The REC pill is a page overlay, so it is
// NOT in the recording (we capture the element, not the page).
// Spec: docs/superpowers/specs/2026-08-26-clip-design.md
(function () {
  if (window.__svClipRec) { try { window.__svClipRec.toggle(); } catch (e) {} return; }

  const DRM = /(^|\.)(netflix\.com|primevideo\.com|amazon\.[a-z.]+)$/i.test(location.hostname);
  const send = (m) => new Promise((res) => { try { chrome.runtime.sendMessage(m, (r) => res(chrome.runtime.lastError ? null : r)); } catch (e) { res(null); } });

  function findVideo() {
    const ad = window.__copilotAdapters || [];
    for (const a of ad) { try { const v = a && a.getVideoEl && a.getVideoEl(); if (v && v.videoWidth) return v; } catch (e) {} }
    const vids = [...document.querySelectorAll("video")].filter((v) => v.videoWidth > 0);
    vids.sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight);
    return vids[0] || null;
  }

  let rec = null, chunks = [], stream = null, mime = "", t0 = 0, startSec = 0, W = 0, H = 0;
  let pill = null, timer = null, toastEl = null, toastT = null;

  function toast(msg, ms) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.cssText = "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483647;background:rgba(20,16,12,.92);color:#fff;font:600 13px/1.35 system-ui,-apple-system,sans-serif;padding:10px 15px;border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,.4);max-width:80vw;text-align:center;pointer-events:none;transition:opacity .2s;";
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = msg; toastEl.style.opacity = "1";
    clearTimeout(toastT); toastT = setTimeout(() => { if (toastEl) toastEl.style.opacity = "0"; }, ms || 2800);
  }
  function showPill() {
    pill = document.createElement("div");
    pill.style.cssText = "position:fixed;top:16px;left:16px;z-index:2147483647;background:rgba(20,16,12,.9);color:#fff;font:600 13px/1 system-ui,-apple-system,sans-serif;padding:9px 14px;border-radius:22px;display:flex;gap:9px;align-items:center;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.45);user-select:none;";
    pill.title = "Click to stop recording and open the editor";
    const st = document.createElement("style"); st.textContent = "@keyframes svclipblink{50%{opacity:.2}}";
    const dot = document.createElement("span"); dot.style.cssText = "width:10px;height:10px;border-radius:50%;background:#ff4b4b;animation:svclipblink 1s steps(2) infinite;";
    const label = document.createElement("span"); label.textContent = "REC 0:00";
    const stop = document.createElement("span"); stop.textContent = "◼ Stop"; stop.style.cssText = "margin-left:2px;padding-left:9px;border-left:1px solid rgba(255,255,255,.28);opacity:.92;";
    pill.append(st, dot, label);
    pill.append(stop);
    pill.addEventListener("click", () => { stopRec(); });
    document.documentElement.appendChild(pill);
    t0 = Date.now();
    timer = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); label.textContent = "REC " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }, 250);
  }
  function hidePill() { if (timer) clearInterval(timer); timer = null; if (pill) pill.remove(); pill = null; }

  function sliceB64(blob) { return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1] || ""); fr.onerror = () => res(""); fr.readAsDataURL(blob); }); }

  async function transfer(blob) {
    const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const meta = { title: document.title, url: location.href, host: location.hostname, startSec, w: W, h: H, durationMs: Date.now() - t0, mime: (mime || "video/webm").split(";")[0] };
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

  function startRec() {
    if (rec) return;
    if (DRM) { toast("Clip isn't available on DRM-protected video (Netflix/Prime)."); return; }
    const v = findVideo();
    if (!v || !v.videoWidth) { toast("No playing video found on this page."); return; }
    try { stream = v.captureStream ? v.captureStream() : (v.mozCaptureStream ? v.mozCaptureStream() : null); }
    catch (e) { stream = null; }
    if (!stream || !stream.getVideoTracks().length) { toast("This video can't be captured (it may be protected)."); return; }
    mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
    chunks = []; W = v.videoWidth; H = v.videoHeight; startSec = v.currentTime || 0;
    try { rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
    catch (e) { toast("Recording isn't supported in this browser."); return; }
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      hidePill();
      try { stream.getVideoTracks().forEach((t) => { /* leave the element's tracks; captureStream tracks are shared */ }); } catch (e) {}
      const blob = new Blob(chunks, { type: (mime || "video/webm").split(";")[0] });
      if (!blob.size) { toast("Recording was empty — try again while the video is playing."); return; }
      await transfer(blob);
    };
    rec.start(1000);
    showPill();
    toast("Recording the video (" + W + "×" + H + ") — click the red pill or ⌥⇧C to stop.", 3200);
  }
  function stopRec() { try { if (rec && rec.state !== "inactive") { const r = rec; rec = null; r.stop(); } } catch (e) {} }

  window.__svClipRec = { toggle: () => (rec && rec.state === "recording" ? stopRec() : startRec()) };
  startRec(); // first injection starts recording
})();
