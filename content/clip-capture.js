// content/clip-capture.js — on-demand (never manifest-registered). Just the
// on-page recording indicator for Clip: a red REC pill you can click to stop.
// The actual recording is done by tabCapture in the offscreen document; this
// script only reflects state (SV_CLIP_RECORDING messages from background) and
// lets the user stop from the page. The pill sits in a screen corner, outside
// the video, so the editor's crop leaves it out of the finished clip.
// Spec: docs/superpowers/specs/2026-08-26-clip-design.md
(function () {
  if (window.__svClipUI) { return; }
  window.__svClipUI = true;

  let pill = null, timer = null, t0 = 0, toastEl = null, toastT = null;

  function toast(msg, ms) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.cssText = "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483647;background:rgba(20,16,12,.92);color:#fff;font:600 13px/1.35 system-ui,-apple-system,sans-serif;padding:10px 15px;border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,.4);max-width:80vw;text-align:center;pointer-events:none;transition:opacity .2s;";
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = msg; toastEl.style.opacity = "1";
    clearTimeout(toastT); toastT = setTimeout(() => { if (toastEl) toastEl.style.opacity = "0"; }, ms || 2800);
  }

  function show() {
    if (pill) return;
    pill = document.createElement("div");
    pill.style.cssText = "position:fixed;top:16px;left:16px;z-index:2147483647;background:rgba(20,16,12,.9);color:#fff;font:600 13px/1 system-ui,-apple-system,sans-serif;padding:9px 14px;border-radius:22px;display:flex;gap:9px;align-items:center;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.45);user-select:none;transition:transform .1s;";
    pill.title = "Click to stop recording and open the editor";
    const st = document.createElement("style"); st.textContent = "@keyframes svclipblink{50%{opacity:.2}}";
    const dot = document.createElement("span"); dot.style.cssText = "width:10px;height:10px;border-radius:50%;background:#ff4b4b;animation:svclipblink 1s steps(2) infinite;";
    const label = document.createElement("span"); label.textContent = "REC 0:00";
    const stop = document.createElement("span"); stop.textContent = "◼ Stop"; stop.style.cssText = "margin-left:2px;padding-left:9px;border-left:1px solid rgba(255,255,255,.28);opacity:.92;";
    pill.append(st, dot, label, stop);
    pill.addEventListener("mousedown", () => { pill.style.transform = "scale(.96)"; });
    pill.addEventListener("mouseup", () => { pill.style.transform = ""; });
    pill.addEventListener("click", () => { try { chrome.runtime.sendMessage({ type: "CLIP_STOP" }); } catch (e) {} label.textContent = "Saving…"; });
    document.documentElement.appendChild(pill);
    t0 = Date.now();
    timer = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      label.textContent = "REC " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    }, 250);
    toast("Recording this tab — click the red pill (or ⌥⇧C) to stop.", 3200);
  }

  function hide(error) {
    if (timer) clearInterval(timer); timer = null;
    if (pill) pill.remove(); pill = null;
    if (error) toast("Clip: " + error, 4000);
    else toast("Clip saved — opening the editor…", 2600);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "SV_CLIP_RECORDING") return;
    if (msg.on) show(); else hide(msg.error);
  });
})();
