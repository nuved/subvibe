// Simulated player: the file adopts, cue 0 shows, the driver clicks word #1
// ("Hund") and judges the VOCAB_ADD payload. Verdict in document.title.
(function () {
  const vid = document.getElementById("vid");
  let clock = 0.5, playing = true;
  Object.defineProperty(vid, "currentTime", { get: () => clock });
  Object.defineProperty(vid, "duration", { get: () => 600 }); // VOD
  Object.defineProperty(vid, "paused", { get: () => !playing });
  Object.defineProperty(vid, "ended", { get: () => false });
  setInterval(() => { if (playing) clock += 0.25; }, 250);

  // The caption file URL is "spotted" — with a lang param, so the click
  // handler's lang hint is testable end-to-end. Re-posted like subs-intercept.
  const URL_ = "https://www.youtube.com/api/timedtext?v=vid123&pot=abc&lang=de&fmt=json3";
  setTimeout(() => window.postMessage({ __copilotSubs: true, type: "SUBS_URL", url: URL_ }, "*"), 800);
  setInterval(() => window.postMessage({ __copilotSubs: true, type: "SUBS_URL", url: URL_ }, "*"), 1500);

  const AUTORUN = new URLSearchParams(location.search).get("autorun");
  if (AUTORUN) setTimeout(async () => {
    const results = [];
    const check = (name, ok, info) => results.push({ name, ok: !!ok, info: String(info || "").slice(0, 220) });

    // Wait for the ORIGINAL line to render karaoke word spans (≤ 10s).
    let row = null, spans = [];
    for (let i = 0; i < 50 && spans.length < 2; i++) {
      row = document.querySelector('.copilot-subs__line[data-cs-key="__orig"]');
      spans = row ? [...row.querySelectorAll(".copilot-subs__w")] : [];
      await new Promise((r) => setTimeout(r, 200));
    }
    check("original line renders karaoke word spans", spans.length >= 2, spans.length + " spans");

    // Click word #1 ("Hund") — pointerdown then click at the same spot.
    const w = spans[1];
    if (w) {
      const rect = w.getBoundingClientRect();
      const at = { bubbles: true, clientX: rect.left + 2, clientY: rect.top + 2 };
      w.dispatchEvent(new PointerEvent("pointerdown", at));
      w.dispatchEvent(new MouseEvent("click", at));
    }
    await new Promise((r) => setTimeout(r, 100));
    const m = window.__vocabMsgs[0];
    check("click sends exactly one VOCAB_ADD", window.__vocabMsgs.length === 1, JSON.stringify(window.__vocabMsgs.map((x) => x.word)));
    check("payload word = the clicked span's text", m && m.word === (w && w.textContent), m && m.word);
    check("payload sentence = the cue's original sentence", m && m.sentence === "Der Hund läuft schnell über die Straße.", m && m.sentence);
    check("payload translation = the cached EN· translation", m && m.translation === "EN·Der Hund läuft schnell über die Straße.", m && m.translation);
    check("payload lang hint from the timedtext URL", m && m.lang === "de", m && m.lang);
    check("span pulses .saved", !!(w && w.classList.contains("saved")), w && w.className);
    check("video was NOT paused by the click", playing === true, "playing=" + playing);

    // A drag (pointer travel > 6px) must NOT save.
    if (w) {
      const rect = w.getBoundingClientRect();
      w.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: rect.left + 2, clientY: rect.top + 2 }));
      w.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: rect.left + 40, clientY: rect.top + 30 }));
    }
    await new Promise((r) => setTimeout(r, 100));
    check("a drag does not save", window.__vocabMsgs.length === 1, window.__vocabMsgs.length + " msgs");

    // Learn-pool hints: "Hund" is in the stubbed pool → dotted underline (.lw),
    // hover → overlay tooltip with the meaning, mouseout hides it.
    check("pool word carries the .lw hint", !!(w && w.classList.contains("lw")), w && w.className);
    if (w) w.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    const tip = document.querySelector(".copilot-subs__wtip");
    check("hover shows the overlay tooltip with the meaning", !!(tip && tip.classList.contains("show") && tip.textContent === "سگ"), tip && tip.textContent);
    if (w) w.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    check("mouseout hides the tooltip", !!(tip && !tip.classList.contains("show")), tip && tip.className);

    // On-demand hover translation: "Straße" is in the pool WITHOUT a meaning —
    // a lingering hover (350ms intent) fetches it and the bubble updates.
    const w2 = spans.find((s) => /Straße/.test(s.textContent));
    if (w2) w2.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 650));
    check("lingering hover fetches the missing meaning on demand (card shows type+level too)", !!(tip && tip.classList.contains("show") && tip.textContent.includes("خیابان") && tip.textContent.includes("A1")), tip && tip.textContent);

    const passed = results.filter((r) => r.ok).length;
    document.title = (passed === results.length ? "PASS " : "FAIL ") + passed + "/" + results.length;
    const out = document.createElement("pre");
    out.id = "results";
    out.style.cssText = "color:#ddd;padding:12px;white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;";
    out.textContent = results.map((r) => (r.ok ? "PASS  " : "FAIL  ") + r.name + "\n      " + r.info).join("\n");
    document.body.appendChild(out);
  }, 5000);
})();
