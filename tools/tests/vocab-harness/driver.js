// Simulated player: the file adopts, cue 0 shows, the driver clicks word #1
// ("Hund") and judges the VOCAB_ADD payload. Verdict in document.title.
(function () {
  const vid = document.getElementById("vid");
  let clock = 0.5, playing = true;
  Object.defineProperty(vid, "currentTime", { get: () => clock });
  Object.defineProperty(vid, "duration", { get: () => 600 }); // VOD
  Object.defineProperty(vid, "paused", { get: () => !playing });
  Object.defineProperty(vid, "ended", { get: () => false });
  // The word card pauses/resumes the element itself — model that so the harness
  // observes it (the paused getter already reflects `playing`).
  vid.pause = () => { playing = false; };
  vid.play = () => { playing = true; return Promise.resolve(); };
  setInterval(() => { if (playing) clock += 0.25; }, 250);

  // The caption file URL is "spotted" — with a lang param, so the click
  // handler's lang hint is testable end-to-end. Re-posted like subs-intercept.
  const URL_ = "https://www.youtube.com/api/timedtext?v=vid123&pot=abc&lang=de&fmt=json3";
  setTimeout(() => window.postMessage({ __copilotSubs: true, type: "SUBS_URL", url: URL_ }, "*"), 800);
  setInterval(() => window.postMessage({ __copilotSubs: true, type: "SUBS_URL", url: URL_ }, "*"), 1500);

  const AUTORUN = new URLSearchParams(location.search).get("autorun");
  const NOPOOL = new URLSearchParams(location.search).get("nopool"); // clip's language isn't the one being learned → empty pool
  const SPLIT = new URLSearchParams(location.search).get("split");   // a sentence split across two cues
  const RUNAWAY = new URLSearchParams(location.search).get("runaway"); // many cues, no sentence punctuation
  if (AUTORUN) setTimeout(async () => {
    const results = [];
    const check = (name, ok, info) => results.push({ name, ok: !!ok, info: String(info || "").slice(0, 220) });
    const finish = () => {
      const passed = results.filter((r) => r.ok).length;
      document.title = (passed === results.length ? "PASS " : "FAIL ") + passed + "/" + results.length;
      const out = document.createElement("pre");
      out.id = "results";
      out.style.cssText = "color:#ddd;padding:12px;white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;";
      out.textContent = results.map((r) => (r.ok ? "PASS  " : "FAIL  ") + r.name + "\n      " + r.info).join("\n");
      document.body.appendChild(out);
    };

    if (NOPOOL) {
      // Regression: a clip whose language isn't the one being learned has an
      // EMPTY pool (vocabPool null). Clicking a word must still FETCH and show
      // its meaning — the bug discarded the fetched meaning and showed "no
      // meaning yet" for every word (e.g. German words on an "en"-detected clip).
      let r2 = null, sp2 = [];
      for (let i = 0; i < 50 && sp2.length < 2; i++) {
        r2 = document.querySelector('.copilot-subs__line[data-cs-key="__orig"]');
        sp2 = r2 ? [...r2.querySelectorAll(".copilot-subs__w")] : [];
        await new Promise((r) => setTimeout(r, 200));
      }
      check("no-pool clip: original line still renders", sp2.length >= 2, sp2.length + " spans");
      const tw = sp2[1];
      if (tw) { const rr = tw.getBoundingClientRect(); const at = { bubbles: true, clientX: rr.left + 2, clientY: rr.top + 2 }; tw.dispatchEvent(new PointerEvent("pointerdown", at)); tw.dispatchEvent(new MouseEvent("click", at)); }
      await new Promise((r) => setTimeout(r, 1000));
      const tip = document.querySelector(".copilot-subs__wtip");
      check("no-pool clip: a word click STILL fetches + shows the meaning (not 'no meaning')",
        !!(tip && tip.classList.contains("pinned") && tip.textContent.includes("خیابان") && !/no meaning/.test(tip.textContent)),
        tip && tip.textContent);
      finish();
      return;
    }

    if (SPLIT) {
      // Cross-cue context: "Ich wünsche mir dass er" | "nach Hause kommt." are
      // two cues (buildGroups split them by the gap). Clicking a word in the
      // FIRST cue must send the model the RECONSTRUCTED full sentence — including
      // the verb "kommt" that lands in the next cue — not the truncated group.
      let r3 = null, sp3 = [];
      for (let i = 0; i < 50 && sp3.length < 2; i++) {
        r3 = document.querySelector('.copilot-subs__line[data-cs-key="__orig"]');
        sp3 = r3 ? [...r3.querySelectorAll(".copilot-subs__w")] : [];
        await new Promise((r) => setTimeout(r, 200));
      }
      check("split: the first cue renders", sp3.length >= 2, (r3 && r3.textContent) || "");
      const tw = sp3.find((s) => /wünsche/i.test(s.textContent)) || sp3[1];
      if (tw) { const rr = tw.getBoundingClientRect(); const at = { bubbles: true, clientX: rr.left + 2, clientY: rr.top + 2 }; tw.dispatchEvent(new PointerEvent("pointerdown", at)); tw.dispatchEvent(new MouseEvent("click", at)); }
      await new Promise((r) => setTimeout(r, 900));
      check("split: enrich gets the sentence RECONSTRUCTED across cues (incl. 'nach Hause kommt')",
        !!(window.__enrichS && /nach Hause kommt/.test(window.__enrichS)), window.__enrichS);
      finish();
      return;
    }

    if (RUNAWAY) {
      // Punctuation-less captions: an UNBOUNDED walk would send the model (and
      // the card) the whole clip. The bounded walk must send a small window —
      // never reaching the "ENDE" marker in the last cue.
      let r4 = null, sp4 = [];
      for (let i = 0; i < 50 && sp4.length < 2; i++) {
        r4 = document.querySelector('.copilot-subs__line[data-cs-key="__orig"]');
        sp4 = r4 ? [...r4.querySelectorAll(".copilot-subs__w")] : [];
        await new Promise((r) => setTimeout(r, 200));
      }
      check("runaway: the first cue renders", sp4.length >= 2, (r4 && r4.textContent) || "");
      const tw = sp4[1];
      if (tw) { const rr = tw.getBoundingClientRect(); const at = { bubbles: true, clientX: rr.left + 2, clientY: rr.top + 2 }; tw.dispatchEvent(new PointerEvent("pointerdown", at)); tw.dispatchEvent(new MouseEvent("click", at)); }
      await new Promise((r) => setTimeout(r, 900));
      check("runaway: enrich context is BOUNDED (no runaway; never reaches 'ENDE')",
        !!(window.__enrichS && window.__enrichS.length < 230 && !/ENDE/.test(window.__enrichS)), (window.__enrichS || "").length + " chars — " + window.__enrichS);
      finish();
      return;
    }

    // Wait for the ORIGINAL line to render karaoke word spans (≤ 10s).
    let row = null, spans = [];
    for (let i = 0; i < 50 && spans.length < 2; i++) {
      row = document.querySelector('.copilot-subs__line[data-cs-key="__orig"]');
      spans = row ? [...row.querySelectorAll(".copilot-subs__w")] : [];
      await new Promise((r) => setTimeout(r, 200));
    }
    check("original line renders karaoke word spans", spans.length >= 2, spans.length + " spans");

    // Wait for the trainer pool to arm (Hund gets the .lw hint) so the card
    // shows the CACHED meaning deterministically, not a race with the pool fetch.
    for (let i = 0; i < 40 && !(spans[1] && spans[1].classList.contains("lw")); i++) await new Promise((r) => setTimeout(r, 100));
    check("trainer pool armed before click", !!(spans[1] && spans[1].classList.contains("lw")), spans[1] && spans[1].className);

    // Click word #1 ("Hund"): the new model PAUSES the video and pins a card
    // with a Save button — it does NOT save on the bare click.
    const w = spans[1];
    if (w) {
      const rect = w.getBoundingClientRect();
      const at = { bubbles: true, clientX: rect.left + 2, clientY: rect.top + 2 };
      w.dispatchEvent(new PointerEvent("pointerdown", at));
      w.dispatchEvent(new MouseEvent("click", at));
    }
    await new Promise((r) => setTimeout(r, 120));
    const tip = document.querySelector(".copilot-subs__wtip");
    check("click pauses the video", playing === false, "playing=" + playing);
    check("click pins the word card", !!(tip && tip.classList.contains("show") && tip.classList.contains("pinned")), tip && tip.className);
    check("the card shows the Persian meaning", !!(tip && tip.textContent.includes("سگ")), tip && tip.textContent);
    check("the card offers a Save button", !!(tip && tip.querySelector(".wt-save")), tip && tip.querySelector(".wt-save") && tip.querySelector(".wt-save").textContent);
    check("a bare click does NOT save yet", window.__vocabMsgs.length === 0, window.__vocabMsgs.length + " msgs");

    // Click Save → exactly one VOCAB_ADD with the right payload.
    const saveBtn = tip && tip.querySelector(".wt-save");
    if (saveBtn) saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    const m = window.__vocabMsgs[0];
    check("Save sends exactly one VOCAB_ADD", window.__vocabMsgs.length === 1, JSON.stringify(window.__vocabMsgs.map((x) => x.word)));
    check("payload word = the clicked span's text", m && m.word === (w && w.textContent), m && m.word);
    check("payload sentence = the cue's original sentence", m && m.sentence === "Der Hund läuft schnell über die Straße.", m && m.sentence);
    check("payload translation = the cached EN· translation", m && m.translation === "EN·Der Hund läuft schnell über die Straße.", m && m.translation);
    check("payload lang hint from the timedtext URL", m && m.lang === "de", m && m.lang);
    check("the Save button confirms saved", !!(saveBtn && /Saved/.test(saveBtn.textContent)), saveBtn && saveBtn.textContent);

    // Close the card → the video resumes.
    const closeBtn = tip && tip.querySelector(".wt-close");
    if (closeBtn) closeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    check("closing the card resumes the video", playing === true, "playing=" + playing);
    check("closing hides the card", !!(tip && !tip.classList.contains("show")), tip && tip.className);

    // A drag (pointer travel > 6px) must NOT open the card, pause, or save.
    if (w) {
      const rect = w.getBoundingClientRect();
      w.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: rect.left + 2, clientY: rect.top + 2 }));
      w.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: rect.left + 40, clientY: rect.top + 30 }));
    }
    await new Promise((r) => setTimeout(r, 100));
    check("a drag does not pin a card", !!(tip && !tip.classList.contains("pinned")), tip && tip.className);
    check("a drag does not pause", playing === true, "playing=" + playing);
    check("a drag does not save", window.__vocabMsgs.length === 1, window.__vocabMsgs.length + " msgs");

    // Regression (real-click bug): the line-drag handler calls setPointerCapture
    // on pointerdown, so on real hardware the CLICK is retargeted to the LINE,
    // not the word — e.target.closest(".copilot-subs__w") is null and the card
    // never opened. The synthetic clicks above hit the word directly and hide
    // this. Simulate the retarget: click the LINE with the point over a word;
    // the card must still open (via elementFromPoint recovery).
    {
      const line = document.querySelector('.copilot-subs__line[data-cs-key="__orig"]');
      const tw = line && [...line.querySelectorAll(".copilot-subs__w")][1];
      if (tw) {
        const rr = tw.getBoundingClientRect();
        const at = { bubbles: true, clientX: Math.round(rr.left + rr.width / 2), clientY: Math.round(rr.top + rr.height / 2) };
        line.dispatchEvent(new PointerEvent("pointerdown", at));
        line.dispatchEvent(new MouseEvent("click", at)); // target = LINE, point over the word
      }
      await new Promise((r) => setTimeout(r, 150));
      check("a click retargeted to the line still opens the card (elementFromPoint)", !!(tip && tip.classList.contains("show") && tip.classList.contains("pinned")), tip && tip.className);
      const cb = tip && tip.querySelector(".wt-close");
      if (cb) cb.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
    }

    // Learn-pool hints: "Hund" is in the stubbed pool → dotted underline (.lw).
    check("pool word carries the .lw hint", !!(w && w.classList.contains("lw")), w && w.className);

    // CEFR-graded underline: a leveled pool word ("schnell", B1) carries its
    // level as a data attribute the CSS colors by.
    const wc = spans.find((s) => /schnell/i.test(s.textContent));
    check("a leveled pool word carries its CEFR on the underline", !!(wc && wc.classList.contains("lw") && wc.dataset.cefr === "B1"), wc && (wc.className + " cefr=" + (wc.dataset.cefr || "")));
    // Smart lightener: a learned / low-priority word (stub dim=["die"]) is dimmed.
    const wd = spans.find((s) => s.textContent.replace(/[^\p{L}]/gu, "").toLowerCase() === "die");
    check("a learned / low-priority word is dimmed", !!(wd && wd.classList.contains("known")), wd && wd.className);

    // Hover does NOTHING now — the card is click-only, so a lookup never races
    // the moving subtitle line. Hovering a word must not open the tooltip.
    if (w) w.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    check("hover does NOT open the tooltip (click-only)", !!(tip && !tip.classList.contains("show")), tip && tip.className);

    // Clicking an UN-enriched pool word ("Straße", no cached meaning) fetches on
    // demand — one call returns the word card AND the sentence's grammar.
    const w2 = spans.find((s) => /Straße/.test(s.textContent));
    if (w2) { const r2 = w2.getBoundingClientRect(); const at2 = { bubbles: true, clientX: r2.left + 2, clientY: r2.top + 2 }; w2.dispatchEvent(new PointerEvent("pointerdown", at2)); w2.dispatchEvent(new MouseEvent("click", at2)); }
    await new Promise((r) => setTimeout(r, 1000));
    check("clicking an un-enriched word fetches its meaning on demand", !!(tip && tip.classList.contains("pinned") && tip.textContent.includes("خیابان") && tip.textContent.includes("A1")), tip && tip.textContent);
    check("the fetched card carries the sentence's grammar from the same call", !!(tip && tip.textContent.includes("زمان حال ساده")), tip && tip.textContent);

    // The underline is a recommendation, not a permission: a word OUTSIDE the
    // pool ("läuft" — no .lw) is clickable and fetches exactly the same.
    const cb2 = tip && tip.querySelector(".wt-close");
    if (cb2) cb2.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    const w3 = spans.find((s) => /läuft/.test(s.textContent) && !s.classList.contains("lw"));
    if (w3) { const r3 = w3.getBoundingClientRect(); const at3 = { bubbles: true, clientX: r3.left + 2, clientY: r3.top + 2 }; w3.dispatchEvent(new PointerEvent("pointerdown", at3)); w3.dispatchEvent(new MouseEvent("click", at3)); }
    await new Promise((r) => setTimeout(r, 1000));
    check("a non-pool word is clickable and fetches too", !!(w3 && tip.classList.contains("pinned") && tip.textContent.includes("خیابان")), (w3 ? "" : "no un-pooled span found; ") + (tip && tip.textContent));

    const passed = results.filter((r) => r.ok).length;
    document.title = (passed === results.length ? "PASS " : "FAIL ") + passed + "/" + results.length;
    const out = document.createElement("pre");
    out.id = "results";
    out.style.cssText = "color:#ddd;padding:12px;white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;";
    out.textContent = results.map((r) => (r.ok ? "PASS  " : "FAIL  ") + r.name + "\n      " + r.info).join("\n");
    document.body.appendChild(out);
  }, 5000);
})();
