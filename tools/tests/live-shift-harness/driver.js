// Simulated ZDF-live (or VOD) player + scenario controls for the engine harness.
// Query params:
//   ?mode=relay|direct   relay (default) = MSE-like: the element's currentTime reads
//                        0 and the clock arrives via SUBS_TIME postMessages exactly
//                        like content/subs-intercept.js relays it; direct = readable.
//   ?buf=<seconds>       how far subtitle cues run AHEAD of the playhead (default 8).
//   ?paused=1            start with the video already paused (latch scenario).
//   ?vod=1               report a FINITE duration (VOD) instead of live's NaN.
(function () {
  const q = new URLSearchParams(location.search);
  const MODE = q.get("mode") || "relay";
  const BUF = q.get("buf") != null ? +q.get("buf") : 8;
  const START_PAUSED = q.get("paused") === "1";
  const VOD = q.get("vod") === "1";

  const BASE = 5000;       // starting playhead, seconds (live DVR position)
  const CUE_EVERY = 2.0;
  const CUE_DUR = 1.9;

  const vid = document.getElementById("vid");
  const sim = (window.sim = {
    clock: BASE,
    playing: !START_PAUSED,
    buffering: true,
    edge: BASE + BUF,
    lastWall: performance.now(),
  });

  // ── the fake MSE element ──────────────────────────────────────────────────
  Object.defineProperty(vid, "duration", { get: () => (VOD ? BASE + 3600 : NaN) }); // ZDF live: NaN, never Infinity
  Object.defineProperty(vid, "currentTime", { get: () => (MODE === "direct" ? sim.clock : 0) });
  Object.defineProperty(vid, "paused", { get: () => !sim.playing });
  Object.defineProperty(vid, "ended", { get: () => false });

  const track = vid.addTextTrack("subtitles", "Deutsch", "de");
  const cueText = (n) => `Zeile ${n}: hier wird gerade Satz Nummer ${n} gesprochen.`;
  let nextCueStart = BASE - 30; // seed 30s of history
  function fillCues() {
    while (nextCueStart <= sim.edge) {
      const n = Math.round(nextCueStart / CUE_EVERY);
      track.addCue(new VTTCue(nextCueStart, nextCueStart + CUE_DUR, cueText(n)));
      nextCueStart += CUE_EVERY;
    }
  }
  fillCues();

  // ── clock + buffering advance + the site's own caption ────────────────────
  setInterval(() => {
    const now = performance.now();
    const dt = (now - sim.lastWall) / 1000;
    sim.lastWall = now;
    if (sim.playing) sim.clock += dt;
    if (sim.buffering) sim.edge = Math.max(sim.edge, sim.clock + BUF);
    fillCues();
    // ZDF renders its own caption (the cue active at the PLAYER's clock); SubVibe's
    // autoCalibrate finds this text in the DOM and anchors live auto-sync to it.
    const active = Math.floor(sim.clock / CUE_EVERY) * CUE_EVERY;
    const el = document.getElementById("nativecap");
    if (el) el.textContent = sim.clock - active <= CUE_DUR ? cueText(Math.round(active / CUE_EVERY)) : "";
  }, 100);

  // ── the page-world clock relay, replicated from subs-intercept.reportTime ──
  if (MODE === "relay") {
    let lastT = -1, lastPaused = null;
    setInterval(() => {
      const t = Math.round(sim.clock * 1000);
      const paused = !sim.playing;
      if (t === lastT && paused === lastPaused) return; // skip unchanged samples (real relay behavior)
      lastT = t; lastPaused = paused;
      window.postMessage({ __copilotSubs: true, type: "SUBS_TIME", t, paused, id: "vid" }, "*");
    }, 200);
  }

  // ── scenario controls ─────────────────────────────────────────────────────
  sim.play = () => { sim.playing = true; document.dispatchEvent(new Event("play")); };
  sim.pause = (keepBuffering = true) => { sim.playing = false; sim.buffering = keepBuffering; };

  // Exactly what popup.js saveSetting does for a clip: clipOverrides[base].syncOffset.
  // `stored` uses the ENGINE sign (+ = earlier); the popup UI shows the negated value.
  sim.setStoredOffset = async (stored) => {
    const base = "zdf:" + (location.pathname.replace(/\/+$/, "") || location.pathname);
    const cur = (await chrome.storage.local.get("clipOverrides")).clipOverrides || {};
    cur[base] = { ...(cur[base] || {}), syncOffset: stored };
    await chrome.storage.local.set({ clipOverrides: cur });
  };

  sim.state = () => {
    const rows = [...document.querySelectorAll("#copilot-subs .copilot-subs__line")];
    const shown = {};
    for (const r of rows) shown[r.dataset.csKey || r.dataset.lang || "?"] = r.textContent;
    let diag = null;
    try { diag = JSON.parse(document.documentElement.dataset.csDiag || "null"); } catch {}
    const st = document.querySelector("#copilot-subs .copilot-subs__status");
    return {
      mode: MODE, buf: BUF, vod: VOD,
      clock: +sim.clock.toFixed(2), edge: +sim.edge.toFixed(2),
      playing: sim.playing, buffering: sim.buffering,
      cueCount: track.cues ? track.cues.length : 0,
      status: st ? st.textContent : "",
      shown, diag,
    };
  };
})();
