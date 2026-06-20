// Netflix site adapter — a STREAMING source.
//
// Netflix is DRM (Widevine), so we can't capture its audio and there's no
// fetchable caption track we can rely on. But Netflix renders the *selected*
// subtitle track as on-screen text in `.player-timedtext`. So this adapter just
// reports the currently-shown native caption text; content/common.js reads it
// live, translates each line to the chosen target(s), and overlays the result.
//
// Requirement: the user must have a Netflix subtitle/CC track turned ON (any
// language) — that on-screen text is our input. Image-based subtitle tracks
// (rare) render no text and can't be scraped.

(function () {
  const adapter = {
    site: "netflix",
    stream: true, // tells the engine to use the live caption-scrape path

    matches() {
      return location.hostname.endsWith("netflix.com") && location.pathname.startsWith("/watch");
    },

    getVideoId() {
      const m = location.pathname.match(/\/watch\/(\d+)/);
      return m ? m[1] : null;
    },

    getVideoEl() {
      return document.querySelector("video");
    },

    getPlayerContainer() {
      return (
        document.querySelector(".watch-video--player-view") ||
        document.querySelector(".watch-video") ||
        (adapter.getVideoEl() && adapter.getVideoEl().parentElement) ||
        document.body
      );
    },

    // The text Netflix is showing right now (its own selected subtitle track).
    readNativeText() {
      const n = document.querySelector(".player-timedtext");
      if (!n) return "";
      return n.innerText || n.textContent || "";
    },

    onNavigate(cb) {
      window.addEventListener("popstate", cb);
    },
  };

  (window.__copilotAdapters = window.__copilotAdapters || []).push(adapter);
})();
