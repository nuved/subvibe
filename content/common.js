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
    translateOn: true,   // false = "Original" mode: style the native captions, no translation
    targets: ["en"],     // one or more languages to show (multiple subtitles)
    showOriginal: true,  // also show the original spoken line (dual subtitles) — also
                         // means there's always a line to show even before a key is added
    hideNative: true,    // hide the site's own captions to avoid duplicates by default
                         // (SubVibe re-renders the same line, so the native one is redundant)
    position: "bottom",  // bottom | top | auto | custom (user-dragged)
    linePositions: {},   // custom mode: slot key ("__orig"|lang) → {x,y} fraction (per-segment)
    size: "md",          // fraction of video height (e.g. 0.03) — legacy "sm|md|lg|xl" names still accepted
    stylePreset: "classic", // named look from shared/presets.js: classic | youtube | tiktok | pill | snapchat | cinema | minimal
    styleCustom: {},        // sparse tweaks on top of the preset: { font, color, bg, bgColor, bgOpacity, edge }
    syncOffset: 0,       // seconds; + shows subtitles earlier, − later
    karaokeHl: true,     // karaoke fill: words already spoken light up in --cs-hl
                         // (exact per-word times on YouTube ASR tracks, estimated elsewhere)
    karaokeStyle: "classic", // karaoke highlight look: classic | neon-cyan | neon-magenta | ember | aurora
    audioFallback: false, // transcribe audio ONLY when a video has no captions
    audioDeviceId: "",    // chosen input device (e.g. BlackHole)
    debugHud: false,      // on-video debug panel (engine mode + caption-file pipeline)
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
  function haltOrphaned(note) {
    if (window.__svDub) try { window.__svDub.detach(); } catch {}
    if (streamCleanup) { try { streamCleanup(); } catch {} streamCleanup = null; }
    try { cancelAnimationFrame(rafId); } catch {}
    try { cancelAnimationFrame(audioRaf); } catch {}
    const el = document.getElementById("copilot-subs");
    const s = el && el.querySelector(".copilot-subs__status");
    if (s) { s.textContent = note || "SubVibe was updated — refresh this tab to continue."; s.classList.add("show"); }
    const b = document.getElementById("sv-board"); // the story board says it too, where the eye is
    if (b) { const n = document.createElement("div"); n.className = "svb-dead"; n.textContent = note || "SubVibe was updated — refresh this tab to continue."; b.insertBefore(n, b.firstChild.nextSibling); }
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
  // "Receiving end does not exist": nobody is listening — the extension's
  // background worker is not running (its process crashed, or the extension was
  // reloaded under this tab). Chrome wakes an idle worker for a message, so this
  // is not the idle case. Say what to do instead of "Translation failed".
  const isNoReceiver = (m) => /Receiving end does not exist|Could not establish connection/i.test(m || "");
  const NO_RECEIVER = "SubVibe's background isn't running — reload the extension (brave://extensions → SubVibe → Reload); if the browser just updated itself, relaunch it. Then refresh this tab.";
  function deadReply(m) {
    if (isOrphanError(m)) { contextDead = true; try { haltOrphaned(); } catch {} return { error: "SubVibe was reloaded — refresh the tab.", dead: true }; }
    if (isNoReceiver(m)) { contextDead = true; try { haltOrphaned(NO_RECEIVER); } catch {} return { error: NO_RECEIVER, dead: true }; }
    return null;
  }
  function send(msg) {
    return new Promise((resolve) => {
      if (!extAlive()) { resolve({ error: "SubVibe was reloaded — refresh the tab.", dead: true }); return; }
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          const le = chrome.runtime.lastError;
          if (le) {
            const m = le.message || "messaging error";
            resolve(deadReply(m) || { error: m, dead: false });
          } else resolve(resp);
        });
      } catch (e) {
        const m = String((e && e.message) || e);
        resolve(deadReply(m) || { error: m, dead: false });
      }
    });
  }

  // Per-clip settings: each captured video keeps its OWN targets / position / size /
  // sync / line-layout, keyed by the SAME stable id as its cache (clipBaseId). The
  // flat storage keys are the GLOBAL DEFAULTS a new clip starts from; clipOverrides[base]
  // layers this clip's own changes on top — so a tweak on one video (or live channel)
  // never bleeds onto another. sync defaults to 0 per clip.
  async function getSettings() {
    const s = await chrome.storage.local.get(["enabled", "translateOn", "targets", "showOriginal", "hideNative", "position", "linePositions", "size", "stylePreset", "styleCustom", "syncOffset", "karaokeHl", "karaokeStyle", "storyBoard", "tipsAhead", "tmdbKey", "audioFallback", "audioDeviceId", "translationProvider", "debugHud", "clipOverrides"]);
    const { clipOverrides, ...flat } = s;
    const ov = (clipOverrides && clipOverrides[clipBaseId()]) || {};
    const merged = { ...DEFAULTS, ...flat, ...ov };
    // "Original" mode (translateOn === false): drop every target so not a single
    // line is sent to the translator (zero cost), and force the original line on
    // so there's still something to style/karaoke/resync. One gate, read by all.
    if (merged.translateOn === false) { merged.targets = []; merged.showOriginal = true; }
    return merged;
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

  let lastMainEl = null; // sticky main — see below
  function liveVideoEl(fallback) {
    // Best-effort pick of the element being watched. NOTE: on MSE players the
    // isolated content-script world can't read live media state, so the real
    // playhead comes from the page-world clock relay (mainClockMs), not here.
    const vids = [...document.querySelectorAll("video")];
    const playing = vids.filter((v) => !v.paused && !v.ended);
    // Prefer the LARGEST playing video — the main content. Picking the furthest-
    // along one let a small ad / hover-preview video (with a totally different
    // time) hijack the playhead, flipping the shown cue on/off → a fast blink.
    let pick = null;
    if (playing.length) pick = playing.reduce((a, b) => ((b.clientWidth * b.clientHeight) > (a.clientWidth * a.clientHeight) ? b : a));
    // STICKY MAIN (same rule as the page-world relay): when the main player is
    // PAUSED, a playing hover-preview becomes the only candidate — its 0-6s
    // loop hijacks the playhead (early cues shown) and its NaN/∞ duration made
    // isLiveStream flap true, waking the live auto-calibrator on plain VOD
    // (the "auto offset 15s" incident). Under half the followed element's size
    // ⇒ it's a preview/ad: keep the main, even paused.
    if (pick && lastMainEl && lastMainEl.isConnected && pick !== lastMainEl
        && (pick.clientWidth * pick.clientHeight) < 0.5 * (lastMainEl.clientWidth * lastMainEl.clientHeight)) pick = lastMainEl;
    if (!pick) {
      if (lastMainEl && lastMainEl.isConnected) pick = lastMainEl;
      else { const a = adapter && adapter.getVideoEl && adapter.getVideoEl(); pick = (a && a.isConnected) ? a : fallback; }
    }
    if (pick) lastMainEl = pick;
    return pick;
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
  // Translated lines pass through SV_QUOTES (shared/quotes.js) so German-style
  // „quotes“ become the target language's marks. Guarded: harness pages that
  // don't load the shared file just render unchanged text.
  const fixQ = (s, lang) => (globalThis.SV_QUOTES ? globalThis.SV_QUOTES.fix(s, lang) : s);
  // Cross-cue sentence groups translate as ONE unit and every member cue holds
  // the identical full translation — shown raw, a short original line sat under
  // a whole translated paragraph. Slice the group translation across its cues
  // (weights = original text share) so the translated line paces with the
  // original. Display-only; strict equality keeps per-cue cache rows untouched.
  function groupSlice(c, tg) {
    const mine = (c.t && c.t[tg]) || "";
    const grp = c.grp;
    if (!grp || !mine || grp.cues.length < 2 || !globalThis.SV_TEXTSLICE) return mine;
    if (mine !== ((grp.t && grp.t[tg]) || "")) return mine; // per-cue translation — already paced
    if (!grp.__sl) grp.__sl = {};
    let sl = grp.__sl[tg];
    if (!sl || sl.src !== mine) {
      sl = grp.__sl[tg] = { src: mine, parts: SV_TEXTSLICE.split(mine, grp.cues.map((q) => ((q.original || "").length || 1))) };
    }
    return sl.parts[grp.cues.indexOf(c)] || "";
  }
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
  let engineGen = 0;         // bumped by every non-deduped start(); a start whose gen is stale after an await was SUPERSEDED and must die, not build
  let liveOffsetMs = 0;      // manual sync nudge (+ = earlier) — applied to LIVE streams only (recorded titles are exact)
  let liveOffsetChangedAt = -Infinity, liveClampNotedAt = -1; // when the nudge last changed (−∞ = never — early-page clamps must not read as a user action); which change already got its clamp note
  let liveAutoOffsetMs = 0;  // AUTO sync: shift so our cues coincide with the player's OWN on-screen caption
  let calibAt = 0, calibMatched = false, calibMisses = 0;
  let isLiveStream = null;   // latched liveness verdict: true = live, false = a real finite duration was seen (VOD),
                             // null = no verdict yet this page — only this state may be armed from a PAUSED video
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
  let userTrackPick = null;   // the native track the PLAYER last showed — the viewer's language choice.
                              // Remembered because hideNative flips "showing" back off moments later.
  let nativeCueTrack = null;  // which native track supplied the held cue list (null = file/URL-sourced)
  let cueListActive = false;  // perfect-sync cue-list mode is the running engine
  let mainClockMs = null, mainClockAt = 0, mainClockPaused = false; // playhead relayed from the page world
  let lastClipChangeAt = 0; // SPA clip switches stamp this; 0 = initial page load (no hold-back)
  let mainVideoId = null;     // id of the playing clip, reported from the page world (detects clip switch)
  let audioActive = false;   // live audio-transcription mode is running
  let audioRaf = 0;
  let audioCues = null, audioDefs = [], audioEls = {};

  // Inject bundled fonts with ABSOLUTE extension URLs. A relative url() in
  // overlay.css resolves against the page origin (e.g. www.zdf.de/.../fonts/…)
  // and 404s, so the text falls back to a system font. Vazirmatn (Persian/RTL)
  // is ALWAYS injected; style fonts (Baloo 2 for the TikTok/Pill presets and the
  // "Rounded" custom choice) are injected on demand by applyAppearance.
  const FONT_FACES = {
    vazirmatn: [
      { family: "Vazirmatn", weight: 400, file: "fonts/Vazirmatn-Regular.woff2" },
      { family: "Vazirmatn", weight: 700, file: "fonts/Vazirmatn-Bold.woff2" },
    ],
    // Subset per script with unicode-range (Google Fonts subsets), so e.g. a
    // Polish translation doesn't mix Baloo glyphs with fallback-font diacritics.
    baloo2: [
      { family: "Baloo 2", weight: 800, file: "fonts/Baloo2-ExtraBold-latin.woff2",
        range: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
      { family: "Baloo 2", weight: 800, file: "fonts/Baloo2-ExtraBold-latin-ext.woff2",
        range: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF" },
    ],
  };
  function ensureFont(keys) {
    for (const k of ["vazirmatn", ...(keys || [])]) {
      const id = "copilot-font-" + k;
      if (document.getElementById(id) || !FONT_FACES[k]) continue;
      try {
        const st = document.createElement("style");
        st.id = id;
        st.textContent = FONT_FACES[k].map((f) =>
          `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-display:swap;` +
          `src:url('${chrome.runtime.getURL(f.file)}') format('woff2');` +
          (f.range ? `unicode-range:${f.range};` : "") + "}"
        ).join("");
        (document.head || document.documentElement).appendChild(st);
      } catch {}
    }
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

  // All caption text goes through here: the text lives in an inner span so pill
  // styles can give each WRAPPED line its own box (see overlay.css). The row's
  // textContent still reads the same text, so `el.textContent !== txt` guards
  // at the call sites keep working unchanged.
  //
  // Karaoke mode: `units` = [{s: absolute startMs, t: word}]. Each word gets its
  // own span, separated by REAL space text nodes — so row.textContent === txt
  // and the change-guards above stay valid. updateSung() then colors the words
  // whose start time the playhead has passed.
  function setLineText(row, txt, units) {
    let span = row.firstElementChild;
    if (!span || !span.classList.contains("copilot-subs__text")) {
      row.textContent = "";
      span = document.createElement("span");
      span.className = "copilot-subs__text";
      row.appendChild(span);
    }
    if (units && units.length > 1) {
      span.textContent = "";
      const spans = [];
      units.forEach((u, i) => {
        if (i) span.appendChild(document.createTextNode(" "));
        const w = document.createElement("span");
        w.className = "copilot-subs__w";
        w.textContent = u.t;
        span.appendChild(w);
        spans.push(w);
      });
      row.__svW = { units, spans, k: -1 };
    } else {
      if (span.textContent !== txt) span.textContent = txt;
      row.__svW = null;
    }
  }

  // No word timing in the file (manual subs, translations, dub audio): spread
  // the words across [startMs,endMs], weighted by length + a per-word floor —
  // the classic karaoke approximation. Joining the result with " " reproduces
  // the input EXACTLY only when it's single-space normalized; lineUnits checks.
  function estimateUnits(text, startMs, endMs) {
    const words = (text || "").split(" ").filter(Boolean);
    if (!words.length) return [];
    const span = Math.max(300, (endMs || startMs) - startMs);
    const wt = words.map((w) => w.length + 2);
    const total = wt.reduce((a, b) => a + b, 0);
    let acc = 0;
    return words.map((w, i) => {
      const s = startMs + (span * acc) / total;
      acc += wt[i];
      return { s, t: w };
    });
  }

  // Word units for the line a row is about to show. Original lines show the
  // whole sentence GROUP, so exact per-cue offsets (cue.w) and estimated cues
  // mix into one absolute timeline; translated lines carry one shared text per
  // group, estimated over the group's span. Returns null when units wouldn't
  // reassemble into txt (odd spacing) — the line then renders plain, no churn.
  function lineUnits(c, target, txt) {
    if (!c || !txt) return null;
    const cs = c.grp && (txt === c.grp.orig || (target && c.grp.t && txt === c.grp.t[target])) ? c.grp.cues : [c];
    const endOf = (q) => q.endMs || q.startMs + 2500;
    let units;
    if (!target) {
      units = [];
      for (const q of cs) {
        if (q.w && q.w.length > 1) for (const x of q.w) units.push({ s: q.startMs + (x.o || 0), t: x.t });
        else units.push(...estimateUnits(q.original, q.startMs, endOf(q)));
      }
    } else if (c.grp && c.grp.t && c.grp.t[target] && txt !== c.grp.t[target]) {
      units = estimateUnits(txt, c.startMs, endOf(c)); // sliced group line — pace within THIS cue
    } else {
      units = estimateUnits(txt, cs[0].startMs, endOf(cs[cs.length - 1]));
    }
    if (units.length > 1 && units.map((u) => u.t).join(" ") === txt) return units;
    // Exact offsets didn't reassemble (spacing/punct drift) — estimate from txt itself.
    units = estimateUnits(txt, cs[0].startMs, endOf(cs[cs.length - 1]));
    return units.length > 1 && units.map((u) => u.t).join(" ") === txt ? units : null;
  }

  // Sweep the fill: color spans 0..k-1 where k = words already started at t.
  // DOM writes only when k changes (word boundaries), not per frame.
  function updateSung(row, t) {
    const W = row.__svW;
    if (!W) return;
    let k = 0;
    while (k < W.units.length && W.units[k].s <= t) k++;
    if (k !== W.k) {
      for (let j = 0; j < W.spans.length; j++) W.spans[j].classList.toggle("sung", j < k);
      W.k = k;
    }
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
        // Udemy: the rendered caption is div[data-purpose="captions-cue-text"]
        // (class captions-display-module--captions-cue-text--<hash>). Match the stable
        // data-purpose + class prefix; opacity:0 (not visibility:hidden) so the live
        // scrape can still read it before the .vtt file is intercepted.
        "[data-purpose='captions-cue-text'],[class*='captions-display-module--captions-cue-text'],[class*='captions-cue-text']{opacity:0 !important;} " +
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
  // size is a FRACTION of the video height (popup slider, e.g. 0.03); the named
  // tiers are the legacy S/M/L/XL values still sitting in existing users'
  // storage — interpreted on read, never migrated.
  const SIZE_FACTORS = { sm: 0.024, md: 0.030, lg: 0.038, xl: 0.048 };
  let appearanceSize = "md";
  function sizeOverlay() {
    const el = document.getElementById("copilot-subs");
    if (!el) return;
    const v = liveVideoEl(adapter && adapter.getVideoEl ? adapter.getVideoEl() : null);
    const h = (v && v.clientHeight) || el.clientHeight || 0;
    if (!h) return;
    const f = typeof appearanceSize === "number" && isFinite(appearanceSize)
      ? appearanceSize
      : (SIZE_FACTORS[appearanceSize] || SIZE_FACTORS.md);
    const px = Math.max(9, Math.min(80, Math.round(h * f)));
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
  // A dragged line's CENTER is clamped, but a long sentence's BOX can still
  // hang past the player edge (subtitles "outside the view"). Nudge the box
  // back inside via the --cs-shift-* transform correction; the stored drag
  // fraction — the user's intent — is never rewritten. Re-runs automatically
  // when a line's size changes (every new cue) via a ResizeObserver.
  function keepLineInside(ln) {
    const overlay = document.getElementById("copilot-subs");
    if (!overlay || !overlay.classList.contains("copilot-pos-custom")) return;
    const o = overlay.getBoundingClientRect(), r = ln.getBoundingClientRect();
    if (!o.width || !r.width) return;
    const curX = parseFloat(ln.style.getPropertyValue("--cs-shift-x")) || 0;
    const curY = parseFloat(ln.style.getPropertyValue("--cs-shift-y")) || 0;
    const left = r.left - curX, right = r.right - curX, top = r.top - curY, bottom = r.bottom - curY;
    let sx = 0, sy = 0;
    if (right > o.right - 4) sx = o.right - 4 - right;
    if (left + sx < o.left + 4) sx = o.left + 4 - left;
    if (bottom > o.bottom - 4) sy = o.bottom - 4 - bottom;
    if (top + sy < o.top + 4) sy = o.top + 4 - top;
    ln.style.setProperty("--cs-shift-x", Math.round(sx) + "px");
    ln.style.setProperty("--cs-shift-y", Math.round(sy) + "px");
  }
  let lineFitRO = null;
  function layoutCustomLines() {
    const overlay = document.getElementById("copilot-subs");
    if (!overlay || !overlay.classList.contains("copilot-pos-custom")) return;
    if (!lineFitRO && window.ResizeObserver) lineFitRO = new ResizeObserver((es) => es.forEach((e) => keepLineInside(e.target)));
    const lines = [...overlay.querySelectorAll(".copilot-subs__line")];
    lines.forEach((ln, i) => {
      const key = ln.dataset.csKey || ("slot" + i);
      const p = linePositions[key] || defaultSlotPos(i, lines.length);
      ln.style.left = (clampFrac(p.x, 0.5) * 100).toFixed(2) + "%";
      ln.style.top = (clampFrac(p.y, 0.85) * 100).toFixed(2) + "%";
      if (lineFitRO && !ln._csFit) { ln._csFit = true; lineFitRO.observe(ln); }
      keepLineInside(ln);
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
      // While the pointer drives, no fit-correction — it would fight the hand.
      dragState.line.style.setProperty("--cs-shift-x", "0px");
      dragState.line.style.setProperty("--cs-shift-y", "0px");
    });
    const end = (e) => {
      if (!dragState || e.pointerId !== dragState.id) return;
      const moved = dragState.moved;
      const line = dragState.line;
      try { line.releasePointerCapture(e.pointerId); } catch {}
      overlay.classList.remove("copilot-dragging");
      dragState = null;
      keepLineInside(line); // released near an edge → pull the box back into the player
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
    // Legacy named tiers only — a numeric (slider) size has no class; sizing is
    // all --cs-font anyway and an unremovable "copilot-size-0.03" would pile up.
    if (SIZE_FACTORS[appearanceSize]) el.classList.add("copilot-size-" + appearanceSize);
    // Visual style: preset + custom tweaks → CSS vars on the overlay (pure
    // presentation — the storage watcher applies these live, no restart).
    const style = window.SV_RESOLVE_STYLE ? window.SV_RESOLVE_STYLE(settings) : null;
    if (style) {
      for (const k in style.vars) el.style.setProperty(k, style.vars[k]);
      el.classList.toggle("copilot-style-pill", style.pill);
      el.classList.toggle("copilot-style-banner", style.banner);
      ensureFont(style.fonts);
    }
    // Karaoke highlight style: one overlay class drives the .sung look
    // (styles/overlay.css). Unknown/missing values render classic.
    const HL_KEYS = ["classic", "neon-cyan", "neon-magenta", "ember", "aurora"];
    const hl = HL_KEYS.includes(settings.karaokeStyle) ? settings.karaokeStyle : "classic";
    for (const k of HL_KEYS) el.classList.toggle("copilot-hl-" + k, k === hl);
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
    if (window.__svDub) try { window.__svDub.detach(); } catch {}
    const el = document.getElementById("copilot-subs");
    if (el) el.remove();
    { const b = document.getElementById("sv-board"); if (b) b.remove(); const s = document.getElementById("sv-strip"); if (s) s.remove(); for (const el of document.querySelectorAll("[data-sv-fit]")) { el.style.right = el.dataset.svFitRight || ""; el.style.width = el.dataset.svFitWidth || ""; el.style.bottom = el.dataset.svFitBottom || ""; el.style.height = el.dataset.svFitHeight || ""; delete el.dataset.svFit; } }
  }

  // ─── track engine (YouTube) ──────────────────────────────────────────────────

  // Original spoken language = the ASR track if present, else the first track.
  function pickOriginalTrack(tracks) {
    if (!tracks || !tracks.length) return null;
    // ASR = the spoken language, always the best "original". Otherwise prefer the
    // track the site itself marks default — tracks[0] is alphabetical on multi-
    // track uploads (a DW German video listed Arabic first, so "the original"
    // came out Arabic and everything downstream translated the wrong language).
    return tracks.find((t) => t.kind === "asr") || tracks.find((t) => t.isDefault) || tracks[0];
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
          setLineText(l.el, txt);
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
  async function startStream(settings, video, gen) {
    const site = adapter.site;
    const videoId = adapter.getVideoId();
    if (!videoId) return;
    const targets = (settings.targets || []).slice();

    const cacheKey = `${site}:${videoId}:stream`;
    const loaded = (await send({ type: "CACHE_GET", key: cacheKey }))?.track;
    // A newer start() may have committed a cuelist engine while that cache read
    // was in flight. Building the scrape engine now would bulldoze it (wipe its
    // overlay stack, cancel its rAF) while leaving cueListActive stuck true —
    // the exact deadlock the adopt-harness reproduces. Superseded → vanish.
    if (gen !== undefined && (gen !== engineGen || liveMode)) { dbgSub.stale = "scrape build superseded (during cache read)"; return; }
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
      row.className = "copilot-subs__line" + (d.target ? "" : " copilot-subs__line--orig");
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
        const txt = c ? (d.target ? fixQ(groupSlice(c, d.target), d.target) : c.original) : "";
        if (el.textContent !== txt) {
          setLineText(el, txt);
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

    // Claude bills the ~1k-token instruction prompt on EVERY request, so the
    // per-line reactive path was ~90% prompt overhead — a live evening hit
    // ~1.4M tokens/hour. With Claude, coalesce heard lines for a beat (4 lines
    // or 1.8s) and translate them as ONE batch; OpenAI keeps the instant
    // per-line path (prompt overhead is pennies there, latency wins).
    const coalesce = settings.translationProvider === "claude";
    let sq = [], sqTimer = 0, sqBusy = false;
    async function flushStreamQ() {
      sqTimer = 0;
      if (!adapter || !adapter.matches()) { sq = []; return; } // navigated away — don't spend on dead cues
      if (sqBusy || !sq.length) return;
      sqBusy = true;
      const batch = sq.splice(0);
      try {
        for (const tg of targets) {
          const todo = batch.filter((b) => !(textCache.get(b.text) || {})[tg]);
          if (!todo.length) continue;
          const resp = await send({ type: "TRANSLATE", cues: todo.map((b) => b.text), source: "auto", target: tg,
            context: todo[0].context, site: adapter?.site, title: SV_TITLE.clean(document.title), base: lastCacheBase || clipBaseId() });
          if (resp?.dead) return; // extension reloaded — orphaned script, stop quietly
          if (resp?.error) {
            dbg("ERR " + tg + ": " + resp.error);
            setStatus(`Translation failed (${langLabel(tg)}): ${resp.error}`, true);
            continue;
          }
          todo.forEach((b, i) => {
            const out = resp.lines && resp.lines[i];
            if (!out) { dbg(tg + " — empty reply from model"); return; }
            const k = textCache.get(b.text) || {};
            k[tg] = out; textCache.set(b.text, k);
            b.cue.t[tg] = out;
            dbg(tg + " ✓ " + out.slice(0, 28));
          });
        }
        persist();
      } finally {
        sqBusy = false;
        if (sq.length && !sqTimer) sqTimer = setTimeout(flushStreamQ, 400); // lines arrived mid-flush
      }
    }
    function queueStreamLine(cue, text, context) {
      sq.push({ cue, text, context });
      if (sq.length >= 4) { clearTimeout(sqTimer); flushStreamQ(); }
      else if (!sqTimer) sqTimer = setTimeout(flushStreamQ, 1800);
    }

    const poll = setInterval(async () => {
      if (!adapter || !adapter.matches()) return; // adapter can be nulled mid-flight on clip nav
      const text = (adapter.readNativeText ? adapter.readNativeText() : "").replace(/\s+/g, " ").trim();
      if (text === lastText) return;
      const nowMs = (video.currentTime || 0) * 1000;
      if (curCue && curCue.endMs == null) curCue.endMs = nowMs;
      lastText = text;
      // Mode stamp for diagnosis: if this ever shows while a "perfect-sync ON"
      // run is believed active, a scrape run is what is actually rendering.
      try { document.documentElement.dataset.csDiag = JSON.stringify({ mode: "scrape", heard: (text || "").slice(0, 48), cues: cues.length, play: +((video.currentTime || 0)).toFixed(1) }); } catch {}
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
      if (coalesce) {
        let need = false;
        for (const tg of targets) { if (known[tg]) cue.t[tg] = known[tg]; else need = true; }
        if (need) queueStreamLine(cue, text, context);
        else persist();
        return;
      }
      for (const tg of targets) {
        if (known[tg]) { cue.t[tg] = known[tg]; continue; }
        const resp = await send({ type: "TRANSLATE", cues: [text], source: "auto", target: tg, context,
          site: adapter?.site, title: SV_TITLE.clean(document.title), base: lastCacheBase || clipBaseId() }); // meta: the Activity log needs a name for the row
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
    // YouTube: we can't fetch timedtext ourselves (a token-less request returns an
    // empty body — see subs-intercept.js), but the PLAYER fires its pot-bearing
    // fetch the moment a caption track is enabled. So instead of waiting ~32s to
    // ASK the user to press CC, ask the page world to switch the track on now —
    // hideNative keeps it invisible, and the intercepted URL upgrades this scrape
    // run to perfect-sync (real cue timing + karaoke) within seconds.
    // Gated on hideNative: with it OFF the site's captions actually render, so
    // auto-enabling them would paint doubles and persist a CC preference the
    // user never chose — those users keep the manual "turn on CC" advice.
    let ccNudges = 0;
    const ccNudge = (adapter && adapter.site === "youtube" && settings.hideNative !== false)
      ? setInterval(() => {
          if (cueListActive || (interceptedCues && interceptedCues.length) || ++ccNudges > 4) { clearInterval(ccNudge); return; }
          window.postMessage({ __copilotSubs: true, type: "NEED_CAPTIONS" }, "*");
        }, 2500)
      : null;
    // Same-origin <track> sources (e.g. DW) expose the full cue list through the
    // <video>'s textTracks once it loads — even with the site's own captions
    // toggled off. Poll for it and, when present, upgrade from line-by-line
    // scraping to perfect-sync cue-list mode.
    const upgrade = setInterval(() => {
      // THE RELEASE VALVE (found via the on-video HUD: "intercepted: 442 cues
      // (clip ok)" + "last start: deduped (run unchanged)" + starts climbing —
      // the file was held while every restart bounced off the dedupe gate).
      // While scraping with a fetched file in hand, force adoption: null the
      // run key so the dedupe CANNOT bounce, and retry every tick until
      // cue-list mode actually takes over.
      if (interceptedCues && interceptedCues.length && interceptedClipId === currentClipId() && !cueListActive) {
        dbgSub.adopt = "upgrade→adopting file " + interceptedCues.length;
        currentRunKey = null;
        schedule();
        return;
      }
      // YouTube SPA nav: the reused <video>'s track list can still hold the
      // PREVIOUS clip's cues for a beat (their console showed a 150-cue run
      // from the prior video painting onto the next one). Give the real
      // subtitle file — whose fetch the CC nudge triggers — an 8s head start
      // before trusting the native track on a freshly switched clip.
      if (adapter && adapter.site === "youtube" && lastClipChangeAt && performance.now() - lastClipChangeAt < 8000) return;
      const full = readVideoCueList(video);
      // Never merge rolling native cues OVER a held file — that's the caption
      // pollution the cue-list reread already guards against (fileCoversClip);
      // the scrape upgrade path was missing the same guard.
      if (!(interceptedCues && interceptedCues.length) && full && full.length > 3) onInterceptedCues(full);
    }, 2000);
    streamCleanup = () => { clearInterval(poll); clearTimeout(watchdog); clearInterval(upgrade); if (ccNudge) clearInterval(ccNudge); };
    applyHideNative(settings.hideNative);
    setStatus(`Live mode → ${targets.map(langLabel).join(" · ")}. Turn ON the player's CC / subtitles if you see nothing.`);
  }

  // ─── cue-list mode: the browser exposes the whole caption track (e.g. ZDF) ────

  // Read the full WebVTT cue list from the <video>'s text tracks, if readable
  // (cross-origin tracks return null cues — then we can't, and fall back).
  function readVideoCueList(video) {
    if (!video || !video.textTracks) return null;
    hookTrackSwitch(video);
    let tracks = [...video.textTracks].filter((t) => !t.kind || t.kind === "subtitles" || t.kind === "captions");
    // Force the track to LOAD its cues without rendering them ("hidden"): this
    // means we get the text even when the site's subtitles look "off", and
    // nothing of the site's is drawn on screen.
    for (const tt of tracks) { if (tt.mode === "disabled") { try { tt.mode = "hidden"; } catch {} } }
    // The PLAYER's selected track wins — "first track with cues" served whatever
    // language happened to load first, so switching the site's subtitle menu
    // mid-video changed nothing until a hard refresh. "showing" is the live
    // selection; userTrackPick remembers it after hideNative flips it off.
    const preferred = tracks.find((t) => t.mode === "showing") || (tracks.includes(userTrackPick) ? userTrackPick : null);
    if (preferred) tracks = [preferred, ...tracks.filter((t) => t !== preferred)];
    for (const tt of tracks) {
      const cues = tt.cues;
      if (!cues || !cues.length) continue;
      const out = [];
      for (let i = 0; i < cues.length; i++) {
        const c = cues[i];
        const text = (c.text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (text) out.push({ startMs: Math.round((c.startTime || 0) * 1000), endMs: Math.round((c.endTime || 0) * 1000), text });
      }
      if (out.length) { out.sort((a, b) => a.startMs - b.startMs); nativeCueTrack = tt; return out; }
    }
    return null;
  }

  // React to the PLAYER's subtitle menu: switching tracks fires "change" on the
  // TextTrackList with NO network fetch (multi-track sites keep every language
  // loaded), so the URL pipeline never sees it. When the shown track is a
  // different one than the cue list we hold came from, drop the held list and
  // re-adopt — the translate cache keys on cue text, so the new language simply
  // translates fresh while the old one stays cached.
  const trackSwitchHooked = new WeakSet();
  let trackSwitchRetry = 0;
  function hookTrackSwitch(video) {
    if (!video.textTracks || trackSwitchHooked.has(video.textTracks)) return;
    trackSwitchHooked.add(video.textTracks);
    const onSwitch = (retries) => {
      const tracks = [...video.textTracks].filter((t) => !t.kind || t.kind === "subtitles" || t.kind === "captions");
      const showing = tracks.find((t) => t.mode === "showing");
      if (showing) userTrackPick = showing; // remember before hideNative flips it off again
      const pick = showing || (tracks.includes(userTrackPick) ? userTrackPick : null);
      // Only a real switch restarts anything: native-sourced cues in hand, and the
      // player now shows a DIFFERENT track than the one they came from. (URL/file
      // sites refetch on switch — fetchSubsByUrl already owns that path.)
      if (!pick || !nativeCueTrack || pick === nativeCueTrack || interceptedUrl) return;
      if (!(interceptedCues && interceptedCues.length)) return;
      if (!pick.cues || !pick.cues.length) {
        // Lazy <track>: cue arrival fires no "change", so poll briefly — the
        // hidden nudge starts the load and one of these ticks sees it land.
        try { if (pick.mode === "disabled") pick.mode = "hidden"; } catch {}
        if (retries < 8) trackSwitchRetry = setTimeout(() => onSwitch(retries + 1), 750);
        return;
      }
      console.info("[CopilotSubs] player switched subtitle track (" + (nativeCueTrack.language || nativeCueTrack.label || "?") + " → " + (pick.language || pick.label || "?") + ") — re-adopting");
      interceptedCues = null; interceptedClipId = null; nativeCueTrack = null;
      const full = readVideoCueList(video); // preference now lands on the new pick
      if (full && full.length > 3) onInterceptedCues(full);
      cueListActive = false; currentRunKey = null;
      schedule();
    };
    video.textTracks.addEventListener("change", () => { clearTimeout(trackSwitchRetry); onSwitch(0); });
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
    // HUD forensics: record what THIS call saw, so "file not usable" names its reason.
    dbgSub.inter = interceptedCues ? (interceptedClipId === currentClipId() ? "ok:" + interceptedCues.length : "CLIP≠ " + interceptedClipId + " vs " + currentClipId()) : "null";
    if (interceptedCues && interceptedCues.length && interceptedClipId === currentClipId()) return interceptedCues;
    // YouTube: right after a clip switch the reused <video>'s track can still
    // hold the previous clip's ROLLING cues — hold back so the real file (whose
    // fetch the CC nudge triggers) wins the race instead of junk native cues.
    if (adapter && adapter.site === "youtube" && lastClipChangeAt && performance.now() - lastClipChangeAt < 8000) { dbgSub.hold = "clip-change hold " + Math.round((8000 - (performance.now() - lastClipChangeAt)) / 1000) + "s"; return null; }
    dbgSub.hold = "";
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
    userTrackPick = null; nativeCueTrack = null; // a new clip's tracks are new objects — never inherit the pick
    interceptedKey = null; subFilesByKey.clear(); // parsed files belong to the OLD clip
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
          const cue = { startMs, endMs: startMs + (ev.dDurationMs || 2500), text: t };
          // ASR tracks: one seg per word with its own offset — keep for karaoke.
          // Multi-seg manual tracks (split at line breaks) have NO offsets;
          // all-zero o would light the whole line at once, so require a real one.
          const w = [];
          for (const s of ev.segs) {
            const wt = (s.utf8 || "").replace(/\s+/g, " ").trim();
            if (wt) w.push({ o: s.tOffsetMs || 0, t: wt });
          }
          if (w.length > 1 && w.some((x) => x.o > 0)) cue.w = w;
          cues.push(cue);
        }
        if (cues.length) return cues;
      } catch {}
    }
    if (/^﻿?WEBVTT/.test(text.trim())) {
      const cues = [];
      // WebVTT timestamps come in BOTH HH:MM:SS.mmm and the short MM:SS.mmm form
      // (the spec allows omitting hours). Udemy's caption files use MM:SS.mmm, so a
      // pattern that hard-required the hours field matched nothing → 0 cues.
      const TS = "(?:\\d{1,2}:)?\\d{1,2}:\\d{2}[.,]\\d{3}";
      const cueRe = new RegExp(`(${TS})\\s*-->\\s*(${TS})([\\s\\S]*)`);
      // Thumbnail/storyboard preview tracks are ALSO served as .vtt, but each cue's
      // "text" is an image-sprite reference (e.g. thumb-sprites.jpg#xywh=0,0,160,90),
      // not dialogue. Drop those so a storyboard file can't be adopted as captions
      // (a pure-storyboard file then yields 0 cues and is rejected upstream).
      const isThumb = (t) => /#xywh=|\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(t);
      for (const block of text.replace(/\r/g, "").split("\n\n")) {
        const m = block.match(cueRe);
        if (!m) continue;
        const txt = m[3].split("\n").slice(1).join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        if (txt && !isThumb(txt)) cues.push({ startMs: subTimeToMs(m[1]), endMs: subTimeToMs(m[2]), text: txt });
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
  const subFilesByKey = new Map();    // key -> { cues, url }: every file parsed for THIS clip. "Fetched
                                      // once" must not mean "active forever" — switching the player
                                      // original→translated→original re-spots the FIRST key, and without
                                      // this memory the claimed-key skip left the middle track stuck on
                                      // screen. Swap-backs re-adopt from here, no refetch.
  let interceptedKey = null;          // dedup key of the ACTIVE cue list's URL
  // A CLIP-STABLE dedup key. YouTube re-fetches its timedtext with a fresh pot/ei
  // token on every seek (a different URL each time). Keying on v+lang+kind makes
  // those re-fetches resolve to the SAME key → skipped → so a seek doesn't REPLACE
  // the cue list and wipe the pump's in-progress translations. A language switch
  // must still re-fetch — and that needs `tlang` in the key too: YouTube's
  // auto-TRANSLATED tracks reuse the source track's lang (German ASR shown as
  // English = lang=de&tlang=en), so keying on lang alone made switching the
  // player from translated-English back to real German look like a duplicate,
  // and the plugin stayed on English no matter what the player showed.
  function subDedupKey(url) {
    try {
      const u = new URL(url);
      if (/\/api\/timedtext$/.test(u.pathname)) {
        const p = u.searchParams;
        return "yt-tt:" + (p.get("v") || "") + ":" + (p.get("lang") || "") + ":" + (p.get("kind") || "") + ":" + (p.get("tlang") || "");
      }
    } catch {}
    return url;
  }
  // Caption-file pipeline state for the on-video debug HUD — each stage writes
  // its outcome here so a single screenshot shows where adoption died.
  const dbgSub = { spotted: "", fetch: "", adopt: "", hold: "", starts: 0 };

  // Make a parsed subtitle file the ACTIVE cue list and restart the engine on it.
  function adoptSubFile(cues, url, key, how) {
    dbgSub.adopt = how + " " + cues.length;
    interceptedCues = cues;
    interceptedUrl = url;
    interceptedKey = key;
    interceptedClipId = currentClipId(); // tie this file to the clip now playing
    cueListActive = false;
    currentRunKey = null;
    schedule();
  }

  async function fetchSubsByUrl(url) {
    const key = subDedupKey(url);
    if (!url || key === interceptedKey) return; // this track IS the active one (covers token-rotating re-posts)
    const held = subFilesByKey.get(key);
    if (held) { // the player switched BACK to a track we already parsed — swap, don't skip
      console.info("[CopilotSubs] player returned to an earlier subtitle track — re-adopting", key);
      adoptSubFile(held.cues, held.url, key, "switched back:");
      return;
    }
    if (fetchedSubUrls.has(key)) return; // in flight, or given up on
    fetchedSubUrls.add(key); // claim NOW so the 1.5s re-post (subs-intercept.js) can't launch a duplicate fetch
    console.info("[CopilotSubs] fetching subtitle file:", url);
    dbgSub.fetch = "fetching…";
    // YouTube timedtext: the pot token validates against the SAME first-party
    // context the player fetched with (cookies included). The worker's cookieless
    // re-fetch comes back as an empty 200 body — so fetch it same-origin from THIS
    // world first, exactly like the player did. The worker stays the path for
    // cross-origin files (ZDF's utstreaming subdomain), where it's CORS-exempt.
    let resp = null;
    if (/\/api\/timedtext/.test(url) && location.hostname.endsWith("youtube.com")) {
      try { const r = await fetch(url, { credentials: "include" }); resp = { ok: r.ok, status: r.status, text: await r.text() }; } catch {}
    }
    if (!resp || !resp.text) resp = await send({ type: "FETCH_SUBS", url });
    if (!resp || resp.error || !resp.text) {
      // Transport failure is transient — let a later re-post retry, but only a few
      // times, then give up (leave it claimed) so we never hammer a dead URL forever.
      const n = (subFetchFails.get(key) || 0) + 1;
      subFetchFails.set(key, n);
      dbgSub.fetch = "FAILED " + ((resp && (resp.error || (resp.status + (resp.text === "" ? " empty body" : "")))) || "no response") + ` (try ${n}/4)`;
      console.warn("[CopilotSubs] subtitle fetch failed:", resp && (resp.error || resp.status), `(try ${n}/4)`, url);
      if (n < 4) fetchedSubUrls.delete(key);
      return;
    }
    // We HAVE the file. Whatever the parse yields, this URL is DONE — it STAYS
    // claimed even on 0 cues, so a file we can't parse can't trigger an endless
    // re-fetch loop (the re-post would otherwise hammer it ~every 1.5s forever).
    const cues = parseSubtitleFile(resp.text);
    if (!cues.length) {
      dbgSub.fetch = "parsed 0 cues (" + resp.text.length + "B body)";
      console.warn("[CopilotSubs] subtitle file parsed to 0 cues (not TTML/VTT?):", url, resp.text.slice(0, 160));
      return;
    }
    dbgSub.fetch = "OK " + cues.length + " cues";
    console.info(`[CopilotSubs] ${cues.length} cues from subtitle file → perfect-sync`);
    setStatus(`Loaded subtitle file (${cues.length} lines) — perfect sync.`);
    // A subtitle file IS this clip's full cue list — REPLACE, never merge across
    // clips (merging is what bled one clip's lines onto another).
    subFilesByKey.set(key, { cues, url }); // remembered for switch-backs
    if (subFilesByKey.size > 12) subFilesByKey.delete(subFilesByKey.keys().next().value); // bound: a clip has a handful of tracks
    adoptSubFile(cues, url, key, "fetched:");
  }

  // Perfect-sync display: cues carry their own timing, and we translate a window
  // AHEAD of the playhead so each line is ready before it's needed.
  async function runCueListMode(settings, video, cueList, gen) {
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
    const pageTitle = SV_TITLE.clean(document.title), pageUrl = location.href;

    // Cached translations (per target), applied to current AND future cues.
    // Three lookup layers, strictest first: exact startMs; the cue's ORIGINAL
    // text (rows persisted since the `o` field shipped); then an overlapping
    // near-miss on time. The fallbacks exist because caption timings JITTER
    // between variants of the same track (YouTube re-generates ASR, native
    // roll-up cues carry their own timestamps) — an exact-only key turned every
    // millisecond of drift into a paid re-translation of a line we already own.
    const CACHE_NEAR_MS = 250;
    let nearMatchLogs = 0;
    const cacheMaps = {}, cacheStarts = {}, cacheTextMaps = {};
    for (const tg of settings.targets) {
      const cached = (await send({ type: "CACHE_GET", key: `${base}:auto:${tg}` }))?.track;
      const rows = cached?.cues || [];
      cacheMaps[tg] = new Map(rows.map((c) => [c.startMs, c]));
      cacheStarts[tg] = rows.map((c) => c.startMs).sort((a, b) => a - b);
      cacheTextMaps[tg] = new Map(rows.filter((c) => c.o).map((c) => [normCue(c.o), c]));
    }
    // Same fence as startStream: if a newer start() superseded us while the
    // cache reads were in flight, its teardown already revoked our claim —
    // building the overlay/rAF now would fight the newer engine. Vanish.
    if (gen !== undefined && (gen !== engineGen || liveMode)) { dbgSub.stale = "cuelist build superseded (during cache read)"; return; }
    // Nearest LEGACY cached row (no `o` field) within CACHE_NEAR_MS whose time
    // window overlaps the cue's. Rows that know their original are excluded on
    // purpose: the exact/text layers already serve them, and a near-in-time row
    // with DIFFERENT text is the wrong line by definition — assigning it would
    // show a wrong subtitle silently for the whole session, worse than the
    // pennies of a re-translation. Legacy rows can't be text-compared (they
    // only store the translation), so they get a tight window plus a crude
    // length-plausibility check, and every acceptance is logged.
    const nearCacheRow = (tg, cue) => {
      const arr = cacheStarts[tg];
      if (!arr || !arr.length) return null;
      let lo = 0, hi = arr.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < cue.startMs) lo = m + 1; else hi = m; }
      let best = null;
      for (const k of [arr[lo], arr[lo - 1]]) {
        if (k == null) continue;
        const d = Math.abs(k - cue.startMs);
        if (d > CACHE_NEAR_MS || (best && d >= best.d)) continue;
        const row = cacheMaps[tg].get(k);
        if (row.o) continue; // has its original → exact/text layers own it
        const oLen = normCue(cue.original || "").length, tLen = (row.text || "").length;
        if (oLen && tLen && (oLen > tLen * 3 || tLen > oLen * 3)) continue; // length-implausible pair
        const rowEnd = row.endMs || row.startMs, cueEnd = cue.endMs || cue.startMs;
        if (row.startMs < cueEnd && cue.startMs < rowEnd) best = { d, row };
      }
      if (best && nearMatchLogs++ < 5) console.info(`[CopilotSubs] cache near-match (+${best.d}ms) for cue @${Math.round(cue.startMs / 1000)}s — legacy row, timestamp jitter healed`);
      return best ? best.row : null;
    };
    const applyCache = (cue) => {
      for (const tg of settings.targets) {
        const v = cacheMaps[tg].get(cue.startMs)
          || (cue.original && cacheTextMaps[tg].get(normCue(cue.original)))
          || nearCacheRow(tg, cue);
        if (!v) continue;
        // Heal caches poisoned by the failed-batch English fallback: an RTL
        // target whose cached "translation" has no RTL script is untranslated
        // source text — skip it so the pump re-translates and re-caches. (Rare
        // legit Latin-only lines — a kept name, bare numbers — just re-translate
        // once per session; pennies, and they cache again if RTL comes back.)
        if (isRTLLang(tg) && v.text && !isRTL(v.text)) continue;
        cue.t[tg] = (v.text || "").replace(/\s+/g, " ").trim(); // normalized for karaoke unit reassembly
        if (v.sid != null && !cue.spk) cue.spk = { id: v.sid, g: v.sg || "?" };
        if (v.dt != null && cue.dt === undefined) cue.dt = v.dt; // cached condensed dub text (old caches: undefined → g.d null in buildGroups)
      }
    };

    // ZDF streams subtitle cues in as you play, so ingest is incremental.
    const cues = [];
    const seen = new Set();
    // Word-timed cues (YouTube ASR) are re-chunked into SENTENCES first — the
    // unit a creator's own captions use — instead of YouTube's fixed windows
    // that carry the tail of one sentence and the head of the next
    // (shared/cues.js). Only when the batch is (nearly) all word-timed.
    const recut = (list) => {
      if (!globalThis.SV_CUES || !Array.isArray(list) || list.length < 2) return list;
      const timed = list.filter((c) => SV_CUES.isTimed(c)).length;
      return timed >= list.length * 0.8 ? SV_CUES.rechunkTimed(list) : list;
    };
    const ingest = (list0) => {
      const list = recut(list0);
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
        if (f.w) cue.w = f.w; // per-word offsets (YouTube ASR) — feeds the karaoke highlight
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
        grp.spk = (grp.cues.find((c) => c.spk) || {}).spk;
        for (const tg of settings.targets) if (grp.cues.every((c) => c.t[tg])) grp.t[tg] = grp.cues[0].t[tg];
        grp.d = grp.cues[0].dt || null; // restored from cache (old caches: no dt → null → dub.js falls back to full text)
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
    for (const d of defs) { const row = document.createElement("div"); row.className = "copilot-subs__line" + (d.target ? "" : " copilot-subs__line--orig"); row.dataset.csKey = d.key; els[d.key] = row; stack.appendChild(row); }
    layoutCustomLines(); // if Position is "custom", anchor each line at its own saved spot

    // ── Click a word → pin its dictionary card (and pause) ───────────────────
    // Karaoke words in the ORIGINAL line are interactive: a click PAUSES the
    // video and pins a dictionary card (word · level · frequency · meaning) with
    // a deliberate Save-to-Leitner button; closing the card resumes playback.
    // Capture phase on the stack. A drag is not a click: pointer travel > 6px
    // vetoes it, so grabbing a line to move it neither pauses nor opens a card.
    // (openWordCard and the card controller are defined with the tooltip below;
    // the listener only reads them when a click fires, long after setup.)
    const vocabTg = (settings.targets || [])[0] || null;
    let curCue = null; // the cue on screen — stamped by tick each frame
    let vocabDownX = 0, vocabDownY = 0;
    stack.addEventListener("pointerdown", (e) => { vocabDownX = e.clientX; vocabDownY = e.clientY; }, true);
    stack.addEventListener("click", (e) => {
      let w = e.target && e.target.closest && e.target.closest(".copilot-subs__w");
      // The line-drag handler calls setPointerCapture on pointerdown, which
      // retargets this click to the LINE, not the word — so e.target is the line
      // and closest() finds nothing. Recover the real word under the pointer.
      if (!w) { const el = document.elementFromPoint(e.clientX, e.clientY); w = el && el.closest && el.closest(".copilot-subs__w"); }
      if (!w) return;
      const row = w.closest(".copilot-subs__line");
      if (!row || row.dataset.csKey !== "__orig") return; // original words only
      if (Math.hypot(e.clientX - vocabDownX, e.clientY - vocabDownY) > 6) return; // that was a drag
      openWordCard(w);
    }, true);

    // On-video hints: the trainer's word pool for this clip marks its words in
    // the ORIGINAL line with a dotted underline COLORED BY CEFR level — a
    // glanceable "worth learning, and how hard". The meaning rides the tooltip
    // once the clip was enriched. Words you've already learned (a high Leitner
    // box) or dismissed are dimmed instead — the "smart lightener" — so the eye
    // lands on what's new. Built from the cache the worker owns; zero network.
    let vocabPool = null;   // lowercased word → full pool entry (w, n, cefr, meaning…)
    let vocabPoolLang = "xx";
    let dimSet = null;      // lowercased words to de-emphasize (learned / dismissed)
    const markLearnWords = (row) => {
      for (const sp of row.__svW.spans) {
        const lw = sp.textContent.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
        if (vocabPool && vocabPool.has(lw)) {
          sp.classList.add("lw");
          const cefr = (vocabPool.get(lw) || {}).cefr;
          if (cefr && cefr !== "?") sp.dataset.cefr = cefr; else delete sp.dataset.cefr;
        }
        if (dimSet && dimSet.has(lw)) sp.classList.add("known");
      }
    };
    send({ type: "VOCAB_CLIP_WORDS", base, limit: 150 }).then((r) => {
      // A valid pool (even a small one) arms the hover for EVERY original-line
      // word: underlines are the ranked recommendations, not a permission.
      if (r && Array.isArray(r.words) && !r.reason) {
        vocabPoolLang = r.lang || "xx";
        vocabPool = new Map(r.words.map((x) => [x.w.toLowerCase(), x])); // full entries — the card shows lemma/article/level/phrase too
        dimSet = Array.isArray(r.dim) && r.dim.length ? new Set(r.dim.map((s) => String(s).toLowerCase())) : null;
        // The line on screen rendered before the pool arrived — mark it now,
        // not on the next cue change.
        const orig = els.__orig;
        if (orig && orig.__svW) markLearnWords(orig);
      }
    }).catch(() => {});
    // One-time build marker — open the video tab's DevTools console: if you see
    // this line, the smart-lightener code is the one actually running (not a
    // stale store install). Remove before any store build.
    if (!window.__svBuild) { window.__svBuild = "smart-lightener"; try { console.info("%c[SubVibe] smart-lightener build active — click a subtitle word to pause + open its card", "color:#6c5ce7;font-weight:700"); } catch (e) {} }

    // ── Word card: CLICK only (no hover) ─────────────────────────────────────
    // Hover shows nothing on purpose — a lookup takes a second or two and the
    // subtitle moves on, so an un-anchored hover bubble races the line. Clicking
    // a word PAUSES the video (freezing the line) and opens its card; that's the
    // only trigger. One bubble element, reused across engine runs.
    let wtip = overlay.querySelector(".copilot-subs__wtip");
    if (!wtip) {
      wtip = document.createElement("div");
      wtip.className = "copilot-subs__wtip";
      overlay.appendChild(wtip);
    }
    const wtipFetching = new Set(); // words already being looked up
    const vocabGram = new Map();    // sentence text → grammar note (session-local; the worker caches per clip)
    const lineExplainCache = new Map();   // sentence → { tr, g, words } (the ﹖ line-explain)
    const lineExplainFetching = new Set();

    // The ﹖ "explain this line" button lives on the OVERLAY (never inside a line,
    // so it can't disturb word clicks). The tick tracks it to the original line's
    // box; clicking it opens the stacked line card (openLineCard, defined below).
    let hintBtn = overlay.querySelector(".copilot-subs__hint");
    if (!hintBtn) { hintBtn = document.createElement("button"); hintBtn.type = "button"; hintBtn.className = "copilot-subs__hint"; hintBtn.textContent = "?"; hintBtn.title = "Explain this line — translation, grammar, key words"; overlay.appendChild(hintBtn); }
    hintBtn.onclick = (e) => { e.stopPropagation(); openLineCard(els.__orig); };

    const positionWtip = (w) => {
      const or = overlay.getBoundingClientRect(), wr = w.getBoundingClientRect();
      // Show first (display:none boxes measure 0), then clamp the center into
      // the player so an edge word can't push the bubble off screen.
      wtip.classList.add("show");
      const half = wtip.offsetWidth / 2 + 6;
      const cx = wr.left + wr.width / 2 - or.left;
      wtip.style.left = Math.round(Math.max(half, Math.min(or.width - half, cx))) + "px";
      // Above by default. When the card doesn't fit above (a subtitle moved to
      // the top) it goes to whichever side has more room, and is capped to that
      // room — the sentence band and the buttons stay, the middle scrolls.
      wtip.style.maxHeight = "";
      const roomAbove = wr.top - or.top - 12, roomBelow = or.bottom - wr.bottom - 12;
      const h = wtip.offsetHeight;
      const below = h > roomAbove && roomBelow > roomAbove;
      wtip.classList.toggle("below", below);
      const room = Math.max(140, below ? roomBelow : roomAbove);
      if (h > room) wtip.style.maxHeight = Math.round(room) + "px";
      wtip.style.top = Math.round((below ? wr.bottom : wr.top) - or.top) + "px";
    };

    // ── Pinned card controller (click) ───────────────────────────────────────
    // While pinned the card owns the bubble: hover won't clobber it and the
    // video stays paused. Save moves into the card; closing it (×, Esc, or a
    // click off it) resumes playback — but only if the click is what paused it.
    const closeWtip = (resume) => {
      wtip._word = null;
      wtip._lineSig = null;
      wtip._pinned = false;
      wtip.classList.remove("show", "pinned", "wt-explain", "below");
      wtip.style.maxHeight = "";
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKey, true);
      if (resume && wtip._resume) {
        const v = liveVideoEl(video) || video;
        if (v && v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      }
      wtip._resume = false;
    };
    const onDocClick = (e) => {
      const t = e.target;
      // Inside the card, or on another word (which re-pins) — not a dismiss.
      if (t && t.closest && (t.closest(".copilot-subs__wtip") || t.closest(".copilot-subs__w"))) return;
      closeWtip(true);
    };
    const onKey = (e) => { if (e.key === "Escape") closeWtip(true); };

    const renderPinnedCard = (w, headword, content, cue) => {
      wtip.textContent = "";
      wtip.classList.add("pinned");
      const title = document.createElement("div");
      title.className = "wt-word";
      title.dir = "auto";
      const showArt = content.art && vocabPoolLang === "de"; // der/die/das is German-only
      title.textContent = (showArt && content.lemma) ? `${content.art} ${content.lemma}` : (content.lemma || headword);
      wtip.appendChild(title);
      const bits = [];
      if (content.pos && content.pos !== "other") bits.push(content.pos);
      if (content.cefr && content.cefr !== "?") bits.push(content.cefr);
      if (content.n) bits.push("×" + content.n); // frequency in this video
      if (bits.length) {
        const head = document.createElement("div");
        head.className = "wt-head";
        head.textContent = bits.join(" · ");
        wtip.appendChild(head);
      }
      const mean = document.createElement("div");
      mean.className = "wt-mean";
      mean.dir = "auto";
      mean.textContent = content.meaning || "…";
      wtip.appendChild(mean);
      if (content.phrase) {
        const p = document.createElement("div");
        p.className = "wt-phrase";
        p.textContent = globalThis.SV_QUOTES ? SV_QUOTES.wrap(content.phrase, vocabPoolLang) : content.phrase;
        wtip.appendChild(p);
      }
      if (content.gram) { // the sentence's grammar note, from the same call
        const g = document.createElement("div");
        g.className = "wt-gram";
        g.dir = "auto";
        g.textContent = content.gram;
        wtip.appendChild(g);
      }
      const act = document.createElement("div");
      act.className = "wt-actions";
      const save = document.createElement("button");
      save.type = "button";
      save.className = "wt-save";
      save.textContent = wtip._saved ? "Saved ✓" : "Save to Leitner";
      save.disabled = !!wtip._saved;
      save.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (wtip._saved) return;
        const sentence = cue.grp ? cue.grp.orig : cue.original;
        const sentenceT = !vocabTg ? "" : cue.grp
          ? cue.grp.cues.map((q) => q.t[vocabTg] || "").join(" ").trim()
          : (cue.t[vocabTg] || "");
        const langHint = /[?&]lang=([a-z-]+)/i.exec(interceptedUrl || "");
        save.textContent = "Saving…";
        send({ type: "VOCAB_ADD", word: headword, sentence, translation: sentenceT,
          lang: langHint ? langHint[1].toLowerCase() : null, videoTitle: pageTitle, base, ms: cue.startMs, channel: adapter?.getChannel?.() || "" })
          .then((r) => {
            if (r && r.error) { save.textContent = "Save failed — retry"; return; }
            wtip._saved = true; save.textContent = "Saved ✓"; save.disabled = true;
          });
      });
      const close = document.createElement("button");
      close.type = "button";
      close.className = "wt-close";
      close.title = "Close";
      close.textContent = "×";
      close.addEventListener("click", (ev) => { ev.stopPropagation(); closeWtip(true); });
      act.appendChild(save);
      act.appendChild(close);
      wtip.appendChild(act);
      wtip.dir = "auto";
      positionWtip(w);
    };

    // The FULL sentence a clicked word belongs to, reconstructed ACROSS cues.
    // buildGroups can cut a group mid-sentence (110-char / 4-cue limit), so a
    // separable prefix or a subordinate-clause verb often lands in the NEXT cue
    // ("…dass er" | "nach Hause kommt."). Walk out to the nearest sentence
    // boundaries, then return the one sentence that contains the word — so the
    // model sees the whole clause, not a fragment.
    const sentenceForWord = (idx, word) => {
      if (!(idx >= 0 && idx < cues.length)) return "";
      const txt = (c) => String((c && c.original) || "").trim();
      // Bound the walk. Slow-German / ASR captions often have NO sentence
      // punctuation, so an unbounded walk swallows the whole clip (a paragraph
      // in the card AND a garbled model prompt). Stop at a sentence end, or after
      // a small window — ±2 cues / ~200 chars — enough to complete a clause.
      const MAX_CUES = 2, MAX_CHARS = 200;
      let s = idx, e = idx, chars = txt(cues[idx]).length;
      while (s > 0 && (idx - s) < MAX_CUES && chars < MAX_CHARS && !SENT_END.test(txt(cues[s - 1]))) { s--; chars += txt(cues[s]).length; }
      while (e < cues.length - 1 && (e - idx) < MAX_CUES && chars < MAX_CHARS && !SENT_END.test(txt(cues[e]))) { e++; chars += txt(cues[e]).length; }
      const joined = cues.slice(s, e + 1).map(txt).join(" ").replace(/\s+/g, " ").trim();
      if (!word) return joined;
      const esc = String(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      let re = null; try { re = new RegExp("(?<![\\p{L}])" + esc + "(?![\\p{L}])", "iu"); } catch {}
      const sentences = joined.split(/(?<=[.!?…])\s+/);
      const hit = re ? sentences.find((x) => re.test(x)) : sentences.find((x) => x.toLowerCase().includes(String(word).toLowerCase()));
      return (hit || joined).trim();
    };

    const openWordCard = (w) => {
      const cue = curCue;
      if (!cue) return;
      const surface = w.textContent.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
      const lw = surface.toLowerCase();
      // Send the word's FULL sentence (reconstructed across cues) so the model
      // sees a detached separable prefix or a clause verb that lands in the next
      // line — "…dass er" needs "nach Hause kommt" to resolve the clause.
      const sentText = sentenceForWord(cues.indexOf(cue), surface) || (cue.grp ? cue.grp.orig : cue.original) || w.closest(".copilot-subs__line").textContent;
      // Overlay clicks don't reach the player, so we pause the element ourselves
      // — and remember we did, so closing only resumes what WE paused.
      const v = liveVideoEl(video) || video;
      wtip._resume = !!(v && !v.paused);
      if (v && !v.paused) v.pause();
      wtip._pinned = true; wtip._word = lw; wtip._saved = false; wtip._lineSig = null;
      const entry = (vocabPool && vocabPool.get(lw)) || { w: surface };
      const gram = vocabGram.get(sentText);
      renderPinnedCard(w, surface, gram !== undefined ? { ...entry, gram } : entry, cue);
      // Arm the dismiss AFTER this click settles, so the opening click can't close it.
      setTimeout(() => {
        document.addEventListener("click", onDocClick, true);
        document.addEventListener("keydown", onKey, true);
      }, 0);
      // No cached meaning yet → fetch on demand (one call = word card + the
      // sentence's grammar), then re-render in place if still pinned here.
      if (!(entry && entry.meaning) && !wtipFetching.has(lw)) {
        wtipFetching.add(lw);
        send({ type: "VOCAB_WORD_ENRICH", base, w: surface, lang: vocabPoolLang, s: sentText })
          .then((r) => {
            wtipFetching.delete(lw);
            const e2 = r && r.e;
            if (e2 && e2.meaning && vocabPool) vocabPool.set(lw, { ...(vocabPool.get(lw) || { w: surface }), ...e2 }); // cache for the pool view, when there is one
            if (r && typeof r.g === "string") vocabGram.set(sentText, r.g);
            if (wtip._pinned && wtip._word === lw) {
              // Use the FETCHED entry directly — vocabPool is null on a clip whose
              // language isn't the one being learned, but a lookup must still work.
              const cur = (e2 && e2.meaning) ? { ...(entry || { w: surface }), ...e2 } : ((vocabPool && vocabPool.get(lw)) || entry);
              renderPinnedCard(w, surface,
                (cur && cur.meaning) ? { ...cur, gram: vocabGram.get(sentText) || "" }
                  : { ...entry, meaning: (r && r.error) ? "couldn't translate — check the provider key in the popup" : "no meaning yet — close & click the word again to retry" },
                cue);
            }
          });
      }
    };

    // ── Chunks: the unit tips are given for ──────────────────────────────────
    // A chunk is a passage of a few sentences cut at natural breaks (a long
    // silence, a sentence cap). Sentence units come from the groups that
    // partition the cues; chunks are recomputed on demand (cheap) so a
    // still-growing cue list never goes stale.
    const sentenceUnits = () => {
      const units = []; const seen = new Set();
      for (let i = 0; i < cues.length; i++) {
        const c = cues[i]; if (!c) continue;
        if (c.grp) {
          if (seen.has(c.grp)) continue; seen.add(c.grp);
          const gc = c.grp.cues || [c];
          units.push({ startMs: gc[0].startMs, endMs: gc[gc.length - 1].endMs || gc[gc.length - 1].startMs + 2500, original: c.grp.orig || gc.map((q) => q.original || "").join(" ").trim(), grp: c.grp, cue: gc[0] });
        } else units.push({ startMs: c.startMs, endMs: c.endMs || c.startMs + 2500, original: c.original || "", grp: null, cue: c });
      }
      return units;
    };
    const unitTr = (u, tg) => {
      if (!u.grp) return (u.cue.t && u.cue.t[tg]) || "";
      if (u.grp.t && u.grp.t[tg]) return u.grp.t[tg];
      // Every window of a group carries the group's whole line — join the distinct ones only.
      const out = []; for (const q of u.grp.cues || []) { const t = (q.t && q.t[tg]) || ""; if (t && !out.includes(t)) out.push(t); }
      return out.join(" ").trim();
    };
    // Translations and tips are laid out by their LANGUAGE, not by their first letter
    // (a Latin name at the start of a Persian line must not flip it left-to-right).
    const tgCode = () => vocabTg || (settings.targets && settings.targets[0]) || "";
    const dirOf = (code) => (code ? (isRTLLang(code) ? "rtl" : "ltr") : "auto");
    const explainDir = (ex) => dirOf(tipsExplain === "same" ? (ex && ex.lang) || vocabPoolLang : tgCode());
    const chunksNow = () => {
      const units = sentenceUnits();
      const C = globalThis.SV_CUES;
      const ranges = C && C.chunkCues ? C.chunkCues(units, { maxSents: 4, maxChars: 300 }) : units.map((u, i) => ({ from: i, to: i, startMs: u.startMs, endMs: u.endMs }));
      const tg = vocabTg || (settings.targets && settings.targets[0]) || "";
      return ranges.map((r, k) => {
        const us = units.slice(r.from, r.to + 1);
        // ASR stage tags ("[Music]") and speaker marks (">>") are not language — keep them out of the tips.
        const clean = (t) => String(t || "").replace(/\[[^\]]{1,24}\]/g, " ").replace(/(?:^|\s)(?:>>|&gt;&gt;|»)+\s*/g, " ").replace(/\s+/g, " ").trim();
        const sentences = us.map((u) => ({ s: clean(u.original), tr: clean(unitTr(u, tg)), startMs: u.startMs, endMs: u.endMs, cue: u.cue })).filter((x) => x.s);
        return { k, from: r.from, to: r.to, startMs: r.startMs, endMs: r.endMs, units: us, text: sentences.map((x) => x.s).join(" "), sentences };
      });
    };
    const chunkOfCue = (list, cue) => list.findIndex((ch) => ch.units.some((u) => u.cue === cue || (u.grp && u.grp === cue.grp)));
    // A sample of the whole video's lines — the background infers the video's
    // kind from it once (cached per video), so every later tip knows whether
    // this is an interview, a lesson, a match or a game stream.
    const sampleLines = () => {
      const us = sentenceUnits().map((u) => u.original).filter(Boolean);
      if (globalThis.SV_DOSSIER) return SV_DOSSIER.sampleLines(us, us.length >= 120 ? 300 : 40);
      // Without the shared module, still SPREAD 40 lines over the whole video — the
      // first 40 are all opening titles and say nothing about what the video is.
      if (us.length <= 40) return us;
      const step = us.length / 40, out = [];
      for (let i = 0; i < 40; i++) out.push(us[Math.floor(i * step)]);
      return out;
    };
    // Tips language: "" = the popup's target, "same" = the video's own language.
    let tipsExplain = "";
    try { chrome.storage.local.get("tipsExplain", (r) => { tipsExplain = String((r && r.tipsExplain) || ""); if (board.el) { const sel = board.el.querySelector(".svb-lang"); if (sel) sel.value = tipsExplain; seedExplained(); board.sig = ""; } }); } catch (e) {}
    // How far ahead the pump explains: "off" · "3" · "all" (the popup's "Tips ahead").
    // Read live — a change must not restart the engine, only wake the pump.
    let tipsAhead = "3";
    try { chrome.storage.local.get("tipsAhead", (r) => { tipsAhead = String((r && r.tipsAhead) || "3"); }); } catch (e) {}
    // One listener per page: a restarted engine drops the old one first, or every restart leaves a dead closure listening.
    const onTipsAhead = (ch, area) => { if (area === "local" && ch.tipsAhead) { tipsAhead = String(ch.tipsAhead.newValue || "3"); tips.stopped = false; tips.errors = 0; tips.pausedUntil = 0; board.sig = ""; } };
    try { if (window.__svTipsAheadListener) chrome.storage.onChanged.removeListener(window.__svTipsAheadListener); } catch (e) {}
    window.__svTipsAheadListener = onTipsAhead;
    try { chrome.storage.onChanged.addListener(onTipsAhead); } catch (e) {}
    const explainPayload = (ch, list) => ({ type: "VOCAB_EXPLAIN", base, s: ch.text, lang: vocabPoolLang, title: document.title, explain: tipsExplain, k: ch.k, n: list.length,
      before: list[ch.k - 1] ? [list[ch.k - 1].text] : [], after: list[ch.k + 1] ? [list[ch.k + 1].text] : [],
      // The background only needs the lines while the dossier is unknown or thin —
      // sending 300 of them with every explanation was ~48 KB a call for nothing.
      sample: !board.dossier || (board.dossier.sample || []).length < 40 ? sampleLines() : [] });
    // Seed the explanations already made on this video (for this tips language)
    // so marks and tips survive a page load.
    let seededFor = null;
    const seedExplained = () => {
      if (seededFor === tipsExplain) return; seededFor = tipsExplain;
      send({ type: "TIPS_CACHED", base, explain: tipsExplain }).then((r) => {
        if (!r || !r.ok || seededFor !== tipsExplain) return;
        if (r.ctx) setCtx(r.ctx);
        const known = (r.entries || []).find((e) => e.lang && e.lang !== "xx"); if (known) refreshLangOption(known.lang);
        for (const e of r.entries || []) if (!lineExplainCache.has(e.s)) lineExplainCache.set(e.s, { tr: e.tr, simple: e.simple || "", g: e.g, scene: e.scene || "", who: e.who || [], lang: e.lang || "", words: e.words || [] });
        // Last: painting the dossier must never cost the seeded tips above.
        if (r.dossier) setDossier(r.dossier);
        board.sig = "";
      });
    };
    const setTipsExplain = (v) => {
      tipsExplain = String(v || ""); lineExplainCache.clear(); chunkFetching.clear(); seededFor = null;
      try { chrome.storage.local.set({ tipsExplain }); } catch (e) {}
      seedExplained(); board.sig = ""; boardTick(true);
      if (wtip._pinned && card.list.length) renderChunkCard(els.__orig);
    };
    // The video's language becomes known from the track or the first explanation — name it in the option.
    const refreshLangOption = (code, opt) => { const o = opt || (board.el && board.el.querySelector('.svb-lang option[value="same"]')); if (!o || !code || code === "xx") return; const name = langLabel(code); if (name && name !== code) o.textContent = "Tips in " + name + " (the video's language)"; };
    const tipsLangLabel = (short) => tipsExplain === "same" ? (short ? (vocabPoolLang || "same").toUpperCase().slice(0, 2) : "the video's language") : (short ? (vocabTg || (settings.targets && settings.targets[0]) || "").toUpperCase().slice(0, 2) : (vocabTg || (settings.targets && settings.targets[0]) || "target"));

    // The background's own words, made plain: a reloaded extension says "reload this page", a missing key says so, anything else is shown as is.
    const plainError = (m) => { const s = String(m || ""); return isNoReceiver(s) || /context invalidated/i.test(s) ? "SubVibe was updated — reload this page" : /No (OpenAI|Anthropic) API key|bridge/i.test(s) ? s.replace(/^Error:\s*/, "").slice(0, 140) : "couldn't explain — " + s.replace(/^Error:\s*/, "").slice(0, 120); };
    const chunkFetching = new Map(); // chunk text → pending explain promise (deduped)
    const explainChunk = (ch, list, fresh) => {
      const hit = fresh ? null : lineExplainCache.get(ch.text); if (hit) return Promise.resolve(hit);
      if (fresh || !chunkFetching.has(ch.text)) chunkFetching.set(ch.text, send(Object.assign(explainPayload(ch, list), fresh ? { fresh: true } : {})).then((r) => {
        chunkFetching.delete(ch.text);
        if (r && r.ctx) setCtx(r.ctx);
        if (r && r.lang) refreshLangOption(r.lang);
        if (r && r.tr) { const ex = { tr: r.tr, simple: r.simple || "", g: r.g, scene: r.scene || "", who: r.who || [], lang: r.lang || "", words: r.words || [] }; lineExplainCache.set(ch.text, ex); return ex; }
        return { error: r && r.error ? plainError(r.error) : "no explanation — try again" };
      }));
      return chunkFetching.get(ch.text);
    };
    // Tips ahead: the next chunks after the playhead are always being explained —
    // one call in flight, in order, cached ones skipped — so the prompt cache
    // stays warm and the tips are there when a chunk starts. "Explain all" runs to the end.
    const tips = { inflight: new Map(), errors: 0, pausedUntil: 0, all: false, stopped: false, lastError: "" }; // inflight: chunk text → started at
    const PUMP_SLOW_MS = 30000;
    const busyHere = (ch) => !!(ch && tips.inflight.has(ch.text));
    const tipsPump = (list, ki) => {
      const now = performance.now();
      if (!globalThis.SV_DOSSIER || tips.stopped || now < tips.pausedUntil || !list.length) return;
      const mode = tips.all ? "all" : tipsAhead; if (mode === "off") return;
      if (!engaged && mode !== "all") return; // nothing before the video has played once
      // How many at once: one normally; two while the current or next chunk is not ready
      // (a bridge call takes 10–20 s, a chunk lasts about as long); one more when a call
      // has been out over 30 s — a hung call must not block the queue behind it.
      const ready = (j) => !!list[j] && lineExplainCache.has(list[j].text);
      const behind = ki >= 0 && (!ready(ki) || (list[ki + 1] && !ready(ki + 1)));
      const slow = [...tips.inflight.values()].some((t0) => now - t0 > PUMP_SLOW_MS);
      const limit = (behind || mode === "all" ? 2 : 1) + (slow ? 1 : 0);
      if (tips.inflight.size >= limit) return;
      const k = SV_DOSSIER.aheadWindow(ki, list.length, mode === "all" ? Infinity : 3, (j) => lineExplainCache.has(list[j].text) || tips.inflight.has(list[j].text));
      if (k < 0) { if (tips.all && !tips.inflight.size) tips.all = false; return; }
      const text = list[k].text; tips.inflight.set(text, now); board.sig = "";
      const failed = (why) => { tips.errors++; tips.lastError = why; tips.pausedUntil = performance.now() + 30000;
        if (/reload this page/.test(why)) { tips.stopped = true; return; } // nothing will answer until the page is reloaded
        if (tips.errors >= 3) { tips.rounds = (tips.rounds || 0) + 1; if (tips.rounds >= 3) tips.stopped = true; else { tips.errors = 0; tips.pausedUntil = performance.now() + 60000; } } };
      explainChunk(list[k], list).then((ex) => { if (!ex || ex.error) failed((ex && ex.error) || "no explanation"); else { tips.errors = 0; tips.rounds = 0; tips.lastError = ""; } })
        .catch((e) => failed(plainError(e && e.message)))
        .finally(() => { tips.inflight.delete(text); board.sig = ""; });
    };
    // What the strip and the pane say about the pipeline: how far the tips reach,
    // how many are done, which chunk is being explained, and why it stopped.
    const tipsStatus = (list, ki) => {
      const doneN = list.filter((ch) => lineExplainCache.has(ch.text)).length;
      let readyTo = -1; for (let j = Math.max(0, ki); j < list.length && lineExplainCache.has(list[j].text); j++) readyTo = j;
      const mode = tips.all ? "all" : tipsAhead;
      const busy = []; list.forEach((ch, j) => { if (tips.inflight.has(ch.text)) busy.push(j); });
      return { readyToMs: readyTo >= 0 ? list[readyTo].endMs : 0, doneN, totalN: list.length, busy, all: tips.all,
        state: mode === "off" ? "off" : tips.stopped ? "stopped" : tips.inflight.size ? "busy" : performance.now() < tips.pausedUntil ? "paused" : "idle", reason: tips.lastError };
    };
    const tipsAll = (on) => { tips.all = !!on; tips.stopped = false; tips.errors = 0; tips.pausedUntil = 0; board.sig = ""; boardTick(true); };
    const tipsRetry = () => { tips.stopped = false; tips.errors = 0; tips.rounds = 0; tips.pausedUntil = 0; board.sig = ""; boardTick(true); };
    // A person is a name: "Ray (Raymond)" counts as Ray; "the police", "radio advertisement voice" are roles.
    const cleanName = (w) => String(w || "").replace(/\s*\(.*$/, "").trim();
    const isRole = (k) => !/^\p{Lu}/u.test(k) || /['\u2019]s?\s/.test(k) || /\b(voice|advert|announcer|narrator|officer|police|crowd|men|man|woman|guy|guys|people|cop|cops|dealer|driver|radio|tv)\b/i.test(k) || k.split(/\s+/).length > 3; // "Andrés's partner" is a role, not a person
    // Faces: character pictures from the franchise's wiki, asked in small batches, remembered per name.
    let facesTimer = 0; const facesQueue = new Set();
    const askFaces = (names) => {
      for (const n0 of names || []) { const n = cleanName(n0); if (!n || isRole(n) || board.facesAsked.has(n)) continue; board.facesAsked.add(n); facesQueue.add(n); }
      if (!facesQueue.size || facesTimer || !board.dossier) return;
      facesTimer = setTimeout(() => {
        facesTimer = 0; const batch = [...facesQueue].slice(0, 12); for (const n of batch) facesQueue.delete(n);
        send({ type: "FACES", base, names: batch, lang: vocabPoolLang }).then((r) => {
          if (!r || !r.ok) { for (const n of batch) board.facesAsked.delete(n); return; }
          for (const [n, u] of Object.entries(r.faces || {})) board.faces.set(n, u || "");
          if (Array.isArray(r.credits)) board.credits = r.credits;
          board.facesV++; board.sig = ""; board.stripSig = "";
        }).catch(() => { for (const n of batch) board.facesAsked.delete(n); });
        if (facesQueue.size) askFaces([]);
      }, 1200);
    };
    // Story so far: a catch-up up to the playhead only, refreshed every 8 chunks, in the video's language.
    const recap = { k: -1, text: "", who: [], cast: new Map(), inflight: false, pausedUntil: 0 };
    const ROLE_WORD = { protagonist: "lead", antagonist: "opponent", ally: "ally", minor: "minor", other: "" };
    const wantRecap = (list, ki) => {
      if (ki < 3 || recap.inflight || performance.now() < recap.pausedUntil || (tips.all ? "all" : tipsAhead) === "off" || !engaged) return;
      const bucket = ki - (ki % 8); if (bucket === recap.k) return;
      const scenes = []; for (let j = 0; j <= bucket; j++) { const e = lineExplainCache.get(list[j].text); if (e && e.scene) scenes.push(e.scene); }
      if (scenes.length < 2) return;
      const lines = list.slice(Math.max(0, bucket - 4), bucket + 1).flatMap((c) => c.sentences.map((x) => x.s));
      recap.inflight = true;
      send({ type: "STORY_RECAP", base, k: bucket, scenes, lines, lang: vocabPoolLang, upTo: fmtT(list[bucket].startMs) })
        .then((r) => { recap.inflight = false; if (r && r.ok && r.recap) { recap.k = bucket; recap.text = r.recap; recap.who = r.who || []; for (const c of r.cast || []) recap.cast.set(cleanName(c.name), c); board.sig = ""; board.stripSig = ""; askFaces(recap.who); } else recap.pausedUntil = performance.now() + 60000; })
        .catch(() => { recap.inflight = false; recap.pausedUntil = performance.now() + 60000; });
    };
    const fmtT = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); };
    const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

    // ── Shared pieces: a chunk's sentences, its tips, the actions row ────────
    // Used by the ﹖ card over the video and by the story board beside it.
    // Word classes: verbs (both parts of a separated verb in the same colour),
    // nouns, adjectives, adverbs, phrases — from the explanation's word list.
    const POS_CLASS = { noun: "n", verb: "v", "phrasal verb": "v", adjective: "adj", adverb: "adv", idiom: "x", expression: "x", preposition: "prep", conjunction: "conj", pronoun: "pron" };
    const POS_LABEL = { v: "verb", n: "noun", adj: "adjective", adv: "adverb", x: "phrase", prep: "preposition" };
    const normTok = (w) => String(w || "").toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    // Colour the term's words inside one sentence: each part is matched in
    // order (a separated verb's prefix comes later in the sentence).
    const markPos = (spans, words) => {
      if (!spans.length || !words || !words.length) return;
      const toks = spans.map((s) => normTok(s.textContent));
      for (const w of words) {
        const cls = POS_CLASS[String(w.pos || "").toLowerCase()]; if (!cls) continue;
        const parts = (Array.isArray(w.parts) && w.parts.length ? w.parts : String(w.w || "").split(" ")).map(normTok).filter(Boolean);
        if (!parts.length) continue;
        let from = 0; const idxs = [];
        for (const part of parts) { let i = -1; for (let j = from; j < toks.length; j++) if (toks[j] === part) { i = j; break; } if (i < 0) { idxs.length = 0; break; } idxs.push(i); from = i + 1; }
        if (!idxs.length) continue;
        for (const i of idxs) { spans[i].classList.add("pos-" + cls); if (parts.length > 1 && cls === "v") spans[i].classList.add("sep"); if (w.m) spans[i].title = w.w + " — " + w.m; }
      }
    };
    // One sentence as word spans (karaoke units when given, else the words),
    // coloured by the explanation's word classes.
    const renderSentence = (x, ex, units) => {
      const t = mk("span", "svb-txt"); t.dir = "auto";
      const toks = units ? units.map((u) => u.t) : String(x.s || "").split(" ").filter(Boolean);
      const spans = [];
      toks.forEach((w, j) => { if (j) t.appendChild(document.createTextNode(" ")); const sp = mk("span", "svb-w", w); t.appendChild(sp); spans.push(sp); });
      if (units) { t.__svW = { units, spans, k: -1 }; t.classList.add("k"); }
      if (ex && !ex.error) markPos(spans, ex.words);
      return t;
    };
    const buildSents = (ch, startNo, ex) => {
      const box = mk("div", "wt-line wt-sents"); box.dir = "auto";
      ch.sentences.forEach((x, i) => {
        const r = mk("div", "wt-sent"); const num = mk("button", "wt-sn", String(startNo + i)); num.type = "button"; num.title = "Hear this sentence"; num.addEventListener("click", (ev) => { ev.stopPropagation(); playFrom(x.startMs != null ? x.startMs : ch.startMs, x.endMs); });
        r.appendChild(num); r.appendChild(renderSentence(x, ex, null)); box.appendChild(r);
        if (x.tr) { const tr = mk("div", "wt-tr", x.tr); tr.dir = dirOf(tgCode()); box.appendChild(tr); }
      });
      return box;
    };
    const buildLegend = (ex) => {
      const seen = new Set(); for (const w of (ex && ex.words) || []) { const c = POS_CLASS[String(w.pos || "").toLowerCase()]; if (c && POS_LABEL[c]) seen.add(c); }
      if (!seen.size) return null;
      const lg = mk("div", "wt-legend");
      for (const c of ["v", "n", "adj", "adv", "x", "prep"]) if (seen.has(c)) { const it = mk("span", "wt-lg pos-" + c, POS_LABEL[c]); lg.appendChild(it); }
      if ((ex.words || []).some((w) => /phrasal/.test(String(w.pos || "")) || ((w.parts || []).length > 1 && /verb/.test(String(w.pos || ""))))) lg.appendChild(mk("span", "wt-lg pos-v sep", "two-part verb"));
      return lg;
    };
    const buildTips = (ex, ch) => {
      const body = mk("div", "wt-body");
      const addSect = (label, node) => { const sc = mk("div", "wt-sect"); sc.appendChild(mk("div", "wt-lbl", label)); sc.appendChild(node); body.appendChild(sc); };
      const tDir = ex && !ex.error ? explainDir(ex) : "auto"; // the tips' language (target, or the video's)
      const line = (text, d) => { const v = mk("div", "wt-val", text); v.dir = d || "auto"; return v; };
      if (!ex) { body.appendChild(line("…")); return body; }
      if (ex.error) { body.appendChild(line(ex.error)); return body; }
      // The passage said more simply, in its own language — the translation
      // already sits under each sentence, so no second translation here.
      // The scene as the model read it — who speaks, the mood — then the retelling.
      if (ex.scene) { const sc = mk("div", "wt-val wt-scene", ex.scene); sc.dir = tDir; addSect("What's happening", sc); }
      const simple = ex.simple || (tipsExplain === "same" ? ex.tr : "");
      const srcName = langLabel(ex.lang || vocabPoolLang || "");
      if (simple) { const v = line(simple, dirOf(ex.lang || vocabPoolLang)); v.title = "The same passage retold with easier " + srcName + " words — the meaning does not change"; addSect("Simpler words, same meaning" + (srcName && srcName !== (ex.lang || "") ? " · " + srcName : ""), v); }
      if (ex.g) {
        const parts = String(ex.g).split(/\s*•\s*/).map((x) => x.trim()).filter(Boolean);
        const gbox = mk("div", "wt-val wt-grambox"); gbox.dir = tDir;
        // «quoted» bits are the passage's own words — set them apart from the explanation.
        const gpt = (text) => { const d = mk("div", "wt-gpt"); const re = /«([^»]+)»|“([^”]+)”|"([^"]{2,60})"/g; let last = 0, m; while ((m = re.exec(text))) { if (m.index > last) d.appendChild(document.createTextNode(text.slice(last, m.index))); const q = mk("b", "wt-q", m[1] || m[2] || m[3]); q.dir = "auto"; d.appendChild(q); last = m.index + m[0].length; } if (last < text.length) d.appendChild(document.createTextNode(text.slice(last))); return d; };
        for (const pt of parts.length ? parts : [String(ex.g)]) gbox.appendChild(gpt(pt));
        addSect("Grammar", gbox);
      }
      if (ex.words && ex.words.length) {
        const list = mk("div", "wt-words");
        for (const x of ex.words) {
          const b = mk("b", "pos-" + (POS_CLASS[String(x.pos || "").toLowerCase()] || "o"), x.w); b.dir = "auto";
          // ± for the word's tone; register (formal · informal · slang) in the tag line; ⚠ when care is needed.
          if (x.tone === "positive" || x.tone === "negative") b.appendChild(mk("i", "wt-tone " + x.tone, x.tone === "positive" ? "+" : "−"));
          const tag = [x.pos, x.level, x.register && x.register !== "neutral" ? x.register : ""].filter(Boolean).join(" · ");
          if (tag) b.appendChild(mk("i", "wt-tag" + (x.register === "slang" || x.register === "vulgar" ? " hot" : ""), tag));
          const m = mk("span", null, x.m); m.dir = tDir;
          if (x.care) { const c = mk("i", "wt-care", "⚠ " + x.care); c.dir = tDir; m.appendChild(c); }
          // Into the Leitner boxes, with the sentence it appeared in.
          const add = mk("button", "wt-add", "＋"); add.type = "button"; add.title = "Save to Leitner";
          add.addEventListener("click", (ev) => {
            ev.stopPropagation(); if (add.disabled) return; add.disabled = true; add.textContent = "…";
            const snt = (ch && ch.sentences.find((q) => q.s.toLowerCase().includes(String(x.w).toLowerCase()))) || (ch && ch.sentences[0]) || null;
            const langHint = /[?&]lang=([a-z-]+)/i.exec(interceptedUrl || "");
            send({ type: "VOCAB_ADD", word: x.w, sentence: snt ? snt.s : (ch ? ch.text : ""), translation: snt ? snt.tr : "", lang: (ex.lang || (langHint ? langHint[1].toLowerCase() : null)) || null,
              videoTitle: pageTitle, base, ms: snt ? snt.startMs : (ch ? ch.startMs : 0), channel: adapter?.getChannel?.() || "" })
              .then((r) => { if (r && r.error) { add.disabled = false; add.textContent = "＋"; add.title = "Save failed — retry"; return; } add.textContent = "✓"; add.title = "Saved to Leitner"; });
          });
          m.appendChild(add);
          // A verb's forms / a noun's plural — left-to-right on its own line, after the ＋ (a bare dash is no form).
          const forms = String(x.forms || "").trim();
          if (forms && !/^[\s\-–—·.,_/]*$/.test(forms)) { const f = mk("i", "wt-forms", forms); f.dir = "ltr"; m.appendChild(f); }
          list.appendChild(b); list.appendChild(m);
        }
        addSect("Words", list);
      }
      const lg = buildLegend(ex); if (lg) body.appendChild(lg);
      if (ch) { // one more call, on purpose: a fresh explanation for this chunk
        const again = mk("button", "wt-again", "Explain again ↻"); again.type = "button"; again.title = "Ask once more for this chunk (one call) — e.g. after the tips language or the explanation shape changed";
        again.addEventListener("click", (ev) => { ev.stopPropagation(); again.disabled = true; again.textContent = "Explaining…"; explainChunk(ch, board.list.length ? board.list : card.list, true).then(() => { board.sig = ""; boardTick(true); if (wtip._pinned && card.list.length) renderChunkCard(els.__orig); }); });
        (lg || body).appendChild(again);
      }
      return body;
    };
    // Frame + chunk from the screen (keyboard command / context menu): gather the
    // chunk(s) with their tips, report the video's box and the line's box in CSS
    // pixels, hide the overlay for the capture.
    window.__svSnapPrep = async () => {
      const list = board.list.length ? board.list : chunksNow(); if (!list.length) return { ok: false, error: "no-chunks" };
      let k0 = board.open >= 0 ? board.open : chunkOfCue(list, curCue); if (k0 < 0) k0 = Math.max(0, board.ki);
      const picked = [];
      for (let k = k0; k < Math.min(list.length, k0 + snapChunks); k++) { const ch = list[k]; const ex = await explainChunk(ch, list); if (!ex || ex.error) continue; picked.push({ s: ch.text, tr: ex.tr, simple: ex.simple || "", g: ex.g, lang: ex.lang || "", words: ex.words || [], sentences: ch.sentences.map((x) => ({ s: x.s, tr: x.tr })) }); }
      if (!picked.length) return { ok: false, error: "explain" };
      const v = liveVideoEl(video) || video; const vr = v.getBoundingClientRect();
      const ol = els.__orig && els.__orig.style.display !== "none" ? els.__orig : null; const lr = ol ? ol.getBoundingClientRect() : null;
      overlay.classList.add("sv-snap-hide");
      return { ok: true, dpr: window.devicePixelRatio || 1, rect: { x: vr.left, y: vr.top, w: vr.width, h: vr.height },
        lineRect: lr ? { x: lr.left - vr.left, y: lr.top - vr.top, w: lr.width, h: lr.height } : null,
        chunks: picked, lang: picked[0].lang || vocabPoolLang, title: document.title, url: location.href, base };
    };
    window.__svSnapDone = () => overlay.classList.remove("sv-snap-hide");
    // Snap: the current video frame as a Shot, with N whole chunks under it.
    // The frame comes straight from the <video> at its native size — no player
    // UI, no overlay, no tab-capture permission. Media-source players (YouTube)
    // allow it; a DRM stream taints the canvas, and the popup's Screenshot is
    // the way there (it attaches the first chunk via window.__svOverlayLine).
    const snapChunksNow = async (list, k0, n, anchor, status) => {
      const picked = [];
      for (let k = k0; k < Math.min(list.length, k0 + n); k++) {
        const ch = list[k]; status("Explaining chunk " + (k - k0 + 1) + "/" + n + "…");
        const ex = await explainChunk(ch, list); if (!ex || ex.error) continue;
        picked.push({ s: ch.text, tr: ex.tr, g: ex.g, lang: ex.lang || "", words: ex.words || [], sentences: ch.sentences.map((x) => ({ s: x.s, tr: x.tr })) });
      }
      if (!picked.length) return { ok: false, error: "explain" };
      status("Snapping…");
      const v = liveVideoEl(video) || video;
      const vr = v.getBoundingClientRect(), lr = (anchor || els.__orig).getBoundingClientRect();
      const w = v.videoWidth || Math.round(vr.width), h = v.videoHeight || Math.round(vr.height);
      let frame = null;
      try { const cv = document.createElement("canvas"); cv.width = w; cv.height = h; cv.getContext("2d").drawImage(v, 0, 0, w, h); frame = cv.toDataURL("image/jpeg", 0.92); } catch (e) { frame = null; }
      if (!frame || w < 8 || h < 8) return { ok: false, error: "drm" };
      const kx = w / (vr.width || 1), ky = h / (vr.height || 1);
      const lineRect = { x: (lr.left - vr.left) * kx, y: (lr.top - vr.top) * ky, w: lr.width * kx, h: lr.height * ky };
      return send({ type: "TIPS_SNAP", base, lang: picked[0].lang || vocabPoolLang, title: document.title, url: location.href, frame, w, h, lineRect, line: picked[0], chunks: picked });
    };
    // The actions row: 1 · 2 · 3 chunks, Frame + chunks, All explained lines.
    const buildActions = (ctx) => {
      const act = mk("div", "wt-actions");
      const nsel = mk("span", "wt-nsel"); nsel.title = "How many chunks to show and to put on the frame — this one, then the following ones";
      const btns = [1, 2, 3].map((m) => { const b = mk("button", m === ctx.n ? "on" : "", String(m)); b.type = "button"; b.addEventListener("click", (ev) => { ev.stopPropagation(); ctx.setN(m); }); nsel.appendChild(b); return b; });
      const snap = mk("button", "wt-sheet wt-snap", "Frame + " + (ctx.n === 1 ? "this chunk" : ctx.n + " chunks")); snap.type = "button";
      snap.title = "Capture this video frame as a Shot, with the chunk's sentences, translation, grammar and words under it";
      snap.addEventListener("click", async (ev) => {
        ev.stopPropagation(); snap.disabled = true; for (const b of btns) b.disabled = true;
        const r = await snapChunksNow(ctx.list, ctx.k0, ctx.n, ctx.anchor(), (t) => { snap.textContent = t; });
        snap.disabled = false; for (const b of btns) b.disabled = false;
        snap.textContent = r && r.ok ? "Snapped ↗" : r && r.error === "drm" ? "Protected video — press ⌥⇧F, or right-click → Frame + this chunk (SubVibe)" : r && r.error === "explain" ? "Couldn't explain" : "Couldn't snap";
      });
      const sheet = mk("button", "wt-sheet", "All explained lines ↗"); sheet.type = "button";
      sheet.title = "Every chunk you explained on this video, gathered as one Study sheet";
      sheet.addEventListener("click", (ev) => {
        ev.stopPropagation(); sheet.disabled = true;
        send({ type: "TIPS_SHEET", base, lang: vocabPoolLang, title: document.title, url: location.href }).then((r) => {
          sheet.disabled = false;
          if (!r || !r.ok) sheet.textContent = r && r.error === "empty" ? "No tips saved yet" : "Couldn't open the sheet";
        });
      });
      const loop = mk("button", "wt-sheet wt-loop" + (board.loop === ctx.k0 ? " on" : ""), board.loop === ctx.k0 ? "Repeating ↻" : "Repeat ↻"); loop.type = "button";
      loop.title = "Play this chunk again and again (click to stop)";
      loop.addEventListener("click", (ev) => { ev.stopPropagation(); if (board.loop === ctx.k0) { board.loop = -1; loop.classList.remove("on"); loop.textContent = "Repeat ↻"; } else { board.loop = ctx.k0; board.stopAt = null; loop.classList.add("on"); loop.textContent = "Repeating ↻"; const ch = ctx.list[ctx.k0]; if (ch) playFrom(ch.startMs); } });
      const share = mk("button", "wt-sheet wt-share", "Share ↗"); share.type = "button"; share.title = "One page with every chunk, its translation and the tips already explained — from the cache — to download and send to a friend";
      share.addEventListener("click", (ev) => { ev.stopPropagation(); shareBoard(share); });
      act.append(nsel, snap, loop, sheet, share);
      return act;
    };
    // Playback speed for listening slowly: 1× → 0.75× → 0.5× → 1×.
    const speedButton = (cls) => {
      const b = mk("button", cls || "svb-speed", (board.rate || 1) + "×"); b.type = "button"; b.title = "Playback speed — click to slow down: 1× → 0.75× → 0.5× → 1×";
      b.addEventListener("click", (ev) => { ev.stopPropagation(); const next = { 1: 0.75, 0.75: 0.5, 0.5: 1 }[board.rate || 1] || 1; board.rate = next; setRate(next); for (const q of document.querySelectorAll(".svb-speed, .wt-speed")) q.textContent = next + "×"; });
      return b;
    };
    let snapChunks = 1; // how many chunks the card shows and a snap carries (1 · 2 · 3)

    // ── "Explain this chunk" card (the ﹖ hint button) ───────────────────────
    // Over the video: a pager (‹ chunk k / n ›), the shown chunks' sentences
    // (numbered straight through), each chunk's Translation · Grammar · Words,
    // and the actions row. One cached VOCAB_EXPLAIN call per chunk. Reuses the
    // pinned bubble + close/resume.
    const card = { k0: -1, n: 1, list: [] };
    const renderChunkCard = (anchor) => {
      const list = card.list, k0 = card.k0;
      const first = list[k0]; if (!first) return;
      const n = Math.max(1, Math.min(card.n, list.length - k0));
      wtip.textContent = "";
      wtip.classList.add("pinned", "wt-explain");
      const ex0 = lineExplainCache.get(first.text);
      if (ex0 && !ex0.error) {
        // A Shot taken from the popup on this page attaches this chunk and its
        // tips (content/shot-capture.js reads it) — the DRM-safe route to a snap.
        const lr = anchor.getBoundingClientRect();
        window.__svOverlayLine = { s: first.text, tr: ex0.tr || "", g: ex0.g || "", words: ex0.words || [], lang: ex0.lang || vocabPoolLang, sentences: first.sentences.map((x) => ({ s: x.s, tr: x.tr })),
          rect: { x: lr.left + scrollX, y: lr.top + scrollY, w: lr.width, h: lr.height }, at: Date.now() };
      }
      const pager = mk("div", "wt-pager");
      const prev = mk("button", "wt-pg", "‹"); prev.type = "button"; prev.title = "Previous chunk (the video jumps there)"; prev.disabled = k0 <= 0;
      const next = mk("button", "wt-pg", "›"); next.type = "button"; next.title = "Next chunk (the video jumps there)"; next.disabled = k0 + n >= list.length;
      const lbl = mk("span", "wt-chunk", "chunk " + (k0 + 1) + (n > 1 ? "–" + (k0 + n) : "") + " / " + list.length + " · " + fmtT(first.startMs));
      prev.addEventListener("click", (ev) => { ev.stopPropagation(); goChunk(k0 - 1, anchor); });
      next.addEventListener("click", (ev) => { ev.stopPropagation(); goChunk(k0 + n, anchor); });
      const lang = mk("button", "wt-pg wt-lang", tipsLangLabel(true)); lang.type = "button"; lang.title = "Tips in " + tipsLangLabel(false) + " — click to switch between your language and the video's own language";
      lang.addEventListener("click", (ev) => { ev.stopPropagation(); setTipsExplain(tipsExplain === "same" ? "" : "same"); });
      pager.append(prev, lbl, speedButton("wt-pg wt-speed"), lang, next); wtip.appendChild(pager);
      if (board.ctx && board.ctx.kind) { const cx = mk("div", "wt-ctx", ctxLine(board.ctx)); cx.title = [board.ctx.register ? "Register: " + board.ctx.register : "", board.ctx.speakers ? "Speakers: " + board.ctx.speakers : ""].filter(Boolean).join("\n"); wtip.appendChild(cx); }
      const scroller = mk("div", "wt-scroll"); // sentences + tips of every shown chunk scroll together
      let no = 1;
      for (let k = k0; k < k0 + n; k++) {
        const ch = list[k]; const ex = lineExplainCache.get(ch.text);
        if (k > k0) scroller.appendChild(mk("div", "wt-div", "chunk " + (k + 1) + " · " + fmtT(ch.startMs)));
        scroller.appendChild(buildSents(ch, no, ex)); no += ch.sentences.length;
        scroller.appendChild(buildTips(ex, ch));
        if (!ex) explainChunk(ch, list).then(() => { if (wtip._pinned && card.k0 === k0 && card.list === list) renderChunkCard(anchor); });
      }
      wtip.appendChild(scroller);
      const act = buildActions({ list, k0, n, setN: (m) => { card.n = m; snapChunks = m; renderChunkCard(anchor); }, anchor: () => anchor });
      const close = mk("button", "wt-close", "×"); close.type = "button"; close.title = "Close";
      close.addEventListener("click", (ev) => { ev.stopPropagation(); closeWtip(true); });
      act.appendChild(close); wtip.appendChild(act);
      wtip.dir = "auto";
      positionWtip(anchor);
    };
    const goChunk = (k, anchor) => {
      if (k < 0 || k >= card.list.length) return;
      card.k0 = k; wtip._lineSig = card.list[k].text;
      seekTo(card.list[k].startMs);
      renderChunkCard(anchor);
    };
    const openLineCard = (row) => {
      const cue = curCue;
      if (!cue) return;
      // The tips belong to the CHUNK holding this line — a passage of a few
      // sentences — shown once for the whole chunk, with the neighbouring
      // chunks handed over as context only.
      const list = chunksNow();
      if (!list.length) return;
      let ki = chunkOfCue(list, cue); if (ki < 0) ki = 0;
      const anchor = row || els.__orig;
      const v = liveVideoEl(video) || video;
      // With the story board beside the video, the tips go there and the
      // picture stays clean; the floating card is for sites without a board
      // (and for fullscreen).
      if (board.el && board.el.isConnected && !document.fullscreenElement && (boardVisible() || board.collapsed)) {
        if (board.collapsed) setBoardCollapsed(false);
        if (v && !v.paused) v.pause(); boardFocus(ki, true); return;
      }
      wtip._resume = !!(v && !v.paused);
      if (v && !v.paused) v.pause();
      wtip._pinned = true; wtip._word = null; wtip._lineSig = list[ki].text;
      card.list = list; card.k0 = ki; card.n = snapChunks;
      renderChunkCard(anchor);
      setTimeout(() => {
        document.addEventListener("click", onDocClick, true);
        document.addEventListener("keydown", onKey, true);
      }, 0);
    };

    // ── Story board: the chunks beside the video (YouTube's side column) ─────
    // Docked above the suggested videos, so the picture carries only the
    // subtitles: every chunk in order with its translation, the playing one
    // highlighted and followed, the explained ones marked; the open chunk
    // shows its Translation · Grammar · Words and the actions row.
    const board = { el: null, list: [], ki: -1, open: -1, sig: "", at: 0, collapsed: false, userScrollAt: 0, linesOff: false, loop: -1, stopAt: null, rate: 1, ctx: null, lastScene: null, faces: new Map(), facesAsked: new Set(), facesV: 0, stripShownAt: 0, pumpSig: "", dossier: null, dossierAsked: false, dossierInFlight: false, dossierTries: 0, dossierRetryAt: 0, pinnedAt: 0, paneSig: "", stripHidden: false, stripSig: "" };
    // "language lesson · walk & talk" — what kind of video the model took this for.
    const ctxLine = (cx) => cx && cx.kind ? [cx.kind, cx.about].filter(Boolean).join(" · ").slice(0, 90) : "";
    const setCtx = (cx) => { if (!cx || !cx.kind) return; board.ctx = cx; const el = board.el && board.el.querySelector(".svb-ctx"); if (el) { el.textContent = ctxLine(cx); el.title = [cx.kind, cx.about, cx.register ? "Register: " + cx.register : "", cx.speakers ? "Speakers: " + cx.speakers : ""].filter(Boolean).join("\n"); } };
    // The dossier: what the site says this video IS (show/episode or channel +
    // description), the cast, and the model's reading of it. It reaches the board
    // once per video and names the video under the "Story board" title.
    const setDossier = (d) => {
      if (!d) return; board.dossier = d; if (d.kind) setCtx({ kind: d.kind, about: d.about, register: d.register, speakers: d.speakers });
      // Under the title: "interview · Peak TV · Anna, Tom" (YouTube) or "crime drama series · The Block · S1 E3" (Netflix)
      const el = board.el && board.el.querySelector(".svb-ctx");
      const idl = globalThis.SV_DOSSIER ? SV_DOSSIER.identityLine(d) : (d.show || d.title || "");
      if (el) { const who = (d.people || []).slice(0, 3).map((p) => p.character || p.name).filter(Boolean).join(", "); el.textContent = [d.kind, d.show ? idl : d.channel, who].filter(Boolean).join(" · ").slice(0, 110); el.title = [d.kind, d.about, idl, d.channel, d.synopsis || d.description].filter(Boolean).join("\n"); }
      board.sig = "";
    };
    // Asked ONCE per video (the background builds it once and caches it), before
    // any explanation, so every tip is read in the light of what this video is.
    const askDossier = () => {
      if (board.dossierAsked || board.dossierInFlight || !adapter) return;
      if (board.dossierTries >= 5 || performance.now() < board.dossierRetryAt) return; // a failed ask waits 20 s, five tries at most
      // A YouTube pre-roll ad carries its OWN caption track, so the lines on the
      // board right now are the ad's. The dossier is frozen once per video — asking
      // during an ad would freeze the model's reading on the ad. Wait; boardTick
      // asks again on the next tick, and the flag is still unset.
      try { if (adapter.site === "youtube" && document.querySelector(".ad-showing")) return; } catch (e) {}
      board.dossierInFlight = true; board.dossierTries++;
      const fail = () => { board.dossierInFlight = false; board.dossierRetryAt = performance.now() + 20000; };
      const metaP = adapter.getMeta ? adapter.getMeta() : Promise.resolve({ site: adapter.site, url: location.href, title: SV_TITLE.clean(document.title) });
      metaP.then((m) => { const meta = m || { site: adapter.site, url: location.href }; meta.title = SV_TITLE.clean(meta.title || ""); return send({ type: "DOSSIER", base, meta, sample: sampleLines(), lang: vocabPoolLang }); })
        // Only a real answer closes the question: a send that failed (worker asleep,
        // error) must not cost this video its dossier for the whole run.
        .then((r) => { if (r && r.ok) { board.dossierAsked = true; board.dossierInFlight = false; setDossier(r.dossier); } else fail(); })
        .catch(() => fail());
    };
    try { board.collapsed = localStorage.getItem("sv-board-collapsed") === "1"; board.linesOff = localStorage.getItem("sv-lines-off") === "1"; board.stripHidden = localStorage.getItem("sv-strip-collapsed") === "1"; } catch (e) {}
    const boardVisible = () => !!(board.el && board.el.isConnected && !board.collapsed && !document.fullscreenElement && board.el.getClientRects().length > 0);
    // Drawer mode: the picture makes room instead of hiding behind the drawer.
    // The player's outermost viewport-sized box (Netflix: .watch-video) gets a
    // right inset equal to the drawer's width; the video letterboxes inside it.
    const fit = { el: null, prev: null, on: false };
    const playerBox = () => {
      const v = liveVideoEl(video) || video; if (!v) return null;
      let el = v, best = null;
      for (let i = 0; i < 12 && el && el !== document.body; i++, el = el.parentElement) {
        const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
        if ((cs.position === "absolute" || cs.position === "fixed") && r.width >= innerWidth * 0.9) best = el;
      }
      return best;
    };
    const STRIP_H = 136;
    const stripOn = () => !!(board.el && board.el.classList.contains("drawer") && !board.collapsed && !board.stripHidden && !document.fullscreenElement);
    const fitPlayer = (on) => {
      const w = board.el && board.el.classList.contains("drawer") ? Math.round(board.el.getBoundingClientRect().width) : 0;
      const h = stripOn() ? STRIP_H : 0;
      if (on && w > 0) {
        // Once inset, the box is no longer viewport-wide, so playerBox() cannot find
        // it a second time — keep the one already held, or the strip's inset never lifts.
        const el = (fit.el && fit.el.isConnected) ? fit.el : playerBox(); if (!el) return;
        if (fit.el !== el) { fitPlayer(false); fit.el = el; fit.prev = { right: el.style.right, width: el.style.width, bottom: el.style.bottom, height: el.style.height, transition: el.style.transition }; }
        if (!el.dataset.svFit) { el.dataset.svFit = "1"; el.dataset.svFitRight = fit.prev.right || ""; el.dataset.svFitWidth = fit.prev.width || ""; el.dataset.svFitBottom = fit.prev.bottom || ""; el.dataset.svFitHeight = fit.prev.height || ""; }
        el.style.transition = "right .2s ease, bottom .2s ease"; el.style.right = w + "px"; el.style.width = "auto"; el.style.bottom = h + "px"; el.style.height = h ? "auto" : fit.prev.height; fit.on = true;
      } else if (fit.el) {
        try { fit.el.style.right = fit.prev.right; fit.el.style.width = fit.prev.width; fit.el.style.bottom = fit.prev.bottom; fit.el.style.height = fit.prev.height; fit.el.style.transition = fit.prev.transition; delete fit.el.dataset.svFit; } catch (e) {}
        fit.el = null; fit.prev = null; fit.on = false;
      }
    };
    const setBoardCollapsed = (v) => {
      board.collapsed = !!v; try { localStorage.setItem("sv-board-collapsed", board.collapsed ? "1" : ""); } catch (e) {}
      if (board.el) { board.el.classList.toggle("collapsed", board.collapsed); const t = board.el.querySelector(".svb-toggle"); if (t) t.textContent = board.collapsed ? "Show" : "Hide"; }
      board.sig = "";
    };
    // Subtitles on the picture: off = read them on the board (karaoke follows there).
    const applyLinesOff = () => { overlay.classList.toggle("sv-lines-off", board.linesOff && boardVisible()); const t = board.el && board.el.querySelector(".svb-lines"); if (t) { t.textContent = board.linesOff ? "Subtitles: board only" : "Subtitles: on video"; t.title = board.linesOff ? "The subtitles are hidden on the picture — read them here. Click to show them on the video again." : "The subtitles are shown on the picture. Click to hide them there and read them here only (the spoken words light up on the board)."; t.classList.toggle("off", board.linesOff); } };
    const ensureBoard = () => {
      if (settings.storyBoard === false) { if (board.el) { try { board.el.remove(); } catch (e) {} board.el = null; } return null; } // switched off in the popup
      if (board.el && board.el.isConnected) return board.el;
      if (!adapter) return null;
      // YouTube has a side column to dock into; other players fill the window,
      // so the board becomes a drawer on the right edge (hidden in fullscreen).
      let drawer = adapter.site !== "youtube";
      try { if (localStorage.getItem("sv-board-drawer") === "1") drawer = true; } catch (e) {}
      const host = drawer ? null : (document.querySelector("ytd-watch-flexy #secondary-inner") || document.querySelector("ytd-watch-flexy #secondary"));
      if (!drawer && !host) return null;
      if (drawer && !document.body) return null;
      const b = mk("div", "sv-board" + (board.collapsed ? " collapsed" : "") + (drawer ? " drawer" : "")); b.id = "sv-board"; b.dir = "auto";
      const head = mk("div", "svb-head");
      const toggle = mk("button", "svb-toggle", board.collapsed ? "Show" : "Hide"); toggle.type = "button";
      toggle.addEventListener("click", () => { setBoardCollapsed(!board.collapsed); applyLinesOff(); if (b.classList.contains("drawer")) fitPlayer(!board.collapsed && !document.fullscreenElement); });
      const title = mk("span", "svb-title"); title.appendChild(mk("b", null, "Story board")); title.appendChild(mk("i", "svb-ctx", board.ctx ? ctxLine(board.ctx) : ""));
      head.append(mk("span", "svb-logo", "S"), title, mk("span", "svb-count", ""), toggle);
      const tools = mk("div", "svb-tools");
      const lines = mk("button", "svb-lines", ""); lines.type = "button";
      lines.addEventListener("click", () => { board.linesOff = !board.linesOff; try { localStorage.setItem("sv-lines-off", board.linesOff ? "1" : ""); } catch (e) {} applyLinesOff(); });
      const sel = mk("select", "svb-lang"); sel.title = "Which language the tips (simpler retelling, grammar, word notes) are written in";
      const tgc = vocabTg || (settings.targets && settings.targets[0]) || "";
      const o1 = mk("option", null, "Tips in " + (tgc ? langLabel(tgc) : "your language")); o1.value = "";
      const o2 = mk("option", null, "Tips in the video's language"); o2.value = "same"; refreshLangOption(vocabPoolLang, o2);
      sel.append(o1, o2); sel.value = tipsExplain;
      sel.addEventListener("change", () => setTipsExplain(sel.value));
      sel.addEventListener("click", (ev) => ev.stopPropagation());
      const share = mk("button", "svb-share", "Share ↗"); share.type = "button"; share.title = "One page with every chunk, its translation and the tips already explained — from the cache, nothing is asked again — to download and send to a friend";
      share.addEventListener("click", (ev) => { ev.stopPropagation(); shareBoard(share); });
      tools.append(lines, speedButton("svb-speed"), share, sel);
      const sceneBtn = mk("button", "svb-scene-btn", "Scene"); sceneBtn.type = "button";
      sceneBtn.addEventListener("click", () => { board.stripHidden = !board.stripHidden; try { localStorage.setItem("sv-strip-collapsed", board.stripHidden ? "1" : ""); } catch (e) {} ensureStrip(); fitPlayer(true); board.sig = ""; board.stripSig = ""; boardTick(true); });
      if (drawer) tools.append(sceneBtn); board.sceneBtn = sceneBtn;
      b.appendChild(head); b.appendChild(tools); b.appendChild(mk("div", "svb-pump"));
      const listEl = mk("div", "svb-list");
      // A hand on the list pauses the follow for a while, so it never yanks
      // the reader back while they scroll.
      for (const evn of ["wheel", "touchstart", "pointerdown"]) listEl.addEventListener(evn, () => { board.userScrollAt = performance.now(); }, { passive: true });
      b.appendChild(listEl);
      // The tips of ONE chunk, in a fixed place under the list — the rows stay short.
      const pane = mk("div", "svb-pane"); pane.appendChild(mk("div", "svb-ph")); pane.appendChild(mk("div", "svb-pb")); b.appendChild(pane);
      for (const evn of ["wheel", "touchstart", "pointerdown"]) pane.addEventListener(evn, () => { board.userScrollAt = performance.now(); }, { passive: true });
      if (host) host.insertBefore(b, host.firstChild); else document.body.appendChild(b);
      board.el = b;
      applyLinesOff(); seedExplained(); askDossier();
      return b;
    };
    // Some players (Netflix) must be driven through their own API — the adapter says so.
    const seekTo = (ms) => { const v = liveVideoEl(video) || video; try { if (adapter && adapter.seek) adapter.seek(ms + 50); else v.currentTime = ms / 1000 + 0.05; } catch (e) {} };
    const playNow = () => { const v = liveVideoEl(video) || video; try { if (adapter && adapter.play) adapter.play(); else { const pr = v.play(); if (pr && pr.catch) pr.catch(() => {}); } } catch (e) {} };
    const pauseNow = () => { const v = liveVideoEl(video) || video; try { if (adapter && adapter.pause) adapter.pause(); else v.pause(); } catch (e) {} };
    const setRate = (r) => { const v = liveVideoEl(video) || video; try { if (adapter && adapter.setRate) adapter.setRate(r); else v.playbackRate = r; } catch (e) {} };
    // Play from a time; with an end time the video pauses there (hear ONE sentence).
    const playFrom = (ms, stopMs) => { board.stopAt = stopMs != null ? stopMs : null; if (stopMs != null) board.loop = -1; seekTo(ms); if (board.rate && board.rate !== 1) setRate(board.rate); playNow(); };
    const rowSig = (ch, k) => [ch.text, ch.sentences.map((x) => x.tr).join("\u0002"), lineExplainCache.has(ch.text) ? 1 : 0, k === board.open ? 1 : 0, k === board.ki ? 1 : 0, k === board.open ? snapChunks : 0, board.loop === k ? 1 : 0, (lineExplainCache.get(ch.text) || {}).scene || "", ((lineExplainCache.get(ch.text) || {}).who || []).join("|"), busyHere(ch) ? 1 : 0, board.facesV].join("\u0001");
    const boardRow = (ch, k) => {
      const on = k === board.ki;
      const row = mk("div", "svb-chunk" + (on ? " on" : "") + (k === board.open ? " open" : "")); row.dataset.k = String(k); row.dataset.sig = rowSig(ch, k);
      const time = mk("button", "svb-time", fmtT(ch.startMs)); time.type = "button"; time.title = "Play from here";
      time.addEventListener("click", (ev) => { ev.stopPropagation(); playFrom(ch.startMs); });
      const main = mk("div", "svb-main");
      const ex = lineExplainCache.get(ch.text);
      ch.sentences.forEach((x, i) => {
        const r = mk("div", "svb-sent");
        const num = mk("button", "svb-sn", String(i + 1)); num.type = "button"; num.title = "Hear this sentence (stops at its end)"; num.addEventListener("click", (ev) => { ev.stopPropagation(); playFrom(x.startMs != null ? x.startMs : ch.startMs, x.endMs); });
        r.appendChild(num);
        // The playing chunk reads like the subtitle: its words light up as they are spoken.
        const units = on && settings.karaokeHl !== false && x.cue ? lineUnits(x.cue, null, x.s) : null;
        r.appendChild(renderSentence(x, ex, units)); main.appendChild(r);
        if (x.tr) { const tr = mk("div", "svb-tr", x.tr); tr.dir = dirOf(tgCode()); main.appendChild(tr); }
      });
      const aside = mk("div", "svb-aside"); // the third column: ✓ tips or Explain — never over the text
      if (ex && !ex.error && (ex.scene || (ex.who && ex.who.length))) { // one line about the scene, and who is in it
        const sc = mk("div", "svb-scene");
        if (ex.scene) { const t = mk("span", "svb-scene-txt", ex.scene); t.dir = explainDir(ex); sc.appendChild(t); }
        for (const f of SV_DOSSIER.whoFaces(ex.who, board.dossier && board.dossier.people)) { const chip = mk("span", "svb-who"); const nm0 = (f.person && f.person.character) || f.label, url0 = (f.person && f.person.photo) || board.faces.get(cleanName(nm0)) || ""; const av = mk("i", null, url0 ? "" : SV_DOSSIER.initials(nm0)); if (url0) av.style.backgroundImage = "url(" + url0 + ")"; else av.style.background = "hsl(" + nameHue(nm0) + " 38% 50%)"; chip.append(av, document.createTextNode((f.person && f.person.character) || f.label)); chip.title = f.person ? (f.person.character || f.person.name) + (f.person.name && f.person.character ? " — " + f.person.name : "") : f.label; sc.appendChild(chip); }
        main.appendChild(sc);
      }
      if (ex && !ex.error) aside.appendChild(mk("i", "svb-mark", k === board.open ? "▸ tips" : "✓ tips"));
      else if (busyHere(ch)) aside.appendChild(mk("i", "svb-mark busy", "explaining"));
      else if (on) { const b = mk("button", "svb-explain", "Explain"); b.type = "button"; b.addEventListener("click", (ev) => { ev.stopPropagation(); boardFocus(k, false, true); }); aside.appendChild(b); }
      // A click pins the pane to this row; a second click hands it back to the playhead.
      // A second click unpins — and jumps back to the playing chunk, so "following" never shows a chunk minutes away.
      row.addEventListener("click", (ev) => { if (ev.target && ev.target.closest && ev.target.closest("button, select, .wt-body")) return; if (board.open === k && board.pinnedAt) { board.pinnedAt = 0; board.open = board.ki; board.sig = ""; boardTick(true); } else boardFocus(k, false, true); });
      row.append(time, main, aside);
      return row;
    };
    // Share: every chunk in order with its translations; the background attaches the cached tips.
    const shareBoard = (btn) => {
      const list = board.list.length ? board.list : chunksNow(); if (!list.length) return;
      if (btn) { btn.disabled = true; btn.textContent = "Preparing…"; }
      send({ type: "SHARE_TIPS", base, explain: tipsExplain, title: SV_TITLE.clean(document.title), url: location.href, lang: vocabPoolLang,
        chunks: list.map((ch) => ({ k: ch.k, startMs: ch.startMs, text: ch.text, sentences: ch.sentences.map((x) => ({ s: x.s, tr: x.tr })) })) })
        .then((r) => { if (!(r && r.ok)) console.warn("[SubVibe] share failed:", r && (r.error || JSON.stringify(r).slice(0, 200))); if (btn) { btn.disabled = false; btn.textContent = r && r.ok ? "Shared ↗" : "Couldn't share"; setTimeout(() => { btn.textContent = "Share ↗"; }, 2500); } });
    // Hoisted for the card's actions row (declared later in this closure; called at click time).
    };
    // Karaoke on the board (every frame): spoken words turn coral, the word
    // being spoken sits on a warm pill, its sentence is the one in focus.
    const boardSung = (t) => {
      // Hear one sentence: pause at its end. Repeat a chunk: jump back at its end.
      if (board.stopAt != null && t >= board.stopAt) { board.stopAt = null; pauseNow(); }
      if (board.loop >= 0) {
        const ch = board.list[board.loop];
        const now = performance.now();
        if (!ch || t < ch.startMs - 2500 || t > ch.endMs + 2500) { if (now - (board.loopSeekAt || 0) > 3000) { board.loop = -1; board.sig = ""; } } // the reader went elsewhere — stop repeating
        else if (t >= ch.endMs && now - (board.loopSeekAt || 0) > 2500) { board.loopSeekAt = now; seekTo(ch.startMs); } // one jump per lap — a seek per frame stalls Netflix at "99%"
      }
      if (!board.el || board.collapsed || board.ki < 0) return;
      const row = board.el.querySelector(".svb-chunk.on"); if (!row) return;
      let live = null, lastDone = null;
      const txts = row.querySelectorAll(".svb-txt");
      for (const el of txts) {
        const W = el.__svW; if (!W) continue;
        let k = 0; while (k < W.units.length && W.units[k].s <= t) k++;
        if (k !== W.k) { for (let j = 0; j < W.spans.length; j++) W.spans[j].classList.toggle("sung", j < k); W.k = k; }
        if (k > 0 && k < W.units.length) live = el; else if (k > 0) lastDone = el; // the sentence being spoken, else the last one finished
      }
      live = live || lastDone;
      // One pill only: the word being spoken in the live sentence. Finished sentences keep their colour, not the pill.
      for (const el of txts) { const W = el.__svW; if (!W) continue; for (let j = 0; j < W.spans.length; j++) W.spans[j].classList.toggle("now", el === live && j === W.k - 1); }
      for (const s of row.querySelectorAll(".svb-sent")) s.classList.toggle("live", !!live && s.contains(live));
    };
    const boardScrollTo = (k, smooth) => {
      const listEl = board.el && board.el.querySelector(".svb-list"); const row = listEl && listEl.querySelector('.svb-chunk[data-k="' + k + '"]');
      if (!row) return;
      const target = Math.max(0, row.offsetTop - listEl.clientHeight / 3);
      try { listEl.scrollTo({ top: target, behavior: smooth ? "smooth" : "auto" }); } catch (e) { listEl.scrollTop = target; }
    };
    // Keyed re-render: only rows whose content changed are replaced, so the
    // list under the reader's hand never disappears mid-scroll.
    const renderBoard = () => {
      const b = ensureBoard(); if (!b) return;
      const listEl = b.querySelector(".svb-list");
      b.querySelector(".svb-count").textContent = board.list.length + (board.list.length === 1 ? " chunk" : " chunks");
      const rows = listEl.children;
      board.list.forEach((ch, k) => {
        const cur = rows[k]; const sig = rowSig(ch, k);
        if (cur && cur.dataset.sig === sig) return;
        const fresh = boardRow(ch, k);
        if (cur) listEl.replaceChild(fresh, cur); else listEl.appendChild(fresh);
      });
      while (listEl.children.length > board.list.length) listEl.removeChild(listEl.lastChild);
      renderPane();
    };
    // The tips pane: the open chunk's tips in one fixed place — it follows the
    // playhead unless the reader pinned a row (click), and "following ▸" hands it back.
    const renderPane = () => {
      const b = board.el; if (!b) return;
      const pane = b.querySelector(".svb-pane"), head = pane.querySelector(".svb-ph"), body = pane.querySelector(".svb-pb");
      const k = board.open, ch = board.list[k]; const ex = ch ? lineExplainCache.get(ch.text) : null;
      // board.list.length is in the signature because the head prints "chunk k / n": a growing cue list must redraw the total.
      const sig = [k, ch ? ch.text : "", ex ? 1 : 0, ex && ex.error ? ex.error : "", snapChunks, tipsExplain, board.loop, board.pinnedAt ? 1 : 0, busyHere(ch) ? 1 : 0, board.list.length].join("\u0001");
      if (sig === board.paneSig) return; board.paneSig = sig;
      head.textContent = ""; body.textContent = "";
      if (!ch) { head.appendChild(mk("b", null, "Tips")); body.appendChild(mk("div", "wt-val svb-empty", "The tips of the playing chunk appear here.")); return; }
      head.appendChild(mk("b", null, "Tips · " + fmtT(ch.startMs) + " · chunk " + (k + 1) + " / " + board.list.length));
      const fol = mk("button", "svb-follow" + (board.pinnedAt ? "" : " on"), board.pinnedAt ? "follow ▸" : "following ▸"); fol.type = "button"; fol.title = board.pinnedAt ? "Back to the playing chunk" : "The pane follows the video";
      fol.addEventListener("click", (ev) => { ev.stopPropagation(); board.pinnedAt = 0; board.open = board.ki; board.sig = ""; boardTick(true); }); head.appendChild(fol);
      if (!ex) { body.appendChild(mk("div", "wt-val svb-empty", busyHere(ch) ? "Explaining…" : "Not explained yet.")); if (!busyHere(ch)) { const b2 = mk("button", "svb-explain", "Explain"); b2.type = "button"; b2.addEventListener("click", () => boardFocus(k, false)); body.appendChild(b2); } return; }
      body.appendChild(buildTips(ex, ch));
      body.appendChild(buildActions({ list: board.list, k0: k, n: snapChunks, setN: (m) => { snapChunks = m; board.sig = ""; boardTick(true); }, anchor: () => els.__orig }));
    };
    // The scene strip under the picture (drawer players): what is playing, what
    // is happening now and who is in it, the cast, and the tips pipeline.
    const ensureStrip = () => {
      if (!stripOn()) { const s = document.getElementById("sv-strip"); if (s) s.remove(); board.stripSig = ""; return null; }
      let s = document.getElementById("sv-strip"); if (s) return s;
      s = mk("div", "sv-strip"); s.id = "sv-strip"; s.dir = "auto";
      s.append(mk("div", "svs-ident"), mk("div", "svs-now"), mk("div", "svs-people"));
      // An accordion, not a pop-up: the section under the pointer (or with keyboard focus) widens in
      // place and the others make room; a short hover intent keeps a crossing mouse from flapping.
      let openT = 0; const setOpen = (v) => { clearTimeout(openT); openT = setTimeout(() => { if (v) s.dataset.open = v; else delete s.dataset.open; }, v ? 220 : 380); };
      for (const el of s.children) { const key = el.className.replace("svs-", ""); el.tabIndex = 0; el.addEventListener("mouseenter", () => setOpen(key)); el.addEventListener("focusin", () => setOpen(key)); }
      s.addEventListener("mouseleave", () => setOpen("")); s.addEventListener("focusout", (e) => { if (!s.contains(e.relatedTarget)) setOpen(""); });
      document.body.appendChild(s);
      return s;
    };
    // Without a photo, each name gets its own steady colour — R and J stay apart across the strip and the rows.
    const nameHue = (name) => { let h = 0; for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
    const photoOf = (p, nm) => (p && p.photo) || board.faces.get(cleanName(nm)) || "";
    // size: sm 40 px in the row · md 48 px in the Now box · lg 72 px cards in a sheet
    const face = (p, label, size, talk) => {
      const nm = (p && (p.character || p.name)) || label;
      const f = mk("span", "svs-face " + size + (talk ? " talk" : ""));
      const url = photoOf(p, nm);
      const av = mk("i", null, url ? "" : SV_DOSSIER.initials(nm)); if (url) av.style.backgroundImage = "url(" + url + ")"; else av.style.background = "hsl(" + nameHue(nm) + " 38% 50%)";
      f.appendChild(av); f.appendChild(mk("b", null, nm));
      if (size === "lg" && p && (p.character ? p.name : p.role)) f.appendChild(mk("small", null, p.character ? p.name : p.role));
      return f;
    };
    const renderStrip = () => {
      if (board.sceneBtn) { board.sceneBtn.textContent = board.stripHidden ? "Scene" : "Hide scene"; board.sceneBtn.title = board.stripHidden ? "Show the scene strip under the picture" : "Hide the scene strip under the picture"; }
      const s = ensureStrip(); if (!s) return;
      s.style.right = Math.round(board.el.getBoundingClientRect().width) + "px";
      const d = board.dossier, list = board.list, ch = list[board.ki], ex = ch ? lineExplainCache.get(ch.text) : null, st = tipsStatus(list, board.ki);
      // Each section repaints only when its own facts change.
      const part = (cls, sig, fill) => { const el = s.querySelector("." + cls); if (!el || el.dataset.sig === sig) return; el.dataset.sig = sig; el.textContent = ""; fill(el); };
      const title = (d && (d.show || d.title)) || SV_TITLE.clean(document.title);
      const epLine = d && d.show ? [d.season ? "S" + d.season + " · E" + d.episode : d.episode ? "E" + d.episode : "", d.epTitle].filter(Boolean).join(" · ") : d && d.channel ? d.channel : "";
      // ── identity: a small poster and the title; the synopsis unfolds when the section is open ──
      part("svs-ident", [d ? d.at : 0, d ? d.poster + (d.backdrop || "") : "", title, epLine, d ? (d.synopsis || d.description || "") : "", (board.credits || []).length].join("|"), (ident) => {
        if (d && d.backdrop) { const art = mk("img", "svs-art"); art.src = d.backdrop; art.alt = ""; art.loading = "lazy"; ident.appendChild(art); } // the wide key art, shown when the section is open
        if (d && d.poster) { const img = mk("img", "svs-poster"); img.src = d.poster; img.alt = ""; ident.appendChild(img); }
        else { const ph = mk("div", "svs-poster ph", SV_DOSSIER.initials(title)); ph.style.background = "hsl(" + nameHue(title) + " 30% 42%)"; ident.appendChild(ph); }
        const idb = mk("div", "svs-id"); idb.appendChild(mk("b", null, title)); if (epLine) idb.appendChild(mk("div", "svs-ep", epLine));
        if (d && (d.synopsis || d.description)) idb.appendChild(mk("div", "svs-syn", d.synopsis || d.description));
        const cr = board.credits || []; if (cr.length) idb.appendChild(mk("div", "svs-made", cr.map((c) => (c.role === "developer" || c.role === "studio" ? "" : c.role + " ") + c.names.join(", ")).join(" · "))); // "Rockstar Games · producer Sam Houser"
        ident.appendChild(idb);
      });
      // ── now: the scene and who is in it; the story so far when the chunk has no tips yet ──
      if (ex && ex.scene) board.lastScene = { scene: ex.scene, who: ex.who || [], ex };
      const who = ex ? SV_DOSSIER.whoFaces(ex.who, d && d.people) : [];
      askFaces(who.map((f) => (f.person && (f.person.character || f.person.name)) || f.label));
      const useRecap = !(ex && ex.scene) && !!recap.text, last = ex && ex.scene ? null : useRecap ? null : board.lastScene;
      const waiting = busyHere(ch) ? "explaining this chunk…" : st.state === "stopped" || st.state === "paused" ? "tips paused — see the board" : ex ? "" : "tips follow the video as it plays";
      part("svs-now", [ch ? ch.text : "", ex ? (ex.scene || "") + (ex.who || []).join("|") : "", busyHere(ch) ? 1 : 0, st.state, d ? d.at : 0, useRecap ? recap.k + recap.text.slice(0, 40) : "", last ? last.scene : "", board.facesV].join("|"), (now) => {
        let facesList = [];
        if (ex && ex.scene) { now.appendChild(mk("div", "svs-lbl", "Now · " + fmtT(ch.startMs))); const sc = mk("div", "svs-scene", ex.scene); sc.dir = explainDir(ex); now.appendChild(sc); facesList = who; }
        else if (useRecap) { now.appendChild(mk("div", "svs-lbl", "Story so far · to " + fmtT(list[recap.k] ? list[recap.k].startMs : 0) + (busyHere(ch) ? " · explaining this chunk…" : ""))); const sc = mk("div", "svs-scene recap", recap.text); sc.dir = dirOf(vocabPoolLang); now.appendChild(sc); facesList = SV_DOSSIER.whoFaces(recap.who, d && d.people); }
        else if (last) { now.appendChild(mk("div", "svs-lbl", "Earlier" + (waiting ? " · " + waiting : ""))); const sc = mk("div", "svs-scene faded", last.scene); sc.dir = explainDir(last.ex); now.appendChild(sc); facesList = SV_DOSSIER.whoFaces(last.who, d && d.people); }
        else if (waiting) { now.appendChild(mk("div", "svs-lbl", "Now")); now.appendChild(mk("div", "svs-scene muted", waiting[0].toUpperCase() + waiting.slice(1))); }
        const faces = mk("div", "svs-faces" + (ex && ex.scene ? "" : " faded")); facesList.slice(0, 4).forEach((f, i) => faces.appendChild(face(f.person, f.label, "md", i === 0 && !!(ex && ex.scene))));
        if (facesList.length > 4) { const more = mk("span", "svs-face md plus"); more.appendChild(mk("i", null, "+" + (facesList.length - 4))); more.appendChild(mk("b", null, "more")); faces.appendChild(more); }
        now.appendChild(faces);
        if (d && (d.stills || []).length) { const still = mk("img", "svs-still"); still.src = d.stills[0]; still.alt = ""; still.loading = "lazy"; now.appendChild(still); } // the episode's own still, when the section is open
        now.classList.remove("svs-swap"); void now.offsetWidth; now.classList.add("svs-swap");
      });
      // ── people: in this scene first, then most seen — tiny at rest, named when the section is open ──
      const dp = (d && d.people) || [];
      if (!board.peopleSeen || board.peopleSeen.n !== st.doneN || board.peopleSeen.at !== (d ? d.at : 0)) {
        const count = new Map();
        for (const e of lineExplainCache.values()) for (const w of (e && e.who) || []) { const k = cleanName(w); if (k && !isRole(k)) count.set(k, (count.get(k) || 0) + 1); }
        const named = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => ({ f: SV_DOSSIER.whoFaces([label], dp)[0], n }));
        const listP = dp.map((p) => ({ p, label: "", n: 0 }));
        for (const { f, n } of named) { const hit = f.person && listP.find((x) => x.p === f.person); if (hit) hit.n += n; else listP.push({ p: null, label: f.label, n }); }
        board.peopleSeen = { n: st.doneN, at: d ? d.at : 0, list: listP.filter((x) => x.p || x.n > 0).sort((a, b) => (b.p && b.p.src === "tmdb" ? 1 : 0) - (a.p && a.p.src === "tmdb" ? 1 : 0) || b.n - a.n) };
      }
      const people = board.peopleSeen.list, inScene = new Set(who.map((f) => f.person || cleanName(f.label)).filter(Boolean));
      askFaces(people.map((x) => (x.p ? x.p.character || x.p.name : x.label)));
      const keyOf = (x) => x.p || cleanName(x.label);
      const ordered = people.slice().sort((a, b) => (inScene.has(keyOf(b)) ? 1 : 0) - (inScene.has(keyOf(a)) ? 1 : 0));
      const castOf = (x) => recap.cast.get(cleanName(x.p ? x.p.character || x.p.name : x.label)) || null;
      const firstSeen = (nm) => { const n = cleanName(nm); for (let j = 0; j < list.length; j++) { const e = lineExplainCache.get(list[j].text); if (e && (e.who || []).some((w) => cleanName(w) === n)) return list[j].startMs; } return -1; };
      part("svs-people", [d ? d.at : 0, ordered.map((x) => (x.p ? x.p.name : x.label) + x.n + (inScene.has(keyOf(x)) ? "*" : "")).join("|"), board.facesV, recap.k].join("|"), (pe) => {
        const tmdb = people.some((x) => x.p && x.p.src === "tmdb");
        const head = mk("div", "svs-lbl"); head.append(mk("span", null, "People · " + people.length), mk("span", "svs-attr", tmdb ? "TMDB" : "")); pe.appendChild(head);
        if (!people.length) { pe.appendChild(mk("div", "svs-scene muted", "People appear here as the chunks meet them")); return; }
        // At rest eight tiny faces and "+N"; open, twelve portraits with names and "+N" — the same row, two chips, CSS picks.
        const row = mk("div", "svs-people-row"); const MAX = 12, REST = 3; // at rest: three overlapped faces and "+N" — the scene keeps the room
        // A face under the pointer opens a card at the end of the row — inside the strip, never over the picture.
        const card = mk("div", "svs-card"); let cardT = 0;
        const showCard = (x) => { clearTimeout(cardT); cardT = setTimeout(() => { const nm = x.p ? x.p.character || x.p.name : x.label, c = castOf(x), since = firstSeen(nm); card.textContent = "";
          card.appendChild(face(x.p, x.label, "md", false)); const tx = mk("div", "svs-card-tx"); const h = mk("b", null, nm); tx.appendChild(h);
          const chips = mk("div", "svs-chips"); if (c) { if (ROLE_WORD[c.role]) chips.appendChild(mk("span", "svs-chip " + c.role, ROLE_WORD[c.role])); chips.appendChild(mk("span", "svs-chip " + c.weight, c.weight === "major" ? "drives the story" : "passes through")); }
          if (x.p && x.p.character && x.p.name) chips.appendChild(mk("span", "svs-chip", x.p.name)); if (chips.childElementCount) tx.appendChild(chips);
          const note = c && c.note ? c.note : x.p && x.p.role ? x.p.role : ""; if (note) { const nt = mk("div", "svs-card-note", note); nt.dir = dirOf(vocabPoolLang); tx.appendChild(nt); }
          tx.appendChild(mk("div", "svs-card-meta", [x.n ? x.n + (x.n === 1 ? " scene" : " scenes") : "", since >= 0 ? "since " + fmtT(since) : ""].filter(Boolean).join(" · ")));
          card.appendChild(tx); pe.dataset.person = nm; }, 180); };
        const hideCard = () => { clearTimeout(cardT); cardT = setTimeout(() => { delete pe.dataset.person; }, 260); };
        ordered.slice(0, MAX).forEach((x) => { const f = face(x.p, x.label, "sm", false); if (inScene.has(keyOf(x))) f.classList.add("here"); const c = castOf(x); if (c && c.role !== "other") f.classList.add("role-" + c.role); if (x.n) f.appendChild(mk("small", "n", String(x.n)));
          f.addEventListener("mouseenter", () => showCard(x)); f.addEventListener("mouseleave", hideCard); row.appendChild(f); });
        if (ordered.length > REST) { const more = mk("span", "svs-face sm plus rest"); more.appendChild(mk("i", null, "+" + (ordered.length - REST))); more.appendChild(mk("b", null, "more")); row.appendChild(more); }
        if (ordered.length > MAX) { const more = mk("span", "svs-face sm plus open"); more.appendChild(mk("i", null, "+" + (ordered.length - MAX))); more.appendChild(mk("b", null, "more")); row.appendChild(more); }
        pe.appendChild(row); pe.appendChild(card); card.addEventListener("mouseenter", () => clearTimeout(cardT)); card.addEventListener("mouseleave", hideCard);
      });
    };
    // The tips pipeline lives on the board, under its tools: how far the tips reach, what is being explained, Explain all / Stop / Retry.
    const renderPump = () => {
      const b = board.el; if (!b) return; const el = b.querySelector(".svb-pump"); if (!el) return;
      const list = board.list, n = list.length, st = tipsStatus(list, board.ki);
      const ranges = []; let start = -1;
      for (let j = 0; j <= n; j++) { const on = j < n && lineExplainCache.has(list[j].text); if (on && start < 0) start = j; if (!on && start >= 0) { ranges.push([start, j]); start = -1; } }
      const wait = st.state === "paused" ? Math.max(0, Math.ceil((tips.pausedUntil - performance.now()) / 10000) * 10) : 0;
      const sig = [st.state, st.doneN, n, st.readyToMs, st.busy.join(","), st.all, st.reason, board.ki, ranges.map((r) => r.join("-")).join(","), wait, board.collapsed ? 1 : 0].join("|");
      if (sig === board.pumpSig) return; board.pumpSig = sig; el.textContent = ""; el.hidden = board.collapsed || !n;
      if (el.hidden) return;
      const bar = mk("div", "svs-bar");
      for (const [a, c] of ranges) { const i = mk("i"); i.style.left = (100 * a / n) + "%"; i.style.width = (100 * (c - a) / n) + "%"; bar.appendChild(i); }
      for (const j of st.busy) { const e = mk("em"); e.style.left = (100 * j / n) + "%"; e.style.width = (100 / n) + "%"; bar.appendChild(e); }
      if (board.ki >= 0) { const u = mk("u"); u.style.left = (100 * board.ki / n) + "%"; bar.appendChild(u); }
      const txt = st.state === "off" ? "Tips ahead is off (popup)" : st.state === "stopped" ? "Tips paused — " + (st.reason || "couldn't explain")
        : st.state === "paused" ? "Tips paused — " + (st.reason || "couldn't explain") + (wait ? " · retrying in " + wait + " s" : "")
        : "Tips " + st.doneN + " / " + n + (st.readyToMs ? " · ready to " + fmtT(st.readyToMs) : "") + (st.busy.length ? " · explaining " + st.busy.map((j) => fmtT(list[j].startMs)).join(" · ") : "");
      const stEl = mk("span", "svb-pump-st", txt); stEl.title = txt;
      let btn = null;
      if (st.state === "stopped" || st.state === "paused") { btn = mk("button", "svb-explain", "Retry now"); btn.addEventListener("click", tipsRetry); }
      else if (st.all) { btn = mk("button", "svb-explain", "Stop"); btn.addEventListener("click", () => tipsAll(false)); }
      else if (st.doneN < n) { btn = mk("button", "svb-explain", "Explain all →"); btn.title = "Explain every chunk of this video now, one after the other"; btn.addEventListener("click", () => tipsAll(true)); }
      if (btn) btn.type = "button";
      el.append(bar, stEl); if (btn) el.appendChild(btn);
    };
    // Open a chunk on the board: explain it (cached), show its tips, follow it.
    const boardFocus = (k, flash, pin) => {
      const list = board.list.length ? board.list : chunksNow(); board.list = list;
      const ch = list[k]; if (!ch) return;
      if (pin) board.pinnedAt = performance.now(); // a reader's click holds the pane here
      board.open = k; board.sig = ""; boardTick(true); boardScrollTo(k, true);
      if (flash) { const row = board.el && board.el.querySelector('.svb-chunk[data-k="' + k + '"]'); if (row) { row.classList.add("flash"); setTimeout(() => row.classList.remove("flash"), 1200); } }
      if (!lineExplainCache.get(ch.text)) explainChunk(ch, list).then(() => { board.sig = ""; boardTick(true); });
    };
    // Called every frame from tick; does real work at most every 600 ms and
    // re-renders only when something changed (a new line, a translation, the
    // playing chunk, an explanation).
    // Once a second: the overlay must sit in the LIVE player container (Netflix swaps it on
    // an episode change) and every dragged line's edge correction is recomputed against the
    // real box — a correction computed during the swap's animation parked lines top-left.
    let healAt = 0;
    const healOverlay = (now) => {
      if (now - healAt < 1000) return; healAt = now;
      try { const o = ensureOverlay(); if (o.classList.contains("copilot-pos-custom")) for (const ln of o.querySelectorAll(".copilot-subs__line")) keepLineInside(ln); } catch (e) {}
    };
    const boardTick = (force) => {
      const now = performance.now();
      healOverlay(now);
      if (!force && now - board.at < 600) return;
      board.at = now;
      const b = ensureBoard(); if (!b) return;
      askDossier(); // a no-op once asked — the retry for a board that was built during an ad
      b.classList.toggle("fs", !!document.fullscreenElement); // a drawer never sits over a fullscreen picture
      if (b.classList.contains("drawer")) fitPlayer(!board.collapsed && !document.fullscreenElement); // the picture makes room (re-applied if the player re-renders)
      ensureStrip(); // collapsed, fullscreen or hidden: the strip leaves with the board
      if (board.collapsed) return;
      const list = chunksNow();
      const ki = curCue ? chunkOfCue(list, curCue) : -1;
      if (boardVisible()) { tipsPump(list, ki); wantRecap(list, ki); } // the next chunks are explained before the playhead reaches them; the catch-up refreshes every 8
      // Tips at the start of each chunk: the pane opens the playing chunk by
      // itself (it shows "Explaining…" until the pump delivers) — unless a
      // row was pinned by a click in the last 20 s.
      if (ki >= 0 && ki !== board.ki && (!board.pinnedAt || now - board.pinnedAt > 20000)) { board.open = ki; board.pinnedAt = 0; }
      const trN = list.reduce((n, ch) => n + ch.sentences.filter((x) => x.tr).length, 0);
      const exN = list.filter((ch) => lineExplainCache.has(ch.text)).length;
      const sig = [list.length, trN, ki, exN, board.open, snapChunks, tipsExplain, tips.inflight.size, tips.stopped ? 1 : 0, tips.all ? 1 : 0].join(":");
      if (sig === board.sig) { renderPane(); renderStrip(); renderPump(); return; }
      const follow = ki !== board.ki;
      board.sig = sig; board.list = list; board.ki = ki;
      // A small state stamp for diagnosis from the page (the script's variables are not reachable there).
      try { document.documentElement.dataset.svBoard = JSON.stringify({ ki, open: board.open, loop: board.loop, stopAt: board.stopAt, rate: board.rate, tips: tipsStatus(list, ki).state, chunk: list[ki] ? [Math.round(list[ki].startMs), Math.round(list[ki].endMs)] : null }); } catch (e) {}
      renderBoard();
      renderStrip(); renderPump();
      // Follow the playhead — unless the reader scrolled the list in the last 6 s.
      if (follow && ki >= 0 && now - board.userScrollAt > 6000) boardScrollTo(ki, true);
      applyLinesOff();
    };

    // No hover handler — a word's card opens on CLICK only (openWordCard above),
    // which pauses the video, so a lookup never races the moving subtitle line.

    cancelAnimationFrame(rafId);
    let diagAt = 0;
    // Becomes true once this clip has actually played. Lets us keep pre-translating
    // the buffered-ahead window WHILE PAUSED — so pausing a live/DVR stream (or any
    // video) lets the translation run ahead and cache — yet stay idle (no spend) on a
    // video you've never started (e.g. a muted autoplay promo on a browse page).
    let engaged = false;
    const tick = () => {
      boardTick(); // the story board follows the playhead (YouTube's side column)
      video = liveVideoEl(video); // DW's video.js can swap the <video> element mid-play
      if (video && !video.paused && (video.currentTime || 0) > 0.5) engaged = true;
      // Latched live detection. Infinity ⇒ live; a real finite duration ⇒ VOD;
      // NaN keeps the previous verdict. The old !isFinite() matched NaN too, so
      // a metadata-less element (fresh SPA clip, hover-preview) read as "live"
      // and woke the live-only auto-calibrator on plain VOD (the +15s incident).
      // The latch protects the other direction too: a single NaN tick during a
      // real live stream's MediaSource rebuild must not zero the converged
      // auto-offset or let persist() cache a live channel under the shared key.
      const dur0 = video && video.duration;
      if (dur0 === Infinity) isLiveStream = true;
      else if (typeof dur0 === "number" && isFinite(dur0) && dur0 > 0) isLiveStream = false;
      // PLAYING with an advancing clock but still no finite duration = live.
      // ZDF live reports NaN (not Infinity), so without this rule the latch
      // never flipped and the manual timing shift silently multiplied by zero.
      // The clock MUST be playheadMs(): the raw element currentTime reads ~0 in
      // this isolated world on MSE players (ZDF live!) — reading it directly
      // silently disabled this very rule. playheadMs() falls back to the
      // page-world relay, the same clock every other consumer trusts.
      // Safe for VOD: metadata (finite duration) always lands before playback
      // can advance past the first half-second.
      else if (video && !video.paused && playheadMs(video) > 500) isLiveStream = true;
      // PAUSED ZDF live: the rule above can never arm (it requires playing), and
      // NaN keeps the verdict — so an engine that starts against an already-paused
      // live tab (content script injected late, tab refreshed while paused) reads
      // as VOD forever and the manual shift silently multiplies by zero. Arm from
      // pause ONLY while the verdict is still null: a clip that ever reported a
      // finite duration stays VOD through NaN flickers (the hover-preview and SPA
      // +15s incidents stay impossible). A paused pre-metadata VOD normally can't
      // get here (clock ~0, no cues); the narrow slip-through — restored caption
      // track feeding nativePlayheadMs before metadata — mis-arms only until the
      // finite duration lands, which flips the verdict and drops the auto-offset.
      else if (isLiveStream == null && video && video.paused && Number.isNaN(dur0) && playheadMs(video) > 500 && cues.length) isLiveStream = true;
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
        if (t > lastEnd && t - lastEnd < 20000) {
          i = cues.length - 1;
          // A shift the user JUST made that lands past the newest line would
          // otherwise re-show the same text — reading as a dead control. Say why.
          if (performance.now() - liveOffsetChangedAt < 5000 && liveClampNotedAt !== liveOffsetChangedAt) {
            liveClampNotedAt = liveOffsetChangedAt;
            setStatus(`Live edge — no newer subtitle exists yet (${((t - lastEnd) / 1000).toFixed(1)}s past the newest line). It applies as new lines arrive.`);
          }
        }
      }
      const c = i >= 0 ? cues[i] : null;
      curCue = c; // click-to-save reads the on-screen cue from here
      boardSung(t);
      const kar = settings.karaokeHl !== false;
      for (const d of defs) {
        const el = els[d.key];
        const txt = c ? (d.target ? fixQ(groupSlice(c, d.target), d.target) : c.original) : "";
        // Unit key: a REPEATED line (song refrain) keeps txt identical while the
        // cue changes — the karaoke fill must still restart from the new times.
        const uk = c && kar ? (c.grp ? c.grp.cues[0].startMs : c.startMs) + ":" + (d.target || "") : "";
        if (el.textContent !== txt || (kar && el.__svUk !== uk)) {
          setLineText(el, txt, kar ? lineUnits(c, d.target, txt) : null);
          el.__svUk = uk;
          el.style.display = txt ? "block" : "none";
          el.dir = (d.target ? isRTLLang(d.target) : isRTL(txt)) ? "rtl" : "ltr";
          if (!d.target && vocabPool && el.__svW) markLearnWords(el); // learn-pool hint underline
        }
        if (kar) updateSung(el, t);
      }
      // Track the ﹖ hint button to the ORIGINAL line's top-right (hide when no
      // original line is on screen). It lives on the overlay, so this never
      // touches the line's own DOM.
      if (hintBtn) {
        // The button sits at the end of the TEXT (a banner row spans the whole
        // player); when the original line is hidden, the first visible line will do.
        let ol = els.__orig;
        if (!(ol && ol.style.display !== "none" && ol.textContent)) ol = defs.map((d) => els[d.key]).find((el) => el && el.style.display !== "none" && el.textContent) || null;
        if (ol) {
          const tx = ol.querySelector(".copilot-subs__text");
          const or = overlay.getBoundingClientRect(), lr = (tx && tx.getBoundingClientRect().width > 0 ? tx : ol).getBoundingClientRect();
          hintBtn.style.display = "block";
          hintBtn.style.left = Math.round(Math.min(lr.right - or.left + 6, or.width - 30)) + "px";
          hintBtn.style.top = Math.round(lr.top - or.top) + "px";
        } else hintBtn.style.display = "none";
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
        // Dub Mode's own readiness counter (clips decoded and ready to play in
        // the next ~60s) — ADDS a field to the existing payload, never restructures it.
        const dub = window.__svDub && window.__svDub.readyAhead ? { dubReady: window.__svDub.readyAhead() } : {};
        if (!active) setBadge({ off: true, ...dub });
        else if (pending <= 0) setBadge({ free: true, ...dub });
        else setBadge({ count: done, state: behindMs < 3500 ? "miss" : "lag", ...dub });
        try {
          document.documentElement.dataset.csDiag = JSON.stringify({
            mode: "cuelist", src: interceptedUrl ? "file" : "native",
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
    const persist = debounce(() => {
      // Don't cache LIVE: it's not replayable, and all live channels share the same
      // clip key (/gp/video/livetv) so caching would mix channels and pollute the Library.
      if (isLiveStream) return;
      for (const tg of settings.targets) {
        send({ type: "CACHE_PUT", key: `${base}:auto:${tg}`,
          track: { site: adapter?.site, videoId, source: "auto", target: tg, model: "gpt-4o-mini", createdAt: new Date().toISOString(),
            title: pageTitle, url: pageUrl, totalCues: cues.length,
            cues: cues.filter((c) => c.t[tg]).map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.t[tg], o: c.original, sid: c.spk && c.spk.id, sg: c.spk && c.spk.g,
              dt: c.grp && c === c.grp.cues[0] ? (c.grp.d || undefined) : undefined })) } });
      }
    }, 3000);
    rafId = requestAnimationFrame(tick);
    if (window.__svDub) window.__svDub.attach({
      base: `${base}:auto:${settings.targets[0] || "en"}`,
      target: settings.targets[0] || null,
      getVideo: () => liveVideoEl(video),
      playhead: () => playheadMs(liveVideoEl(video)) + (isLiveStream ? (liveOffsetMs + liveAutoOffsetMs) : 0),
      live: () => isLiveStream,
      cues,
      site: adapter && adapter.site,
      persist,
    });
    ensureAudioStopped();
    applyHideNative(settings.hideNative);
    // If this clip's translations are already cached (a re-watch), say so — it's
    // free and instant, which is SubVibe's whole replay story.
    const tgs0 = settings.targets || [];
    const cachedReady = tgs0.length && cues.length ? cues.filter((c) => tgs0.every((g) => c.t[g])).length / cues.length : 0;
    setStatus(cachedReady > 0.9 ? "Replaying from cache — free, no API cost ✓" : "Subtitles ready — pre-translating ahead.");
    console.info(`[CopilotSubs] perfect-sync ON — ${cues.length} cues`);

    // Translate the next ~30s ahead of the playhead, one batch at a time.
    // Keep ingesting cues as ZDF streams more of them in during playback.
    // Keep ingesting as more cues arrive. HLS players (e.g. DW) add subtitle
    // cues to the text track segment-by-segment during playback, so re-read the
    // live track too — not just the one-shot intercepted file.
    // A complete intercepted FILE is authoritative — never merge the player's
    // own track cues on top of it. YouTube's native track rolls the previous +
    // current line into ONE cue with its own timestamps; merging those in
    // duplicated every line under near-miss startMs values, so the duplicates
    // missed the cache, the pump re-translated them (real spend), the badge
    // read 0/8 in already-watched territory, and the display flip-flopped
    // between the one-line and two-line copies. Only merge the live track
    // while the file does NOT cover the clip (HLS sites stream cues in
    // segment-by-segment; live has no duration and always merges).
    const fileCoversClip = () => {
      if (!interceptedUrl || !cues.length) return false;
      // YouTube VOD timedtext is always the complete track — no heuristic needed.
      // (Live falls through: duration is Infinity, durMs 0 → keep merging.)
      if (adapter && adapter.site === "youtube" && video && isFinite(video.duration)) return true;
      const durMs = video && isFinite(video.duration) ? video.duration * 1000 : 0;
      return durMs > 0 && cues[cues.length - 1].startMs >= 0.8 * durMs;
    };
    const reread = setInterval(() => {
      if (!fileCoversClip()) {
        const native = readVideoCueList(video);
        if (native && native.length) onInterceptedCues(native); // dedups into interceptedCues
      }
      const fresh = getAllCues(video);
      if (fresh) ingest(fresh);
      buildGroups(cues); // re-group as new cues arrive (streaming sources)
    }, 3000);

    // Up to TWO batches in flight: Claude's ~13-20s per call outruns a single
    // serial pipe on dense speech — the runway drained faster than it filled.
    // In-flight content is marked on the CUES (c.pend[tg]), not the groups:
    // buildGroups rebuilds group objects every 3s, so a group-level flag would
    // be wiped mid-call and the same lines re-sent (double billing).
    let inFlight = 0;
    const pump = setInterval(async () => {
      if (inFlight >= 2) return;
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
        // Claude batches take several times longer than gpt-4o-mini — give the
        // pump a longer runway (~2.5 min) so slower calls land well before the
        // playhead and batches fill up instead of trickling out one line at a time.
        const claudeT = settings.translationProvider === "claude";
        const MAX_AHEAD_CUES = claudeT ? 80 : 24;
        let i0 = 0;
        while (i0 < cues.length && cues[i0].startMs < t - 4000) i0++;
        const groups = [], gseen = new Set();
        for (let k = i0; k < cues.length && k < i0 + MAX_AHEAD_CUES; k++) {
          const c = cues[k];
          if (c.startMs > t + (claudeT ? 150000 : 45000)) break; // also never run far ahead in time
          const g = c.grp;
          if (!g || !g.closed || g.t[tg] || gseen.has(g)) continue;
          if (g.cues.some((cc) => cc.pend && cc.pend[tg])) continue; // already in flight
          gseen.add(g); groups.push(g);
          if (groups.length >= 12) break;
        }
        if (!groups.length) continue;
        // A lone group re-bills the full prompt for one line. LIVE: give a second
        // group ~4s to accumulate. VOD: hold a lone batch while its line isn't due
        // within 12s — the deadline always wins over batching, nothing shows late.
        if (claudeT && groups.length === 1) {
          if (isLiveStream) { if (t - groups[0].cues[0].startMs < 4000) continue; }
          // 30s: comfortably above Claude's observed worst call (~21s) — a 12s
          // margin would have guaranteed a late line every time the hold fired.
          else if (groups[0].cues[0].startMs - t > 30000) continue;
        }
        for (const g of groups) for (const cc of g.cues) (cc.pend ||= {})[tg] = 1;
        inFlight++;
        let released = false;
        const release = () => {
          if (released) return;
          released = true; inFlight--;
          for (const g of groups) for (const cc of g.cues) if (cc.pend) delete cc.pend[tg];
        };
        // Last-resort zombie-slot reclaim ONLY. A LEGITIMATE call can run minutes:
        // the worker retries 429s with up to 25s waits x3 attempts, then halves the
        // batch and retries each half — firing early re-bills content still in
        // flight (the old 20s guard's exact bug). Extension reloads resolve via
        // resp.dead, so this timer covers only a truly hung worker; with two slots
        // a wedged one no longer stalls the pump, so it can afford to be patient.
        const guard = setTimeout(release, 300000);
        let resp;
        try { resp = await send({ type: "TRANSLATE", cues: groups.map((g) => g.orig), source: "auto", target: tg, site: adapter?.site, title: SV_TITLE.clean(document.title), base: lastCacheBase }); }
        finally { clearTimeout(guard); release(); }
        if (resp?.dead) return; // extension reloaded — orphaned script, stop quietly (haltOrphaned showed the refresh hint)
        if (resp?.error) {
          // Transient OpenAI blips (5xx/520/429) self-recover on the next tick — show a
          // gentle, fading note rather than a scary sticky "Translation failed".
          const transient = /temporarily unavailable|rate limited|\bOpenAI (?:429|5\d\d)\b/i.test(resp.error);
          setStatus(transient ? `${langLabel(tg)}: translator busy — retrying…` : `Translation failed (${langLabel(tg)}): ${resp.error}`, !transient);
          return;
        }
        if (resp?.lines) groups.forEach((g, k) => {
          if (!resp.lines[k]) return;
          // An RTL target answered with the source line, no RTL script at all:
          // that's the worker's failed-batch fallback, not a translation. Leave
          // the group untranslated so the next pump round retries it — but only
          // twice, so a group the model INSISTS is non-speech ("[music]") can't
          // become an every-round re-spend loop.
          const echo = isRTLLang(tg) && resp.lines[k] === g.orig && !isRTL(resp.lines[k]);
          if (echo && (g.echoN = (g.echoN || 0) + 1) <= 2) return;
          // Single-space-normalized: karaoke's word units only attach when they
          // reassemble into the display text exactly — stray double spaces from
          // the model silently disabled the highlight for that line.
          const line = resp.lines[k].replace(/\s+/g, " ").trim();
          g.t[tg] = line;
          for (const cc of g.cues) cc.t[tg] = line;
          if (tg === settings.targets[0]) {                      // tag once, from the primary target's pass
            g.spk = { id: (resp.spk && resp.spk[k]) || 0, g: (resp.gen && resp.gen[k]) || "?" };
            for (const cc of g.cues) cc.spk = g.spk;
            g.d = (resp.dub && resp.dub[k]) || null;             // condensed dub rendition (dub.js falls back to g.t when null)
          }
        });
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
      row.className = "copilot-subs__line" + (d.target ? "" : " copilot-subs__line--orig");
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
        const txt = c ? (d.target ? fixQ(groupSlice(c, d.target), d.target) : c.original) : "";
        if (el.textContent !== txt) {
          setLineText(el, txt);
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
      const resp = await send({ type: "TRANSLATE", cues: [text], source: "auto", target: tg, context: ctx,
        site: adapter?.site, title: SV_TITLE.clean(document.title), base: lastCacheBase || clipBaseId() }); // meta: the Activity log needs a name for the row
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
    { const b = document.getElementById("sv-board"); if (b) b.remove(); const s = document.getElementById("sv-strip"); if (s) s.remove(); for (const el of document.querySelectorAll("[data-sv-fit]")) { el.style.right = el.dataset.svFitRight || ""; el.style.width = el.dataset.svFitWidth || ""; el.style.bottom = el.dataset.svFitBottom || ""; el.style.height = el.dataset.svFitHeight || ""; delete el.dataset.svFit; } }
    currentRunKey = null;
    schedule(); // resume caption scraping if the page has its own captions
  }

  // ─── Live Translate (experimental) ───────────────────────────────────────────
  // Transcript lines relayed from the Gemini Live session (offscreen document).
  // Takes over the overlay like audio mode does; the translated text arrives
  // ready, so no TRANSLATE calls happen here. LIVE_STATE {running:false}
  // hands the overlay back to the normal engine.
  let liveMode = false, liveIdleT = 0;
  // Voice-only live: when the engine already runs PERFECT-SYNC subtitles
  // (cueListActive), the live session contributes just the translated VOICE —
  // the engine keeps the screen, its timing, and the karaoke sweep. The
  // transcript lines paint only where no caption engine is running (unsupported
  // sites, no-caption videos). Decided ONCE at session start, deliberately —
  // flip-flopping mid-session would thrash the overlay.
  let liveVoiceOnly = false;
  // Enter live mode the moment the session STARTS (LIVE_STATE running:true) —
  // not on the first transcript. Waiting for text left the scrape engine
  // painting its rolling word-by-word captions straight through the live
  // session (the operator's "appending words" was THAT, not the transcripts).
  async function liveEnter() {
    if (liveMode) return;
    liveMode = true;
    const settings = await getSettings();
    // Full engine teardown: stops the tick AND the pump/reread intervals
    // (no background billing on scrape fragments), detaches a running dub
    // (no voice collision), clears the badge. ensureOverlay rebuilds fresh.
    teardown();
    currentRunKey = null;
    const overlay = ensureOverlay();
    applyAppearance(settings);
    const stack = overlay.querySelector(".copilot-subs__stack");
    stack.innerHTML = "";
    for (const key of ["__orig", "__live"]) {
      const row = document.createElement("div");
      row.className = "copilot-subs__line" + (key === "__orig" ? " copilot-subs__line--orig" : "");
      row.dataset.csKey = key;
      stack.appendChild(row);
    }
    setStatus("Live Translate — listening…");
  }
  async function liveShow(orig, out) {
    const settings = await getSettings();
    await liveEnter();
    const overlay = document.getElementById("copilot-subs");
    if (!overlay) return;
    const rows = overlay.querySelectorAll(".copilot-subs__line");
    const ro = rows[0], rt = rows[1];
    if (ro) {
      if (settings.showOriginal && orig) { setLineText(ro, orig); ro.style.display = "block"; ro.dir = isRTL(orig) ? "rtl" : "ltr"; }
      else ro.style.display = "none";
    }
    if (rt && out) { out = fixQ(out, (settings.targets && settings.targets[0]) || ""); setLineText(rt, out); rt.style.display = "block"; rt.dir = isRTL(out) ? "rtl" : "ltr"; }
    // A quiet room keeps the last line ~8s, then the overlay clears until the
    // next spoken line — live has no cue end times to honor.
    clearTimeout(liveIdleT);
    liveIdleT = setTimeout(() => {
      const o = document.getElementById("copilot-subs");
      if (o && liveMode) o.querySelectorAll(".copilot-subs__line").forEach((r) => (r.style.display = "none"));
    }, 8000);
  }
  // The engine reached PERFECT-SYNC while a live session runs: the cuelist
  // takes the screen back (timed lines, karaoke, cache) and the session
  // demotes itself to voice-only. This is what makes the pairing self-healing
  // after a tab reload — the fresh page briefly goes full-live (no engine yet),
  // then the file adopts and text returns.
  function liveYieldToCuelist() {
    if (!liveMode) return;
    liveMode = false;
    liveVoiceOnly = true;
    clearTimeout(liveIdleT);
    setStatus("Perfect-sync subtitles are back — Live keeps speaking the translation.");
  }
  function liveEnd() {
    if (!liveMode) return;
    liveMode = false;
    clearTimeout(liveIdleT);
    currentRunKey = null;
    schedule(); // normal engine takes the overlay back
  }

  // ─── orchestration ───────────────────────────────────────────────────────────

  async function start() {
    if (!extAlive()) return; // orphaned by a reload — don't touch chrome.* APIs
    // A running live session no longer blocks the engine. If this page can
    // reach perfect-sync, the engine takes the screen and live demotes to
    // voice-only (liveYieldToCuelist). Only the text-painting FALLBACKS
    // (scrape, audio) stay suppressed — live's transcript overlay replaces
    // exactly those.
    dbgSub.starts++;
    const settings = await getSettings();
    liveOffsetMs = Math.round((settings.syncOffset || 0) * 1000);
    const ad = pickAdapter();
    const vid = ad && ad.matches && ad.matches() ? ad.getVideoId() : null;

    // Skip redundant restarts: if nothing relevant changed and we're already
    // showing an overlay, don't tear it all down (kills the live loop).
    const runKey = JSON.stringify({
      en: settings.enabled, tr: settings.translateOn, v: vid,
      t: settings.targets, o: settings.showOriginal, h: settings.hideNative,
      p: settings.position, s: settings.size, k: settings.karaokeHl,
      // Whether this clip's FULL cue list has been intercepted yet. Without this,
      // when the subtitle file arrives LATE the run key looks "unchanged" so start()
      // early-returns, leaving the engine in its reactive fallback and the counter
      // stuck at 0 — only a lucky-timing reload "fixes" it. Applies to ALL adapters:
      // Netflix (TTML fetch-hook) AND YouTube (the pot-token timedtext intercept,
      // which routinely lands after the first start()), plus ZDF/DW/Prime.
      cl: !!(interceptedCues && interceptedCues.length && interceptedClipId === currentClipId()),
    });
    if (runKey === currentRunKey && document.getElementById("copilot-subs")) { dbgSub.adopt = "deduped (run unchanged)"; return; }
    currentRunKey = runKey;
    // Reentrancy fence. start() awaits real network (getCaptionTracks, cache
    // reads) — a NEWER start can complete an engine while an older one sleeps.
    // The harness proved the older one then resumes and rebuilds scrape ON TOP
    // of the fresh cuelist engine without a teardown, leaving cueListActive
    // stuck true — which in turn disables the upgrade valve, onInterceptedCues
    // and the dedupe key. So: every await below is followed by a staleness
    // check, and a superseded start returns without touching anything.
    const gen = ++engineGen;
    const stale = () => gen !== engineGen;

    // Under a full-live overlay, DON'T tear down yet — if this start ends in a
    // suppressed fallback, the live transcript lines must survive untouched.
    // Any path that builds an engine tears down right before building.
    if (!liveMode) teardown();
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
    if (stale()) { dbgSub.stale = "start superseded (waiting for video)"; return; }
    if (!video) { currentRunKey = null; return; } // not ready — allow a retry

    // Streaming sources: if the browser exposes the full caption track (e.g. ZDF),
    // use it for perfect-sync pre-translation; otherwise scrape on-screen captions.
    if (adapter.stream) {
      const cueList = await waitFor(() => getAllCues(video), 3000);
      if (stale()) { dbgSub.stale = "start superseded (waiting for cues)"; return; }
      if (cueList && cueList.length) { dbgSub.adopt = "cuelist(stream) " + cueList.length; liveYieldToCuelist(); await runCueListMode(settings, video, cueList, gen); return; }
      if (liveMode) { dbgSub.adopt = "scrape suppressed (live voice active)"; return; }
      dbgSub.adopt = "scrape (stream: no track cues yet)";
      await startStream(settings, video, gen);
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
      if (inter && inter.length) { dbgSub.adopt = "cuelist(file) " + inter.length; liveYieldToCuelist(); await runCueListMode(settings, video, inter, gen); return; }
      dbgSub.adopt = "file not usable at start #" + dbgSub.starts + (dbgSub.hold ? " (" + dbgSub.hold + ")" : "");
    }

    setStatus("Loading captions…");
    let tracks = [];
    try { tracks = await adapter.getCaptionTracks(videoId); } catch { tracks = []; }
    // THE await that bit in production: getCaptionTracks is a real network call,
    // and the intercepted caption file routinely lands while it's in flight.
    if (stale()) { dbgSub.stale = "start superseded (during getCaptionTracks)"; return; }
    const originalTrack = pickOriginalTrack(tracks);

    // Try the direct download (still works on some sites / when logged in). If it
    // comes back empty (YouTube anti-scraping), fall through.
    let originalCues = [];
    if (originalTrack) {
      try { originalCues = await adapter.fetchCues(originalTrack.baseUrl); }
      catch (e) { console.warn("[CopilotSubs] fetchCues failed", e); originalCues = []; }
      if (stale()) { dbgSub.stale = "start superseded (during fetchCues)"; return; }
    }
    if (!originalCues.length) {
      if (adapter.readNativeText) {
        // Turn ON the player's CC: that makes YouTube fetch its real caption file
        // (with the token), which we intercept and upgrade to perfect-sync with
        // pre-translation. Until then, scrape the on-screen captions line by line.
        setStatus("Turn ON the player's CC (subtitles) — then I'll pre-translate the whole track in sync.", true);
        if (liveMode) { dbgSub.adopt = "scrape suppressed (live voice active)"; return; }
        dbgSub.adopt = "scrape (direct download empty) at start #" + dbgSub.starts;
        await startStream(settings, video, gen);
        return;
      }
      if (liveMode) return; // live transcript lines already cover the no-captions case
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
    dbgSub.adopt = "cuelist(track) " + originalCues.length;
    liveYieldToCuelist();
    await runCueListMode(settings, video, originalCues, gen);
  }

  // ─── wiring ──────────────────────────────────────────────────────────────────

  const schedule = debounce(() => { start().catch((e) => console.warn("[CopilotSubs]", e)); }, 400);

  // Appearance keys (position, drag coords, text size, style preset/tweaks) and
  // the sync nudge apply LIVE — re-style in place, no flicker. Anything else
  // (languages, key, enabled…) restarts the engine.
  const LIVE_KEYS = ["syncOffset", "position", "linePositions", "size", "stylePreset", "styleCustom", "karaokeStyle", "dubEnabled", "dubVoice", "dubGeminiVoice", "ttsProvider", "dubMultiVoice", "dubDuckLevel", "dubPace", "debugHud", "tipsAhead", "tmdbKey"];
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const keys = Object.keys(changes);
    // This clip's sync/appearance can change via a global default key OR via its
    // per-clip override (clipOverrides). Either way, recompute the EFFECTIVE (merged)
    // settings and apply sync + appearance live — no restart, no flicker.
    const overChanged = keys.includes("clipOverrides");
    if (overChanged || keys.some((k) => LIVE_KEYS.includes(k))) {
      getSettings().then((s) => {
        const next = Math.round((s.syncOffset || 0) * 1000);
        if (next !== liveOffsetMs) { liveOffsetMs = next; liveOffsetChangedAt = performance.now(); }
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
  // ── On-video debug HUD (popup: "Debug overlay") ────────────────────────────
  // One screenshot = full diagnosis: engine mode, playhead, cue counts, and
  // every stage of the caption-file pipeline (spotted → fetched → adopted).
  setInterval(async () => {
    let on = false;
    try { on = (await getSettings()).debugHud; } catch {}
    let hud = document.getElementById("copilot-subs-hud");
    if (!on) { if (hud) hud.remove(); return; }
    const parent = (adapter && adapter.getPlayerContainer && adapter.getPlayerContainer()) || document.body;
    if (!hud) {
      hud = document.createElement("div");
      hud.id = "copilot-subs-hud";
      hud.style.cssText = "position:absolute;top:8px;left:8px;z-index:2147483001;background:rgba(0,0,0,.78);color:#8fe3a8;font:11px/1.55 ui-monospace,Menlo,monospace;padding:7px 10px;border-radius:7px;pointer-events:none;white-space:pre;max-width:46%;";
    }
    if (hud.parentElement !== parent) parent.appendChild(hud);
    let d = {};
    try { d = JSON.parse(document.documentElement.dataset.csDiag || "{}"); } catch {}
    hud.textContent = [
      "SubVibe debug",
      "mode: " + (liveMode ? "LIVE" : (d.mode || "—") + (liveVoiceOnly ? " + live voice" : "")) + (d.src ? " (" + d.src + ")" : ""),
      "play: " + (d.play != null ? d.play : "—") + "  cues: " + (d.total != null ? d.total : d.cues != null ? d.cues : "—"),
      d.live != null ? "live-stream: " + d.live + "  autoOff: " + d.autoOff : null,
      d.heard != null ? "scrape heard: " + JSON.stringify(String(d.heard).slice(0, 42)) : null,
      "file spotted: " + (dbgSub.spotted || "NONE"),
      "file fetch:   " + (dbgSub.fetch || "—"),
      "intercepted:  " + (interceptedCues ? interceptedCues.length + " cues " + (interceptedClipId === currentClipId() ? "(clip ok)" : "(CLIP MISMATCH)") : "none held"),
      "starts: " + dbgSub.starts + (dbgSub.hold ? "  " + dbgSub.hold : "") + "  getAllCues: " + (dbgSub.inter || "—"),
      "last start:   " + (dbgSub.adopt || "—"),
      dbgSub.stale ? "superseded:   " + dbgSub.stale : null,
    ].filter(Boolean).join("\n");
  }, 1000);

  document.addEventListener("fullscreenchange", onFullscreenChange);
  setInterval(() => { if (autoPosEnabled) updateAutoPosition(); }, 600);
  setInterval(() => { if (hideNativeOn) { injectShadowHide(); hideNativeTextTracks(); } }, 2000);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "GET_CLIP") { sendResponse({ base: lastCacheBase || clipBaseId(), title: SV_TITLE.clean(document.title) }); return; } // popup → "this video" cache + per-clip settings
    if (msg.type === "SV_SEEK") {
      // Learn tab time chip → jump the video to where a word was said (shadowing).
      const v = adapter?.getVideoEl?.() || document.querySelector("video");
      if (v && typeof msg.ms === "number") { const ms = Math.max(0, msg.ms - 1000); if (adapter && adapter.seek) { adapter.seek(ms); adapter.play && adapter.play(); } else { v.currentTime = ms / 1000; v.play?.(); } } // 1s of run-up; Netflix through its own player
      sendResponse({ ok: !!v });
      return;
    }
    if (msg.type === "SV_SNAP_PREP") { // the background captures the screen next — prepare the chunk(s), hide the overlay
      const prep = window.__svSnapPrep;
      if (!prep) { sendResponse({ ok: false, error: "no-board" }); return; }
      prep().then((r) => sendResponse(r || { ok: false, error: "prep" })).catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
    if (msg.type === "SV_SNAP_DONE") { if (window.__svSnapDone) window.__svSnapDone(); sendResponse({ ok: true }); return; }
    if (msg.type === "AUDIO_CUE") onAudioCue(msg.text);
    else if (msg.type === "AUDIO_STOP") stopAudio();
    else if (msg.type === "AUDIO_ERROR") setStatus("Audio: " + msg.error, true);
    else if (msg.type === "LIVE_LINE") { if (!liveVoiceOnly) liveShow(msg.original, msg.translated); }
    else if (msg.type === "LIVE_STATE") {
      if (msg.running) {
        // Perfect-sync already on stage → keep it (text + karaoke) and let the
        // session speak. Otherwise the live transcripts take the overlay —
        // that's the only text source there is.
        // Heartbeats repeat running:true every 2s — announce the takeover ONCE
        // (the re-announcing toast was flashing on the video every beat).
        if (cueListActive && !liveMode) { if (!liveVoiceOnly) { liveVoiceOnly = true; setStatus("Live Translate — voice over your subtitles."); } }
        else if (!liveVoiceOnly) liveEnter(); // take the stage immediately — silence the scrape engine
      }
      if (msg.error) setStatus("Live: " + msg.error, true);
      if (!msg.running) { liveVoiceOnly = false; liveEnd(); }
    }
  });

  // Full cue list / subtitle-file URL captured by subs-intercept.js (MAIN world).
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || !d.__copilotSubs) return;
    if (d.type === "SUBS_CUES") onInterceptedCues(d.cues);          // parsed full cue list (legacy path)
    else if (d.type === "SUBS_RESET") { dropInterceptedCues(); schedule(); } // live channel switched → drop the previous channel's cues + restart fresh
    else if (d.type === "SUBS_URL") { dbgSub.spotted = "…" + String(d.url).replace(/\?.*/, "").slice(-34); fetchSubsByUrl(d.url); } // discovered subtitle URL
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
          // YouTube: a real clip switch ALWAYS changes the URL, and the 1s
          // watcher below handles that. The element-id relay only ever fires
          // false positives here (hover previews / ads reporting their own tiny
          // <video>) — and dropping cues on one nuked a healthy perfect-sync
          // run mid-watch, stranding the clip on rolling native cues.
          if (!(adapter && adapter.site === "youtube")) {
            lastClipChangeAt = performance.now();
            dropInterceptedCues(); schedule();
          }
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
    if (clip !== lastClip) { lastClip = clip; lastClipChangeAt = performance.now(); dropInterceptedCues(); schedule(); }
    else if (location.href !== lastUrl) { lastUrl = location.href; schedule(); }
  }, 1000);

  schedule();
})();
