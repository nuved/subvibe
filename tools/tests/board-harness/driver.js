// Simulated player + judge for the board harness. Waits for the board, reads the Explain all label, presses it,
// waits for every chunk to be explained, then checks what reached the model and what the board shows; last, the ×.
(function () {
  const vid = document.getElementById("vid");
  let clock = 0.5, playing = true;
  Object.defineProperty(vid, "currentTime", { get: () => clock, set: (v) => { clock = v; } });
  Object.defineProperty(vid, "duration", { get: () => 600 });
  Object.defineProperty(vid, "paused", { get: () => !playing });
  Object.defineProperty(vid, "ended", { get: () => false });
  vid.pause = () => { playing = false; };
  vid.play = () => { playing = true; return Promise.resolve(); };
  setInterval(() => { if (playing) clock += 0.25; }, 250);
  // The caption file URL is "spotted", re-posted like subs-intercept does.
  const URL_ = "https://www.youtube.com/api/timedtext?v=vid123&pot=abc&lang=en&fmt=json3";
  setTimeout(() => window.postMessage({ __copilotSubs: true, type: "SUBS_URL", url: URL_ }, "*"), 800);
  setInterval(() => window.postMessage({ __copilotSubs: true, type: "SUBS_URL", url: URL_ }, "*"), 1500);
  const until = (fn, ms) => new Promise((res, rej) => { const t0 = Date.now(); const id = setInterval(() => { let v; try { v = fn(); } catch (e) { v = null; } if (v) { clearInterval(id); res(v); } else if (Date.now() - t0 > ms) { clearInterval(id); rej(new Error("timeout")); } }, 100); });
  const R = (window.__result = { checks: {} });
  const done = (ok, why) => { R.ok = ok; document.title = (ok ? "PASS " : "FAIL ") + why; };
  (async () => {
    try {
      const board = await until(() => document.getElementById("sv-board"), 20000);
      R.chunks = await until(() => { const rows = board.querySelectorAll(".svb-chunk"); return rows.length >= 4 ? [...rows].map((r) => r.querySelector(".svb-main").innerText.split("\n")[0]) : null; }, 20000);
      const btn = await until(() => [...board.querySelectorAll(".svb-explain")].find((b) => /Explain all/.test(b.textContent) && /\$/.test(b.textContent)), 10000);
      R.label = btn.textContent;
      R.checks.price = /Explain all · ~\$0\.08 →/.test(R.label); // 4 chunks × $0.021 = $0.084
      btn.click();
      await until(() => board.querySelectorAll(".svb-mark:not(.busy)").length >= 4, 20000);
      await new Promise((r) => setTimeout(r, 1500));
      const msgs = window.__explainMsgs;
      R.calls = msgs.map((m) => ({ s: m.s, prevScene: m.prevScene || "", prevWho: m.prevWho || [], known: m.known || [] }));
      R.checks.chorusOnce = msgs.length === 3 && msgs.filter((m) => /lost without you/i.test(m.s)).length === 1; // 4 chunks, 3 calls: the chorus once
      R.checks.contextSent = msgs.slice(1).every((m) => !!m.prevScene && m.prevWho.length > 0 && m.known.length > 0);
      R.scenes = [...board.querySelectorAll(".svb-scene-txt")].map((e) => e.textContent);
      R.checks.sceneOnce = R.scenes.length === 1;
      R.checks.paneNoScene = ![...board.querySelectorAll(".svb-pane .wt-lbl")].some((e) => /What's happening/.test(e.textContent));
      const close = board.querySelector(".svb-close");
      R.checks.closeThere = !!close;
      close.click();
      await new Promise((r) => setTimeout(r, 800));
      R.checks.boardGone = !document.getElementById("sv-board");
      R.checks.settingSaved = (window.__storageSets || []).some((o) => o.storyBoard === false);
      const bad = Object.entries(R.checks).filter(([, v]) => !v).map(([k]) => k);
      done(!bad.length, bad.length ? bad.join(",") : Object.keys(R.checks).join(","));
    } catch (e) { R.error = String(e && e.stack || e); done(false, "error " + e.message); }
  })();
})();
