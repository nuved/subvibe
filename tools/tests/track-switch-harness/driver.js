// Simulated player with two native subtitle tracks + the operator's exact
// sequence: watch with German, switch the player to English mid-video.
(function () {
  const vid = document.getElementById("vid");
  let clock = 0.5, playing = true;
  Object.defineProperty(vid, "currentTime", { get: () => clock });
  Object.defineProperty(vid, "duration", { get: () => 600 }); // VOD
  Object.defineProperty(vid, "paused", { get: () => !playing });
  Object.defineProperty(vid, "ended", { get: () => false });
  setInterval(() => { if (playing) clock += 0.25; }, 250);

  const URL_DE = "https://harness.test/api/timedtext?v=clip42&lang=de&pot=r1";
  const URL_EN = "https://harness.test/api/timedtext?v=clip42&lang=en&pot=r2";
  if (window.__PHASE === 1) {
    // Phase 1 — NATIVE tracks: two programmatic tracks (same-origin, no
    // network), identical timing — how a multi-language subtitle set is authored.
    const de = vid.addTextTrack("subtitles", "Deutsch", "de");
    const en = vid.addTextTrack("subtitles", "English", "en");
    for (let i = 0; i < 60; i++) {
      const s = i * 2, e = s + 1.8;
      de.addCue(new VTTCue(s, e, "German line " + (i + 1)));
      en.addCue(new VTTCue(s, e, "English line " + (i + 1)));
    }
    de.mode = "showing"; // the viewer's initial pick — hideNative will hide it
    en.mode = "hidden";  // loaded but not selected (players keep cues warm)
    // t=8s: the viewer opens the player's subtitle menu and picks English.
    // This is ALL a real player does — mode flips, no refetch.
    setTimeout(() => { de.mode = "disabled"; en.mode = "showing"; }, 8000);
  } else {
    // Phase 2 — the URL/timedtext path (YouTube-shaped): each pick makes the
    // player fetch that track's file; the interceptor posts the URL. The
    // operator's exact sequence was original → auto-translate → original;
    // A→B→A is the same shape. The 1.5s re-post mirrors subs-intercept.js.
    let current = URL_DE;
    const post = () => window.postMessage({ __copilotSubs: true, type: "SUBS_URL", url: current }, "*");
    setTimeout(post, 2000);
    setInterval(post, 1500);
    setTimeout(() => { current = URL_EN; post(); }, 8000);  // switch away…
    setTimeout(() => { current = URL_DE; post(); }, 12000); // …and BACK (the bug: sticks on English)
  }

  // Chronicle: sample what the overlay actually shows, so language flips are
  // provable ("FA·German… until 8s, FA·English… by 12s").
  window.__chron = [];
  setInterval(() => {
    const ov = document.getElementById("copilot-subs");
    const txt = ov ? ov.textContent.replace(/\s+/g, " ").trim() : "";
    const lang = /FA·German/.test(txt) ? "de" : /FA·English/.test(txt) ? "en" : txt ? "other" : "none";
    const last = window.__chron[window.__chron.length - 1];
    if (!last || last.lang !== lang) window.__chron.push({ at: +clock.toFixed(1), lang, sample: txt.slice(0, 60) });
  }, 250);

  window.__probe = () => {
    const hud = document.getElementById("copilot-subs-hud");
    let diag = null; try { diag = JSON.parse(document.documentElement.dataset.csDiag || "null"); } catch {}
    return { hud: hud ? hud.textContent : "NO HUD", mode: diag && diag.mode, clock: +clock.toFixed(1), chron: window.__chron, warns: window.__warns };
  };

  // ── autorun: self-judging run, verdict in document.title ────────────────────
  // ?autorun=1 → native-track switch, chains to ?autorun=2 → URL A→B→A.
  // Results accumulate in window.name across the navigation (adopt pattern).
  const AUTORUN = new URLSearchParams(location.search).get("autorun");
  if (AUTORUN) setTimeout(() => {
    const results = (() => { try { return JSON.parse(window.name || "[]"); } catch { return []; } })();
    const check = (name, ok, info) => results.push({ name, ok: !!ok, info: String(info || "").slice(0, 220) });
    const p = window.__probe();
    const langs = p.chron.map((c) => c.lang);
    if (AUTORUN === "1") {
      // Baseline: German was adopted and rendered BEFORE the switch — without
      // this the main assertion could pass vacuously.
      const sawDe = p.chron.some((c) => c.lang === "de" && c.at < 8.5);
      check("native: German adopted & rendered before the switch", sawDe, JSON.stringify(p.chron));
      const enAfter = p.chron.some((c) => c.lang === "en" && c.at > 8);
      check("native: overlay shows English after the player's track switch", enAfter, JSON.stringify(p.chron));
      const enIdx = langs.lastIndexOf("en");
      check("native: German never returns once English took over", enAfter && !langs.slice(enIdx + 1).includes("de"), JSON.stringify(p.chron));
      window.name = JSON.stringify(results);
      location.href = location.pathname + "?autorun=2";
      return;
    }
    // Phase 2 verdicts — the operator's YouTube sequence.
    const sawDe1 = p.chron.some((c) => c.lang === "de" && c.at < 8.5);
    check("url: German file adopted before any switch", sawDe1, JSON.stringify(p.chron));
    const enMid = p.chron.some((c) => c.lang === "en" && c.at > 8 && c.at < 12.5);
    check("url: switch to English adopts the new file", enMid, JSON.stringify(p.chron));
    // THE reported bug: switching BACK must re-adopt German, not stick on English.
    const lastLang = langs.filter((l) => l === "de" || l === "en").pop();
    check("url: switch BACK re-adopts German (A→B→A must not stick on B)", enMid && lastLang === "de", JSON.stringify(p.chron));
    window.name = "";
    const passed = results.filter((r) => r.ok).length;
    document.title = (passed === results.length ? "PASS " : "FAIL ") + passed + "/" + results.length;
    const out = document.createElement("pre");
    out.id = "results";
    out.style.cssText = "color:#ddd;padding:12px;white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;";
    out.textContent = results.map((r) => (r.ok ? "PASS  " : "FAIL  ") + r.name + "\n      " + r.info).join("\n");
    document.body.appendChild(out);
  }, 18000);
})();
