# Library & Popup Information Hierarchy + Gemini TTS Request Reduction — Design

**Date:** 2026-07-24 · **Status:** pending operator review · **Scope:** SubVibe browser extension

## Summary

Three related fixes born from one observation: the screens show the wrong things
loudly. Saved titles carry YouTube's "(4)" notification-counter junk; library
cards give a destructive Delete the same visual weight as the primary Open;
the popup is ~90% set-once settings and 0% data about the current video; and
the Gemini TTS free tier gets hammered with a request storm it rate-limits.

**Design principle (operator's):** show the data, fold the config. Data (cost,
call counts, progress, downloads) is never behind a click — screens have the
space; confusion comes from equal visual weight, not from quantity. Only
*rarely-changed configuration* folds (like the existing API-keys row), always
with its current value visible on the fold line. Folded state is remembered.

### Decisions made during brainstorming

| Question | Decision |
|---|---|
| What is "(4)" in every title? | YouTube's unread-notification count, captured verbatim from `document.title`. Strip it (and " - YouTube") at capture AND at display (legacy entries). |
| Expand-click card? Detail overlay? | Rejected by operator. No click to reveal data. Visual hierarchy instead: one loud primary action, quiet secondary ones, dim destructive ones — all visible. |
| What may fold? | Only set-once config in the popup (engine, voice, subtitle options — anything covered by "Save as default"). Each folded row shows a one-line summary of its current value. |
| Where is "the popup"? | The toolbar-icon panel only. Nothing new is drawn over the video page. |
| Fold state | Persisted in `chrome.storage.local` — the panel reopens exactly as the user left it. |
| Audio artifact button | "⬇ audio" icon alone rejected — audio gets ▶ play (preview the stitched dub) plus ⬇ download. |
| Gemini 429 storm | Reduce requests: provider cooldown honoring Retry-After, larger runs for Gemini (fewer calls), per-provider pacing. Gemini's async Batch API is NOT viable for live dubbing (minutes-to-hours turnaround). |

## Part A — Data plumbing (prerequisite for everything visible)

**A1. Title cleanup.** One shared helper (new `shared/title.js`, global
`SV_TITLE.clean`, same pattern as `shared/pricing.js`): strip leading
`(\d{1,3}) ` (tab notification counters; 1–3 digits so a "(2024) …" year
prefix survives) and the trailing ` - YouTube` suffix — exactly those two,
nothing fuzzier. Applied:
- at capture in `content/common.js` / `content/dub.js` wherever `document.title` is sent or stored;
- at display in `library.js` and the Activity list, so already-saved clips and old log rows clean up too.

**A2. Per-clip attribution.** `TRANSLATE` and `TTS` messages gain a `base`
field (the clip cache prefix the content script already knows); `logCall`
records it. The library aggregates cost/calls per card by `base`, falling back
to cleaned-title match for legacy rows. Ring buffer stays at 300 — the card
stat reads "recent activity", which is honest; exact lifetime accounting is out
of scope.

## Part B — Library card

Everything visible, weighted; no reveal clicks. Layout top-to-bottom:

1. **Title** — cleaned, bold, clickable (opens the video). The raw URL line is
   removed (it duplicated the title's link and cost a line on every card; full
   URL stays in the tooltip).
2. **Languages** — flag chip + progress dot + cue count, as today.
3. **Stat strip** — small, muted, monospace: `~$0.42 · 12 calls · 8 min dub audio`
   (cost + calls from A2; audio minutes from the existing `audioRows` sum).
   Sections appear only when nonzero.
4. **Action row** —
   - `Open ▶` — the one filled/bright primary button;
   - `⬇ srt · fa` — normal secondary button;
   - audio (when cached): `▶` plays the stitched dub in-page (same stitching
     path as export, played via a Blob URL `<audio>`; button toggles ▶/⏸),
     `⬇` downloads it;
   - `Delete` and `✕ audio` — far right, small, dim; visible but visually
     quiet so a stray click doesn't look routine. Confirm stays as-is.

## Part C — Popup (toolbar panel)

Order flips from "settings first" to "this video first":

1. Header + master toggle (unchanged).
2. **"This video" strip** — progress (cues cached / total), est. cost so far,
   API calls (both via A2 for the current clip base), and `⬇ srt` / `▶`+`⬇`
   audio buttons mirroring the library card. Appears once the clip has data.
3. **Per-video controls, always visible:** Translate-to language chips, Dub
   on/off toggle.
4. **Folded groups** (one-line rows in the style of the existing API-keys row,
   each showing current value, chevron to expand):
   - `Engine · Claude Sonnet 4.6 ▸` — translation engine select;
   - `Voice · OpenAI gpt-4o-mini-tts ▸` — TTS provider/voice/pace/duck;
   - `Subtitles · dual, keep names ▸` — dual-subtitle toggle, keep-names
     toggle, extra-terms box.
5. **Fold-state persistence:** `chrome.storage.local` key `uiFold`
   (`{engine: bool, voice: bool, subs: bool, keys: bool}`); the existing keys
   row joins the same mechanism. Auto-open-on-attention (keys row) still wins
   over the remembered state when a key needs attention.

## Part D — Gemini TTS request reduction

Observed: dozens of `Gemini TTS 429` rows within one minute. Cause: runs are
capped at ≤ 12 s of speech per call, the pump keeps 2 requests in flight at
1 Hz, each failed call retries 3× internally (0.7 s/1.4 s backoff), and a
failed run is re-attempted on the next pump tick — a storm against a hard RPM
cap. Three changes, all in the worker + `content/dub.js`:

**D1. Provider cooldown (the big one).** On a 429, the worker parses the wait
hint (`Retry-After` header, or Google's `RetryInfo.retryDelay` in the error
body; fallback 30 s, doubling per consecutive 429, capped at 5 min) and opens a
per-provider cooldown gate. While cooling: TTS requests return an immediate
local `cooling down (Ns)` error — zero network calls. `content/dub.js` treats
that error as "pause the pump until N", and the dub transport shows a small
"rate-limited, resuming in Ns" note instead of silent failure rows.

**D2. Bigger runs for Gemini.** Run span cap becomes per-provider: OpenAI
stays ≤ 12 s (timbre drift rationale in dub-mode spec); Gemini ≤ 28 s and gap
tolerance 2 s. Roughly 2–3× fewer calls per video minute at identical audio
cost. Trade-off accepted: a failed call loses a bigger chunk; runs are
immutable, so this only affects run *construction* for new fetches.

**D3. Per-provider pacing.** Pump concurrency/pacing becomes provider-aware:
Gemini gets 1 request in flight plus a minimum spacing between launches
(default 6 s, config constant); OpenAI keeps today's 2-in-flight behavior.

Future (out of scope): routing "Generate full dub" through Gemini's async
Batch API for the 50% discount — viable there because pre-generation is not
latency-sensitive.

## Error handling & testing

- `SV_TITLE.clean` is pure → `tools/tests/title.test.mjs` with node:test,
  like the existing srt/audio-export suites (cases: "(4) X - YouTube", RTL
  Persian title, "(2024) X" year prefix NOT stripped, "(99) " alone NOT
  reduced to empty, plain title untouched).
- Cooldown gate: simulate 429 (mock fetch in worker dev console) → verify one
  request per cooldown window, transport note appears, resumes after expiry.
- Fold persistence: toggle groups, close/reopen popup → state identical;
  delete `uiFold` → sensible defaults (all folded, keys auto-open logic wins).
- Per-clip stats: play a fresh clip, confirm card/popup counts match Activity
  tab rows for that title.
- Acceptance remains the operator's ear/eye test on a real YouTube video.

## Out of scope

- Async Batch API pre-generation (future spec).
- Any UI drawn on the video page.
- Lifetime-exact cost accounting beyond the 300-row ring buffer.
- Library grouping/search changes; Activity tab layout beyond title cleanup.
