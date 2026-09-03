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

    // Netflix's player must do the seeking (a direct video.currentTime write ends
    // the session with error M7375) — content/page/netflix-seek.js listens in the page.
    seek(ms) { window.postMessage({ __sv: "netflix", op: "seek", ms: Math.round(ms) }, "*"); },
    play() { window.postMessage({ __sv: "netflix", op: "play" }, "*"); },
    pause() { window.postMessage({ __sv: "netflix", op: "pause" }, "*"); },
    setRate(rate) { window.postMessage({ __sv: "netflix", op: "rate", rate }, "*"); },

    // What Netflix says is playing — asked from the page world (cookies, the player API).
    getMeta() {
      const id = adapter.getVideoId();
      return new Promise((resolve) => {
        const done = (meta) => { window.removeEventListener("message", on); clearTimeout(t); resolve(Object.assign({ site: "netflix", url: location.href, title: "" }, meta || {})); };
        const on = (ev) => { if (ev.source === window && ev.data && ev.data.__sv === "netflix" && ev.data.type === "META" && String(ev.data.id) === String(id)) done(ev.data.meta); };
        window.addEventListener("message", on);
        const t = setTimeout(() => done(null), 3000);
        window.postMessage({ __sv: "netflix", op: "meta", id }, "*");
      });
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
