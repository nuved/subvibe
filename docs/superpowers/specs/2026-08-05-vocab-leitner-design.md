# Vocabulary Leitner Box + Karaoke Highlight Styles — Design

Operator-approved 2026-08-05 (chat). One branch (`vocab-leitner`), two features:
a Leitner-system vocabulary trainer fed by watched videos, and expressive
karaoke active-word styles. Economy is a hard requirement: everything local
that can be local; AI enrichment batched and only for words the user chose.

## Goals

- Click a subtitle word while watching → saved to the trainer with its real
  sentence, that sentence's cached translation, video title + timestamp.
- Every watched video's words auto-collect into a FREE local inbox (stopwords
  filtered, frequency counted) for skim-and-promote curation.
- Promoted words get ONE batched AI enrichment (50 words/request): lemma,
  part of speech, der/die/das + plural for nouns, CEFR level (A1–C2),
  meaning in the user's target language, one short natural phrase.
- Verb conjugation tables on demand (one small request per verb, cached
  forever in the word row).
- Review = classic 5-box Leitner: flip-cards with self-grade; nouns ask
  der/die/das before the flip; verbs carry a conjugate button.
- Browse the collection filtered by level / article / part of speech /
  phrases.
- New karaoke highlight styles: Classic gold, Neon cyan, Neon magenta,
  Ember, Aurora (animated gradient) — pure CSS on `.sung`, global setting.

## Non-goals (v1)

- No typing tests, no multiple choice (flip + article quiz only).
- No cross-device sync (IndexedDB local, like every other SubVibe store).
- German-first but language-generic: `lang` is a field, not an assumption;
  the article card renders only when the enrichment returned an article.
- No auto-promotion, no notification nagging.

## Architecture

Same pattern as everything else in SubVibe: the background worker owns
storage and network; pages/content talk to it over runtime messages.

- `shared/leitner.js` — PURE module: box math, due-date computation, session
  ordering, grade transitions. `node --test`-able, no chrome.* access.
  - Boxes 1–5, review intervals [1, 2, 4, 8, 16] days (box 5 stays 16).
  - `grade(card, ok, now)` → new box + nextDueAt. Wrong → box 1.
  - `dueCards(cards, now)`, `sessionOrder(cards)` (article cards mixed in).
- `background.js` — new object store `vocab` (DB version bump 2→3) plus
  message cases:
  - `VOCAB_ADD` {word, sentence, translation, lang, videoTitle, base, ms}
    → upsert card (box 1, source recorded). Key: `${lang}:${lowercased word}`.
  - `VOCAB_INBOX_PUT` {base, lang, videoTitle, words:[{w, n, sentence}]}
    → per-video inbox row (store key `inbox:${base}`).
  - `VOCAB_LIST` {filter} → cards; `VOCAB_INBOX_LIST` → inbox rows.
  - `VOCAB_PROMOTE` {base, words[]} → cards from inbox entries;
    `VOCAB_DISMISS` {base, words[]} → tombstones (never re-inboxed).
  - `VOCAB_GRADE` {key, ok} → shared/leitner.js transition, persisted.
  - `VOCAB_ENRICH` {keys[]} → batches of 50 → provider (same
    translationProvider/key plumbing as TRANSLATE, logged through the same
    pricing meter) → strict JSON schema below → merged into cards.
  - `VOCAB_CONJUGATE` {key} → one request, table cached on the card.
- `content/common.js` — ONE small addition:
  - Karaoke spans get a click handler in cuelist mode (capture-phase, does
    not pause the video): saves via VOCAB_ADD with the active cue's original
    sentence + primary-target translation; brief `.saved` pulse on the span.
  - NO harvest hook in the engine: the worker already holds every cached
    track, so the inbox is built worker-side (below) with zero engine risk.
- Inbox build (worker): `VOCAB_INBOX_BUILD` scans the `tracks` store,
  extracts unique original-language words per clip (stopwords filtered,
  frequency counted, first-occurrence sentence kept), writes `inbox:${base}`
  rows, skips clips already inboxed or dismissed. Triggered when the Learn
  page opens. Stopword list bundled in `shared/stopwords.js` (top ~200
  function words for de/en; other languages pass through), loaded in the
  worker via importScripts like shared/pricing.js.
- `learn.html` + `learn.js` — new extension page (dark UI like Library):
  - Today: due count + Start review (flip cards, Again/Good buttons;
    noun cards show der/die/das buttons first, then flip).
  - Boxes: five columns visualizing card counts and next-due.
  - Inbox: per-video groups, checkbox promote / dismiss.
  - Browse: filters level (A1–C2), article (der/die/das), POS
    (noun/verb/adjective/adverb/phrase/other); verb rows have Conjugate.
  - Enrichment runs from here ("Enrich N new words · ~$0.0x") — never
    automatic, cost shown before click, meter logs after.
- `popup` — one chip in the header area: "🎓 N due" → opens learn.html.
  (`chrome.tabs.create`; no new permissions.)
- `styles/overlay.css` + `shared/presets.js` — highlight styles as a
  `karaokeStyle` global setting ("classic" | "neon-cyan" | "neon-magenta" |
  "ember" | "aurora"); Style tab gains a "Highlight" row of five swatch
  buttons. Aurora uses a CSS keyframe gradient on background-clip:text —
  falls back to classic color if the browser lacks it.

## Enrichment schema (strict JSON, one batch = 50 words)

Request: system prompt states the source language and target language and
demands arrays aligned to the input order. Response schema:

```json
{ "e": [ { "lemma": "string", "pos": "noun|verb|adj|adv|phrase|other",
  "art": "der|die|das|-", "plural": "string|-", "cefr": "A1|A2|B1|B2|C1|C2",
  "meaning": "string", "phrase": "string", "note": "string|-" } ] }
```

Same strict-schema pattern as TRANSLATE_SCHEMA (OpenAI structured outputs;
Claude JSON-in-prompt with the existing fallback). Short-array back-fill:
missing entries get `pos:"other", cefr:"?"` and stay enrichable.

Conjugation request (verbs, on demand): returns
`{ "forms": { "präsens": [...6], "präteritum": [...6], "perfekt": "string",
"imperativ": [...2], "konjunktivII": "string" } }` for German; for other
languages the provider fills equivalent tense rows keyed by label —
rendered as a plain table, keys are display labels.

## Data model (vocab store)

```js
// key `${lang}:${word}`
{ word, lang, box: 1, nextDueAt, addedAt, lastGradedAt,
  sentence, sentenceT, videoTitle, base, ms,     // capture context
  n: 3,                                          // seen-count across videos
  lemma, pos, art, plural, cefr, meaning, phrase, note, // enrichment (null until enriched)
  conj: null,                                    // conjugation table cache
  history: [ { at, ok } ]                        // last 20 grades
}
// key `inbox:${base}` → { base, lang, videoTitle, at, words: [{w, n, sentence}] }
// key `dismissed:${lang}` → { words: Set-as-array }
```

## Settings

- `karaokeStyle` (global, default "classic") — LIVE_KEYS-style live restyle,
  no engine restart.
- No other new settings; Learn page state (filters) is page-local.

## Economy summary

- Capture, inbox, review, browse: 0 API calls.
- Enrichment: ceil(N/50) requests, only for promoted words, user-triggered,
  priced up front, logged in the meter.
- Conjugation: 1 request per verb ever (cached).

## Firefox

No new Chrome-only APIs (IndexedDB + runtime messages + tabs.create). Learn
page ships in both builds unchanged.

## Testing

- `tools/tests/leitner.test.mjs` — node tests: grade transitions, due math
  across day boundaries, wrong→box1, box5 cap, session ordering.
- `tools/tests/vocab-harness/` — file:// harness with the chrome stub:
  click a karaoke word → VOCAB_ADD payload asserted (sentence + translation
  + pulse class). Inbox build and enrichment merge are worker-side pure-ish
  functions — factored so `node --test` covers them directly (stopword
  filtering, counts, schema merge, short-array back-fill).
- Highlight styles: eye test + a screenshot per style for the store/docs.
- Engine regression: adopt-harness 7/7, live-shift 13/13 must stay green
  (common.js is touched by the click handler + harvest hook).
