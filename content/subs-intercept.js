// Subtitle-file discovery. Runs in the PAGE (MAIN) world at document_start on
// sites that ship a real subtitle file (ZDF, DW, …). It watches the Resource
// Timing API for the subtitle file's URL — however and whenever the player loads
// it — and hands that URL to the content script, which re-fetches it through the
// background worker (cross-origin + CORS-exempt) and parses it. Getting the whole
// track up front lets the translator work far ahead of the playhead.
//
// NOTE: we deliberately do NOT wrap window.fetch / XMLHttpRequest. Watching the
// Resource Timing API is enough, and it keeps us entirely out of the page's own
// network call stacks — so the site's (ad-blocked) analytics errors never point
// back at this file.

(function () {
  const dbg = (window.__copilotSubsDebug = window.__copilotSubsDebug || { urls: [] });
  if (!dbg.urls) dbg.urls = [];

  const seenSubUrls = new Set();
  let latestUrl = null; // most recently LOADED subtitle file ≈ the clip now playing
  function isSubUrl(u) {
    if (!u) return false;
    // Match on host + path only (NEVER the query string) so an analytics beacon
    // whose query happens to contain "caption"/"subtitle" can't slip through.
    let path = u, query = "";
    try { const p = new URL(u); path = p.hostname + p.pathname; query = p.search; } catch {}
    // YouTube serves its captions from /api/timedtext, but ONLY a request carrying
    // a `pot` (Proof-of-Origin Token) returns real cues — the token-less ones (and
    // any direct fetch we'd build ourselves) return an empty body. The player emits
    // a pot-bearing request when CC is ON; that URL is re-fetchable, so grab it.
    if (/\/api\/timedtext$/.test(path)) return /[?&]pot=/.test(query);
    if (/\/(qos|beacon|collect|metrics|analytics|telemetry|events?|track(ing)?|pixel|stats|log)(\/|\b)/i.test(path)) return false;
    // HLS subtitle SEGMENTS carry segment-relative times we'd mis-place.
    if (/segment|fragment|fileSequence|[-_/]seg[-_]?\d|[-_/]frag[-_]?\d|\/\d+\.(vtt|m4s|ts)$/i.test(path)) return false;
    if (/\.(mp4|m4s|ts|m3u8|mpd|jpe?g|png|webp|gif|js|css|woff2?|json|aac|mp3|html?)$/i.test(path)) return false;
    return /utstreaming\.zdf\.de|\/mtt\/|ttml|\.vtt$|\.xml$|\.srt$|\/subtitles?(\/|$)|\/captions?(\/|$)|untertit/i.test(path);
  }
  function consider(u) {
    if (!isSubUrl(u)) return;
    latestUrl = u; // the most recent subtitle load is the clip currently playing
    if (!seenSubUrls.has(u)) {
      seenSubUrls.add(u);
      if (dbg.urls.length < 40) dbg.urls.push(u);
      console.info("[CopilotSubs/MAIN] subtitle file spotted:", u);
    }
    window.postMessage({ __copilotSubs: true, type: "SUBS_URL", url: u }, "*");
  }
  // A PerformanceObserver catches every resource load live; the indexed re-scan
  // is a fallback for entries it might miss (the buffer caps at ~250 entries).
  try { performance.setResourceTimingBufferSize(2000); } catch {}
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) consider(e.name || ""); })
      .observe({ type: "resource", buffered: true });
  } catch {}
  // (The live PerformanceObserver above catches new resources without us having
  // to re-scan the whole Resource Timing list on a timer — cheaper on long videos
  // that load thousands of media segments.)
  // Re-post ONLY the current clip's subtitle URL. latestUrl is cleared the moment
  // the playing clip changes (see reportTime + the clip-key watcher below), so a
  // content script that loaded late still gets it WITHOUT resurrecting a previous
  // clip's subtitles.
  setInterval(() => { if (latestUrl) window.postMessage({ __copilotSubs: true, type: "SUBS_URL", url: latestUrl }, "*"); }, 1500);

  // Clip-change detector by URL — covers SPA players whose <video> element has no
  // per-clip id (YouTube: same element across videos, id only in ?v=). When the
  // clip key changes, the previous clip's subtitle URL is stale; stop re-posting it.
  const clipKey = () => { try { return location.pathname + "|" + (new URLSearchParams(location.search).get("v") || ""); } catch { return location.pathname; } };
  let lastClipKey = clipKey();
  setInterval(() => { const k = clipKey(); if (k !== lastClipKey) { lastClipKey = k; latestUrl = null; seenSubUrls.clear(); } }, 500);

  // ── DRM streamers (Netflix, Prime Video): capture the subtitle FILE from the
  // player's own network calls ──
  // These expose no clean subtitle URL to match and render only the current line
  // in the DOM, so to pre-translate AHEAD we sniff fetch/XHR for the TTML/DFXP/VTT
  // body (subtitles aren't DRM-locked — only the audio/video is) and hand the raw
  // text to the content script, which parses + time-sanity-checks it before using.
  // Also logs candidates ([SubVibe/stream]) so the exact format can be reported.
  const STREAM_SNIFF_HOST = /(?:^|\.)netflix\.com$|(?:^|\.)primevideo\.com$|(?:^|\.)amazon\.(?:de|com)$/i;
  if (STREAM_SNIFF_HOST.test(location.hostname)) {
    let nflxLogs = 0;
    const looksSub = (t) => {
      const h = (t || "").slice(0, 300);
      if (/^﻿?\s*WEBVTT/.test(h)) return true;                       // WebVTT
      if (/<(?:MPD|SmoothStreamingMedia)[\s>]/i.test(h)) return false;    // DASH/Smooth MANIFEST — XML, but NOT subtitles (this was parsing to 0 cues)
      // TTML/DFXP must actually carry a <tt> root, not just be any XML.
      if (/^﻿?\s*(?:<\?xml|<tt[\s:>])/.test(h)) return /<tt[\s:>]/i.test((t || "").slice(0, 3000));
      return false;
    };
    const consider = (url, ct, clen, getText) => {
      try {
        if (/^(video|audio|image)\//i.test(ct || "")) return;            // skip AV segments
        if (clen && +clen > 5000000) return;                             // skip large bodies
        if (ct && !/xml|ttml|vtt|dfxp|text|octet|json|subrip|plain/i.test(ct)) return;
        getText().then((text) => {
          if (!text || text.length < 32) return;
          if (looksSub(text)) {
            // Stash the file's head so it's retrievable later via
            // window.__copilotSubsDebug.subHeads (no need to scroll the console).
            // The head shows the timestamp format we must parse (tickRate etc.).
            (dbg.subHeads = dbg.subHeads || []).push("ct=" + ct + " | " + text.slice(0, 800).replace(/\s+/g, " "));
            if (dbg.subHeads.length > 6) dbg.subHeads.shift();
            if (nflxLogs++ < 6) console.info("[SubVibe/stream] subtitle body:", "ct=" + ct, "len=" + text.length, "head=", text.slice(0, 110).replace(/\s+/g, " "));
            window.postMessage({ __copilotSubs: true, type: "SUBS_TEXT", text }, "*");
          } else if (nflxLogs < 4 && /xml|vtt|ttml|dfxp|text|plain/i.test(ct || "")) {
            console.info("[SubVibe/stream] text resp (no subtitle magic):", "ct=" + ct, "head=", text.slice(0, 70).replace(/\s+/g, " "));
          }
        }).catch(() => {});
      } catch {}
    };
    // ── DRM subtitles delivered as fragmented MP4 (CMAF) segments ──────────────
    // Prime/Amazon stream subtitles as binary cenc_subtitles_*.mp4 chunks (stpp =
    // TTML, or wvtt = WebVTT, inside MP4 boxes) — not a text file we can sniff. We
    // parse those boxes HERE (DOMParser exists in this page world), turn each
    // segment into cues with ABSOLUTE times, and post SUBS_CUES so the engine
    // pre-translates + caches them like any track — including for live.
    const seg = { timescale: 0, codec: "", postedStarts: new Set(), logs: 0, dbg: 0, offset: null, maxSeen: null, streamKey: "" };
    // Live channels all share the SAME URL (/gp/video/livetv), so the engine's
    // URL-based clip-change detector never fires on a channel switch — it kept the
    // PREVIOUS channel's subtitles. Detect the switch from the subtitle STREAM
    // itself: each stream uses its own segment directory (a stream hash). On change,
    // reset the parser and tell the engine to drop the stale cues.
    const streamKey = (u) => { try { const p = new URL(u).pathname; return p.slice(0, p.lastIndexOf("/")); } catch { return ""; } };
    function checkStream(u) {
      const k = streamKey(u);
      if (!k) return;
      if (seg.streamKey && seg.streamKey !== k) {
        console.info("[SubVibe/seg] subtitle stream changed (channel switch) → reset");
        seg.postedStarts = new Set(); seg.offset = null; seg.maxSeen = null; seg.timescale = 0; seg.lastBaseMs = 0; seg.codec = "";
        window.postMessage({ __copilotSubs: true, type: "SUBS_RESET" }, "*");
      }
      seg.streamKey = k;
    }
    const isSubSegment = (u) => {
      let path = ""; try { path = new URL(u).pathname.toLowerCase(); } catch { return false; }
      if (/cenc_subtitles|[_/]subtitles?[_/]/.test(path) && /\.(mp4|m4s|cmft|cmf|dash)$/.test(path)) return true;
      if (/subtitle|caption|webvtt|ttml/.test(path) && /\.(mp4|m4s|cmft)$/.test(path)) return true;
      return false;
    };
    const fourcc = (dv, p) => String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
    function walkBoxes(dv, start, end, cb) {
      let p = start;
      while (p + 8 <= end) {
        let size = dv.getUint32(p), hdr = 8;
        const type = fourcc(dv, p + 4);
        if (size === 1) { size = dv.getUint32(p + 8) * 4294967296 + dv.getUint32(p + 12); hdr = 16; }
        else if (size === 0) size = end - p;
        if (size < hdr || p + size > end) break;
        cb(type, p + hdr, p + size);
        p += size;
      }
    }
    // Follow an exact nested box path (e.g. moov>trak>mdia>mdhd), collecting the leaf's [start,end].
    function findBoxes(dv, start, end, path, out) {
      walkBoxes(dv, start, end, (type, s, e) => {
        if (type !== path[0]) return;
        if (path.length === 1) out.push([s, e]);
        else findBoxes(dv, s, e, path.slice(1), out);
      });
    }
    // TTML time → ms (clock HH:MM:SS.mmm, HH:MM:SS:FF @25fps, or s/ms offsets).
    function ttmlMs(v) {
      if (!v) return null; v = String(v).trim(); let m;
      if ((m = /^(\d+):(\d{2}):(\d{2})(?:[.,](\d+))?$/.exec(v))) return (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 + (m[4] ? Math.round(+("0." + m[4]) * 1000) : 0);
      if ((m = /^(\d+):(\d{2}):(\d{2}):(\d{2})$/.exec(v))) return (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 + Math.round((+m[4] / 25) * 1000);
      if ((m = /^([\d.]+)ms$/.exec(v))) return Math.round(+m[1]);
      if ((m = /^([\d.]+)s$/.exec(v))) return Math.round(+m[1] * 1000);
      return null;
    }
    function parseTtmlBody(xml, baseMs) {
      let doc; try { doc = new DOMParser().parseFromString(xml, "text/xml"); } catch { return []; }
      if (!doc || doc.getElementsByTagName("parsererror").length) return [];
      const cues = [];
      const ps = doc.getElementsByTagNameNS("*", "p");
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        const b = ttmlMs(p.getAttribute("begin"));
        if (b == null) continue;
        const e = ttmlMs(p.getAttribute("end"));
        const text = (p.textContent || "").replace(/\s+/g, " ").trim();
        if (text) cues.push({ startMs: b, endMs: e == null ? b + 3000 : e, text });
      }
      if (!cues.length) return [];
      // If the segment uses segment-RELATIVE times (all before its own base decode
      // time) shift them onto the absolute timeline; absolute times pass through.
      const maxT = cues.reduce((mx, c) => Math.max(mx, c.endMs), 0);
      if (baseMs > 1000 && maxT < baseMs) cues.forEach((c) => { c.startMs += baseMs; c.endMs += baseMs; });
      return cues;
    }
    function parseSegment(buf) {
      const dv = new DataView(buf), end = buf.byteLength;
      if (seg.dbg < 5) { const tt = []; walkBoxes(dv, 0, end, (t) => tt.push(t)); seg.dbg++; console.info("[SubVibe/seg] boxes [" + tt.join(",") + "] " + end + "B"); }
      // INIT segment → timescale + codec (kept for later media segments).
      const mdhd = []; findBoxes(dv, 0, end, ["moov", "trak", "mdia", "mdhd"], mdhd);
      if (mdhd.length) { const [s] = mdhd[0]; seg.timescale = dv.getUint8(s) === 1 ? dv.getUint32(s + 20) : dv.getUint32(s + 12); }
      const stsd = []; findBoxes(dv, 0, end, ["moov", "trak", "mdia", "minf", "stbl", "stsd"], stsd);
      if (stsd.length) seg.codec = fourcc(dv, stsd[0][0] + 12); // first sample-entry 4cc (stpp / wvtt)
      // MEDIA segment → tfdt (base decode time) + mdat (payload).
      let baseMs = 0;
      const tfdt = []; findBoxes(dv, 0, end, ["moof", "traf", "tfdt"], tfdt);
      if (tfdt.length && seg.timescale) {
        const [s] = tfdt[0];
        const t = dv.getUint8(s) === 1 ? (dv.getUint32(s + 4) * 4294967296 + dv.getUint32(s + 8)) : dv.getUint32(s + 4);
        baseMs = (t / seg.timescale) * 1000;
      }
      seg.lastBaseMs = baseMs; // segment's own media time (tfdt) — for diagnostics/anchoring
      const mdat = []; findBoxes(dv, 0, end, ["mdat"], mdat);
      if (!mdat.length) return [];
      const [ms, me] = mdat[0];
      let body = ""; try { body = new TextDecoder("utf-8").decode(new Uint8Array(buf, ms, me - ms)); } catch { return []; }
      const head = body.slice(0, 200);
      if (/<tt[\s:>]|<\?xml/i.test(head)) return parseTtmlBody(body, baseMs);
      if (seg.logs++ < 4) console.info("[SubVibe/seg] non-TTML subtitle payload (codec=" + (seg.codec || "?") + ") — tell SubVibe if you need it. head=", head.replace(/\s+/g, " ").slice(0, 80));
      return [];
    }
    const seenSegUrls = new Set(); // segments already handled (by the fetch hook OR a re-fetch)
    function considerSegment(getBuffer) {
      getBuffer().then((buf) => {
        if (!buf || buf.byteLength < 16) return;
        let cues = [];
        try { cues = parseSegment(buf); } catch (err) { if (seg.logs++ < 8) console.warn("[SubVibe/seg] parse error", err && err.message); return; }
        const fresh = cues.filter((c) => !seg.postedStarts.has(c.startMs)); // dedup on ORIGINAL (epoch) time — stable across re-anchoring
        if (!fresh.length) return;
        fresh.forEach((c) => seg.postedStarts.add(c.startMs));
        if (seg.postedStarts.size > 5000) seg.postedStarts = new Set([...seg.postedStarts].slice(-3000)); // bound for long live sessions
        // Live segments carry presentation-EPOCH times (e.g. 90,710,605s) that don't
        // match the player's currentTime, so nothing would display. Anchor the NEWEST
        // cue to the video's buffered LIVE EDGE — this maps the epoch timeline onto
        // the player's, whether currentTime is epoch- or DVR-window-relative, and
        // converges toward the live edge as newer segments arrive.
        const vid = document.querySelector("video");
        const edge = vid && vid.buffered && vid.buffered.length ? vid.buffered.end(vid.buffered.length - 1) : ((vid && vid.currentTime) || 0);
        const newest = fresh.reduce((mx, c) => Math.max(mx, c.startMs), 0);
        // Establish the epoch→player offset ONCE and FREEZE it. Recomputing later
        // corrupts sync when you rewind the live DVR: the buffered edge drops, so the
        // live-edge cue would get mapped onto your rewound playhead and subtitles run
        // ahead. The offset is a CONSTANT (epoch zero vs player zero), so one
        // measurement holds across seeks. LIVE carries a presentation-EPOCH clock
        // (~millions of s) → anchor to the live edge once; recorded/VOD carries real
        // player times → no shift at all (sync matches the player exactly).
        if (seg.offset == null) {
          const EPOCH_MS = 100000 * 1000; // ~27h: above this = live presentation epoch
          let via = "vod";
          if (newest > EPOCH_MS) {
            // LIVE. Prefer the segment's OWN media time (tfdt): anchoring each cue to
            // it is EXACT — no subtitle-prefetch / live-delay gap, so no manual nudge.
            // Usable only if tfdt is a real player time (small), not the epoch itself.
            const base = seg.lastBaseMs || 0;
            const firstEpoch = fresh.reduce((mn, c) => Math.min(mn, c.startMs), Infinity);
            if (base > 1000 && base < EPOCH_MS && (edge <= 0 || Math.abs(base / 1000 - edge) < 300)) {
              seg.offset = firstEpoch - base; via = "tfdt"; // exact media anchor
            } else if (edge > 0) {
              seg.offset = newest - edge * 1000; via = "edge"; // approximate (buffer edge) — may need a nudge
            }
          } else { seg.offset = 0; }
          if (seg.offset != null && seg.dbg < 8) {
            seg.dbg++;
            console.info("[SubVibe/seg] LOCKED offset=" + Math.round(seg.offset / 1000) + "s · via=" + via +
              " tfdt=" + Math.round((seg.lastBaseMs || 0) / 1000) + "s edge=" + Math.round(edge) + "s cur=" + Math.round((vid && vid.currentTime) || 0) + "s");
          }
        }
        if (seg.offset == null) return; // player not ready to anchor yet — skip raw epoch times
        const out = fresh.map((c) => ({ startMs: Math.round(c.startMs - seg.offset), endMs: Math.round(c.endMs - seg.offset), text: c.text }));
        if (seg.logs++ < 10) console.info("[SubVibe/seg] +" + out.length + " cues @ " + Math.round(out[0].startMs / 1000) + "s (codec=" + (seg.codec || "?") + ")");
        window.postMessage({ __copilotSubs: true, type: "SUBS_CUES", cues: out }, "*");
      }).catch((e) => { if (seg.logs++ < 8) console.warn("[SubVibe/seg] segment fetch failed (CORS?)", (e && e.message) || e); });
    }

    const of = window.fetch;
    if (of) window.fetch = function () {
      const pr = of.apply(this, arguments);
      try {
        pr.then((r) => {
          try {
            if (isSubSegment(r.url)) { checkStream(r.url); seenSegUrls.add(r.url); considerSegment(() => r.clone().arrayBuffer()); }
            else consider(r.url, r.headers.get("content-type"), r.headers.get("content-length"), () => r.clone().text());
          } catch {}
        }, () => {});
      } catch {}
      return pr;
    };

    // Players often fetch media segments INSIDE A WEB WORKER, where the window.fetch
    // hook above can't see them — but the Resource Timing API still reports their
    // URLs. Re-fetch any subtitle segment we didn't already capture, then parse it.
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const u = e.name || "";
          if (!isSubSegment(u) || seenSegUrls.has(u)) continue;
          seenSegUrls.add(u);
          checkStream(u);
          if (seg.dbg < 5) { seg.dbg++; console.info("[SubVibe/seg] re-fetching (worker?) " + u.split("/").pop().slice(0, 48)); }
          considerSegment(() => fetch(u, { credentials: "omit" }).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("HTTP " + r.status)))));
        }
      }).observe({ type: "resource", buffered: true });
    } catch {}
    try {
      const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { try { this.__svUrl = u; } catch {} return oOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () {
        try { this.addEventListener("load", () => { try { consider(this.__svUrl, this.getResponseHeader("content-type"), this.getResponseHeader("content-length"), () => Promise.resolve(typeof this.responseText === "string" ? this.responseText : "")); } catch {} }); } catch {}
        return oSend.apply(this, arguments);
      };
    } catch {}
  }

  // Relay the playing clip's clock from the PAGE world. The extension's isolated
  // world can read a different/stale <video> on DW's MSE player (it sees a poster
  // stub frozen at 0:00), but here in the page world currentTime reads correctly.
  let lastT = -1, lastPaused = null, lastPlayingId = null;
  function reportTime() {
    const vids = document.querySelectorAll("video");
    if (!vids.length) return;
    let best = null;
    // Prefer the LARGEST playing video (main content) so a small ad/preview can't
    // hijack the relayed clock and make the shown cue flicker.
    for (const v of vids) if (!v.paused && !v.ended && (!best || v.clientWidth * v.clientHeight > best.clientWidth * best.clientHeight)) best = v;
    if (!best) for (const v of vids) if (!best || (v.currentTime || 0) > (best.currentTime || 0)) best = v;
    if (!best) return;
    // When the PLAYING clip changes, the previous subtitle file is stale — stop
    // re-posting it until this clip's own subtitle loads.
    if (!best.paused && best.id && best.id !== lastPlayingId) { lastPlayingId = best.id; latestUrl = null; }
    const t = Math.round((best.currentTime || 0) * 1000);
    if (t === lastT && best.paused === lastPaused) return; // skip unchanged samples
    lastT = t; lastPaused = best.paused;
    window.postMessage({ __copilotSubs: true, type: "SUBS_TIME", t, paused: best.paused, id: best.id }, "*");
  }
  setInterval(reportTime, 200);
})();
