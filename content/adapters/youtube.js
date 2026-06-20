// YouTube site adapter. Loaded before content/common.js (manifest order), so
// it only registers itself on a shared isolated-world global; common.js drives.
//
// Primary path: enumerate the video's caption tracks and download the chosen one
// as timed cues. YouTube increasingly returns an EMPTY body for direct timedtext
// fetches (anti-scraping), so fetchCues tries json3, then the XML format, and
// reports empties cleanly. When the file can't be downloaded at all, the engine
// falls back to readNativeText() — scraping the player's on-screen captions.

(function () {
  // Find `<marker> = { ... };` in a blob and brace-match the object.
  function extractJsonAfter(text, marker) {
    const m = text.indexOf(marker);
    if (m < 0) return null;
    const start = text.indexOf("{", m);
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { if (--depth === 0) return text.slice(start, i + 1); }
    }
    return null;
  }

  function decodeEntities(s) {
    const ta = document.createElement("textarea");
    ta.innerHTML = s;
    return ta.value;
  }

  function parseJson3(text) {
    const data = JSON.parse(text);
    const cues = [];
    for (const ev of data.events || []) {
      if (!ev.segs) continue;
      const t = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
      if (!t) continue;
      const startMs = ev.tStartMs || 0;
      cues.push({ startMs, endMs: startMs + (ev.dDurationMs || 2500), text: t });
    }
    return cues;
  }

  // YouTube's default/srv1 format: <transcript><text start="1.2" dur="2.0">…</text>
  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, "text/xml");
    const nodes = doc.getElementsByTagName("text");
    const cues = [];
    for (const n of nodes) {
      const start = parseFloat(n.getAttribute("start") || "0");
      const dur = parseFloat(n.getAttribute("dur") || "0");
      const t = decodeEntities(n.textContent || "").replace(/\s+/g, " ").trim();
      if (!t) continue;
      const startMs = Math.round(start * 1000);
      cues.push({ startMs, endMs: startMs + Math.round((dur || 2.5) * 1000), text: t });
    }
    return cues;
  }

  const adapter = {
    site: "youtube",

    matches() {
      return location.hostname.endsWith("youtube.com") && location.pathname === "/watch";
    },

    getVideoId() {
      return new URL(location.href).searchParams.get("v");
    },

    getVideoEl() {
      return document.querySelector("video.html5-main-video") || document.querySelector("video");
    },

    getPlayerContainer() {
      return (
        document.querySelector("#movie_player") ||
        document.querySelector(".html5-video-player") ||
        (adapter.getVideoEl() && adapter.getVideoEl().parentElement) ||
        document.body
      );
    },

    async getCaptionTracks(videoId) {
      const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`, {
        credentials: "include",
      });
      const html = await res.text();
      const jsonStr = extractJsonAfter(html, "ytInitialPlayerResponse");
      if (!jsonStr) return [];
      let pr;
      try { pr = JSON.parse(jsonStr); } catch { return []; }
      const list = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      return list.map((t) => ({
        languageCode: t.languageCode,
        name: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode,
        baseUrl: t.baseUrl,
        kind: t.kind || "",
      }));
    },

    // Returns [{startMs,endMs,text}] or [] if YouTube serves an empty body.
    async fetchCues(baseUrl) {
      const base = baseUrl.replace(/&fmt=[^&]*/g, "");
      const get = async (u) => {
        try {
          const r = await fetch(u, { credentials: "include" });
          return (await r.text()) || "";
        } catch { return ""; }
      };
      // Try json3 first, then the default XML format.
      const j = await get(base + "&fmt=json3");
      if (j.trim()) { try { const c = parseJson3(j); if (c.length) return c; } catch {} }
      const x = await get(base);
      if (x.trim()) { try { const c = parseXml(x); if (c.length) return c; } catch {} }
      return [];
    },

    // Fallback source: the player's on-screen caption text (needs YouTube CC ON).
    readNativeText() {
      const segs = document.querySelectorAll(".ytp-caption-segment");
      if (segs.length) return Array.from(segs).map((s) => s.textContent || "").join(" ");
      const w = document.querySelector(".captions-text") || document.querySelector(".ytp-caption-window-container");
      return w ? w.innerText || w.textContent || "" : "";
    },

    onNavigate(cb) {
      // ONLY real navigations. NOT yt-page-data-updated — that fires
      // repeatedly during playback and would restart the engine in a loop,
      // tearing the subtitle overlay down before it can render.
      window.addEventListener("yt-navigate-finish", cb);
    },
  };

  (window.__copilotAdapters = window.__copilotAdapters || []).push(adapter);
})();
