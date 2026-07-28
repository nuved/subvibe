# Popup UI Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the SubVibe popup into three workflow tabs (Translate / Dub / Style) with a persistent data strip, honest size labels, info-icon micro-copy, tactile preset cards, and an isolated Usage block — in 9 independently shippable tasks.

**Architecture:** The popup stays a single vanilla `popup.html` (inline CSS) + `popup.js` pair. All JS is element-ID driven (`el(id)`), so restructuring is HTML moves + CSS + a small tab controller; no handler rewiring. Tab choice persists in `chrome.storage.local` under `uiTab`, exactly like the existing `uiFold`.

**Tech Stack:** Vanilla HTML/CSS/JS, Chrome extension MV3 popup, `chrome.storage.local`. No build step, no framework, no new files.

## Where this plan diverges from the review feedback (deliberate)

1. **Size in px → NO. Relative % instead.** The stored size is a *fraction of the video height* (`0.012–0.050`); a px label would be a lie that breaks the moment the video goes fullscreen. We display `100%` = the default (`md` tier, slider 30), range 40%–167%. (The current `lookVal` summary already lies — it says `30px`. Task 1 fixes that too.)
2. **Library as a 4th tab → NO. Persistent bottom row.** The reviewer's own mockup keeps `📚 Library … Open →` as a persistent bottom row. Library is a full page already; the popup entry stays one always-visible click, and the Usage block moves next to it (Task 7).
3. **"Pace" → "Speed" rename → NO.** The on-player dub transport uses "Pace"; renaming only in the popup would desync vocabulary.
4. **The This-video strip stays ABOVE the tabs.** Operator's recorded design principle: *"show the data, fold the set-once config — never hide data behind a click."* Header, scope bar, and the This-video strip are data; they stay visible on every tab.

## Global Constraints

- Files touched: **only `popup.html` and `popup.js`**. No new files, no framework, no build step.
- Popup body width stays **340px**.
- **Never rename or delete an existing element id.** `popup.js` resolves everything via `el(id)`; `pollDub()` runs on a 1.5s interval and writes into `dubStatus`/`dubProg`/`dubNow`/`dubSpend` wherever they live. Hidden panes still receive updates — that's fine and expected.
- Every control persists **immediately** to `chrome.storage.local` (no Save button). New UI state uses the same pattern: tab choice under key `uiTab` (mirrors `uiFold`).
- Stored `size` value stays a fraction of video height — Task 1 changes **display only**.
- Verification: there is no JS test harness for the popup, and `popup.html` cannot run outside an extension context (`chrome.*` is undefined). Per task: `node --check popup.js` (syntax gate) + reload the unpacked extension (`brave://extensions` → ↻ SubVibe) + the task's explicit visual checklist. **Final acceptance gate is the operator's eye test** — that is this repo's recorded standard.
- The operator's daily Brave loads the unpacked extension **from this repo's working tree** — whatever is on disk is what runs after a reload. Only reload at task boundaries; commit each task before starting the next.
- Branch: `popup-ui` **off `dub-mode`** (the dub controls only exist there). PR targets `dub-mode` while draft PR #1 is open; retarget to `main` if #1 merges first.
- Commits: author `Nimanou <support@nimanou.com>` (already configured in this repo). **No `Co-Authored-By` / AI trailers.** Messages in this repo's dialect: one descriptive sentence, no `feat:`/`fix:` prefixes (see `git log --oneline`).

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `popup.html` | Markup + all popup CSS (inline `<style>`) | New CSS blocks (info icons, cards, accordion summaries, tabs, site chips); sections regrouped and wrapped into tab panes |
| `popup.js` | All popup behavior, storage sync | `sizePct()` helper, fold-summary updates, ~15-line tab controller, empty-state chip renderer |

Task order matters: 1–4 are independent quick wins; **5 must precede 6** (Task 6 wraps the section Task 5 creates); 7–9 build on 6.

---

## Phase 1 — Quick wins (no restructure; each shippable alone)

### Task 1: Branch + honest size label (relative %, default = 100%)

**Files:**
- Modify: `popup.js:324-337` (SIZE_TIER block), `popup.js:169` (`lookVal` summary)
- Modify: `popup.html:335` (size slider title)

**Interfaces:**
- Produces: `sizePct(v: number) => string` — slider value → `"100%"`-style label. **Task 5 reuses this exact name.**

- [ ] **Step 1: Create the branch**

```bash
git -C ~/claude/subvibe checkout dub-mode && git checkout -b popup-ui
```

- [ ] **Step 2: Add `sizePct` and use it in both display sites**

In `popup.js`, after the `sliderFromSize` const (line ~325), add:

```js
// Display only — 100% = the default (md tier, slider 30). The stored value
// stays a fraction of video height; px would lie the moment fullscreen hits.
const sizePct = (v) => Math.round((v / SIZE_TIER.md) * 100) + "%";
```

Replace **both** occurrences of:

```js
  el("sizeVal").textContent = (v / 10).toFixed(1) + "%";
```

with:

```js
  el("sizeVal").textContent = sizePct(v);
```

(One is in `setSizeUI`, one in the `sizeRange` input listener.)

- [ ] **Step 3: Fix the lying fold summary**

In `updateFoldSummaries()` replace:

```js
  txt("lookVal", `${el("sizeRange").value}px`);
```

with:

```js
  txt("lookVal", sizePct(+el("sizeRange").value));
```

(`sizePct` is declared later in the file with `const`, but `updateFoldSummaries` is only *called* after the whole script evaluates — no TDZ issue.)

- [ ] **Step 4: Explain the unit on the slider itself**

In `popup.html`, the Size row input becomes:

```html
        <input type="range" id="sizeRange" min="12" max="50" step="1" style="flex:1;"
          title="Relative to the standard subtitle size — scales with the video, so it stays right in fullscreen" />
```

- [ ] **Step 5: Verify**

Run: `node --check popup.js` — Expected: no output.
Reload extension, open popup → Appearance:
- Slider at default (`md`) shows **100%**, not 3.0%.
- Slider at far left shows **40%**, far right **167%**.
- Collapse Appearance → summary shows the same % (not `30px`).

- [ ] **Step 6: Commit**

```bash
git add popup.html popup.js
git commit -m "Size reads as a percentage of normal (100% = default) — the px/%-of-video labels lied"
```

### Task 2: Micro-copy moves into ⓘ info icons

**Files:**
- Modify: `popup.html` (CSS block after `.hint` rule line 36; six label rows; position-tip line)

**Interfaces:**
- Produces: CSS class `.info` — a 14px circled-i with a `title` tooltip. **Tasks 4–5 reuse it.**

- [ ] **Step 1: Add the CSS**

After the `.hint` rule (`popup.html:36`), add:

```css
    .info { display: inline-block; width: 14px; height: 14px; margin-left: 5px; flex: none;
      border: 1px solid var(--border); border-radius: 50%; color: var(--muted);
      font-size: 10px; line-height: 12px; text-align: center; font-weight: 600; cursor: help; }
    .info:hover { color: var(--text); border-color: var(--muted); }
```

- [ ] **Step 2: Replace the six parenthetical hints**

Each `<span class="info" …>` sits **outside** the `<label for=…>` so clicking the icon never toggles the switch. Exact replacements:

`showOriginal` row:
```html
        <label for="showOriginal">Also show the original line</label>
        <span class="info" title="Dual subtitles — the original sits right above the translation">i</span>
```

`karaokeHl` row:
```html
        <label for="karaokeHl">Highlight spoken words</label>
        <span class="info" title="Karaoke-style sweep across each word as it is spoken">i</span>
```

`keepNames` row:
```html
        <label for="keepNames">Keep names &amp; brands untranslated</label>
        <span class="info" title="Never transliterated — MySQL stays MySQL, Skyler stays Skyler">i</span>
```

`hideNative` row:
```html
        <label for="hideNative">Hide the site's own captions</label>
        <span class="info" title="Prevents doubled subtitles when the site shows its own">i</span>
```

`dubMultiVoice` row:
```html
        <label for="dubMultiVoice">Multi-voice</label>
        <span class="info" title="Beta — a different voice per speaker (OpenAI voices only)">i</span>
```

Dub section header — replace:
```html
    <div class="lbl">Dub <span class="hint">speak the translation · original stays quiet under it</span></div>
```
with:
```html
    <div class="lbl"><span>Dub <span class="info" title="Speaks the translation aloud — the original soundtrack stays quiet underneath">i</span></span></div>
```

- [ ] **Step 3: Fold the drag tip into the Position row**

Delete the full-width tip line:
```html
      <div class="hint" style="margin-top:7px;">Tip: drag each subtitle line on the video to place it — the original and translation can sit apart.</div>
```
and add an info icon at the end of the Position row (after the `</select>`):
```html
        <span class="info" title="You can also drag each subtitle line on the video — original and translation can sit apart">i</span>
```

- [ ] **Step 4: Verify**

Reload, open popup:
- No parenthesized grey text remains on toggle rows; each has a small ⓘ whose hover tooltip shows the old copy.
- Clicking an ⓘ does **not** flip its toggle.
- Under Gemini TTS the Multi-voice row still greys out with its "OpenAI voices only for now" title (set by `updateTtsProviderUI` — unchanged).

- [ ] **Step 5: Commit**

```bash
git add popup.html
git commit -m "Toggle micro-copy moves into hoverable info icons — rows read as one line each"
```

### Task 3: Preset tiles become tactile cards; fold summaries read as buttons (CSS only)

**Files:**
- Modify: `popup.html:105-111` (`.presets` rules), `popup.html:116-118` (`details.customize` rules)

- [ ] **Step 1: Card-ify the preset tiles**

Replace the `.presets` block (lines 105–111) with:

```css
    .presets { display: flex; gap: 6px; overflow-x: auto; padding: 2px 0 5px; scrollbar-width: thin; }
    .presets button { flex: none; width: 64px; padding: 8px 0 6px; background: var(--panel2);
      border: 1px solid transparent; border-radius: 10px; box-shadow: 0 1px 2px rgba(0,0,0,.35);
      display: flex; flex-direction: column; align-items: center; gap: 4px; }
    .presets button:hover { background: #1b2330; border-color: var(--border); }
    .presets button .abc { font-size: 13px; line-height: 1.25; padding: 1px 6px; border-radius: 4px; }
    .presets button .pname { font-size: 9.5px; color: var(--muted); font-weight: 500; }
    .presets button.on { border-color: var(--accent); background: #14233c; }
    .presets button.on .pname { color: var(--accent); }
```

- [ ] **Step 2: Make every `details.customize` summary a visible control**

Replace lines 116–118:

```css
    details.customize { border-top: 0; margin-top: 10px; }
    details.customize summary { padding: 2px 0; font-size: 12px; color: var(--muted); }
    details.customize summary::after { float: none; margin-left: 6px; }
```

with:

```css
    details.customize { border-top: 0; margin-top: 10px; }
    details.customize > summary { display: flex; align-items: center; gap: 7px; padding: 8px 10px;
      background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
      font-size: 12.5px; color: #cdd6e3; }
    details.customize > summary:hover { background: var(--panel2); }
    details.customize > summary::after { content: "▸"; float: none; margin-left: auto; color: var(--muted); }
    details.customize[open] > summary::after { content: "▾"; }
    details.customize > summary .hint { font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

(This styles ALL folds — engine, keys, voice, subtitle options, appearance, timing, and the nested Customize — as consistent accordion buttons. The generic `summary` rules at lines 126–130 stay for safety but are overridden by these more specific selectors.)

- [ ] **Step 3: Verify**

Reload, open popup:
- Preset tiles look like raised cards; hover lifts them; active one has the blue ring; row still scrolls horizontally.
- Every fold summary (Translation engine, API keys, Voice & pace, Subtitle options, Appearance, Timing, nested Customize) renders as a bordered clickable row with a right-aligned chevron that flips ▸/▾.
- Long summary values (Claude label, key dots) ellipsize instead of wrapping.
- Folds still remember open/closed state across popup reopens (`uiFold` untouched).

- [ ] **Step 4: Commit**

```bash
git add popup.html
git commit -m "Preset tiles read as cards and every fold summary reads as a button, not stray text"
```

### Task 4: "Voice & pace" gets a labeled Engine row

**Files:**
- Modify: `popup.html:293-297` (ttsProvider select)

- [ ] **Step 1: Give the TTS engine select the same labeled-row shape as Voice/Original/Pace**

Replace:

```html
      <select id="ttsProvider" style="margin-top:7px;">
        <option value="openai">OpenAI gpt-4o-mini-tts</option>
        <option value="gemini">Gemini 2.5 Flash TTS (native Persian voices)</option>
      </select>
      <div id="ttsProviderWarn" class="selwarn" hidden></div>
```

with:

```html
      <div class="row" style="margin-top:7px;">
        <span style="min-width:58px; color:var(--muted);">Engine</span>
        <select id="ttsProvider" style="flex:1;">
          <option value="openai">OpenAI gpt-4o-mini-tts</option>
          <option value="gemini">Gemini 2.5 Flash TTS (native Persian voices)</option>
        </select>
      </div>
      <div id="ttsProviderWarn" class="selwarn" hidden></div>
```

(`rebuildEngineSelect` repopulates the options at load; only the wrapper changes. The single select under "Translation engine" keeps full width — a label would be redundant under its own titled fold.)

- [ ] **Step 2: Verify**

Reload: Voice & pace fold now reads Engine / Voice / Original / Pace as four aligned rows; switching Engine still swaps the Voice dropdown and disables Multi-voice under Gemini; the missing-key warning still appears below the row.

- [ ] **Step 3: Commit**

```bash
git add popup.html
git commit -m "TTS engine gets a labeled row like Voice and Pace — the bare dropdown was unlabeled"
```

---

## Phase 2 — Structure: semantic regroup, then tabs

### Task 5: Split "Subtitle options" — translation knobs vs display toggles

Keep-names/glossary are *translation* behavior; dual-line and karaoke are *display*. This split is what makes clean tabs possible.

**Files:**
- Modify: `popup.html:264-282` (subsFold section), `popup.html:363-377` (lookFold tail)
- Modify: `popup.js:144` (FOLD_IDS), `popup.js:160-171` (updateFoldSummaries)

**Interfaces:**
- Consumes: `sizePct` from Task 1, `.info` from Task 2.
- Produces: fold id `transFold`, summary span id `transVal`. **Task 6 wraps this section into the Translate pane.**

- [ ] **Step 1: Rebuild the section as "Translation options"**

Replace the whole `<!-- Subtitle options -->` section with:

```html
  <!-- Translation options -->
  <section>
    <details class="customize" id="transFold">
      <summary>Translation options <span class="hint" id="transVal"></span></summary>
      <div class="row" style="margin-top:7px;">
        <label class="switch"><input type="checkbox" id="keepNames" /><span class="slider"></span></label>
        <label for="keepNames">Keep names &amp; brands untranslated</label>
        <span class="info" title="Never transliterated — MySQL stays MySQL, Skyler stays Skyler">i</span>
      </div>
      <input type="text" id="keepTerms" placeholder="Extra specific terms (optional): Skyler, Wharton…" autocomplete="off" spellcheck="false" style="margin-top:8px;" />
    </details>
  </section>
```

- [ ] **Step 2: Move the two display toggles into Appearance**

Inside `lookFold`, directly after the `hideNative` row, add:

```html
      <div class="row">
        <label class="switch"><input type="checkbox" id="showOriginal" /><span class="slider"></span></label>
        <label for="showOriginal">Also show the original line</label>
        <span class="info" title="Dual subtitles — the original sits right above the translation">i</span>
      </div>
      <div class="row">
        <label class="switch"><input type="checkbox" id="karaokeHl" /><span class="slider"></span></label>
        <label for="karaokeHl">Highlight spoken words</label>
        <span class="info" title="Karaoke-style sweep across each word as it is spoken">i</span>
      </div>
```

(Handlers don't care where the elements live: `showOriginal` stays per-clip via `saveSetting`, `karaokeHl` stays global via `persist` — unchanged in JS.)

- [ ] **Step 3: Update FOLD_IDS and summaries in popup.js**

```js
const FOLD_IDS = ["keysDetails", "engineFold", "voiceFold", "transFold", "lookFold", "timeFold"];
```

(A stale `subsFold` key in stored `uiFold` is harmless — `initFolds` skips ids it can't find.)

In `updateFoldSummaries()`, replace the `subsVal` and `lookVal` lines with:

```js
  txt("transVal", [el("keepNames").checked ? "keep names" : "",
                   el("keepTerms").value.trim() ? "glossary" : ""].filter(Boolean).join(" · ") || "defaults");
  txt("lookVal", [sizePct(+el("sizeRange").value),
                  el("showOriginal").checked ? "dual" : "translation only",
                  el("karaokeHl").checked ? "karaoke" : ""].filter(Boolean).join(" · "));
```

- [ ] **Step 4: Verify**

Run: `node --check popup.js` — Expected: no output.
Reload:
- "Translation options" fold shows keep-names + glossary only; collapsed summary reads e.g. `keep names · glossary`.
- Appearance now holds dual-line + karaoke toggles; collapsed summary reads e.g. `100% · dual · karaoke`.
- Flip each moved toggle → "Saved ✓" flashes; reopen popup → state stuck.

- [ ] **Step 5: Commit**

```bash
git add popup.html popup.js
git commit -m "Subtitle options split by meaning: translation knobs vs display toggles (which join Appearance)"
```

### Task 6: Tab bar — Translate / Dub / Style, persisted like uiFold

**Files:**
- Modify: `popup.html` (CSS + nav + three pane wrappers)
- Modify: `popup.js` (tab controller + init call)

**Interfaces:**
- Consumes: section with `transFold` from Task 5.
- Produces: `#tabBar`, `.pane[data-pane]`, storage key `uiTab`. **Tasks 7–9 assume this layout.**

- [ ] **Step 1: Add tab CSS**

After the `.scopebar` rules, add:

```css
    /* tab bar — three workflows; header, scope bar and This-video stay above all of them */
    .tabs { display: flex; gap: 5px; padding: 10px 14px 0; }
    .tabs .tab { flex: 1; padding: 7px 0; background: var(--panel); border: 1px solid var(--border);
      border-radius: 8px; color: var(--muted); font-weight: 600; font-size: 12px; }
    .tabs .tab:hover { background: var(--panel2); color: var(--text); }
    .tabs .tab.on { background: #14233c; border-color: var(--accent); color: var(--text); }
    .pane > section:first-child { border-top: 0; padding-top: 8px; }
```

- [ ] **Step 2: Insert the nav and wrap the sections**

Directly after the closing `</section>` of the This-video block, insert:

```html
  <nav class="tabs" id="tabBar">
    <button class="tab on" data-tab="translate">Translate</button>
    <button class="tab" data-tab="dub">Dub</button>
    <button class="tab" data-tab="style">Style</button>
  </nav>
```

Then wrap existing sections — moved whole, byte-identical inside:

```html
  <div class="pane" data-pane="translate">
    <!-- (unchanged) section containing #engineFold -->
    <!-- (unchanged) section containing #keysDetails -->
    <!-- (unchanged) Languages section (#chips / #langSearch) -->
    <!-- (unchanged) section containing #transFold  ← from Task 5 -->
  </div>
  <div class="pane" data-pane="dub" hidden>
    <!-- (unchanged) Dub section (#dubEnabled … #dubSpend) -->
  </div>
  <div class="pane" data-pane="style" hidden>
    <!-- (unchanged) Appearance section (#lookFold) -->
    <!-- (unchanged) Timing section (#timeFold) -->
  </div>
```

The Library section, footer, and tribute card stay **outside** the panes (always visible).

- [ ] **Step 3: Add the tab controller to popup.js**

Below `initFolds()`:

```js
// ── tabs: Translate / Dub / Style. Header, scope bar and the This-video strip
// stay visible above whichever tab is open; the choice persists like uiFold.
const TAB_NAMES = ["translate", "dub", "style"];
function selectTab(name) {
  for (const b of el("tabBar").children) b.classList.toggle("on", b.dataset.tab === name);
  for (const p of document.querySelectorAll(".pane")) p.hidden = p.dataset.pane !== name;
}
async function initTabs() {
  const { uiTab } = await chrome.storage.local.get("uiTab");
  if (TAB_NAMES.includes(uiTab)) selectTab(uiTab);
  el("tabBar").addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b) return;
    selectTab(b.dataset.tab);
    chrome.storage.local.set({ uiTab: b.dataset.tab });
  });
}
```

At the file bottom, after `initFolds();` add:

```js
initTabs();
```

- [ ] **Step 4: Verify**

Run: `node --check popup.js` — Expected: no output.
Reload:
- Three tabs under the This-video strip; Translate active by default; switching tabs swaps content with no scroll jumps; popup height shrinks per tab.
- Close popup on Style, reopen → Style is still active (storage `uiTab`).
- On the Dub tab with a video playing, `dubStatus`/progress still update (pollDub is location-agnostic).
- With an empty key: the keys fold auto-opens **inside** the Translate pane; the engine warning still shows. (Known gap: no cross-tab attention badge yet — backlog item B1.)
- Header toggle, scope bar, This-video chips, Library button, footer visible on every tab.

- [ ] **Step 5: Commit**

```bash
git add popup.html popup.js
git commit -m "Popup splits into Translate / Dub / Style tabs; data strip and Library stay always visible"
```

### Task 7: Usage block sits with the Library entry

**Files:**
- Modify: `popup.html` (remove `#dubSpend` from the Dub section; rebuild the Library section)

- [ ] **Step 1: Move the spend line**

Delete from the Dub section:

```html
    <div id="dubSpend" class="hint" style="margin-top:3px; min-height:13px; cursor:pointer;" title="Open the Library → Activity for the full breakdown"></div>
```

Replace the Library section with:

```html
  <!-- Usage + Library -->
  <section>
    <div class="lbl">Usage <span class="hint">estimated</span></div>
    <div id="dubSpend" class="hint" style="min-height:13px; cursor:pointer;" title="Open the Library → Activity for the full breakdown"></div>
    <button class="libbtn" id="openLibrary" style="margin-top:10px;">
      <span class="libico">📚</span>
      <span class="libtxt"><b>Library</b><span class="libsub" id="libCount">…</span></span>
      <span class="libgo">Open →</span>
    </button>
  </section>
```

(No JS change: `refreshSpend()` and the click-to-Library listener resolve `#dubSpend` by id wherever it lives.)

- [ ] **Step 2: Verify**

Reload: `Today ~$… · this video ~$…` now sits in a labeled Usage block above the Library button, visible on every tab; clicking it opens the Library; the Dub tab no longer shows a floating cost line.

- [ ] **Step 3: Commit**

```bash
git add popup.html
git commit -m "Spend line stops floating in the dub controls — Usage block lives beside the Library entry"
```

---

## Phase 3 — States

### Task 8: Empty state shows supported-site chips (and stops omitting Udemy)

**Files:**
- Modify: `popup.html` (chips CSS)
- Modify: `popup.js:641-646` (empty-state branch of `loadThisVideo`)

**Interfaces:**
- Produces: `.sites` / `.site` CSS, chip list constant `SUPPORTED_SITES`. **Task 9 adds the light-up.**

- [ ] **Step 1: CSS**

Next to the `.clipcache` rules add:

```css
    .sites { display: flex; flex-wrap: wrap; gap: 5px; width: 100%; }
    .site { padding: 2px 8px; border: 1px solid var(--border); border-radius: 12px;
      font-size: 11px; color: var(--muted); background: var(--panel); }
```

- [ ] **Step 2: Replace the sentence with chips**

Near the top of `popup.js` (after `CLIP_FIELDS`), add — this list mirrors `manifest.json` `content_scripts` matches; update both together:

```js
const SUPPORTED_SITES = ["YouTube", "Netflix", "Prime Video", "ZDF", "DW", "Udemy"];
```

In `loadThisVideo()`, replace:

```js
  if (!clipBase) {
    box.className = "clipcache muted";
    box.textContent = "Open a YouTube, Netflix, Prime Video, ZDF or DW video to translate it.";
    el("clipExports").hidden = true;
    return;
  }
```

with:

```js
  if (!clipBase) {
    box.className = "clipcache muted";
    box.innerHTML = "";
    const msg = document.createElement("div");
    msg.style.width = "100%";
    msg.textContent = "No video detected — open one on a supported site:";
    box.appendChild(msg);
    const sites = document.createElement("div");
    sites.className = "sites";
    for (const s of SUPPORTED_SITES) {
      const c = document.createElement("span");
      c.className = "site";
      c.textContent = s;
      sites.appendChild(c);
    }
    box.appendChild(sites);
    el("clipExports").hidden = true;
    return;
  }
```

- [ ] **Step 3: Verify**

Run: `node --check popup.js` — Expected: no output.
Reload, open popup on a non-video tab (e.g. brave://newtab): message line + six muted chips including **Udemy** (the old sentence omitted it despite manifest support). On a video tab the cached-language chips render exactly as before.

- [ ] **Step 4: Commit**

```bash
git add popup.html popup.js
git commit -m "Empty state lists supported sites as chips — and finally admits Udemy is one of them"
```

### Task 9: The active site's chip lights up

**Files:**
- Modify: `popup.html` (`.site.on` rule)
- Modify: `popup.js` (host matcher + highlight in the empty-state branch)

- [ ] **Step 1: CSS**

```css
    .site.on { color: var(--text); border-color: var(--accent); background: #14233c; }
```

- [ ] **Step 2: Match the active tab's hostname**

Replace the Task 8 `SUPPORTED_SITES` constant with name+pattern pairs (still mirrors the manifest):

```js
const SUPPORTED_SITES = [
  ["YouTube", /(^|\.)youtube\.com$/],
  ["Netflix", /(^|\.)netflix\.com$/],
  ["Prime Video", /(^|\.)(primevideo\.com|amazon\.de)$/],
  ["ZDF", /(^|\.)zdf\.de$/],
  ["DW", /(^|\.)dw\.com$/],
  ["Udemy", /(^|\.)udemy\.com$/],
];
async function activeTabHost() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  // tab.url is exposed only where we hold host permissions — i.e. exactly on supported sites.
  try { return tabs[0] && tabs[0].url ? new URL(tabs[0].url).hostname : ""; } catch { return ""; }
}
```

In the empty-state branch, the chip loop becomes:

```js
    const host = await activeTabHost();
    for (const [name, re] of SUPPORTED_SITES) {
      const c = document.createElement("span");
      c.className = "site" + (re.test(host) ? " on" : "");
      c.textContent = name;
      sites.appendChild(c);
    }
```

(`loadThisVideo` is already `async`; the extra await is fine. Guarded by `clipLoadSeq`? Not needed — this branch returns before any other async fill runs.)

- [ ] **Step 3: Verify**

Run: `node --check popup.js` — Expected: no output.
Reload. On a YouTube **home** page (supported site, no video yet): YouTube's chip is lit, others muted. On brave://newtab: none lit. On a playing video: cache chips render, site chips don't appear (unchanged branch).

- [ ] **Step 4: Commit**

```bash
git add popup.html popup.js
git commit -m "The active site's chip lights up in the empty state — you can see SubVibe recognizes the tab"
```

---

## Phase 4 — The standing loop (how the interface keeps getting better)

Not tasks — process. This is the recurring cadence for all future popup/Library UI work:

1. **One phase per session, eye test between phases.** Ship 1–4 tasks, reload in Brave, operator looks at it with a real video (ZDF or YouTube, fa target). Their eye is the gate — no phase starts on top of an unreviewed one.
2. **Before/after screenshots in every PR.** Four canonical popup states: no tab support / supported site no video / video translating / dub generating. Screenshot the states a change touches.
3. **Feedback lands in the backlog table below** (append rows; keep "blocked on" honest). Re-run external UI reviews (like the one that produced this plan) only after a full phase ships — reviewing mid-phase reviews scaffolding.
4. **Copy rules distilled from this round:** every control row is one line; explanation lives in an ⓘ title; data is never behind a click; set-once config is always behind one; a displayed unit must be the truth of what's stored.

### Backlog

| # | Item | Why | Blocked on |
|---|---|---|---|
| B1 | Attention dot on the Translate tab when a key Verify fails / selected engine lacks a key | Keys fold auto-opens invisibly when another tab is active | Task 6 shipped |
| B2 | Real hover popovers (styled, multi-line) replacing `title` tooltips | `title` has OS delay and no formatting | Phase 1 eye test — maybe `title` is enough |
| B3 | Keyboard/a11y pass: tab bar arrow keys, `aria-selected`, focus rings | Popup is mouse-only today | Task 6 shipped |
| B4 | Site chips as favicon-style monogram badges | Text chips are v1; logos raise store/trademark questions — decide deliberately | Task 9 eye test |
| B5 | Firefox popup QA (fold/tab rendering, `details` styling) | Firefox phases B1–B3 from the style-presets plan still pending | AMO track resuming |
| B6 | Library page gets the same card/accordion language | Popup and Library should read as one product | This plan fully shipped |
| B7 | Content-script storage watcher gets a UI-keys ignore list (`uiTab`, `uiFold`) | Every tab click schedules a redundant debounced `start()` in the page; today it no-ops only because the run key dedupes | Touches `content/common.js` — separate branch |
| B8 | Prime Video chip lights on any `www.amazon.de` page, not just `/gp/video/*` | Host permission exposes `tab.url` site-wide, so the chip over-claims recognition on the shopping homepage | Product call at the B4 eye test |
| B9 | Appearance fold mixes per-clip (`showOriginal`) and global (`karaokeHl`, `hideNative`) toggles with no visual distinction | The fold implies uniform scoping; a per-video badge like the scope bar's would be honest | Design idea for B1's attention-dot pass |

## Self-Review (done at write time)

- **Spec coverage:** reviewer point 1 (tabs) → Task 6 (+ divergence note on Library-as-tab); point 2 (labels/micro-copy) → Tasks 2, 4, 5; point 3 (cards, size %, accordion affordance) → Tasks 1, 3; point 4 (usage isolation, static-vs-dynamic empty state) → Tasks 7, 8, 9. "Keep updating" ask → Phase 4 loop + backlog.
- **Placeholders:** none; every step carries its code. The pane-wrap comments in Task 6 Step 2 denote *byte-identical moves* of sections that exist on disk, identified by their unique fold ids.
- **Type consistency:** `sizePct` (Task 1) is the name Task 5 uses; `transFold`/`transVal` consistent across Tasks 5–6; `SUPPORTED_SITES` shape change in Task 9 replaces Task 8's constant in place; `uiTab` naming mirrors `uiFold`.
- **Known interaction:** if Task 2 ships without Task 5, the `showOriginal`/`karaokeHl`/`keepNames` rows carry ⓘ icons that Task 5 then moves — the Task 5 snippets already include the icons, so no drift.
