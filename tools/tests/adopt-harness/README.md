# Adoption harness — the scrape→cuelist upgrade must survive the start() race

Pins the bug fixed in 16b0a0e: an older `start()` sleeping in `await
getCaptionTracks` resumed AFTER a newer start had adopted the intercepted
caption file, rebuilt the scrape engine on top of the cuelist engine without a
teardown, and left `cueListActive` stuck true — which disabled the upgrade
valve, `onInterceptedCues`, and the runKey `cl` term, so every later start
printed "deduped (run unchanged)" forever. Symptoms on a real video: rolling
appended words, no karaoke, badge never green, "highlight works for a moment
at the start then breaks".

Runs the REAL `content/common.js` (script-included, not a copy) against a
chrome stub + YouTube-shaped adapter. The on-video debug HUD is the oracle —
the same panel the operator screenshots.

## Run

Open in any Chromium browser (file:// is fine):

    tools/tests/adopt-harness/harness.html?autorun=1

Wait ~35s. Verdict lands in the tab title: `PASS 7/7` or `FAIL n/7`, details
in the page. Two phases, chained by navigation (results carried in
window.name):

1. `autorun=1` — fast timing: engine settles in scrape, file arrives at t=3s.
   Checks: adoption happens, all 400 cues ingested, no fall-back to scrape,
   a translated line (FA· prefix from the stub) actually renders.
2. `autorun=2&slow=1` — the race: `getCaptionTracks` takes 3s and the file
   lands at t=1s, mid-await. Checks: the HUD's "superseded:" line appears
   (proves the race genuinely fired — without this the phase could pass
   vacuously if timings drift), final mode is cuelist, and the chronicle
   (mode sampled every 250ms) never shows cuelist→scrape.

No autorun param = manual mode: watch the HUD, call `window.__probe()` from
the console for {hud, mode, fetches, chron, warns}.

## When to run

Before pushing any change to `content/common.js` that touches `start()`,
`startStream`, `runCueListMode`, `getAllCues`, `onInterceptedCues`,
`fetchSubsByUrl`, or the runKey/engineGen plumbing. Together with the other
two harnesses this is the engine regression suite:

- `tools/tests/live-shift-harness/harness.html?autorun=1` — ZDF live sync (13 checks)
- `tools/tests/live-harness/harness.html?autorun=1` — Gemini Live transcript merge (10 checks, needs the RUN click)
- `tools/tests/adopt-harness/harness.html?autorun=1` — this file (7 checks)
- `tools/tests/vocab-harness/harness.html?autorun=1` — click-to-save vocabulary + on-video hints (13 checks)
