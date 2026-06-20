// ─────────────────────────────────────────────────────────────────────────────
//  Dedicated, with love, to the memory of my father — Agha Mansoor (آقا منصور).
//  He taught me to stay curious and gave me the room to discover; this engine,
//  and everything it became, grew from that. Tap the popup logo three times, or
//  run  subvibe.remember()  in the console, to see him.
// ─────────────────────────────────────────────────────────────────────────────
// SubVibe — content-script engine (site-agnostic).
//
// Two adapter shapes:
//   • "track"  (YouTube): fetch the full caption track up front, translate &
//     cache per language, render time-synced.
//   • "stream" (Netflix, DRM): read the site's own on-screen captions live,
//     translate each line, cache & sync per video.currentTime.
// Source language is auto-detected; targets come from settings; multiple targets
// stack as multiple lines (plus an optional original line for dual subtitles).

(function () {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    targets: ["en"],     // one or more languages to show (multiple subtitles)
    showOriginal: true,  // also show the original spoken line (dual subtitles) — also
                         // means there's always a line to show even before a key is added
    hideNative: true,    // hide the site's own captions to avoid duplicates by default
                         // (SubVibe re-renders the same line, so the native one is redundant)
    position: "bottom",  // bottom | top | auto | custom (user-dragged)
    linePositions: {},   // custom mode: slot key ("__orig"|lang) → {x,y} fraction (per-segment)
    size: "md",          // sm | md | lg | xl
    syncOffset: 0,       // seconds; + shows subtitles earlier, − later
    audioFallback: false, // transcribe audio ONLY when a video has no captions
    audioDeviceId: "",    // chosen input device (e.g. BlackHole)
  };

  const LANG_LABEL = {
    fa: "Persian", de: "German", en: "English", fr: "French", es: "Spanish",
    it: "Italian", pt: "Portuguese", ja: "Japanese", ko: "Korean", ru: "Russian",
    hi: "Hindi", ar: "Arabic", tr: "Turkish", zh: "Chinese", nl: "Dutch",
    pl: "Polish", sv: "Swedish", uk: "Ukrainian",
  };
  const langLabel = (c) => LANG_LABEL[c] || LANG_LABEL[(c || "").split("-")[0]] || c;

  // ─── small helpers ─────────────────────────────────────────────────────────

  const sameLang = (a, b) =>
    (a || "").split("-")[0].toLowerCase() === (b || "").split("-")[0].toLowerCase();

  // Hebrew, Arabic (+ supplement/extended), and Arabic presentation forms.
  const isRTL = (s) => /[֐-ࣿיִ-﷿ﹰ-ﻼ]/.test(s || "");
  // Set direction by the LINE's language, not just its text — a Persian line that
  // happens to start with a kept-in-original Latin name (e.g. "MySQL را…") must
  // still flow RTL. CSS `unicode-bidi: isolate` then renders the Latin run correctly.
  const RTL_LANGS = new Set(["fa", "ar", "he", "ur", "ps", "ug", "sd", "yi", "dv"]);
  const isRTLLang = (c) => RTL_LANGS.has((c || "").split("-")[0]);
  let lastCacheBase = null; // cache key prefix of the clip now playing (for "clear this video")

  // When the extension is reloaded/updated, content scripts already running in
  // open tabs are ORPHANED: chrome.runtime is gone, so chrome.runtime.sendMessage
  // throws "Cannot read properties of undefined (reading 'sendMessage')". Detect
  // that and halt this stale script quietly (with a refresh hint) instead of
  // spamming "Translation failed" on every pump tick.
  let contextDead = false;
  function haltOrphaned() {
    if (streamCleanup) { try { streamCleanup(); } catch {} streamCleanup = null; }
    try { cancelAnimationFrame(rafId); } catch {}
    try { cancelAnimationFrame(audioRaf); } catch {}
    const el = document.getElementById("copilot-subs");
    const s = el && el.querySelector(".copilot-subs__status");
    if (s) { s.textContent = "SubVibe was updated — refresh this tab to continue."; s.classList.add("show"); }
  }
  function extAlive() {
    if (contextDead) return false;
    try { if (chrome.runtime && chrome.runtime.id) return true; } catch {}
    contextDead = true;
    try { haltOrphaned(); } catch {}
    return false;
  }

  // True when an error means this content script was orphaned by an extension
  // reload/update (so we should halt quietly with a refresh hint, not surface a
  // "Translation failed"). Netflix kept hitting this via the callback path below.
  const isOrphanError = (m) => /context invalidated|Extension context|reading 'sendMessage'/i.test(m || "");
  function send(msg) {
    return new Promise((resolve) => {
      if (!extAlive()) { resolve({ error: "SubVibe was reloaded — refresh the tab.", dead: true }); return; }
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          const le = chrome.runtime.lastError;
          if (le) {
            const m = le.message || "messaging error";
            const dead = isOrphanError(m);
            if (dead) { contextDead = true; try { haltOrphaned(); } catch {} }
            resolve({ error: dead ? "SubVibe was reloaded — refresh the tab." : m, dead });
          } else resolve(resp);
        });
      } catch (e) {
        const m = String((e && e.message) || e);
        const dead = isOrphanError(m);
        if (dead) { contextDead = true; try { haltOrphaned(); } catch {} }
        resolve({ error: dead ? "SubVibe was reloaded — refresh the tab." : m, dead });
      }
    });
  }

  // Per-clip settings: each captured video keeps its OWN targets / position / size /
  // sync / line-layout, keyed by the SAME stable id as its cache (clipBaseId). The
  // flat storage keys are the GLOBAL DEFAULTS a new clip starts from; clipOverrides[base]
  // layers this clip's own changes on top — so a tweak on one video (or live channel)
  // never bleeds onto another. sync defaults to 0 per clip.
  async function getSettings() {
    const s = await chrome.storage.local.get(["enabled", "targets", "showOriginal", "hideNative", "position", "linePositions", "size", "syncOffset", "audioFallback", "audioDeviceId", "clipOverrides"]);
    const { clipOverrides, ...flat } = s;
    const ov = (clipOverrides && clipOverrides[clipBaseId()]) || {};
    return { ...DEFAULTS, ...flat, ...ov };
  }

  function pickAdapter() {
    const list = window.__copilotAdapters || [];
    return list.find((a) => a.matches && a.matches()) || null;
  }

  // The site's player (e.g. DW's video.js) can REPLACE the <video> element when
  // playback starts, leaving a captured reference frozen at 0:00. Re-resolve the
  // live element each frame (the adapter tracks whichever one is actually playing).
  // DW's MSE element can report currentTime ~0 to us even while it plays. But the
  // site's OWN caption track is correctly synced — the start time of its active
  // cue is a reliable playhead. Scan every video's text tracks for it.
  function nativePlayheadMs() {
    let best = null;
    for (const v of document.querySelectorAll("video")) {
      const tts = v.textTracks;
      if (!tts) continue;
      for (let i = 0; i < tts.length; i++) {
        const tt = tts[i];
        if (tt.kind && tt.kind !== "subtitles" && tt.kind !== "captions") continue;
        if (tt.mode === "disabled") { try { tt.mode = "hidden"; } catch {} continue; } // load activeCues without rendering
        const ac = tt.activeCues;
        if (ac && ac.length) {
          const s = (ac[ac.length - 1].startTime || 0) * 1000;
          if (best == null || s > best) best = s;
        }
      }
    }
    return best;
  }

  // The single source of truth for the playhead (ms): the <video>'s own
  // currentTime, then the page-world relayed clock (MSE players read ~0 in our
  // isolated world), then the site's own active-caption timing. Used by BOTH the
  // render tick AND the pre-translation pump so they always agree.
  function playheadMs(v) {
    let t = (v && v.currentTime || 0) * 1000;
    if (t < 50) {
      if (mainClockMs != null && (mainClockPaused || performance.now() - mainClockAt < 1500)) {
        t = mainClockMs + (mainClockPaused ? 0 : Math.min(1500, performance.now() - mainClockAt));
      } else {
        const n = nativePlayheadMs();
        if (n != null) t = n;
      }
    }
    return t;
  }

  function liveVideoEl(fallback) {
    // Best-effort pick of the element being watched. NOTE: on MSE players the
    // isolated content-script world can't read live media state, so the real
    // playhead comes from the page-world clock relay (mainClockMs), not here.
    const vids = [...document.querySelectorAll("video")];
    const playing = vids.filter((v) => !v.paused && !v.ended);
    // Prefer the LARGEST playing video — the main content. Picking the furthest-
    // along one let a small ad / hover-preview video (with a totally different
    // time) hijack the playhead, flipping the shown cue on/off → a fast blink.
    if (playing.length) return playing.reduce((a, b) => ((b.clientWidth * b.clientHeight) > (a.clientWidth * a.clientHeight) ? b : a));
    const a = adapter && adapter.getVideoEl && adapter.getVideoEl();
    return (a && a.isConnected) ? a : fallback;
  }

  function waitFor(fn, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const t = setInterval(() => {
        let v = null;
        try { v = fn(); } catch { v = null; }
        if (v || Date.now() - start > timeoutMs) { clearInterval(t); resolve(v); }
      }, 200);
    });
  }

  function debounce(fn, ms) {
    let h;
    return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
  }

  // Binary search: index of the cue whose [startMs,endMs) contains t, else -1.
  function findCue(cues, t) {
    let lo = 0, hi = cues.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].startMs <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (ans >= 0 && t < cues[ans].endMs) return ans;
    return -1;
  }

  // Keep a streaming cue array sorted by startMs.
  function insertCue(cues, cue) {
    let lo = 0, hi = cues.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cues[m].startMs < cue.startMs) lo = m + 1; else hi = m; }
    cues.splice(lo, 0, cue);
    return cue;
  }

  // Active cue for a streaming track, where the on-screen cue may be unclosed.
  function activeStreamCue(cues, t) {
    let lo = 0, hi = cues.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (cues[m].startMs <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    if (ans < 0) return null;
    const c = cues[ans];
    if (c.endMs == null) return t - c.startMs < 15000 ? c : null;
    return t < c.endMs ? c : null;
  }

  // Which cue to SHOW in stream mode. Two fixes over activeStreamCue:
  //  • walks back to the most recent cue whose `target` text is actually ready,
  //    so a line isn't blanked during the translation round-trip, and
  //  • holds each line for a reading-time minimum (so late translations still
  //    get a proper on-screen duration instead of a leftover sliver).
  function streamDisplayCue(cues, t, target) {
    let lo = 0, hi = cues.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (cues[m].startMs <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    for (let i = ans; i >= 0 && t - cues[i].startMs < 10000; i--) {
      const c = cues[i];
      const txt = target ? c.t && c.t[target] : c.original;
      if (!txt) continue; // text for this line not ready yet → keep the previous one
      const end = c.endMs != null ? c.endMs : c.startMs + 4000;
      const minVisible = Math.min(6000, Math.max(1600, String(txt).length * 75));
      const until = Math.max(end, c.startMs + minVisible) + 600;
      return t <= until ? c : null;
    }
    return null;
  }

  // ─── overlay ───────────────────────────────────────────────────────────────

  let adapter = null;
  let rafId = 0;
  let activeLines = [];      // [{ lang, cues, idx, el }]
  let streamCleanup = null;  // stops a streaming (DOM-scrape) source
  let currentRunKey = null;  // dedupes redundant start() calls (event spam)
  let liveOffsetMs = 0;      // manual sync nudge (+ = earlier) — applied to LIVE streams only (recorded titles are exact)
  let liveAutoOffsetMs = 0;  // AUTO sync: shift so our cues coincide with the player's OWN on-screen caption
  let calibAt = 0, calibMatched = false, calibMisses = 0;
  let isLiveStream = false;  // current video is live (duration = Infinity); recorded titles ignore the manual nudge
  const normCue = (s) => (s || "").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
  // Find the site's own caption currently on screen by MATCHING its text to one of
  // our cues, then shift our timeline so that cue shows exactly when the player
  // shows it. This auto-removes the constant live "prefetch" offset (the +7s you had
  // to nudge), and self-corrects to ~0 on recorded titles (already in sync). Bounded
  // (scans only the player container, ≤6000 nodes, stops at the first match) + throttled.
  function autoCalibrate(cues, video) {
    if (!cues || !cues.length) return;
    const now = playheadMs(video);
    const center = now + liveOffsetMs + liveAutoOffsetMs;
    const cand = [];
    for (const c of cues) {
      if (!c.original) continue;
      if (Math.abs(c.startMs - center) > 90000 && Math.abs(c.startMs - now) > 90000) continue;
      const n = normCue(c.original);
      if (n.length >= 14) cand.push([n, c]);
    }
    if (!cand.length) return;
    const ov = document.getElementById("copilot-subs");
    let hit = null, seen = 0;
    const scan = (r) => {
      if (hit || !r || !r.querySelectorAll) return;
      const els = r.querySelectorAll("*");
      for (let i = 0; i < els.length && !hit && seen < 15000; i++) {
        const el = els[i]; seen++;
        if (el.shadowRoot) scan(el.shadowRoot);
        if (hit) break;
        if (ov && ov.contains(el)) continue;
        // Read leaf elements AND elements whose only children are <br> — a player's
        // caption is often ONE element with its lines split by <br> (Prime does this),
        // which the old childElementCount check skipped, so live auto-sync never matched.
        let txt = "", isLeaf = true;
        for (const nd of el.childNodes) {
          if (nd.nodeType === 3) txt += nd.nodeValue;        // text node
          else if (nd.nodeName === "BR") txt += " ";         // <br> → a space, so two-line captions still match
          else { isLeaf = false; break; }                    // a real child element ⇒ a container, skip it
        }
        if (!isLeaf) continue;
        const n = normCue(txt);
        if (n.length < 14) continue;
        for (let k = 0; k < cand.length; k++) {
          const cn = cand[k][0];
          if (n === cn || n.indexOf(cn) >= 0 || cn.indexOf(n) >= 0) { hit = cand[k][1]; break; }
        }
      }
    };
    try { scan(document.body); } catch {} // scan the WHOLE page — the player's caption often lives OUTSIDE its container
    if (!hit) {
      calibMisses++;
      if (calibMatched) { calibMatched = false; console.info("[SubVibe] auto-sync: lost the on-screen caption match"); }
      return;
    }
    calibMisses = 0;
    const want = Math.max(-30000, Math.min(30000, hit.startMs - now)); // gap: our cue's time vs the playhead
    liveAutoOffsetMs = Math.abs(want - liveAutoOffsetMs) < 300 ? want : Math.round(liveAutoOffsetMs + (want - liveAutoOffsetMs) * 0.5);
    if (!calibMatched) { calibMatched = true; console.info("[SubVibe] auto-sync: matched the player's caption → auto offset " + Math.round(liveAutoOffsetMs / 1000) + "s (you can leave the manual shift at 0)"); }
  }
  let autoPosEnabled = false; // auto opposite-positioning vs the site's caption
  let hideNativeOn = false;   // hiding the site's own captions (incl. shadow DOM)
  let interceptedCues = null; // active subtitle cues (the current clip's file)
  let interceptedUrl = null;  // URL those cues came from
  let interceptedClipId = null; // the clip (URL-derived videoId) those cues belong to
  let cueListActive = false;  // perfect-sync cue-list mode is the running engine
  let mainClockMs = null, mainClockAt = 0, mainClockPaused = false; // playhead relayed from the page world
  let mainVideoId = null;     // id of the playing clip, reported from the page world (detects clip switch)
  let audioActive = false;   // live audio-transcription mode is running
  let audioRaf = 0;
  let audioCues = null, audioDefs = [], audioEls = {};

  // Inject the Persian font with ABSOLUTE extension URLs. A relative url() in
  // overlay.css resolves against the page origin (e.g. www.zdf.de/.../fonts/…)
  // and 404s, so Persian falls back to a system font. This fixes that.
  function ensureFont() {
    if (document.getElementById("copilot-font")) return;
    try {
      const reg = chrome.runtime.getURL("fonts/Vazirmatn-Regular.woff2");
      const bold = chrome.runtime.getURL("fonts/Vazirmatn-Bold.woff2");
      const st = document.createElement("style");
      st.id = "copilot-font";
      st.textContent =
        `@font-face{font-family:'Vazirmatn';font-weight:400;font-display:swap;src:url('${reg}') format('woff2');}` +
        `@font-face{font-family:'Vazirmatn';font-weight:700;font-display:swap;src:url('${bold}') format('woff2');}`;
      (document.head || document.documentElement).appendChild(st);
    } catch {}
  }

  function ensureOverlay() {
    ensureFont();
    let el = document.getElementById("copilot-subs");
    if (!el) {
      el = document.createElement("div");
      el.id = "copilot-subs";
      el.innerHTML =
        '<div class="copilot-subs__debug"></div><div class="copilot-subs__status"></div><div class="copilot-subs__stack"></div>';
    }
    const parent = adapter?.getPlayerContainer?.() || document.body;
    if (el.parentElement !== parent) parent.appendChild(el);
    return el;
  }

  function setStatus(text, isError) {
    const el = ensureOverlay();
    el.classList.toggle("copilot-error", !!isError);
    const s = el.querySelector(".copilot-subs__status");
    s.textContent = text || "";
    s.classList.toggle("show", !!text);
    if (text) {
      // Errors linger long enough to read; normal status fades quickly.
      setTimeout(() => { if (s.textContent === text) s.classList.remove("show"); }, isError ? 12000 : 3000);
    }
  }

  // Live look-ahead badge on the toolbar icon (drawn by background.js). Shows how
  // many upcoming lines are already translated ("runway") so you can SEE the
  // pre-translation keeping up — and that reactive sources (Netflix) have none.
  // De-duped by value so identical 1 Hz updates don't spam the worker.
  let lastBadge = "";
  function setBadge(p) {
    const k = JSON.stringify(p);
    if (k === lastBadge) return;
    lastBadge = k;
    send({ type: "LOOKAHEAD", ...p });
  }

  // Live diagnostic badge (top-left). Tells us exactly which pipeline stage
  // fails: reading the on-screen caption, the OpenAI call, or rendering.
  // Diagnostics now go to the console only (F12), not an on-screen badge.
  function dbg(msg) {
    console.debug("[CopilotSubs]", msg);
  }

  function applyHideNative(on) {
    hideNativeOn = on;
    let st = document.getElementById("copilot-hide-native");
    if (on && !st) {
      st = document.createElement("style");
      st.id = "copilot-hide-native";
      st.textContent =
        ".ytp-caption-window-container{opacity:0 !important;} .player-timedtext{opacity:0 !important;} " +
        ".zdfplayer-captions,.zdfplayer-cue-inline,.vjs-text-track-display{opacity:0 !important;} " +
        // Amazon Prime: the rendered caption lives in the OPEN DOM as
        // div.atvwebplayersdk-captions-overlay > … > span.atvwebplayersdk-captions-text.
        // The trailing class (f7j034j, f334kzc, …) is a per-session hash — match the
        // STABLE atvwebplayersdk-captions- prefix instead, and only the -overlay/-text
        // RENDER nodes (not the player's caption MENU buttons).
        "[class*='atvwebplayersdk-captions-overlay'],[class*='atvwebplayersdk-captions-text']{opacity:0 !important;visibility:hidden !important;} " +
        "video::-webkit-media-text-track-container{opacity:0 !important;}";
      document.documentElement.appendChild(st);
    } else if (!on && st) {
      st.remove();
    }
    injectShadowHide();      // ZDF renders captions inside a shadow root
    hideNativeTextTracks();  // DW/others render via the native <track> (::cue)
  }

  // Native <track> captions (DW, and HTML5 video generally) render through the
  // browser's own text-track display, which CSS can't always reach. The surest
  // way to hide them is to switch the track to "hidden" — which keeps its cues
  // loaded for us to read while stopping the browser from drawing them.
  function hideNativeTextTracks() {
    if (!hideNativeOn) return;
    for (const v of document.querySelectorAll("video")) {
      const tts = v.textTracks;
      if (!tts) continue;
      for (let i = 0; i < tts.length; i++) {
        const tt = tts[i];
        const k = tt.kind;
        if ((!k || k === "subtitles" || k === "captions") && tt.mode === "showing") {
          try { tt.mode = "hidden"; } catch {}
        }
      }
    }
  }

  // Document CSS can't reach a shadow DOM, so inject the hide rule into every
  // shadow root (ZDF's <div class="zdfplayer-cue-inline"> lives in one).
  function injectShadowHide() {
    const CSS = ".zdfplayer-cue-inline,.zdfplayer-captions,[class*='cue-inline'],[class*='atvwebplayersdk-captions-overlay'],[class*='atvwebplayersdk-captions-text']{opacity:0 !important;visibility:hidden !important;}";
    const ID = "copilot-shadow-hide";
    const visit = (root, depth) => {
      if (depth > 8) return;
      let nodes;
      try { nodes = root.querySelectorAll("*"); } catch { return; }
      for (const el of nodes) {
        const sr = el.shadowRoot;
        if (!sr) continue;
        const ex = sr.getElementById(ID);
        if (hideNativeOn && !ex) {
          const s = document.createElement("style");
          s.id = ID;
          s.textContent = CSS;
          sr.appendChild(s);
        } else if (!hideNativeOn && ex) {
          ex.remove();
        }
        visit(sr, depth + 1);
      }
    };
    visit(document, 0);
  }

  // Apply position + text-size choices as classes on the overlay container.
  // Scale the subtitle font to the VIDEO's rendered height — NOT the viewport — so
  // it matches the player's own captions whether windowed, theater, or fullscreen.
  // (Viewport-relative vw made the text huge over a small windowed player.)
  const SIZE_FACTORS = { sm: 0.024, md: 0.030, lg: 0.038, xl: 0.048 };
  let appearanceSize = "md";
  function sizeOverlay() {
    const el = document.getElementById("copilot-subs");
    if (!el) return;
    const v = liveVideoEl(adapter && adapter.getVideoEl ? adapter.getVideoEl() : null);
    const h = (v && v.clientHeight) || el.clientHeight || 0;
    if (!h) return;
    const px = Math.max(11, Math.min(50, Math.round(h * (SIZE_FACTORS[appearanceSize] || SIZE_FACTORS.md))));
    el.style.setProperty("--cs-font", px + "px");
  }

  // ── drag-to-place (per segment) ───────────────────────────────────────────────
  // Each subtitle line can be grabbed and dropped anywhere on the video — the
  // original and each translation keep their OWN spot (stored as a fraction of the
  // player rect, so it survives resize/fullscreen). Dragging switches Position to
  // "custom"; picking Bottom/Top/Auto in the popup leaves custom again. Only the
  // text pills are grab handles, so clicks elsewhere still reach the player.
  const clampFrac = (v, d) => (typeof v === "number" && isFinite(v) ? Math.max(0.06, Math.min(0.94, v)) : d);
  let linePositions = {}; // slot key ("__orig" | lang code) → { x, y }
  function defaultSlotPos(idx, total) {
    // un-dragged lines stack near the bottom, in order
    const y = 0.86 - (total - 1 - idx) * 0.085;
    return { x: 0.5, y: Math.max(0.12, Math.min(0.9, y)) };
  }
  function layoutCustomLines() {
    const overlay = document.getElementById("copilot-subs");
    if (!overlay || !overlay.classList.contains("copilot-pos-custom")) return;
    const lines = [...overlay.querySelectorAll(".copilot-subs__line")];
    lines.forEach((ln, i) => {
      const key = ln.dataset.csKey || ("slot" + i);
      const p = linePositions[key] || defaultSlotPos(i, lines.length);
      ln.style.left = (clampFrac(p.x, 0.5) * 100).toFixed(2) + "%";
      ln.style.top = (clampFrac(p.y, 0.85) * 100).toFixed(2) + "%";
    });
  }
  let dragState = null;
  function initDrag(overlay) {
    const stack = overlay.querySelector(".copilot-subs__stack");
    if (!stack || stack._csDrag) return;
    stack._csDrag = true; // idempotent — listeners live on the stack, not the lines
    stack.addEventListener("pointerdown", (e) => {
      const line = e.target && e.target.closest && e.target.closest(".copilot-subs__line");
      if (!line) return;
      if (e.button != null && e.button !== 0) return;
      const rect = overlay.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      dragState = { id: e.pointerId, rect, moved: false, line, key: line.dataset.csKey || "__orig" };
      try { line.setPointerCapture(e.pointerId); } catch {}
      overlay.classList.add("copilot-dragging");
      e.preventDefault(); e.stopPropagation();
    });
    stack.addEventListener("pointermove", (e) => {
      if (!dragState || e.pointerId !== dragState.id) return;
      const r = dragState.rect;
      const x = clampFrac((e.clientX - r.left) / r.width, 0.5);
      const y = clampFrac((e.clientY - r.top) / r.height, 0.85);
      linePositions[dragState.key] = { x, y };
      dragState.moved = true;
      if (!overlay.classList.contains("copilot-pos-custom")) {
        overlay.classList.remove("copilot-pos-top", "copilot-pos-bottom");
        overlay.classList.add("copilot-pos-custom");
        autoPosEnabled = false;
        layoutCustomLines(); // place the OTHER lines so none jump to the corner
      }
      dragState.line.style.left = (x * 100).toFixed(2) + "%";
      dragState.line.style.top = (y * 100).toFixed(2) + "%";
    });
    const end = (e) => {
      if (!dragState || e.pointerId !== dragState.id) return;
      const moved = dragState.moved;
      try { dragState.line.releasePointerCapture(e.pointerId); } catch {}
      overlay.classList.remove("copilot-dragging");
      dragState = null;
      // position + linePositions apply LIVE via the storage watcher (no restart).
      // Saved PER-CLIP so each video keeps its own dragged layout.
      if (moved) saveClipSettings({ position: "custom", linePositions });
    };
    stack.addEventListener("pointerup", end);
    stack.addEventListener("pointercancel", end);
  }

  function applyAppearance(settings) {
    const el = ensureOverlay();
    el.classList.remove(
      "copilot-pos-top", "copilot-pos-bottom", "copilot-pos-custom",
      "copilot-size-sm", "copilot-size-md", "copilot-size-lg", "copilot-size-xl",
    );
    linePositions = (settings.linePositions && typeof settings.linePositions === "object") ? settings.linePositions : {};
    const pos = settings.position || "bottom";
    autoPosEnabled = pos === "auto";
    if (pos === "custom") {
      el.classList.add("copilot-pos-custom");
      layoutCustomLines();
    } else {
      el.classList.add("copilot-pos-" + (autoPosEnabled ? "bottom" : pos)); // auto starts bottom, then adapts
      // Clear any leftover per-line drag offsets so a prior "custom" session can't
      // leave the translation parked off-screen after you switch back to Top/Bottom.
      el.querySelectorAll(".copilot-subs__line").forEach((ln) => { ln.style.left = ""; ln.style.top = ""; });
    }
    appearanceSize = settings.size || "md";
    el.classList.add("copilot-size-" + appearanceSize);
    sizeOverlay(); // size the font to the video now (a 1s timer keeps it in sync on resize/fullscreen)
    initDrag(el);  // make the subtitles grabbable (idempotent)
    if (autoPosEnabled) updateAutoPosition();
  }

  // Known on-screen native-caption containers, for collision avoidance.
  const NATIVE_CAPTION_SELECTORS = [
    ".ytp-caption-window-container", ".caption-window", ".player-timedtext",
    ".zdfplayer-captions", ".zdfplayer-subtitle", ".vjs-text-track-display", ".captions",
  ];
  function nativeCaptionRect() {
    for (const s of NATIVE_CAPTION_SELECTORS) {
      const el = document.querySelector(s);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return r;
      }
    }
    return null;
  }
  // Put our overlay on the opposite half from the site's own caption.
  function updateAutoPosition() {
    const overlay = document.getElementById("copilot-subs");
    if (!overlay || !autoPosEnabled) return;
    // Native captions sit at the bottom ~always; when we can't measure the
    // site's caption (e.g. ZDF's native renderer has no DOM element), default
    // to the TOP so we don't land on top of it.
    let top = true;
    const rect = nativeCaptionRect();
    if (rect) {
      const player = (adapter?.getPlayerContainer?.() || document.body).getBoundingClientRect();
      top = rect.top + rect.height / 2 > player.top + player.height / 2; // native low → us high
    }
    overlay.classList.toggle("copilot-pos-top", top);
    overlay.classList.toggle("copilot-pos-bottom", !top);
  }

  // Keep the overlay inside whatever element went fullscreen.
  function onFullscreenChange() {
    const el = document.getElementById("copilot-subs");
    if (!el) return;
    const parent = document.fullscreenElement || adapter?.getPlayerContainer?.() || document.body;
    if (el.parentElement !== parent) parent.appendChild(el);
  }

  function teardown() {
    cancelAnimationFrame(rafId);
    rafId = 0;
    cancelAnimationFrame(audioRaf);
    audioRaf = 0;
    activeLines = [];
    cueListActive = false;
    audioActive = false;
    audioCues = null;
    if (streamCleanup) { try { streamCleanup(); } catch {} streamCleanup = null; }
    setBadge({ off: true }); // clear the toolbar look-ahead counter
    const el = document.getElementById("copilot-subs");
    if (el) el.remove();
  }

  // ─── track engine (YouTube) ──────────────────────────────────────────────────

  // Original spoken language = the ASR track if present, else the first track.
  function pickOriginalTrack(tracks) {
    if (!tracks || !tracks.length) return null;
    return tracks.find((t) => t.kind === "asr") || tracks[0];
  }

  // Build the cue list for one target language, being SMART about cost:
  //   1) cached from a previous run  -> free, instant
  //   2) target == source           -> show the original track
  //   3) a real (non-ASR) caption track already exists in this language -> reuse it
  //   4) otherwise translate the original cues with OpenAI (high quality)
  async function buildCues(ctx) {
    const { site, videoId, source, target, tracks, originalCues } = ctx;
    const key = `${site}:${videoId}:${source}:${target}`;

    const cached = await send({ type: "CACHE_GET", key });
    if (cached?.track?.cues?.length) return cached.track.cues;

    let cues, model;
    if (sameLang(target, source)) {
      cues = originalCues; // already downloaded up front
      model = "native";
    } else {
      const native = tracks.find((t) => t.kind !== "asr" && sameLang(t.languageCode, target));
      const nativeCues = native ? await adapter.fetchCues(native.baseUrl) : [];
      if (nativeCues.length) {
        cues = nativeCues; // reuse an existing track in this language — no API call
        model = "site-native";
      } else {
        const resp = await send({ type: "TRANSLATE", cues: originalCues.map((c) => c.text), source, target });
        if (resp?.error) throw new Error(resp.error);
        const tr = resp.lines || [];
        cues = originalCues.map((c, i) => ({
          startMs: c.startMs, endMs: c.endMs, text: tr[i] || c.text, original: c.text,
        }));
        model = "gpt-4o-mini";
      }
    }

    const track = {
      site, videoId, source, target, model,
      createdAt: new Date().toISOString(),
      durationMs: cues.length ? cues[cues.length - 1].endMs : 0,
      cues,
    };
    await send({ type: "CACHE_PUT", key, track });
    return cues;
  }

  function render(lines, video) {
    activeLines = lines.map((l) => ({
      lang: l.lang,
      cues: l.cues.slice().sort((a, b) => a.startMs - b.startMs),
      idx: -2,
      el: null,
    }));
    const overlay = ensureOverlay();
    const stack = overlay.querySelector(".copilot-subs__stack");
    stack.innerHTML = "";
    for (const l of activeLines) {
      const row = document.createElement("div");
      row.className = "copilot-subs__line";
      row.dataset.lang = l.lang;
      l.el = row;
      stack.appendChild(row);
    }

    cancelAnimationFrame(rafId);
    const tick = () => {
      const t = (video.currentTime || 0) * 1000 + liveOffsetMs;
      for (const l of activeLines) {
        const i = findCue(l.cues, t);
        if (i !== l.idx) {
          l.idx = i;
          const txt = i >= 0 ? l.cues[i].text : "";
          l.el.textContent = txt;
          l.el.style.display = txt ? "block" : "none";
          l.el.dir = isRTL(txt) ? "rtl" : "ltr";
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  // ─── stream engine (Netflix & other DRM/no-fetch sites) ──────────────────────

  // Read the site's own on-screen captions, translate each line to every target
  // (deduped by text, cached to disk), overlay the result, all keyed to
  // video.currentTime so replay reuses everything for free.
  async function startStream(settings, video) {
    const site = adapter.site;
    const videoId = adapter.getVideoId();
    if (!videoId) return;
    const targets = (settings.targets || []).slice();

    const cacheKey = `${site}:${videoId}:stream`;
    const loaded = (await send({ type: "CACHE_GET", key: cacheKey }))?.track;
    const track = loaded || {
      site, videoId, source: "auto", model: "gpt-4o-mini",
      createdAt: new Date().toISOString(), cues: [],
    };
    const cues = track.cues; // [{ startMs, endMs, original, t:{<target>:text} }]

    // text -> { target -> translated }, seeded from cache so repeats are free.
    const textCache = new Map();
    for (const c of cues) {
      const m = textCache.get(c.original) || {};
      Object.assign(m, c.t || {});
      textCache.set(c.original, m);
    }

    // Overlay rows: optional original line + one per target.
    const defs = [];
    if (settings.showOriginal) defs.push({ key: "__orig", target: null });
    for (const tg of targets) defs.push({ key: tg, target: tg });
    const overlay = ensureOverlay();
    applyAppearance(settings);
    const stack = overlay.querySelector(".copilot-subs__stack");
    stack.innerHTML = "";
    const els = {};
    for (const d of defs) {
      const row = document.createElement("div");
      row.className = "copilot-subs__line";
      row.dataset.lang = d.key;
      els[d.key] = row;
      stack.appendChild(row);
    }

    // The whole stack follows one cue — the most recent one whose primary
    // target translation is ready — so the original and its translation stay
    // aligned and both get a proper reading-time on screen.
    const primaryTarget = targets[0] || null;
    cancelAnimationFrame(rafId);
    let badgeAt = 0;
    const tick = () => {
      video = liveVideoEl(video); // DW's video.js can swap the <video> element mid-play
      const t = (video.currentTime || 0) * 1000 + liveOffsetMs;
      const c = streamDisplayCue(cues, t, primaryTarget);
      for (const d of defs) {
        const el = els[d.key];
        const txt = c ? (d.target ? c.t?.[d.target] || "" : c.original) : "";
        if (el.textContent !== txt) {
          el.textContent = txt;
          el.style.display = txt ? "block" : "none";
          el.dir = (d.target ? isRTLLang(d.target) : isRTL(txt)) ? "rtl" : "ltr";
        }
      }
      // Toolbar badge = how many upcoming lines are already translated. In this
      // reactive scrape path (Netflix) we can't see future lines, so it's ~0 —
      // which is the honest "fetched ahead" answer the counter is meant to show.
      if (performance.now() - badgeAt > 1000) {
        badgeAt = performance.now();
        const ahead = cues.filter((x) => x.startMs > t + 200);
        const ready = targets.length ? ahead.filter((x) => targets.every((g) => x.t && x.t[g])).length : ahead.length;
        setBadge({ count: ready, state: ready === 0 ? "miss" : ready < 5 ? "lag" : "ok" });
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    const persist = debounce(() => { send({ type: "CACHE_PUT", key: cacheKey, track }); }, 1500);
    let lastText = "";
    let curCue = null;
    let warned = false;
    let sawAny = false;
    let audioStopped = false;
    const recentLines = []; // preceding dialogue, for translation context

    const poll = setInterval(async () => {
      if (!adapter || !adapter.matches()) return; // adapter can be nulled mid-flight on clip nav
      const text = (adapter.readNativeText ? adapter.readNativeText() : "").replace(/\s+/g, " ").trim();
      if (text === lastText) return;
      const nowMs = (video.currentTime || 0) * 1000;
      if (curCue && curCue.endMs == null) curCue.endMs = nowMs;
      lastText = text;
      if (!text) { curCue = null; return; }
      sawAny = true;
      if (!audioStopped) { ensureAudioStopped(); audioStopped = true; } // captions exist → no audio
      dbg("heard “" + text.slice(0, 32) + "”");

      // Reuse an existing cue (replay) when the same line recurs near this time.
      let cue = cues.find((c) => c.original === text && Math.abs(c.startMs - nowMs) < 4000);
      if (!cue) cue = insertCue(cues, { startMs: nowMs, endMs: null, original: text, t: {} });
      curCue = cue;

      const context = recentLines.slice(-4);
      recentLines.push(text);
      if (recentLines.length > 20) recentLines.shift();

      const known = textCache.get(text) || {};
      textCache.set(text, known);
      for (const tg of targets) {
        if (known[tg]) { cue.t[tg] = known[tg]; continue; }
        const resp = await send({ type: "TRANSLATE", cues: [text], source: "auto", target: tg, context });
        if (resp?.dead) return; // extension reloaded — orphaned script, stop quietly
        if (resp?.error) {
          dbg("ERR " + tg + ": " + resp.error);
          setStatus(`Translation failed (${langLabel(tg)}): ${resp.error}`, true);
          continue;
        }
        const out = resp.lines && resp.lines[0];
        if (out) { known[tg] = out; cue.t[tg] = out; dbg(tg + " ✓ " + out.slice(0, 28)); }
        else { dbg(tg + " — empty reply from model"); }
      }
      persist();
    }, 100);

    let watchdog, wdTries = 0;
    const checkWatchdog = () => {
      // Resolved — a subtitle file fed us, or we're scraping live captions. Good.
      if (sawAny || cueListActive || (interceptedCues && interceptedCues.length)) return;
      // Ground truth that survives schedule() re-runs (which reset sawAny): if the
      // overlay is actually displaying a caption line, subtitles plainly work.
      const ov = document.getElementById("copilot-subs");
      if (ov && [...ov.querySelectorAll(".copilot-subs__line")].some((l) => l.style.display !== "none" && l.textContent)) return;
      // Not resolved yet. Keep waiting QUIETLY (the "Live mode… turn on CC" status
      // is already showing) — ZDF only requests its subtitle sidecar ~20s into
      // playback, so give it ~32s total before concluding there are none. This
      // replaces the old single 9s timeout that flashed a false "no subtitles".
      if (++wdTries < 5) { watchdog = setTimeout(checkWatchdog, 6000); return; }
      if (!maybeOfferAudio(settings)) {
        setStatus("No subtitles found for this clip. If the player has a CC / subtitles button, turn it ON — otherwise this clip has no subtitle track.", true);
      }
    };
    watchdog = setTimeout(checkWatchdog, 8000); // first check at 8s, re-check every 6s up to ~32s
    // Same-origin <track> sources (e.g. DW) expose the full cue list through the
    // <video>'s textTracks once it loads — even with the site's own captions
    // toggled off. Poll for it and, when present, upgrade from line-by-line
    // scraping to perfect-sync cue-list mode.
    const upgrade = setInterval(() => {
      const full = readVideoCueList(video);
      if (full && full.length > 3) onInterceptedCues(full);
    }, 2000);
    streamCleanup = () => { clearInterval(poll); clearTimeout(watchdog); clearInterval(upgrade); };
    applyHideNative(settings.hideNative);
    setStatus(`Live mode → ${targets.map(langLabel).join(" · ")}. Turn ON the player's CC / subtitles if you see nothing.`);
  }

  // ─── cue-list mode: the browser exposes the whole caption track (e.g. ZDF) ────

  // Read the full WebVTT cue list from the <video>'s text tracks, if readable
  // (cross-origin tracks return null cues — then we can't, and fall back).
  function readVideoCueList(video) {
    if (!video || !video.textTracks) return null;
    const tracks = [...video.textTracks].filter((t) => !t.kind || t.kind === "subtitles" || t.kind === "captions");
    // Force the track to LOAD its cues without rendering them ("hidden"): this
    // means we get the text even when the site's subtitles look "off", and
    // nothing of the site's is drawn on screen.
    for (const tt of tracks) { if (tt.mode === "disabled") { try { tt.mode = "hidden"; } catch {} } }
    for (const tt of tracks) {
      const cues = tt.cues;
      if (!cues || !cues.length) continue;
      const out = [];
      for (let i = 0; i < cues.length; i++) {
        const c = cues[i];
        const text = (c.text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (text) out.push({ startMs: Math.round((c.startTime || 0) * 1000), endMs: Math.round((c.endTime || 0) * 1000), text });
      }
      if (out.length) { out.sort((a, b) => a.startMs - b.startMs); return out; }
    }
    return null;
  }

  // Identity of the clip a cue list belongs to, derived from the URL so it's STABLE
  // and can't oscillate. We deliberately do NOT use adapter.getVideoId() here: on a
  // page with several <video> elements (e.g. a DW article with related clips) it
  // flips between elements, which made the clip-change detector churn — drop +
  // re-fetch + race between modes, leaving a stale "Live mode" status. The path is
  // unique per clip everywhere except YouTube (always "/watch"), where the ?v= id
  // distinguishes videos; other volatile params (&t=…) are ignored so a seek-share
  // URL doesn't look like a new clip.
  function currentClipId() {
    try {
      let path = location.pathname;
      // Amazon/Prime append a VOLATILE tracking segment after the title id
      // (…/detail/<ASIN>/ref=atv_hm_… changes every visit), which would make each
      // re-visit look like a new clip → cache miss → re-translate (re-pay). Pin the
      // key to the stable …/detail/<ASIN> so replays are actually free.
      const m = path.match(/^(.*\/(?:detail|dp|gti)\/[A-Za-z0-9.\-]{6,})(?:\/|$)/i);
      if (m) path = m[1];
      const v = new URLSearchParams(location.search).get("v");
      return path + (v ? "?v=" + v : "");
    } catch { return location.pathname; }
  }

  // The stable per-clip key, "<site>:<clipId>" — IDENTICAL to the cache base, so
  // per-clip settings and the cache agree on what "this video" is. Resolvable even
  // before the engine starts (the popup asks for it via GET_CLIP).
  function clipBaseId() {
    try { return `${(adapter || pickAdapter())?.site || "site"}:${currentClipId()}`; }
    catch { return "site:" + (location.pathname || ""); }
  }
  // Persist a few setting fields for THIS clip only (read-modify-write the override
  // map). Used by per-segment drag; the popup writes the same clipOverrides[base].
  async function saveClipSettings(partial) {
    try {
      const base = clipBaseId();
      const store = await chrome.storage.local.get("clipOverrides");
      const all = store.clipOverrides || {};
      all[base] = { ...(all[base] || {}), ...partial };
      await chrome.storage.local.set({ clipOverrides: all });
    } catch (e) { console.warn("[CopilotSubs] saveClipSettings", e && e.message); }
  }

  // Prefer the full cue list intercepted from the subtitle file (every line up
  // front → translate far ahead); otherwise read the browser's text tracks. Only
  // hand back intercepted cues that belong to the CLIP NOW PLAYING — stale cues
  // from a previous clip (different URL/id) are ignored so they can't bleed across.
  function getAllCues(video) {
    if (interceptedCues && interceptedCues.length && interceptedClipId === currentClipId()) return interceptedCues;
    return readVideoCueList(video);
  }
  function onInterceptedCues(list) {
    if (!Array.isArray(list) || !list.length) return;
    // Cues arriving for a different clip than the one we're holding → start fresh,
    // never merge two clips' cues into one list.
    const id = currentClipId();
    if (interceptedClipId !== id) { interceptedCues = null; interceptedClipId = id; }
    if (!interceptedCues) interceptedCues = [];
    const seen = new Set(interceptedCues.map((c) => c.startMs));
    let added = false;
    for (const c of list) {
      if (c && c.text && !seen.has(c.startMs)) { seen.add(c.startMs); interceptedCues.push(c); added = true; }
    }
    if (!added) return;
    interceptedCues.sort((a, b) => a.startMs - b.startMs);
    if (audioActive) return;
    // First cues flip the stream adapter from line-by-line scraping to perfect-
    // sync cue-list mode. Once that mode runs, its reread loop ingests more.
    if (!cueListActive) { currentRunKey = null; schedule(); }
  }

  // Drop the current clip's intercepted subtitle file. Called on a clip/page
  // change so the previous clip's cues can't bleed onto a new clip — critical
  // when the new clip has DIFFERENT subtitles, or (as on many ZDF clips) NONE.
  function dropInterceptedCues() {
    interceptedCues = null; interceptedUrl = null; interceptedClipId = null; cueListActive = false; currentRunKey = null;
    fetchedSubUrls.clear(); subFetchFails.clear();
  }

  // Parse a subtitle file (TTML/XML or WebVTT) into [{startMs,endMs,text}].
  // Runs here (not the worker) because the content script has DOMParser.
  function subTimeToMs(s, tickRate) {
    if (!s) return 0;
    s = String(s).trim();
    // TTML tick-based timing (Netflix imsc1.1): "<digits>t" (or bare digits),
    // converted via the file's ttp:tickRate. Without this, ticks read as raw
    // seconds → timestamps centuries long (the Netflix "lastStart=…s" symptom).
    if (tickRate > 0 && /^\d+(?:\.\d+)?t?$/.test(s)) return Math.round((parseFloat(s) / tickRate) * 1000);
    const m = s.match(/(?:(\d+):)?(\d+):(\d+)(?:[.,](\d+))?/);
    if (m) {
      const h = +(m[1] || 0), mi = +m[2], se = +m[3];
      const fr = m[4] ? +(m[4] + "000").slice(0, 3) : 0;
      return (h * 3600 + mi * 60 + se) * 1000 + fr;
    }
    const sec = parseFloat(s);
    return isNaN(sec) ? 0 : Math.round(sec * 1000);
  }
  function parseSubtitleFile(text) {
    if (!text || text.length < 16) return [];
    const trimmed = text.trim();
    // YouTube timedtext json3 ({"wireMagic":"pb3","events":[{tStartMs,dDurationMs,segs:[{utf8}]}]}).
    if (trimmed[0] === "{" && /"events"\s*:/.test(trimmed.slice(0, 400))) {
      try {
        const data = JSON.parse(trimmed);
        const cues = [];
        for (const ev of data.events || []) {
          if (!ev.segs) continue;
          const t = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
          if (!t) continue;
          const startMs = ev.tStartMs || 0;
          cues.push({ startMs, endMs: startMs + (ev.dDurationMs || 2500), text: t });
        }
        if (cues.length) return cues;
      } catch {}
    }
    if (/^﻿?WEBVTT/.test(text.trim())) {
      const cues = [];
      for (const block of text.replace(/\r/g, "").split("\n\n")) {
        const m = block.match(/(\d{1,2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3})([\s\S]*)/);
        if (!m) continue;
        const txt = m[3].split("\n").slice(1).join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        if (txt) cues.push({ startMs: subTimeToMs(m[1]), endMs: subTimeToMs(m[2]), text: txt });
      }
      return cues;
    }
    let doc;
    try { doc = new DOMParser().parseFromString(text, "text/xml"); } catch { return []; }
    const cues = [];
    // TTML timing can be tick-based (Netflix): pull the file's ttp:tickRate (or
    // derive it from frameRate) so subTimeToMs can convert "<n>t" ticks → ms.
    const root = doc.documentElement;
    const TTP = "http://www.w3.org/ns/ttml#parameter";
    let tickRate = 0;
    if (root) {
      tickRate = +(root.getAttribute("ttp:tickRate") || root.getAttributeNS(TTP, "tickRate") || 0) || 0;
      if (!tickRate) {
        const fr = +(root.getAttribute("ttp:frameRate") || root.getAttributeNS(TTP, "frameRate") || 0);
        const sfr = +(root.getAttribute("ttp:subFrameRate") || root.getAttributeNS(TTP, "subFrameRate") || 0) || 1;
        if (fr) tickRate = fr * sfr;
      }
    }
    // ZDF/EBU-TT-D namespaces every tag (<tt:p>, <tt:span>…). getElementsByTagName("p")
    // does an EXACT, prefix-sensitive match and finds none — so match the LOCAL name
    // "p" in ANY namespace, which covers both plain <p> and prefixed <tt:p>.
    let ps = doc.getElementsByTagNameNS("*", "p");
    if (!ps.length) ps = doc.getElementsByTagName("p"); // belt-and-suspenders for odd parsers
    for (const p of ps) {
      const b = p.getAttribute("begin");
      if (!b) continue; // TTML cue <p> carries begin/end; plain XHTML <p> doesn't
      let out = "";
      for (const n of p.childNodes) out += /br/i.test(n.nodeName) ? " " : (n.textContent || "");
      out = out.replace(/\s+/g, " ").trim();
      if (out) cues.push({ startMs: subTimeToMs(b, tickRate), endMs: subTimeToMs(p.getAttribute("end"), tickRate), text: out });
    }
    return cues;
  }

  // A subtitle URL was discovered (Resource Timing). Re-fetch it through the
  // background worker (CORS-exempt cross-origin) and merge its full cue list.
  const fetchedSubUrls = new Set();   // dedup KEYS we've claimed: in flight, done, or given up on
  const subFetchFails = new Map();    // key -> transient network-failure count (bounds retries)
  // A CLIP-STABLE dedup key. YouTube re-fetches its timedtext with a fresh pot/ei
  // token on every seek (a different URL each time). Keying on v+lang+kind makes
  // those re-fetches resolve to the SAME key → skipped → so a seek doesn't REPLACE
  // the cue list and wipe the pump's in-progress translations. (A real caption-
  // language switch has a different lang → different key → still re-fetched.)
  function subDedupKey(url) {
    try {
      const u = new URL(url);
      if (/\/api\/timedtext$/.test(u.pathname)) {
        const p = u.searchParams;
        return "yt-tt:" + (p.get("v") || "") + ":" + (p.get("lang") || "") + ":" + (p.get("kind") || "");
      }
    } catch {}
    return url;
  }
  async function fetchSubsByUrl(url) {
    const key = subDedupKey(url);
    if (!url || url === interceptedUrl || fetchedSubUrls.has(key)) return; // already active / in flight / done
    fetchedSubUrls.add(key); // claim NOW so the 1.5s re-post (subs-intercept.js) can't launch a duplicate fetch
    console.info("[CopilotSubs] fetching subtitle file:", url);
    const resp = await send({ type: "FETCH_SUBS", url });
    if (!resp || resp.error || !resp.text) {
      // Transport failure is transient — let a later re-post retry, but only a few
      // times, then give up (leave it claimed) so we never hammer a dead URL forever.
      const n = (subFetchFails.get(key) || 0) + 1;
      subFetchFails.set(key, n);
      console.warn("[CopilotSubs] subtitle fetch failed:", resp && (resp.error || resp.status), `(try ${n}/4)`, url);
      if (n < 4) fetchedSubUrls.delete(key);
      return;
    }
    // We HAVE the file. Whatever the parse yields, this URL is DONE — it STAYS
    // claimed even on 0 cues, so a file we can't parse can't trigger an endless
    // re-fetch loop (the re-post would otherwise hammer it ~every 1.5s forever).
    const cues = parseSubtitleFile(resp.text);
    if (!cues.length) {
      console.warn("[CopilotSubs] subtitle file parsed to 0 cues (not TTML/VTT?):", url, resp.text.slice(0, 160));
      return;
    }
    console.info(`[CopilotSubs] ${cues.length} cues from subtitle file → perfect-sync`);
    setStatus(`Loaded subtitle file (${cues.length} lines) — perfect sync.`);
    // A subtitle file IS this clip's full cue list — REPLACE, never merge across
    // clips (merging is what bled one clip's lines onto another).
    interceptedCues = cues;
    interceptedUrl = url;
    interceptedClipId = currentClipId(); // tie this file to the clip now playing
    cueListActive = false;
    currentRunKey = null;
    schedule();
  }

  // Perfect-sync display: cues carry their own timing, and we translate a window
  // AHEAD of the playhead so each line is ready before it's needed.
  async function runCueListMode(settings, video, cueList) {
    adapter = pickAdapter();
    teardown();
    cueListActive = true; // claim the engine so streamed-in cues don't restart us
    liveAutoOffsetMs = 0; calibAt = 0; calibMatched = false; calibMisses = 0; // fresh auto-sync per clip
    const videoId = adapter?.getVideoId?.() || location.pathname;
    // Cache key = the STABLE, URL-derived clip id — ONE per video. NOT the subtitle
    // URL (on YouTube it carries a rotating pot token) and NOT the <video> element
    // id (it varies, e.g. "v70813425" vs "v70813425_html5_api"); both of those keyed
    // the SAME video under many entries, flooding the cache list with duplicates.
    const base = clipBaseId(); // "<site>:<clipId>" — shared by the cache AND per-clip settings
    lastCacheBase = base; // remember for "clear this video" from the popup

    // Cached translations (per target), applied to current AND future cues.
    const cacheMaps = {};
    for (const tg of settings.targets) {
      const cached = (await send({ type: "CACHE_GET", key: `${base}:auto:${tg}` }))?.track;
      cacheMaps[tg] = new Map((cached?.cues || []).map((c) => [c.startMs, c.text]));
    }
    const applyCache = (cue) => {
      for (const tg of settings.targets) { const v = cacheMaps[tg].get(cue.startMs); if (v) cue.t[tg] = v; }
    };

    // ZDF streams subtitle cues in as you play, so ingest is incremental.
    const cues = [];
    const seen = new Set();
    const ingest = (list) => {
      for (const f of list) {
        if (seen.has(f.startMs)) continue;
        seen.add(f.startMs);
        // Live captions ROLL UP — the same line is re-sent across consecutive
        // segments. Collapse a repeat into the existing cue (extend its end) instead
        // of inserting a duplicate. Otherwise it showed "X X X", got translated 3×,
        // and the duplicate cues confused auto-sync (jittery shift).
        const last = cues.length ? cues[cues.length - 1] : null;
        if (last && f.text && normCue(last.original) === normCue(f.text) && f.startMs - (last.endMs || last.startMs) < 2000) {
          if ((f.endMs || f.startMs) > (last.endMs || last.startMs)) last.endMs = f.endMs;
          continue;
        }
        const cue = { startMs: f.startMs, endMs: f.endMs, original: f.text, t: {} };
        applyCache(cue);
        insertCue(cues, cue);
      }
    };
    // Group consecutive cues into SENTENCES so we translate whole thoughts, not
    // fragments — YouTube auto-captions split a sentence mid-phrase ("…Nice" |
    // "to meet you."), and translating each piece alone produced wrong results.
    // Every cue gets .grp; all cues of a group share ONE translation, shown across
    // the group's span. Sentence-aligned captions ⇒ 1 cue per group ⇒ no change.
    const SENT_END = /[.!?…](["'”’»)\]]*)\s*$/;
    function buildGroups(list) {
      let i = 0;
      while (i < list.length) {
        const start = i;
        let txt = list[i].original, brokeBy = "end";
        while (i + 1 < list.length) {
          if (SENT_END.test((list[i].original || "").trim())) { brokeBy = "sent"; break; }
          if (list[i + 1].startMs - list[i].endMs > 1400) { brokeBy = "gap"; break; }
          if (txt.length > 110 || (i - start) >= 4) { brokeBy = "limit"; break; }
          i++; txt += " " + list[i].original;
        }
        // "closed" = a complete unit safe to translate; an open last group is still
        // accumulating (streaming) so we wait. A full file's last cue usually ends
        // a sentence, so it closes too.
        const closed = brokeBy !== "end" || SENT_END.test((list[i].original || "").trim());
        const grp = { orig: txt.replace(/\s+/g, " ").trim(), cues: list.slice(start, i + 1), t: {}, closed };
        for (const tg of settings.targets) if (grp.cues.every((c) => c.t[tg])) grp.t[tg] = grp.cues[0].t[tg];
        for (const c of grp.cues) c.grp = grp;
        i++;
      }
    }
    ingest(cueList);
    buildGroups(cues);

    const overlay = ensureOverlay();
    applyAppearance(settings);
    const stack = overlay.querySelector(".copilot-subs__stack");
    stack.innerHTML = "";
    const defs = [];
    if (settings.showOriginal) defs.push({ key: "__orig", target: null });
    for (const tg of settings.targets) defs.push({ key: tg, target: tg });
    if (!defs.length) defs.push({ key: "__orig", target: null });
    const els = {};
    for (const d of defs) { const row = document.createElement("div"); row.className = "copilot-subs__line"; row.dataset.csKey = d.key; els[d.key] = row; stack.appendChild(row); }
    layoutCustomLines(); // if Position is "custom", anchor each line at its own saved spot

    cancelAnimationFrame(rafId);
    let diagAt = 0;
    // Becomes true once this clip has actually played. Lets us keep pre-translating
    // the buffered-ahead window WHILE PAUSED — so pausing a live/DVR stream (or any
    // video) lets the translation run ahead and cache — yet stay idle (no spend) on a
    // video you've never started (e.g. a muted autoplay promo on a browse page).
    let engaged = false;
    const tick = () => {
      video = liveVideoEl(video); // DW's video.js can swap the <video> element mid-play
      if (video && !video.paused && (video.currentTime || 0) > 0.5) engaged = true;
      isLiveStream = !!(video && video.duration != null && !isFinite(video.duration));
      // Auto-align to the player's own caption — LIVE ONLY. On VOD (YouTube, Netflix,
      // recorded Prime) the cue list is already exactly timed to video.currentTime, so
      // ANY auto-shift can only DESYNC it. The trap: a caption stays on screen for its
      // whole [start,end] span, so matching it mid-display gives want = startMs - now,
      // a NEGATIVE value that drags our line ~1 cue into the PAST — that's the
      // "ours hasn't changed yet" lag behind YouTube's own caption. Live needs it (our
      // clock is anchored to the buffered edge, not currentTime); VOD stays a hard 0.
      if (isLiveStream) {
        // Back off the caption scan when we can't match (e.g. a <br>-split Prime caption).
        const calibIv = calibMatched ? 4000 : (calibMisses > 5 ? 20000 : 3500);
        if (performance.now() - calibAt > calibIv) { calibAt = performance.now(); try { autoCalibrate(cues, video); } catch {} }
      } else if (liveAutoOffsetMs) { liveAutoOffsetMs = 0; } // a clip that proved to be VOD: drop any stale auto-shift
      // Manual nudge + auto-align apply to LIVE only — VOD is frame-exact off currentTime.
      const t = playheadMs(video) + (isLiveStream ? (liveOffsetMs + liveAutoOffsetMs) : 0);
      let i = findCue(cues, t);
      // LIVE: if the (offset-shifted) lookup ran PAST the newest cue, show the newest
      // one instead of going blank. Live's caption delay varies per channel, so a
      // fixed shift can overshoot the edge — better to show the latest line than
      // nothing. (When rewound, t is well below the newest cue, so findCue handles it.)
      if (i < 0 && isLiveStream && cues.length) {
        const last = cues[cues.length - 1], lastEnd = last.endMs || last.startMs;
        if (t > lastEnd && t - lastEnd < 20000) i = cues.length - 1;
      }
      const c = i >= 0 ? cues[i] : null;
      for (const d of defs) {
        const el = els[d.key];
        const txt = c ? (d.target ? c.t[d.target] || "" : (c.grp ? c.grp.orig : c.original)) : "";
        if (el.textContent !== txt) { el.textContent = txt; el.style.display = txt ? "block" : "none"; el.dir = (d.target ? isRTLLang(d.target) : isRTL(txt)) ? "rtl" : "ltr"; }
      }
      // ── live proof of the lookahead — read window.csDiag() in the console ──
      if (performance.now() - diagAt > 1000) {
        diagAt = performance.now();
        const raw = (video && video.currentTime) || 0;
        // Bounded to the next ~24 cues (matches the pump's window), so the badge
        // reflects real runway and can't read "99+" when a file's timestamps are
        // misparsed (Prime) and the whole movie looks "due now".
        let _i0 = 0;
        while (_i0 < cues.length && cues[_i0].startMs < t) _i0++;
        const aheadCues = cues.slice(_i0, _i0 + 24);
        const tgs = settings.targets || [];
        const done = tgs.length ? aheadCues.filter((x) => tgs.every((g) => x.t[g])).length : aheadCues.length;
        const nextUntr = tgs.length ? aheadCues.find((x) => !tgs.every((g) => x.t[g])) : null;
        // Toolbar badge as a COST signal: a number while it's actively pre-
        // translating (may be spending), but a green "✓" once everything ahead is
        // ready — i.e. replaying cached/already-done lines at no API cost. So a
        // seek back into watched territory reads ✓ (free), not a number.
        const pending = aheadCues.length - done;
        const behindMs = nextUntr ? nextUntr.startMs - t : Infinity;
        // Active = playing, OR paused but already engaged (we keep pre-translating
        // the buffered-ahead window during a pause). Idle only on a never-started
        // video ⇒ clear the badge so nothing shows before you press play.
        const active = video && !video.ended && (!video.paused || engaged);
        if (!active) setBadge({ off: true });
        else if (pending <= 0) setBadge({ free: true });
        else setBadge({ count: done, state: behindMs < 3500 ? "miss" : "lag" });
        try {
          document.documentElement.dataset.csDiag = JSON.stringify({
            play: +(t / 1000).toFixed(1), raw: +raw.toFixed(1), relayClk: mainClockMs != null ? +(mainClockMs / 1000).toFixed(1) : null,
            live: isLiveStream, autoOff: +(liveAutoOffsetMs / 1000).toFixed(1),
            showing: i >= 0 ? +(cues[i].startMs / 1000).toFixed(1) : null,
            translatedAhead: done + "/" + aheadCues.length, total: cues.length,
            cueRange: cues.length ? [+(cues[0].startMs / 1000).toFixed(1), +(cues[cues.length - 1].startMs / 1000).toFixed(1)] : null,
            firstUntranslatedAhead: nextUntr ? +(nextUntr.startMs / 1000).toFixed(1) : null,
          });
        } catch {}
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    ensureAudioStopped();
    applyHideNative(settings.hideNative);
    // If this clip's translations are already cached (a re-watch), say so — it's
    // free and instant, which is SubVibe's whole replay story.
    const tgs0 = settings.targets || [];
    const cachedReady = tgs0.length && cues.length ? cues.filter((c) => tgs0.every((g) => c.t[g])).length / cues.length : 0;
    setStatus(cachedReady > 0.9 ? "Replaying from cache — free, no API cost ✓" : "Subtitles ready — pre-translating ahead.");
    console.info(`[CopilotSubs] perfect-sync ON — ${cues.length} cues`);

    const persist = debounce(() => {
      // Don't cache LIVE: it's not replayable, and all live channels share the same
      // clip key (/gp/video/livetv) so caching would mix channels and pollute the Library.
      if (isLiveStream) return;
      for (const tg of settings.targets) {
        send({ type: "CACHE_PUT", key: `${base}:auto:${tg}`,
          track: { site: adapter?.site, videoId, source: "auto", target: tg, model: "gpt-4o-mini", createdAt: new Date().toISOString(),
            title: document.title, url: location.href, totalCues: cues.length,
            cues: cues.filter((c) => c.t[tg]).map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.t[tg] })) } });
      }
    }, 3000);

    // Translate the next ~30s ahead of the playhead, one batch at a time.
    // Keep ingesting cues as ZDF streams more of them in during playback.
    // Keep ingesting as more cues arrive. HLS players (e.g. DW) add subtitle
    // cues to the text track segment-by-segment during playback, so re-read the
    // live track too — not just the one-shot intercepted file.
    const reread = setInterval(() => {
      const native = readVideoCueList(video);
      if (native && native.length) onInterceptedCues(native); // dedups into interceptedCues
      const fresh = getAllCues(video);
      if (fresh) ingest(fresh);
      buildGroups(cues); // re-group as new cues arrive (streaming sources)
    }, 3000);

    let busy = false;
    const pump = setInterval(async () => {
      if (busy) return;
      const lv = liveVideoEl(video);
      // Pre-translate the buffered-ahead window while PLAYING — and also while PAUSED
      // once you've engaged this clip, so pausing a live/DVR (or any) video lets the
      // translation run ahead and cache. Stay idle only on a video you've never
      // started (don't spend on muted autoplay promos while just browsing).
      if (!lv || lv.ended) return;
      if (lv.paused && !engaged) return;
      // SAME sync-shifted clock as the render tick: a big +shift means the display
      // requests cues N seconds ahead, so the pump must pre-translate THOSE cues, not
      // the raw-playhead ones — otherwise a shifted line shows up blank/untranslated.
      const t = playheadMs(lv) + (isLiveStream ? (liveOffsetMs + liveAutoOffsetMs) : 0);
      for (const tg of settings.targets) {
        // Translate whole SENTENCE GROUPS (one entry each) in a BOUNDED window
        // ahead of the playhead — closed groups only (an open one is still
        // streaming in). The window is capped BY CUE INDEX (the next ~24 cues),
        // not just by a 30s time span: if a site reports broken/compressed
        // timestamps (Prime did — the whole file looked "due now"), a pure time
        // window would translate the ENTIRE movie at once and burn API cost. The
        // index cap makes spend track watched time, never file size.
        const MAX_AHEAD_CUES = 24;
        let i0 = 0;
        while (i0 < cues.length && cues[i0].startMs < t - 4000) i0++;
        const groups = [], gseen = new Set();
        for (let k = i0; k < cues.length && k < i0 + MAX_AHEAD_CUES; k++) {
          const c = cues[k];
          if (c.startMs > t + 45000) break; // also never run far ahead in time
          const g = c.grp;
          if (!g || !g.closed || g.t[tg] || gseen.has(g)) continue;
          gseen.add(g); groups.push(g);
          if (groups.length >= 12) break;
        }
        if (!groups.length) continue;
        busy = true;
        const guard = setTimeout(() => { busy = false; }, 20000); // backstop: a hung worker call must never wedge the pump (the 5→0-stuck bug)
        let resp;
        try { resp = await send({ type: "TRANSLATE", cues: groups.map((g) => g.orig), source: "auto", target: tg, site: adapter?.site, title: document.title }); }
        finally { clearTimeout(guard); busy = false; }
        if (resp?.dead) return; // extension reloaded — orphaned script, stop quietly (haltOrphaned showed the refresh hint)
        if (resp?.error) {
          // Transient OpenAI blips (5xx/520/429) self-recover on the next tick — show a
          // gentle, fading note rather than a scary sticky "Translation failed".
          const transient = /temporarily unavailable|rate limited|\bOpenAI (?:429|5\d\d)\b/i.test(resp.error);
          setStatus(transient ? `${langLabel(tg)}: OpenAI busy — retrying…` : `Translation failed (${langLabel(tg)}): ${resp.error}`, !transient);
          return;
        }
        if (resp?.lines) groups.forEach((g, k) => { if (resp.lines[k]) { g.t[tg] = resp.lines[k]; for (const cc of g.cues) cc.t[tg] = resp.lines[k]; } });
        persist();
        return; // one batch per tick
      }
    }, 700);
    streamCleanup = () => { clearInterval(pump); clearInterval(reread); };
  }

  // ─── audio-transcription mode (EXPLICIT opt-in; cues from offscreen capture) ──

  function mediaClock() {
    const v = document.querySelector("video");
    return v && v.currentTime ? v.currentTime * 1000 : performance.now();
  }

  function audioCacheKey() {
    const id = adapter?.getVideoId?.();
    return adapter && id ? `${adapter.site}:${id}:audio` : null;
  }

  // Caption path found nothing → show an explicit button (only if the user
  // enabled the fallback + picked a device). NOTHING runs or is charged until
  // they click. If we already cached a transcription for this video, the button
  // replays it for FREE instead of charging again.
  function maybeOfferAudio(settings) {
    if (!settings.audioFallback || !settings.audioDeviceId) return false;
    (async () => {
      const key = audioCacheKey();
      const cached = key ? (await send({ type: "CACHE_GET", key }))?.track : null;
      showAudioCta(settings, cached?.cues?.length ? cached.cues : null);
    })();
    return true;
  }

  function showAudioCta(settings, cachedCues) {
    const overlay = ensureOverlay();
    let cta = overlay.querySelector(".copilot-subs__cta");
    if (!cta) {
      cta = document.createElement("button");
      cta.className = "copilot-subs__cta";
      overlay.appendChild(cta);
    }
    if (cachedCues) {
      cta.textContent = "▶ Show saved subtitles (free)";
      cta.onclick = () => { buildAudioOverlay(settings, cachedCues.slice()); setStatus("Saved subtitles — no charge."); };
    } else {
      cta.textContent = "▶ No captions — transcribe the audio live (~$0.40/hr)";
      cta.onclick = () => {
        buildAudioOverlay(settings, []);
        send({ type: "START_AUDIO", deviceId: settings.audioDeviceId }); // charging starts now
        setStatus("Transcribing the audio…");
      };
    }
    cta.style.display = "block";
  }

  function hideAudioCta() {
    const cta = document.querySelector("#copilot-subs .copilot-subs__cta");
    if (cta) cta.style.display = "none";
  }

  function ensureAudioStopped() {
    hideAudioCta();
    send({ type: "STOP_AUDIO" });
  }

  // Builds the overlay + time-synced loop. Used for live transcription
  // (initialCues = []) AND for free cache replay (initialCues pre-filled).
  function buildAudioOverlay(settings, initialCues) {
    adapter = pickAdapter();
    teardown();
    audioCues = initialCues || [];
    audioActive = true;
    const overlay = ensureOverlay();
    applyAppearance(settings);
    const stack = overlay.querySelector(".copilot-subs__stack");
    stack.innerHTML = "";
    audioDefs = [];
    if (settings.showOriginal) audioDefs.push({ key: "__orig", target: null });
    for (const tg of settings.targets) audioDefs.push({ key: tg, target: tg });
    if (!audioDefs.length) audioDefs.push({ key: "__orig", target: null });
    audioEls = {};
    for (const d of audioDefs) {
      const row = document.createElement("div");
      row.className = "copilot-subs__line";
      audioEls[d.key] = row;
      stack.appendChild(row);
    }
    const primary = settings.targets[0] || null;
    cancelAnimationFrame(audioRaf);
    const tick = () => {
      const t = mediaClock() + liveOffsetMs;
      const c = streamDisplayCue(audioCues, t, primary);
      for (const d of audioDefs) {
        const el = audioEls[d.key];
        const txt = c ? (d.target ? c.t?.[d.target] || "" : c.original) : "";
        if (el.textContent !== txt) {
          el.textContent = txt;
          el.style.display = txt ? "block" : "none";
          el.dir = (d.target ? isRTLLang(d.target) : isRTL(txt)) ? "rtl" : "ltr";
        }
      }
      audioRaf = requestAnimationFrame(tick);
    };
    audioRaf = requestAnimationFrame(tick);
  }

  // Cache the transcription so a re-watch is instant + free (debounced writes).
  const persistAudio = debounce(() => {
    const key = audioCacheKey();
    if (!key || !audioCues || !audioCues.length) return;
    send({
      type: "CACHE_PUT",
      key,
      track: {
        site: adapter?.site, videoId: adapter?.getVideoId?.(), source: "auto",
        model: "gpt-4o-transcribe", createdAt: new Date().toISOString(), cues: audioCues,
      },
    });
  }, 2500);

  async function onAudioCue(text) {
    text = (text || "").replace(/\s+/g, " ").trim();
    if (!text) return;
    const settings = await getSettings();
    liveOffsetMs = Math.round((settings.syncOffset || 0) * 1000);
    if (!audioActive) buildAudioOverlay(settings, []);

    const nowMs = mediaClock();
    if (audioCues.length) audioCues[audioCues.length - 1].endMs = nowMs;
    const cue = { startMs: nowMs, endMs: null, original: text, t: {} };
    insertCue(audioCues, cue);

    for (const tg of settings.targets) {
      const ctx = audioCues.slice(-5, -1).map((c) => c.original);
      const resp = await send({ type: "TRANSLATE", cues: [text], source: "auto", target: tg, context: ctx });
      if (resp?.error) { setStatus("Translation failed: " + resp.error, true); continue; }
      const out = resp && resp.lines && resp.lines[0];
      if (out) cue.t[tg] = out;
    }
    persistAudio();
  }

  function stopAudio() {
    audioActive = false;
    cancelAnimationFrame(audioRaf);
    audioRaf = 0;
    audioCues = null;
    const el = document.getElementById("copilot-subs");
    if (el) el.remove();
    currentRunKey = null;
    schedule(); // resume caption scraping if the page has its own captions
  }

  // ─── orchestration ───────────────────────────────────────────────────────────

  async function start() {
    if (!extAlive()) return; // orphaned by a reload — don't touch chrome.* APIs
    const settings = await getSettings();
    liveOffsetMs = Math.round((settings.syncOffset || 0) * 1000);
    const ad = pickAdapter();
    const vid = ad && ad.matches && ad.matches() ? ad.getVideoId() : null;

    // Skip redundant restarts: if nothing relevant changed and we're already
    // showing an overlay, don't tear it all down (kills the live loop).
    const runKey = JSON.stringify({
      en: settings.enabled, v: vid,
      t: settings.targets, o: settings.showOriginal, h: settings.hideNative,
      p: settings.position, s: settings.size,
      // Whether this clip's FULL cue list has been intercepted yet. Without this,
      // a stream site (Netflix) that fell back to reactive scraping never upgrades
      // to look-ahead when its subtitle file arrives late — the key looked
      // "unchanged" so start() early-returned, leaving the counter stuck at 0.
      cl: !!(ad && ad.stream && interceptedCues && interceptedCues.length && interceptedClipId === currentClipId()),
    });
    if (runKey === currentRunKey && document.getElementById("copilot-subs")) return;
    currentRunKey = runKey;

    teardown();
    applyHideNative(settings.enabled && settings.hideNative);
    if (!settings.enabled) return;

    adapter = ad;
    if (!adapter || !adapter.matches()) return;

    const videoId = vid;
    if (!videoId) return;
    // Clip switches are detected from the page-world clock relay (mainVideoId),
    // which clears stale cues — see the SUBS_TIME handler. The isolated world's
    // own videoId is unreliable on MSE players, so we don't key cues off it here.

    const video = await waitFor(() => adapter.getVideoEl());
    if (!video) { currentRunKey = null; return; } // not ready — allow a retry

    // Streaming sources: if the browser exposes the full caption track (e.g. ZDF),
    // use it for perfect-sync pre-translation; otherwise scrape on-screen captions.
    if (adapter.stream) {
      const cueList = await waitFor(() => getAllCues(video), 3000);
      if (cueList && cueList.length) { await runCueListMode(settings, video, cueList); return; }
      await startStream(settings, video);
      return;
    }

    // YouTube's caption files can't be downloaded directly anymore — its
    // anti-scraping returns an EMPTY body unless the request carries a Proof-of-
    // Origin Token that only the player can mint. But when CC is ON the player
    // fetches the real file (token included); subs-intercept.js captures that URL
    // and fetchSubsByUrl re-fetches it. If we already have that intercepted cue
    // list for this clip, use it — full pre-translate lookahead, same as ZDF/DW.
    {
      const inter = getAllCues(video);
      if (inter && inter.length) { await runCueListMode(settings, video, inter); return; }
    }

    setStatus("Loading captions…");
    let tracks = [];
    try { tracks = await adapter.getCaptionTracks(videoId); } catch { tracks = []; }
    const originalTrack = pickOriginalTrack(tracks);

    // Try the direct download (still works on some sites / when logged in). If it
    // comes back empty (YouTube anti-scraping), fall through.
    let originalCues = [];
    if (originalTrack) {
      try { originalCues = await adapter.fetchCues(originalTrack.baseUrl); }
      catch (e) { console.warn("[CopilotSubs] fetchCues failed", e); originalCues = []; }
    }
    if (!originalCues.length) {
      if (adapter.readNativeText) {
        // Turn ON the player's CC: that makes YouTube fetch its real caption file
        // (with the token), which we intercept and upgrade to perfect-sync with
        // pre-translation. Until then, scrape the on-screen captions line by line.
        setStatus("Turn ON the player's CC (subtitles) — then I'll pre-translate the whole track in sync.", true);
        await startStream(settings, video);
        return;
      }
      if (!maybeOfferAudio(settings)) {
        setStatus(originalTrack
          ? "The caption file couldn't be downloaded for this video."
          : "No caption track on this video.", true);
      }
      return;
    }
    // We now have the full original track. Hand it to the SAME incremental engine
    // ZDF/DW use: it shows the ORIGINAL line INSTANTLY and pre-translates each
    // target ~30s AHEAD of the playhead, caching as it goes. The old path
    // translated the ENTIRE track up front and called render() only after every
    // language finished — so each line lagged and even the original waited on the
    // (slow) translation. runCueListMode fixes both. (window.csDiag proves the lookahead.)
    await runCueListMode(settings, video, originalCues);
  }

  // ─── wiring ──────────────────────────────────────────────────────────────────

  const schedule = debounce(() => { start().catch((e) => console.warn("[CopilotSubs]", e)); }, 400);

  // Appearance keys (position, drag coords, text size) and the sync nudge apply
  // LIVE — re-style in place, no flicker. Anything else (languages, key, enabled…)
  // restarts the engine.
  const LIVE_KEYS = ["syncOffset", "position", "linePositions", "size"];
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const keys = Object.keys(changes);
    // This clip's sync/appearance can change via a global default key OR via its
    // per-clip override (clipOverrides). Either way, recompute the EFFECTIVE (merged)
    // settings and apply sync + appearance live — no restart, no flicker.
    const overChanged = keys.includes("clipOverrides");
    if (overChanged || keys.some((k) => LIVE_KEYS.includes(k))) {
      getSettings().then((s) => {
        liveOffsetMs = Math.round((s.syncOffset || 0) * 1000);
        if (document.getElementById("copilot-subs")) applyAppearance(s);
      }).catch(() => {});
    }
    // Restart for anything that changes WHICH cues/lines we show. Global non-live keys
    // (languages, key, enabled, …) always restart.
    if (keys.some((k) => k !== "clipOverrides" && !LIVE_KEYS.includes(k))) schedule();
    // A per-clip override restarts ONLY if THIS clip's languages/show-original changed
    // (position/size/sync/layout are applied live above, not via restart).
    if (overChanged) {
      const base = clipBaseId();
      const before = (changes.clipOverrides.oldValue && changes.clipOverrides.oldValue[base]) || {};
      const after = (changes.clipOverrides.newValue && changes.clipOverrides.newValue[base]) || {};
      if (JSON.stringify(before.targets) !== JSON.stringify(after.targets) || !!before.showOriginal !== !!after.showOriginal) schedule();
    }
  });
  document.addEventListener("fullscreenchange", onFullscreenChange);
  setInterval(() => { if (autoPosEnabled) updateAutoPosition(); }, 600);
  setInterval(() => { if (hideNativeOn) { injectShadowHide(); hideNativeTextTracks(); } }, 2000);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "GET_CLIP") { sendResponse({ base: lastCacheBase || clipBaseId(), title: document.title }); return; } // popup → "this video" cache + per-clip settings
    if (msg.type === "AUDIO_CUE") onAudioCue(msg.text);
    else if (msg.type === "AUDIO_STOP") stopAudio();
    else if (msg.type === "AUDIO_ERROR") setStatus("Audio: " + msg.error, true);
  });

  // Full cue list / subtitle-file URL captured by subs-intercept.js (MAIN world).
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || !d.__copilotSubs) return;
    if (d.type === "SUBS_CUES") onInterceptedCues(d.cues);          // parsed full cue list (legacy path)
    else if (d.type === "SUBS_RESET") { dropInterceptedCues(); schedule(); } // live channel switched → drop the previous channel's cues + restart fresh
    else if (d.type === "SUBS_URL") fetchSubsByUrl(d.url);          // discovered subtitle URL → fetch via worker
    else if (d.type === "SUBS_TEXT") {                              // raw subtitle file body (Netflix sniffer)
      try {
        const cues = parseSubtitleFile(d.text || "");
        const maxStart = cues.length ? cues[cues.length - 1].startMs : 0;
        // Only adopt it if the timing is sane (≥3 cues, last cue between 1s and 6h).
        // A garbled parse (e.g. tick-based timing we don't yet handle) is REJECTED
        // so it can't wreck the working reactive scrape — but is logged so it can
        // be fixed. This is how Netflix upgrades from reactive to look-ahead.
        const sane = cues.length >= 3 && maxStart > 1000 && maxStart < 21600000;
        console.info("[CopilotSubs] SUBS_TEXT →", cues.length, "cues, lastStart=" + Math.round(maxStart / 1000) + "s, adopted=" + sane);
        if (sane) onInterceptedCues(cues);
      } catch (e) { console.warn("[CopilotSubs] SUBS_TEXT parse failed:", e && e.message); }
    }
    else if (d.type === "SUBS_TIME") {
      mainClockMs = d.t; mainClockAt = performance.now(); mainClockPaused = !!d.paused;
      // Clip switch (page world reports the playing element's id): drop stale
      // cues and re-fetch the new clip's subtitle file.
      if (!d.paused && d.id) { // only track the clip that is actually playing
        if (mainVideoId && d.id !== mainVideoId) { // a real clip switch
          dropInterceptedCues(); schedule();
        }
        mainVideoId = d.id;
      }
    }
  });

  for (const a of window.__copilotAdapters || []) a.onNavigate && a.onNavigate(schedule);
  // React the instant a different clip starts playing (capture phase: the media
  // 'play' event doesn't bubble) — far snappier than waiting for the poll, so we
  // switch clips before the old clip's loop can paint a stale line.
  document.addEventListener("play", () => schedule(), true);
  // Keep the subtitle font matched to the player size as it changes (theater mode,
  // window resize, fullscreen) without re-running the whole engine.
  setInterval(sizeOverlay, 1000);
  // Catch an extension reload even while idle (no pump running), so the orphaned
  // script halts and shows the refresh hint instead of lingering.
  setInterval(extAlive, 3000);
  // Re-evaluate on a real clip change. We key on the STABLE, URL-derived clip id
  // (not the per-element videoId, which oscillates on multi-video pages like a DW
  // article and used to churn the cue list). A changed clip id drops the previous
  // clip's intercepted file so it can't bleed; a changed href reschedules.
  let lastUrl = location.href, lastClip = currentClipId();
  setInterval(() => {
    const clip = currentClipId();
    if (clip !== lastClip) { lastClip = clip; dropInterceptedCues(); schedule(); }
    else if (location.href !== lastUrl) { lastUrl = location.href; schedule(); }
  }, 1000);

  schedule();
})();
