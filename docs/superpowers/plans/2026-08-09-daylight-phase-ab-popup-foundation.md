# Daylight Redesign — Phase A+B (tokens, popup, welcome) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Daylight brand foundation (`styles/tokens.css`, `styles/components.css`), the restructured hero-above-tabs popup, and the three-step `welcome.html` first-run flow — the first releasable unit of the redesign.

**Architecture:** One token stylesheet defines the light palette on `:root` and the dark counterpart under `prefers-color-scheme: dark`; a component stylesheet builds buttons/cards/chips/forms/states on those tokens. `popup.html` links both, aliases its old inline variable names to the new tokens (so pane-internal CSS keeps working), and reflows its chrome: header with scope line + gear, permanent Live hero card, three pill tabs. `welcome.html` is a new extension page opened once by a `chrome.runtime.onInstalled` listener. No build step exists — files ship as written; `build.sh` zips everything, so new files need no packaging change.

**Tech Stack:** Plain HTML/CSS/JS (MV3 extension, no framework, no bundler). Tests: `node:test` + `assert/strict` in `tools/tests/*.test.mjs`, run with `node --test tools/tests/`.

**Spec:** `docs/superpowers/specs/2026-08-09-daylight-redesign-design.md` (sections §1–§3, §6 and acceptance criteria). Read it before starting.

## Global Constraints

- Branch: `daylight-redesign`. One commit per task minimum.
- **Every element id and `data-` attribute referenced by `popup.js` must exist in `popup.html` at every commit** (Task 3's test enforces this).
- Pane internal names stay `translate` / `style` / `learn` / `keys` — only visible labels change (Subtitles · Style · Learn). No `dub` pane after Task 3.
- Popup width: exactly **460px** (html AND body pinned, `overflow-x: hidden` — keep the load-time sizing comment from the old file, it documents a real Chrome behavior).
- Type floor 11px; body 13.5px. Numbers `tabular-nums`.
- Coral `#F45D48` never carries small text; text-on-coral uses `--coral-600 #C93F2B` fills.
- The coral glow shadow appears on exactly one element: `#liveBtn`.
- `prefers-reduced-motion: reduce` disables the live pulse and transitions.
- RTL: plain text only, no direction-control characters, no `dir` hacks beyond what exists.
- No AI/assistant trailers in commit messages; author stays the repo's configured identity.
- Do not touch: `styles/overlay.css`, `library.html`, `learn.html`, hidden TTS dub logic, tribute logic (`shared/tribute.js`), version numbers.

---

### Task 1: `styles/tokens.css` — the Daylight token sheet

**Files:**
- Create: `styles/tokens.css`
- Test: `tools/tests/design-tokens.test.mjs`

**Interfaces:**
- Produces: CSS custom properties on `:root` (light) and dark overrides, consumed by every later task. Exact names below — later tasks use them verbatim.

- [ ] **Step 1: Write the failing test**

```js
// tools/tests/design-tokens.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../../styles/tokens.css", import.meta.url), "utf8");

const LIGHT = {
  "--bg": "#FAF6F0", "--surface": "#FFFFFF", "--surface-2": "#F3EDE4",
  "--border": "#EDE5DA", "--ink": "#241F1A", "--ink-2": "#5B5348",
  "--muted": "#8A7F72", "--faint": "#A39684",
  "--coral-500": "#F45D48", "--coral-600": "#C93F2B", "--coral-700": "#A93521",
  "--coral-100": "#FDE8E4", "--teal-600": "#0D9488", "--teal-100": "#E4F2EF",
  "--green-600": "#15803D", "--red-600": "#DC2626", "--amber-600": "#B45309",
  "--karaoke": "#FFB35C", "--toggle-off": "#D8CFC2",
};
const DARK = {
  "--bg": "#191512", "--surface": "#241F1A", "--surface-2": "#2E2822",
  "--border": "#3A332B", "--ink": "#F3EDE4",
  "--coral-500": "#FF7A66", "--teal-600": "#2DD4BF",
};

test("light tokens present on :root with spec values", () => {
  const root = css.split("@media")[0];
  for (const [k, v] of Object.entries(LIGHT))
    assert.match(root, new RegExp(`${k}:\\s*${v}`, "i"), `${k} missing/wrong in :root`);
});

test("dark counterparts under prefers-color-scheme: dark", () => {
  const i = css.indexOf("prefers-color-scheme: dark");
  assert.ok(i > -1, "dark media block missing");
  const dark = css.slice(i);
  for (const [k, v] of Object.entries(DARK))
    assert.match(dark, new RegExp(`${k}:\\s*${v}`, "i"), `${k} missing/wrong in dark block`);
});

test("non-color scale tokens exist", () => {
  for (const k of ["--r-sm", "--r-md", "--r-lg", "--shadow-rest", "--shadow-raised", "--shadow-glow", "--t-fast", "--t-panel"])
    assert.ok(css.includes(k + ":"), `${k} missing`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/tests/design-tokens.test.mjs`
Expected: FAIL — `ENOENT ... styles/tokens.css`

- [ ] **Step 3: Write `styles/tokens.css`**

```css
/* SubVibe "Daylight" design tokens — the single source of truth for every
   extension page (popup, welcome, library, learn). The on-video overlay does
   NOT link this file: it keeps its own self-contained CSS (content-script
   world) and duplicates the few values it needs, with a comment pointing here.
   Spec: docs/superpowers/specs/2026-08-09-daylight-redesign-design.md §1 */

:root {
  color-scheme: light dark;

  /* neutrals — warm paper + ink */
  --bg: #FAF6F0;         /* canvas */
  --surface: #FFFFFF;    /* cards, inputs */
  --surface-2: #F3EDE4;  /* hover, wells */
  --border: #EDE5DA;     /* hairlines */
  --ink: #241F1A;        /* primary text */
  --ink-2: #5B5348;      /* secondary body */
  --muted: #8A7F72;      /* hints, meta */
  --faint: #A39684;      /* overline labels */
  --toggle-off: #D8CFC2;

  /* coral = ACT (Live, primary buttons, active nav).
     500 is brand/glow only — never small text; 600 passes AA with white. */
  --coral-500: #F45D48;
  --coral-600: #C93F2B;
  --coral-700: #A93521;  /* hover/pressed fills */
  --coral-100: #FDE8E4;  /* selected chips, soft fills */

  /* teal = LEARN (vocab, CEFR, Leitner) */
  --teal-600: #0D9488;
  --teal-100: #E4F2EF;

  /* semantic */
  --green-600: #15803D;
  --red-600: #DC2626;
  --amber-600: #B45309;
  --karaoke: #FFB35C;    /* karaoke sweep — only ever on the video's dark scrim */

  /* shape */
  --r-sm: 8px;   /* buttons, inputs */
  --r-md: 12px;  /* cards */
  --r-lg: 16px;  /* page-level cards */

  /* elevation — warm brown, not gray. Glow is reserved for #liveBtn. */
  --shadow-rest: 0 1px 2px rgba(93, 64, 35, .08);
  --shadow-raised: 0 6px 18px -4px rgba(93, 64, 35, .18);
  --shadow-glow: 0 6px 18px rgba(244, 93, 72, .28);

  /* motion */
  --t-fast: 120ms ease-out;   /* hover, press */
  --t-panel: 180ms ease-out;  /* folds, panes */

  /* type */
  --ui: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --display: "Baloo 2", var(--ui);
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
}

/* Dark counterpart — warm stone, not blue-black. Same names, one query.
   People use SubVibe at night over videos; light stays the brand default. */
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #191512;
    --surface: #241F1A;
    --surface-2: #2E2822;
    --border: #3A332B;
    --ink: #F3EDE4;
    --ink-2: #C9BFB2;
    --muted: #8A7F72;
    --faint: #6E6458;
    --toggle-off: #4A4238;
    --coral-500: #FF7A66;
    --coral-600: #FF7A66;  /* fills use dark ink text in dark mode */
    --coral-700: #F45D48;
    --coral-100: #3A241F;
    --teal-600: #2DD4BF;
    --teal-100: #16302C;
    --green-600: #4ADE80;
    --red-600: #F87171;
    --amber-600: #FBBF24;
    --shadow-rest: 0 1px 2px rgba(0, 0, 0, .4);
    --shadow-raised: 0 6px 18px -4px rgba(0, 0, 0, .5);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/tests/design-tokens.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add styles/tokens.css tools/tests/design-tokens.test.mjs
git commit -m "Daylight: design tokens (light + dark) with contract test"
```

---

### Task 2: `styles/components.css` — shared component classes

**Files:**
- Create: `styles/components.css`
- Test: `tools/tests/design-components.test.mjs`

**Interfaces:**
- Consumes: every token from Task 1.
- Produces: class contract used by Tasks 3–5 — `.btn-primary`, `.btn-secondary`, `.btn-quiet`, `.btn-danger`, `.card`, `.chip`, `.chip.on`, `.chip.learn`, `.field`, `.switch`+`.slider`, `.overline`, `.skeleton`, `.empty-state`, `.error-state`, `.check-row`.

- [ ] **Step 1: Write the failing test**

```js
// tools/tests/design-components.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../../styles/components.css", import.meta.url), "utf8");

test("component class contract", () => {
  for (const sel of [".btn-primary", ".btn-secondary", ".btn-quiet", ".btn-danger",
    ".card", ".chip", ".chip.on", ".chip.learn", ".field", ".switch", ".slider",
    ".overline", ".skeleton", ".empty-state", ".error-state", ".check-row"])
    assert.ok(css.includes(sel), `${sel} missing`);
});

test("focus ring and reduced motion are defined", () => {
  assert.ok(css.includes(":focus-visible"), "focus-visible ring missing");
  assert.ok(css.includes("prefers-reduced-motion"), "reduced-motion guard missing");
});

test("components use tokens, not raw palette hexes", () => {
  // Raw brand hexes belong in tokens.css only.
  for (const hex of ["#F45D48", "#C93F2B", "#0D9488", "#FAF6F0"])
    assert.ok(!css.includes(hex), `raw ${hex} found — use var()`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/tests/design-components.test.mjs`
Expected: FAIL — `ENOENT ... styles/components.css`

- [ ] **Step 3: Write `styles/components.css`**

```css
/* Daylight shared components — consumed by popup, welcome, library, learn.
   Depends on styles/tokens.css being linked first. Spec §6. */

* { box-sizing: border-box; }
[hidden] { display: none !important; } /* beats any class-set display */

:focus-visible { outline: 2px solid var(--coral-600); outline-offset: 2px; border-radius: 6px; }
::selection { background: var(--coral-100); }

.overline { font-size: 11px; font-weight: 700; letter-spacing: .08em;
  text-transform: uppercase; color: var(--faint); }

/* ── buttons: 4 variants × rest/hover/focus/disabled, min-height 32px ── */
.btn-primary, .btn-secondary, .btn-quiet, .btn-danger {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  min-height: 32px; padding: 7px 14px; border-radius: var(--r-sm);
  font: 600 13.5px/1.2 var(--ui); cursor: pointer;
  transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
}
.btn-primary { border: 0; background: var(--coral-600); color: #fff; }
.btn-primary:hover { background: var(--coral-700); }
.btn-secondary { border: 1px solid var(--border); background: var(--surface); color: var(--ink); }
.btn-secondary:hover { background: var(--surface-2); }
.btn-quiet { border: 0; background: transparent; color: var(--coral-600); padding: 7px 8px; }
.btn-quiet:hover { background: var(--coral-100); }
.btn-danger { border: 1px solid var(--border); background: var(--surface); color: var(--red-600); }
.btn-danger:hover { border-color: var(--red-600); background: color-mix(in srgb, var(--red-600) 8%, var(--surface)); }
.btn-primary:disabled, .btn-secondary:disabled, .btn-quiet:disabled, .btn-danger:disabled {
  opacity: .45; cursor: default; }
@media (prefers-color-scheme: dark) { .btn-primary { color: #191512; } }

/* ── cards ── */
.card { background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r-md); box-shadow: var(--shadow-rest); }

/* ── chips / pills ── */
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 11px;
  border-radius: 999px; font: 600 12px/1.4 var(--ui);
  background: var(--surface-2); color: var(--ink-2); border: 1px solid transparent; }
.chip.on { background: var(--coral-100); color: var(--coral-600); border-color: var(--coral-500); }
.chip.learn { background: var(--teal-100); color: var(--teal-600); }

/* ── forms ── */
.field { width: 100%; padding: 8px 10px; border-radius: var(--r-sm);
  border: 1px solid var(--border); background: var(--surface); color: var(--ink);
  font: 13.5px/1.4 var(--ui); }
.field::placeholder { color: var(--faint); }
.field:focus { outline: none; border-color: var(--coral-600); }
.field-msg-ok { color: var(--green-600); font-size: 12px; }
.field-msg-err { color: var(--red-600); font-size: 12px; }

/* toggle — teal when on (spec §6) */
.switch { position: relative; display: inline-block; width: 38px; height: 22px; flex: none; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider { position: absolute; inset: 0; cursor: pointer; background: var(--toggle-off);
  border-radius: 22px; transition: background var(--t-fast); }
.slider::before { content: ""; position: absolute; height: 16px; width: 16px; left: 3px; top: 3px;
  background: #fff; border-radius: 50%; transition: transform var(--t-fast);
  box-shadow: 0 1px 2px rgba(0, 0, 0, .25); }
.switch input:checked + .slider { background: var(--teal-600); }
.switch input:checked + .slider::before { transform: translateX(16px); }

/* ── async states: no view renders blank (spec §6) ── */
.skeleton { border-radius: var(--r-sm); background: var(--surface-2); min-height: 14px;
  animation: sk 1.2s ease-in-out infinite; }
@keyframes sk { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
.empty-state { color: var(--muted); font-size: 13px; text-align: center; padding: 24px 12px; }
.error-state { color: var(--red-600); font-size: 12.5px; }

/* setup checklist rows (popup hero + welcome step 3) */
.check-row { display: flex; align-items: center; gap: 8px; background: var(--surface);
  border: 1px solid var(--border); border-radius: var(--r-sm); padding: 8px 10px;
  font-size: 12.5px; color: var(--ink-2); }
.check-row .ok { color: var(--green-600); font-weight: 800; }
.check-row .todo { color: var(--amber-600); font-weight: 800; }

@media (prefers-reduced-motion: reduce) {
  .skeleton { animation: none; }
  .btn-primary, .btn-secondary, .btn-quiet, .btn-danger, .slider, .slider::before { transition: none; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/tests/design-components.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add styles/components.css tools/tests/design-components.test.mjs
git commit -m "Daylight: shared component classes with contract test"
```

---

### Task 3: `popup.html` — Daylight restructure (hero above tabs)

**Files:**
- Modify: `popup.html` (currently 769 lines, all styling inline)
- Test: `tools/tests/popup-ids.test.mjs`

**Interfaces:**
- Consumes: `styles/tokens.css`, `styles/components.css`.
- Produces: new ids `#gearBtn`, `#setupCard`, `#setupKeyLine`, `#finishSetup`, `#liveSettingsFold` for Task 4. All existing popup.js-referenced ids preserved. Tab bar keeps `id="tabBar"` with `data-tab` buttons `translate|style|learn` only.

**This task is HTML/CSS only — zero popup.js edits.** The popup must still open and function identically wired (Task 4 rewires). A hidden compatibility stub keeps removed chrome (learnChip) resolvable until Task 4 deletes its JS.

- [ ] **Step 1: Write the failing test (the load-bearing check of the whole phase)**

```js
// tools/tests/popup-ids.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const js = fs.readFileSync(new URL("../../popup.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../../popup.html", import.meta.url), "utf8");

test("every id popup.js touches exists in popup.html", () => {
  const ids = new Set();
  for (const m of js.matchAll(/\bel\(\s*"([^"]+)"\s*\)/g)) ids.add(m[1]);
  for (const m of js.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) ids.add(m[1]);
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `popup.js references missing ids: ${missing.join(", ")}`);
});

test("panes are translate/style/learn/keys — no dub pane, tabs match", () => {
  const panes = [...html.matchAll(/data-pane="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(panes, ["keys", "learn", "style", "translate"]);
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(tabs, ["learn", "style", "translate"]);
});

test("Daylight applied: tokens linked, 460px, old indigo palette gone", () => {
  assert.ok(html.includes('href="styles/tokens.css"'), "tokens.css not linked");
  assert.ok(html.includes('href="styles/components.css"'), "components.css not linked");
  assert.match(html, /width:\s*460px/, "popup not pinned to 460px");
  for (const hex of ["#0B0F19", "#161D30", "#4F46E5", "#1C2438", "#24324F"])
    assert.ok(!html.includes(hex), `old indigo hex ${hex} still present`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/tests/popup-ids.test.mjs`
Expected: FAIL on tests 2 and 3 (dub pane + keys tab exist; tokens not linked; indigo hexes present). Test 1 passes today — it must STAY passing.

- [ ] **Step 3: Rewire the `<head>`**

In `popup.html`, add before the inline `<style>`:

```html
<link rel="stylesheet" href="styles/tokens.css" />
<link rel="stylesheet" href="styles/components.css" />
```

Then in the inline `<style>`, replace the entire old `:root { ... }` block (lines 7–16) with **aliases** so every existing pane rule keeps working on the new palette:

```css
:root {
  /* Legacy aliases → Daylight tokens. Pane-internal rules below still use the
     old names; the chrome uses tokens directly. Remove aliases when panes are
     rewritten (phase d follow-up). */
  --panel: var(--surface); --panel2: var(--surface-2); --hover: var(--surface-2);
  --divider: var(--border); --text: var(--ink); --text2: var(--ink-2);
  --accent: var(--coral-600); --accent2: var(--coral-700); --accent-soft: var(--coral-100);
  --green: var(--green-600); --red: var(--red-600); --amber: var(--amber-600);
  --radius: var(--r-md);
}
```

Delete `color-scheme: dark;` (tokens.css declares `light dark`). Update the body font line to `font: 13.5px/1.5 var(--ui);` and background/color to `var(--bg)` / `var(--ink)`. Change every `520px` to `460px` (3 occurrences on the html/body rule — keep the explanatory comment).

- [ ] **Step 4: Fix the hard-coded hexes the aliases don't cover**

Exact find → replace across the inline `<style>` (these are raw values sprinkled in rules):

| Find | Replace |
|---|---|
| `#818cf8` (all) | `var(--coral-600)` — except `.lnw .lvl`, `.lnlvl`, `.seenb`, `.ctxtoggle`: use `var(--teal-600)` (learning role) |
| `#6366f1` | `var(--coral-600)` |
| `rgba(99, 102, 241, .18)` / `rgba(99,102,241,.12)` / `rgba(99, 102, 241, .07)` | `var(--teal-100)` |
| `rgba(124, 92, 231, 0.18)` / `rgba(124, 92, 231, 0.3)` and `#c4b5fd` | `var(--teal-100)` / `var(--teal-600)` |
| `#ffd479` (karaoke in word samples) | `var(--amber-600)` |
| `#34d399` (`.lnw.added b`) | `var(--green-600)` |
| `rgba(79, 70, 229, .4/.5/.75/.85)` (livebtn/tab glows) | `var(--shadow-glow)` for the livebtn shadows; DELETE the `.tabs .tab.on` box-shadow line |
| `#FBBF24` (idle ring/text) | `var(--amber-600)` |
| `rgba(0,0,0,.5)` (menu shadow) | `var(--shadow-raised)` |
| `#475569` / `#3E4C60` (live-elsewhere) | keep — slate is intentional for the remote state |
| `.memcard` block | keep untouched (tribute, dark by design) |
| `#7fe0b0` ver-arming glow | keep (tribute door) |

- [ ] **Step 5: Restructure the `<body>` chrome**

Replace the current `<header>` (lines 381–389) and scope bar `#scopeBar` div (391–397) with:

```html
<header>
  <img src="icons/icon-48.png" alt="" />
  <div class="hgroup">
    <h1 class="wordmark">SubVibe</h1>
    <p class="scopeline">
      <span id="scopeText">Editing your defaults</span>
      <button id="setDefault" class="scopelink" hidden title="Apply this video's languages, position, size and timing to every NEW video">Save as default</button>
      <button id="resetClip" class="scopelink muted" hidden title="Revert this video to your defaults">Reset</button>
    </p>
    <p class="ver" id="verTag"></p>
  </div>
  <button id="gearBtn" class="gearbtn" title="API keys">
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
  </button>
  <!-- Task 4 removes learnChip JS; stub keeps popup-ids green until then -->
  <button id="learnChip" hidden><span id="learnDue"></span></button>
</header>
```

Immediately after the header, insert the **hero** (this is the old `.livecard` section moved out of the dub pane — keep ALL its inner ids: `liveBtn`, `livePerm`, `liveLangSearch`, `liveLangMenu`, `liveDevice`, `liveStatus`; the two `.liverow` rows move inside a new collapsed fold):

```html
<section class="hero">
  <div class="livecard card">
    <div id="setupCard" hidden>
      <div class="check-row"><span class="ok">✓</span> Free styled captions — active</div>
      <div class="check-row" id="setupKeyLine"><span class="todo">○</span> Translation &amp; Live — need an API key</div>
      <button class="btn-primary" id="finishSetup" style="width:100%; margin-top:8px;">Finish setup (2 min)</button>
    </div>
    <button class="livebtn" id="liveBtn">▶ Start Live Translate</button>
    <p class="liveperm" id="livePerm">🔒 Capturing this tab's audio safely — no microphone access required.</p>
    <details class="customize" id="liveSettingsFold">
      <summary>Live settings <span class="hint">audio language · input device</span></summary>
      <!-- MOVE the two .liverow rows + #liveStatus from the old dub pane
           (popup.html lines 500–512) here verbatim. -->
    </details>
  </div>
</section>
```

Then the tab nav — three pills, keys removed, dub removed:

```html
<nav class="tabs" id="tabBar">
  <button class="tab on" data-tab="translate">Subtitles</button>
  <button class="tab" data-tab="style">Style</button>
  <button class="tab" data-tab="learn">Learn</button>
</nav>
```

Panes: keep `data-pane="translate"`, `data-pane="style"`, `data-pane="learn"`, `data-pane="keys"` **with their entire existing contents unchanged** (translate: old lines 407–490; style: 569–658; learn: 660–697; keys: 699–734). Make `translate` the un-hidden default pane. Delete the `data-pane="dub"` wrapper; move its hidden TTS `<section hidden>` (old lines 518–566, ids dubFold/dubEnabled/…/dubNow) to just before the tribute card, wrapped in `<div hidden>` — the ids must stay in the DOM.

Footer/bottombar (old lines 736–747): keep as-is.

- [ ] **Step 6: Restyle the chrome in the inline `<style>`**

Add/replace these rules (delete the old `header`, `.learnchip`, `.scopebar`, `.tabs` blocks):

```css
header { display: flex; align-items: flex-start; gap: 11px; padding: 14px 16px 10px; }
header img { width: 30px; height: 30px; border-radius: 9px; }
.wordmark { font-family: var(--display); font-weight: 800; font-size: 19px; margin: 0; line-height: 1.1; }
.scopeline { margin: 2px 0 0; font-size: 11.5px; color: var(--muted); display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.gearbtn { margin-left: auto; border: 1px solid var(--border); background: var(--surface);
  color: var(--muted); border-radius: var(--r-sm); width: 32px; height: 32px;
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
  transition: color var(--t-fast), border-color var(--t-fast); }
.gearbtn:hover, .gearbtn.on { color: var(--coral-600); border-color: var(--coral-600); }

.hero { padding: 2px 16px 12px; }
.hero .livecard { padding: 13px; gap: 10px; }

.tabs { display: flex; gap: 6px; padding: 0 16px 12px; }
.tabs .tab { flex: 1; padding: 8px 0; border: 0; border-radius: 999px; background: transparent;
  color: var(--muted); font-weight: 600; font-size: 12.5px; cursor: pointer;
  transition: background var(--t-fast), color var(--t-fast); }
.tabs .tab:hover { background: var(--surface-2); color: var(--ink); }
.tabs .tab.on { background: var(--ink); color: var(--bg); }
```

Update `.livebtn`: `background: var(--coral-600);` hover `var(--coral-700)`, `box-shadow: var(--shadow-glow);`, and the `@keyframes livePulse` shadows to `var(--shadow-glow)` / `0 6px 26px rgba(244,93,72,.5)`. Sections become white cards on paper: `section { padding: 12px 16px; border-top: 0; }` with each pane's `details.customize > summary` and inputs already re-skinned via the aliases.

- [ ] **Step 7: Run tests**

Run: `node --test tools/tests/popup-ids.test.mjs`
Expected: PASS (all 3). Also run `node --test tools/tests/` — everything green.

- [ ] **Step 8: Load it for real**

Open `chrome://extensions` → reload SubVibe → open the popup. Check: exactly 460px, no horizontal scroll, paper background, hero visible above pills, all three panes switch (tab JS still works because ids/data-attrs are unchanged), keys pane currently unreachable by click (expected until Task 4 — verify via devtools `document.querySelector('[data-pane=keys]').hidden = false`).

- [ ] **Step 9: Commit**

```bash
git add popup.html tools/tests/popup-ids.test.mjs
git commit -m "Daylight popup: hero above tabs, token palette, 460px, keys behind gear (markup)"
```

---

### Task 4: `popup.js` — wiring for the new chrome

**Files:**
- Modify: `popup.js` (tab handling at lines 183–193, learnChip wiring, DEFAULTS load path)
- Test: existing `tools/tests/popup-ids.test.mjs` (re-run) + manual states

**Interfaces:**
- Consumes: `#gearBtn`, `#setupCard`, `#setupKeyLine`, `#finishSetup` from Task 3; storage keys `apiKey`, `anthropicKey`, `geminiKey` (popup.js DEFAULTS, line 15).
- Produces: `updateSetupHero()` — called after key state loads/changes.

- [ ] **Step 1: Tab fallback + gear**

In the tab init (around lines 183–193): define the valid set and fall back — stored `uiTab` may be `"dub"` or `"keys"` from older versions.

```js
const TABS = ["translate", "style", "learn", "keys"]; // keys reachable via gear only
function selectTab(name) {
  if (!TABS.includes(name)) name = "translate";
  for (const b of el("tabBar").children) b.classList.toggle("on", b.dataset.tab === name);
  el("gearBtn").classList.toggle("on", name === "keys");
  for (const p of document.querySelectorAll(".pane")) p.hidden = p.dataset.pane !== name;
}
el("gearBtn").addEventListener("click", () => {
  const open = !el("gearBtn").classList.contains("on");
  selectTab(open ? "keys" : "translate");
  chrome.storage.local.set({ uiTab: open ? "keys" : "translate" });
});
```

(The existing `tabBar` click listener stays as-is — it only sees the three pill buttons now.)

- [ ] **Step 2: Remove learnChip**

Delete the `learnChip`/`learnDue` wiring from popup.js (grep `learnChip` — click handler and due-count updater), then delete the stub `<button id="learnChip" hidden>...` from popup.html. The Learn pane's `#lnOpenFull` link is the surviving path to the trainer.

- [ ] **Step 3: Setup-state hero**

Where popup.js loads settings into the key inputs on startup (it reads the DEFAULTS keys via `chrome.storage.local.get` — grep `apiKey` near the load path), add:

```js
function updateSetupHero(s) {
  const hasKey = !!(s.apiKey || s.anthropicKey || s.geminiKey);
  el("setupCard").hidden = hasKey;
  el("liveBtn").hidden = !hasKey;
  el("livePerm").hidden = !hasKey;
  el("liveSettingsFold").hidden = !hasKey;
}
```

Call it with the loaded settings object on startup, and again after any successful key verify (the verify handlers that set `.ok` status). `#finishSetup` opens the keys pane:

```js
el("finishSetup").addEventListener("click", () => selectTab("keys"));
```

- [ ] **Step 4: Run tests + manual states**

Run: `node --test tools/tests/`
Expected: PASS — popup-ids test now proves learnChip is gone from BOTH files.

Manual: reload extension. (a) With keys stored: hero shows Live button; gear opens/closes Keys; pills switch panes; stored `uiTab: "dub"` case — run `chrome.storage.local.set({uiTab:"dub"})` in the popup devtools console, reopen popup, expect Subtitles tab. (b) Clear keys (`chrome.storage.local.set({apiKey:"",anthropicKey:"",geminiKey:""})`), reopen: setup card shows, Finish setup lands on Keys pane; verify a key → hero swaps in live.

- [ ] **Step 5: Commit**

```bash
git add popup.html popup.js
git commit -m "Daylight popup: gear-keys wiring, dub-tab fallback, setup-state hero"
```

---

### Task 5: `welcome.html` + `welcome.js` + install hook

**Files:**
- Create: `welcome.html`, `welcome.js`
- Modify: `background.js` (add onInstalled listener — file currently has none; put it near the top-level listeners, e.g. above the `chrome.runtime.onMessage` block)
- Test: `tools/tests/welcome.test.mjs`

**Interfaces:**
- Consumes: tokens/components CSS; `shared/langs.js` (`window.SV_LANGS`: array of `{ code, name, flag }` — same global popup.js uses at its line 8); storage key `targets` (array of lang codes, first = primary — same shape popup.js persists).
- Produces: `welcome.html` opened once per fresh install.

- [ ] **Step 1: Write the failing test**

```js
// tools/tests/welcome.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../../welcome.html", import.meta.url), "utf8");
const js = fs.readFileSync(new URL("../../welcome.js", import.meta.url), "utf8");
const bg = fs.readFileSync(new URL("../../background.js", import.meta.url), "utf8");

test("welcome page structure: 3 steps, skippable, tokens linked", () => {
  assert.ok(html.includes('href="styles/tokens.css"'));
  for (const id of ["step1", "step2", "step3", "langGrid", "langSearch", "skipBtn"])
    assert.ok(html.includes(`id="${id}"`), `#${id} missing`);
  assert.ok(html.includes('src="shared/langs.js"'), "langs.js not loaded");
});

test("welcome.js writes the targets key popup reads", () => {
  assert.match(js, /storage\.local\.set\(\s*\{\s*targets:/);
});

test("background opens welcome on fresh install only", () => {
  assert.match(bg, /onInstalled/);
  assert.match(bg, /reason\s*===\s*"install"/);
  assert.match(bg, /welcome\.html/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/tests/welcome.test.mjs`
Expected: FAIL — ENOENT welcome.html

- [ ] **Step 3: Write `welcome.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Welcome to SubVibe</title>
  <link rel="stylesheet" href="styles/tokens.css" />
  <link rel="stylesheet" href="styles/components.css" />
  <style>
    @font-face { font-family: "Baloo 2"; font-weight: 800; font-display: swap;
      src: url("fonts/Baloo2-ExtraBold-latin.woff2") format("woff2"); }
    body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.6 var(--ui);
      -webkit-font-smoothing: antialiased; }
    .wrap { max-width: 620px; margin: 0 auto; padding: 48px 24px 80px; }
    .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 34px; }
    .brand img { width: 40px; height: 40px; border-radius: 11px; }
    .brand .name { font-family: var(--display); font-weight: 800; font-size: 24px; }
    h1 { font-family: var(--display); font-weight: 800; font-size: 27px; margin: 0 0 6px; }
    .sub { color: var(--ink-2); margin: 0 0 22px; }
    .stepdots { display: flex; gap: 6px; margin-bottom: 26px; }
    .stepdots i { width: 26px; height: 4px; border-radius: 2px; background: var(--border); }
    .stepdots i.on { background: var(--coral-600); }
    .grid { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 22px; }
    .grid .chip { cursor: pointer; padding: 8px 14px; font-size: 13.5px; }
    .sites { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 22px; }
    .sites span { background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--r-sm); padding: 9px 14px; font-weight: 600; font-size: 13px; }
    .row { display: flex; gap: 10px; align-items: center; margin-top: 18px; flex-wrap: wrap; }
    .checks { display: flex; flex-direction: column; gap: 7px; margin: 16px 0; }
    #langSearch { max-width: 300px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand"><img src="icons/icon-48.png" alt="" /><span class="name">SubVibe</span></div>
    <div class="stepdots"><i class="on" data-dot="1"></i><i data-dot="2"></i><i data-dot="3"></i></div>

    <section id="step1">
      <h1>Welcome 👋 Which language do you want on screen?</h1>
      <p class="sub">One question — this becomes your subtitle language everywhere. You can add more later.</p>
      <input type="text" id="langSearch" class="field" placeholder="Search languages…" autocomplete="off" />
      <div class="grid" id="langGrid"></div>
      <div class="row"><button class="btn-primary" id="next1" disabled>Continue →</button></div>
    </section>

    <section id="step2" hidden>
      <h1>Open any video — captions get beautiful, free</h1>
      <p class="sub">Styled original captions cost nothing and need no account. Try it right now:</p>
      <div class="sites"><span>▶ YouTube</span><span>Netflix</span><span>ZDF</span><span>ARD</span><span>Prime Video</span></div>
      <div class="row">
        <button class="btn-primary" id="tryYoutube">Try it on YouTube →</button>
        <button class="btn-secondary" id="next2">I'll browse on my own</button>
      </div>
    </section>

    <section id="step3" hidden>
      <h1>Unlock translation &amp; Live voice</h1>
      <p class="sub">Bring your own key (OpenAI, Claude or Gemini) — you pay cents directly to the provider, nothing to us, and every translated video is cached so replays are free.</p>
      <div class="checks">
        <div class="check-row"><span class="ok">✓</span> Subtitle language — <b id="chosenLang" style="margin-left:4px;"></b></div>
        <div class="check-row"><span class="todo">○</span> API key — connect when ready</div>
      </div>
      <div class="row">
        <button class="btn-primary" id="openKeys">Connect a key</button>
        <button class="btn-secondary" id="skipBtn">Later — start watching</button>
      </div>
    </section>
  </div>
  <script src="shared/langs.js"></script>
  <script src="welcome.js"></script>
</body>
</html>
```

- [ ] **Step 4: Write `welcome.js`**

```js
// First-run flow. Storage contract: { targets: [primaryLangCode] } — the same
// key/shape popup.js persists; DEFAULTS there fill in everything else.
// NOTE: SV_LANGS entries are TUPLES [code, name, flag] (shared/langs.js:14),
// not objects — destructure positionally.
const $ = (id) => document.getElementById(id);
const LANGS = window.SV_LANGS;
let chosen = null;

const POPULAR = ["fa", "de", "en", "tr", "ar", "es", "fr", "uk", "ru", "hi"];
function renderGrid(q) {
  const list = (q
    ? LANGS.filter(([code, name]) => name.toLowerCase().includes(q.toLowerCase()) || code === q.toLowerCase())
    : LANGS.filter(([code]) => POPULAR.includes(code))
  ).slice(0, 24);
  $("langGrid").replaceChildren(...list.map(([code, name, flag]) => {
    const b = document.createElement("button");
    b.className = "chip" + (chosen === code ? " on" : "");
    b.textContent = `${flag || ""} ${name}`.trim();
    b.addEventListener("click", () => {
      chosen = code;
      chrome.storage.local.set({ targets: [chosen] });
      $("next1").disabled = false;
      $("chosenLang").textContent = name;
      renderGrid($("langSearch").value);
    });
    return b;
  }));
}
renderGrid("");
$("langSearch").addEventListener("input", (e) => renderGrid(e.target.value));

function goto(n) {
  for (const s of [1, 2, 3]) $("step" + s).hidden = s !== n;
  document.querySelectorAll(".stepdots i").forEach((d) => d.classList.toggle("on", +d.dataset.dot <= n));
}
$("next1").addEventListener("click", () => goto(2));
$("next2").addEventListener("click", () => goto(3));
$("tryYoutube").addEventListener("click", () => { chrome.tabs.create({ url: "https://www.youtube.com" }); goto(3); });
$("openKeys").addEventListener("click", () => { chrome.storage.local.set({ uiTab: "keys" }); window.close(); });
$("skipBtn").addEventListener("click", () => window.close());
```

- [ ] **Step 5: Add the install hook to `background.js`**

```js
// First run only — never on update: the welcome page sets up language + key.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
});
```

- [ ] **Step 6: Run tests, then live check**

Run: `node --test tools/tests/` — all green.
Live: remove + re-add the unpacked extension → welcome opens once; pick a language → popup shows it as primary chip; reload extension (update path) → welcome does NOT open. `chrome.storage.local.get("targets")` shows `["<code>"]`. Keys route: "Connect a key" closes welcome; next popup open lands on Keys pane (uiTab).

- [ ] **Step 7: Commit**

```bash
git add welcome.html welcome.js background.js tools/tests/welcome.test.mjs
git commit -m "Daylight: three-step welcome flow, opened once on install"
```

---

### Task 6: Acceptance sweep + PR

**Files:**
- No new code — verification + `tools/audit.mjs` + `build.sh` + PR.

- [ ] **Step 1: Full test + audit + build**

```bash
node --test tools/tests/
node tools/audit.mjs
./build.sh && ./build.sh --firefox
```
Expected: tests green, audit exits 0, both zips list `welcome.html`, `welcome.js`, `styles/tokens.css`, `styles/components.css`.

- [ ] **Step 2: Manual acceptance (spec's criteria, popup + welcome scope)**

- Popup opens at 460px, no layout shift, no horizontal scrollbar.
- macOS System Settings → toggle Dark mode: popup and welcome flip to warm stone palette; text readable in both.
- System Settings → Accessibility → Reduce Motion: live pulse and transitions stop.
- Persian: set targets to `fa`, open the Learn pane — RTL strings render correctly (no stray LTR punctuation).
- Contrast spot-check (devtools eyedropper): `--coral-600` on white ≥ 4.5, `--muted` on `--bg` ≥ 4.5.
- Firefox: `about:debugging` → Load Temporary Add-on with the firefox zip's manifest — popup renders identically; check `color-mix()` renders (used in `.btn-danger:hover` and `#claudeModelRow` legacy rule).
- Full smoke: translate a short YouTube video end-to-end — subtitles appear, style pane still applies presets, Learn pane lists words.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin daylight-redesign
gh pr create --title "Daylight redesign: tokens, popup hero-above-tabs, welcome flow (phases a+b)" \
  --body "$(cat <<'EOF'
Implements phases a+b of docs/superpowers/specs/2026-08-09-daylight-redesign-design.md:
- styles/tokens.css + styles/components.css — Daylight light/dark token system with contract tests
- popup.html/js — hero-above-tabs at 460px, pill nav (Subtitles · Style · Learn), keys behind gear, setup-state hero; every popup.js id preserved (tools/tests/popup-ids.test.mjs)
- welcome.html/js + onInstalled — three-step skippable first-run: language → free captions → key as upgrade

Library, learn, overlay and the store re-shoot follow in phases c–e.
EOF
)"
```

(No AI trailers in the PR body — house rule.)

---

## Not in this plan (later phases)

- Phase c: store re-shoot — reuse the existing `tools/store-screenshots/` pipeline (compose.html, promo-*.html) restyled to Daylight; new icon set; copy from spec §4 replacing `tools/store-listing.md`.
- Phase d: library.html + learn.html onto tokens (drop their local palettes), optional Activity sparkline.
- Phase e: overlay karaoke default `--karaoke` + word/explain card skin in `styles/overlay.css` and `content/common.js` appearance code.
