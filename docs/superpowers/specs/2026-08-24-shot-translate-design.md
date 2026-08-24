# Shot — pro screenshots with the page translated, on any site

Date: 2026-08-24 · Status: approved direction (operator chose approach 1 and the
three-step split); this document is step 1. Mock: `docs/superpowers/mocks/2026-08-24-shot-editor.html` (published: https://claude.ai/code/artifact/9c90ec4b-99fb-4c42-a44d-3f439f9794db).

## Goal

A pro screenshot tool inside SubVibe: capture the visible area, the full page,
a dragged region, or one picked element of any web page, and get the picture
back **with the page's text in the user's target language**, laid out by the
site itself. The shot opens in a SubVibe editor tab where the user can switch
Translated / Bilingual / Original, fix a translation and re-shoot, put a clean
frame around it, then download, copy, or share it. Shots are kept on the
device so they can be reopened later and used for learning or sharing.

Steps after this one (own spec each): **step 2** learning layer (click a word
in the text panel → word card → Leitner; Paraphrase per block via the Simplify
path); **step 3** editor tools (crop, arrows, boxes, highlight, blur, free
text) and a Shots gallery in the Library; **step 4** Books: named
collections of shots (a shot can sit in several books), a book view in the
Library with page order, and "Export book as PDF" (one page per shot, title
page, choice of view per page; PDF generation without dependencies is the
open design question: a print-styled `book.html` + the browser's Save as PDF,
or a minimal hand-written PDF writer embedding JPEG pages).

## Approach (decided)

**Translate the page, then shoot.** The injected script collects the text
blocks inside the capture area straight from the DOM, background translates
them with the user's provider, the script swaps the translated text into the
live page for the duration of the capture, the tab is captured, and the
original text is restored. The browser does all layout: the site's fonts and
wrapping, right-to-left for Persian/Arabic/Hebrew/Urdu, natural reflow in
bilingual mode. No painted-over rectangles, no text fitting, no vision model.

Rejected: shoot once and paint translations on a canvas (visible patches on
non-flat backgrounds, system fonts, shrink-to-fit); vision OCR (rough boxes).
Text inside images, canvases and video frames is out of scope for v1 (it
stays as it is in the shot).

## User flow

1. Entry, all three grant `activeTab` on that tab and nothing else:
   - Right-click anywhere → **Screenshot with SubVibe ▸** Visible area · Full
     page · Select area · Pick element.
   - Popup: a "Screenshot this page" row with the same four choices; the popup
     closes itself so it doesn't sit over the picker.
   - Keyboard: one command, `Alt+Shift+S` (suggested) = Select area.
2. Picker (injected on demand, closed shadow root, `z-index` max):
   - **Select area**: dimmed page, crosshair, drag a rectangle; size label
     follows the cursor; Esc cancels. Release = capture.
   - **Pick element**: hovering outlines the element under the cursor with its
     tag + size label; click = capture that element's box; Esc cancels.
   - **Visible area**: no picker, immediate.
   - **Full page**: no picker, immediate; a small progress pill
     ("Shooting 3/9…") shows while tiles are captured.
3. During capture the page text inside the area flips to the target language
   for roughly a second (bilingual mode: the translation appears under each
   paragraph), then flips back. A toast on the page says "Shot saved — opening
   editor…". Nothing else is left on the page.
4. The editor tab (`shot.html?id=…`) opens active with the shot.
5. Editor: view toggle (Translated · Bilingual · Original), frame options,
   text panel with editable translations + "Apply & re-shoot", export
   (Download PNG · Copy · Share), recent-shots strip, delete.

## Architecture

### Files

- `content/shot-capture.js` (new, on-demand only) + `styles/shot-capture.css`
  (fetched and inlined like `reader.css`; add to `web_accessible_resources`
  with `use_dynamic_url`): picker UI, text-block collection, swap/restore,
  tile loop, re-shoot.
- `shared/shot.js` (new, pure, `globalThis.SV_SHOT`, node-tested): tile
  planning, crop/stitch geometry, block prep and caps, translation mapping,
  bilingual rule, RTL table, frame layout, export filename, record validation.
- `background.js`: menu + command + popup entry → `startShot`; handlers
  `SHOT_TRANSLATE`, `SHOT_TILE`, `SHOT_COMPOSE`, `SHOT_GET`, `SHOT_LIST`,
  `SHOT_UPDATE`, `SHOT_DELETE`, `SHOT_RESHOOT`; IndexedDB `shots` store
  (`copilot-subs` v3 → v4); OffscreenCanvas compositing; spend log.
- `shot.html`, `shot.js`, `styles/shot.css` (new extension page; links
  `styles/tokens.css`, `styles/components.css`, `shared/theme.js`,
  `shared/langs.js`, `shared/shot.js`).
- `popup.html`/`popup.js`: the Screenshot row (ids covered by
  `tools/tests/popup-ids.test.mjs`).
- `manifest.json`: `commands` key; context-menu items are created in
  background; `web_accessible_resources` entry for `styles/shot-capture.css`.
  No new permissions beyond what exists (`activeTab`, `scripting`,
  `contextMenus`, `storage`, `unlimitedStorage`). No new host permissions.
- `build.sh`: add `shared/shot.js` to the Firefox event-page `scripts` list.

### Capture pipeline (background orchestrates, content script does page work)

```
entry(tabId, mode) ─▶ inject content/shot-capture.js (guard window.__svShot)
                  ─▶ tabs.sendMessage SV_SHOT_START {mode, layout, target}
content: pick rect ─▶ collect blocks in rect ─▶ SHOT_TRANSLATE {blocks, url, title}
background: detect source lang, translateAll(lines, source, target) ─▶ {tr[]}
content: capture pass A (original) ─▶ swap(layout) ─▶ capture pass B ─▶ restore
         each pass = for tile in planTiles(): scroll, settle, SHOT_TILE ─▶ dataUrl
background: SHOT_COMPOSE {rect, dpr, tilesA, tilesB, blocks, meta}
            ─▶ OffscreenCanvas crop+stitch ─▶ two PNG blobs ─▶ IndexedDB shots
            ─▶ tabs.create shot.html?id=…
```

- Rect is in document CSS px (`{x, y, w, h}`); tiles are captured at
  `devicePixelRatio`; compositing multiplies by `dpr`.
- `captureVisibleTab` is limited to 2 calls/second in Chrome (trained
  memory; the plan verifies against current docs): the tile loop waits
  ≥ 550 ms between captures and retries once after 700 ms on a quota error.
- Full page: `planTiles(docH, viewportH, maxTiles = 25)` returns scroll
  offsets, last tile aligned to the document bottom (overlap allowed; the
  stitcher draws the last tile's unique slice only). Pages taller than 25
  viewports are cut at 25 with `truncated: "height"` shown in the editor.
  `position: fixed` and `sticky` elements are hidden (`visibility: hidden`,
  restored after) for every tile after the first so headers don't repeat.
  Scroll position is restored at the end. Settle per tile: two
  `requestAnimationFrame`s + 150 ms.
- Element mode with an element taller than the viewport uses the same tile
  loop limited to the element's rect.
- Passes are kept minimal because `captureVisibleTab` is rate-limited (2/s)
  and flaky in bulk. A shot that fits ONE viewport captures two passes (the
  original and the chosen layout) so Original↔Translated toggles instantly for
  one extra capture. A MULTI-TILE shot (full page, tall element) captures only
  the chosen layout (`shotLayout` in `chrome.storage.local`, `"translated"`
  default, `"bilingual"` the other); its Original and other views are rendered
  on demand by re-shoot, halving captures on the fragile path. Each
  `captureVisibleTab` is raced against a 5 s timeout so one wedged tile aborts
  the shot cleanly instead of freezing the overlay.

### Text blocks (content script)

- Walk text nodes under `document.body` with a `TreeWalker`; skip `script`,
  `style`, `noscript`, `template`, `textarea`, `input`, `select`,
  `[contenteditable]`, SubVibe's own hosts, and nodes whose ancestors have
  `display:none`, `visibility:hidden`, or `opacity:0`.
- Group nodes by their nearest ancestor whose computed `display` is not
  `inline`, `inline-*`, or `contents` (the block ancestor). One block = one
  translation unit.
- Block record: `{ id, text, rect }` where `text` is the joined, whitespace-
  normalised text of its nodes and `rect` the union of the nodes' client
  rects converted to document coordinates. Keep blocks whose rect intersects
  the capture rect and whose text has ≥ 2 characters including a letter.
- Caps (`SV_SHOT.prepBlocks`): 400 blocks and 20 000 characters, document
  order, `truncated: "text"` flagged to the editor. Same block text twice
  (e.g. repeated nav) is translated once and reused.
- Source language: `chrome.i18n.detectLanguage` over the joined text
  (existing `detectClipLang` pattern). If it equals the target, the shot is
  taken original-only with the note "This page is already in {target}".

### Swap and restore

- Translated layout: for each block, the longest text node receives the
  translation, its sibling text nodes in the same block are emptied (inline
  formatting like `<b>` inside a paragraph is lost for the shot; layout is
  kept). Block element gets `dir="auto"` (previous value remembered).
- Bilingual layout: blocks with ≥ 4 words keep the original and get a
  `<span class="sv-shot-tr" dir="auto">` appended after their last text node
  (`display:block; font-size:.92em; opacity:.85; margin-top:.15em`, inherits
  the site's font); blocks under 4 words (nav labels, buttons) are replaced in
  place as in Translated layout.
- Before capture the swap is verified: ≥ 90 % of blocks must still hold the
  translation (node connected and text matches). Otherwise swap once more;
  if still failing, capture anyway with `partial: true` ("Some text couldn't
  be swapped on this page" in the editor).
- Restore runs in `finally`: original text back, spans removed, `dir`
  restored, fixed/sticky visibility restored, scroll restored. A node the site
  already replaced is skipped.

### Storage

IndexedDB `copilot-subs`, version 4, new store `shots` keyed by `id`
(`Date.now().toString(36) + random`). Record (validated by
`SV_SHOT.validateRecord` on read):

```
{ id, ts, url, title, host, source, target, mode, layout, dpr,
  w, h,                       // CSS px of the shot
  original: Blob | null,   // null on multi-tile shots (rendered via re-shoot)
  variant: Blob (image/png),   // the chosen layout — always present
  rect: {x,y,w,h},   // document-space rect the shot covers (re-shoot needs it)
  blocks: [{ id, text, tr, rect }],
  partial: bool, truncated: "" | "text" | "height", tabId, windowId }
```

`tabId` + `url` let re-shoot find the source tab; both are informational and
never trusted for anything else. No cap on the number of shots in v1
(`unlimitedStorage` is already declared); delete is per shot in the editor.

### Editor (`shot.html`)

- Header: SubVibe wordmark, page title (link to `url`), `{source} → {target}`
  chip, timestamp, recent-shots strip (last 12 thumbnails, click to open).
- Stage: the framed image, rendered on a `<canvas>` at shot resolution,
  displayed to fit; zoom is the browser's.
- Side panel:
  - **View**: Translated · Bilingual · Original. The two captured views switch
    instantly; the missing one shows "Re-shoot to render this view" with a
    button (needs the source tab).
  - **Frame**: Plain · Card. Card = padding 48 px, warm Daylight gradient
    background, 16 px radius, raised shadow, optional badge
    `SubVibe · DE → FA` bottom-right (on by default). Options persist in
    `chrome.storage.local` under `shotFrame`.
  - **Text**: one row per block, original above, translation in an editable
    field below, RTL-aware. Edits mark the shot dirty; **Apply & re-shoot**
    sends `SHOT_RESHOOT`. If the source tab is gone or navigated away the
    button is disabled with "Original tab was closed — take a new shot to
    re-render".
  - **Export**: Size (Native = the capture's device pixels · 2× · 1× · ½,
    where 1× = CSS pixels) and Format (PNG · JPEG 90 %), both persisted under
    `shotExport` in `chrome.storage.local`; Download (filename
    `subvibe-{host}-{yyyyMMdd-HHmm}-{view}[-{size}].png|.jpg`), Copy
    (`ClipboardItem` image/png, always PNG at the chosen size), Share (only
    when `navigator.canShare({ files })` is true, else hidden), Delete shot.
    Size and format apply to the framed image; the stored blobs never change.
- Theme follows `uiTheme` like the Library.

### Re-shoot

`SHOT_RESHOOT { id, layout, blocks: [{ id, tr }] }` → background loads the
record, checks `tabs.get(tabId)` exists and its URL equals `record.url`,
re-injects `content/shot-capture.js` (the `activeTab` grant survives until
navigation) and sends `SV_SHOT_RESHOOT { rect, layout, blocks }`; the script
re-collects blocks by id (text match; blocks that no longer exist are
skipped and reported), swaps, captures one pass, restores. Background
recomposes, stores the new variant and layout, and replies; the editor
reloads the record. Re-shoot never re-translates: it uses the edited strings.

### Errors (never silent)

| Case | Where | Message |
|---|---|---|
| No API key | picker toast | "No API key set — open the SubVibe popup to add one." |
| No target language | picker toast | "Pick your language in the SubVibe popup first." |
| Restricted page (chrome://, Web Store, PDF viewer) | action badge `!` | "SubVibe: can't run on this page" (same as Simplify) |
| Translation failed (network/HTTP) | picker toast with two buttons | "Translation failed." Retry · Shoot without translation (original-only shot is still saved) |
| Capture quota / tile failure | picker | one retry, then "Capture failed — try a smaller area." |
| Page already in target | editor note | "This page is already in {target}." |
| Swap partial | editor note | "Some text couldn't be swapped on this page." |
| Re-shoot, tab gone | editor | button disabled + note |

### Spend log

One `logCall` record per translation: `{ site: "shot", kind: "shot", title,
lines: blocks.length, provider, model, inTok, outTok, cacheR, cacheW, ok }`
so the Library's Activity view and `spendToday` count it.

## Privacy

Nothing runs on any page until the user picks a menu item, popup button or
shortcut; `activeTab` scopes the grant to that tab. Page text goes only to
the user's own provider, as subtitles already do. Shots never leave the
device except through the user's own Download / Copy / Share action.
`PRIVACY.md` gets one paragraph saying exactly this.

## Not doing in step 1 (YAGNI)

- No crop/annotate/blur tools, no Library gallery (step 3).
- No word cards, no Paraphrase, no Leitner hookup (step 2).
- No text inside images/video/canvas (no vision).
- No per-block re-translation with a different model; no glossary.
- No Firefox-specific work beyond the `build.sh` script list; Share is hidden
  where `canShare` is absent.
- No sync, no cloud, no server.

## Testing

- Pure (`tools/tests/shot.test.mjs`): `planTiles` (short page = 1 tile; exact
  multiple; remainder aligns last tile to bottom; cap at 25), `cropRect` /
  `stitchLayout` with `dpr` 1 and 2, `prepBlocks` (dedupe, letter rule, both
  caps and their `truncated` flags), `mapTranslations` (alignment with
  missing lines), `isBilingualBlock` (word count rule), `isRtl` (fa, ar, he,
  ur true; de false), `frameLayout` geometry, `filename` (host sanitised,
  view and size suffix, extension by format), `validateRecord` (rejects missing blobs / wrong types).
- `popup-ids.test.mjs` covers the new popup ids automatically.
- Manual acceptance (Chrome, unpacked): Spiegel article — Select area over two
  paragraphs → Persian, right-to-left correct, site font kept; switch to
  Bilingual → re-shoot renders; Full page on a ~10-screen Wikipedia article —
  sticky header appears once, scroll restored, editor shows the whole page;
  Pick element on a tweet; YouTube watch page — title/description translated,
  the video frame unchanged; edit one translation → Apply & re-shoot; Download,
  Copy (paste into a chat), Share (macOS share sheet); no key → toast;
  chrome://extensions → badge; close the source tab → re-shoot disabled with
  note; Firefox build loads and Select area works (`bash build.sh --firefox`).
