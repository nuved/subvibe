# Shot editor — the pro pass

Date: 2026-09-02 · Status: built on branch `shot-pro-editor` under default-plus-veto
(operator asked for continued design work on Shot while away; every item here
is reversible on the branch). Builds on
`2026-08-24-shot-translate-design.md` and PR #52 (toolbar reachability, Crop).

## What the current editor gets wrong

Seen on the seeded preview (`tools/tests/shot-harness/preview.html`, real
`shot.html` at 1440×900):

1. The toolbar is a row of Unicode glyphs: ✕ ✎ ▬ 🖍 T ↗ ▭ ⛶ ↶ 🗑. The emoji
   render in colour on macOS, the ✕ for "Select" reads as "close", and none of
   it matches the stroke icons the popup uses.
2. "Move / select" doesn't move or select anything — it only stops drawing.
   The only way to remove one wrong stroke is Undo (last only) or Clear all.
3. No way to hide a name, an email or a face before sharing. Every pro
   screenshot tool has blur; ours ships shots of real pages.
4. One frame look. The gradient card is nice, but it's the only option and
   there's no "browser window" framing, which is the look people expect when
   sharing a page shot.
5. Export (the page's end goal) sits below the fold at 900 px; the Text list
   pushes Download/Copy off screen.
6. Sentence pairing over-splits abbreviations and German ordinal dates:
   "Dr. Anna Meier …" becomes the pair "Dr." + "Anna Meier …";
   "2. September" becomes "2." + "September". (Operator-reported follow-up.)
7. The second line of a bilingual pair has one fixed size and tone;
   the operator asked for a quieter / bigger option.

## Decisions

### Toolbar

- Stroke SVG icons (24-grid, 1.8 stroke, the popup's icon dialect), 32 px
  targets, tooltips carry the hotkey: Select `V`, Pen `P`, Highlighter `H`,
  Text `T`, Arrow `A`, Rectangle `R`, Blur `B`, Number `N`, Crop `C`,
  Undo `⌘Z`, Esc returns to Select. Hotkeys are ignored while a text field
  has focus (translation edits, the text-annotation input, language search).
- **Select is real.** Click an annotation to select it (dashed box), drag to
  move it, `Delete`/`Backspace` removes it, Esc deselects. Hit-testing and
  moving are pure functions in `shared/shot.js` (`annBounds`, `hitAnnot`,
  `moveAnnot`), unit-tested. Blur regions and number badges are selectable
  like every other annotation.
- **Blur** = pixelate a dragged rectangle. Stored as `{tool:"blur", a, b}` in
  full-image fractions like Rect. Rendered FIRST (under every other
  annotation) by sampling the image already on the canvas — the on-screen
  overlay samples the stage canvas, the export samples its own canvas — so
  it works without a source tab and on every view. Block size ≈ 1.4 % of the
  image width, never below 6 px, so the effect survives ½ exports.
- **Number badges** = step markers. Click places a filled circle with the
  next number (1, 2, 3 …), colour = the current swatch, size follows the
  thickness slider. Numbers renumber in document order after a delete, so
  removing "2" turns "3" into "2".
- Clear all keeps its confirm (destructive; doctrine §15). Undo stays
  last-only; selection + Delete covers the "one wrong stroke" case.
- **Marks stay on the view they were drawn on.** Each new mark records its
  surface (`on`: `translated` / `original` / `bi-card` / `bi-notes` /
  `bi-pages`); only the current surface's marks render, and Undo, Clear,
  Select and the number sequence act on those alone. The reading card, the
  notes sheet and the two-page picture have different geometry, so a mark
  placed on one would land somewhere meaningless on another (seen on the
  preview: an arrow over the headline reappeared across a margin note).
  Marks saved before this rule carry no `on` and show everywhere, as before.

### Frame

- Style: **Plain · Card · Window.** Window = Card plus a 36 px title bar on
  the image: three dots, the page host centred in a soft address pill, the
  image below with only the bottom corners rounded. Geometry lives in
  `S.frameLayout({frame: "window"})` (pure, tested; returns `bar`); painting
  in `shot.js` (`paintBg` / `paintPaper` / `paintBar` / `paintBadge`, shared
  by every view).
- **Background** swatches for Card/Window: Sunset (today's warm gradient,
  default), Ocean (teal→blue), Ember (coral→amber), Meadow (green→teal),
  Stone (neutral), Ink (dark). Hidden on Plain. Persisted with the frame
  under `chrome.storage.local.shotFrame = {frame, badge, bg}`; unknown
  values fall back to Sunset so older prefs still load.
- Badge switch unchanged.

### Panel

- Order stays View → Frame → Font → Text, but **Export becomes a sticky
  footer**: size/format row, Download (primary), Copy · Share, the filename
  note, and Delete as a quiet danger link. The Text list scrolls in the
  middle; Download is always one click away.

### Bilingual card

- **Translation line** control next to Pairing: **Quiet · Balanced · Equal.**
  Quiet = 0.85× the original size, 70 % ink; Balanced = today's 15.5/17
  (default); Equal = same size, full ink. Saved under `shotBiStyle`.
- `splitSentences` keeps a period attached when the token before it is a
  known abbreviation (`Dr.`, `Prof.`, `Mr.`, `Mrs.`, `Ms.`, `St.`, `Nr.`,
  `ca.`, `bzw.`, `z.B.`, `u.a.`, `vs.`, `e.g.`, `i.e.`, `p.m.`, month
  names …), a single letter (initials: `J. K. Rowling`), or a 1–2 digit
  number (`2. September`). Four-digit years, `etc.`, `usw.` and tokens that
  are also words (`may`, `so`) still end a sentence. `?` and `!` always end.
  The old match-based regex also silently dropped the text before any
  inner dot ("Das gilt z.B. für" lost "Das gilt z."); the splitter is now a
  split, never a match, so no text can vanish.

### Bilingual on the page (operator suggestion, 2026-09-02)

Two layouts next to the reading card, under "On the page":

- **Notes** — the original page as captured, plus a margin column (42 % of
  the page width, 220–360 px) where each text block's translation sits as a
  numbered note level with its block; a note is pushed down only when the
  previous one is in the way (`S.layoutNotes`, greedy). Coral number badges
  mark the block on the page and the note in the margin. Needs no source
  tab (the original raster always exists; translation comes from the
  blocks). The Translation-line control sets the note size. Crop applies to
  the page part. This is the study-sheet the operator described: "the
  translated sentence as a hint written in the free space, like a note".
- **Side by side** — the original page and the translated page in one
  framed picture, tops aligned, a 28 px gap, a small language caption above
  each page (card/window only), one badge. Needs the translated raster: if
  it's missing and the source tab is open, the editor renders it first and
  comes back (`resumeView`); if the tab is gone, the reading card shows with
  a note saying to open the tab and pick Translated once.
- Follow-up, not built: notes whose content is a **same-language
  paraphrase** (learn the language with itself) — needs the Simplify
  pipeline per block; the Notes renderer takes its text from the block, so
  the source is swappable.

## Not doing

- Per-shot pairing default (the global default is enough until asked again).
- Zoom / fit controls: the browser's zoom and `max-width: 100%` still cover it.
- Layer ordering or multi-select of annotations.
- A Shots gallery in the Library (own spec).
- Gaussian blur (pixelate is cheaper, reads as deliberate, and can't be
  reversed by sharpening the way a light blur can).

## Verification

- `node --test tools/tests/shot.test.mjs`: `splitSentences` abbreviation
  cases, `frameLayout` with `chrome`, `annBounds` / `hitAnnot` / `moveAnnot`.
- `tools/tests/shot-harness/harness.html` (real `shot.js`): the PR #52 checks
  plus: select-drag moves a rect and persists; Delete removes the selected
  annotation; a blur region changes the overlay pixels under it; number
  badges increment and renumber; Window frame adds the bar height; the
  Export footer is visible at 900 px without scrolling the panel; Notes =
  page + 220 px column; Side by side = two pages + gap. PASS 18/18.
- `tools/tests/shot-harness/preview.html` seeds a realistic German→Persian
  shot for screenshots; `chrome-stub.js` lets the real `shot.html` run from
  `file://`.
- ux-golden-rules table on the editor at 1440×900 and 390×844.
