// ZDF (zdf.de / ZDFmediathek) site adapter — a STREAMING source.
//
// ZDF shows its own subtitle track on screen. We read it two ways, most
// reliable first: the <video> element's WebVTT `textTracks` cues (clean text +
// timing; subtitle text is not DRM-protected), then a fallback DOM scrape of
// the rendered caption element. The user must turn ZDF's own subtitles ON.

(function () {
  const adapter = {
    site: "zdf",
    stream: true,

    matches() {
      return location.hostname.endsWith("zdf.de") && /\/play\//.test(location.pathname);
    },

    getVideoId() {
      return location.pathname.replace(/\/+$/, "") || location.pathname;
    },

    getVideoEl() {
      return document.querySelector("video");
    },

    getPlayerContainer() {
      return (
        document.querySelector(".zdfplayer") ||
        document.querySelector("[class*='player']") ||
        (adapter.getVideoEl() && adapter.getVideoEl().parentElement) ||
        document.body
      );
    },

    readNativeText() {
      const v = adapter.getVideoEl();

      // 1) Native WebVTT cues (works when the track is same-origin / CORS-OK).
      if (v && v.textTracks) {
        let out = "";
        for (let i = 0; i < v.textTracks.length; i++) {
          const tt = v.textTracks[i];
          if (tt.mode === "disabled") continue;
          const cues = tt.activeCues;
          if (cues) for (let j = 0; j < cues.length; j++) out += (cues[j].text || "") + " ";
        }
        out = out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (out) return out;
      }

      // 2) Fallback: the player's rendered caption element.
      const sels = [
        ".zdfplayer-captions", ".zdfplayer-subtitle", "[class*='caption-text']",
        "[class*='subtitle']", ".vjs-text-track-display", ".captions",
      ];
      const root = adapter.getPlayerContainer() || document;
      for (const s of sels) {
        const el = root.querySelector(s) || document.querySelector(s);
        if (el) {
          const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
          if (t && t.length < 300) return t;
        }
      }
      return "";
    },

    onNavigate(cb) {
      window.addEventListener("popstate", cb);
    },
  };

  (window.__copilotAdapters = window.__copilotAdapters || []).push(adapter);
})();
