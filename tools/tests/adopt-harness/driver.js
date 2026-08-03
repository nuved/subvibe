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

  // ── autorun: self-judging regression run, verdict in document.title ──────────
  // ?autorun=1 → fast timing (file after the engine settles), then chains to
  // ?autorun=2&slow=1 → the operator's race (file lands mid-getCaptionTracks).
  // Results accumulate in window.name across the navigation (live-shift pattern).
  const AUTORUN = new URLSearchParams(location.search).get("autorun");
  if (AUTORUN) setTimeout(async () => {
    const results = (() => { try { return JSON.parse(window.name || "[]"); } catch { return []; } })();
    const check = (name, ok, info) => results.push({ name, ok: !!ok, info: String(info || "").slice(0, 220) });
    const p = window.__probe();
    const modes = p.chron.map((c) => c.mode);
    const firstCue = modes.indexOf("cuelist");
    const bulldozed = firstCue >= 0 && modes.slice(firstCue + 1).includes("scrape");
    if (AUTORUN === "1") {
      check("fast: fetched file adopted (mode cuelist)", p.mode === "cuelist", JSON.stringify(p.chron));
      check("fast: all 400 cues ingested", /OK 400 cues/.test(p.hud) && /cues: 400/.test(p.hud), p.hud);
      check("fast: cuelist never bulldozed back to scrape", !bulldozed, JSON.stringify(p.chron));
      // Full pipeline proof: a translated line actually reaches the overlay.
      // Cues have 200ms display gaps, so sample rather than snapshot once.
      let fa = false;
      for (let i = 0; i < 15 && !fa; i++) { fa = /FA·/.test((document.getElementById("copilot-subs") || { textContent: "" }).textContent); await new Promise((r) => setTimeout(r, 200)); }
      check("fast: translated line rendered in overlay", fa, "looked for FA· prefix");
      window.name = JSON.stringify(results);
      location.href = location.pathname + "?autorun=2&slow=1";
      return;
    }
    // Phase 2 — the deadlock race. The superseded line MUST appear: it proves
    // the race genuinely fired (otherwise this phase would pass vacuously).
    check("race: stale start was superseded (race provably fired)", /superseded/.test(p.hud), p.hud);
    check("race: ends in cuelist despite the race", p.mode === "cuelist", JSON.stringify(p.chron));
    check("race: cuelist never bulldozed back to scrape", firstCue >= 0 && !bulldozed, JSON.stringify(p.chron));
    window.name = "";
    const passed = results.filter((r) => r.ok).length;
    document.title = (passed === results.length ? "PASS " : "FAIL ") + passed + "/" + results.length;
    const out = document.createElement("pre");
    out.id = "results";
    out.style.cssText = "color:#ddd;padding:12px;white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;";
    out.textContent = results.map((r) => (r.ok ? "PASS  " : "FAIL  ") + r.name + "\n      " + r.info).join("\n");
    document.body.appendChild(out);
  }, 16000);
})();
