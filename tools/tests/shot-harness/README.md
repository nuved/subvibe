# Shot editor harness — toolbar reachability + non-destructive crop

Pins two things on the REAL `shot.js` + `shared/shot.js` (script-included, not
a copy) against a chrome stub and a seeded IndexedDB record:

1. **The ed4e237 regression.** `.stage` became `flex-direction: column` but kept
   `justify-content: center` — in a column that centers VERTICALLY, and centered
   overflow in an `overflow: auto` container is unreachable above the scrollport
   start. On any shot taller than the window (every full-page capture) the
   annotation toolbar sat thousands of px above the reachable area: "no tools".
   The harness renders a 400×6000 shot and asserts the toolbar is visible at
   `scrollTop 0` and stays pinned (sticky) after scrolling 2000px. With the old
   CSS the toolbar measures at −2575px — the check fails.

2. **Crop.** Drag with the crop tool → `rec.crop` stored as full-image
   fractions, canvas resized to the crop window, Uncrop revealed, tool back to
   select; a rectangle annotation drawn ON the cropped view stores full-image
   coords (the crop↔view mapping, `S.cropToView`/`S.viewToCrop`); Uncrop
   restores the full size and clears `rec.crop` in the DB.

## Run

Open in any Chromium browser (file:// is fine):

    tools/tests/shot-harness/harness.html

The first open navigates itself to `?id=t1` (the seeded record). Verdict lands
in the tab title (`PASS 7/7` / `FAIL n/7`), details in the panel bottom-left
and in `window.__results`. Re-runs re-seed the record, so state can't leak
between runs.

## When to run

Before pushing any change to `shot.js` (render/annotation/crop paths),
`shared/shot.js` (crop helpers, `frameLayout`), or `styles/shot.css` (`.stage`
/ `.annotbar` layout). The crop coordinate math is also unit-tested in
`tools/tests/shot.test.mjs` — this harness covers the wiring on the live page.
