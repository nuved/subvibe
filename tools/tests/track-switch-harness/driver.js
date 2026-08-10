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

  // Two programmatic tracks (same-origin, no network): identical timing —
  // exactly how a multi-language subtitle set is authored.
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
  window.__switchedAt = 0;
  setTimeout(() => { de.mode = "disabled"; en.mode = "showing"; window.__switchedAt = clock; }, 8000);

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
  const AUTORUN = new URLSearchParams(location.search).get("autorun");
  if (AUTORUN) setTimeout(() => {
    const results = [];
    const check = (name, ok, info) => results.push({ name, ok: !!ok, info: String(info || "").slice(0, 220) });
    const p = window.__probe();
    const langs = p.chron.map((c) => c.lang);
    // Baseline: German was adopted and rendered BEFORE the switch — without
    // this the main assertion could pass vacuously.
    const sawDe = p.chron.some((c) => c.lang === "de" && c.at < 8.5);
    check("baseline: German cue list adopted & rendered before the switch", sawDe, JSON.stringify(p.chron));
    // The fix: after the player switched to English, the overlay follows.
    const enAfter = p.chron.some((c) => c.lang === "en" && c.at > 8);
    check("switch: overlay shows English lines after the player's track switch", enAfter, JSON.stringify(p.chron));
    // And German never comes back after English took over.
    const enIdx = langs.lastIndexOf("en");
    const deAfterEn = enIdx >= 0 && langs.slice(enIdx + 1).includes("de");
    check("switch: German never returns once English took over", enAfter && !deAfterEn, JSON.stringify(p.chron));
    const passed = results.filter((r) => r.ok).length;
    document.title = (passed === results.length ? "PASS " : "FAIL ") + passed + "/" + results.length;
    const out = document.createElement("pre");
    out.id = "results";
    out.style.cssText = "color:#ddd;padding:12px;white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;";
    out.textContent = results.map((r) => (r.ok ? "PASS  " : "FAIL  ") + r.name + "\n      " + r.info).join("\n");
    document.body.appendChild(out);
  }, 18000);
})();
