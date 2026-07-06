// Udemy (udemy.com course player) site adapter — a STREAMING source.
//
// Udemy is NOT DRM for most courses: the lecture's caption track is a plain
// WebVTT file served from the CDN (*.udemycdn.com), and the video is HLS/MP4.
// That .vtt file isn't locked, so content/subs-intercept.js spots its URL via
// the Resource Timing API (its generic `.vtt` matcher) and hands it to the
// engine, which re-fetches the WHOLE track through the background worker
// (cross-origin + CORS-exempt — see the *.udemycdn.com host permission) and
// pre-translates AHEAD of the playhead, exactly like ZDF/DW.
//
// Until that file is captured we fall back to reading the player's currently
// shown caption text line by line (stream mode). The native <video> textTracks
// are usually cross-origin (CDN), so their cues aren't readable; the DOM scrape
// is the reliable live source.
//
// Requirement: the user must turn a Udemy caption track ON (any language) — that
// timed text is our input.
//
// NOTE: Udemy's player markup varies by A/B test + player version; the caption
// selectors below are best-effort and may need tuning against a real lecture
// (watch the console for "[CopilotSubs/MAIN] subtitle file spotted:" logs).

(function () {
  const big = () => {
    let best = null;
    for (const v of document.querySelectorAll("video")) {
      if (!best || v.clientWidth * v.clientHeight > best.clientWidth * best.clientHeight) best = v;
    }
    return best || document.querySelector("video");
  };

  const adapter = {
    site: "udemy",
    stream: true, // capture-from-file when intercepted; live caption-scrape until then

    matches() {
      // Course lecture player: /course/<slug>/learn/lecture/<id>. Also covers the
      // course-taking shell (/learn/) so SPA navigation between lectures keeps us on.
      return location.hostname.endsWith("udemy.com") && /\/learn(\/|$)/.test(location.pathname);
    },

    getVideoId() {
      // The lecture id — stable per video, so each lecture caches separately.
      const m = location.pathname.match(/\/lecture\/(\d+)/);
      if (m) return "l" + m[1];
      // Quizzes/practice or a shell URL with no lecture id yet: fall back to the
      // course slug so the engine still runs rather than refusing to start.
      const c = location.pathname.match(/\/course\/([^/]+)/);
      return c ? c[1] : location.pathname.replace(/\/+$/, "") || "udemy";
    },

    getVideoEl() { return big(); },

    getPlayerContainer() {
      const v = big();
      return (
        document.querySelector('[data-purpose="video-display"]') ||
        document.querySelector(".video-player--container--YBkWv") ||
        document.querySelector("[class*='video-player--container']") ||
        document.querySelector(".shaka-video-container") ||
        (v && v.parentElement) ||
        document.body
      );
    },

    // The line Udemy is showing right now (its own selected caption track). The
    // VTT cues come from the CDN (cross-origin), so we scrape the rendered DOM
    // rather than the <video>'s textTracks (whose cues are CORS-blocked).
    readNativeText() {
      const root = adapter.getPlayerContainer() || document;
      const sels = [
        '[data-purpose="captions-cue-text"]',
        ".captions-display--captions-cue-text--TQ0DQ",
        "[class*='captions-display--captions-cue-text']",
        "[class*='captions-cue-text']",
        ".shaka-text-container",
        ".vjs-text-track-display",
      ];
      for (const s of sels) {
        const el = root.querySelector(s) || document.querySelector(s);
        if (el) {
          const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
          if (t && t.length < 300) return t;
        }
      }
      return "";
    },

    onNavigate(cb) { window.addEventListener("popstate", cb); },
  };

  (window.__copilotAdapters = window.__copilotAdapters || []).push(adapter);
})();
