# SubVibe growth features — roadmap

Date: 2026-08-10 · Status: direction approved in conversation; each item gets
its own brainstorm → spec → plan cycle before implementation.

Follows the Daylight redesign spec (2026-08-09). Its standing constraint —
nothing video-locked in brand or components — was written for exactly the
features below.

## 0 · Store re-shoot (Daylight phase c) — FIRST, it's overdue

The listing still shows the old indigo UI; installs land in a light product.
Re-shoot on the merged Daylight UI using `tools/store-screenshots/`
(compose.html + promo pages), new icon, copy per spec §4. Refresh again after
feature 4 ships to sell "the web speaks your language."

## 1 · Multiple Leitner decks — automatic, not managed

Principle: no deck management homework. Decks derive from what cards already
know:

- **Primary split: language.** One deck per learning language, auto-created,
  never mixed in review. (A German word and an English word share nothing —
  this is the real "conflict" being solved.)
- **Filters inside a deck: channel · video.** Review scopes: "All German ·
  this channel · this video." Channel captured at save time (adapter knows
  it; add to the vocab row schema — small engine change, no migration for
  old rows: they simply lack the channel facet).
- Custom named decks: deferred until someone asks (YAGNI).
- UI: deck chips at the top of learn.html (Daylight `.chip` components);
  review queue = filtered view over the single store. Material-first: the
  deck chip shows language + due count, not statistics.

Effort: small. Depends on nothing. Unblocks feature 2 (deck = share unit).

## 2 · Deck sharing — files, no servers

- "Share deck" (learn.html) → one compact `.svbox` file (JSON: schema
  version, language, cards with word/lemma/CEFR/meaning/phrase/notes +
  source titles). WhatsApp/Telegram carry files natively.
- Import: file picker + drag-drop on learn.html. Dedup by (word, lang).
- **Receiver gets fresh Leitner state (box 1) but keeps ALL enrichment** —
  meanings/examples were the expensive part; one person pays, the group
  learns free. This is the headline of the feature.
- Optional later: CSV export for Anki users.
- Privacy: pure file exchange, nothing leaves the device except by the
  user's own hand. No server, ever.

Effort: small-moderate. Depends on 1 (deck boundary).

## 3 · Subtitle sharing — watch without AI

- Library: "Share subtitles" per video → one `.svsub` bundle (video URL +
  clip id + original/translated cues + languages + meta). The SRT export
  already exists; this is the richer, SubVibe-bindable sibling.
- Import: drag-drop on the popup or Library "Import" → writes the cache
  entry keyed to the clip → the recipient replays the video fully subtitled
  with NO key and no cost (cache path already free).
- Growth loop: the bundle only opens with SubVibe installed — every shared
  file is an install invitation carrying its own proof of value. Include a
  one-line hint in the share text.
- Guard: schema-version the bundle; validate at import (size caps, string
  fields only) — imported files are untrusted input.

Effort: moderate. Independent of 1-2.

## 4 · Any-page translation — select → understand → save

- **No new host permissions.** `activeTab` + context menu ("Translate with
  SubVibe") / keyboard shortcut: access granted only on invocation, only on
  that tab. The privacy story ("your key, your device, no tracking")
  survives the store review and the user's prompt intact.
- Selection = word → the existing word card (CEFR, meaning, grammar,
  Save to Leitner → auto-routed to the language's deck via detectLanguage).
- Selection = sentence/paragraph → translation card (same Daylight card
  skin), optional "explain" like the subtitle explain-line card.
- Reuses: word card, enrich pipeline, translate pipeline, quotes.js,
  Leitner save, theme. New: selection anchor + popover positioning on
  arbitrary pages (shadow-DOM-isolated like the overlay).
- After shipping: second listing refresh — positioning upgrades from "every
  video" to "the web speaks your language" (the tagline was chosen for this).

Effort: moderate-large. Benefits from 1 (deck routing).

## Order & rationale

0 → 1 → 2 → 3 → 4. The re-shoot stops today's trust leak; decks are the
smallest high-value step and define the share unit; deck sharing rides on
it; subtitle sharing is the strongest viral loop; any-page translation is
the biggest audience expansion and deserves its own listing refresh.

Each feature: brainstorm (questions + design sections) → spec → plan →
subagent-driven execution, as with the Daylight redesign.
