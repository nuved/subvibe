// Deutsche Welle (dw.com) site adapter — a STREAMING source.
//
// DW serves standard HTML5 <video> elements (each with a stable data-id) and a
// standard <track> subtitle file at www.dw.com/media/subtitles/<id>. That file
// is SAME-ORIGIN WebVTT, so the engine reads the whole cue list directly (the
// <video>'s textTracks) or via the subtitle-file interceptor — either way it
// gets perfect sync + pre-translation. A DW article can embed several videos,
// so we lock onto the one that's actually playing (or the largest on screen).

(function () {
  // Track the video the user actually started. A DW article embeds several, and
  // a previous clip can keep its "playing" state, so "first/largest playing"
  // flickers between elements. The most recently played one is what they watch.
  const vidId = (v) => (v && (v.getAttribute("data-id") || (v.id || "").replace(/^video-/, ""))) || null;
  let lastPlayed = null, lastPlayedId = null;
  document.addEventListener(
    "play",
    (e) => { if (e.target && e.target.tagName === "VIDEO") { lastPlayed = e.target; lastPlayedId = vidId(e.target); } },
    true,
  );

  function pickVideo() {
    if (lastPlayed && lastPlayed.isConnected) return lastPlayed;
    // DW (React) can re-create the <video> element mid-playback. Re-find the same
    // clip by its stable data-id so our video id doesn't flicker — a flicker would
    // make the engine think you switched clips and drop the cues it just fetched.
    if (lastPlayedId) {
      const again = [...document.querySelectorAll("video")].find((v) => vidId(v) === lastPlayedId);
      if (again) { lastPlayed = again; return again; }
    }
    const vids = [...document.querySelectorAll("video")];
    if (vids.length <= 1) return vids[0] || null;
    const playing = vids.find((v) => !v.paused && (v.currentTime || 0) > 0);
    if (playing) return playing;
    return vids
      .slice()
      .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  }

  const adapter = {
    site: "dw",
    stream: true,

    matches() {
      return location.hostname.endsWith("dw.com") && !!document.querySelector("video");
    },

    getVideoEl() {
      return pickVideo();
    },

    // Stable per-video id (data-id / id), so each embedded video caches separately.
    getVideoId() {
      const v = pickVideo();
      const id = v && (v.getAttribute("data-id") || (v.id || "").replace(/^video-/, ""));
      if (id) return "v" + id;
      const m = location.pathname.match(/\/a-(\d+)/);
      return m ? "a" + m[1] : location.pathname.replace(/\/+$/, "");
    },

    getPlayerContainer() {
      const v = pickVideo();
      return (
        (v && (v.closest("[class*='player'], [class*='video'], figure") || v.parentElement)) ||
        document.body
      );
    },

    // DW renders captions through the browser's native text-track layer (::cue)
    // and we read them straight from the <video>'s textTracks (same-origin, so
    // cues are readable). We deliberately do NOT scrape the DOM: DW's only
    // caption-ish DOM element is the subtitle MENU (e.g. "ENGLISH, selected"),
    // which is a label, not dialogue — scraping it printed the menu as a subtitle.
    readNativeText() {
      const v = pickVideo();
      if (!v || !v.textTracks) return "";
      let out = "";
      for (let i = 0; i < v.textTracks.length; i++) {
        const tt = v.textTracks[i];
        if (tt.mode === "disabled") continue;
        if (tt.kind && tt.kind !== "subtitles" && tt.kind !== "captions") continue; // skip metadata/chapters
        const cues = tt.activeCues;
        if (cues) for (let j = 0; j < cues.length; j++) out += (cues[j].text || "") + " ";
      }
      return out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    },

    onNavigate(cb) {
      window.addEventListener("popstate", cb);
    },
  };

  (window.__copilotAdapters = window.__copilotAdapters || []).push(adapter);
})();
