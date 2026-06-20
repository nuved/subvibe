// Amazon Prime Video site adapter — a STREAMING source (Netflix-class).
//
// Prime is DRM (Widevine/PlayReady/FairPlay), so we can't capture its audio. But
// the subtitle FILE itself isn't DRM-locked: content/subs-intercept.js sniffs the
// player's own fetch/XHR for the TTML/DFXP/VTT body and hands it to the engine,
// which parses the whole track and pre-translates AHEAD. As a fallback, this
// adapter also reports the currently-shown native caption text (stream mode).
//
// Requirement: the user must turn a Prime subtitle/CC track ON (any language) —
// that timed text is our input.
//
// NOTE: caption DOM classes + the subtitle file format vary by region/player
// version; the selectors below are best-effort and may need tuning against a real
// Prime video (watch the console for "[SubVibe/stream] subtitle body:" logs).

(function () {
  const big = () => {
    let best = null;
    for (const v of document.querySelectorAll("video")) {
      if (!best || v.clientWidth * v.clientHeight > best.clientWidth * best.clientHeight) best = v;
    }
    return best || document.querySelector("video");
  };

  const adapter = {
    site: "prime",
    stream: true, // allow the live caption-scrape fallback path

    matches() {
      const h = location.hostname, p = location.pathname;
      if (h.endsWith("primevideo.com")) return true;            // dedicated Prime site = all video
      if (h.endsWith("amazon.de") || h.endsWith("amazon.com")) return p.startsWith("/gp/video"); // scoped to the video section
      return false;
    },

    getVideoId() {
      // The playing title's ASIN/GTI — Prime detail/watch URLs carry it.
      const m = location.pathname.match(/\/(?:detail|dp|gti)\/([A-Za-z0-9.\-]{8,})/i)
        || location.search.match(/[?&](?:asin|gti|titleId|tid)=([A-Za-z0-9.\-]{6,})/i);
      if (m) return m[1];
      // Live TV / storefront players carry NO ASIN in the URL — but the engine
      // refuses to start without an id (and so never renders the cues the segment
      // parser produces). Fall back to a stable path-based id so it runs.
      const tail = location.pathname.replace(/\/+$/, "").split("/").filter(Boolean).pop();
      return tail || "prime";
    },

    getVideoEl() { return big(); },

    getPlayerContainer() {
      return (
        document.querySelector(".webPlayerSDKContainer") ||
        document.querySelector(".atvwebplayersdk-overlays-container") ||
        document.querySelector("[id^='dv-web-player']") ||
        (big() && big().parentElement) ||
        document.body
      );
    },

    // The line Prime is showing right now (its own selected subtitle track).
    readNativeText() {
      const n =
        document.querySelector('[class*="atvwebplayersdk-captions"]') ||
        document.querySelector(".webPlayerSDKContainer .captions") ||
        document.querySelector(".captions");
      return n ? (n.innerText || n.textContent || "").trim() : "";
    },

    onNavigate(cb) { window.addEventListener("popstate", cb); },
  };

  (window.__copilotAdapters = window.__copilotAdapters || []).push(adapter);
})();
