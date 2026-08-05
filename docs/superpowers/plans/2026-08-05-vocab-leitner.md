# Vocabulary Leitner Box + Karaoke Highlight Styles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local-first Leitner vocabulary trainer fed by the subtitle cache (click-to-save + free worker-built inbox, batched enrichment only for promoted words, article-quiz cards, on-demand conjugations) plus five pure-CSS karaoke highlight styles.

**Architecture:** Same pattern as everything else in SubVibe — the background worker owns storage (new `vocab` object store, DB v2→3) and network; pages/content talk to it over runtime messages. Pure logic lives in `shared/*.js` modules attached to `globalThis` (the `shared/pricing.js` pattern) so the worker's `importScripts`, page `<script src>`, and `node --test` all share one copy. The subtitle engine gains exactly ONE feature (a click handler on karaoke word spans); the inbox is built entirely worker-side from the `tracks` store.

**Tech Stack:** Vanilla JS/HTML/CSS, MV3, IndexedDB, `node --test`. No build step, no dependencies.

**Spec:** `docs/superpowers/specs/2026-08-05-vocab-leitner-design.md` (operator-approved).

## Global Constraints

- Economy is a hard requirement: capture, inbox, review, browse = **0 API calls**. Enrichment = ceil(N/50) requests, only for promoted words, user-triggered, priced up front, logged through `logCall`/`SV_PRICING`. Conjugation = 1 request per verb ever (cached on the card).
- Boxes 1–5, review intervals `[1, 2, 4, 8, 16]` days; box 5 stays 16. Wrong → box 1.
- `karaokeStyle` values: `"classic" | "neon-cyan" | "neon-magenta" | "ember" | "aurora"`, default `"classic"`, GLOBAL setting, applied live (LIVE_KEYS restyle, no engine restart). Aurora = CSS keyframe gradient on `background-clip: text`, falling back to classic gold where unsupported.
- Vocab store keys: cards `${lang}:${lowercased word}`, inbox rows `inbox:${base}`, tombstones `dismissed:${lang}`. DB `copilot-subs` version 2→3 adds object store `vocab`.
- NO harvest hook in the subtitle engine. The worker builds the inbox from the `tracks` store it already owns.
- No new Chrome-only APIs (IndexedDB + runtime messages + `tabs.create` only) — Learn page ships identically in the Firefox build.
- Engine regression gates before finishing: adopt-harness **7/7**, live-shift **13/13**, all `node --test tools/tests/*.test.mjs` green.
- **House rules:** author commits as `Novid <support@nimanou.com>` (already configured), NO AI/assistant trailers in commit messages. Do NOT commit the pre-existing unrelated working-tree changes (`manifest.json` version bump, `marker.png`) — they belong to another effort; never `git add` them.
- Documented deviations from the spec (decided during planning, consistent with its intent):
  1. `VOCAB_INBOX_PUT` is dropped — the spec's own improvement (worker-built inbox) made it dead code. Nothing ever sends it.
  2. `VOCAB_DUE_COUNT` message added — the popup chip needs a count without loading every card.
  3. Inbox word entries carry an optional `st` (first sentence's cached translation) so promoted cards keep the translation the click-to-save path would have had.
  4. `lang` resolution: content sends a hint from the intercepted timedtext URL's `lang=` param when present; otherwise the worker detects de/en by stopword hit-rate (`SV_STOPWORDS.detect`); undetectable → `"xx"` bucket (still fully usable; article cards only render when enrichment returned an article).

---

### Task 1: `shared/leitner.js` — pure box math + node tests

**Files:**
- Create: `shared/leitner.js`
- Test: `tools/tests/leitner.test.mjs`

**Interfaces:**
- Consumes: nothing (pure; `globalThis` attach like `shared/pricing.js`).
- Produces: `SV_LEITNER = { DAY, INTERVALS, grade(card, ok, now) → newCard, dueCards(cards, now) → cards[], sessionOrder(cards) → cards[] }`. `grade` never mutates its input; history capped at 20.

- [ ] **Step 1: Write the failing test**

Create `tools/tests/leitner.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/leitner.js";

const L = globalThis.SV_LEITNER;
const DAY = 86400000;
const T0 = 1_754_000_000_000; // fixed epoch — no wall-clock in tests

const card = (over = {}) => ({ word: "Hund", lang: "de", box: 1, nextDueAt: T0, addedAt: T0, history: [], ...over });

test("intervals are [1,2,4,8,16] days and box 5 caps at 16", () => {
  assert.deepEqual(L.INTERVALS, [1, 2, 4, 8, 16]);
});

test("good grades climb 1→2→3→4→5 and stay at 5", () => {
  let c = card();
  for (const [box, days] of [[2, 2], [3, 4], [4, 8], [5, 16], [5, 16]]) {
    c = L.grade(c, true, T0);
    assert.equal(c.box, box);
    assert.equal(c.nextDueAt, T0 + days * DAY);
  }
});

test("a wrong answer sends any box back to 1, due tomorrow", () => {
  const c = L.grade(card({ box: 4 }), false, T0);
  assert.equal(c.box, 1);
  assert.equal(c.nextDueAt, T0 + 1 * DAY);
});

test("grade returns a NEW object and stamps lastGradedAt + history", () => {
  const before = card();
  const after = L.grade(before, true, T0);
  assert.notEqual(after, before);
  assert.equal(before.box, 1); // input untouched
  assert.equal(after.lastGradedAt, T0);
  assert.deepEqual(after.history, [{ at: T0, ok: true }]);
});

test("history keeps only the last 20 grades", () => {
  let c = card();
  for (let i = 0; i < 25; i++) c = L.grade(c, i % 2 === 0, T0 + i);
  assert.equal(c.history.length, 20);
  assert.equal(c.history[0].at, T0 + 5); // oldest 5 dropped
});

test("dueCards: due exactly now counts, future does not, missing nextDueAt counts", () => {
  const cs = [card({ nextDueAt: T0 }), card({ nextDueAt: T0 + 1 }), card({ nextDueAt: undefined })];
  assert.deepEqual(L.dueCards(cs, T0).map((c) => c.nextDueAt), [T0, undefined]);
});

test("due math across a day boundary: graded at 23:59 is due next day, not same day", () => {
  const lateNight = T0; // any instant — intervals are pure ms, no calendar rounding
  const c = L.grade(card(), true, lateNight); // box 2 → +2 days
  assert.equal(c.nextDueAt - lateNight, 2 * DAY);
});

test("sessionOrder: lowest box first, then oldest due, then word (stable)", () => {
  const cs = [
    card({ word: "b", box: 2, nextDueAt: T0 }),
    card({ word: "c", box: 1, nextDueAt: T0 + 5 }),
    card({ word: "a", box: 1, nextDueAt: T0 }),
    card({ word: "d", box: 1, nextDueAt: T0 }),
  ];
  assert.deepEqual(L.sessionOrder(cs).map((c) => c.word), ["a", "d", "c", "b"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tools/tests/leitner.test.mjs`
Expected: FAIL — `Cannot find module '.../shared/leitner.js'`.

- [ ] **Step 3: Write the implementation**

Create `shared/leitner.js`:

```js
// SubVibe — Leitner box math (pure logic, node-testable).
// Attached to globalThis so plain <script src> includes, the worker's
// importScripts, AND node:test all share it — same pattern as shared/pricing.js.
(function (g) {
  const DAY = 86400000;
  // Boxes 1–5; review interval per box, in days. Box 5 stays at 16 days forever.
  const INTERVALS = [1, 2, 4, 8, 16];

  // Apply a self-grade. ok → next box (capped at 5); wrong → back to box 1.
  // Returns a NEW card; never mutates the input. History keeps the last 20.
  function grade(card, ok, now) {
    const box = ok ? Math.min(5, (card.box || 1) + 1) : 1;
    const history = [...(card.history || []), { at: now, ok: !!ok }].slice(-20);
    return { ...card, box, nextDueAt: now + INTERVALS[box - 1] * DAY, lastGradedAt: now, history };
  }

  // Cards due at `now` — due exactly now counts; a card without nextDueAt
  // (bad storage) counts too, so it can never get stuck invisible.
  function dueCards(cards, now) {
    return (cards || []).filter((c) => (c.nextDueAt || 0) <= now);
  }

  // Session order: shakiest cards first (lowest box), oldest due first within a
  // box, then by word so the order is deterministic. Noun article-quiz cards
  // ride along — the quiz is a presentation stage of the card, not a second card.
  function sessionOrder(cards) {
    return (cards || []).slice().sort((a, b) =>
      (a.box || 1) - (b.box || 1) ||
      (a.nextDueAt || 0) - (b.nextDueAt || 0) ||
      String(a.word).localeCompare(String(b.word)));
  }

  g.SV_LEITNER = { DAY, INTERVALS, grade, dueCards, sessionOrder };
})(globalThis);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tools/tests/leitner.test.mjs`
Expected: PASS, 8/8 tests.

- [ ] **Step 5: Commit**

```bash
git add shared/leitner.js tools/tests/leitner.test.mjs
git commit -m "Leitner core: pure box math (grade/due/session order) + node tests"
```

---

### Task 2: `shared/stopwords.js` + `shared/vocab.js` — inbox extraction & enrichment merge + node tests

**Files:**
- Create: `shared/stopwords.js`
- Create: `shared/vocab.js`
- Test: `tools/tests/vocab.test.mjs`

**Interfaces:**
- Consumes: nothing external; `shared/vocab.js` reads `globalThis.SV_STOPWORDS` (load stopwords first).
- Produces:
  - `SV_STOPWORDS = { set(lang) → Set<string> (empty for unknown langs), detect(words[]) → "de"|"en"|null }`
  - `SV_VOCAB = { tokenize(text) → string[], extractInboxWords(sentences, lang, dismissed?, known?) → [{w, n, sentence, st}], mergeEnrichment(cards, entries) → cards[] }` where `sentences = [{o: originalText, t: translatedText}]`, `dismissed`/`known` are Sets of lowercased words.

- [ ] **Step 1: Write the failing test**

Create `tools/tests/vocab.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/stopwords.js";
import "../../shared/vocab.js";

const S = globalThis.SV_STOPWORDS;
const V = globalThis.SV_VOCAB;

test("tokenize: unicode letters, umlauts/ß, in-word apostrophes and hyphens, no numbers", () => {
  assert.deepEqual(V.tokenize("Der Fußgängerübergang, geht's — 42 U-Bahn!"),
    ["Der", "Fußgängerübergang", "geht's", "U-Bahn"]);
  assert.deepEqual(V.tokenize(""), []);
});

test("stopword sets: 'der' is a de stopword, 'the' is en; unknown lang → empty set", () => {
  assert.ok(S.set("de").has("der"));
  assert.ok(S.set("en").has("the"));
  assert.equal(S.set("tr").size, 0);
  assert.ok(S.set("de-DE").has("der")); // region tags normalize
});

test("detect: German sentence → de, English → en, name soup → null", () => {
  assert.equal(S.detect(V.tokenize("Ich habe das nicht gewusst und wir gehen jetzt nach Hause")), "de");
  assert.equal(S.detect(V.tokenize("I did not know that and we are going home now")), "en");
  assert.equal(S.detect(V.tokenize("Balrog Mithrandir Lothlorien Galadriel")), null);
  assert.equal(S.detect([]), null);
});

test("extractInboxWords: stopwords filtered, counts accumulate, FIRST sentence kept", () => {
  const sentences = [
    { o: "Der Hund läuft schnell.", t: "The dog runs fast." },
    { o: "Der Hund schläft.", t: "The dog sleeps." },
  ];
  const out = V.extractInboxWords(sentences, "de");
  const hund = out.find((e) => e.w === "Hund");
  assert.equal(hund.n, 2);
  assert.equal(hund.sentence, "Der Hund läuft schnell."); // first occurrence wins
  assert.equal(hund.st, "The dog runs fast.");
  assert.ok(!out.find((e) => e.w.toLowerCase() === "der")); // stopword gone
  assert.equal(out[0].w, "Hund"); // sorted by count desc
});

test("extractInboxWords: dismissed and already-known words never appear", () => {
  const sentences = [{ o: "Der Hund läuft schnell.", t: "" }];
  const out = V.extractInboxWords(sentences, "de", new Set(["schnell"]), new Set(["hund"]));
  assert.deepEqual(out.map((e) => e.w), ["läuft"]);
});

test("extractInboxWords: unknown language passes everything through (no stopword list)", () => {
  const out = V.extractInboxWords([{ o: "el perro corre", t: "" }], "es");
  assert.deepEqual(out.map((e) => e.w).sort(), ["corre", "el", "perro"]);
});

test("mergeEnrichment: aligned entries land on the cards, '-' fields become null", () => {
  const cards = [{ word: "Hund", lang: "de" }, { word: "laufen", lang: "de" }];
  const merged = V.mergeEnrichment(cards, [
    { lemma: "Hund", pos: "noun", art: "der", plural: "Hunde", cefr: "A1", meaning: "dog", phrase: "Der Hund bellt.", note: "-" },
    { lemma: "laufen", pos: "verb", art: "-", plural: "-", cefr: "A1", meaning: "to run", phrase: "Ich laufe gern.", note: "läuft, lief, gelaufen" },
  ]);
  assert.equal(merged[0].art, "der");
  assert.equal(merged[0].note, null);
  assert.equal(merged[1].art, null);
  assert.equal(merged[1].plural, null);
  assert.equal(merged[1].note, "läuft, lief, gelaufen");
  assert.equal(cards[0].art, undefined); // inputs untouched
});

test("mergeEnrichment: short array back-fills pos:'other', cefr:'?' — still enrichable", () => {
  const merged = V.mergeEnrichment([{ word: "a" }, { word: "b" }],
    [{ lemma: "a", pos: "noun", art: "-", plural: "-", cefr: "A2", meaning: "x", phrase: "y", note: "-" }]);
  assert.equal(merged[1].pos, "other");
  assert.equal(merged[1].cefr, "?");
});

test("mergeEnrichment: garbage enums are sanitized, never stored raw", () => {
  const [m] = V.mergeEnrichment([{ word: "a" }],
    [{ lemma: "a", pos: "verbish", art: "los", plural: "-", cefr: "Z9", meaning: "x", phrase: "y", note: "-" }]);
  assert.equal(m.pos, "other");
  assert.equal(m.art, null);
  assert.equal(m.cefr, "?");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tools/tests/vocab.test.mjs`
Expected: FAIL — `Cannot find module '.../shared/stopwords.js'`.

- [ ] **Step 3: Write `shared/stopwords.js`**

```js
// SubVibe — stopword lists + stopword-based language detection (pure logic,
// node-testable; globalThis pattern like shared/pricing.js). The top ~200
// function words per language: words that never belong in a vocabulary
// trainer. Languages without a list pass every word through.
(function (g) {
  const DE = ("der die das den dem des ein eine einen einem einer eines und oder aber doch denn wenn als wie wo " +
    "was wer wen wem wessen ich du er sie es wir ihr mich dich sich uns euch mir dir ihm ihnen mein dein sein " +
    "unser euer meine deine seine ihre unsere eure meinen deinen seinen ihren nicht kein keine keinen ja nein " +
    "auch noch schon nur sehr so dann da hier dort jetzt heute morgen gestern immer nie mal wieder zu zum zur " +
    "in im ins an am auf aus bei mit nach von vom vor über unter durch für gegen ohne um bis seit ist sind war " +
    "waren bin bist gewesen wird werden wurde wurden worden hat haben hatte hatten habe hast kann können konnte " +
    "konnten muss müssen musste mussten will wollen wollte wollten soll sollen sollte sollten darf dürfen " +
    "durfte mag mögen möchte möchten geht gehen ging gingen gibt geben gab macht machen machte man etwas nichts " +
    "alles alle allem allen jeder jede jedes jeden dieser diese dieses diesen diesem welcher welche welches ob " +
    "weil dass damit deshalb deswegen trotzdem also eben halt ganz mehr weniger viel viele wenig gut besser oben " +
    "unten links rechts her hin weg los ab dazu dabei dafür davon darauf darin darüber daran danach davor " +
    "dahinter warum wieso weshalb wann beim ans aufs übers unters vors hinters durchs fürs ums").split(" ");
  const EN = ("the a an and or but if when as like where what who whom whose why how i you he she it we they " +
    "me him her us them my your his its our their mine yours hers ours theirs this that these those which not " +
    "no nor yes also still only very so then there here now today tomorrow yesterday always never again to in " +
    "into on at from by with within after of off over under through for against without about until since is " +
    "are was were am be been being will would shall should can could must may might do does did done doing has " +
    "have had having go goes went gone going get gets got gotten give gives gave given make makes made making " +
    "say says said see sees saw seen know knows knew known think thinks thought take takes took taken come " +
    "comes came coming want wants wanted use uses used one two three some any all each every out up down more " +
    "less much many few little good well better just than too own same other another such both between because " +
    "while during before once really actually maybe okay oh yeah right let lets us").split(" ");

  const SETS = { de: new Set(DE), en: new Set(EN) };

  // Stopword set for a language — EMPTY for languages without a list, so every
  // word passes through (the spec's "other languages pass through").
  function set(lang) {
    return SETS[(lang || "").split("-")[0].toLowerCase()] || new Set();
  }

  // Guess a token stream's language from stopword hit-rates. Function words are
  // >25% of natural text; 8% is a safe floor that still rejects name soups.
  function detect(words) {
    const n = (words || []).length;
    if (!n) return null;
    let de = 0, en = 0;
    for (const w of words) {
      const lw = String(w).toLowerCase();
      if (SETS.de.has(lw)) de++;
      if (SETS.en.has(lw)) en++;
    }
    if (de / n < 0.08 && en / n < 0.08) return null;
    return de >= en ? "de" : "en";
  }

  g.SV_STOPWORDS = { set, detect };
})(globalThis);
```

- [ ] **Step 4: Write `shared/vocab.js`**

```js
// SubVibe — vocabulary inbox extraction + enrichment merge (pure logic,
// node-testable; globalThis pattern). Load shared/stopwords.js first.
(function (g) {
  // Unicode-aware tokenizer: letter runs incl. umlauts/ß, keeping in-word
  // apostrophes and hyphens ("geht's", "U-Bahn"). Numbers never tokenize.
  function tokenize(text) {
    return String(text || "").match(/\p{L}+(?:['’-]\p{L}+)*/gu) || [];
  }

  // One clip's sentences → inbox words: unique non-stopword words with a seen
  // count and the FIRST sentence they appeared in (plus that sentence's cached
  // translation). `dismissed`/`known` are Sets of lowercased words to skip —
  // tombstoned words and words already in the trainer never re-inbox.
  function extractInboxWords(sentences, lang, dismissed, known) {
    const stop = g.SV_STOPWORDS.set(lang);
    const seen = new Map(); // lowercased → entry
    for (const s of sentences || []) {
      for (const w of tokenize(s.o)) {
        const lw = w.toLowerCase();
        if (lw.length < 2 || stop.has(lw)) continue;
        if ((dismissed && dismissed.has(lw)) || (known && known.has(lw))) continue;
        const e = seen.get(lw);
        if (e) e.n++;
        else seen.set(lw, { w, n: 1, sentence: s.o, st: s.t || "" });
      }
    }
    return [...seen.values()].sort((a, b) => b.n - a.n);
  }

  // Enrichment merge: response entries (aligned to the request order) onto the
  // cards. Short/missing entries back-fill pos:"other", cefr:"?" so the word
  // reads visibly un-enriched and STAYS enrichable. Enum garbage is sanitized —
  // corrupted model output can never plant an unknown pos/art/cefr in storage.
  function mergeEnrichment(cards, entries) {
    const POS = new Set(["noun", "verb", "adj", "adv", "phrase", "other"]);
    const CEFR = new Set(["A1", "A2", "B1", "B2", "C1", "C2"]);
    const val = (v) => (typeof v === "string" && v.trim() && v.trim() !== "-" ? v.trim() : null);
    return (cards || []).map((card, i) => {
      const e = (entries || [])[i];
      if (!e || typeof e !== "object") return { ...card, pos: "other", cefr: "?" };
      return {
        ...card,
        lemma: val(e.lemma) || card.word,
        pos: POS.has(e.pos) ? e.pos : "other",
        art: /^(der|die|das)$/i.test((e.art || "").trim()) ? e.art.trim().toLowerCase() : null,
        plural: val(e.plural),
        cefr: CEFR.has(e.cefr) ? e.cefr : "?",
        meaning: val(e.meaning) || "",
        phrase: val(e.phrase) || "",
        note: val(e.note),
      };
    });
  }

  g.SV_VOCAB = { tokenize, extractInboxWords, mergeEnrichment };
})(globalThis);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tools/tests/vocab.test.mjs`
Expected: PASS, 9/9 tests. Also run `node --test tools/tests/leitner.test.mjs` — still green.

- [ ] **Step 6: Commit**

```bash
git add shared/stopwords.js shared/vocab.js tools/tests/vocab.test.mjs
git commit -m "Vocab core: stopwords + language detection, inbox extraction, enrichment merge"
```

---

### Task 3: `background.js` — vocab store (DB v3) + local message cases

**Files:**
- Modify: `background.js` (importScripts line 9; `db()` at :95-109; new helpers after the audio-store section ~:180; new message cases in the router before `default:` at :1034)

**Interfaces:**
- Consumes: `SV_LEITNER`, `SV_STOPWORDS`, `SV_VOCAB` (Task 1–2), existing `db()`/store plumbing.
- Produces (runtime messages, all local/free):
  - `VOCAB_ADD {word, sentence, translation, lang?, videoTitle, base, ms}` → `{ok, key, card}`
  - `VOCAB_LIST {}` → `{cards: [{key, ...card}]}`
  - `VOCAB_INBOX_LIST {}` → `{inbox: [inboxRow]}`
  - `VOCAB_INBOX_BUILD {}` → `{ok, built}`
  - `VOCAB_PROMOTE {base, words: string[]}` → `{ok, promoted}`
  - `VOCAB_DISMISS {base, words: string[]}` → `{ok}`
  - `VOCAB_GRADE {key, ok}` → `{ok, card}`
  - `VOCAB_DUE_COUNT {}` → `{due, total}`

- [ ] **Step 1: importScripts + DB v3**

Line 9 becomes:

```js
importScripts("shared/pricing.js", "shared/leitner.js", "shared/stopwords.js", "shared/vocab.js"); // SV_PRICING + SV_LEITNER + SV_STOPWORDS + SV_VOCAB — pure modules shared with pages and node tests
```

In `db()` change the open call and upgrade handler:

```js
      const req = indexedDB.open("copilot-subs", 3);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("tracks")) d.createObjectStore("tracks");
        if (!d.objectStoreNames.contains("audio")) d.createObjectStore("audio");
        if (!d.objectStoreNames.contains("vocab")) d.createObjectStore("vocab"); // v3: Leitner trainer (cards + inbox + tombstones)
      };
```

(`shared/export.js` opens the DB without a version — it follows to v3 automatically; nothing else opens this DB.)

- [ ] **Step 2: vocab store helpers + vocabAdd + vocabInboxBuild**

Insert after the `idbAudioDeletePrefix` function (before `idbList`):

```js
// ─── vocab store (Leitner trainer; same DB, third object store) ──────────────
// Keys share one store, split by prefix: cards `${lang}:${word}`, per-video
// inbox rows `inbox:${base}`, dismissal tombstones `dismissed:${lang}`.

async function idbVocabGet(key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("vocab", "readonly").objectStore("vocab").get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

async function idbVocabPut(key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("vocab", "readwrite").objectStore("vocab").put(value, key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

// All rows whose key starts with `prefix` ("" = the whole store) as {key, value}.
async function idbVocabList(prefix) {
  const d = await db();
  return new Promise((resolve) => {
    const store = d.transaction("vocab", "readonly").objectStore("vocab");
    const out = [];
    store.openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return resolve(out);
      if (typeof c.key === "string" && c.key.startsWith(prefix)) out.push({ key: c.key, value: c.value });
      c.continue();
    };
    store.transaction.onerror = () => resolve(out);
  });
}

const isCardKey = (k) => !k.startsWith("inbox:") && !k.startsWith("dismissed:");

// Upsert one card. Language: explicit > stopword-detected from the sentence >
// "xx" bucket. A repeat save bumps the seen-count and fills gaps (sentence,
// translation, title) but never resets the box or the enrichment.
async function vocabAdd({ word, sentence, translation, lang, videoTitle, base, ms }) {
  const clean = SV_VOCAB.tokenize(word)[0] || String(word || "").trim();
  if (!clean) throw new Error("empty word");
  const l = (lang || "").split("-")[0].toLowerCase() || SV_STOPWORDS.detect(SV_VOCAB.tokenize(sentence)) || "xx";
  const key = `${l}:${clean.toLowerCase()}`;
  const cur = await idbVocabGet(key);
  const now = Date.now();
  const card = cur ? {
    ...cur, n: (cur.n || 1) + 1,
    sentence: cur.sentence || sentence || "", sentenceT: cur.sentenceT || translation || "",
    videoTitle: cur.videoTitle || videoTitle || "", base: cur.base || base || "", ms: cur.ms ?? ms ?? 0,
  } : {
    word: clean, lang: l, box: 1, nextDueAt: now, addedAt: now, lastGradedAt: 0,
    sentence: sentence || "", sentenceT: translation || "", videoTitle: videoTitle || "", base: base || "", ms: ms || 0,
    n: 1, lemma: null, pos: null, art: null, plural: null, cefr: null, meaning: null, phrase: null, note: null,
    conj: null, history: [],
  };
  await idbVocabPut(key, card);
  return { key, card };
}

// Build the FREE per-video inbox from the subtitle cache the worker already
// owns — the engine has no harvest hook by design. Scans `tracks`, extracts
// words per clip, writes `inbox:${base}` rows. Clips already inboxed are
// skipped (their row IS the state); dismissed words and words already in the
// trainer never re-appear. Zero network.
async function vocabInboxBuild() {
  const d = await db();
  const rows = await new Promise((resolve) => { // full rows — idbList() drops cues
    const store = d.transaction("tracks", "readonly").objectStore("tracks");
    const out = [];
    store.openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return resolve(out);
      out.push({ key: String(c.key), t: c.value || {} });
      c.continue();
    };
    store.transaction.onerror = () => resolve(out);
  });
  const vocabRows = await idbVocabList("");
  const inboxed = new Set(), known = {}, dismissed = {};
  for (const { key, value } of vocabRows) {
    if (key.startsWith("inbox:")) inboxed.add(key);
    else if (key.startsWith("dismissed:")) dismissed[key.slice(10)] = new Set(value.words || []);
    else {
      const lang = key.split(":")[0];
      (known[lang] = known[lang] || new Set()).add(key.slice(lang.length + 1));
    }
  }
  // Group cache rows by clip: keys are `${base}:auto:${target}` or `${base}:stream`.
  // Keep the row with the most original text (rows predating the `o` field have none).
  const withOrig = (t) => (t.cues || []).filter((c) => c.o || c.original).length;
  const byBase = new Map();
  for (const { key, t } of rows) {
    const m = /^(.*):(?:auto:[^:]+|stream)$/.exec(key);
    if (!m) continue;
    if (!byBase.has(m[1]) || withOrig(t) > withOrig(byBase.get(m[1]))) byBase.set(m[1], t);
  }
  let built = 0;
  for (const [base, t] of byBase) {
    if (inboxed.has("inbox:" + base)) continue;
    const sentences = (t.cues || [])
      .map((c) => ({ o: c.o || c.original || "", t: c.text || (c.t && t.target && c.t[t.target]) || "" }))
      .filter((s) => s.o);
    if (!sentences.length) continue;
    const lang = SV_STOPWORDS.detect(sentences.flatMap((s) => SV_VOCAB.tokenize(s.o)))
      || (t.source && t.source !== "auto" ? t.source : "xx");
    const words = SV_VOCAB.extractInboxWords(sentences, lang, dismissed[lang], known[lang]);
    if (!words.length) continue;
    await idbVocabPut("inbox:" + base, { base, lang, videoTitle: t.title || t.videoId || base, at: Date.now(), words });
    built++;
  }
  return built;
}
```

- [ ] **Step 3: message cases**

Insert before `default:` in the router:

```js
        // ── Vocabulary trainer (all local — capture/inbox/review cost nothing) ──
        case "VOCAB_ADD":
          sendResponse({ ok: true, ...(await vocabAdd(msg)) });
          break;
        case "VOCAB_LIST":
          sendResponse({ cards: (await idbVocabList("")).filter((r) => isCardKey(r.key)).map((r) => ({ key: r.key, ...r.value })) });
          break;
        case "VOCAB_INBOX_LIST":
          sendResponse({ inbox: (await idbVocabList("inbox:")).map((r) => r.value) });
          break;
        case "VOCAB_INBOX_BUILD":
          sendResponse({ ok: true, built: await vocabInboxBuild() });
          break;
        case "VOCAB_PROMOTE": {
          const row = await idbVocabGet("inbox:" + msg.base);
          let promoted = 0;
          if (row) {
            const pick = new Set((msg.words || []).map((w) => String(w).toLowerCase()));
            for (const e of (row.words || []).filter((e) => pick.has(e.w.toLowerCase()))) {
              await vocabAdd({ word: e.w, sentence: e.sentence, translation: e.st || "", lang: row.lang, videoTitle: row.videoTitle, base: row.base, ms: 0 });
              promoted++;
            }
            row.words = (row.words || []).filter((e) => !pick.has(e.w.toLowerCase()));
            await idbVocabPut("inbox:" + msg.base, row);
          }
          sendResponse({ ok: true, promoted });
          break;
        }
        case "VOCAB_DISMISS": {
          const row = await idbVocabGet("inbox:" + msg.base);
          if (row) {
            const pick = new Set((msg.words || []).map((w) => String(w).toLowerCase()));
            const tomb = new Set(((await idbVocabGet("dismissed:" + row.lang)) || {}).words || []);
            for (const e of row.words || []) if (pick.has(e.w.toLowerCase())) tomb.add(e.w.toLowerCase());
            await idbVocabPut("dismissed:" + row.lang, { words: [...tomb] }); // never re-inboxed
            row.words = (row.words || []).filter((e) => !pick.has(e.w.toLowerCase()));
            await idbVocabPut("inbox:" + msg.base, row);
          }
          sendResponse({ ok: true });
          break;
        }
        case "VOCAB_GRADE": {
          const cur = await idbVocabGet(msg.key);
          if (!cur) { sendResponse({ error: "no such card: " + msg.key }); break; }
          const card = SV_LEITNER.grade(cur, !!msg.ok, Date.now());
          await idbVocabPut(msg.key, card);
          sendResponse({ ok: true, card });
          break;
        }
        case "VOCAB_DUE_COUNT": {
          const cards = (await idbVocabList("")).filter((r) => isCardKey(r.key)).map((r) => r.value);
          sendResponse({ due: SV_LEITNER.dueCards(cards, Date.now()).length, total: cards.length });
          break;
        }
```

- [ ] **Step 4: Smoke-test in the real worker**

Load the unpacked extension (chrome://extensions → Reload). Open `chrome-extension://<id>/library.html`, DevTools console:

```js
await new Promise(r => chrome.runtime.sendMessage({type:"VOCAB_ADD", word:"Hund.", sentence:"Der Hund läuft schnell über die Straße.", translation:"The dog runs fast across the street.", videoTitle:"Test", base:"youtube:/watch?v=x", ms:1234}, r))
// → {ok:true, key:"de:hund", card:{word:"Hund", lang:"de", box:1, …}}  (lang detected, punctuation stripped)
await new Promise(r => chrome.runtime.sendMessage({type:"VOCAB_GRADE", key:"de:hund", ok:true}, r))
// → card.box === 2, nextDueAt ≈ now + 2 days
await new Promise(r => chrome.runtime.sendMessage({type:"VOCAB_INBOX_BUILD"}, r))
// → {ok:true, built:N} (N = clips in your cache with original text)
await new Promise(r => chrome.runtime.sendMessage({type:"VOCAB_INBOX_LIST"}, r))
// → inbox rows; spot-check one: words sorted by n desc, no "der/die/und", no "hund" (already known)
await new Promise(r => chrome.runtime.sendMessage({type:"VOCAB_DUE_COUNT"}, r))
// → {due:0, total:1}  (the graded card is due in 2 days)
```

Expected: all five shapes as annotated; no errors in the service-worker console.

- [ ] **Step 5: Commit**

```bash
git add background.js
git commit -m "Worker: vocab object store (DB v3) + local trainer messages (add/list/inbox/promote/dismiss/grade)"
```

---

### Task 4: `background.js` — batched enrichment + on-demand conjugation

**Files:**
- Modify: `background.js` (constants near TRANSLATE_SCHEMA ~:52; helper after `translateAll` ~:540; two message cases after `VOCAB_DUE_COUNT`)

**Interfaces:**
- Consumes: `SV_VOCAB.mergeEnrichment`, `idbVocabGet/Put`, `logCall`, `SV_PRICING.estCost`, `resolveClaudeModel`, `TRANSLATE_MODEL`, `TRANSIENT_HTTP`, `retryAfterMs`, `langName`.
- Produces:
  - `VOCAB_ENRICH {keys: string[]}` → `{ok, enriched, usd}` or `{error}` — batches of 50, grouped by card lang, one `logCall` row per run (`kind:"enrich"`).
  - `VOCAB_CONJUGATE {key}` → `{ok, conj, cached?}` — one request per verb EVER; table cached on the card.
  - Internal: `llmJSON(system, userPayload, schema|null)` → `{parsed, usage, provider, model}` — one structured-JSON call on the user's selected translation provider.

- [ ] **Step 1: schema + prompts**

Insert after the `TRANSLATE_SCHEMA` block:

```js
// Vocabulary enrichment — batched (50 words/request, the spec's economy
// contract), strict-schema like TRANSLATE_SCHEMA. Strict mode requires every
// property; "-" marks not-applicable (mergeEnrichment turns it into null).
const ENRICH_BATCH = 50;
const ENRICH_SCHEMA = {
  name: "vocab_enrichment",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      e: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            lemma: { type: "string" },
            pos: { type: "string", enum: ["noun", "verb", "adj", "adv", "phrase", "other"] },
            art: { type: "string" },
            plural: { type: "string" },
            cefr: { type: "string", enum: ["A1", "A2", "B1", "B2", "C1", "C2"] },
            meaning: { type: "string" },
            phrase: { type: "string" },
            note: { type: "string" },
          },
          required: ["lemma", "pos", "art", "plural", "cefr", "meaning", "phrase", "note"],
        },
      },
    },
    required: ["e"],
  },
};

// CACHE-STABLE per (source, target) — same rule as systemPrompt(): nothing
// per-call in here, so provider prompt caching can serve repeat batches.
function enrichPrompt(source, target) {
  return `You are a precise lexicographer helping a learner of ${langName(source)}. The user message carries ` +
    `{"words":[{"w":"<word>","s":"<the sentence it appeared in>"}, …]}.\n` +
    `Return STRICT JSON {"e":[…]} with EXACTLY one entry per input word, in the same order:\n` +
    `- lemma: the dictionary form (infinitive for verbs, nominative singular for nouns).\n` +
    `- pos: noun|verb|adj|adv|phrase|other — the word's role in the given sentence.\n` +
    `- art: for German nouns the article "der", "die" or "das"; otherwise "-".\n` +
    `- plural: for nouns the plural form; otherwise "-".\n` +
    `- cefr: the word's CEFR level, A1–C2.\n` +
    `- meaning: a concise meaning in ${langName(target)}, matching the sentence's sense.\n` +
    `- phrase: ONE short, natural ${langName(source)} example phrase using the word.\n` +
    `- note: a short usage or irregularity note when genuinely useful, else "-".`;
}

// Conjugation (verbs, on demand; cached forever on the card). Keys are display
// labels — German gets the canonical five rows; other languages fill equivalent
// tense rows. Free-keyed object, so this call uses json_object, not a strict schema.
function conjPrompt(source) {
  return `You are a ${langName(source)} verb conjugation table generator. The user message carries {"verb":"…"}.\n` +
    `Return STRICT JSON {"forms":{…}}. For German verbs exactly these keys:\n` +
    `{"forms":{"präsens":["ich …","du …","er/sie/es …","wir …","ihr …","sie/Sie …"],` +
    `"präteritum":[6 forms in the same person order],"perfekt":"er/sie/es form, e.g. \\"hat gemacht\\",` +
    `"imperativ":["du form","ihr form"],"konjunktivII":"ich form"}}.\n` +
    `For other languages: the equivalent core tense rows — each key a display label in that language, ` +
    `each value a string or an array of person-forms. Table content only, no commentary.`;
}
```

- [ ] **Step 2: the `llmJSON` helper**

Insert after `translateAll` (before the TTS section):

```js
// One structured-JSON call on the user's selected TRANSLATION provider — the
// enrichment/conjugation twin of translateChunk/translateChunkClaude, sharing
// their retry, schema and error-shaping rules. schema=null → plain JSON mode
// (json_object on OpenAI, prompt-dictated JSON on Claude).
async function llmJSON(system, userPayload, schema) {
  const { apiKey, anthropicKey, translationProvider, claudeModel } =
    await chrome.storage.local.get(["apiKey", "anthropicKey", "translationProvider", "claudeModel"]);
  const provider = translationProvider === "claude" ? "claude" : "openai";
  const key = provider === "claude" ? anthropicKey : apiKey;
  if (!key) {
    throw new Error(provider === "claude"
      ? "No Anthropic API key yet — open the SubVibe popup and paste your key."
      : "No OpenAI API key yet — open the SubVibe popup and paste your key.");
  }
  const model = provider === "claude" ? resolveClaudeModel(claudeModel) : TRANSLATE_MODEL;
  const user = JSON.stringify(userPayload);
  let body, url, headers;
  if (provider === "claude") {
    url = ANTHROPIC_MESSAGES;
    headers = { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json", "anthropic-dangerous-direct-browser-access": "true" };
    body = {
      model, max_tokens: 8192,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    };
    if (schema) body.output_config = { format: { type: "json_schema", schema: schema.schema } };
    if (!/haiku/.test(model)) body.thinking = { type: "disabled" }; // same rule as translateChunkClaude
  } else {
    url = OPENAI_CHAT;
    headers = { Authorization: "Bearer " + key, "Content-Type": "application/json" };
    body = {
      model, temperature: 0,
      response_format: schema ? { type: "json_schema", json_schema: schema } : { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };
  }
  let lastStatus = 0, lastBody = "", waitMs = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, waitMs || 500 * attempt));
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    waitMs = res.status === 429 ? retryAfterMs(res) : 0;
    const txt = await res.text();
    if (res.ok) {
      if (!txt) throw new Error("the provider returned an empty response");
      let data;
      try { data = JSON.parse(txt); } catch { throw new Error("the provider returned a non-JSON response"); }
      let content, usage;
      if (provider === "claude") {
        if (data.stop_reason === "refusal") throw new Error("Claude declined this request (refusal)");
        if (data.stop_reason === "max_tokens") throw new Error("Claude truncated the response (max_tokens)");
        const blk = (data.content || []).find((b) => b && b.type === "text");
        content = (blk && blk.text) || "{}";
        usage = data.usage ? { prompt_tokens: data.usage.input_tokens || 0, completion_tokens: data.usage.output_tokens || 0,
          cache_r: data.usage.cache_read_input_tokens || 0, cache_w: data.usage.cache_creation_input_tokens || 0 } : null;
      } else {
        content = data?.choices?.[0]?.message?.content || "{}";
        usage = data.usage || null;
      }
      let parsed;
      try { parsed = JSON.parse(content); } catch { throw new Error("the model returned malformed JSON"); }
      return { parsed, usage, provider, model };
    }
    lastStatus = res.status; lastBody = txt;
    // Same fallback as translateChunkClaude: a model generation that rejects
    // output_config drops to schema-in-prompt once (the prompt dictates the shape).
    if (provider === "claude" && res.status === 400 && body.output_config && /output_config|output_format/i.test(txt || "")) {
      console.info("[SubVibe] " + model + " rejected output_config — retrying schema-in-prompt");
      delete body.output_config;
      continue;
    }
    if (!TRANSIENT_HTTP.has(res.status)) break;
  }
  const who = provider === "claude" ? "Claude" : "OpenAI";
  const detail = lastStatus >= 500 ? `${who} is temporarily unavailable — retrying`
    : lastStatus === 429 ? `rate limited by ${who}`
    : /^\s*<(?:!doctype|html|\?xml)/i.test(lastBody || "") ? "unexpected non-JSON response"
    : (lastBody || "").replace(/\s+/g, " ").slice(0, 140);
  throw new Error(`${who} ${lastStatus}: ${detail}`);
}
```

- [ ] **Step 3: message cases**

Insert after the `VOCAB_DUE_COUNT` case:

```js
        case "VOCAB_ENRICH": {
          // Batches of 50, grouped by the cards' language (one prompt per
          // source language), merged via SV_VOCAB.mergeEnrichment (short-array
          // back-fill included), one Activity row for the whole run.
          const { targets } = await chrome.storage.local.get(["targets"]);
          const target = (Array.isArray(targets) && targets[0]) || "en";
          const started = Date.now();
          const loaded = [];
          for (const k of msg.keys || []) { const c = await idbVocabGet(k); if (c) loaded.push({ key: k, card: c }); }
          const byLang = new Map();
          for (const it of loaded) {
            if (!byLang.has(it.card.lang)) byLang.set(it.card.lang, []);
            byLang.get(it.card.lang).push(it);
          }
          let enriched = 0, inTok = 0, outTok = 0, cacheR = 0, cacheW = 0, provider = null, model = null, lastErr = null;
          for (const [lang, items] of byLang) {
            for (let i = 0; i < items.length; i += ENRICH_BATCH) {
              const batch = items.slice(i, i + ENRICH_BATCH);
              try {
                const r = await llmJSON(enrichPrompt(lang === "xx" ? "auto" : lang, target),
                  { words: batch.map((b) => ({ w: b.card.word, s: (b.card.sentence || "").slice(0, 160) })) }, ENRICH_SCHEMA);
                provider = r.provider; model = r.model;
                if (r.usage) { inTok += r.usage.prompt_tokens || 0; outTok += r.usage.completion_tokens || 0; cacheR += r.usage.cache_r || 0; cacheW += r.usage.cache_w || 0; }
                const merged = SV_VOCAB.mergeEnrichment(batch.map((b) => b.card), (r.parsed && r.parsed.e) || []);
                for (let j = 0; j < batch.length; j++) { await idbVocabPut(batch[j].key, merged[j]); enriched++; }
              } catch (e) { lastErr = e; }
            }
          }
          if (!provider) {
            const { translationProvider } = await chrome.storage.local.get("translationProvider");
            provider = translationProvider === "claude" ? "claude" : "openai";
          }
          await logCall({ ts: started, site: "learn", title: "Vocabulary enrichment", kind: "enrich", lines: loaded.length,
            ms: Date.now() - started, inTok, outTok, cacheR, cacheW, ok: !lastErr,
            err: lastErr ? String((lastErr && lastErr.message) || lastErr) : undefined, provider, model });
          if (!enriched && lastErr) { sendResponse({ error: String((lastErr && lastErr.message) || lastErr) }); break; }
          sendResponse({ ok: true, enriched, usd: SV_PRICING.estCost({ provider, model, inTok, outTok, cacheR, cacheW }) });
          break;
        }
        case "VOCAB_CONJUGATE": {
          const card = await idbVocabGet(msg.key);
          if (!card) { sendResponse({ error: "no such card: " + msg.key }); break; }
          if (card.conj) { sendResponse({ ok: true, conj: card.conj, cached: true }); break; } // cached forever — free
          const started = Date.now();
          const label = "Conjugation: " + (card.lemma || card.word);
          try {
            const r = await llmJSON(conjPrompt(card.lang === "xx" ? "auto" : card.lang), { verb: card.lemma || card.word }, null);
            const forms = r.parsed && r.parsed.forms;
            if (!forms || typeof forms !== "object" || Array.isArray(forms)) throw new Error("the model returned no conjugation table");
            card.conj = forms;
            await idbVocabPut(msg.key, card);
            await logCall({ ts: started, site: "learn", title: label, kind: "enrich", lines: 1, ms: Date.now() - started,
              inTok: (r.usage && r.usage.prompt_tokens) || 0, outTok: (r.usage && r.usage.completion_tokens) || 0,
              cacheR: (r.usage && r.usage.cache_r) || 0, cacheW: (r.usage && r.usage.cache_w) || 0,
              ok: true, provider: r.provider, model: r.model });
            sendResponse({ ok: true, conj: forms });
          } catch (e) {
            const { translationProvider } = await chrome.storage.local.get("translationProvider");
            await logCall({ ts: started, site: "learn", title: label, kind: "enrich", lines: 1, ms: Date.now() - started,
              inTok: 0, outTok: 0, ok: false, err: String((e && e.message) || e),
              provider: translationProvider === "claude" ? "claude" : "openai" });
            sendResponse({ error: String((e && e.message) || e) });
          }
          break;
        }
```

- [ ] **Step 4: Smoke-test with the real key**

Reload the extension. From the library.html console (uses whichever provider the popup has selected — cost ≈ a tenth of a cent):

```js
await new Promise(r => chrome.runtime.sendMessage({type:"VOCAB_ADD", word:"laufen", sentence:"Wir laufen jeden Morgen durch den Park.", translation:"", videoTitle:"t", base:"b", ms:0}, r))
await new Promise(r => chrome.runtime.sendMessage({type:"VOCAB_ENRICH", keys:["de:laufen"]}, r))
// → {ok:true, enriched:1, usd:0.000…}; then:
await new Promise(r => chrome.runtime.sendMessage({type:"VOCAB_LIST"}, r)).then(x => x.cards.find(c => c.key==="de:laufen"))
// → pos:"verb", cefr:"A1", lemma:"laufen", meaning in your primary target language
await new Promise(r => chrome.runtime.sendMessage({type:"VOCAB_CONJUGATE", key:"de:laufen"}, r))
// → {ok:true, conj:{präsens:[6], präteritum:[6], perfekt:"ist gelaufen", …}}
await new Promise(r => chrome.runtime.sendMessage({type:"VOCAB_CONJUGATE", key:"de:laufen"}, r))
// → {ok:true, cached:true, …} — second call is FREE (no new Activity row)
```

Also check the Library → Activity tab shows the two "learn" rows with a cost.

- [ ] **Step 5: Commit**

```bash
git add background.js
git commit -m "Worker: batched vocab enrichment (50/request, strict schema) + cached conjugation, metered like TRANSLATE"
```

---

### Task 5: click-to-save in the engine + `.saved` pulse + vocab-harness

**Files:**
- Modify: `content/common.js` (inside `runCueListMode` — after the `els` build ~:1557, and one line in `tick` after `const c = i >= 0 ? cues[i] : null;` ~:1631)
- Modify: `styles/overlay.css` (append)
- Create: `tools/tests/vocab-harness/harness.html`, `tools/tests/vocab-harness/fake-env.js`, `tools/tests/vocab-harness/driver.js`

**Interfaces:**
- Consumes: `send()`, `settings.targets`, `interceptedUrl`, `pageTitle`, `base`, cue objects (`c.grp`, `c.original`, `c.t[tg]`, `c.startMs`), `.copilot-subs__w` spans from `setLineText`.
- Produces: `VOCAB_ADD` messages (Task 3's contract); `.saved` class pulse on the clicked span. Video is never paused; drags never save.

- [ ] **Step 1: the click handler**

In `runCueListMode`, right after `layoutCustomLines();` (the line following the `els` build loop), insert:

```js
    // ── Click-to-save vocabulary ────────────────────────────────────────────
    // Karaoke words in the ORIGINAL line are save targets: one click sends the
    // word + its real sentence + the primary target's cached translation to the
    // trainer (VOCAB_ADD). Capture phase on the stack; never pauses the video
    // (overlay clicks don't reach the player). A drag is not a click: pointer
    // travel > 6px vetoes the save, so grabbing a line to move it stays clean.
    const vocabTg = (settings.targets || [])[0] || null;
    let curCue = null; // the cue on screen — stamped by tick each frame
    let vocabDownX = 0, vocabDownY = 0;
    stack.addEventListener("pointerdown", (e) => { vocabDownX = e.clientX; vocabDownY = e.clientY; }, true);
    stack.addEventListener("click", (e) => {
      const w = e.target && e.target.closest && e.target.closest(".copilot-subs__w");
      if (!w) return;
      const row = w.closest(".copilot-subs__line");
      if (!row || row.dataset.csKey !== "__orig") return; // original words only
      if (Math.hypot(e.clientX - vocabDownX, e.clientY - vocabDownY) > 6) return; // that was a drag
      const c = curCue;
      if (!c) return;
      const sentence = c.grp ? c.grp.orig : c.original;
      const sentenceT = !vocabTg ? "" : c.grp
        ? c.grp.cues.map((q) => q.t[vocabTg] || "").join(" ").trim()
        : (c.t[vocabTg] || "");
      const langHint = /[?&]lang=([a-z-]+)/i.exec(interceptedUrl || "");
      send({ type: "VOCAB_ADD", word: w.textContent, sentence, translation: sentenceT,
        lang: langHint ? langHint[1].toLowerCase() : null, videoTitle: pageTitle, base, ms: c.startMs });
      w.classList.remove("saved");
      void w.offsetWidth; // restart the pulse on a repeat click
      w.classList.add("saved");
      w.addEventListener("animationend", () => w.classList.remove("saved"), { once: true });
    }, true);
```

In `tick`, directly after `const c = i >= 0 ? cues[i] : null;` add:

```js
      curCue = c; // click-to-save reads the on-screen cue from here
```

- [ ] **Step 2: overlay CSS**

Append to `styles/overlay.css`:

```css
/* Click-to-save (vocabulary trainer): original-line karaoke words are save
   targets — pointer cursor, and a brief green pulse confirms the save. */
#copilot-subs .copilot-subs__line--orig .copilot-subs__w { cursor: pointer; }
@keyframes cs-saved-pulse {
  0% { transform: scale(1); }
  40% { transform: scale(1.3); color: #7cfc9a; }
  100% { transform: scale(1); }
}
#copilot-subs .copilot-subs__w.saved {
  display: inline-block; /* transform needs a box; a one-word span never re-wraps */
  animation: cs-saved-pulse 0.45s ease;
  color: #7cfc9a;
}
```

- [ ] **Step 3: the harness (write it before running anything)**

Create `tools/tests/vocab-harness/harness.html`:

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Vocab harness — click a karaoke word, assert the VOCAB_ADD payload</title>
<!--
  Runs the REAL content/common.js against a chrome stub (adopt-harness pattern):
  1. a 10-cue German caption file is adopted via SUBS_URL → FETCH_SUBS (stubbed),
  2. the stub "translates" each line to "EN·<original>",
  3. the driver clicks a karaoke word in the ORIGINAL line,
  4. EXPECT: exactly one VOCAB_ADD with the word, the cue's sentence, the
     cached translation and the lang hint from the timedtext URL; the span
     pulses .saved; the video never pauses.
  ?hl=<style> also forces a karaokeStyle for highlight-style screenshots.
-->
<link rel="stylesheet" href="../../../styles/overlay.css">
<style>
  body { background: #111; color: #ddd; font: 13px system-ui; margin: 0; }
  #player { position: relative; width: 800px; height: 450px; background: #000; margin: 16px auto; }
  #vid { width: 100%; height: 100%; background: #222; }
</style>
</head>
<body>
<div id="player"><video id="vid"></video></div>
<script src="fake-env.js"></script>
<script src="../../../shared/title.js"></script>
<script src="../../../shared/presets.js"></script>
<script src="../../../content/common.js"></script>
<script src="driver.js"></script>
</body>
</html>
```

Create `tools/tests/vocab-harness/fake-env.js`:

```js
// chrome stub + YouTube-shaped adapter for the vocab click-to-save harness.
(function () {
  const settings = {
    enabled: true, targets: ["en"], showOriginal: true, hideNative: true, karaokeHl: true,
    karaokeStyle: new URLSearchParams(location.search).get("hl") || "classic",
    translationProvider: "openai", apiKey: "sk-test", debugHud: false,
    position: "bottom", size: "md", stylePreset: "classic", styleCustom: {}, syncOffset: 0,
  };
  // 10-cue German WebVTT "file" the FETCH_SUBS stub serves. Sentence 1 is the
  // click target; the words are plain single-space tokens so lineUnits() builds
  // karaoke spans from estimated timings.
  const LINES = [
    "Der Hund läuft schnell über die Straße.",
    "Ich habe das gestern nicht gewusst.",
    "Wir gehen jetzt nach Hause zurück.",
    "Das Wetter ist heute wirklich schön.",
    "Sie liest jeden Abend ein Buch.",
    "Der Zug kommt gleich am Bahnhof an.",
    "Kannst du mir bitte kurz helfen?",
    "Morgen fahren wir in die Berge.",
    "Das Essen schmeckt mir sehr gut.",
    "Er arbeitet seit Jahren in Berlin.",
  ];
  let vtt = "WEBVTT\n\n";
  LINES.forEach((l, i) => {
    const s = i * 8, e = s + 7.8; // long cues: cue 0 must still be on screen when the driver clicks at ~5s
    const ts = (t) => "00:" + String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(Math.floor(t % 60)).padStart(2, "0") + "." + String(Math.round((t % 1) * 1000)).padStart(3, "0");
    vtt += (i + 1) + "\n" + ts(s) + " --> " + ts(e) + "\n" + l + "\n\n";
  });
  window.__vocabMsgs = []; // every VOCAB_ADD the content script sends
  window.chrome = {
    runtime: {
      id: "harness", lastError: undefined, getURL: (p) => "/" + p,
      onMessage: { addListener() {} },
      sendMessage: (msg, cb) => {
        let r = { ok: true };
        if (msg && msg.type === "FETCH_SUBS") r = { ok: true, status: 200, text: vtt };
        else if (msg && msg.type === "CACHE_GET") r = { track: null };
        else if (msg && msg.type === "TRANSLATE") r = { lines: (msg.cues || []).map((s) => "EN·" + s) };
        else if (msg && msg.type === "VOCAB_ADD") { window.__vocabMsgs.push(msg); r = { ok: true, key: "de:x", card: {} }; }
        if (cb) setTimeout(() => cb(r), 20);
      },
    },
    storage: {
      onChanged: { addListener() {} },
      local: {
        get: async (keys) => { const out = {}; const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(settings); for (const k of list) if (k in settings) out[k] = settings[k]; return out; },
        set: async (o) => Object.assign(settings, o),
      },
    },
  };
  const adapter = {
    site: "youtube",
    matches: () => true,
    getVideoId: () => "vid123",
    getVideoEl: () => document.getElementById("vid"),
    getPlayerContainer: () => document.getElementById("player"),
    async getCaptionTracks() { return []; },
    async fetchCues() { return []; },
    readNativeText() { return ""; }, // scrape idles empty; the SUBS_URL file then upgrades to cuelist — the proven adopt flow
    onNavigate() {},
  };
  (window.__copilotAdapters = window.__copilotAdapters || []).push(adapter);
})();
```

Create `tools/tests/vocab-harness/driver.js`:

```js
// Simulated player: the file adopts, cue 0 shows, the driver clicks word #1
// ("Hund") and judges the VOCAB_ADD payload. Verdict in document.title.
(function () {
  const vid = document.getElementById("vid");
  let clock = 0.5, playing = true;
  Object.defineProperty(vid, "currentTime", { get: () => clock });
  Object.defineProperty(vid, "duration", { get: () => 600 }); // VOD
  Object.defineProperty(vid, "paused", { get: () => !playing });
  Object.defineProperty(vid, "ended", { get: () => false });
  setInterval(() => { if (playing) clock += 0.25; }, 250);

  // The caption file URL is "spotted" — with a lang param, so the click
  // handler's lang hint is testable end-to-end. Re-posted like subs-intercept.
  const URL_ = "https://www.youtube.com/api/timedtext?v=vid123&pot=abc&lang=de&fmt=json3";
  setTimeout(() => window.postMessage({ __copilotSubs: true, type: "SUBS_URL", url: URL_ }, "*"), 800);
  setInterval(() => window.postMessage({ __copilotSubs: true, type: "SUBS_URL", url: URL_ }, "*"), 1500);

  const AUTORUN = new URLSearchParams(location.search).get("autorun");
  if (AUTORUN) setTimeout(async () => {
    const results = [];
    const check = (name, ok, info) => results.push({ name, ok: !!ok, info: String(info || "").slice(0, 220) });

    // Wait for the ORIGINAL line to render karaoke word spans (≤ 10s).
    let row = null, spans = [];
    for (let i = 0; i < 50 && spans.length < 2; i++) {
      row = document.querySelector('.copilot-subs__line[data-cs-key="__orig"]');
      spans = row ? [...row.querySelectorAll(".copilot-subs__w")] : [];
      await new Promise((r) => setTimeout(r, 200));
    }
    check("original line renders karaoke word spans", spans.length >= 2, spans.length + " spans");

    // Click word #1 ("Hund") — pointerdown then click at the same spot.
    const w = spans[1];
    if (w) {
      const rect = w.getBoundingClientRect();
      const at = { bubbles: true, clientX: rect.left + 2, clientY: rect.top + 2 };
      w.dispatchEvent(new PointerEvent("pointerdown", at));
      w.dispatchEvent(new MouseEvent("click", at));
    }
    await new Promise((r) => setTimeout(r, 100));
    const m = window.__vocabMsgs[0];
    check("click sends exactly one VOCAB_ADD", window.__vocabMsgs.length === 1, JSON.stringify(window.__vocabMsgs.map((x) => x.word)));
    check("payload word = the clicked span's text", m && m.word === (w && w.textContent), m && m.word);
    check("payload sentence = the cue's original sentence", m && m.sentence === "Der Hund läuft schnell über die Straße.", m && m.sentence);
    check("payload translation = the cached EN· translation", m && m.translation === "EN·Der Hund läuft schnell über die Straße.", m && m.translation);
    check("payload lang hint from the timedtext URL", m && m.lang === "de", m && m.lang);
    check("span pulses .saved", !!(w && w.classList.contains("saved")), w && w.className);
    check("video was NOT paused by the click", playing === true, "playing=" + playing);

    // A drag (pointer travel > 6px) must NOT save.
    if (w) {
      const rect = w.getBoundingClientRect();
      w.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: rect.left + 2, clientY: rect.top + 2 }));
      w.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: rect.left + 40, clientY: rect.top + 30 }));
    }
    await new Promise((r) => setTimeout(r, 100));
    check("a drag does not save", window.__vocabMsgs.length === 1, window.__vocabMsgs.length + " msgs");

    const passed = results.filter((r) => r.ok).length;
    document.title = (passed === results.length ? "PASS " : "FAIL ") + passed + "/" + results.length;
    const out = document.createElement("pre");
    out.id = "results";
    out.style.cssText = "color:#ddd;padding:12px;white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;";
    out.textContent = results.map((r) => (r.ok ? "PASS  " : "FAIL  ") + r.name + "\n      " + r.info).join("\n");
    document.body.appendChild(out);
  }, 5000);
})();
```

- [ ] **Step 4: Run the harness — verify it fails BEFORE the common.js change is applied** (git stash the common.js edit if written together, or simply note: with the handler in place this step verifies PASS; if you wrote the handler first, temporarily verify failure by checking out `content/common.js` from HEAD, running, then re-applying)

Open `tools/tests/vocab-harness/harness.html?autorun=1` in a Chromium browser (file:// is fine). Without the handler: title `FAIL 2/9` (spans render, nothing saves). With the handler: title `PASS 9/9`.

- [ ] **Step 5: Engine regression**

Open `tools/tests/adopt-harness/harness.html?autorun=1` — wait ~35s → title `PASS 7/7`.
Open `tools/tests/live-shift-harness/harness.html?autorun=1` — → title `PASS 13/13`.
Both must be green (common.js was touched).

- [ ] **Step 6: Update the regression list in `tools/tests/adopt-harness/README.md`**

Add one line to the "engine regression suite" list:

```markdown
- `tools/tests/vocab-harness/harness.html?autorun=1` — click-to-save vocabulary (9 checks)
```

- [ ] **Step 7: Commit**

```bash
git add content/common.js styles/overlay.css tools/tests/vocab-harness tools/tests/adopt-harness/README.md
git commit -m "Engine: click a karaoke word to save it to the trainer (+ vocab harness, 9 checks)"
```

---

### Task 6: five karaoke highlight styles (pure CSS) + Style tab row

**Files:**
- Modify: `styles/overlay.css` (append)
- Modify: `shared/presets.js` (add `SV_HL_STYLES` export)
- Modify: `content/common.js` (DEFAULTS ~:34, `getSettings` keys ~:118, `applyAppearance` ~:722, `LIVE_KEYS` ~:2225)
- Modify: `popup.html` (Style pane, after `#presetRow` ~:507)
- Modify: `popup.js` (DEFAULTS :15, `buildHlRow` next to `buildPresetRow`, `updateStyleUI`)

**Interfaces:**
- Consumes: `settings.karaokeStyle`, existing `--cs-hl` classic fill, `.presets`/`.abc`/`.pname` popup tile CSS.
- Produces: `karaokeStyle` global storage key (`"classic" | "neon-cyan" | "neon-magenta" | "ember" | "aurora"`); overlay classes `copilot-hl-<style>`; `window.SV_HL_STYLES = { key: {label, css} }`.

- [ ] **Step 1: overlay CSS — the five looks**

Append to `styles/overlay.css`:

```css
/* Karaoke highlight styles (karaokeStyle global setting) — pure CSS on .sung.
   Classic = the existing gold var(--cs-hl) rule above; the other four override
   it per overlay class. Aurora paints an animated gradient through the glyphs
   (background-clip: text) and falls back to classic gold where unsupported —
   outside the @supports block no aurora rule exists, so the base rule wins. */
#copilot-subs.copilot-hl-neon-cyan .copilot-subs__w.sung {
  color: #7df9ff;
  text-shadow: 0 0 0.3em rgba(0, 229, 255, 0.9), 0 0 0.7em rgba(0, 229, 255, 0.45);
}
#copilot-subs.copilot-hl-neon-magenta .copilot-subs__w.sung {
  color: #ff5ce1;
  text-shadow: 0 0 0.3em rgba(255, 0, 200, 0.9), 0 0 0.7em rgba(255, 0, 200, 0.45);
}
#copilot-subs.copilot-hl-ember .copilot-subs__w.sung {
  color: #ff9d4d;
  text-shadow: 0 0 0.25em rgba(255, 94, 0, 0.85), 0 0.05em 0.5em rgba(255, 60, 0, 0.4);
}
@keyframes cs-aurora { to { background-position: 200% 50%; } }
@supports ((-webkit-background-clip: text) or (background-clip: text)) {
  #copilot-subs.copilot-hl-aurora .copilot-subs__w.sung {
    background: linear-gradient(90deg, #4ade80, #22d3ee, #a78bfa, #f472b6, #4ade80) 0 50% / 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    -webkit-text-fill-color: transparent;
    animation: cs-aurora 3s linear infinite;
  }
}
```

- [ ] **Step 2: `shared/presets.js` — swatch metadata**

Before the `window.SV_PRESETS = PRESETS;` export block, add:

```js
  // Karaoke highlight styles (karaokeStyle setting). The LOOK lives in
  // styles/overlay.css (.copilot-hl-* on .sung); this map only feeds the
  // popup's swatch row — label + the css that paints the "Abc" tile.
  const HL_STYLES = {
    classic: { label: "Classic gold", css: "color:#ffd479" },
    "neon-cyan": { label: "Neon cyan", css: "color:#7df9ff;text-shadow:0 0 6px rgba(0,229,255,.9)" },
    "neon-magenta": { label: "Neon magenta", css: "color:#ff5ce1;text-shadow:0 0 6px rgba(255,0,200,.9)" },
    ember: { label: "Ember", css: "color:#ff9d4d;text-shadow:0 0 5px rgba(255,94,0,.85)" },
    aurora: { label: "Aurora", css: "background:linear-gradient(90deg,#4ade80,#22d3ee,#a78bfa,#f472b6);-webkit-background-clip:text;background-clip:text;color:transparent" },
  };
```

And alongside the other exports:

```js
  window.SV_HL_STYLES = HL_STYLES;
```

- [ ] **Step 3: `content/common.js` plumbing**

1. DEFAULTS (after the `karaokeHl` lines):

```js
    karaokeStyle: "classic", // karaoke highlight look: classic | neon-cyan | neon-magenta | ember | aurora
```

2. `getSettings()` — add `"karaokeStyle"` to the `chrome.storage.local.get([...])` key list (after `"karaokeHl"`).

3. `applyAppearance()` — directly AFTER the `if (style) { … }` block (outside the guard, so a missing SV_RESOLVE_STYLE can't disable highlight styles), add:

```js
    // Karaoke highlight style: one overlay class drives the .sung look
    // (styles/overlay.css). Unknown/missing values render classic.
    const HL_KEYS = ["classic", "neon-cyan", "neon-magenta", "ember", "aurora"];
    const hl = HL_KEYS.includes(settings.karaokeStyle) ? settings.karaokeStyle : "classic";
    for (const k of HL_KEYS) el.classList.toggle("copilot-hl-" + k, k === hl);
```

4. `LIVE_KEYS` — add `"karaokeStyle"` after `"styleCustom"` (live restyle, no engine restart).

- [ ] **Step 4: popup UI**

`popup.html`, directly after `<div class="presets" id="presetRow"></div>`:

```html
      <div class="row" style="margin-top:10px; margin-bottom:2px;">
        <span style="color:var(--muted);">Highlight</span>
        <span class="hint">the karaoke color as words are spoken</span>
      </div>
      <div class="presets" id="hlRow"></div>
```

`popup.js`:

1. DEFAULTS (line 15) — add `karaokeStyle: "classic",` after `karaokeHl: true,` (note: the popup DEFAULTS live in one object literal; keep the key order readable).
2. After `buildPresetRow`'s definition, add:

```js
const HL_STYLES = window.SV_HL_STYLES;
function buildHlRow() {
  const row = el("hlRow");
  row.innerHTML = "";
  for (const [key, h] of Object.entries(HL_STYLES)) {
    const b = document.createElement("button");
    b.dataset.hl = key;
    b.title = h.label + " karaoke highlight";
    const abc = document.createElement("span");
    abc.className = "abc";
    abc.textContent = "Abc";
    abc.style.cssText = "font-weight:800;" + h.css;
    const name = document.createElement("span");
    name.className = "pname";
    name.textContent = h.label;
    b.append(abc, name);
    b.addEventListener("click", () => {
      state.karaokeStyle = key;
      persist({ karaokeStyle: key }); // GLOBAL — taste follows the user, like stylePreset
      updateStyleUI();
    });
    row.appendChild(b);
  }
}
```

3. In `updateStyleUI()`, after the presetRow `.on` toggling line, add:

```js
  [...el("hlRow").children].forEach((b) => b.classList.toggle("on", b.dataset.hl === (state.karaokeStyle || "classic")));
```

4. Call `buildHlRow();` immediately after the existing `buildPresetRow();` call site (find it with `grep -n "buildPresetRow()" popup.js`).

- [ ] **Step 5: Verify live restyle + eye test**

- `tools/tests/vocab-harness/harness.html?hl=neon-cyan` (no autorun) — sung words glow cyan as the clock advances. Repeat for `?hl=neon-magenta`, `?hl=ember`, `?hl=aurora` (animated gradient sweeps), and no param (classic gold). Take one screenshot per style into `tools/store-screenshots/` for the store/docs.
- Real extension: reload, open a captioned video, switch Highlight swatches in the popup Style tab — the color changes live WITHOUT the subtitles flickering/restarting (watch the badge: it must not reset).
- Regression: adopt-harness `PASS 7/7`, live-shift `PASS 13/13`, vocab-harness `PASS 9/9` (common.js touched again).

- [ ] **Step 6: Commit**

```bash
git add styles/overlay.css shared/presets.js content/common.js popup.html popup.js tools/store-screenshots
git commit -m "Karaoke highlight styles: Classic gold, Neon cyan, Neon magenta, Ember, Aurora — pure CSS, live restyle"
```

---

### Task 7: Learn page — Today / Boxes / Inbox / Browse + enrichment + conjugation UI

**Files:**
- Create: `learn.html`
- Create: `learn.js`

**Interfaces:**
- Consumes: every `VOCAB_*` message from Tasks 3–4; `SV_LEITNER` (`dueCards`, `sessionOrder`, `INTERVALS`); `SV_PRICING.estCost`; storage keys `translationProvider`, `claudeModel`, `targets`.
- Produces: the extension page `learn.html` (opened via `chrome.tabs.create` from the popup chip, Task 8). Page state (active tab, filters, session) is page-local — no new settings.

- [ ] **Step 1: `learn.html`** — dark UI on the Library's palette, four tabs. Create exactly:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SubVibe Learn</title>
  <style>
    :root {
      color-scheme: dark;
      /* Same premium indigo dark palette as library.html */
      --bg: #0B0F19; --surface: #161D30; --brand: #4F46E5; --text: #F9FAFB; --muted: #9CA3AF;
      --surface-2: #1C2438; --border: #262F49; --border-soft: #1E2740;
      --brand-2: #6366F1; --brand-3: #818CF8; --brand-soft: rgba(99,102,241,.13);
      --green: #34D399; --red: #F87171; --amber: #FBBF24;
      --ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 var(--ui); -webkit-font-smoothing: antialiased; }
    button { font-family: inherit; cursor: pointer; }
    :focus-visible { outline: 2px solid var(--brand-3); outline-offset: 2px; border-radius: 6px; }

    .wrap { max-width: 880px; margin: 0 auto; padding: 26px 20px 60px; }
    header { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
    header img { width: 34px; height: 34px; border-radius: 9px; }
    header h1 { font-size: 19px; margin: 0; }
    header .sub { color: var(--muted); font-size: 12px; }

    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border-soft); margin-bottom: 18px; }
    .tab { border: 0; background: transparent; color: var(--muted); font-weight: 600; font-size: 13.5px;
      padding: 9px 14px; border-radius: 9px 9px 0 0; }
    .tab.on { color: var(--text); background: var(--surface); }
    .tab .n { color: var(--brand-3); }

    .card { background: var(--surface); border: 1px solid var(--border-soft); border-radius: 14px; padding: 18px; margin-bottom: 14px; }
    .muted { color: var(--muted); }
    .btn { border: 0; border-radius: 10px; padding: 9px 16px; font-weight: 700; font-size: 13.5px;
      background: var(--surface-2); color: var(--text); }
    .btn.primary { background: var(--brand); }
    .btn.primary:hover { background: var(--brand-2); }
    .btn:disabled { opacity: .45; cursor: default; }
    .btn.small { padding: 5px 10px; font-size: 12px; font-weight: 600; }

    /* Today / review */
    .due-big { font-size: 40px; font-weight: 800; line-height: 1.1; }
    .review { text-align: center; padding: 30px 18px; }
    .review .word { font-size: 34px; font-weight: 800; margin: 8px 0 2px; }
    .review .sentence { color: var(--muted); margin: 10px auto 0; max-width: 560px; }
    .review .back { border-top: 1px solid var(--border-soft); margin-top: 18px; padding-top: 16px; }
    .review .meaning { font-size: 20px; font-weight: 700; }
    .review .extra { color: var(--muted); font-size: 13px; margin-top: 6px; }
    .grade { display: flex; gap: 10px; justify-content: center; margin-top: 18px; }
    .again { background: #7f1d1d; }
    .good { background: #14532d; }
    .arts { display: flex; gap: 10px; justify-content: center; margin: 14px 0 4px; }
    .art { min-width: 74px; font-size: 15px; }
    .art.right { background: #14532d; }
    .art.wrong { background: #7f1d1d; }
    .progress { color: var(--muted); font-size: 12px; margin-top: 14px; }

    /* Boxes */
    .boxes { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
    .box { background: var(--surface-2); border-radius: 12px; padding: 14px 10px; text-align: center; }
    .box .cnt { font-size: 26px; font-weight: 800; }
    .box .lbl { color: var(--muted); font-size: 12px; }
    .box .nxt { color: var(--muted); font-size: 11px; margin-top: 4px; min-height: 14px; }

    /* Inbox */
    .vid { margin-bottom: 6px; }
    .vid summary { cursor: pointer; font-weight: 700; padding: 8px 4px; }
    .vid summary .muted { font-weight: 400; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 2px 4px; }
    .chip { border: 1px solid var(--border); background: var(--surface-2); color: var(--text);
      border-radius: 999px; padding: 4px 11px; font-size: 13px; }
    .chip .n { color: var(--muted); font-size: 11px; }
    .chip.sel { background: var(--brand-soft); border-color: var(--brand-2); color: var(--brand-3); }
    .vid .acts { display: flex; gap: 8px; padding: 8px 2px; }

    /* Browse */
    .filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
    .filters select { background: var(--surface-2); color: var(--text); border: 1px solid var(--border);
      border-radius: 8px; padding: 6px 8px; font: inherit; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border-soft); vertical-align: top; }
    th { color: var(--muted); font-size: 12px; font-weight: 600; }
    td .art-tag { color: var(--brand-3); font-weight: 700; }
    .lvl { display: inline-block; min-width: 26px; text-align: center; border-radius: 6px; padding: 1px 5px;
      font-size: 11px; font-weight: 700; background: var(--surface-2); }

    /* Conjugation modal */
    .modal { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; }
    .modal .inner { background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
      padding: 20px; max-width: 520px; width: 92%; max-height: 80vh; overflow: auto; }
    .modal h2 { margin: 0 0 10px; font-size: 18px; }
    .modal table { font-size: 13px; }

    .toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
      background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
      padding: 9px 16px; border-radius: 10px; font-size: 13px; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <img src="icons/icon-48.png" alt="" />
      <div>
        <h1>Learn</h1>
        <div class="sub">Vocabulary from the videos you watched · everything local</div>
      </div>
    </header>

    <nav class="tabs" id="tabs">
      <button class="tab on" data-tab="today">Today <span class="n" id="nDue"></span></button>
      <button class="tab" data-tab="boxes">Boxes</button>
      <button class="tab" data-tab="inbox">Inbox <span class="n" id="nInbox"></span></button>
      <button class="tab" data-tab="browse">Browse <span class="n" id="nCards"></span></button>
    </nav>

    <div id="enrichBar" class="card" hidden>
      <span id="enrichText"></span>
      <button class="btn primary" id="enrichBtn" style="margin-left:10px;"></button>
      <div class="muted" style="font-size:12px; margin-top:6px;">One batched request per 50 words on your selected translation provider — never automatic, logged in the Library's Activity meter.</div>
    </div>

    <section data-pane="today">
      <div class="card" id="todayCard">
        <div class="due-big" id="dueBig">0</div>
        <div class="muted" id="dueSub">cards due for review</div>
        <div style="margin-top:14px;"><button class="btn primary" id="startBtn">Start review</button></div>
      </div>
      <div class="card review" id="reviewCard" hidden></div>
    </section>

    <section data-pane="boxes" hidden>
      <div class="card"><div class="boxes" id="boxCols"></div>
        <div class="muted" style="font-size:12px; margin-top:10px;">Right → next box (reviews spread to 1 · 2 · 4 · 8 · 16 days). Wrong → back to box 1.</div>
      </div>
    </section>

    <section data-pane="inbox" hidden>
      <div class="card">
        <div class="muted" style="margin-bottom:8px;">Every watched video's words, collected free from your subtitle cache. Tap words to select, then promote them into the trainer — or dismiss what you already know.</div>
        <div id="inboxList"></div>
      </div>
    </section>

    <section data-pane="browse" hidden>
      <div class="card">
        <div class="filters">
          <select id="fLevel"><option value="">Level: all</option><option>A1</option><option>A2</option><option>B1</option><option>B2</option><option>C1</option><option>C2</option><option value="?">?</option></select>
          <select id="fArt"><option value="">Article: all</option><option>der</option><option>die</option><option>das</option></select>
          <select id="fPos"><option value="">Type: all</option><option value="noun">Nouns</option><option value="verb">Verbs</option><option value="adj">Adjectives</option><option value="adv">Adverbs</option><option value="phrase">Phrases</option><option value="other">Other</option></select>
        </div>
        <div id="browseWrap"></div>
      </div>
    </section>
  </div>

  <script src="shared/pricing.js"></script>
  <script src="shared/leitner.js"></script>
  <script src="learn.js"></script>
</body>
</html>
```

- [ ] **Step 2: `learn.js`** — create exactly:

```js
// SubVibe Learn — the Leitner trainer page. All data lives in the worker's
// vocab store; this page only renders and messages. Zero API calls except the
// two user-triggered buttons (Enrich, Conjugate), both priced/logged worker-side.
"use strict";

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || {})));
const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let cards = [];   // [{key, word, lang, box, nextDueAt, …}]
let inbox = [];   // [{base, lang, videoTitle, at, words:[{w,n,sentence,st}]}]

// ── tabs ─────────────────────────────────────────────────────────────────────
el("tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (!b) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t === b));
  document.querySelectorAll("[data-pane]").forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
});

// ── data ─────────────────────────────────────────────────────────────────────
async function refresh() {
  const [v, i] = await Promise.all([send({ type: "VOCAB_LIST" }), send({ type: "VOCAB_INBOX_LIST" })]);
  cards = v.cards || [];
  inbox = (i.inbox || []).filter((r) => r.words && r.words.length).sort((a, b) => (b.at || 0) - (a.at || 0));
  renderToday();
  renderBoxes();
  renderInbox();
  renderBrowse();
  renderEnrichBar();
}

function toast(text) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── Today: due count + review session ────────────────────────────────────────
let session = null; // { queue: cards[], i, flipped, artPick }

function renderToday() {
  const due = SV_LEITNER.dueCards(cards, Date.now());
  el("nDue").textContent = due.length ? `· ${due.length}` : "";
  el("dueBig").textContent = due.length;
  el("dueSub").textContent = due.length === 1 ? "card due for review" : "cards due for review";
  el("startBtn").disabled = !due.length;
}

el("startBtn").addEventListener("click", () => {
  const due = SV_LEITNER.dueCards(cards, Date.now());
  if (!due.length) return;
  session = { queue: SV_LEITNER.sessionOrder(due), i: 0, flipped: false, artPick: null };
  el("todayCard").hidden = true;
  el("reviewCard").hidden = false;
  renderReview();
});

function endSession(done) {
  session = null;
  el("reviewCard").hidden = true;
  el("todayCard").hidden = false;
  if (done) toast(`Session done — ${done} card${done === 1 ? "" : "s"} reviewed ✓`);
  refresh();
}

function renderReview() {
  const s = session;
  if (!s || s.i >= s.queue.length) return endSession(s ? s.i : 0);
  const c = s.queue[s.i];
  const isArtCard = c.pos === "noun" && c.art; // article quiz first, then flip
  const r = el("reviewCard");
  let html = `<div class="muted" style="font-size:12px;">Box ${c.box} · ${esc(c.videoTitle || "")}</div>`;
  if (isArtCard && !s.flipped) {
    html += `<div class="word">${s.artPick ? esc(c.art) + " " : "___ "}${esc(c.word)}</div>`;
    if (!s.artPick) {
      html += `<div class="arts">` + ["der", "die", "das"].map((a) => `<button class="btn art" data-art="${a}">${a}</button>`).join("") + `</div>`;
      html += `<div class="sentence">${esc(c.sentence || "")}</div>`;
    } else {
      const right = s.artPick === c.art;
      html += `<div class="arts"><button class="btn art ${right ? "right" : "wrong"}">${esc(s.artPick)}</button></div>`;
      html += `<div class="${right ? "" : "muted"}" style="font-weight:700;">${right ? "Richtig ✓" : `→ ${esc(c.art)} ${esc(c.word)}`}</div>`;
      html += `<div class="sentence">${esc(c.sentence || "")}</div>`;
      html += `<div style="margin-top:16px;"><button class="btn primary" id="flipBtn">Flip</button></div>`;
    }
  } else if (!s.flipped) {
    html += `<div class="word">${esc(c.word)}</div>`;
    html += `<div class="sentence">${esc(c.sentence || "")}</div>`;
    html += `<div style="margin-top:16px;"><button class="btn primary" id="flipBtn">Flip</button></div>`;
  }
  if (s.flipped) {
    html += `<div class="word">${c.art ? `<span style="color:var(--brand-3)">${esc(c.art)}</span> ` : ""}${esc(c.word)}</div>`;
    html += `<div class="back">`;
    html += `<div class="meaning">${esc(c.meaning || "(not enriched yet)")}</div>`;
    const bits = [];
    if (c.lemma && c.lemma !== c.word) bits.push(esc(c.lemma));
    if (c.plural) bits.push("pl. " + esc(c.plural));
    if (c.pos) bits.push(esc(c.pos));
    if (c.cefr) bits.push(esc(c.cefr));
    if (bits.length) html += `<div class="extra">${bits.join(" · ")}</div>`;
    if (c.phrase) html += `<div class="extra">„${esc(c.phrase)}“</div>`;
    if (c.sentence) html += `<div class="extra">${esc(c.sentence)}${c.sentenceT ? `<br>${esc(c.sentenceT)}` : ""}</div>`;
    if (c.note) html += `<div class="extra">${esc(c.note)}</div>`;
    if (c.pos === "verb") html += `<div style="margin-top:10px;"><button class="btn small" id="conjBtn">Conjugate</button></div>`;
    html += `</div>`;
    html += `<div class="grade"><button class="btn again" id="againBtn">Again</button><button class="btn good" id="goodBtn">Good</button></div>`;
  }
  html += `<div class="progress">${s.i + 1} / ${s.queue.length}</div>`;
  r.innerHTML = html;

  r.querySelectorAll("[data-art]").forEach((b) => b.addEventListener("click", () => { s.artPick = b.dataset.art; renderReview(); }));
  const flip = r.querySelector("#flipBtn");
  if (flip) flip.addEventListener("click", () => { s.flipped = true; renderReview(); });
  const conj = r.querySelector("#conjBtn");
  if (conj) conj.addEventListener("click", () => showConjugation(c));
  const grade = async (ok) => {
    const resp = await send({ type: "VOCAB_GRADE", key: c.key, ok });
    if (resp.card) { const idx = cards.findIndex((x) => x.key === c.key); if (idx >= 0) cards[idx] = { key: c.key, ...resp.card }; }
    s.i++; s.flipped = false; s.artPick = null;
    renderReview();
  };
  const again = r.querySelector("#againBtn");
  if (again) again.addEventListener("click", () => grade(false));
  const good = r.querySelector("#goodBtn");
  if (good) good.addEventListener("click", () => grade(true));
}

// ── Boxes ────────────────────────────────────────────────────────────────────
function renderBoxes() {
  const cols = el("boxCols");
  cols.innerHTML = "";
  const fmt = (t) => t <= Date.now() ? "due now" : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  for (let b = 1; b <= 5; b++) {
    const inBox = cards.filter((c) => (c.box || 1) === b);
    const next = inBox.length ? Math.min(...inBox.map((c) => c.nextDueAt || 0)) : null;
    const d = document.createElement("div");
    d.className = "box";
    d.innerHTML = `<div class="cnt">${inBox.length}</div><div class="lbl">Box ${b} · ${SV_LEITNER.INTERVALS[b - 1]}d</div>` +
      `<div class="nxt">${next != null ? "next: " + fmt(next) : ""}</div>`;
    cols.appendChild(d);
  }
}

// ── Inbox ────────────────────────────────────────────────────────────────────
function renderInbox() {
  const totalWords = inbox.reduce((a, r) => a + r.words.length, 0);
  el("nInbox").textContent = totalWords ? `· ${totalWords}` : "";
  const list = el("inboxList");
  list.innerHTML = inbox.length ? "" : '<div class="muted">Nothing here yet — watch a subtitled video, then reopen this page.</div>';
  for (const row of inbox) {
    const d = document.createElement("details");
    d.className = "vid";
    d.open = inbox.length <= 3;
    const sum = document.createElement("summary");
    sum.innerHTML = `${esc(row.videoTitle)} <span class="muted">· ${row.words.length} words · ${esc(row.lang)}</span>`;
    d.appendChild(sum);
    const chips = document.createElement("div");
    chips.className = "chips";
    for (const w of row.words) {
      const c = document.createElement("button");
      c.className = "chip";
      c.title = w.sentence || "";
      c.innerHTML = `${esc(w.w)} <span class="n">×${w.n}</span>`;
      c.addEventListener("click", () => c.classList.toggle("sel"));
      c.dataset.w = w.w;
      chips.appendChild(c);
    }
    d.appendChild(chips);
    const acts = document.createElement("div");
    acts.className = "acts";
    const selected = () => [...chips.querySelectorAll(".chip.sel")].map((c) => c.dataset.w);
    const mk = (label, cls, fn) => {
      const b = document.createElement("button");
      b.className = "btn small " + cls;
      b.textContent = label;
      b.addEventListener("click", fn);
      return b;
    };
    acts.appendChild(mk("Promote selected", "primary", async () => {
      const words = selected();
      if (!words.length) return toast("Tap some words first");
      const r = await send({ type: "VOCAB_PROMOTE", base: row.base, words });
      toast(`${r.promoted || 0} word${r.promoted === 1 ? "" : "s"} promoted → box 1`);
      refresh();
    }));
    acts.appendChild(mk("Dismiss selected", "", async () => {
      const words = selected();
      if (!words.length) return toast("Tap some words first");
      await send({ type: "VOCAB_DISMISS", base: row.base, words });
      refresh();
    }));
    acts.appendChild(mk("Select all", "", () => chips.querySelectorAll(".chip").forEach((c) => c.classList.add("sel"))));
    d.appendChild(acts);
    list.appendChild(d);
  }
}

// ── Browse ───────────────────────────────────────────────────────────────────
["fLevel", "fArt", "fPos"].forEach((id) => el(id).addEventListener("change", renderBrowse));

function renderBrowse() {
  el("nCards").textContent = cards.length ? `· ${cards.length}` : "";
  const lv = el("fLevel").value, ar = el("fArt").value, po = el("fPos").value;
  const rows = cards
    .filter((c) => (!lv || c.cefr === lv) && (!ar || c.art === ar) && (!po || c.pos === po))
    .sort((a, b) => String(a.word).localeCompare(String(b.word)));
  const wrap = el("browseWrap");
  if (!rows.length) { wrap.innerHTML = '<div class="muted">No cards match. Save words by clicking them on a video, or promote from the Inbox.</div>'; return; }
  const fmt = (t) => (t || 0) <= Date.now() ? "due" : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  wrap.innerHTML = `<table><thead><tr><th>Word</th><th>Meaning</th><th>Type</th><th>Level</th><th>Box</th><th>Due</th><th></th></tr></thead><tbody>` +
    rows.map((c) => `<tr>
      <td>${c.art ? `<span class="art-tag">${esc(c.art)}</span> ` : ""}${esc(c.word)}${c.plural ? `<div class="muted" style="font-size:11px;">pl. ${esc(c.plural)}</div>` : ""}</td>
      <td>${esc(c.meaning || "")}${c.phrase ? `<div class="muted" style="font-size:11.5px;">„${esc(c.phrase)}“</div>` : ""}</td>
      <td>${esc(c.pos || "—")}</td>
      <td><span class="lvl">${esc(c.cefr || "·")}</span></td>
      <td>${c.box || 1}</td>
      <td class="muted">${fmt(c.nextDueAt)}</td>
      <td>${c.pos === "verb" ? `<button class="btn small" data-conj="${esc(c.key)}">Conjugate</button>` : ""}</td>
    </tr>`).join("") + "</tbody></table>";
  wrap.querySelectorAll("[data-conj]").forEach((b) => b.addEventListener("click", () => {
    const c = cards.find((x) => x.key === b.dataset.conj);
    if (c) showConjugation(c);
  }));
}

// ── Conjugation (one request per verb ever; cached on the card) ──────────────
async function showConjugation(c) {
  const r = await send({ type: "VOCAB_CONJUGATE", key: c.key });
  if (r.error) return toast(r.error);
  if (!r.cached) { const idx = cards.findIndex((x) => x.key === c.key); if (idx >= 0) cards[idx].conj = r.conj; }
  const PERSONS = ["ich", "du", "er/sie/es", "wir", "ihr", "sie/Sie"];
  const rows = Object.entries(r.conj || {}).map(([label, v]) => {
    const val = Array.isArray(v)
      ? v.map((f, i) => (v.length === 6 && !/^\s*(ich|du|er|wir|ihr|sie)/i.test(String(f)) ? `${PERSONS[i]} ${esc(f)}` : esc(f))).join("<br>")
      : esc(v);
    return `<tr><th style="white-space:nowrap; vertical-align:top;">${esc(label)}</th><td>${val}</td></tr>`;
  }).join("");
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="inner"><h2>${esc(c.lemma || c.word)}</h2><table>${rows}</table>
    <div style="margin-top:14px; text-align:right;"><button class="btn" id="closeConj">Close</button></div></div>`;
  m.addEventListener("click", (e) => { if (e.target === m || e.target.id === "closeConj") m.remove(); });
  document.body.appendChild(m);
}

// ── Enrichment bar (never automatic; price shown BEFORE the click) ───────────
async function renderEnrichBar() {
  const todo = cards.filter((c) => !c.cefr || c.cefr === "?");
  const bar = el("enrichBar");
  if (!todo.length) { bar.hidden = true; return; }
  const s = await chrome.storage.local.get(["translationProvider", "claudeModel"]);
  const provider = s.translationProvider === "claude" ? "claude" : "openai";
  const model = provider === "claude" ? (s.claudeModel || "claude-sonnet-5") : "gpt-4o-mini";
  // ~35 tokens per word+sentence in, ~45 out, ~260-token system prompt per batch of 50.
  const n = todo.length;
  const usd = SV_PRICING.estCost({ provider, model, inTok: n * 35 + Math.ceil(n / 50) * 260, outTok: n * 45 });
  bar.hidden = false;
  el("enrichText").textContent = `${n} word${n === 1 ? "" : "s"} without article, level and meaning yet.`;
  const btn = el("enrichBtn");
  btn.textContent = `Enrich ${n} new word${n === 1 ? "" : "s"} · ~$${usd < 0.005 ? usd.toFixed(4) : usd.toFixed(2)}`;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Enriching…";
    const r = await send({ type: "VOCAB_ENRICH", keys: todo.map((c) => c.key) });
    btn.disabled = false;
    if (r.error) { toast(r.error); renderEnrichBar(); return; }
    toast(`${r.enriched} enriched · $${(r.usd || 0).toFixed(4)} (logged in Activity)`);
    refresh();
  };
}

// ── boot: build the inbox (free, local scan of the subtitle cache), then render ──
(async () => {
  await send({ type: "VOCAB_INBOX_BUILD" });
  await refresh();
})();
```

- [ ] **Step 3: Verify against the real cache**

Reload the extension, open `chrome-extension://<id>/learn.html`:
1. Inbox lists your cached videos with words (no `der/die/und` noise), counts, sentence tooltips.
2. Select a few words → Promote → they show in Browse (Today counter rises; new cards are due immediately).
3. Enrich bar: "Enrich N new words · ~$0.0x" — click, watch the toast; Browse now shows der/die/das tags, levels, meanings; Library → Activity shows the row.
4. Start review: a noun card asks der/die/das first, feedback, flip, Again/Good works; Boxes tab counts move.
5. A verb row's Conjugate opens the table; a second click is instant (`cached:true`, no Activity row).
6. Filters (level/article/type) narrow the table correctly.

- [ ] **Step 4: Commit**

```bash
git add learn.html learn.js
git commit -m "Learn page: Today review (article quiz + flip), Boxes, per-video Inbox, Browse filters, priced enrichment"
```

---

### Task 8: popup chip — 🎓 opens the trainer

**Files:**
- Modify: `popup.html` (header block ~:316-323 + one CSS rule in its `<style>`)
- Modify: `popup.js` (init block that ends with `pollDub();`)

**Interfaces:**
- Consumes: `VOCAB_DUE_COUNT` (Task 3).
- Produces: header chip, `chrome.tabs.create({url: learn.html})`.

- [ ] **Step 1: markup + CSS**

In `popup.html`'s `<header>`, after the inner `<div>` (the one holding h1/tag/ver), add:

```html
    <button id="learnChip" class="learnchip" title="Vocabulary trainer — review words you saved from videos">🎓 <span id="learnDue">Learn</span></button>
```

In the popup's `<style>`, near the header rules, add:

```css
    .learnchip { margin-left: auto; align-self: flex-start; border: 1px solid var(--border, #262f49);
      background: transparent; color: var(--text, #f9fafb); border-radius: 999px; padding: 5px 11px;
      font: 600 12px/1 inherit; cursor: pointer; white-space: nowrap; }
    .learnchip:hover { border-color: #6366f1; color: #818cf8; }
```

(If `header` isn't `display:flex`, wrap: check the existing header CSS first and match its layout — the chip must sit right-aligned in the header row without moving the wordmark.)

- [ ] **Step 2: wiring**

In `popup.js`, inside the init block that ends with `pollDub();`, add before it:

```js
  // 🎓 chip: due-count from the trainer; label "Learn" until the first card exists.
  chrome.runtime.sendMessage({ type: "VOCAB_DUE_COUNT" }, (r) => {
    if (chrome.runtime.lastError || !r) return;
    el("learnDue").textContent = r.total ? `${r.due} due` : "Learn";
  });
  el("learnChip").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("learn.html") }));
```

- [ ] **Step 3: Verify**

Open the popup: chip shows "🎓 N due" (or "🎓 Learn" with an empty trainer); clicking opens learn.html in a tab. Popup layout unshifted (header intact at both widths of the popup).

- [ ] **Step 4: Commit**

```bash
git add popup.html popup.js
git commit -m "Popup: 🎓 due-count chip in the header opens the Learn page"
```

---

### Task 9: full regression + package check

**Files:** none new (verification only; fix whatever it surfaces).

- [ ] **Step 1: node tests**

Run: `node --test tools/tests/*.test.mjs`
Expected: ALL green — the 2 new files (leitner, vocab) plus the 5 existing (audio-export, pricing, srt, title, voices).

- [ ] **Step 2: browser harnesses**

- `tools/tests/vocab-harness/harness.html?autorun=1` → `PASS 9/9`
- `tools/tests/adopt-harness/harness.html?autorun=1` (~35s) → `PASS 7/7`
- `tools/tests/live-shift-harness/harness.html?autorun=1` → `PASS 13/13`

- [ ] **Step 3: package both builds**

```bash
./build.sh && ./build.sh --firefox
```

Expected: both zips build; the content listing includes `learn.html`, `learn.js`, `shared/leitner.js`, `shared/stopwords.js`, `shared/vocab.js`, `tools/` excluded. (Do NOT commit the zips or the unrelated manifest/marker changes.)

- [ ] **Step 4: end-to-end eye test (operator-shaped)**

On a real German video (YouTube/ZDF/DW) with subtitles on:
1. Click a word in the original line → green pulse; popup chip count reflects it.
2. Switch highlight styles in the popup Style tab → live restyle, no flicker, aurora animates.
3. Open Learn via the chip → inbox has the video; promote → enrich → review one card.

- [ ] **Step 5: Final review + commit anything the regression surfaced**

Run the adversarial-verify skill against the whole branch diff (`git diff main...vocab-leitner`) before declaring done.

---

## Execution notes

- Tasks 1→2→3→4 are strictly ordered (each consumes the previous). Task 5 needs Task 3 (message contract). Task 6 is independent of 1–5. Task 7 needs 3+4. Task 8 needs 3. Task 9 last.
- Line numbers referenced are as of commit `244b85e` — re-locate anchors by the quoted code, not the number, if drift occurred.
- Never touch: `manifest.json` (pre-existing unrelated edit), `marker.png`, the `persist()` cache writer in common.js, anything in `content/adapters/`.
