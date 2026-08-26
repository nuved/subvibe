// offscreen-clip.js — records the whole tab (video + audio) via tabCapture, so a
// Clip is WYSIWYG: the real subtitle overlay in its real style, and the audio
// the viewer actually hears (original OR dub). A service worker can't do
// getUserMedia; this hidden document can. Driven by background messages.
// The recorded WebM is stored in IndexedDB "clips" (extension origin) and the
// Clip editor (clip.html) reads it there. Spec: docs/superpowers/specs/2026-08-26-clip-design.md
(function () {
  let stream = null, rec = null, chunks = [], ac = null, passSrc = null, passGain = null;
  let startedAt = 0, meta = null;

  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("copilot-subs", 5);
      req.onupgradeneeded = () => { const d = req.result; for (const s of ["tracks", "audio", "vocab", "shots", "clips"]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
  }
  async function saveClip(record) {
    const d = await idb();
    await new Promise((res, rej) => { const r = d.transaction("clips", "readwrite").objectStore("clips").put(record, record.id); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
  }
  const newId = () => Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

  function cleanup() {
    try { if (rec && rec.state !== "inactive") rec.stop(); } catch (e) {}
    rec = null;
    try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    stream = null;
    try { if (passSrc) passSrc.disconnect(); } catch (e) {}
    try { if (passGain) passGain.disconnect(); } catch (e) {}
    try { if (ac) ac.close(); } catch (e) {}
    ac = passSrc = passGain = null;
  }

  async function start(msg) {
    if (rec) return;
    meta = msg.meta || {};
    let s;
    try {
      s = await Promise.race([
        navigator.mediaDevices.getUserMedia({
          audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: msg.streamId } },
          video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: msg.streamId } },
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("tab stream didn't open in 8s — the browser may block tab capture")), 8000)),
      ]);
    } catch (e) { chrome.runtime.sendMessage({ type: "CLIP_REC_ERROR", error: (e && e.message) || String(e) }); return; }
    stream = s;
    // tabCapture mutes the tab for the user — route the captured audio back to
    // the speakers so they keep hearing the video while it records.
    try {
      ac = new AudioContext();
      passSrc = ac.createMediaStreamSource(s);
      passGain = ac.createGain(); passGain.gain.value = 1;
      passSrc.connect(passGain).connect(ac.destination);
    } catch (e) { /* passthrough is a nicety; recording still works without it */ }
    const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
    chunks = [];
    try { rec = new MediaRecorder(s, mime ? { mimeType: mime } : undefined); }
    catch (e) { chrome.runtime.sendMessage({ type: "CLIP_REC_ERROR", error: "recorder: " + ((e && e.message) || e) }); cleanup(); return; }
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = onStop;
    startedAt = performance.now();
    rec.start(1000); // 1s timeslice keeps chunks flowing (and duration saner)
    const vt = s.getVideoTracks()[0], st = (vt && vt.getSettings && vt.getSettings()) || {};
    chrome.runtime.sendMessage({ type: "CLIP_REC_STARTED", w: st.width || 0, h: st.height || 0 });
  }

  async function onStop() {
    const durationMs = Math.round(performance.now() - startedAt);
    const mime = (rec && rec.mimeType) || "video/webm";
    const vt = stream && stream.getVideoTracks()[0], st = (vt && vt.getSettings && vt.getSettings()) || {};
    const blob = new Blob(chunks, { type: mime.split(";")[0] || "video/webm" });
    cleanup();
    if (!blob.size) { chrome.runtime.sendMessage({ type: "CLIP_REC_ERROR", error: "empty recording — keep the tab in front while recording" }); return; }
    const record = {
      id: newId(), ts: Date.now(), blob, mime, durationMs,
      w: st.width || 0, h: st.height || 0,
      title: meta.title || "", url: meta.url || "", host: meta.host || "", target: meta.target || "",
    };
    try { await saveClip(record); }
    catch (e) { chrome.runtime.sendMessage({ type: "CLIP_REC_ERROR", error: "store: " + ((e && e.message) || e) }); return; }
    chrome.runtime.sendMessage({ type: "CLIP_REC_SAVED", id: record.id, durationMs, size: blob.size });
  }

  function stop() { try { if (rec && rec.state !== "inactive") rec.stop(); } catch (e) {} }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "CLIP_REC_PING") { sendResponse({ pong: true }); return; }
    if (msg.type === "CLIP_REC_START") { start(msg); sendResponse({ ok: true }); return; }
    if (msg.type === "CLIP_REC_STOP") { stop(); sendResponse({ ok: true }); return; }
  });
})();
