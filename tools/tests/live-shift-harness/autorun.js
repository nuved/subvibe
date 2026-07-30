// Self-running scenario suite. Open harness.html?autorun=1 and wait ~1 minute;
// the page chains itself through three loads (results carried in window.name)
// and finishes with a PASS/FAIL report on screen + in document.title.
//
// Scenarios (engine-sign offsets: stored + = earlier, the popup UI shows −):
//   S1 live PLAYING with cue headroom → a stored +2 shifts the shown line forward
//   S3 live PAUSED, buffering continues (free room) → ±3 shifts both directions
//   S2 live PAUSED at the exact edge, no room  → +5 clamps to the newest line
//      WITH the "Live edge" status note; −3 still moves back
//   S4 engine STARTED against an already-paused live video → liveness still arms
//      (tri-state latch) and ±shift works            [the "dead control" bug]
//   S5 paused VOD (finite duration) → live stays false, shift stays inert
(function () {
  const q = new URLSearchParams(location.search);
  const phase = q.get("autorun");
  if (!phase) return;

  const results = (() => { try { return JSON.parse(window.name || "[]"); } catch { return []; } })();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const parseN = (s) => { const m = /Zeile (\d+):/.exec(s || ""); return m ? +m[1] : null; };
  const snap = () => window.sim.state();
  // Manual shift actually applied by the engine, in seconds: playhead-as-displayed
  // minus true clock minus the auto-calibration share.
  const applied = (s) => (s.diag ? +(s.diag.play - s.clock - (s.diag.autoOff || 0)).toFixed(2) : null);
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

  async function engineUp(timeoutMs = 12000) {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const s = snap();
      if (s.diag && s.diag.mode === "cuelist" && parseN(s.shown.__orig) != null) return true;
      await sleep(400);
    }
    return false;
  }

  async function phase1() { // S1, S3, S2 on a playing live stream
    check("boot: cuelist engine renders a line", await engineUp(), snap());
    await sleep(4000); // let auto-calibration settle

    // S1 — playing, headroom available
    const a0 = snap();
    await window.sim.setStoredOffset(2);
    await sleep(2500);
    const a1 = snap();
    check("S1 playing: stored +2 applies (earlier)", applied(a1) > 1.0 && applied(a1) < 3.0, { before: applied(a0), after: applied(a1) });
    await window.sim.setStoredOffset(0);
    await sleep(1500);

    // S3 — paused with buffered room building
    window.sim.pause(true);
    await sleep(4000);
    const b0 = snap();
    await window.sim.setStoredOffset(3);
    await sleep(2000);
    const b1 = snap();
    check("S3 paused+room: stored +3 shows a LATER line", parseN(b1.shown.__orig) > parseN(b0.shown.__orig) && Math.abs(applied(b1) - 3) < 0.8, { n0: parseN(b0.shown.__orig), n1: parseN(b1.shown.__orig), applied: applied(b1) });
    await window.sim.setStoredOffset(-3);
    await sleep(2000);
    const b2 = snap();
    check("S3 paused+room: stored −3 shows an EARLIER line", parseN(b2.shown.__orig) < parseN(b0.shown.__orig) && Math.abs(applied(b2) + 3) < 0.8, { n0: parseN(b0.shown.__orig), n2: parseN(b2.shown.__orig), applied: applied(b2) });
    await window.sim.setStoredOffset(0);
    await sleep(1500);

    // S2 — run the playhead into the frozen edge, pause with zero room
    window.sim.play();
    window.sim.buffering = false;
    await sleep(9000);
    window.sim.pause(false);
    await sleep(1500);
    const c0 = snap();
    await window.sim.setStoredOffset(5);
    await sleep(1500);
    const c1 = snap();
    check("S2 edge: stored +5 clamps to the SAME newest line", parseN(c1.shown.__orig) === parseN(c0.shown.__orig), { n0: parseN(c0.shown.__orig), n1: parseN(c1.shown.__orig) });
    check("S2 edge: the clamp is ANNOUNCED (Live edge status)", /live edge/i.test(c1.status), { status: c1.status });
    await window.sim.setStoredOffset(-3);
    await sleep(1500);
    const c2 = snap();
    check("S2 edge: stored −3 still moves BACK", parseN(c2.shown.__orig) < parseN(c0.shown.__orig), { n0: parseN(c0.shown.__orig), n2: parseN(c2.shown.__orig) });

    window.name = JSON.stringify(results);
    location.search = "?autorun=2&mode=relay&buf=8&paused=1";
  }

  async function phase2() { // S4 — engine starts against an already-paused live video
    check("S4 boot (paused video): engine renders", await engineUp(), snap());
    await sleep(4000); // reread + latch ticks
    const d0 = snap();
    check("S4 started-paused: liveness ARMS from pause", d0.diag && d0.diag.live === true, { live: d0.diag && d0.diag.live });
    await window.sim.setStoredOffset(3);
    await sleep(2000);
    const d1 = snap();
    check("S4 started-paused: stored +3 applies", parseN(d1.shown.__orig) > parseN(d0.shown.__orig) && Math.abs(applied(d1) - 3) < 0.8, { n0: parseN(d0.shown.__orig), n1: parseN(d1.shown.__orig), applied: applied(d1) });

    window.name = JSON.stringify(results);
    location.search = "?autorun=3&mode=direct&buf=8&paused=1&vod=1";
  }

  async function phase3() { // S5 — paused VOD: shift stays inert by design
    check("S5 boot (paused VOD): engine renders", await engineUp(), snap());
    await sleep(2500);
    const e0 = snap();
    check("S5 VOD: liveness verdict is false", e0.diag && e0.diag.live === false, { live: e0.diag && e0.diag.live });
    await window.sim.setStoredOffset(3);
    await sleep(2000);
    const e1 = snap();
    check("S5 VOD: stored +3 stays INERT (frame-exact design)", parseN(e1.shown.__orig) === parseN(e0.shown.__orig) && Math.abs(applied(e1)) < 0.5, { n0: parseN(e0.shown.__orig), n1: parseN(e1.shown.__orig), applied: applied(e1) });

    // ── report ──
    const fails = results.filter((r) => !r.ok);
    document.title = fails.length ? `FAIL ${fails.length}/${results.length}` : `PASS ${results.length}/${results.length}`;
    const pre = document.createElement("pre");
    pre.id = "results";
    pre.style.cssText = "position:fixed;inset:auto 8px 8px 8px;max-height:45%;overflow:auto;background:#000c;color:#9f9;padding:10px;font:11px monospace;z-index:999999;white-space:pre-wrap;";
    pre.textContent = results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}\n      ${JSON.stringify(r.detail)}`).join("\n");
    document.body.appendChild(pre);
    console.info("[harness] " + document.title, results);
    window.name = "";
  }

  (phase === "1" ? phase1() : phase === "2" ? phase2() : phase3()).catch((e) => {
    document.title = "FAIL (harness error)";
    console.error("[harness]", e);
  });
})();
