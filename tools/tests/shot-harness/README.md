# Shot editor harness — the real `shot.js` against a seeded record

Three files, all runnable from `file://` in any Chromium browser:

| File | What it is |
|---|---|
| `harness.html` | Judge. Mirrors the editor DOM (ids must match `shot.html` — `shot.js` runs unmodified), seeds a 400×6000 record, drives the real code with synthetic pointer/keyboard events and puts the verdict in the tab title (`PASS n/n`), the panel bottom-left and `window.__results`. |
| `preview.html` | Seeder for design work. Paints a realistic German article to canvas (original + a Persian in-place translation), stores it as `preview1` (full page, translated, sentence pairs — one paragraph contains "Dr." and a "2. September" date, the abbreviation cases) and `preview2` (area shot, untranslated). Then open the REAL `shot.html?id=preview1`. |
| `chrome-stub.js` | Just enough `chrome.*` for `shot.html` from `file://`: `SHOT_TAB_ALIVE` → closed tab, every re-shoot refused, prefs in `localStorage`. Inject before the page's scripts — chrome-devtools MCP `navigate_page` with `initScript`, or paste it in the console and reload with script blocking. |

IndexedDB is shared across `file://` pages in Chrome, so the seeder and the editor see the same `copilot-subs` database.

## What `harness.html` pins (19 checks)

1. **Toolbar reachability** (the ed4e237 regression): `.stage` became `flex-direction: column` but kept `justify-content: center`; vertically-centred overflow in an `overflow: auto` box is unreachable above the scrollport. Visible at `scrollTop 0`, sticky after scrolling 2000 px. With the old CSS the bar measures at −2575 px.
2. **Crop**: drag → `rec.crop` in full-image fractions, canvas resized, Uncrop revealed, tool reset; a rect drawn on the cropped view stores full-image coords; Uncrop restores size and clears the record.
3. **Select** (2026-09-02): drag moves a mark and persists it; the Delete button appears; `Delete` removes it.
4. **Blur**: stored as a rect; the overlay has opaque pixels inside the box and none outside.
5. **Number badges**: count 1, 2; deleting badge 1 renumbers the other to 1.
6. **Window frame** adds the 36 px title bar; **Export footer** is visible without scrolling the panel.
7. **Bilingual on the page**: Notes = page + 220 px margin column (crop stays available); Side by side = two pages + 28 px gap + caption row, the translation-line control hidden — with NO translated raster in the seed, so the right page is the **painted** one (translation drawn onto the screenshot) and the note says so.
8. **Painted Translated view**: with the tab gone and no raster, Translated renders the painted page at full opacity, toolbar and Download enabled, and the block area carries painted text pixels.

## When to run

Before pushing any change to `shot.js` (render / annotation / crop / bilingual paths), `shared/shot.js` (geometry helpers, `frameLayout`), `styles/shot.css` (`.stage`, `.annotbar`, `.panel` layout) or `shot.html` (ids). The pure geometry is also unit-tested in `tools/tests/shot.test.mjs`; the harness covers the wiring on the live page.
