# Word game — step 1 (core game) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Ship the arcade Learn tab with the word-meaning game: deck cards per language, scope + pacing, the game loop (correct/wrong moments, records), the words fold, trainer Practice/Words restructure, and the no-„ quotes rule.

**Architecture:** A pure, node-tested session engine (`shared/game.js`) does all selection/pacing/records logic; popup.js only renders and forwards taps. Cards come from the existing background vocab store via `VOCAB_LIST`; grades persist via `VOCAB_GRADE`; "know it" via a new `VOCAB_KNOWN`. Scope/pacing/records live in `chrome.storage.local` (`gameScope`, `gamePace`, `gameRecords`, `gameIntro` — all keyed per language). Trainer page reuses the same engine.

**Tech stack:** Plain JS/HTML/CSS on the Daylight tokens; node:test in tools/tests; browser harnesses untouched.

**Spec:** docs/superpowers/specs/2026-08-11-word-game-design.md (read §1–§4, Acceptance).

## Global Constraints

- Branch `word-game`. No AI trailers in commits.
- **No stress numbers**: no due counts on entry points; records celebrate only.
- **No „ anywhere in generated UI** (test-enforced). Sentences in cards render italic, no surrounding quotes, via textContent (no innerHTML for user data except the established static-flag pattern).
- All popup.js-referenced ids exist in popup.html at every commit (tools/tests/popup-ids.test.mjs stays green; markup task adds ids before/with the JS that uses them).
- Existing Learn-pane ids (lnLang, lnLvls, lnPos, lnWords, lnEnrich, lnFoot, lnOpenFull, lnAddAll, lnDir) KEEP existing — lnAddAll becomes hidden-permanently (JS stops showing it) but stays in DOM this step.
- Theme: tokens only; works light + dark. `prefers-reduced-motion` disables all game animation.
- Suite must stay green: `node --test tools/tests/*.test.mjs` + `node tools/audit.mjs`.
- Card schema (existing, do not rename): `word, lemma, lang, cefr, pos, meaning, sentence, sentenceT, phrase, note, box (1-5), nextDueAt, lastGradedAt, history, videoTitle, base, channel?` (channel added at save in this step), `sep?` (bool, may be absent).
- Status derivation: **new** = no `lastGradedAt`; **learning** = graded, box 1–4; **mastered** = box 5.

---

### Task 1: `shared/game.js` + `shared/quotes.js` wrap change (pure logic, node-tested)

**Files:** Create `shared/game.js`, `tools/tests/game.test.mjs` · Modify `shared/quotes.js`, `tools/tests/quotes.test.mjs`

**Produces (exact API consumed by Tasks 3–4):**
```js
globalThis.SV_GAME = {
  status(card) -> "new" | "learning" | "mastered",
  matchesScope(card, scope) -> bool,        // scope = { source, minLevel, pos }
  buildSession({ cards, scope, perDay, introducedToday, now, rng, size = 10 })
    -> { items: [card...], newCount },      // due-first (leitner order), then paced-in new
  distractors(card, pool, rng, n = 3) -> [meaning strings],
  shuffle(arr, rng) -> new array,
  updateRecords(records, { correct, total, seconds, speedBonuses, perfect }, dayKey)
    -> { records, newRecords: [labels] },   // streakDays, bestRound, fastestPerfectSec, bestSpeedBonuses
}
```
Scope semantics: `source` = `""` (everything) | `"base:<clipBase>"` | `"channel:<name>"`; `minLevel` = `""|"A2"|"B1"|"C1"` (CEFR order A1<A2<B1<B2<C1<C2, unknown level passes only when `""`); `pos` = `""|"noun"|"verb"|"sep"|"adj"|"adv"|"phrase"` — `"sep"` matches `card.sep === true` OR `/\|/.test(card.lemma || "")`.

- [ ] **Step 1: failing tests** — write `tools/tests/game.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/leitner.js";
import "../../shared/game.js";

const G = globalThis.SV_GAME;
const DAY = 86400000;
const NOW = 1e12;
const rng = (() => { let s = 42; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
const card = (o) => ({ word: o.w, lang: "de", cefr: o.c || "B1", pos: o.p || "noun",
  meaning: o.m || ("m-" + o.w), sentence: "s " + o.w, base: o.b || "youtube:v1",
  channel: o.ch || "Easy German", lemma: o.lm || o.w, ...o });

test("status: new / learning / mastered", () => {
  assert.equal(G.status(card({ w: "a" })), "new");
  assert.equal(G.status(card({ w: "b", lastGradedAt: 1, box: 2 })), "learning");
  assert.equal(G.status(card({ w: "c", lastGradedAt: 1, box: 5 })), "mastered");
});

test("scope: source, level floor, pos incl separable", () => {
  const c = card({ w: "aufstehen", p: "verb", lm: "auf|stehen", c: "A2" });
  assert.ok(G.matchesScope(c, { source: "", minLevel: "", pos: "sep" }));
  assert.ok(G.matchesScope(c, { source: "channel:Easy German", minLevel: "A2", pos: "" }));
  assert.ok(!G.matchesScope(c, { source: "channel:Other", minLevel: "", pos: "" }));
  assert.ok(!G.matchesScope(c, { source: "", minLevel: "B1", pos: "" }));
  assert.ok(!G.matchesScope(card({ w: "x", c: "?" }), { source: "", minLevel: "A2", pos: "" }));
  assert.ok(G.matchesScope(c, { source: "base:youtube:v1", minLevel: "", pos: "verb" }));
});

test("buildSession: due reviews first, new capped by pacing, size 10", () => {
  const due = Array.from({ length: 4 }, (_, i) => card({ w: "due" + i, lastGradedAt: 1, box: 1, nextDueAt: NOW - DAY }));
  const fresh = Array.from({ length: 30 }, (_, i) => card({ w: "new" + i }));
  const s = G.buildSession({ cards: [...fresh, ...due], scope: { source: "", minLevel: "", pos: "" },
    perDay: 20, introducedToday: 14, now: NOW, rng });
  assert.equal(s.items.length, 10);
  assert.deepEqual(s.items.slice(0, 4).map((c) => c.word).sort(), ["due0", "due1", "due2", "due3"]);
  assert.equal(s.newCount, 6);                       // 20/day − 14 already introduced
  assert.ok(s.items.slice(4).every((c) => G.status(c) === "new"));
});

test("buildSession: never introduces beyond allowance; mastered excluded", () => {
  const done = card({ w: "done", lastGradedAt: 1, box: 5, nextDueAt: NOW - DAY });
  const s = G.buildSession({ cards: [done, ...Array.from({ length: 9 }, (_, i) => card({ w: "n" + i }))],
    scope: { source: "", minLevel: "", pos: "" }, perDay: 20, introducedToday: 20, now: NOW, rng });
  assert.equal(s.newCount, 0);
  assert.ok(!s.items.some((c) => c.word === "done"), "mastered cards never appear");
  assert.equal(s.items.length, 0);
});

test("distractors: 3 unique meanings, never the answer, prefer same pos", () => {
  const target = card({ w: "t", m: "right", p: "verb" });
  const pool = [target, card({ w: "a", m: "right" }), card({ w: "b", m: "w1", p: "verb" }),
    card({ w: "c", m: "w2", p: "verb" }), card({ w: "d", m: "w3", p: "noun" }), card({ w: "e", m: "w1" })];
  const d = G.distractors(target, pool, rng);
  assert.equal(d.length, 3);
  assert.ok(!d.includes("right"));
  assert.equal(new Set(d).size, 3);
  assert.ok(d.includes("w1") && d.includes("w2"), "same-pos meanings preferred");
});

test("shuffle: permutation, deterministic under seeded rng, input untouched", () => {
  const a = [1, 2, 3, 4, 5];
  const out = G.shuffle(a, rng);
  assert.deepEqual([...out].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(a, [1, 2, 3, 4, 5]);
});

test("records: streak counts consecutive days; bests only improve; new-record labels", () => {
  let r = { };
  let u = G.updateRecords(r, { correct: 8, total: 10, seconds: 42, speedBonuses: 5, perfect: false }, "2026-08-11");
  assert.equal(u.records.streakDays, 1);
  assert.equal(u.records.bestRound, 8);
  assert.ok(u.newRecords.length >= 1);
  u = G.updateRecords(u.records, { correct: 7, total: 10, seconds: 50, speedBonuses: 1, perfect: false }, "2026-08-12");
  assert.equal(u.records.streakDays, 2);
  assert.equal(u.records.bestRound, 8, "a worse round never lowers a best");
  u = G.updateRecords(u.records, { correct: 10, total: 10, seconds: 39, speedBonuses: 2, perfect: true }, "2026-08-14");
  assert.equal(u.records.streakDays, 1, "a skipped day restarts the streak");
  assert.equal(u.records.fastestPerfectSec, 39);
});
```

And extend `tools/tests/quotes.test.mjs`:

```js
test("wrap: never German low-quotes — operator rule; curly for Latin incl. de, guillemets for fa", () => {
  assert.equal(Q.wrap("Hallo", "de"), "“Hallo”");
  assert.equal(Q.wrap("سلام", "fa"), "«سلام»");
  assert.ok(!Q.wrap("x", "de").includes("„"));
});
```

- [ ] **Step 2: run — expect FAIL** (`node --test tools/tests/game.test.mjs tools/tests/quotes.test.mjs`)
- [ ] **Step 3: implement `shared/game.js`:**

```js
// Pure session engine for the word game. No DOM, no chrome.* — node-tested.
// Selection: genuinely due reviews first (leitner order), then NEW cards up
// to the day's remaining allowance. Mastered (box 5) cards never enter
// rounds — finished words rest (spec's calm rule); "know it" and a fifth
// correct answer both land there.
(function (g) {
  const ORDER = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };

  function status(card) {
    if (!card.lastGradedAt) return "new";
    return (card.box || 1) >= 5 ? "mastered" : "learning";
  }

  function isSep(card) {
    return card.sep === true || /\|/.test(card.lemma || "");
  }

  function matchesScope(card, scope) {
    const s = scope || {};
    if (s.source) {
      if (s.source.startsWith("base:") && card.base !== s.source.slice(5)) return false;
      if (s.source.startsWith("channel:") && card.channel !== s.source.slice(8)) return false;
    }
    if (s.minLevel) {
      const lv = ORDER[card.cefr] || 0;
      if (!lv || lv < ORDER[s.minLevel]) return false;
    }
    if (s.pos) {
      if (s.pos === "sep") { if (!isSep(card)) return false; }
      else if ((card.pos || "other") !== s.pos) return false;
    }
    return true;
  }

  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function buildSession({ cards, scope, perDay, introducedToday, now, rng, size = 10 }) {
    const inScope = (cards || []).filter((c) => matchesScope(c, scope));
    const due = g.SV_LEITNER.sessionOrder(
      g.SV_LEITNER.dueCards(inScope.filter((c) => status(c) === "learning"), now));
    const allowance = Math.max(0, (perDay || 20) - (introducedToday || 0));
    const fresh = shuffle(inScope.filter((c) => status(c) === "new"), rng);
    const items = due.slice(0, size);
    const newCount = Math.min(allowance, Math.max(0, size - items.length), fresh.length);
    items.push(...fresh.slice(0, newCount));
    return { items, newCount };
  }

  function distractors(card, pool, rng, n = 3) {
    const seen = new Set([card.meaning]);
    const pick = (list, out) => {
      for (const c of shuffle(list, rng)) {
        if (out.length >= n) break;
        const m = (c.meaning || "").trim();
        if (m && !seen.has(m)) { seen.add(m); out.push(m); }
      }
      return out;
    };
    const out = pick(pool.filter((c) => c !== card && c.pos === card.pos), []);
    return pick(pool.filter((c) => c !== card), out);
  }

  function updateRecords(records, round, dayKey) {
    const r = { ...(records || {}) };
    const newRecords = [];
    const prevDay = r.lastDay;
    if (prevDay !== dayKey) {
      const y = new Date(dayKey + "T00:00:00Z").getTime() - 86400000;
      const yKey = new Date(y).toISOString().slice(0, 10);
      r.streakDays = prevDay === yKey ? (r.streakDays || 0) + 1 : 1;
      r.lastDay = dayKey;
      if ((r.streakDays || 0) > (r.bestStreak || 0)) { r.bestStreak = r.streakDays; if (r.streakDays > 1) newRecords.push("streak"); }
    }
    if ((round.correct || 0) > (r.bestRound || 0)) { r.bestRound = round.correct; newRecords.push("bestRound"); }
    if (round.perfect && (!r.fastestPerfectSec || round.seconds < r.fastestPerfectSec)) {
      r.fastestPerfectSec = round.seconds; newRecords.push("fastestPerfect");
    }
    if ((round.speedBonuses || 0) > (r.bestSpeedBonuses || 0)) { r.bestSpeedBonuses = round.speedBonuses; newRecords.push("speedBonuses"); }
    return { records: r, newRecords };
  }

  g.SV_GAME = { status, matchesScope, buildSession, distractors, shuffle, updateRecords };
})(globalThis);
```

And in `shared/quotes.js` wrap(): delete the `if (l === "de") return "„" + s + "“";` line (operator rule — UI never prints „).

- [ ] **Step 4: run — all green** (also full suite)
- [ ] **Step 5: commit** `Word game: pure session engine (scope, pacing, distractors, records) + no-low-quote rule`

---

### Task 2: popup arcade + fold markup/CSS (HTML/CSS only)

**Files:** Modify `popup.html` (Learn pane + styles)

Restructure `div.pane[data-pane="learn"]` to:

```html
<div class="pane" data-pane="learn" hidden>
  <section id="arcade">
    <div class="lbl">Your games <button class="linkbtn" id="lnOpenFull">Full trainer →</button></div>
    <div id="deckCards"></div>
  </section>
  <section id="gameView" hidden>
    <div class="gamecard card">
      <div class="gamehead">
        <button id="gameBack" class="linkbtn">← Done</button>
        <div id="gameDots" class="gamedots"></div>
        <span id="gameStreak" class="gamestreak"></span>
        <span id="gameRing" class="gamering" hidden></span>
      </div>
      <div id="gameBody"></div>
    </div>
  </section>
  <section>
    <details class="customize" id="clipWordsFold">
      <summary>This video's words <span class="hint" id="lnCount"></span>
        <button class="linkbtn" id="lnPlayThese" hidden>Play only these →</button></summary>
      <!-- MOVE the ENTIRE existing Learn-pane content here VERBATIM:
           the Learning row (lnLang/lnDir), lnLvls chips + lnPos, lnAddAll
           (keep, stays hidden), lnWords, lnEnrich, lnFoot. No id changes. -->
    </details>
  </section>
</div>
```

CSS (tokens only): `.deckcard` (flex card: flag 24px, name 14px/700, scope line 10.5px muted with teal filter words, mini 3-seg bar 5px, Play = `.btn-primary`-style coral pill), `.deckcard.hot` coral border for the deck with due reviews; `.gamedots` (8px dots, `--surface-2` / teal done / coral current); `.gamering` (18px conic-gradient amber ring); game option rows `.gopt` (full-width, radius 10, `--surface-2` bg at rest, `.hit` teal / `.miss` coral + strike, `.reveal` dashed coral info row); `.gsent` italic 13px `--ink-2` **no quote marks**; word 20px/800; chip = existing `.lvl` style; round-end `.ringbig` 74px conic; `.recordbanner` coral-soft slide-in; keyframes `gpop`, `gshake`, `gslide` all guarded by `prefers-reduced-motion`. Status dot classes `.wdot.new/.learn/.done` for the fold rows (JS applies in Task 3).

- [ ] Steps: restructure → `node --test tools/tests/*.test.mjs` green (popup-ids test: no JS references removed; new ids unused so far is fine) → visual sanity over http (light+dark) → commit `Word game: arcade + game-view + fold markup (popup)`.

---

### Task 3: popup.js game wiring

**Files:** Modify `popup.js`, `background.js` (one new message), `tools/store-screenshots/popup-stub.js` (keep capture recipe working)

- Load order: popup.html already loads shared/leitner? NO — add `<script src="shared/leitner.js">` and `<script src="shared/game.js">` before popup.js (Task 2 misses this — do it here with the JS that needs it).
- **Deck render**: on Learn-pane show, `send({type:"VOCAB_LIST"})` → group cards by `lang`; for each lang render a `.deckcard` (flag from `langMeta`, name, scope sentence from stored `gameScope[lang]` defaults `{source:"",minLevel:"",pos:""}`, mini-bar from status counts, Play button). Storage keys: `gameScope`, `gamePace` (default 20), `gameRecords`, `gameIntro` (`{ [lang]: { day, count } }`) via `chrome.storage.local`.
- **Play**: build session via `SV_GAME.buildSession` (rng = `Math.random`), hide `#arcade` + fold, show `#gameView`; render cards one at a time into `#gameBody`:
  - word card: sentence (textContent, italic), word, cefr chip, 4 options = `SV_GAME.shuffle([meaning, ...distractors], rng)`; each option a `<button class="gopt" dir="auto">`.
  - correct tap: `.hit` class, `+1` float (CSS anim), streak++, ⚡ if ring alive; `send({type:"VOCAB_GRADE", word, lang, ok:true})`; advance after 800ms.
  - wrong tap: `.miss` + shake; reveal row under it: `💡 <meaning> = <word whose meaning it was> — <its sentence>` (find owner card of that distractor meaning in pool — textContent only); light the correct option `.hit`; streak→0; `VOCAB_GRADE ok:false`; requeue card ~3 positions later; show `Next →` button (no auto-advance).
  - ring: 6s CSS conic countdown per card; expiry = no bonus only.
  - every answer updates `gameIntro` for new cards (first grade of a "new" card counts as introduced).
- **Round end**: score ring, `SV_GAME.updateRecords` (dayKey = local ISO date), 🏆 banner when `newRecords.length`, missed words list (word · meaning · sentence, textContent), buttons One more round / Done. Persist records.
- **Scope "Change"**: inline sheet in the deck card (chips: source Everything/This video/top-3 channels by unlearned count + search input reusing `.ac`/`.menu` pattern; level All/A2+/B1+/C1+; type All/Nouns/Verbs/Separable/Phrases; Game row hidden this step). Persist to `gameScope[lang]`.
- **"Play only these →"** on the fold: session with `scope.source = "base:" + clipBase`.
- **Fold extras**: status dots on `lnWords` rows (from box/lastGradedAt via `SV_GAME.status` — VOCAB_CLIP_WORDS response must include those fields; extend the background handler if it strips them); `know it ✓` link per row → new background message `VOCAB_KNOWN {word, lang}` → sets box 5 + `lastGradedAt`, `nextDueAt = now + 16*DAY`; `lnAddAll` permanently hidden; retire `learnDue`-style counts (none shown).
- **No stress numbers**: deck card shows NO due count — the `.hot` border alone marks "worth playing"; mini-bar has no numerals.
- Update `popup-stub.js` so store captures keep working: stub `VOCAB_LIST` (12 German + 4 Italian demo cards with boxes spread) and `VOCAB_KNOWN`/`VOCAB_GRADE` ok:true responses.
- [ ] Steps: implement → `node --test tools/tests/*.test.mjs` green → live check over http with the stub (arcade renders, full round playable incl. wrong-answer reveal, records persist across reopen) → commit `Word game: popup wiring — decks, rounds, records, know-it, scope` .

---

### Task 4: trainer restructure (learn.html + learn.js)

**Files:** Modify `learn.html`, `learn.js`

- Tabs: `Leitner·Inbox·Dictionary` → **`Practice` · `Words`** (keep ids `tabs`/`data-tab` pattern; panes renamed `practice`/`words`; stored tab value migrates: unknown → practice).
- **Practice pane**: deck cards (same renderer semantics as popup — duplicate lean markup is acceptable this step), records strip (`🔥 streak · best round · fastest perfect`), progress bar (new/learning/mastered stacked, tokens colors, no numerals on the bar; counts 11px muted in legend), Start review → the SAME game loop (port the popup game renderer into learn.js at trainer scale, or simplest: reuse identical code — factor the DOM-side round runner into `shared/gameui.js` consumed by both popup.js and learn.js), "How the schedule works" fold containing the old boxes explanation.
- **Words pane**: merge Inbox+Dictionary: search input; chips (source dropdown, level, type, status new/practicing/mastered); rows = dot · word · CEFR chip · meaning · sentence (italic, amber `<b>` on the word, NO quotes) · source title; `know it ✓` per row (VOCAB_KNOWN); clicking a row opens the existing detail/conjugation affordances where present. Inbox promote/dismiss flows retired (VOCAB_PROMOTE/DISMISS calls removed from learn.js; background handlers stay for now).
- Grade buttons in any remaining flip-review keep coral-100/teal-100 per Daylight spec §5.
- [ ] Steps: implement → suite green → visual over http (light+dark; RTL meanings) → commit `Word game: trainer Practice + Words (inbox/dictionary merged)` .

---

### Task 5: no-„ enforcement test + channel capture

**Files:** Create `tools/tests/no-low-quotes.test.mjs` · Modify `content/common.js` (channel at save), `background.js` if VOCAB_ADD strips fields

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const FILES = ["popup.html", "popup.js", "learn.html", "learn.js", "shared/game.js", "shared/gameui.js"];
test("generated UI never prints German low-quotes", () => {
  for (const f of FILES) {
    if (!fs.existsSync(new URL("../../" + f, import.meta.url))) continue;
    const s = fs.readFileSync(new URL("../../" + f, import.meta.url), "utf8");
    assert.ok(!s.includes("„"), f + " contains „ — UI must use curly/guillemets (spec rule)");
  }
});
```
(shared/quotes.js is exempt: it CONSUMES „ from source text — the test list above deliberately excludes it and content/common.js display paths, which pass through source subtitles.)

- Channel: where the word-save payload is built in content/common.js (VOCAB_ADD / VOCAB_ADD_MANY senders), add `channel: adapter?.getChannel?.() || ""`; implement `getChannel` in the YouTube adapter (`ytd-channel-name` / `#owner #channel-name` text, trimmed) and return `""` elsewhere. Background: ensure the field persists on the stored card.
- [ ] Steps: test red on any „ (verify by grep first) → implement → green → commit `Word game: no-low-quote guard + channel capture at save`.

---

### Task 6: acceptance sweep + PR

- [ ] `node --test tools/tests/*.test.mjs` (all, incl. 7+ new game tests) · `node tools/audit.mjs` · `./build.sh` + `--firefox` (zips list shared/game.js, shared/gameui.js if created)
- [ ] Browser harnesses: adopt 7/7 · track-switch 6/6 · vocab 26/26 (serve http, cache-bust)
- [ ] Live popup check with stub: full round both outcomes, reduced-motion (System Settings) kills animations, dark theme sane, RTL meanings correct
- [ ] Push branch, `gh pr create` (base main) with a body summarizing spec §1–§3 step 1 scope; **do not merge** — operator reviews the game feel first
