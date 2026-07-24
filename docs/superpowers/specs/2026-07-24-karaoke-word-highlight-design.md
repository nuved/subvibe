# Karaoke word highlight — design

Date: 2026-07-24 · Branch: dub-mode · Status: approved (chat)

## Goal

As speech happens, the words already spoken (plus the current one) in the SubVibe
overlay light up in an accent color — a karaoke-style fill sweeping through the
line. Applies to whichever lines are shown: original, translated, or both.
Sweeps right-to-left automatically for RTL targets (Persian).

## Where word timing comes from

| Source | Timing | How |
|---|---|---|
| YouTube auto-generated (ASR) tracks, json3 | **Exact** | Each `segs[]` entry is a word with `tOffsetMs`; both json3 parsers currently discard it |
| Manual tracks, WebVTT, TTML, XML | Estimated | Words spread across the cue window, weighted by word length + constant |
| Translated lines | Estimated | Same estimator over the sentence **group** window (groups share one translation) |
| Dub TTS audio | Estimated (v1) | OpenAI/Gemini TTS return no timestamps; dub clips are rate-fitted to the group span, so the window estimate tracks the voice acceptably |

## Data model

- Parsers (`content/adapters/youtube.js` `parseJson3`, `content/common.js`
  `parseSubtitleFile` json3 branch) emit `cue.w = [{o: <ms offset>, t: <word>}]`
  only when an event has ≥ 2 non-empty segs (i.e. a real per-word track).
- `ingest` copies `w` onto the internal cue. Not persisted to caches (original
  cues are re-parsed from the caption file each load; translations have no `w`).

## Rendering

- `setLineText(row, txt, units)` gains a units mode: word `<span
  class="copilot-subs__w">`s separated by real space **text nodes**, so
  `row.textContent === txt` and every existing change-guard keeps working.
- `lineUnits(cue, target, txt)` builds `[{s: absMs, t: word}]`:
  - original: per group-member cue, exact `w` (start + o) or estimate over that
    cue's window; translated: estimate over the group window.
  - Safety: if `units.join(" ") !== txt`, fall back to the estimator on `txt`;
    if that still mismatches, return null (line renders plain — never churn).
- The main engine tick toggles class `sung` on spans `0..k-1` where `k` = count
  of units with `s <= playhead`. DOM writes only when `k` changes. A unit-key
  (`group start + target`) guard rebuilds units when an identical line repeats
  (song refrains) so the fill restarts correctly.
- `transition: color 150ms` smooths the sweep.

## Styling & settings

- CSS: `.copilot-subs__w.sung { color: var(--cs-hl, #ffd479) }` (warm gold, the
  overlay's existing accent); presets can theme via optional `st.hl`.
- Setting `karaokeHl` (default **ON**): both DEFAULTS objects, `getSettings`
  key list, popup toggle "Highlight spoken words" in Subtitle options. Not a
  LIVE_KEY — toggling restarts the engine like language changes do.

## Out of scope (v1)

- Exact word timing for dub TTS audio (needs timestamped TTS à la ElevenLabs or
  forced alignment — future option).
- The live audio-transcription overlay and the file/audio secondary render
  paths (rolling text, different ticks).

## Verification

Eye test: YouTube ASR video highlights in lockstep with the voice; manual-subbed
or dubbed video sweeps believably; Persian sweeps right-to-left; toggle off
restores today's rendering; repeated song lines restart their fill.
