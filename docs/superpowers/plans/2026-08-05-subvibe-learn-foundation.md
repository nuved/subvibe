# SubVibe Learn — Foundation & Palettes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the highlight-palette color feature and the frozen, unit-tested foundation of the SubVibe Learn suite (contracts, Leitner engine, record logic, IndexedDB store) — every task independent so they run in parallel.

**Architecture:** Contracts-first. Once `learn/contracts.js` (message types, CEFR colors, Leitner intervals, lookup schema) is frozen, the tracks fan out with no cross-dependency: **palettes** (Style tab), **Leitner engine** (pure math), **record merge** (pure dedup logic), **store** (IndexedDB wrapper over record merge). P1 (capture→lookup→display) and P2–P4 build on these later, each its own spec→plan.

**Tech Stack:** Vanilla JS/HTML/CSS (no build step — files in the repo are what ships), IndexedDB, `node --test` for pure-logic unit tests, chrome-devtools MCP stub-harness for UI verification.

## Global Constraints

- No build step; vanilla JS/HTML/CSS, nothing bundled/minified — the repo files ARE what ships.
- **v1 adds NO new permissions** (badge uses the existing `action`; lookups reuse existing AI-provider host permissions).
- Reuse the user's existing BYO key (OpenAI/Anthropic for text); no new provider, no server — local only.
- Dedup words by `id = lemma + "|" + lang`; a word is billed at most once (cache forever).
- CEFR level colors: A1 `#34D399`, A2 `#A3E635`, B1 `#FBBF24`, B2 `#FB923C`, C1 `#F87171`, C2 `#C084FC`.
- Leitner intervals by box (ms): box 1→`0`, 2→`1d`, 3→`3d`, 4→`7d`, 5→`21d`; correct = box+1 (cap 5), wrong = box 1.
- Version scheme stays `1330.x`; commit as `Nimanou <support@nimanou.com>`, **no AI/Co-Authored-By trailer**.
- `docs/` is excluded from `build.sh` (dev-only).
- Run pure tests with the existing glob: `node --test "tools/tests/**/*.test.mjs"` — put new tests under `tools/tests/learn/`.

---

### Task 1: Contracts module (frozen interfaces — do FIRST, unblocks all)

**Files:**
- Create: `learn/contracts.js`
- Test: `tools/tests/learn/contracts.test.mjs`

**Interfaces:**
- Produces: `window.SV_LEARN` = `{ MSG, CEFR, CEFR_COLOR, BOX_INTERVALS_MS, LOOKUP_KEYS }`.
  - `MSG` = `{ CAPTURE:"LEARN_CAPTURE", LOOKUP:"LEARN_LOOKUP", LIST:"LEARN_LIST", DUE:"LEARN_DUE", GRADE:"LEARN_GRADE", BADGE:"LEARN_BADGE" }`
  - `CEFR` = `["A1","A2","B1","B2","C1","C2"]`
  - `CEFR_COLOR` = `{ A1:"#34D399", A2:"#A3E635", B1:"#FBBF24", B2:"#FB923C", C1:"#F87171", C2:"#C084FC" }`
  - `BOX_INTERVALS_MS` = `[0, 0, 86400000, 259200000, 604800000, 1814400000]` (index = box; box 1 = day 0)
  - `LOOKUP_KEYS` = `["lemma","pos","level","meaning","grammar","examples"]`

- [ ] **Step 1: Write the failing test**
```js
// tools/tests/learn/contracts.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const g = {}; new Function("window", readFileSync("learn/contracts.js","utf8"))(g);
test("contracts expose the frozen shapes", () => {
  const L = g.SV_LEARN;
  assert.equal(L.MSG.CAPTURE, "LEARN_CAPTURE");
  assert.deepEqual(L.CEFR, ["A1","A2","B1","B2","C1","C2"]);
  assert.equal(L.CEFR_COLOR.C2, "#C084FC");
  assert.equal(L.BOX_INTERVALS_MS[2], 86400000);
  assert.deepEqual(L.LOOKUP_KEYS, ["lemma","pos","level","meaning","grammar","examples"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/tests/learn/contracts.test.mjs`
Expected: FAIL (`learn/contracts.js` does not exist / `SV_LEARN` undefined).

- [ ] **Step 3: Write minimal implementation**
```js
// learn/contracts.js — single source of truth for the Learn suite (loaded on window).
(function (g) {
  g.SV_LEARN = {
    MSG: { CAPTURE:"LEARN_CAPTURE", LOOKUP:"LEARN_LOOKUP", LIST:"LEARN_LIST", DUE:"LEARN_DUE", GRADE:"LEARN_GRADE", BADGE:"LEARN_BADGE" },
    CEFR: ["A1","A2","B1","B2","C1","C2"],
    CEFR_COLOR: { A1:"#34D399", A2:"#A3E635", B1:"#FBBF24", B2:"#FB923C", C1:"#F87171", C2:"#C084FC" },
    BOX_INTERVALS_MS: [0, 0, 86400000, 259200000, 604800000, 1814400000],
    LOOKUP_KEYS: ["lemma","pos","level","meaning","grammar","examples"],
  };
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/tests/learn/contracts.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add learn/contracts.js tools/tests/learn/contracts.test.mjs
git commit -m "Learn: contracts module (message types, CEFR colors, Leitner intervals)"
```

---

### Task 2: Leitner engine (pure — parallel with everything)

**Files:**
- Create: `learn/leitner.js`
- Test: `tools/tests/learn/leitner.test.mjs`

**Interfaces:**
- Consumes: `SV_LEARN.BOX_INTERVALS_MS` (Task 1).
- Produces: `window.SV_LEITNER.schedule(leitner, grade, now)` → `{ box, dueAt, history }`. `grade` is `"good"|"again"`. `leitner` may be `null`/undefined (new word → treated as box 1).

- [ ] **Step 1: Write the failing test**
```js
// tools/tests/learn/leitner.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const g = {}; new Function("window", readFileSync("learn/contracts.js","utf8"))(g);
new Function("window", readFileSync("learn/leitner.js","utf8"))(g);
const S = g.SV_LEITNER, NOW = 1000000000000;
test("good promotes a box and schedules by interval", () => {
  const r = S.schedule({ box:2, dueAt:0, history:[] }, "good", NOW);
  assert.equal(r.box, 3);
  assert.equal(r.dueAt, NOW + 259200000); // box 3 = 3d
  assert.equal(r.history.at(-1).grade, "good");
});
test("good caps at box 5", () => {
  assert.equal(S.schedule({ box:5, dueAt:0, history:[] }, "good", NOW).box, 5);
});
test("again resets to box 1, due now", () => {
  const r = S.schedule({ box:4, dueAt:0, history:[] }, "again", NOW);
  assert.equal(r.box, 1);
  assert.equal(r.dueAt, NOW);
});
test("new word (null leitner) starts at box 1", () => {
  assert.equal(S.schedule(null, "good", NOW).box, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/tests/learn/leitner.test.mjs`
Expected: FAIL (`SV_LEITNER` undefined).

- [ ] **Step 3: Write minimal implementation**
```js
// learn/leitner.js — pure Leitner-box scheduling.
(function (g) {
  const IV = g.SV_LEARN.BOX_INTERVALS_MS;
  function schedule(leitner, grade, now) {
    const cur = (leitner && leitner.box) || 1;
    const box = grade === "good" ? Math.min(5, cur + 1) : 1;
    const dueAt = now + (IV[box] || 0);
    const history = ((leitner && leitner.history) || []).concat([{ at: now, grade }]);
    return { box, dueAt, history };
  }
  g.SV_LEITNER = { schedule };
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/tests/learn/leitner.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**
```bash
git add learn/leitner.js tools/tests/learn/leitner.test.mjs
git commit -m "Learn: Leitner box scheduling engine (pure, tested)"
```

---

### Task 3: Record merge logic (pure — parallel with everything)

**Files:**
- Create: `learn/record.js`
- Test: `tools/tests/learn/record.test.mjs`

**Interfaces:**
- Consumes: `SV_LEITNER.schedule` (Task 2).
- Produces: `window.SV_LEARN_REC`:
  - `recId(lemma, lang)` → `"lemma|lang"`.
  - `newRecord(lookup, capture, targetLang, now)` → full record (schema in spec §5), `leitner:{box:1,dueAt:now,history:[]}`.
  - `mergeCapture(existing, capture, now)` → clone with `capture` appended to `sources[]`, its surface form appended to `forms[]` (deduped), `updatedAt=now`; NO LLM fields touched (that's the cache).
  - `applyGrade(record, grade, now)` → clone with `leitner = SV_LEITNER.schedule(record.leitner, grade, now)`.

- [ ] **Step 1: Write the failing test**
```js
// tools/tests/learn/record.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const g = {}; for (const f of ["contracts","leitner","record"]) new Function("window", readFileSync(`learn/${f}.js`,"utf8"))(g);
const R = g.SV_LEARN_REC, NOW = 1000000000000;
const LOOKUP = { lemma:"laufen", pos:"verb", level:"A2", meaning:"to run", grammar:"strong verb", examples:[{src:"Ich laufe",tr:"I run"}] };
const CAP = { word:"läuft", sentence:"Er läuft schnell", lang:"de", videoId:"v1", site:"youtube", t:12.5, title:"Clip" };
test("newRecord builds id, box 1, one source", () => {
  const r = R.newRecord(LOOKUP, CAP, "en", NOW);
  assert.equal(r.id, "laufen|de");
  assert.equal(r.level, "A2");
  assert.equal(r.leitner.box, 1);
  assert.equal(r.sources.length, 1);
  assert.deepEqual(r.forms, ["läuft"]);
});
test("mergeCapture appends source + form, keeps meaning (cache)", () => {
  const r0 = R.newRecord(LOOKUP, CAP, "en", NOW);
  const r1 = R.mergeCapture(r0, { ...CAP, word:"lief", t:30 }, NOW + 5);
  assert.equal(r1.sources.length, 2);
  assert.deepEqual(r1.forms, ["läuft","lief"]);
  assert.equal(r1.meaning, "to run");
});
test("applyGrade advances the box", () => {
  const r0 = R.newRecord(LOOKUP, CAP, "en", NOW);
  assert.equal(R.applyGrade(r0, "good", NOW).leitner.box, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/tests/learn/record.test.mjs`
Expected: FAIL (`SV_LEARN_REC` undefined).

- [ ] **Step 3: Write minimal implementation**
```js
// learn/record.js — pure word-record construction + merge (dedup logic).
(function (g) {
  const L = g.SV_LEITNER;
  const recId = (lemma, lang) => `${lemma}|${lang}`;
  const src = (c, now) => ({ videoId:c.videoId, site:c.site, t:c.t, sentence:c.sentence, title:c.title, at:now });
  function newRecord(lookup, cap, targetLang, now) {
    return {
      id: recId(lookup.lemma, cap.lang), lemma: lookup.lemma, lang: cap.lang, targetLang,
      forms: cap.word ? [cap.word] : [], meaning: lookup.meaning, examples: lookup.examples || [],
      grammar: lookup.grammar || "", pos: lookup.pos || "", level: lookup.level || "", image: null,
      sources: [src(cap, now)], leitner: { box:1, dueAt:now, history:[] }, createdAt: now, updatedAt: now,
    };
  }
  function mergeCapture(rec, cap, now) {
    const forms = rec.forms.includes(cap.word) || !cap.word ? rec.forms : rec.forms.concat([cap.word]);
    return { ...rec, forms, sources: rec.sources.concat([src(cap, now)]), updatedAt: now };
  }
  function applyGrade(rec, grade, now) { return { ...rec, leitner: L.schedule(rec.leitner, grade, now), updatedAt: now }; }
  g.SV_LEARN_REC = { recId, newRecord, mergeCapture, applyGrade };
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/tests/learn/record.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**
```bash
git add learn/record.js tools/tests/learn/record.test.mjs
git commit -m "Learn: pure word-record construction + dedup merge (tested)"
```

---

### Task 4: Palettes + highlight in the style engine (pure resolveStyle — parallel)

**Files:**
- Modify: `shared/presets.js` (add `PALETTES`, extend `resolveStyle`, export `SV_PALETTES`)
- Modify: `styles/overlay.css` (`.sung` glow)
- Test: `tools/tests/learn/palettes.test.mjs`

**Interfaces:**
- Produces: `window.SV_PALETTES` = `{ aurora:{label,hl,glow}, cyber, matrix, bubblegum, violet, ember, ice, rose }` (highlight-only moods). `resolveStyle(settings)` now honors `settings.palette` (overrides `--cs-hl`), `settings.styleCustom.hl` (custom hex, wins), and emits `--cs-hl-glow`.
- Constraint: palette overrides ONLY the highlight, never text/bg — so any palette works on any shape preset (Pill's black-on-white stays intact).

- [ ] **Step 1: Write the failing test**
```js
// tools/tests/learn/palettes.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const g = {}; new Function("window", readFileSync("shared/langs.js","utf8"))(g); // no-op safety if referenced
new Function("window", readFileSync("shared/presets.js","utf8"))(g);
const R = g.SV_RESOLVE_STYLE;
test("a palette recolors only the highlight", () => {
  const v = R({ stylePreset:"classic", palette:"matrix" }).vars;
  assert.equal(v["--cs-hl"], "#4dff5a");
  assert.equal(v["--cs-color"], "#ffffff");           // text untouched
  assert.match(v["--cs-hl-glow"], /#4dff5a/);          // glow palette → neon glow
});
test("custom highlight hex wins over the palette", () => {
  const v = R({ stylePreset:"classic", palette:"matrix", styleCustom:{ hl:"#ff0000" } }).vars;
  assert.equal(v["--cs-hl"], "#ff0000");
});
test("no palette keeps the preset's own highlight (Pill amber)", () => {
  assert.equal(R({ stylePreset:"pill" }).vars["--cs-hl"], "#c47500");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/tests/learn/palettes.test.mjs`
Expected: FAIL (`--cs-hl` still preset gold; no palette handling).

- [ ] **Step 3: Write minimal implementation**

In `shared/presets.js`, add before `resolveStyle`:
```js
  // Highlight (karaoke) color moods — recolor ONLY the swept word, so any mood
  // works on any shape preset. "glow" adds a neon halo on the swept word.
  const PALETTES = {
    aurora:{label:"Aurora",hl:"#3df2c6",glow:true}, cyber:{label:"Cyber",hl:"#22e0ff",glow:true},
    matrix:{label:"Matrix",hl:"#4dff5a",glow:true}, bubblegum:{label:"Bubblegum",hl:"#ff5bd0",glow:true},
    violet:{label:"Violet",hl:"#b98cff",glow:true}, ember:{label:"Ember",hl:"#ff8a5c",glow:true},
    ice:{label:"Ice",hl:"#8fd0ff",glow:false}, rose:{label:"Rose",hl:"#ff6fa0",glow:false},
  };
```
Inside `resolveStyle`, after `let fonts = preset.fonts.slice();`:
```js
    const pal = PALETTES[settings && settings.palette];
    if (pal) st.hl = pal.hl;
```
After the existing `if (typeof c.color === "string" ...)` line, add the custom highlight override:
```js
    if (typeof c.hl === "string" && /^#[0-9a-f]{6}$/i.test(c.hl)) st.hl = c.hl;
```
Before `return {`, compute the glow, and add `"--cs-hl-glow"` to `vars`:
```js
    const hlGlow = pal && pal.glow ? `0 0 0.5em ${st.hl}, 0 0 0.16em ${st.hl}` : st.shadow;
```
Add to the `vars` object: `"--cs-hl-glow": hlGlow,`
At the bottom exports add: `window.SV_PALETTES = PALETTES;`

In `styles/overlay.css`, change the `.sung` rule to apply the glow:
```css
#copilot-subs .copilot-subs__w.sung {
  color: var(--cs-hl, #ffd479);
  text-shadow: var(--cs-hl-glow, inherit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/tests/learn/palettes.test.mjs`
Expected: PASS (3 tests). Also run `node --test "tools/tests/**/*.test.mjs"` — no regressions.

- [ ] **Step 5: Commit**
```bash
git add shared/presets.js styles/overlay.css tools/tests/learn/palettes.test.mjs
git commit -m "Style: highlight-color palettes + custom highlight + neon glow (--cs-hl-glow)"
```

---

### Task 5: Palette row + highlight picker in the popup Style tab

**Files:**
- Modify: `popup.html` (palette swatch row + `#styleHl` color input + `.palettes`/`.swatch` CSS)
- Modify: `popup.js` (`DEFAULTS.palette=""`, `buildPaletteRow()`, palette click → `persist({palette})`, `#styleHl` → `setCustom({hl})`, hydrate in `updateStyleUI`)
- Verify: chrome-devtools stub render (no automated test — DOM/visual)

**Interfaces:**
- Consumes: `SV_PALETTES` (Task 4), existing `setCustom`, `resolveStyle`, `paintStyled`, `updateStyleUI`.
- Produces: a `palette` global setting; `styleCustom.hl` custom color.

- [ ] **Step 1: markup** — In the Style pane, after `#presetRow`, add:
```html
<div class="lbl" style="margin-top:2px;">Highlight <span class="hint">the karaoke sweep</span></div>
<div class="palettes" id="paletteRow"></div>
```
In the Customize section, after the text-color row, add:
```html
<div class="row"><span class="rowlbl">Highlight</span><input type="color" id="styleHl" value="#ffd479" title="Karaoke highlight color" /></div>
```
Add CSS: `.palettes{display:flex;flex-wrap:wrap;gap:6px} .swatch{width:26px;height:26px;border-radius:7px;border:2px solid var(--border);cursor:pointer} .swatch.on{border-color:var(--accent)} .swatch.def{background:var(--panel2);font-size:10px;color:var(--muted);display:flex;align-items:center;justify-content:center}`

- [ ] **Step 2: wiring** — In `popup.js`:
  - Add `palette: ""` to `DEFAULTS`.
  - Add `buildPaletteRow()`: a "Default" swatch (`data-pal=""`, class `def`, text "A") then one swatch per `SV_PALETTES` entry with `style.background = hl`, `data-pal = key`, `title = label`; click → `state.palette = key; persist({palette:key}); updateStyleUI()`.
  - Add `el("styleHl").addEventListener("input", ...)` debounced → `setCustom({ hl: el("styleHl").value })`.
  - In `updateStyleUI`: mark active swatch (`.on` where `data-pal === (state.palette||"")`); set `el("styleHl").value = resolveStyle(state).vars["--cs-hl"]`.
  - Call `buildPaletteRow()` next to `buildPresetRow()` at load.

- [ ] **Step 3: verify in browser** — Render `popup.html` with the chrome stub (seed `{stylePreset:"classic"}`), select Style tab. Confirm: palette swatches render; clicking "Matrix" sets `state.palette==="matrix"` and the preview highlight turns neon green; the `#styleHl` picker reflects/overrides it; "Default" restores the preset highlight. (Use the same stub pattern as the mode-switch verification.)

- [ ] **Step 4: Commit**
```bash
git add popup.html popup.js
git commit -m "Style tab: highlight palette swatches + highlight color picker"
```

---

### Task 6: IndexedDB word store wrapper

**Files:**
- Create: `learn/store.js`
- Verify: chrome-devtools stub render (IndexedDB is a browser API; verify in-page, not node)

**Interfaces:**
- Consumes: `SV_LEARN_REC` (Task 3).
- Produces: `window.SV_LEARN_STORE` (async): `open()`, `get(id)`, `capture(lookup, cap, targetLang, now)` (upsert: new→`newRecord`, existing→`mergeCapture`), `list(filter)`, `due(now)`, `countDue(now)`, `grade(id, grade, now)`.
- DB: name `subvibe-learn`, store `words` keyed by `id`, index `dueAt` on `leitner.dueAt`, index `level`.

- [ ] **Step 1: implement** the wrapper (standard IndexedDB open/upgrade; `capture` reads then writes via `SV_LEARN_REC`; `due`/`countDue` scan the `dueAt` index `<= now`).
- [ ] **Step 2: verify in browser** — In a devtools page, load contracts/leitner/record/store, then: `capture(LOOKUP, CAP)` twice with the same lemma → `list()` returns ONE record with 2 sources (dedup proven); `grade(id,"good")` advances box; `countDue(now)` counts box-1 words. Assert via `evaluate_script`.
- [ ] **Step 3: Commit**
```bash
git add learn/store.js
git commit -m "Learn: IndexedDB word store (dedup upsert, due queries)"
```

---

## Self-review notes

- Spec coverage: §5 data model → Task 3/6; §7 lookup schema keys → Task 1; §8 CEFR colors → Task 1; palettes/§ colors → Task 4/5; Leitner §4.4 → Task 2. Capture (§4.1), lookup service (§4.2), popup/Library display (§4.5/4.6), reminders (§4.7/9), clip links, pictures (§10) → **follow-up plans** (below).
- Type consistency: `schedule(leitner,grade,now)`, `newRecord/mergeCapture/applyGrade`, `SV_PALETTES`, `--cs-hl`/`--cs-hl-glow`, `SV_LEARN.MSG/CEFR_COLOR/BOX_INTERVALS_MS` used identically across tasks.
- No placeholders: every code step is complete; browser-verified tasks (5,6) touch DOM/IndexedDB, which can't run under `node --test`, so they specify exact in-browser assertions instead of unit tests.

## Follow-up plans (build after this foundation lands)

Each is its own spec→plan cycle, all consuming the frozen contracts above:

- **P1 — Capture + Lookup + Display.** `content/common.js` tappable words → `LEARN_CAPTURE`; `background.js` + `learn/lookup.js` (LLM structured call reusing the translation provider/key, JSON per §7, writes via `SV_LEARN_STORE`); minimal word list in a new popup "Learn" tab and a Library section. Parallel sub-tracks: capture (content), lookup (background), display (popup + library) — each against the frozen message API.
- **P2 — Leitner review + due badge.** Review UI (popup quick-review + Library sessions) over `SV_LEARN_STORE.due`; `chrome.action.setBadgeText` painting `countDue()`.
- **P3 — Clip links + CEFR colors.** "▶ jump to the moment" from `sources[]`; level color chips using `SV_LEARN.CEFR_COLOR`.
- **P4 — Pictures + opt-in notifications.** Populate `record.image` (source TBD at P4: free image search vs AI-gen — likely a new permission → separate store submission); optional `notifications`/`alarms`.

## Manifest note

Add `learn/contracts.js`, `learn/leitner.js`, `learn/record.js` to the content-script `js` arrays (before `content/common.js`) and load them in `popup.html`/`library.html` in P1 when the consumers land — NOT in this foundation plan (the foundation modules have no runtime consumer yet; wiring them in without a caller would be dead weight). Tasks 4–5 (palettes) DO ship to users now.
