# Simplify Reader — right-click text simplification on any site

Date: 2026-08-18 · Status: approved design

## Goal

While reading anywhere on the web (Medium articles, X posts, Instagram captions, news sites), the user selects text, right-clicks, and picks **"Simplify with SubVibe"**. A floating card appears near the selection with the same text rewritten in simpler language — same language as the original — so the user understands it and gets the points. Long selections also get short key-point bullets.

Nothing is injected into any page until the user right-clicks. No new host permissions.

## User flow

1. Select any text on any page (one sentence up to a whole article).
2. Right-click → context menu shows "Simplify with SubVibe" (only when a selection exists).
3. A SubVibe card appears near the selection with a spinner, then:
   - **Simple**: the rewrite, same language, targeted at a fixed CEFR level from the user's SubVibe settings. Automatic difficulty detection (one notch below the text's own level) is deferred to a later version.
   - **Key points**: 2–4 short bullets, only when the selection is longer than ~2 paragraphs (~600 chars); otherwise omitted.
4. Esc or click outside dismisses the card. New simplification replaces the old card.

## Architecture

- **Manifest**: add `"contextMenus"` and `"activeTab"` to `permissions`. No host_permission changes, no new registered content scripts.
- **background.js**:
  - On install: `chrome.contextMenus.create({ id: "svSimplify", title: "Simplify with SubVibe", contexts: ["selection"] })`.
  - On click: inject `content/reader.js` + `styles/reader.css` into the tab via `chrome.scripting.executeScript`/`insertCSS` (guard flag on `window` so repeat injections no-op), then message the tab `{ type: "SV_SIMPLIFY", fallbackText: info.selectionText }`. The injected script reads `window.getSelection().toString()` itself (Chrome's `selectionText` collapses newlines), using `fallbackText` only if the selection is gone by then.
  - New handler `SIMPLIFY_TEXT` next to the existing translation handlers, reusing the same provider selection (`translationProvider`, `apiKey`/`anthropicKey`, `claudeModel`) and fetch shape. Structured JSON response: `{ "simple": string, "points": string[] }` (`points` empty for short input). Selection capped at ~6000 chars; longer input is truncated with a note on the card.
- **content/reader.js** (new, on-demand only): reads the live selection, positions and renders the card from the selection's `getBoundingClientRect`, sends the text to background, renders result/error. Click handling uses `elementFromPoint` where needed (X/Instagram capture events). Card is a top-layer fixed-position element in a closed shadow root so site CSS can't restyle it.
- **styles/reader.css**: card styling matching the existing overlay look (Daylight theme tokens).

## Prompt shape (background)

System: "Rewrite the text in the SAME language, simpler: shorter sentences, common words, keep names and facts. Target CEFR {target}. If input exceeds ~600 chars, also give 2–4 key-point bullets. Return JSON {simple, points}."
`{target}` = the fixed CEFR level stored under `chrome.storage.local` key `readerLevel`, default `"B1"` when unset. v1 does not detect the selection's own difficulty; that's deferred.

## Errors

All surfaced on the card, never silent:
- No API key → "No API key set — open the SubVibe popup to add one."
- Network/API failure → short message + Retry button.
- Restricted page (chrome://, Web Store) → injection fails; background shows a badge-title notice ("Can't run on this page").

## Not doing (YAGNI)

- No floating select-button, no per-post icons, no side panel.
- No caching of results.
- No translation to another language (same-language only; translation stays a video feature).
- No vocab/Leitner hookup in v1 (possible later: click a word on the card to add it).

## Testing

- Unit-testable pure part: response validation (JSON shape, points array trimming) in a small shared helper.
- Manual acceptance: Medium article section (expect bullets), a tweet (no bullets), Instagram caption, a German news paragraph (same-language check), page with no key set (error card), chrome:// page (graceful notice).
