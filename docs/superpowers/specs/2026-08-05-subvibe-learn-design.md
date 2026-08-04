# SubVibe Learn — design spec

**Date:** 2026-08-05
**Status:** Approved design, ready for implementation planning
**Scope:** Turn watched subtitles into an owned vocabulary + spaced-repetition trainer, plus a highlight-palette color system for the overlay. Built to be implemented across several sessions with as much parallel work as possible.

---

## 1. Vision

Every subtitle you watch becomes vocabulary you own. Tap a word in the overlay → look it up (meaning, examples, grammar, CEFR level, a picture, and a link back to the exact clip) → it's saved and **deduplicated by base form** → you review it with a **Leitner box** → the toolbar icon reminds you when words are due.

Two homes, one data store: a compact **popup tab** for quick capture/review, and the full **Library page** for browsing, filtering, review sessions, and pictures.

## 2. Non-goals (YAGNI)

- No account, no sync, no server — everything stays local (BYO key, IndexedDB), matching SubVibe's privacy stance.
- No sentence/grammar *tutoring* beyond a per-word grammar note. This is a vocabulary trainer, not a course.
- No new translation provider — reuse the user's existing OpenAI/Anthropic/Google key.
- v1 reminders are a **badge count only** — no push notifications (see §9).
- Pictures are designed-for but built last (§10).

## 3. Architecture overview

```
overlay word tap ──▶ background LOOKUP ──▶ LLM (BYO key) ──▶ structured JSON
                          │                                     │
                          ▼                                     ▼
                    word store (IndexedDB) ◀── dedup by lemma+lang, cache
                          │
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
   popup "Learn" tab   Library page     Leitner engine
   (recent, N due,     (browse/filter,   (box math,
    quick review)       full review,     due dates)
                        pictures, clips)
```

Everything reads/writes ONE IndexedDB store. The **store schema**, the **LOOKUP message contract**, and the **lookup JSON schema** are the three interfaces that, once frozen, let all the other pieces be built independently and in parallel (§11).

## 4. Components

Each unit has one purpose, a defined interface, and stated dependencies.

### 4.1 Capture (content script — `content/common.js` + overlay)
- **Does:** makes each overlay word tappable; on tap sends `{ word, sentence, lang, videoId, t, title }` to the background.
- **Interface:** emits message `LEARN_CAPTURE` (see §6). Adds a tap affordance to the existing `.copilot-subs__w` spans (they already exist for karaoke).
- **Depends on:** message contract only. A small visual cue (underline-on-hover) so users know words are tappable; gated behind a `learnEnabled` setting.

### 4.2 Lookup service (`background.js`, new module `learn/lookup.js`)
- **Does:** given a captured word + sentence, returns structured JSON from the user's LLM; computes the lemma; dedups; caches.
- **Interface:** `lookup({word, sentence, lang, targetLang, provider, key}) -> LookupResult` (§7). Cache hit by `lemma+lang` returns instantly, no API call.
- **Depends on:** lookup JSON schema, word store, the existing provider-call plumbing in background.js.

### 4.3 Word store (`learn/store.js`, IndexedDB)
- **Does:** CRUD over word records; dedup by `lemma+lang`; append `sources[]`; query by level/lang/video/due.
- **Interface:** `getWord`, `upsertWord`, `addSource`, `listWords(filter)`, `dueWords(now)`, `countDue(now)`, `gradeWord(id, grade)`.
- **Depends on:** schema (§5). **Standalone + unit-testable** with a fake IndexedDB — build in isolation.

### 4.4 Leitner engine (`learn/leitner.js`, pure functions)
- **Does:** box math only. `schedule(record, grade, now) -> { box, dueAt, history }`.
- **Boxes 1–5**, intervals e.g. `[0, 1d, 3d, 7d, 21d, 60d]` (box→interval). Correct → box+1 (cap 5); wrong → box 1. `dueAt = now + interval[box]`.
- **Depends on:** nothing. **Pure, fully testable in isolation** — build anytime, first.

### 4.5 Popup "Learn" tab (`popup.html` / `popup.js`)
- **Does:** compact view — recent captures, "N due" count, a quick 5-card review, a search box to look a word up manually.
- **Depends on:** store (read), Leitner engine (grade), a new tab in `TAB_NAMES`.

### 4.6 Library "Learn" section (`library.html` / `library.js`)
- **Does:** the full experience — browse/filter all words (by level, language, source video), full review sessions, pictures, and clip links (▶ jump to the moment).
- **Depends on:** store (read/write), Leitner engine, clip-link resolver.

### 4.7 Reminders (badge)
- **Does:** paints `countDue()` on the toolbar icon badge; refreshed on capture, on review, and on an interval/alarm-free timer in the service worker.
- **Depends on:** store (countDue). No new permission (§9).

## 5. Data model (IndexedDB: object store `learn_words`)

Key: `id = lemma + "|" + lang`.

```
{
  id, lemma, lang,               // "laufen|de"
  forms: ["läuft", "lief"],      // surface forms seen (for dedup display)
  targetLang,                    // meaning language (user's)
  meaning,                       // short gloss in targetLang
  examples: [{ src, tr }],       // 2–3 example sentences + translation
  grammar,                       // one-line note (pos, gender, conjugation…)
  pos,                           // part of speech
  level,                         // CEFR: "A1".."C2"
  image: null | { url, credit }, // P4
  sources: [{ videoId, site, t, sentence, title, at }],  // every clip it appeared in
  leitner: { box: 1, dueAt: <ts>, history: [{ at, grade }] },
  createdAt, updatedAt
}
```

Dedup: on capture, if `id` exists → append to `sources[]`, bump `updatedAt`, do NOT re-call the LLM (cache). New forms append to `forms[]`.

## 6. Message contracts (popup/content ↔ background)

- `LEARN_CAPTURE { word, sentence, lang, videoId, site, t, title }` → background looks up + stores → responds `{ ok, record }`. Content shows a tiny toast/confirmation.
- `LEARN_LOOKUP { text, lang }` → manual lookup from the popup search (no source clip).
- `LEARN_LIST { filter }` → `{ words }`.
- `LEARN_DUE {}` → `{ count, words }`.
- `LEARN_GRADE { id, grade }` → applies Leitner, returns updated record.
- `LEARN_BADGE {}` → recomputes and paints the badge.

## 7. Lookup JSON schema (LLM output, structured)

Prompt the provider for STRICT JSON:

```
{
  lemma: string,              // dictionary base form
  pos: string,                // "verb" | "noun" | ...
  level: "A1"|"A2"|"B1"|"B2"|"C1"|"C2",
  meaning: string,            // in targetLang, concise
  grammar: string,            // one line: gender/conjugation/irregularity/usage
  examples: [{ src: string, tr: string }]   // 2–3, src in source lang, tr in targetLang
}
```

Context sent: the word, its full subtitle sentence (for disambiguation), source language, target language. Cost is tiny (~a few hundred tokens) and cached per lemma, so a word is billed at most once.

## 8. Colors & CEFR levels

- Words are color-coded by level: A1 `#34D399` → A2 `#A3E635` → B1 `#FBBF24` → B2 `#FB923C` → C1 `#F87171` → C2 `#C084FC` (green→warm→violet). Used as chips/dots in lists and on captured-word confirmation.
- This reuses the **highlight-palette color layer** (P0): the same `--cs-*` variable discipline and swatch UI.

## 9. Reminders

- **v1 = toolbar badge** with the due count via `chrome.action.setBadgeText` — no new permission, no store re-review.
- Push notifications (`notifications` + `alarms`) are deferred to P4 and are **opt-in**, because adding permissions reopens the Chrome Web Store host-permission review we just cleared.

## 10. Pictures

- Data model carries `image` from P1, but the feature is **built in P4**.
- Source decided at P4: free image search (e.g. Pexels/Unsplash — adds a host permission + attribution) vs. AI-generated. Parked to keep P1–P3 clean.

## 11. Phases & parallelization (the concurrency plan)

**Step 0 — freeze the three contracts first (small, blocking):** the `learn_words` schema (§5), the message API (§6), and the lookup JSON schema (§7). Nothing else can safely fan out until these are fixed. This is the ONLY strictly-serial step.

Once frozen, these tracks run **in parallel** (different files, minimal overlap):

| Track | Files | Depends on | Parallel? |
|---|---|---|---|
| **P0 Highlight palettes** | `shared/presets.js`, `popup.html/js` (Style tab), `styles/overlay.css` | nothing | ✅ fully independent of the suite — start immediately |
| **Leitner engine** | `learn/leitner.js` (+ test) | nothing | ✅ pure logic, build + unit-test in isolation |
| **Word store** | `learn/store.js` (+ test) | schema | ✅ standalone module, fake-IDB tested |
| **Lookup service** | `background.js`, `learn/lookup.js` | schema, lookup JSON | ✅ mock the store; build against the contract |
| **Capture** | `content/common.js`, overlay CSS | message API | ✅ stub the background response |
| **Popup Learn tab** | `popup.html/js` | store (read) | ✅ build against seeded store data |
| **Library Learn section** | `library.html/js` | store (read) | ✅ build against seeded store data |

**Integration order** (after tracks land):
1. Capture + Lookup + Store → the tap→lookup→save flow (P1).
2. Popup tab + Library read the store → words display (P1).
3. Leitner engine + display → review sessions + due badge (P2).
4. Clip links (uses `sources[]`) + level colors (uses `level` + P0 palette) — polish (P3).
5. Pictures + opt-in notifications (P4).

**Release phases** (each shippable):
- **P0** Highlight palettes + picker — independent, ship first.
- **P1** Capture + Dictionary (lookup, dedup, cache, store) + minimal list in popup + Library.
- **P2** Leitner review + due badge.
- **P3** Clip links + CEFR level colors.
- **P4** Pictures + opt-in notifications.

## 12. Files

**New:** `learn/leitner.js`, `learn/store.js`, `learn/lookup.js`, `learn/leitner.test.mjs`, `learn/store.test.mjs`.
**Modified:** `background.js` (LEARN_* routing + badge), `content/common.js` (tappable words + capture), `popup.html`/`popup.js` (Learn tab + palette row + highlight picker), `library.html`/`library.js` (Learn section), `shared/presets.js` (palettes + `--cs-hl`/`--cs-hl-glow`), `styles/overlay.css` (`.sung` glow + tappable cue), `manifest.json` (none for v1 — badge needs no permission).

## 13. Permissions, cost, store impact

- **v1 adds NO permissions** (badge uses `action`, already present; lookups use existing host permissions for the AI providers). Keeps the pending store review clean.
- **Cost:** one small LLM call per NEW word, cached forever after — a heavy watcher spends cents; re-encounters are free.
- P4 pictures/notifications may add permissions → treat as a separate store submission.

## 14. Testing

- `learn/leitner.js` and `learn/store.js` get `*.test.mjs` unit tests (pure logic + fake IndexedDB) — run via the existing `node --test tools/tests/**/*.test.mjs` glob.
- Capture/lookup verified with the chrome-devtools stub harness pattern already used for the popup.
- The palette layer verified by rendering the Style tab + overlay preview in-browser (as done for the mode switch).

## 15. Decisions made

- **Both homes** (popup tab + Library) share ONE IndexedDB store.
- **Dedup by lemma+lang**, cache forever — a word is billed at most once.
- **Reminders = badge** in v1; notifications deferred/opt-in (permission cost).
- **Pictures** designed-for from P1, built in P4.
- **Colors** reuse the highlight-palette layer; CEFR level coloring in lists.
- **Contracts-first** to unlock maximum parallel work.
