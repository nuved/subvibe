# Word game — step 2 (grammar cards) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** The sentence-based card types — builder (word order), grammar gap (articles), find-it (tap the prefix/verb) — mixed into rounds by default, plus the step-1 debts the final review scheduled: factor the duplicated round-runner into shared/gameui.js FIRST, a11y cleanup, learn-ids guard, mini-bar composition, tokenized learning color.

**Architecture:** All card-type LOGIC is pure and node-tested in shared/game.js (token splitting, gap detection, find-target derivation, kind mixing). shared/gameui.js (factored in T1) owns ALL DOM rendering for rounds and gains the three renderers; popup.js and learn.js shrink to thin delegates. Enrichment adds a `sep` flag at the source; `art` (already stored) powers the article gap.

**Spec:** docs/superpowers/specs/2026-08-11-word-game-design.md §2 card types 2–4 + animation rules; scope sheet gains the Game row (§3).

## Global Constraints

- Branch `word-game-step2`; no AI trailers; suite green at every commit (`node --test tools/tests/*.test.mjs`, currently 95/95) + `node tools/audit.mjs`.
- No „ in generated UI (guard test enforces; extend its file list with shared/gameui.js — T1 does this).
- No stress numbers; textContent for user data; reduced-motion gates every new animation; tokens-only CSS (T5 retires the #F4A61 literal via a new `--learning` token).
- Wrong answers NEVER punish silently: every wrong interaction shows the relevant rule/reveal, waits for Next.
- Card-type fallback: a card that can't support the chosen kind falls back to the meaning-choice card — a round NEVER dead-ends because a sentence was too short/long or `art`/prefix data was missing.
- popup-ids + (new) learn-ids contracts hold at every commit.

---

### Task 1: factor shared/gameui.js (behavior-identical refactor)

**Files:** Create `shared/gameui.js` · Modify `popup.js`, `learn.js`, `popup.html`, `learn.html` (script tags), `tools/tests/no-low-quotes.test.mjs` (add gameui.js to the list — it's already future-proofed with an existsSync guard)

- Extract the round-runner duplicated across popup.js/learn.js (session start → card render → answer handling → requeue → round end → records; the advanceTimer teardown; the enrich-pointing empty state) into ONE module `globalThis.SV_GAMEUI` with an explicit host adapter:
  `SV_GAMEUI.start({ mount, cards, pool, scope, lang, perDay, storage: {get,set}, send, onExit, ui: {reducedMotion} })`
  — the HOST supplies chrome plumbing; gameui owns DOM + flow. Both surfaces delegate; their local copies are DELETED, not shadowed.
- Zero behavior change: identical class names, timings, storage semantics (fresh-read RMW pattern from the final fix wave MOVES INTO gameui — verify all 8 RMW sites end up in ONE place).
- Verification: full suite; vocab-harness 26/26; live rounds on BOTH surfaces with the stubs (correct + wrong flows, Done teardown, records persist).
- [ ] Commit: `Word game: factor shared round-runner into gameui.js (both surfaces delegate)`

### Task 2: pure card-type logic in shared/game.js (+tests)

**Files:** Modify `shared/game.js` · extend `tools/tests/game.test.mjs`

Add to SV_GAME (all pure; rng-injectable; node tests for each, including fallback-to-word cases):
- `builderFor(card, rng)` → `{ solution: [tokens], chips: [shuffled tokens] } | null` — tokens = sentence split on whitespace, punctuation kept attached; null when tokens < 3 or > 12 (spec: playable range) or sentence missing.
- `gapFor(card)` → `{ before, after, options: ["der","die","das"], correct } | null` — only when `card.art` ∈ {der,die,das} AND the sentence contains the article token (case-insensitive standalone word) directly before a capitalized noun token containing card.word's stem; blank exactly that article occurrence. Null otherwise.
- `findFor(card)` → `{ tokens: [sentence tokens], answerIndex, ask } | null` — separable verbs (isSep): the standalone prefix token from `lemma.split("|")[0]` (word-boundary match, prefer the LAST occurrence — German prefixes sit at the end); ask = "prefix". Non-sep verbs whose word appears as a token: ask = "verb", answerIndex = that token. Null otherwise.
- `kindsFor(card)` → subset of ["word","builder","gap","find"] the card supports (word always; others when their *For returns non-null).
- `pickKind(card, gameMode, rng)` → gameMode "words" → "word"; "sentences" → random supported non-word kind, fallback "word"; "mixed" (default) → ~40% word / 60% split across supported sentence kinds, fallback "word".
- Rule-hint strings live with the logic: `builderHint(card)` (verb-second / prefix-to-end when isSep), `gapRule(card)` ("die Geduld — feminine…" style from art + word + note when present) — plain strings, no markup, NO „.
- [ ] Tests first (RED) → implement → green → Commit: `Word game: builder/gap/find card logic (pure, tested) + kind mixing`

### Task 3: render the three kinds in gameui.js + Game row

**Files:** Modify `shared/gameui.js`, `popup.html` + `learn.html` (CSS for chips/gap/find + Game row markup if sheet is static), stubs if needed

- Builder: translation line (sentenceT or meaning) on top; tap chips → they move into the answer strip in tap order (tap a placed chip to return it); wrong final order → coral shake + `builderHint` + correct order revealed + Next; correct → teal + auto-advance. Grade maps: fully-correct-first-try = ok:true, else ok:false.
- Gap: sentence with the blanked article (three option buttons); wrong → rule line (`gapRule`) + correct lights teal + Next; correct → auto-advance.
- Find: sentence tokens as tappable spans; wrong token → brief coral flash on it (no lockout), correct → teal + source-citation reward line (`you heard it in <videoTitle>` + timestamp when the card has `ms`); one grade per card (first tap decides ok).
- Speed ring, dots, streak, records, requeue: identical machinery across kinds (they're per-card, kind-agnostic — verify).
- Scope sheet gains the Game row: Mixed · Words only · Sentences only → `gameScope[lang].game` (default "mixed"); buildSession unchanged (kind picked per card at render via `pickKind`).
- [ ] Live-verify every kind's both flows on both surfaces + reduced-motion → Commit: `Word game: sentence builder, article gap, find-it cards + Game mode row`

### Task 4: enrichment `sep` flag

**Files:** Modify `background.js` (enrich prompt + response mapping), `tools/tests/game.test.mjs` (one test: isSep via sep flag without pipe-lemma)

- The word-enrich prompt (grep VOCAB_CLIP_ENRICH / enrich schema in background.js) gains one output field: `sep` (boolean, true only for German separable verbs), mapped onto stored cards like `art` is. Fallback (lemma pipe) stays.
- [ ] Commit: `Word game: separable-verb flag from enrichment`

### Task 5: scheduled debts

**Files:** Modify `popup.js`, `learn.js` (a11y), `popup.html`/`learn.html` + `styles/tokens.css` (color token), create `tools/tests/learn-ids.test.mjs`

- Button-in-button fix: lnWordRow (popup.js) and buildWordRow (learn.js) — the row wrapper becomes a div with the row-level click handler; inner actions stay buttons (keyboard order verified; no visual change).
- `--learning: #F4A261` token added to tokens.css (light+dark same value; comment: progress/learning accent) — replace both hard-coded literals; extend the tokens contract test.
- popup deck mini-bar becomes a true composition bar (new/learning/mastered widths) per spec §1 — fix noted by final review.
- learn-ids guard test: mirror popup-ids for learn.js×learn.html (el()/getElementById refs incl. runtime-defined ids).
- [ ] Commit: `Word game: a11y row fix, learning token, composition mini-bar, learn-ids guard`

### Task 6: acceptance sweep + PR

- [ ] Full suite + audit + both builds; adopt 7/7 · track-switch 6/6 · vocab 26/26; live: mixed round hits all four kinds across a seeded deck (stub cards must include an `art` noun, a pipe-lemma sep verb, a long sentence >12 tokens proving builder fallback, an unenriched card proving exclusion); dark + reduced-motion; no-„ grep.
- [ ] Push, `gh pr create` (base main) — leave OPEN for operator playtest. Body summarizes card types + debts closed.
