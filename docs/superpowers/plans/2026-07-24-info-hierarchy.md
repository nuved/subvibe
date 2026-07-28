# Info Hierarchy + Gemini TTS Request Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean saved titles, show per-clip cost/calls/downloads directly on library cards and in the popup (data visible, set-once config folded with persisted state), and stop the Gemini TTS 429 request storm.

**Architecture:** SubVibe is a vanilla-JS MV3 extension with NO build step — the repo files ship as-is (`build.sh` only zips). Shared pure logic lives in `shared/*.js` files that attach a global (`SV_PRICING` pattern) so plain `<script src>` includes, content scripts, and `node:test` all share one source. Extension pages (library, popup) read the worker's IndexedDB directly for bulk audio; all API calls go through `background.js` (service worker), which logs every call to a 300-row ring buffer (`callLog`).

**Tech Stack:** Vanilla JS, Chrome extension MV3, IndexedDB, Web Audio, `node:test` (in `tools/tests/`).

**Spec:** `docs/superpowers/specs/2026-07-24-info-hierarchy-design.md` — read it first.

## Global Constraints

- No build step: never add a bundler/transpiler; new files must be plain JS loaded via `<script src>` or manifest `content_scripts`.
- Shared modules use the IIFE-attach-to-globalThis pattern of `shared/pricing.js` — node-testable without a bundler.
- Title cleanup strips EXACTLY two things: leading `(\d{1,3}) ` (1–3 digits — a "(2024) …" year prefix must survive) and trailing ` - YouTube`. Nothing fuzzier.
- Run span caps: OpenAI stays at the current 20 000 ms / 1 400 ms gap; Gemini gets 28 000 ms / 2 000 ms gap.
- Cooldown fallback when no Retry-After hint: 30 s, doubling per consecutive 429, capped at 5 min.
- All new UI copy matches the existing voice: short, lowercase-friendly, no exclamation marks.
- XSS: titles/URLs come from arbitrary pages — always `textContent`, never `innerHTML`.
- Commit messages follow the repo style (imperative summary line, no AI/co-author trailers), author `Novid <support@nimanou.com>` (already the repo git config).
- **Plan decision beyond the spec (flagged to operator):** the popup's Appearance and Timing sections also become folded groups — same "set-once config folds" principle; their controls are unchanged inside the fold.

---

### Task 1: `shared/title.js` — title cleanup everywhere

**Files:**
- Create: `shared/title.js`
- Test: `tools/tests/title.test.mjs`
- Modify: `manifest.json` (all 6 `content_scripts` blocks), `library.html:154`, `popup.html:393`, `content/common.js:1180,1431,1742`, `content/dub.js:210,617`, `library.js:154,515`

**Interfaces:**
- Produces: global `SV_TITLE.clean(t: string) → string` — used by every later task that touches titles.

- [ ] **Step 1: Write the failing test**

Create `tools/tests/title.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/title.js";

const clean = globalThis.SV_TITLE.clean;

test("strips a tab notification counter and the YouTube suffix", () => {
  assert.equal(clean("(4) Barack Obama | Full Episode - YouTube"), "Barack Obama | Full Episode");
});
test("counter alone is stripped even without the suffix", () => {
  assert.equal(clean("(99) Some clip"), "Some clip");
});
test("a 4-digit '(2024)' year prefix is NOT a counter", () => {
  assert.equal(clean("(2024) Year in review - YouTube"), "(2024) Year in review");
});
test("RTL Persian title with a counter", () => {
  assert.equal(clean("(4) ورزش زبان با shadowing"), "ورزش زبان با shadowing");
});
test("plain titles pass through untouched", () => {
  assert.equal(clean("Deine Liebe, Mein Atem"), "Deine Liebe, Mein Atem");
});
test("counter with nothing after it survives (never clean to empty)", () => {
  assert.equal(clean("(99) "), "(99)");
});
test("null/undefined → empty string", () => {
  assert.equal(clean(null), "");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/tests/title.test.mjs`
Expected: FAIL — `Cannot find module .../shared/title.js`

- [ ] **Step 3: Write the implementation**

Create `shared/title.js`:

```js
// SubVibe — page-title cleanup (pure logic, node-testable).
// Attached to globalThis so <script src> includes, content scripts AND
// node:test share it (same pattern as shared/pricing.js).
(function (g) {
  // "(4) Barack Obama … - YouTube" → "Barack Obama …"
  //  • a leading "(N) " with 1–3 digits is a tab notification counter, never
  //    content — a "(2024) …" year prefix (4 digits) must survive;
  //  • the counter is only stripped when something follows it;
  //  • " - YouTube" at the end is tab-title chrome, not the video's name.
  const clean = (t) => {
    let s = String(t || "");
    const m = /^\(\d{1,3}\) (.+)$/s.exec(s);
    if (m) s = m[1];
    return s.replace(/ - YouTube$/, "").trim();
  };
  g.SV_TITLE = { clean };
})(globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/tests/title.test.mjs`
Expected: PASS, 7/7

- [ ] **Step 5: Load it everywhere titles flow**

`manifest.json`: in EACH of the 6 `content_scripts` blocks (youtube, netflix, zdf, dw, prime, udemy), insert `"shared/title.js"` right after the adapter line, e.g.:

```json
      "js": [
        "content/adapters/youtube.js",
        "shared/title.js",
        "shared/presets.js",
        "shared/voices.js",
        "content/dub.js",
        "content/common.js"
      ],
```

`library.html` — before `shared/langs.js` (line 154): `<script src="shared/title.js"></script>`
`popup.html` — before `shared/langs.js` (line 393): `<script src="shared/title.js"></script>`

- [ ] **Step 6: Clean at capture (content scripts)**

`content/common.js:1180`:

```js
    const pageTitle = SV_TITLE.clean(document.title), pageUrl = location.href;
```

`content/common.js:1431` — in the TRANSLATE send, `title: document.title` → `title: SV_TITLE.clean(document.title)`.

`content/common.js:1742` — GET_CLIP response, `title: document.title` → `title: SV_TITLE.clean(document.title)`.

`content/dub.js:210` (TTS send) and `content/dub.js:617` (generateAll TRANSLATE send): `title: document.title` → `title: SV_TITLE.clean(document.title)`.

- [ ] **Step 7: Clean at display (legacy data)**

`library.js:154` (groupTracks):

```js
    if (!g.title) g.title = window.SV_TITLE.clean(t.title || t.videoId || prettyBase(base));
```

`library.js:515` (activity row):

```js
    s.textContent = (window.SV_TITLE.clean(c.title || "") || (c.site ? siteMeta(c.site).label : "—")) + (c.target ? " → " + langMeta(c.target)[1] : "");
```

- [ ] **Step 8: Verify by loading the extension**

Run: `node --test tools/tests/` (all suites still pass), then reload the unpacked extension at `chrome://extensions` and open the Library.
Expected: every card that previously showed "(4) … - YouTube" now shows the bare video title; Activity rows likewise.

- [ ] **Step 9: Commit**

```bash
git add shared/title.js tools/tests/title.test.mjs manifest.json library.html popup.html content/common.js content/dub.js library.js
git commit -m "Strip YouTube's notification counter and suffix from captured titles"
```

---

### Task 2: Per-clip attribution — `base` in every API-call log row

**Files:**
- Modify: `background.js:611,638`, `content/dub.js:207-210,617`, `content/common.js:1431`, `popup.js:392-414` (refreshSpend)

**Interfaces:**
- Consumes: `SV_TITLE.clean` (Task 1).
- Produces: call-log rows gain `base: "<site>:<clipId>"` (e.g. `"youtube:6y3Uyns1m…"`). Task 4 and Task 5 aggregate on it. Legacy rows have no `base` — every consumer must fall back to cleaned-title matching.

- [ ] **Step 1: Senders include the clip base**

`content/dub.js:207-210` — add `base: hooks.base,` to the TTS message:

```js
      const resp = await send({
        type: "TTS", key: audioKey(run), text: txt,
        voice: run.voice, base: hooks.base,
        instructions: V().ttsInstructions(txt, hooks.target),
        durMs: spanMs(run), site: hooks.site, title: SV_TITLE.clean(document.title), target: hooks.target,
      });
```

`content/dub.js:617` — add `base: hooks.base,` to the TRANSLATE message object.

`content/common.js:1431` — add `base: lastCacheBase,` to the TRANSLATE message object (`lastCacheBase` is the module-level clip base set on attach at line 1179).

- [ ] **Step 2: Worker logs it**

`background.js:611` (TRANSLATE meta) and `background.js:638` (TTS meta) — add `base: msg.base,` to each `meta` object literal. `logCall({ ...meta, … })` then persists it with no further change.

- [ ] **Step 3: Popup spend line prefers base**

`popup.js` refreshSpend (lines 392-414) — replace the matching loop:

```js
  const info = tab ? await chrome.tabs.sendMessage(tab.id, { type: "GET_CLIP" }).catch(() => null) : null;
  const base = info && info.base;
  const title = window.SV_TITLE.clean((info && info.title) || "");

  const res = await chrome.runtime.sendMessage({ type: "LOG_LIST" }).catch(() => null);
  const calls = (res && res.calls) || [];
  const estCost = window.SV_PRICING.estCost;
  const t0 = new Date().setHours(0, 0, 0, 0);
  let today = 0, thisVideo = 0;
  for (const c of calls) {
    if ((c.ts || 0) >= t0) today += estCost(c);
    // exact match on clip base for new rows; cleaned-title match for legacy rows
    const mine = c.base ? c.base === base : (title && window.SV_TITLE.clean(c.title || "") === title);
    if (mine) thisVideo += estCost(c);
  }
  spend.textContent = (base || title)
    ? `Today ~${fmtCost(today)} · this video ~${fmtCost(thisVideo)}`
    : `Today ~${fmtCost(today)}`;
```

- [ ] **Step 4: Verify**

Reload the extension, play a YouTube video with translation on for ~30 s, then in the service-worker console: `(await chrome.storage.local.get("callLog")).callLog.slice(-3)`.
Expected: the newest rows carry `base: "youtube:<id>"` and a cleaned `title`; the popup spend line shows a nonzero "this video" figure.

- [ ] **Step 5: Commit**

```bash
git add background.js content/dub.js content/common.js popup.js
git commit -m "Attribute API-call log rows to their clip via a base id"
```

---

### Task 3: Extract `shared/export.js` (srt/audio export + new stitch-to-blob)

**Files:**
- Create: `shared/export.js`
- Modify: `library.js:11-114` (move code out), `library.html:157` (include)

**Interfaces:**
- Consumes: globals `SV_SRT`, `SV_AUDIO_EXPORT` (existing shared modules).
- Produces: global `SV_EXPORT` with:
  - `audioRows(prefix) → Promise<[{key, b64, ms, …}]>`
  - `trackCues(key) → Promise<cues[]>`
  - `download(name, blobParts, mime)`
  - `safeName(s) → string`
  - `exportSrt(g, target)` — `g` is `{base, title}`
  - `stitchDubBlob(g, target, {interactive}) → Promise<{blob, name, mime} | null>` — null = nothing cached or user declined the gap warning
  - `exportAudio(g, target)` — download wrapper around `stitchDubBlob`

- [ ] **Step 1: Create `shared/export.js`**

Move these from `library.js` VERBATIM (they are lines 13–114: `openDb`, `audioRows`, `trackCues`, `download`, `safeName`, `exportSrt`, `exportAudio`) into this wrapper, then refactor `exportAudio` into `stitchDubBlob` + a thin caller as shown:

```js
// SubVibe — Library/popup export helpers: read the worker's IndexedDB directly
// (same extension origin; bulk audio through base64 messaging would be silly),
// build .srt text and stitch cached dub clips into one audio file. Writes stay
// in the worker. Extension-page-only — NOT a content script.
(function (g) {
  function openDb() { /* moved verbatim from library.js:13-19 */ }
  async function audioRows(prefix) { /* moved verbatim from library.js:20-32 */ }
  async function trackCues(key) { /* moved verbatim from library.js:33-40 */ }
  function download(name, blobParts, mime) { /* moved verbatim from library.js:41-47 */ }
  const safeName = (s) => (s || "subvibe").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80);

  async function exportSrt(gr, target) { /* moved verbatim from library.js:50-54 */ }

  // Stitch every cached clip at its timestamp into ONE audio blob.
  // Ogg/Opus via WebCodecs where available, else WAV (audit forbids an MP3 lib).
  // interactive=false skips the confirm() gap warning (used by the ▶ preview).
  async function stitchDubBlob(gr, target, { interactive = true } = {}) {
    const rows = await audioRows(`${gr.base}:auto:${target}:dub:`);
    if (!rows.length) return null;
    // …body of the old exportAudio (library.js:61-97) moved verbatim UP TO the
    // `const rendered = await off.startRendering();` line, with ONE change:
    // the gap-warning confirm becomes:
    //   if (interactive && pct < 60 && !confirm(`Only ~${pct}% …`)) return null;
    //   (non-interactive callers preview whatever is cached, no prompt)
    const rendered = await off.startRendering();
    const pcm = rendered.getChannelData(0);
    const name = `${safeName(gr.title)} — ${target} dub`;
    if (!haveEncoder) return { blob: new Blob([g.SV_AUDIO_EXPORT.wavFromPcm(pcm, rate)], { type: "audio/wav" }), name: `${name}.wav`, mime: "audio/wav" };
    // …opus encode block moved verbatim from library.js:100-112, then:
    return { blob: new Blob([g.SV_AUDIO_EXPORT.oggFromOpusPackets(packets, { preSkip: 312 })], { type: "audio/ogg" }), name: `${name}.ogg`, mime: "audio/ogg" };
  }

  async function exportAudio(gr, target) {
    const out = await stitchDubBlob(gr, target, { interactive: true });
    if (out === null) return alert("No dub audio cached for this language yet.");
    download(out.name, [out.blob], out.mime);
  }

  g.SV_EXPORT = { audioRows, trackCues, download, safeName, exportSrt, stitchDubBlob, exportAudio };
})(globalThis);
```

Note the ONE behavioral wrinkle: old `exportAudio` alerted on empty AND could silently return on a declined confirm; `stitchDubBlob` returns null for both, and `exportAudio` alerts only for the empty case when `rows.length` was 0 — preserve that by having `stitchDubBlob` return `null` for empty and `false` for "user declined", and `exportAudio` alert only on `null`. Adjust the two `return` sites accordingly (`if (out) download(...)`).

- [ ] **Step 2: library.js consumes it**

Delete `library.js:11-114` (openDb through exportAudio). At the top add:

```js
const { audioRows, trackCues, download, safeName, exportSrt, exportAudio } = window.SV_EXPORT;
```

`library.html` — add before `shared/pricing.js` (line 157): `<script src="shared/export.js"></script>`.

- [ ] **Step 3: Verify no behavior change**

Run: `node --test tools/tests/` (still green — nothing node-tested moved semantics).
Reload extension → Library: `⬇ srt` downloads a valid .srt; `⬇ audio` on a dubbed clip downloads the stitched file exactly as before (spot-play it).

- [ ] **Step 4: Commit**

```bash
git add shared/export.js library.js library.html
git commit -m "Extract srt/audio export into shared/export.js with a stitch-to-blob seam"
```

---

### Task 4: Library card — stat strip, hierarchy, ▶ dub preview

**Files:**
- Modify: `library.js` (card(), refresh path, move `fmtCost` up), `library.html` (CSS in the `<style>` block, lines 57-76 region)

**Interfaces:**
- Consumes: `SV_EXPORT` (Task 3), log rows with `base` (Task 2), `SV_TITLE.clean` (Task 1), `SV_PRICING.estCost`.
- Produces: none consumed later; UI only.

- [ ] **Step 1: Move `fmtCost` to the helpers section**

Cut `const fmtCost = (c) => (c >= 1 ? "$" + c.toFixed(2) : "$" + c.toFixed(4));` from its Activity-section location (library.js:447) and paste it right after `fmtWhen` (library.js:197). (card() will use it; keep one definition.)

- [ ] **Step 2: Aggregate the call log once per refresh**

Add near the data section (after `groupTracks`):

```js
// Per-clip cost/calls from the on-device call log. Exact via row.base for new
// rows; cleaned-title match covers rows logged before base existed. The log is
// a 300-row ring buffer, so these figures mean "recent activity", not lifetime.
let logAgg = { byBase: new Map(), byTitle: new Map() };
async function loadLogAgg() {
  const res = await chrome.runtime.sendMessage({ type: "LOG_LIST" }).catch(() => null);
  const byBase = new Map(), byTitle = new Map();
  for (const c of ((res && res.calls) || [])) {
    const cost = window.SV_PRICING.estCost(c);
    const bump = (map, key) => {
      if (!key) return;
      const a = map.get(key) || { calls: 0, cost: 0 };
      a.calls++; a.cost += cost; map.set(key, a);
    };
    bump(byBase, c.base);
    bump(byTitle, window.SV_TITLE.clean(c.title || ""));
  }
  logAgg = { byBase, byTitle };
}
```

In `refresh()` (the function that calls CACHE_LIST and rebuilds the grid), `await loadLogAgg()` before rendering cards.

- [ ] **Step 3: Card layout — drop the URL line, add the stat strip**

In `card(g)`:
- Delete the `url` div block (library.js:227-234). Keep `ttl.title = g.title;` but extend it: `ttl.title = g.url ? g.title + "\n" + g.url : g.title;` (full URL still discoverable on hover).
- After `c.appendChild(langs);` insert:

```js
  const agg = logAgg.byBase.get(g.base) || logAgg.byTitle.get(g.title);
  const stats = document.createElement("div");
  stats.className = "stats";
  if (agg) stats.textContent = `~${fmtCost(agg.cost)} · ${agg.calls} call${agg.calls === 1 ? "" : "s"}`;
  c.appendChild(stats);
```

- In the per-language `audioRows(...).then((rows) => …)` block, also append cached-audio minutes to the strip:

```js
      const min = Math.round(ms / 60000);
      if (min) stats.textContent += (stats.textContent ? " · " : "") + `${min} min dub audio`;
```

- [ ] **Step 4: Action rows — one loud button, quiet destructive corner**

Still in `card(g)`:
- First foot row keeps `when` + `Open ▶` only — move the `Delete` button OUT of it.
- The export row becomes: per language `⬇ srt · fa`, then (when audio cached) `▶ fa` and `⬇`, then a flex spacer, then quiet `✕ audio` and quiet `Delete`:

```js
  const exp = document.createElement("div");
  exp.className = "foot";
  const spacer = document.createElement("span");
  spacer.style.flex = "1";
  const quiet = []; // appended after the spacer so destructive actions sit far right
  del.classList.add("quiet");         // the existing Delete button, reparented here
  for (const [target] of g.langs) {
    // srt button — unchanged except it stays in this row
    // audio buttons, inside the audioRows(...).then:
    const playBtn = document.createElement("button");
    playBtn.className = "mini";
    playBtn.textContent = `▶ ${target}`;
    playBtn.title = `Play the stitched dub (~${Math.round(ms / 60000)} min cached)`;
    playBtn.onclick = () => playDub(g, target, playBtn);
    const audBtn = document.createElement("button");
    audBtn.className = "mini";
    audBtn.textContent = "⬇";
    audBtn.title = "Download the dub as one audio file";
    audBtn.onclick = () => exportAudio(g, target);
    const rmBtn = document.createElement("button");
    rmBtn.className = "mini quiet";
    rmBtn.textContent = "✕ audio";
    rmBtn.title = "Delete this language's dub audio (keeps the subtitles)";
    // …existing rm handler unchanged; push rmBtn onto `quiet` instead of exp
  }
  exp.appendChild(spacer);
  for (const b of quiet) exp.appendChild(b);
  exp.appendChild(del);
```

(Integrate with the existing async `.then` structure: insert `playBtn`/`audBtn` before the spacer via `exp.insertBefore(playBtn, spacer)`, and push `rmBtn` to the quiet cluster via `exp.insertBefore(rmBtn, del)` — buttons must not jump after the spacer when the async fill lands.)

- [ ] **Step 5: ▶ preview player (one at a time)**

Add at module level:

```js
// One preview at a time; pressing ▶ elsewhere stops the current one. The blob
// is stitched fresh per press (a long video takes a few seconds — acceptable
// v1; the button shows … while stitching).
let dubPreview = null; // { el, url, btn }
async function playDub(g, target, btn) {
  if (dubPreview) {
    const same = dubPreview.btn === btn;
    dubPreview.el.pause();
    URL.revokeObjectURL(dubPreview.url);
    dubPreview.btn.textContent = dubPreview.btn.textContent.replace("⏸", "▶");
    dubPreview = null;
    if (same) return;
  }
  const old = btn.textContent;
  btn.textContent = "…";
  const out = await window.SV_EXPORT.stitchDubBlob(g, target, { interactive: false });
  if (!out) { btn.textContent = old; return alert("No dub audio cached for this language yet."); }
  const url = URL.createObjectURL(out.blob);
  const el = new Audio(url);
  dubPreview = { el, url, btn };
  btn.textContent = old.replace("▶", "⏸");
  el.onended = () => {
    if (dubPreview && dubPreview.el === el) { URL.revokeObjectURL(url); btn.textContent = old; dubPreview = null; }
  };
  el.play();
}
```

- [ ] **Step 6: CSS**

In `library.html`'s `<style>`, after the `.card .langs` rule add / adjust:

```css
    .card .stats { color: var(--muted); font-size: 11px; font-family: ui-monospace, Menlo, Consolas, monospace; min-height: 13px; }
    .card .mini.quiet { background: transparent; border-color: transparent; color: var(--muted); font-size: 11px; padding: 6px 6px; }
    .card .mini.quiet:hover { color: var(--red); background: #3a1d22; }
```

Delete the now-unused `.card .url` rules (lines 63-64).

- [ ] **Step 7: Verify**

Reload → Library. Each card: clean title, no URL line, stat strip with `~$… · N calls` (and `· N min dub audio` on dubbed clips), one bright Open ▶, srt/▶/⬇ buttons, dim ✕ audio + Delete in the far corner. Press ▶: dub audio plays, button flips to ⏸; pressing another card's ▶ stops the first. Delete still works and refreshes.

- [ ] **Step 8: Commit**

```bash
git add library.js library.html
git commit -m "Library card: stat strip, dub preview, one primary action, quiet destructive corner"
```

---

### Task 5: Popup — "This video" strip with stats and downloads, moved to the top

**Files:**
- Modify: `popup.html` (move section, add stat/export nodes, add script includes), `popup.js` (loadThisVideo + refreshSpend paint the new nodes)

**Interfaces:**
- Consumes: `SV_EXPORT` (Task 3), `SV_TITLE.clean`, log `base` rows (Task 2), existing `clipBase` resolution in popup.js.
- Produces: element ids `clipStats`, `clipExports` (used by Task 6's layout only positionally).

- [ ] **Step 1: popup.html — includes and section move**

Add before `<script src="popup.js">`:

```html
  <script src="shared/srt.js"></script>
  <script src="shared/audio-export.js"></script>
  <script src="shared/export.js"></script>
```

Move the whole `<!-- This video -->` section (popup.html:365-369) to directly AFTER the scope bar `</div>` (line 198), and extend it:

```html
  <!-- This video -->
  <section>
    <div class="lbl">This video <button class="linkbtn" id="clearClip" hidden>Clear cache</button></div>
    <div id="clipCache" class="clipcache muted">Loading…</div>
    <div id="clipStats" class="hint" style="margin-top:6px; min-height:13px;"></div>
    <div class="row" id="clipExports" style="flex-wrap:wrap; gap:6px;" hidden></div>
  </section>
```

- [ ] **Step 2: popup.js — stats line rides refreshSpend**

In `refreshSpend()` (already rewritten in Task 2), count calls too and paint `#clipStats`:

```js
  let today = 0, thisVideo = 0, clipCalls = 0;
  for (const c of calls) {
    if ((c.ts || 0) >= t0) today += estCost(c);
    const mine = c.base ? c.base === base : (title && window.SV_TITLE.clean(c.title || "") === title);
    if (mine) { thisVideo += estCost(c); clipCalls++; }
  }
  const stats = el("clipStats");
  if (stats) stats.textContent = (base || title) && clipCalls
    ? `~${fmtCost(thisVideo)} · ${clipCalls} API call${clipCalls === 1 ? "" : "s"} (recent)`
    : "";
```

- [ ] **Step 3: popup.js — export buttons in loadThisVideo()**

`loadThisVideo()` already filters `tracks` to `mine` (rows starting `clipBase + ":auto:"`, popup.js:601). After the existing per-language chip rendering, add:

```js
  const exp = el("clipExports");
  exp.innerHTML = "";
  // title from the cached track rows (in scope here) — NOT from a GET_CLIP
  // `info` variable, which loadThisVideo() does not have
  const gr = { base: clipBase, title: window.SV_TITLE.clean((mine[0] && mine[0].title) || "") || "subvibe" };
  let any = false;
  for (const t of mine) {
    const m = /^.*:auto:([^:]+)$/.exec(t.key);
    if (!m) continue;
    const target = m[1];
    any = true;
    const srtBtn = document.createElement("button");
    srtBtn.className = "btn ghost";
    srtBtn.textContent = `⬇ srt · ${target}`;
    srtBtn.title = "Download the translated subtitles (.srt)";
    srtBtn.onclick = () => window.SV_EXPORT.exportSrt(gr, target);
    exp.appendChild(srtBtn);
    window.SV_EXPORT.audioRows(`${clipBase}:auto:${target}:dub:`).then((rows) => {
      if (!rows.length) return;
      const audBtn = document.createElement("button");
      audBtn.className = "btn ghost";
      audBtn.textContent = `⬇ dub · ${target}`;
      audBtn.title = "Download the dub as one audio file";
      audBtn.onclick = () => window.SV_EXPORT.exportAudio(gr, target);
      exp.appendChild(audBtn);
    });
  }
  exp.hidden = !any;
```

(No ▶ preview in the 340px popup — the Library has it; a popup closes when it loses focus, which would kill playback mid-listen anyway.)

- [ ] **Step 4: Verify**

Open the popup on a translated video: "This video" sits directly under the scope bar showing language chips, `~$… · N API calls (recent)`, and working `⬇ srt` / `⬇ dub` buttons. On a page with no video: section shows its existing empty-state text, no stats, no export row.

- [ ] **Step 5: Commit**

```bash
git add popup.html popup.js
git commit -m "Popup: this-video stats and downloads first, under the scope bar"
```

---

### Task 6: Popup — fold set-once config, persist fold state

**Files:**
- Modify: `popup.html` (wrap sections in `<details>`), `popup.js` (uiFold persistence + summary values)

**Interfaces:**
- Consumes: nothing new.
- Produces: `chrome.storage.local.uiFold` — `{ keysDetails, engineFold, voiceFold, subsFold, lookFold, timeFold: boolean }`.

- [ ] **Step 1: popup.html — wrap the four config sections**

Using the existing `details`/`summary` styling (popup.html:126-130) and the keys row as the model, restructure:

**Engine** (replaces the Translation-engine section body, popup.html:201-208):

```html
  <section>
    <details class="customize" id="engineFold">
      <summary>Translation engine <span class="hint" id="engineVal"></span></summary>
      <select id="translationProvider" style="margin-top:7px;">
        <option value="openai">OpenAI GPT-4o-mini</option>
        <option value="claude">Claude Sonnet 4.6</option>
      </select>
      <div id="translationProviderWarn" class="selwarn" hidden></div>
    </details>
  </section>
```

**Subtitle options** — move the three controls `showOriginal` row, `keepNames` row, `keepTerms` input (popup.html:252-260) out of the Languages section into a new details AFTER it:

```html
  <section>
    <details class="customize" id="subsFold">
      <summary>Subtitle options <span class="hint" id="subsVal"></span></summary>
      <!-- the three moved rows, markup unchanged -->
    </details>
  </section>
```

**Dub voice** — inside the Dub section, keep the `dubEnabled` toggle row, `dubGenAll`, `dubStatus`, `dubProg`, `dubNow`, `dubSpend` OUTSIDE (toggle = per-video decision; the rest is live data), and wrap `ttsProvider`, `ttsProviderWarn`, the Voice row, `dubMultiVoiceRow`, the Original (duck) row, the Pace row in:

```html
    <details class="customize" id="voiceFold">
      <summary>Voice &amp; pace <span class="hint" id="voiceVal"></span></summary>
      <!-- moved controls, markup unchanged -->
    </details>
```

**Appearance** (plan decision — same principle) — wrap the whole Appearance section body (preview strip through hideNative row) in `<details class="customize" id="lookFold">` with `<summary>Appearance <span class="hint" id="lookVal"></span></summary>`. The inner `Customize` details stays nested as-is.

**Timing** — wrap the sync controls in `<details class="customize" id="timeFold">` with `<summary>Subtitle timing <span class="hint" id="timeVal"></span></summary>`.

Remove the now-redundant `.lbl` headers where a summary replaces them.

- [ ] **Step 2: popup.js — persistence + summaries**

Add near the top-level init:

```js
// Folded config remembers how you left it — the panel always reopens the way
// the user arranged it. Keys auto-open-on-attention (hydrateKeys) still wins:
// it sets .open AFTER this runs, and that programmatic toggle is saved too,
// which is fine — after fixing the key the user closes it once.
const FOLD_IDS = ["keysDetails", "engineFold", "voiceFold", "subsFold", "lookFold", "timeFold"];
async function initFolds() {
  const { uiFold } = await chrome.storage.local.get("uiFold");
  const st = uiFold || {};
  for (const id of FOLD_IDS) {
    const d = el(id);
    if (!d) continue;
    if (typeof st[id] === "boolean") d.open = st[id];
    d.addEventListener("toggle", () => {
      const cur = {};
      for (const i of FOLD_IDS) { const x = el(i); if (x) cur[i] = x.open; }
      chrome.storage.local.set({ uiFold: cur });
    });
  }
}

function updateFoldSummaries() {
  const txt = (id, v) => { const n = el(id); if (n) n.textContent = v; };
  const sel = (id) => { const s = el(id); return (s && s.selectedOptions[0] && s.selectedOptions[0].textContent) || ""; };
  txt("engineVal", sel("translationProvider"));
  const gem = el("ttsProvider").value === "gemini";
  txt("voiceVal", sel(gem ? "dubGeminiVoice" : "dubVoice") || sel("ttsProvider"));
  txt("subsVal", [el("showOriginal").checked ? "dual" : "translation only",
                  el("keepNames").checked ? "keep names" : ""].filter(Boolean).join(" · "));
  txt("lookVal", `${el("sizeRange").value}px`);
  txt("timeVal", el("syncVal").textContent);
}
```

Call `initFolds()` once during startup (alongside the existing `load()` call) and `updateFoldSummaries()` at the end of `load()` AND inside the existing 1.5 s `pollDub` tick (same place `maybeRefreshSpend()` is called) — that keeps summaries fresh without touching every change handler.

- [ ] **Step 3: Verify**

Open popup: config sections show one-line summaries with current values (`Claude Sonnet 4.6`, `Marin`, `dual · keep names`, `24px`, `0.00s`). Open Voice & pace, close the popup, reopen → still open. Clear a key → keys row auto-opens regardless of saved state. Change engine → summary updates within ~1.5 s.

- [ ] **Step 4: Commit**

```bash
git add popup.html popup.js
git commit -m "Popup: fold set-once config behind value summaries, remember fold state"
```

---

### Task 7: Worker — 429 cooldown gate for TTS providers

**Files:**
- Modify: `background.js` (`ttsChunk` :489-509, `ttsChunkGemini` :518-552, TTS router case :624-651)

**Interfaces:**
- Consumes: nothing new.
- Produces: TTS error responses may carry `cooldownUntil` (epoch ms). Task 8 reads it. Thrown TTS errors carry `.status` and `.retryAfterMs`.

- [ ] **Step 1: 429 aborts the internal retry loop with a structured error**

In `ttsChunkGemini`, replace the two lines `lastStatus = res.status; lastBody = txt;` + transient check with:

```js
    lastStatus = res.status; lastBody = txt;
    if (res.status === 429) {
      // An RPM window will not clear in this loop's 0.7–1.4 s backoff — stop
      // burning requests and surface how long Google asked us to wait.
      const err = new Error("Gemini TTS 429: rate limited by Gemini");
      err.status = 429;
      const ra = res.headers.get("retry-after");
      if (ra && /^\d+(\.\d+)?$/.test(ra)) err.retryAfterMs = Math.round(+ra * 1000);
      else {
        try {
          const j = JSON.parse(txt);
          const ri = ((j.error && j.error.details) || []).find((d) => String(d["@type"] || "").endsWith("RetryInfo"));
          const m = /^([\d.]+)s$/.exec((ri && ri.retryDelay) || "");
          if (m) err.retryAfterMs = Math.round(+m[1] * 1000);
        } catch {}
      }
      throw err;
    }
    if (!TRANSIENT_HTTP.has(res.status)) break;
```

In `ttsChunk` (OpenAI), after `lastStatus = res.status; lastBody = await res.text();` insert the same shape (message `"OpenAI TTS 429: rate limited by OpenAI"`, Retry-After header only — OpenAI has no RetryInfo body).

- [ ] **Step 2: Cooldown state + gate in the TTS router case**

Above `logCall` (background.js:~560) add:

```js
// TTS rate-limit cooldown, per provider. In-memory only: the worker dying
// forgets it, and the next 429 simply re-arms — never worth persisting.
const ttsCooldownUntil = { openai: 0, gemini: 0 };
const ttsCooldownStreak = { openai: 0, gemini: 0 };
```

In `case "TTS"` after the provider/key resolution and BEFORE `const started = Date.now();`:

```js
          if (Date.now() < (ttsCooldownUntil[provider] || 0)) {
            // Local, instant, unlogged — the whole point is zero network and
            // zero log spam while the provider's window resets.
            sendResponse({ error: "rate-limited — cooling down", cooldownUntil: ttsCooldownUntil[provider] });
            break;
          }
```

Replace the catch block (`background.js:646-649`) with:

```js
          } catch (e) {
            if (e && e.status === 429) {
              const s = ++ttsCooldownStreak[provider];
              const fallback = Math.min(300000, 30000 * 2 ** (s - 1)); // 30s → 60s → … → 5min
              ttsCooldownUntil[provider] = Date.now() + (e.retryAfterMs || fallback);
            }
            await logCall({ ...meta, ms: Date.now() - started, ok: false, err: String((e && e.message) || e) });
            sendResponse({ error: String((e && e.message) || e), cooldownUntil: ttsCooldownUntil[provider] > Date.now() ? ttsCooldownUntil[provider] : undefined });
            break;
          }
```

And in the success path, after `await logCall({ ...meta, … ok: true });` add `ttsCooldownStreak[provider] = 0;`.

(Note the old catch re-threw so the outer catch answered `{error}`; it now responds directly to carry `cooldownUntil` — the `break` replaces the throw.)

- [ ] **Step 3: Verify with a forced 429**

In the service-worker console, monkey-patch fetch to return 429 with a RetryInfo body once, then trigger a dub tick; OR simpler: temporarily set `ttsCooldownUntil.gemini = Date.now() + 60000` and watch the next TTS message get the instant `cooling down` response in the console, with NO new callLog row.
Expected: one 429 arms the cooldown; subsequent TTS messages return instantly with `cooldownUntil`; the Activity log gains only the single real failure.

- [ ] **Step 4: Commit**

```bash
git add background.js
git commit -m "TTS 429s arm a per-provider cooldown honoring the server's retry hint"
```

---

### Task 8: Dub engine — honor cooldown, provider-aware runs and pacing

**Files:**
- Modify: `content/dub.js` (module state ~:10-30, `rebuildRuns` :88-111, `fetchOne` :201-231, `pump` :233-265, `paintTransport` :384-403, `generateAll` :641-645, stale comment :19)

**Interfaces:**
- Consumes: TTS responses with `cooldownUntil` (Task 7).
- Produces: none.

- [ ] **Step 1: Module state + stale comment**

Near the other module `let`s (after line 32) add:

```js
  let cooldownUntil = 0; // epoch ms — the worker said the TTS provider is rate-limited; the pump sleeps until then
  let lastFetchAt = 0;   // pacing: when the last TTS request was launched
```

Fix the comment at line 19: `total span ≤ 12s` → `total span capped per provider (openai 20s, gemini 28s — see rebuildRuns)`.

- [ ] **Step 2: Provider-aware run construction**

In `rebuildRuns()` replace the `canJoin` line (dub.js:100) with:

```js
      // Gemini bills per second of audio, so bigger runs cost the same in
      // fewer requests — that's what its low RPM ceiling actually rations.
      // OpenAI stays at the ear-test-approved caps.
      const gapMax = conf.provider === "gemini" ? 2000 : 1400;
      const runCap = conf.provider === "gemini" ? 28000 : 20000;
      const canJoin = cur && cur.voice === v && gStart(g) - cur.end < gapMax && (gEnd(g) - cur.start) <= runCap;
```

- [ ] **Step 3: fetchOne captures cooldown**

Replace the error branch (dub.js:228):

```js
      } else if (resp && resp.error) {
        if (resp.cooldownUntil) cooldownUntil = Math.max(cooldownUntil, resp.cooldownUntil);
        console.warn("[SubVibe dub] speech:", resp.error);
      }
```

- [ ] **Step 4: pump honors cooldown + provider pacing**

After the `if (transportPaused) return;` gate (dub.js:243) add:

```js
    if (Date.now() < cooldownUntil) return; // rate-limited — paintTransport (above) shows the countdown
```

Replace the two in-flight checks (dub.js:249 and :263) and the fetch call (:262) with:

```js
    const maxInflight = conf.provider === "gemini" ? 1 : 2;
    const minGapMs = conf.provider === "gemini" ? 6000 : 0;
    if (pending.size >= maxInflight) return;
    …
      if (minGapMs && Date.now() - lastFetchAt < minGapMs) break;
      fetchOne(run);
      lastFetchAt = Date.now();
      if (pending.size >= maxInflight) break;
```

- [ ] **Step 5: transport shows the countdown**

In `paintTransport()` replace the label selection (dub.js:398-401):

```js
    let label;
    const coolS = Math.ceil((cooldownUntil - Date.now()) / 1000);
    if (!transportPaused && coolS > 0) label = `⏳ dub · rate-limited, resuming in ${coolS}s`;
    else if (!transportPaused) label = `⏸ dub · ${Math.round(aheadPct() * 100)}% ready`;
    else if (lastPct > 0) label = `▶ dub · ${pct}% cached (~$${usd} more)`;
    else label = `▶ Start dub (~$${usd})`;
```

- [ ] **Step 6: generateAll waits out cooldowns**

In the speaking loop (dub.js:641-645):

```js
      for (const run of ready) {
        if (genAll.cancelled) break;
        while (Date.now() < cooldownUntil && !genAll.cancelled) {
          genAll.phase = "rate-limited — waiting";
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (genAll.cancelled) break;
        genAll.phase = "speaking";
        if (!buffers.has(run.start)) await fetchOne(run, false); // cached rows return instantly, free
        genAll.done++;
      }
```

- [ ] **Step 7: Verify**

With Gemini selected as TTS provider, dub a fresh video. In the Activity tab: no more than ONE 429 row per cooldown window (previously dozens/minute); the on-video transport shows `⏳ dub · rate-limited, resuming in Ns` counting down, then resumes by itself. Runs in the log now show Gemini TTS rows spanning up to ~28 s (`🎙 28s`). OpenAI dubbing behaves exactly as before (2 in flight, 20 s runs, no pacing delay).

- [ ] **Step 8: Commit**

```bash
git add content/dub.js
git commit -m "Dub: honor TTS cooldowns, bigger Gemini runs, provider-aware pacing"
```

---

### Task 9: Full verification pass

**Files:** none new.

- [ ] **Step 1: Test suite**

Run: `node --test tools/tests/`
Expected: all suites pass (title, srt, audio-export, voices).

- [ ] **Step 2: Package builds**

Run: `./build.sh`
Expected: `✓ Built subvibe-v<ver>.zip`; the listed contents include `shared/title.js` and `shared/export.js`.

- [ ] **Step 3: Manual sweep (the operator's acceptance is the ear/eye test)**

1. Library: clean titles, stat strips, ▶ preview plays/stops, downloads work, delete works.
2. Popup on a translated video: This-video strip on top with stats + downloads; folds remember state across close/reopen; summaries show live values.
3. Dub a video on Gemini free tier: observe the cooldown countdown instead of a 429 storm; audio resumes unaided.
4. Regression: dub on OpenAI still plays in sync; Netflix/ZDF cards still render (non-YouTube titles unaffected by the suffix strip).

- [ ] **Step 4: Update memory + report**

Report results to the operator, including any deviations discovered during implementation.
