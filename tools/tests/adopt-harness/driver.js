// Simulated player + the operator's exact sequence.
(function () {
  const vid = document.getElementById("vid");
  let clock = 0.5, playing = true;
  Object.defineProperty(vid, "currentTime", { get: () => clock });
  Object.defineProperty(vid, "duration", { get: () => 600 }); // VOD
  Object.defineProperty(vid, "paused", { get: () => !playing });
  Object.defineProperty(vid, "ended", { get: () => false });
  setInterval(() => { if (playing) clock += 0.25; }, 250);

  // Rolling native captions like YouTube's: text grows word by word.
  const WORDS = ">> China is beginning to engage in what I'll call AI dumping and the market reacts".split(" ");
  let w = 0;
  setInterval(() => {
    w = (w + 1) % (WORDS.length + 4);
    window.__nativeLine = WORDS.slice(Math.max(0, w - 12), w).join(" ");
    document.getElementById("nativecap").textContent = window.__nativeLine;
  }, 700);

  // The caption file URL is "spotted" (what subs-intercept would post). In slow
  // mode it lands at t=1s — while the first start() is still awaiting the 3s
  // getCaptionTracks call, the operator's exact race.
  setTimeout(() => {
    window.postMessage({ __copilotSubs: true, type: "SUBS_URL", url: "https://www.youtube.com/api/timedtext?v=vid123&pot=abc&fmt=json3" }, "*");
  }, window.__SLOW ? 1000 : 3000);
  // …and re-posted every 1.5s exactly like subs-intercept.js does.
  setInterval(() => {
    window.postMessage({ __copilotSubs: true, type: "SUBS_URL", url: "https://www.youtube.com/api/timedtext?v=vid123&pot=abc&fmt=json3" }, "*");
  }, 1500);

  // Chronicle: sample the engine's visible mode every 250ms so mode FLIPS are
  // provable ("cuelist at 2.1s, back to scrape at 3.3s" = the smoking gun).
  window.__chron = [];
  setInterval(() => {
    let diag = null; try { diag = JSON.parse(document.documentElement.dataset.csDiag || "null"); } catch {}
    const m = diag && diag.mode;
    const last = window.__chron[window.__chron.length - 1];
    if (!last || last.mode !== m) window.__chron.push({ at: +clock.toFixed(1), mode: m });
  }, 250);

  window.__probe = () => {
    const hud = document.getElementById("copilot-subs-hud");
    let diag = null; try { diag = JSON.parse(document.documentElement.dataset.csDiag || "null"); } catch {}
    return { hud: hud ? hud.textContent : "NO HUD", mode: diag && diag.mode, fetches: window.__fetchCount, clock: +clock.toFixed(1), chron: window.__chron, warns: window.__warns };
  };
})();
