// SubVibe — Dub Mode: speaks the translated sentence-groups over the ducked
// original soundtrack. Runs entirely in the content script; the OpenAI call and
// the audio cache live in the worker (the user's BYOK secret never enters this
// page-reachable context — audio arrives as base64, MV3 messages being JSON).
(function () {
  "use strict";

  let hooks = null;          // from common.js attach(): { base, target, getVideo, playhead, live, cues, site, persist }
  let dubOn = false;
  let conf = { voice: "marin", multi: false, duck: 0.12 };
  let ctx = null, master = null;
  let buffers = new Map();   // group startMs → decoded AudioBuffer (playback window only)
  let pending = new Set();   // group startMs with a speech request in flight
  let playing = new Map();   // group startMs → { src, gain, voice }
  let elig = [];             // eligible groups, refreshed 1×/s by the pump
  let raf = 0, pumpIv = 0;
  let ducked = false, baseVol = 1, volEl = null;
  let lastT = -1;
  let lastSetVol = -1;       // last value WE wrote to volEl.volume, for self-write detection
  let genAll = null;         // { phase, total, done, cancelled } while generating everything
  let genErr = null;         // last generateAll() failure message, surfaced by the popup

  // ── consent-gated transport (session-local per attach, not persisted) ────
  // A fresh video must not spend a cent until the user clicks the on-player
  // button once; a video with any cached dub audio auto-starts (replay is
  // free). transportPaused gates BOTH the pump (no TTS requests) and the loop
  // (no clip starts); the duck releases while paused.
  let transportPaused = true;
  let lastPct = 0, lastRemainUSD = 0; // last coverage snapshot, painted on the button
  let dubctlEl = null;

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
      if (g.closed && g.t[hooks.target] && !V().isNonSpeechCaption(g.orig)) out.push(g);
    }
    return out; // cues are sorted by startMs, so groups come out sorted too
  }

  // ── audio graph ──────────────────────────────────────────────────────────
  function ensureCtx() {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") {
      // Autoplay policy: resume() needs a real page gesture. The transport
      // button's click IS that gesture — ensureCtx() is called from its onclick
      // handler, so this resolves synchronously with the click most of the time.
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  // ── ducking (video.volume, site slider stays functional) ────────────────
  function setVol(v, x) {
    const clamped = Math.max(0, Math.min(1, x));
    lastSetVol = clamped;
    try { v.volume = clamped; } catch {}
  }
  function onVolumeChange(e) {
    // volumechange fires as an async task; its ordering vs a 0ms timer is not
    // guaranteed, so a timing-based "was this our write" flag can read stale.
    // Detect by value instead: if this echoes what we just wrote, ignore it.
    if (Math.abs(e.target.volume - lastSetVol) < 0.001) return;
    if (!ducked) return;
    // The user moved the SITE's slider while ducked: what they set IS the new
    // ducked level — re-derive the base so disabling restores what they expect.
    // At duck≈0 a user write can't be meaningfully inverted back to a base
    // (division blows up / loses information), so keep the previous base.
    baseVol = conf.duck > 0.01 ? Math.min(1, e.target.volume / conf.duck) : baseVol;
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
  let pumpTicks = 0;
  function pump() {
    if (!dubOn || !hooks || (hooks.live && hooks.live())) return;
    elig = eligibleGroups();
    pumpTicks++;
    if (pumpTicks % 5 === 0) refreshCoverage().then(paintTransport);
    if (transportPaused) return; // hard gate: no TTS requests until the user clicks
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
    if (c.state === "suspended") return; // transport paused — don't queue silent sources
    // Overlap must key on the VOICE, not the speaker id: in single-voice mode
    // every speaker shares one voice, so speaker-keyed fading let the SAME voice
    // play over itself (the "noisy" chaos live listening flagged). Fast-fade any
    // playing clip whose voice matches this one; different voices may briefly
    // overlap, like a real dub track.
    const voice = V().voiceForSpeaker(g.spk, conf.voice, conf.multi);
    for (const [k, p] of [...playing]) if (p.voice === voice) stopOne(k, p, 150);
    // Rate: a small overrun (≤8%) plays at natural speed and simply trails past
    // the cue's end rather than speeding up — only a bigger overrun gets sped up,
    // and never past 1.1× (was 1.15×; live listening called that "chipmunky").
    const fit = (buf.duration * 1000) / spanMs(g);
    const rate = (fit <= 1.08 ? 1.0 : Math.min(1.1, fit)) * (v.playbackRate || 1);
    const offset = ((t - s) / 1000) * rate;                     // landing mid-line (seek) starts mid-clip
    if (offset >= buf.duration - 0.05) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const gain = c.createGain();
    src.connect(gain);
    gain.connect(master);
    const p = { src, gain, voice };
    playing.set(s, p);
    src.onended = () => { if (playing.get(s) === p) playing.delete(s); };
    src.start(0, Math.max(0, offset));
  }

  // ── consent-gated transport button ──────────────────────────────────────
  // Coverage snapshot (like status() computes for the popup, but kept local so
  // painting the button doesn't need a round trip through the popup).
  async function refreshCoverage() {
    if (!hooks) return;
    const totalMs = elig.reduce((a, g) => a + spanMs(g), 0);
    let cachedMs = 0;
    const r = await send({ type: "AUDIO_KEYS", prefix: `${hooks.base}:dub:${vcfg()}#` });
    if (r && r.keys) cachedMs = r.keys.reduce((a, k) => a + (k.ms || 0), 0);
    lastPct = totalMs ? Math.min(1, cachedMs / totalMs) : 0;
    lastRemainUSD = V().dubEstimateUSD(Math.max(0, totalMs - cachedMs));
  }

  function paintTransport() {
    const overlay = document.getElementById("copilot-subs");
    if (!dubOn || !hooks) { if (dubctlEl) { dubctlEl.remove(); dubctlEl = null; } return; }
    if (!overlay) return;
    if (!dubctlEl) {
      dubctlEl = document.createElement("button");
      dubctlEl.className = "copilot-subs__dubctl";
      dubctlEl.onclick = onTransportClick;
      overlay.appendChild(dubctlEl);
    }
    const pct = Math.round(lastPct * 100);
    let label;
    if (!transportPaused) label = `⏸ dub · ${pct}%`;
    else if (lastPct > 0) label = `▶ dub · ${pct}% ready (~$${lastRemainUSD.toFixed(2)} more)`;
    else label = `▶ Start dub (~$${lastRemainUSD.toFixed(2)})`;
    dubctlEl.textContent = label;
  }

  function onTransportClick() {
    transportPaused = !transportPaused;
    if (!transportPaused) { ensureCtx(); duck(true); }
    else { stopAll(150); duck(false); }
    paintTransport();
  }

  // How many upcoming clips (within the next ~60s window) are already decoded
  // and ready to play right now — the badge's dub-readiness counter.
  function readyAhead() {
    if (!hooks || !dubOn) return 0;
    const t = hooks.playhead();
    let n = 0;
    for (const g of elig) { const s = gStart(g); if (s > t + 60000) break; if (s >= t - 500 && buffers.has(s)) n++; }
    return n;
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    if (!dubOn || !hooks) return;
    // If the AudioContext is found suspended while we supposedly aren't paused,
    // the resume silently failed (or never happened) — flip back to paused so
    // the button honestly asks for the one click it needs, instead of quietly
    // doing nothing forever.
    if (ctx && ctx.state === "suspended" && !transportPaused) { transportPaused = true; paintTransport(); }
    const v = hooks.getVideo();
    if (!v) return;
    if (transportPaused) { duck(false); if (playing.size) stopAll(0); return; } // hard gate: no clip starts while paused
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
      if (hooks && !transportPaused) { ensureCtx(); duck(true); }
      if (!pumpIv) pumpIv = setInterval(pump, 1000);
      if (!raf) raf = requestAnimationFrame(loop);
      paintTransport();
    } else {
      stopAll(0);
      duck(false);
      if (dubctlEl) { dubctlEl.remove(); dubctlEl = null; }
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
    // A fresh video must not spend a cent until the user clicks the transport
    // button; a video with any cached dub audio auto-starts (replay is free).
    transportPaused = true;
    elig = eligibleGroups();
    paintTransport(); // show the paused button immediately; refreshed below once coverage is known
    refreshCoverage().then(() => {
      if (lastPct > 0) {
        transportPaused = false;
        if (dubOn) { ensureCtx(); duck(true); } // auto-start: create/resume the ctx now coverage is known
      }
      paintTransport();
    });
    if (dubOn) {
      if (!pumpIv) pumpIv = setInterval(pump, 1000);
      if (!raf) raf = requestAnimationFrame(loop);
    }
  }
  function detach() {
    stopAll(0);
    if (ducked && volEl) { ducked = false; setVol(volEl, baseVol); }
    bindVolEl(null);
    if (dubctlEl) { dubctlEl.remove(); dubctlEl = null; }
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
      lastError: genErr,
    };
  }

  // Generate the WHOLE video's dub up front (the popup shows the estimate and
  // the user explicitly clicked): first translate every still-untranslated
  // sentence group, then request speech for every group. Speech requests use
  // decode=false — they warm the worker's cache; playback decodes on demand.
  async function generateAll() {
    if (!hooks || genAll || (hooks.live && hooks.live())) return;
    const all = [];
    const seen = new Set();
    for (const c of hooks.cues) {
      const g = c.grp;
      if (g && g.closed && !seen.has(g)) { seen.add(g); all.push(g); }
    }
    const untranslated = all.filter((g) => !g.t[hooks.target]);
    genAll = { phase: "translating", total: untranslated.length, done: 0, cancelled: false };
    genErr = null;
    try {
      for (let i = 0; i < untranslated.length && !genAll.cancelled; i += 40) {
        const batch = untranslated.slice(i, i + 40);
        const resp = await send({ type: "TRANSLATE", cues: batch.map((g) => g.orig), source: "auto", target: hooks.target, site: hooks.site, title: document.title });
        if (!resp || resp.error || !resp.lines) {
          genErr = (resp && resp.error) || "translation failed";
          console.warn("[SubVibe dub] generate:", genErr);
          return; // status() stops reporting "generating"; the pump keeps working incrementally
        }
        batch.forEach((g, k) => {
          if (!resp.lines[k]) return;
          g.t[hooks.target] = resp.lines[k];
          g.spk = { id: (resp.spk && resp.spk[k]) || 0, g: (resp.gen && resp.gen[k]) || "?" };
          for (const cc of g.cues) { cc.t[hooks.target] = resp.lines[k]; cc.spk = g.spk; }
        });
        genAll.done += batch.length;
        if (hooks.persist) hooks.persist();
      }
      if (genAll.cancelled) return;
      const ready = all.filter((g) => g.t[hooks.target]);
      genAll = { phase: "speaking", total: ready.length, done: 0, cancelled: false };
      for (const g of ready) {
        if (genAll.cancelled) break;
        if (!buffers.has(gStart(g))) await fetchOne(g, false); // cached rows return instantly, free
        genAll.done++;
      }
    } finally { genAll = null; }
  }
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
      conf.duck = typeof ch.dubDuckLevel.newValue === "number" ? ch.dubDuckLevel.newValue : 0.12;
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

  window.__svDub = { attach, detach, status, generateAll: () => generateAll(), cancelGenerate, readyAhead };
})();
