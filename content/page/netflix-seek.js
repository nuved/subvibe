// Netflix (MAIN world): the <video> element must not be seeked or re-timed directly —
// Netflix's player takes that as a broken session (error M7375). This tiny helper
// runs in the page world and drives Netflix's own player API instead; the
// extension's content script asks it via window.postMessage.
(() => {
  if (window.__svNetflixSeek) return; window.__svNetflixSeek = true;
  const player = () => {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds() || [];
      const id = ids.find((s) => String(s).startsWith("watch-")) || ids[0];
      return id ? vp.getVideoPlayerBySessionId(id) : null;
    } catch (e) { return null; }
  };
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__sv !== "netflix") return;
    const p = player(); const d = ev.data;
    try {
      if (d.op === "seek" && p && typeof p.seek === "function") p.seek(Math.max(0, Math.round(d.ms)));
      else if (d.op === "play" && p && typeof p.play === "function") p.play();
      else if (d.op === "pause" && p && typeof p.pause === "function") p.pause();
      else if (d.op === "rate" && p && typeof p.setPlaybackRate === "function") p.setPlaybackRate(d.rate);
      else if (d.op === "rate") { const v = document.querySelector("video"); if (v) v.playbackRate = d.rate; }
    } catch (e) {}
  });
})();
