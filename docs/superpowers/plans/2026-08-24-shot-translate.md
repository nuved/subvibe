# Shot (translated screenshots) — step 1 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Before marking any task done, run the adversarial-verify skill on its diff.

**Goal:** Capture the visible area, the full page, a dragged region, or a picked element of any page with the page's text translated into the user's target language by the page itself, open it in a SubVibe editor tab (Translated / Bilingual / Original, editable translations with re-shoot, Plain/Card frame, Download / Copy / Share), and keep shots on the device.

**Architecture:** Context menu, popup row and one keyboard command all grant `activeTab`; background injects `content/shot-capture.js` on demand. The content script picks the rect, collects DOM text blocks, asks background to translate (`translateAll`, the subtitle pipeline), swaps translations into the live page, drives a scroll-and-capture tile loop where **background** calls `captureVisibleTab` and keeps the tiles, then restores the page. Background stitches tiles with `OffscreenCanvas`, stores two PNG blobs plus the block list in IndexedDB (`copilot-subs` v4, store `shots`), and opens `shot.html?id=…`. The editor reads IndexedDB directly and asks background for re-shoots.

**Tech Stack:** Chrome MV3, vanilla JS, no build step; `node --test` for the pure module.

## Global constraints

- Spec: `docs/superpowers/specs/2026-08-24-shot-translate-design.md` — where this plan and the spec disagree, the spec wins; where the mock (`docs/superpowers/mocks/2026-08-24-shot-editor.html`) and the spec disagree, the spec wins.
- No new `permissions` or `host_permissions`. Only a `commands` key and one `web_accessible_resources` entry are added to the manifest. If a step seems to need another permission, stop and ask.
- Nothing is injected into any page before the user picks a mode.
- Shared pure modules use the repo pattern `(function (g) { … g.SV_SHOT = {…}; })(globalThis);` and have no `chrome.*` or DOM access.
- Validation after every task: `node --test tools/tests/*.test.mjs` (164 tests pass at the start) and `bash build.sh && bash build.sh --firefox && rm -f subvibe-*.zip`.
- Never delete, skip, weaken or narrow an existing test to pass. Don't refactor unrelated code. No dependencies. Don't bump `manifest.json` version (release is the operator's step).
- Commits: author `Novid <support@nimanou.com>`, plain messages, no AI trailers. One commit per task, on branch `shot-translate` off `main`.
- Progress log for resumers: `.superpowers/sdd/2026-08-24-shot/progress.md` (git-ignored dev state; keep it current: task, decision, dead ends).

## Message contracts (single source of truth)

Background ↔ content script (`chrome.tabs.sendMessage` / `chrome.runtime.sendMessage`):

| Message | Direction | Payload → reply |
|---|---|---|
| `SV_SHOT_START` | bg → cs | `{ mode: "visible"\|"full"\|"area"\|"element", layout: "translated"\|"bilingual", target, targetName }` → `{ ok:true }` (sync) |
| `SHOT_BEGIN` | cs → bg | `{ url, title, mode, layout, rect:{x,y,w,h}, dpr, scrollX, viewport:{w,h}, docH }` → `{ ok, id }` (creates the session keyed by `sender.tab.id`) |
| `SHOT_TRANSLATE` | cs → bg | `{ lines: string[] }` → `{ ok:true, source, target, tr: string[] }` · `{ ok:true, sameLang:true, source }` · `{ ok:false, error: "no-key"\|"no-target"\|"network"\|"http-NNN" }` |
| `SHOT_TILE` | cs → bg | `{ pass: "original"\|"variant", index, scrollY }` → `{ ok }` · `{ ok:false, error:"capture" }` (bg captures and keeps the data URL; the tile never travels to the page) |
| `SHOT_COMPOSE` | cs → bg | `{ blocks:[{id,text,tr,rect}], partial, truncated, passes:["original","variant"] }` → `{ ok, id }` after the record is stored and the editor tab opened |
| `SHOT_ABORT` | cs → bg | `{}` → `{ ok }` (drops the session) |
| `SV_SHOT_RESHOOT` | bg → cs | `{ rect, layout, blocks:[{id,text,tr}], scrollX }` → `{ ok, partial, missing }` (async) |

Editor / popup ↔ background:

| Message | Direction | Payload → reply |
|---|---|---|
| `SHOT_START` | popup → bg | `{ mode }` → `{ ok }` · `{ ok:false, error:"no-tab"\|"inject" }` (bg resolves the active tab) |
| `SHOT_RESHOOT` | editor → bg | `{ id, layout, blocks:[{id,tr}] }` → `{ ok }` · `{ ok:false, error:"tab-gone"\|"inject"\|"capture" }` |

The editor reads and writes the `shots` store itself (blobs can't cross runtime messages).

Record shape (store `shots`, key `id`):

```
{ id, ts, url, title, host, source, target, mode, layout, dpr, w, h,
  original: Blob, variant: Blob, blocks:[{ id, text, tr, rect:{x,y,w,h} }],
  partial: false, truncated: "" | "text" | "height", tabId, windowId }
```

---

### Task 0: Verify platform assumptions (no code)

- [ ] Confirm from current Chrome extension docs: `tabs.captureVisibleTab` works under `activeTab` alone; its per-second quota (`MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`, believed to be 2) and the error text when exceeded; `activeTab` is granted by `commands` shortcuts and context-menu clicks; `contextMenus.create` supports `parentId`; `OffscreenCanvas`, `createImageBitmap` and `Blob` storage in IndexedDB work in an MV3 service worker.
- [ ] Write findings (with the doc URLs) at the top of the progress log. If any assumption fails, stop and report before Task 3.

### Task 1: `shared/shot.js` — pure helpers (TDD)

**Files:** create `shared/shot.js`, `tools/tests/shot.test.mjs`.

**Interfaces** (`globalThis.SV_SHOT`):

- `MAX_BLOCKS = 400`, `MAX_CHARS = 20000`, `MAX_TILES = 25`, `MIN_WORDS_BILINGUAL = 4`, `CAPTURE_GAP_MS = 550`.
- `planTiles(top, bottom, viewportH, maxScroll, maxTiles = MAX_TILES)` → `{ offsets: number[], truncated: boolean }`. Offsets are `scrollY` values whose `[o, o+viewportH)` windows cover `[top, bottom)`: start at `clamp(top)`, step `viewportH`, and if the last window would overshoot, replace it with `clamp(bottom - viewportH)` so the final tile is bottom-aligned (overlap allowed). Clamp to `[0, maxScroll]`, dedupe, sort. `truncated` when more than `maxTiles` windows were needed (offsets cut to `maxTiles`).
- `stitchLayout(rect, offsets, viewport, scrollX, dpr)` → `{ width, height, ops: [{ i, sx, sy, sw, sh, dx, dy }] }` in device pixels. Canvas size is `rect.w×dpr` by `rect.h×dpr`. For tile `i` at `offsets[i]`, the doc range `[o, o+viewport.h)` is intersected with `[rect.y, rect.y+rect.h)` and with "not yet drawn" (`drawnUntil` advances so overlapping tiles never repaint), giving `y0..y1`; `sx = (rect.x - scrollX)×dpr`, `sy = (y0 - o)×dpr`, `sw = min(rect.w, viewport.w - (rect.x - scrollX))×dpr`, `sh = (y1 - y0)×dpr`, `dx = 0`, `dy = (y0 - rect.y)×dpr`. Tiles with empty intersection produce no op.
- `prepBlocks(raw, caps?)` → `{ keep: [{id,text,rect}], lines: string[], lineOf: number[], truncated: ""|"text" }`. Normalises whitespace (`\s+` → space, trim), drops texts shorter than 2 chars or without a letter (`/\p{L}/u`), keeps document order, dedupes identical texts into `lines` (`lineOf[i]` indexes `lines`), stops at `MAX_BLOCKS` or when the summed `lines` length would exceed `MAX_CHARS` (`truncated: "text"`).
- `mapTranslations(keep, lineOf, tr)` → `{ blocks: [{id,text,tr,rect}], missing }` — `tr[lineOf[i]]` or `""` when absent/empty (counted in `missing`).
- `isBilingualBlock(text)` → words (split on whitespace) `>= MIN_WORDS_BILINGUAL`.
- `isRtl(lang)` → true for `ar fa he ur ps sd ug yi dv ckb`, false otherwise (base code before `-`).
- `frameLayout({ w, h, frame: "plain"|"card", pad = 48, radius = 16, badge = true, dpr = 1 })` → `{ width, height, img: {x,y,w,h,radius}, badge: {x,y,h,padX}|null }` in device pixels; plain = no padding, no radius, no badge.
- `filename({ host, ts, view, size = "native", format = "png" })` → `subvibe-{host}-{yyyyMMdd-HHmm}-{view}[-{size}].{png|jpg}`; host lower-cased, `www.` stripped, every run of non `[a-z0-9]` → `-`, trimmed of `-`; the size suffix is omitted for `"native"` (`"2x"`, `"1x"`, `"half"` otherwise); extension `jpg` for `"jpeg"`; time is local time of `ts`.
- `exportScale(size, dpr)` → the multiplier applied to the framed canvas: `native` → 1, `2x` → 2 / dpr, `1x` → 1 / dpr, `half` → 0.5 / dpr.
- `validateRecord(rec)` → the record or throws `Error("bad-record")`: required strings `id url title host target mode layout`, numbers `ts dpr w h` (> 0 for `dpr w h`), `original` and `variant` instances of `Blob`, `blocks` an array whose items have string `id`, `text`, `tr` and a numeric `rect`.
- `newId()` → `Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)`.

- [ ] Write `tools/tests/shot.test.mjs` first, mirroring `simplify.test.mjs` style (`import "../../shared/shot.js"`, `globalThis.SV_SHOT`). Cases: `planTiles` short range (1 tile, no scroll beyond clamp), exact multiple, remainder → bottom-aligned last offset, clamp to `maxScroll`, cap at 25 with `truncated`; `stitchLayout` single tile crop at dpr 1 and 2, two tiles with overlap (second op starts at `drawnUntil`), rect wider than viewport clips `sw`; `prepBlocks` whitespace normalisation, letter rule (`"42"` dropped, `"4a"` kept), dedupe, both caps; `mapTranslations` missing lines; `isBilingualBlock` (3 words false, 4 true); `isRtl`; `frameLayout` plain vs card sizes and badge presence; `filename` (`www.spiegel.de` → `spiegel-de`, time formatting with a fixed `ts`, no suffix for native, `-2x` + `.jpg` for 2× JPEG); `exportScale` for dpr 1 and 2; `validateRecord` accepts a good record built with `new Blob()` and rejects a missing blob / non-array blocks.
- [ ] Run `node --test tools/tests/shot.test.mjs` — it must fail (module missing).
- [ ] Implement `shared/shot.js`; run until green; run the full suite.
- [ ] Commit: `Shot: shared pure helpers (tiles, stitch, blocks, frame, filename) with tests`.

### Task 2: Manifest and build wiring

**Files:** modify `manifest.json`, `build.sh`.

- [ ] `manifest.json`: add
  ```json
  "commands": { "sv-shot-area": { "suggested_key": { "default": "Alt+Shift+S" }, "description": "SubVibe: screenshot an area of this page, translated" } }
  ```
  and a `web_accessible_resources` entry `{ "resources": ["styles/shot-capture.css"], "matches": ["<all_urls>"], "use_dynamic_url": true }` (same shape as the `reader.css` entry; merge into that entry rather than duplicating it).
- [ ] `build.sh`: add `"shared/shot.js"` to the Firefox event-page `scripts` list (before `background.js`).
- [ ] `background.js` top: extend the guarded `importScripts` list with `shared/shot.js` (find the existing call that loads `shared/simplify.js`).
- [ ] Validate: suite + both builds. Commit: `Shot: manifest command, CSS resource, Firefox script list`.

### Task 3: Background — storage, entry points, session, compose

**Files:** modify `background.js`.

**3a · IndexedDB v4**
- [ ] Bump `indexedDB.open("copilot-subs", 4)` and add `if (!d.objectStoreNames.contains("shots")) d.createObjectStore("shots");` in `onupgradeneeded` (existing stores untouched). Add `shotPut(rec)`, `shotGet(id)`, `shotDelete(id)` helpers next to `idbGet`.

**3b · Entry points**
- [ ] In the `onInstalled` menu block, after `svSimplify`, create parent `svShot` (`title: "Screenshot with SubVibe"`, `contexts: ["all"]`) and children `svShotVisible` "Visible area", `svShotFull` "Full page", `svShotArea` "Select area", `svShotElement` "Pick element" (`parentId: "svShot"`, `contexts: ["all"]`).
- [ ] Extend `chrome.contextMenus.onClicked` to route the four ids to `startShot(tab, mode)`; add `chrome.commands.onCommand` (`"sv-shot-area"` → active tab of `currentWindow` → `startShot(tab, "area")`); add message case `SHOT_START` (popup) resolving the active tab the same way.
- [ ] `startShot(tab, mode)`: clear the badge, `executeScript({ files: ["content/shot-capture.js"] })` (badge `!` + title "SubVibe: can't run on this page" on failure, exactly like Simplify), read `shotLayout` (default `"translated"`) and `targets[0]` from storage, `tabs.sendMessage(tab.id, { type: "SV_SHOT_START", mode, layout, target, targetName })` where `targetName` comes from the `SV_LANGS`-equivalent name table already used in background (or the code itself when no table is reachable from the worker — check what `translateAll`'s prompt uses and match it).

**3c · Session and handlers**
- [ ] `const shotSessions = new Map()` keyed by tab id: `{ id, windowId, url, title, mode, layout, target, source, rect, dpr, scrollX, viewport, docH, tiles: { original: [], variant: [] }, startedAt }`. Sessions older than 3 minutes are dropped on the next `SHOT_BEGIN`.
- [ ] `SHOT_BEGIN`: create the session (`id = SV_SHOT.newId()`), reply `{ ok, id }`.
- [ ] `SHOT_TRANSLATE`: key check like `simplifyText` (`no-key`); `targets[0]` missing → `no-target`; `detectClipLang`-style detection over `lines.join("\n")`; if detected equals target → `{ ok:true, sameLang:true, source }`; else `translateAll(lines, source, target, null)` → reply `{ ok:true, source, target, tr: out }`; `logCall({ ts, site: "shot", kind: "shot", title: session.title, lines: lines.length, provider, model, inTok, outTok, cacheR, cacheW, ok })`; errors map to `network` / `http-NNN` as in `simplifyText`.
- [ ] `SHOT_TILE`: throttle with a module-level `lastCaptureAt` so consecutive calls are ≥ `SV_SHOT.CAPTURE_GAP_MS` apart; `chrome.tabs.captureVisibleTab(session.windowId, { format: "png" })`; on a quota error wait 700 ms and retry once; store `{ dataUrl, scrollY }` at `tiles[pass][index]`; reply `{ ok }`.
- [ ] `SHOT_COMPOSE`: for each pass, `stitchLayout` → `OffscreenCanvas(width, height)` → `drawImage(await createImageBitmap(await (await fetch(dataUrl)).blob()), sx, sy, sw, sh, dx, dy, sw, sh)` → `convertToBlob({ type: "image/png" })`; build the record (validate with `SV_SHOT.validateRecord`), `shotPut`, delete the session, `chrome.tabs.create({ url: chrome.runtime.getURL("shot.html?id=" + id) })`, reply `{ ok, id }`. When `passes` is `["original"]` only (same-language or "shoot without translation"), `variant` is the same blob and `layout` is `"original"`.
- [ ] `SHOT_ABORT`: drop the session.
- [ ] `SHOT_RESHOOT` (editor): `shotGet(id)`; `tabs.get(rec.tabId)` must exist with `url === rec.url` else `tab-gone`; recreate a session from the record with `tiles.variant = []`; `executeScript` the capture script (already-injected guard makes this a no-op) else `inject`; `tabs.sendMessage(SV_SHOT_RESHOOT { rect, layout, blocks: merged tr, scrollX })`; on `{ ok }` compose the variant pass only, update `rec.variant`, `rec.layout`, `rec.blocks[].tr`, `rec.partial`, `shotPut`, reply `{ ok }`.
- [ ] Validate: suite + builds; load unpacked and confirm the context-menu tree appears and the command shows in `chrome://extensions/shortcuts`. Commit: `Shot: background entry points, session handlers, IndexedDB shots store, compose`.

### Task 4: `content/shot-capture.js` + `styles/shot-capture.css`

**Files:** create both. Guard `window.__svShot`; one `onMessage` listener; everything inside a closed shadow root host `div.sv-shot-host` (`position:fixed; inset:0; z-index:2147483647`); CSS fetched and inlined exactly like `reader.js` does for `reader.css`.

**4a · Overlay and pickers**
- [ ] `SV_SHOT_START`: reply `{ ok:true }` synchronously, then run `pick(mode)`:
  - `visible` → rect = current viewport in doc coords.
  - `full` → rect = `{ x: 0, y: 0, w: docW (clamped to viewport width), h: docH }`.
  - `area` → dim overlay + crosshair lines following the pointer + drag rectangle with a size label; `mouseup` with `w,h ≥ 8` resolves; Esc rejects. Pointer events are captured on the host so page handlers never fire.
  - `element` → the overlay is `pointer-events:none` except for a transparent full-size catcher; on `mousemove` use `elementFromPoint` (with the host temporarily `pointer-events:none`) and draw a coral outline box + `tag · w × h` label; click resolves that element's doc rect; Esc rejects.
  - All modes then remove the picker chrome (keep the host for the progress pill and toasts).
- [ ] Toast helper (bottom-centre pill, auto-hides after 2.5 s) and error toast with buttons (`Retry`, `Shoot without translation`).

**4b · Blocks, swap, restore**
- [ ] `collectBlocks(rect)` per spec: `TreeWalker` over text nodes, skip list, hidden-ancestor check (cache per element), block ancestor = nearest ancestor whose computed `display` isn't `inline`/`inline-*`/`contents`; group nodes per ancestor; `rect` = union of `Range.getClientRects()` shifted by `scrollX/scrollY`; keep intersecting blocks. Assign `id = "b" + index` in document order. Keep a side map `id → { el, nodes }`.
- [ ] `swap(layout, blocks, target)`: translated → longest node gets `tr`, siblings emptied, `el.setAttribute("dir", "auto")` (remember prior); bilingual → `isBilingualBlock(text)` ? append `<span class="sv-shot-tr" dir="auto">` styled inline (`display:block;font-size:.92em;opacity:.85;margin-top:.15em`) : replace as translated. `verifySwap()` returns the fraction of blocks whose translated text is still connected; < 0.9 → swap again once; still < 0.9 → `partial = true`.
- [ ] `restore()` in `finally`: original `data` back into every remembered node, spans removed, `dir` restored/removed, fixed/sticky visibility restored, `window.scrollTo(savedX, savedY)`.

**4c · Tile loop**
- [ ] `shootPass(pass, rect)`: if the rect fits inside the current viewport, one tile at the current `scrollY` (no scrolling). Otherwise `SV_SHOT.planTiles(rect.y, rect.y + rect.h, innerHeight, docH - innerHeight)`; before tile ≥ 1, hide `position: fixed|sticky` elements (single `querySelectorAll("*")` scan, `setProperty("visibility","hidden","important")`, remembered for restore); per tile: `scrollTo(scrollX, offset)`, two `requestAnimationFrame`s + 150 ms, `SHOT_TILE { pass, index, scrollY: window.scrollY }` (use the *actual* `scrollY` after scrolling; pass it on to background so `stitchLayout` uses real offsets), progress pill "Shooting i / n…" for n > 1. Any `{ ok:false }` → one retry of that tile, then abort with the capture error toast + `SHOT_ABORT`.
- [ ] Main flow: `SHOT_BEGIN` → `collectBlocks` + `SV_SHOT.prepBlocks` → `SHOT_TRANSLATE(lines)` → (`sameLang` or "shoot without translation" → passes `["original"]`) → `shootPass("original")` → `swap` → `shootPass("variant")` → `restore` → `SHOT_COMPOSE` → toast "Shot saved — opening editor…". Errors from translate show the error toast; `Retry` re-sends `SHOT_TRANSLATE`; Esc during any stage aborts and restores.
- [ ] `SV_SHOT_RESHOOT`: `collectBlocks(rect)` again, match incoming blocks by `id` **and** equal `text` (unmatched → `missing`), swap with the provided `tr`, `shootPass("variant")`, restore, reply `{ ok, partial, missing }`.
- [ ] Manual check on a long article (area over two paragraphs, full page ~10 screens, element on a tweet): page text flips and returns, nothing left in the DOM afterwards (`document.querySelector(".sv-shot-host")` is null, no `sv-shot-tr` spans, scroll restored). Commit: `Shot: on-demand capture script — pickers, DOM text swap, tile loop, re-shoot`.

### Task 5: Editor page `shot.html` / `shot.js` / `styles/shot.css`

**Files:** create the three; modify `tools/tests/design-pages.test.mjs` (`PAGES` gains `"shot.html"`).

- [ ] `shot.html`: links `styles/tokens.css`, `styles/components.css`, `styles/shot.css`; scripts `shared/theme.js`, `shared/langs.js`, `shared/shot.js`, `shot.js`; Baloo 2 `@font-face` block copied from `library.html` for the wordmark. Layout per the mock: header (wordmark + "Shot", page title link, `SRC → TGT` chip, meta, recent strip), stage (`<canvas id="stage">` in a dotted well), side panel groups View / Frame / Text / Export / Delete with the ids `viewSeg`, `frameSeg`, `badgeSw`, `blocks`, `reshootBtn`, `reshootNote`, `sizeSel`, `fmtSel`, `dlBtn`, `copyBtn`, `shareBtn`, `delBtn`, `recent`, `noteBar`.
- [ ] `shot.js`: read `id` from the query string; open `indexedDB.open("copilot-subs")` (no version, as `shared/export.js` does) and load the record (`validateRecord`); list the last 12 records by `ts` for the strip. Render: `createImageBitmap(blob)` for the chosen view (`original` → `rec.original`; `rec.layout` → `rec.variant`; the third view shows the note "Re-shoot to render this view" and enables the re-shoot button with that layout); `drawFramed(canvas, bitmap, frameOpts)` using `SV_SHOT.frameLayout` (gradient from `--frame-*` colours read via `getComputedStyle`, rounded clip, shadow via `ctx.shadowBlur`, badge text `SUBVIBE · DE → FA` in the mono stack). Frame options persist under `shotFrame` in `chrome.storage.local`.
- [ ] Text panel: one row per block (`.o` original, `.t` `contenteditable` translation with `dir="auto"`), edits mark the row and enable `reshootBtn` with the count note; `reshootBtn` sends `SHOT_RESHOOT { id, layout, blocks:[{id,tr}] }`, disables itself with "Re-shooting…", then reloads the record; `tab-gone` → button disabled + note "Original tab was closed — take a new shot to re-render".
- [ ] Export controls: `sizeSel` (Native · 2× · 1× · ½) and `fmtSel` (PNG · JPEG), persisted under `shotExport`; the export canvas is the framed canvas redrawn at `SV_SHOT.exportScale(size, rec.dpr)` (never upscaled beyond native: `2×` on a dpr-1 capture is drawn at 2× from the bitmap and noted as "upscaled").
- [ ] Export: `dlBtn` → export canvas `toBlob(type, 0.9 for JPEG)` → object URL → `<a download="{SV_SHOT.filename(...)}">`; `copyBtn` → `navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])` with a "Copied" toast; `shareBtn` hidden unless `navigator.canShare && navigator.canShare({ files: [file] })`, then `navigator.share({ files: [file], title })`; `delBtn` → confirm → delete from the store → go to the newest remaining shot or show the empty state ("No shots yet — right-click any page → Screenshot with SubVibe").
- [ ] Notes bar shows `partial`, `truncated: "text"`, `truncated: "height"`, and the same-language note.
- [ ] Empty/loading/error states: skeleton while the bitmap decodes; "This shot no longer exists" for a bad id.
- [ ] Validate: suite (design-pages now covers `shot.html`), builds; open a real shot, toggle views, edit + re-shoot, download, copy, share on macOS, delete. Commit: `Shot: editor page — views, frame, text panel with re-shoot, export`.

### Task 6: Popup row, docs

**Files:** modify `popup.html`, `popup.js`, `README.md`, `PRIVACY.md`.

- [ ] `popup.html`: a `<section id="shotRow">` immediately before `<section class="bottombar">` (outside the panes): title "Screenshot this page, translated", shortcut hint, four chip buttons `shotVisible`, `shotFull`, `shotArea`, `shotElement` (inline SVG icons as in the mock). Styles in the popup's existing stylesheet block using Daylight tokens.
- [ ] `popup.js`: click → `chrome.runtime.sendMessage({ type: "SHOT_START", mode })` then `window.close()`; on `{ ok:false, error:"inject" }` show the status line "Can't run on this page" instead of closing.
- [ ] `README.md` Features: one bullet "Translated screenshots — visible area, full page, a dragged region or one element of any page, with the page's text in your language; edit, frame, download, copy, share." `PRIVACY.md` "What is sent to the AI provider": one paragraph per spec §Privacy.
- [ ] Validate (popup-ids test now covers the new ids); commit: `Shot: popup row, README and privacy notes`.

### Task 7: Acceptance and review

- [ ] Run the manual acceptance list from the spec §Testing in Chrome (unpacked) and record each result in the progress log. Firefox: `bash build.sh --firefox`, load temporary add-on, Select area on a DW article.
- [ ] Run the adversarial-verify skill over `git diff main...shot-translate` against the spec; fix findings; re-run suite and builds.
- [ ] Final commit if fixes were needed: `Shot: review fixes — <what>`. Push the branch and open a PR to `main` titled `Shot: translated screenshots (step 1)` with a body listing the spec, the mock URL, what was tested by hand and what was not.
