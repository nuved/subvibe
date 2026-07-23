// SubVibe — Dub Mode: speaks the translated sentence-groups over the ducked
// original soundtrack. Runs entirely in the content script; the OpenAI call and
// the audio cache live in the worker (the user's BYOK secret never enters this
// page-reachable context — audio arrives as base64, MV3 messages being JSON).
(function () {
  "use strict";

  let hooks = null;          // from common.js attach(): { base, target, getVideo, playhead, live, cues, site, persist }
  let dubOn = false;
  let conf = { voice: "marin", multi: false, duck: 0.25 };
  let ctx = null, master = null;
  let buffers = new Map();   // group startMs → decoded AudioBuffer (playback window only)
  let pending = new Set();   // group startMs with a speech request in flight
  let playing = new Map();   // group startMs → { src, gain, spkId }
  let elig = [];             // eligible groups, refreshed 1×/s by the pump
  let raf = 0, pumpIv = 0;
  let ducked = false, baseVol = 1, ourWrite = false, volEl = null;
  let lastT = -1;
  let genAll = null;         // { phase, total, done, cancelled } while generating everything
  let ctaEl = null;

  const V = () => globalThis.SV_VOICES;
  const gStart = (g) => g.cues[0].startMs;
  const spanMs = (g) => {
    const last = g.cues[g.cues.length - 1];
    return Math.max(600, (last.endMs || last.startMs + 2500) - g.cues[0].startMs);
  };
  const vcfg = () => (conf.multi ? "mv" : "sv") + "-" + conf.voice;
  const audioKey = (g) => `${hooks.base}:dub:${vcfg()}#${gStart(g)}`;

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) =>
          resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r));
      } catch (e) { resolve({ error: String((e && e.message) || e) }); }
    });
  }
  function bufFromB64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  // Every closed, translated sentence-group is one dub unit (one utterance).
  function eligibleGroups() {
    const seen = new Set(), out = [];
    for (const c of hooks.cues) {
      const g = c.grp;
      if (!g || seen.has(g)) continue;
      seen.add(g);
      if (g.closed && g.t[hooks.target]) out.push(g);
    }
    return out; // cues are sorted by startMs, so groups come out sorted too
  }

  // ── audio graph + autoplay CTA ──────────────────────────────────────────
  function ensureCtx() {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") {
      // Autoplay policy: the popup toggle is a gesture in the POPUP, not this
      // page. resume() usually works (the user has interacted with the video);
      // when it doesn't, one real click on the overlay CTA fixes it for good.
      ctx.resume().catch(() => {});
      setTimeout(() => { if (ctx && ctx.state === "suspended" && dubOn) showCta(); }, 300);
    }
    return ctx;
  }
  function showCta() {
    const overlay = document.getElementById("copilot-subs");
    if (!overlay || ctaEl) return;
    ctaEl = document.createElement("button");
    ctaEl.className = "copilot-subs__cta";
    ctaEl.textContent = "▶ Start dubbing";
    ctaEl.onclick = () => { if (ctx) ctx.resume().catch(() => {}); hideCta(); };
    overlay.appendChild(ctaEl);
  }
  function hideCta() { if (ctaEl) { ctaEl.remove(); ctaEl = null; } }

  // ── ducking (video.volume, site slider stays functional) ────────────────
  function setVol(v, x) {
    ourWrite = true;
    try { v.volume = Math.max(0, Math.min(1, x)); } catch {}
    setTimeout(() => { ourWrite = false; }, 0);
  }
  function onVolumeChange(e) {
    if (ourWrite || !ducked) return;
    // The user moved the SITE's slider while ducked: what they set IS the new
    // ducked level — re-derive the base so disabling restores what they expect.
    baseVol = conf.duck > 0 ? Math.min(1, e.target.volume / conf.duck) : e.target.volume;
  }
  function bindVolEl(v) {
    if (v === volEl) return;
    if (volEl) {
      volEl.removeEventListener("volumechange", onVolumeChange);
      if (ducked) setVol(volEl, baseVol); // the old element un-ducks
    }
    volEl = v || null;
    if (volEl) {
      volEl.addEventListener("volumechange", onVolumeChange);
      if (ducked) setVol(volEl, baseVol * conf.duck); // keep the swapped-in one ducked
    }
  }
  function duck(on) {
    const v = hooks && hooks.getVideo();
    bindVolEl(v);
    if (!volEl) return;
    if (on && !ducked) { baseVol = volEl.volume; ducked = true; setVol(volEl, baseVol * conf.duck); }
    else if (!on && ducked) { ducked = false; setVol(volEl, baseVol); }
    else if (on && ducked) setVol(volEl, baseVol * conf.duck); // live duck-level change
  }

  // ── look-ahead pump: speech for the next ~60s, 2 in flight, 1 Hz ────────
  async function fetchOne(g, decode = true) {
    const k = gStart(g);
    pending.add(k);
    try {
      const txt = g.t[hooks.target];
      const resp = await send({
        type: "TTS", key: audioKey(g), text: txt,
        voice: V().voiceForSpeaker(g.spk, conf.voice, conf.multi),
        instructions: V().ttsInstructions(txt, hooks.target),
        durMs: spanMs(g), site: hooks.site, title: document.title, target: hooks.target,
      });
      if (resp && resp.b64) {
        // decode=false (full pre-generate) only warms the worker's cache — a
        // whole film decoded to Float32 would be hundreds of MB of RAM.
        if (decode && dubOn) buffers.set(k, await ensureCtx().decodeAudioData(bufFromB64(resp.b64)));
      } else if (resp && resp.error) console.warn("[SubVibe dub] speech:", resp.error);
    } catch (e) { console.warn("[SubVibe dub] speech:", e && e.message); }
    finally { pending.delete(k); }
  }
  function pump() {
    if (!dubOn || !hooks || (hooks.live && hooks.live())) return;
    elig = eligibleGroups();
    const v = hooks.getVideo();
    if (!v || v.ended) return;
    if (v.paused && !(v.currentTime > 0.5)) return; // never spend on a video never started
    const t = hooks.playhead();
    for (const k of buffers.keys()) if (k < t - 30000 || k > t + 90000) buffers.delete(k); // bound RAM
    if (pending.size >= 2) return;
    for (const g of elig) {
      const s = gStart(g);
      if (s < t - 2000) continue;
      if (s > t + 60000) break;
      if (buffers.has(s) || pending.has(s)) continue;
      fetchOne(g);
      if (pending.size >= 2) break;
    }
  }

  // ── playback ────────────────────────────────────────────────────────────
  function stopOne(k, p, fadeMs) {
    playing.delete(k);
    try {
      if (fadeMs && ctx) {
        p.gain.gain.setTargetAtTime(0, ctx.currentTime, fadeMs / 3000);
        p.src.stop(ctx.currentTime + fadeMs / 1000);
      } else p.src.stop();
    } catch {}
  }
  function stopAll(fadeMs) { for (const [k, p] of [...playing]) stopOne(k, p, fadeMs); }

  function startClip(g, s, buf, t, v) {
    const c = ensureCtx();
    if (c.state === "suspended") return; // CTA showing — don't queue silent sources
    // The same speaker can't talk over themselves: fast-fade their previous
    // clip. Different speakers may briefly overlap, like a real dub track.
    const spkId = (g.spk && g.spk.id) || 0;
    for (const [k, p] of [...playing]) if (p.spkId === spkId) stopOne(k, p, 150);
    const fit = Math.max(1, (buf.duration * 1000) / spanMs(g)); // squeeze overlong clips…
    const rate = Math.min(1.15, fit) * (v.playbackRate || 1);   // …but never chipmunk past 1.15×
    const offset = ((t - s) / 1000) * rate;                     // landing mid-line (seek) starts mid-clip
    if (offset >= buf.duration - 0.05) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const gain = c.createGain();
    src.connect(gain);
    gain.connect(master);
    const p = { src, gain, spkId };
    playing.set(s, p);
    src.onended = () => { if (playing.get(s) === p) playing.delete(s); };
    src.start(0, Math.max(0, offset));
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    if (!dubOn || !hooks) return;
    const v = hooks.getVideo();
    if (!v) return;
    duck(true); // re-assert each frame: element swaps, late loads
    if (v.paused || v.ended) { if (playing.size) stopAll(0); lastT = hooks.playhead(); return; }
    const t = hooks.playhead();
    if (lastT >= 0 && Math.abs(t - lastT) > 1500) stopAll(0); // seek — kill mid-air clips
    lastT = t;
    for (const g of elig) {
      const s = gStart(g);
      if (s > t + 120) break;
      if (t > s + spanMs(g) + 400) continue;
      if (playing.has(s)) continue;
      const buf = buffers.get(s);
      if (buf) startClip(g, s, buf, t, v);
    }
  }

  // ── enable/disable + lifecycle ──────────────────────────────────────────
  function setDubOn(on) {
    dubOn = !!on;
    if (dubOn) {
      if (hooks) { ensureCtx(); duck(true); }
      if (!pumpIv) pumpIv = setInterval(pump, 1000);
      if (!raf) raf = requestAnimationFrame(loop);
    } else {
      stopAll(0);
      duck(false);
      hideCta();
      clearInterval(pumpIv); pumpIv = 0;
      cancelAnimationFrame(raf); raf = 0;
      lastT = -1;
    }
  }

  function attach(h) {
    hooks = h;
    buffers.clear(); pending.clear(); elig = [];
    stopAll(0);
    lastT = -1;
    if (dubOn) { ensureCtx(); duck(true); if (!pumpIv) pumpIv = setInterval(pump, 1000); if (!raf) raf = requestAnimationFrame(loop); }
  }
  function detach() {
    stopAll(0);
    if (ducked && volEl) { ducked = false; setVol(volEl, baseVol); }
    bindVolEl(null);
    hideCta();
    hooks = null;
    buffers.clear(); pending.clear(); elig = [];
  }

  // ── status for the popup ────────────────────────────────────────────────
  async function status() {
    if (!hooks) return { attached: false, enabled: dubOn };
    const live = !!(hooks.live && hooks.live());
    const groups = eligibleGroups();
    const totalMs = groups.reduce((a, g) => a + spanMs(g), 0);
    let cachedMs = 0;
    const r = await send({ type: "AUDIO_KEYS", prefix: `${hooks.base}:dub:${vcfg()}#` });
    if (r && r.keys) cachedMs = r.keys.reduce((a, k) => a + (k.ms || 0), 0);
    return {
      attached: true, enabled: dubOn, live,
      groups: groups.length, totalMs, cachedMs,
      cachedPct: totalMs ? Math.min(1, cachedMs / totalMs) : 0,
      estRemainingUSD: V().dubEstimateUSD(Math.max(0, totalMs - cachedMs)),
      generating: genAll ? { phase: genAll.phase, total: genAll.total, done: genAll.done } : null,
    };
  }

  // Filled in by the "generate full dub" task.
  function generateAll() {}
  function cancelGenerate() { if (genAll) genAll.cancelled = true; }

  // ── settings + messages ─────────────────────────────────────────────────
  chrome.storage.local.get(["dubEnabled", "dubVoice", "dubMultiVoice", "dubDuckLevel"]).then((s) => {
    conf.voice = s.dubVoice || conf.voice;
    conf.multi = !!s.dubMultiVoice;
    if (typeof s.dubDuckLevel === "number") conf.duck = s.dubDuckLevel;
    if (s.dubEnabled) setDubOn(true);
  }).catch(() => {});

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.dubVoice || ch.dubMultiVoice) {
      if (ch.dubVoice) conf.voice = ch.dubVoice.newValue || "marin";
      if (ch.dubMultiVoice) conf.multi = !!ch.dubMultiVoice.newValue;
      buffers.clear(); // a different voice config is a different cache namespace
    }
    if (ch.dubDuckLevel) {
      conf.duck = typeof ch.dubDuckLevel.newValue === "number" ? ch.dubDuckLevel.newValue : 0.25;
      if (ducked) duck(true);
    }
    if (ch.dubEnabled) setDubOn(!!ch.dubEnabled.newValue);
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "DUB_STATUS") { status().then(sendResponse); return true; }
    if (msg.type === "DUB_GENERATE_ALL") { generateAll(); sendResponse({ ok: true }); return; }
    if (msg.type === "DUB_CANCEL") { cancelGenerate(); sendResponse({ ok: true }); return; }
  });

  window.__svDub = { attach, detach, status, generateAll: () => generateAll(), cancelGenerate };
})();
