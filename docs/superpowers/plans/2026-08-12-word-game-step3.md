# Word game — step 3 (deck sharing) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Share a language deck as one `.svbox` file with a prepared message (WhatsApp/Telegram-ready), import by drag-drop with fresh boxes but kept enrichment — plus the bundled step-2 leftovers: verb stemming for find cards, the sentences-only hint, Next-button double-click hardening.

**Architecture:** Pure, node-tested share logic in `shared/share.js` (serialize/validate/merge — imported files are untrusted input). UI thin: a share sheet on the trainer's deck cards, drag-drop import on both surfaces, one new background message `VOCAB_IMPORT` reusing the existing vocab-store add path. Spec: docs/superpowers/specs/2026-08-11-word-game-design.md §5.

## Global Constraints

- Branch `word-game-step3`; no AI trailers; suite green at every commit (baseline 107/107) + audit.
- Imported data is UNTRUSTED: schema-versioned, size-capped (file ≤ 2MB, ≤ 5000 cards, strings length-capped), type-checked field by field; everything renders via textContent; no „ anywhere.
- Receiver gets FRESH review state (box/nextDueAt/lastGradedAt/history stripped on import); enrichment fields kept (meaning, sentence, sentenceT, para, note, art, sep, cefr, pos, lemma, phrase, videoTitle, channel). Records/streaks never travel.
- Dedupe by (lang, lowercased word): reimport UPDATES enrichment fields, never duplicates, never resets an existing card's review state.
- Sender name optional; no other personal data in the file. Prepared message: purpose + store link + "free, no AI key needed"; editable; NO third-party streaming brand names (store-listing house rule applies to share text too).
- No stress numbers; calm copy.

---

### Task 1: `shared/share.js` (pure, node-tested TDD)

**Files:** Create `shared/share.js`, `tools/tests/share.test.mjs`

API (globalThis.SV_SHARE):
- `exportDeck(cards, lang, { name })` → `{ filename, text }` — filename `<LangName>-by-<name>.svbox` (or `<LangName>.svbox` when no name; sanitize name [A-Za-z0-9 _-], cap 24); text = JSON `{ v: 1, kind: "svbox", lang, name?, cards: [...] }` with ONLY the whitelisted enrichment fields per card (explicit field list — never spread), review state stripped by construction.
- `validateImport(text)` → `{ ok: true, lang, name, cards } | { ok: false, error }` — parse guarded; v===1 && kind==="svbox"; lang is a 2-8 char lowercase code; cards array ≤ 5000; per card: word required non-empty string ≤ 80 chars; every other field optional with type + length caps (strings ≤ 500, sentence/para ≤ 1000; sep boolean; ms number); UNKNOWN fields dropped (whitelist copy, never spread); a card failing validation is SKIPPED (count reported), file only rejected on structural errors.
- `mergeImport(existingCards, importedCards, lang)` → `{ toAdd: [...], toUpdate: [{key, fields}] }` — dedupe key `lang + ":" + word.toLowerCase()`; toAdd cards get NO review fields (store defaults apply); toUpdate carries only enrichment fields that are non-empty in the import AND (empty on the existing card OR differing — import wins on enrichment, NEVER touches box/nextDueAt/lastGradedAt/history).
- `buildShareText(langName, count, { name })` → the prepared message string: gift framing, count, "Install SubVibe (free) and open my file to play", STORE_URL constant (chrome web store listing URL — put the real one from tools/store-listing.md context or a placeholder constant STORE_URL at top with a comment), no brands, no „.
Tests: export strips review state + unknown fields; validate rejects wrong kind/version/oversize/bad types, skips bad cards, drops unknown fields; merge adds/updates/preserves review state correctly; share text contains no „ and no streaming brands; filename sanitization.
- [ ] Commit: `Word game: svbox share module (export, validate, merge — pure, tested)`

### Task 2: engine leftovers (pure + one-liners)

**Files:** `shared/game.js`, `shared/gameui.js`, `tools/tests/game.test.mjs`

- findFor verb-branch stemming: when card.word (infinitive) isn't a token, match a token whose lowercase form starts with the lemma/word stem (strip -en/-n infinitive ending; stem ≥ 3 chars; word-boundary token; skip when the stem also prefixes an unrelated capitalized noun token — conservative: only lowercase tokens qualify as verb candidates). Tests: "erreichen" matches "erreicht"; "gehen" (stem "geh") matches "geht"; no match → null unchanged; noun false-positive guarded.
- Sentences-only hint: when gameScope.game === "sentences" and a built session contains ZERO sentence-capable cards (kindsFor), gameui shows a one-line calm notice above the first card ("No sentence cards in this scope yet — playing word cards.") — textContent, dismissed with the round.
- showNextButton double-click hardening: disable the button on first click before the async continuation (the step-2 final review's one-liner).
- [ ] Commit: `Word game: verb stemming for find cards, sentences-only notice, next-button hardening`

### Task 3: share sheet UI (trainer)

**Files:** `learn.html`, `learn.js` (+ minimal CSS)

- ⇪ button on each Practice deck card → inline sheet: primary "⇪ Share…" (only when `navigator.share` exists AND `navigator.canShare?.({files:[…]})` — construct the File from exportDeck; graceful catch → fall through to links); link row: WhatsApp (`https://wa.me/?text=<encoded buildShareText>`), Telegram (`https://t.me/share/url?url=<STORE_URL>&text=<encoded>`); "📋 Copy text" (navigator.clipboard); "⬇️ File only" (Blob download via anchor). Editable message textarea prefilled with buildShareText. Optional name field (persisted `shareName` in storage.local), blank by default.
- Calm layout on tokens; no stress numbers; sheet closes on share/escape.
- [ ] Commit: `Word game: share sheet on trainer deck cards (OS share, deep links, file, prepared text)`

### Task 4: import (both surfaces) + background

**Files:** `background.js` (VOCAB_IMPORT), `shared/gameui.js` or hosts as fits, `popup.html/js`, `learn.html/js`, stubs

- Background `VOCAB_IMPORT {lang, name, toAdd, toUpdate}`: bulk-writes via the existing vocab-store patterns (model on VOCAB_ADD_MANY + VOCAB_GRADE's put path); stores `gift: <name>` on added cards when name present; responds {added, updated}.
- UI: drag-drop target on the popup Learn tab (arcade area) and an "Import" affordance on the trainer Practice tab; FileReader → SV_SHARE.validateImport → mergeImport(existing VOCAB_LIST cards…) → VOCAB_IMPORT → refresh decks; success line "Added N new · updated M" (calm, one line); invalid file → single error line, never a broken state. Deck card shows "from <name> 🎁" when any of its cards carry gift (small, muted).
- Reimport idempotence verified live (same file twice → 0 added second time).
- [ ] Commit: `Word game: svbox import — drag-drop, validation, fresh boxes, gifted-deck tag`

### Task 5: acceptance sweep + PR

- [ ] Suite + audit + both builds (zips include shared/share.js); harnesses adopt/track-switch/vocab green; live round-trip: export German deck → import into a cleared profile (stub) → deck playable with kept enrichment + fresh boxes; reimport idempotent; oversized/corrupt file rejected calmly; share sheet fallbacks render without navigator.share. No-„ grep incl. share.js + share text.
- [ ] Push, `gh pr create` (base main) — leave OPEN for operator playtest. Body: spec §5 + the three leftovers.
