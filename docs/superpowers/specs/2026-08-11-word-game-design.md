# SubVibe word game & trainer redesign — design spec

Date: 2026-08-11 · Status: approved by operator (long mock-driven design
session; every screen reviewed as an image). Supersedes the "auto-decks"
sketch in the 2026-08-10 growth roadmap — decks became playable games.

## Goal

Make daily vocabulary review something people *want* to do — a game, not
homework — reachable with zero extra navigation, calm by design (no stress
numbers anywhere), and shareable so every gifted game recruits new users.

## Non-negotiable principles (operator)

- **No stress numbers.** No toolbar badge, no due-counts shouting, no
  backlog totals in entry points. Numbers appear only as celebration
  (records, round scores) or quiet meta (word counts in pickers).
- **Material-first.** Words and sentences are the interface; mechanics
  (boxes, scheduling) stay invisible behind a "how it works" fold.
- **No „low-first" quotation marks in ANY UI we generate.** Sentences in
  game/word cards render italic with NO surrounding quotes; generated
  quotes are always “…” (Latin) or «…» (fa/ar/ur/ps/ckb).
  `SV_QUOTES.wrap()` loses its German special case. Original subtitle
  lines on the video keep their source punctuation untouched.
- **Local-only.** No servers; sharing is files + prepared text.

## 1 · The Learn tab = the arcade

Top to bottom:

1. Header row: "Your games" · "Full trainer →" (opens learn.html).
2. **One game card per language** with saved words: flag, language name,
   scope line ("B1+ · separable verbs · everything · Change"), a thin
   new/learning/mastered mini-bar, and a big **Play**. One language = one
   card. Cards auto-exist; never created or managed by hand.
3. **The fold: "▸ This video's words · N collected"** — collapses to one
   line; opens IN PLACE (accordion, same pattern as the Style tab folds).
   Contains everything the section has today, unchanged unless noted:
   - Learning selector (German ▾ → Persian) — still controls collection.
   - Level chips (All/A2+/B1+) + type dropdown.
   - Word rows + **status dot** (gray new · orange learning · teal
     mastered), ×N seen count, CEFR chip, meaning; sentence with the word
     in amber (italic, NO quote marks); Persian line; expandable detail
     (grammar, ▶ timestamp, seen-N× with other-video list) as today.
   - **"know it ✓"** per row: instantly marks mastered (replaces per-word
     add). **"Add all" is retired** — collected words are automatically
     available to practice; pacing feeds them.
   - ✨ Enrich button unchanged (explicit, shows count + est. cost).
   - Header link **"Play only these →"**: a round scoped to this video.
   - Empty/mismatch states render INSIDE the fold (games above stay
     playable): "Open a video with subtitles…" / "This video is in
     English — switch Learning to English to collect its words too."
4. Bottom bar (spend · Library) unchanged.

Transitions (the only three): fold open/close in place · Play → round
covers the tab for the session · ← Done / round end → back exactly where
you were. Tab pills stay usable mid-round; the session waits.

## 2 · The game

**Round = 10 cards** drawn from the deck's scope (due reviews first, then
paced-in new words). Card types mix by default.

### Card type 1 — Word (meaning choice)
Sentence (italic, amber target word) + the word + CEFR chip + **4 meaning
options in the user's base language**, one correct + 3 distractors drawn
from the same deck. **Options reshuffle position AND distractor set every
appearance.**

### Card type 2 — Sentence builder
The sentence's translation shown; German words as shuffled chips; user
rebuilds the order. Wrong placement → inline rule hint (verb-second,
prefix-to-end for trennbare Verben). Costs zero AI — pure cache reuse.

### Card type 3 — Grammar gap
The sentence with a grammar element blanked: article (der/die/das), case
or verb form, options from enrichment data. Wrong tap → rule card ("die
Geduld — feminine; -ung/-heit/-keit → die").

### Card type 4 — Find it
"Tap the separable prefix / the verb / the Akkusativ object" in the
rendered sentence. Reward line cites the source: "you heard it in Easy
German 265 at 04:12."

### Interactions & animation (timings are part of the spec)
- Card enters sliding from the right, 180ms ease-out.
- **Speed ring**: ~6s conic drain at top-right. Answer while alive → ⚡
  bonus. Empty ring = NO penalty; the card waits forever.
- **Correct**: option flashes teal + glow, 2 ✨ sparks, "+1" pops and
  flies to the streak flame (bounce), "⚡ fast!" if within ring, progress
  dot → teal, auto-advance 0.8s.
- **Wrong**: 300ms shake, option coral; correct option lights teal; the
  wrong option **flips open and teaches its own word**: "💡 تجربه is die
  Erfahrung — [its sentence]". Streak resets to gray (no red). NO
  auto-advance — "Next →" only. The word re-queues later in the round.
- Leitner mapping: correct = advance box; wrong = box 1. Every answer
  commits instantly (popup close mid-round loses nothing).
- `prefers-reduced-motion`: no slide/pulse/spark animations.

### Round end
Score ring draws (600ms) — n/10, time, ⚡ count. Records strip: day
streak, best round, fastest perfect. New record → 🏆 banner slides in.
Missed words repeated as material (word · meaning · sentence). Buttons:
"One more round" / "Done". Records persist per language deck; also shown
on trainer Practice tab. Records only ever celebrate.

## 3 · Scope & pacing

- **Scope** (per deck, remembered): Source (Everything · This video · top-3
  ranked channels · search-all), Level (All/A2+/B1+/C1+), Word type (All /
  nouns / verbs / **separable verbs** / phrases), Game (Mixed · Words only
  · Sentences only). UI: the scope line on the card reads as a sentence;
  "Change" opens chip rows.
- **Source list scaling**: chips never exceed 5 (Everything · This video ·
  3 ranked by recency + unlearned words). Everything else behind
  type-ahead search, results grouped by channel with counts, videos as
  drill-down. Sources with all words mastered fade out with 🎉.
- **Pacing**: ~20 new cards/day (adjustable slider 5–50 in the Change
  sheet) drawn INSIDE the scope, mixed with genuinely due reviews.
  Backlogs are never displayed as due anywhere.
- Data: separable-verb flag from enrichment (new field `sep: true`);
  detection fallback for existing cards: lemma contains "|" or reunited
  lemma differs from surface by a leading-prefix pattern. Channel captured
  at save time (adapter), field `channel`; old rows lack it gracefully.

## 4 · Trainer page (learn.html)

Two tabs (from three): **Practice** — the same game cards larger, records
strip, progress bar (new/learning/mastered) replacing the five boxes,
"how the schedule works" fold with the Leitner explanation; **Words** —
every collected word: search + the same scope chips + status filter;
rows = word · dot · chip · meaning · sentence · source; "know it ✓"
everywhere. Inbox and Dictionary retire into Words. Grade buttons keep
spec §5 colors (soft coral Again / soft teal Got it) where flip-review
remains available (card detail view).

## 5 · Sharing (build step 3)

- **Share** (⇪ on a deck card, trainer page): one sheet with
  (a) `navigator.share` files → OS share sheet (WhatsApp/Telegram/Mail/
  AirDrop) where supported; (b) prefilled-text deep links (wa.me,
  t.me/share) + file download fallback; (c) Copy text / File only.
- File: `<Lang>-by-<name>.svbox` — versioned JSON: cards (word, lemma,
  CEFR, pos, sep, meaning, sentence, sentence translation, grammar note,
  source title/channel), language, optional sender name. **No review
  state, no records** — receiver starts fresh boxes but keeps ALL
  enrichment (one person pays, the group learns free).
- Prepared message (editable): what the gift is + SubVibe store link +
  "free, no AI key needed". This is the growth loop.
- Import: drag-drop on Learn tab or trainer Import; dedupe by
  (word, lang) — reimport updates, never duplicates; imported deck card
  shows optional "from <name> 🎁". Files are untrusted input: schema
  version, size caps, string-type validation, no HTML injection (all
  rendering via textContent).

## 6 · Build steps (each independently shippable)

1. **Core game**: leitner.js extensions (scope query, pacing, records,
   status), shared/game.js session engine (node-tested), arcade +
   fold restructure in popup, word-meaning card type, round end, trainer
   Practice/Words restructure, quotes rule.
2. **Grammar cards**: builder / gap / find-it card types, Mixed default,
   sep-verb flag in enrichment, source-citation reward lines.
3. **Sharing**: .svbox export/import, share sheet, prepared text.

## Acceptance (step 1)

- Node tests: session builder (scope filtering, pacing counts, distractor
  selection excludes the answer & dupes, reshuffle), records update,
  status derivation (new/learning/mastered from box), know-it transition.
- Existing suites stay green (popup-ids, design pages, quotes, textslice,
  harnesses). Popup ids contract holds — Learn pane ids may change ONLY
  together with popup.js (test enforces).
- No „ anywhere in generated UI (test greps the built markup/templates).
- Reduced-motion honored; RTL meanings render correctly; theme-aware
  (tokens only, works light and dark).
- The five no-stress rules hold: no badge, no due counts on entries, no
  backlog totals, records celebrate only, empty states calm.
