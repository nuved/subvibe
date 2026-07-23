# Dub Mode v1 — Design

**Date:** 2026-07-23 · **Status:** approved by operator · **Scope:** SubVibe browser extension

## Summary

A "Dub" toggle that speaks the translated subtitles aloud in sync with the video
(OpenAI `gpt-4o-mini-tts`), while the original soundtrack keeps playing at reduced
volume underneath — the livdub.com experience, BYOK-priced (~$0.30–0.40 per 25-min
video, free on replay via cache). Persian is a first-class target: TTS officially
supports `fa` (Whisper-level language list), and the existing translation prompt
already produces natural *spoken* Persian, which is what a dub should read out.

### Decisions made during brainstorming

| Question | Decision |
|---|---|
| Scope | Dub mode first. Audio descriptions for blind users = separate phase-2 spec reusing this playback/cache layer. |
| Provider | OpenAI-only in v1 (`gpt-4o-mini-tts`, reuses existing BYOK key/retry/logging), behind a small provider seam so Gemini TTS (native-quality `fa`, stronger style control, 2-speaker generation) can be added later as a settings choice. |
| Coverage | Subtitle-based content only (all six site adapters). Live-capture dubbing (no-subtitle videos) is a later phase — it would always lag ~2–4 s. |
| Speaker voices | LLM speaker tagging inside the existing translation call (near-zero cost); maps speakers to a voice palette. Ships as a "Multi-voice (beta)" toggle; single-voice is the default. |
| Export | `.srt` + one continuous stitched `.mp3` dub track from the Library. |
| Cost model | Hybrid: look-ahead generation (~60 s ahead, pay only for what you watch) + a "Generate full dub" button with an upfront cost estimate for export/binge. |

## Architecture

```
subtitle cues ──► TRANSLATE (existing, + speaker tags) ──► cue.t[target], cue.s, cue.g
                                                             │
                      playhead + ~60s look-ahead pump        ▼
                   ◄──────────────────────────────── content/dub.js (DubEngine)
                   │ TTS message per un-synthesized cue
                   ▼
background.js ──► OpenAI /v1/audio/speech ──► mp3 blob ──► IndexedDB "audio" store
                   ▼
content/dub.js: Web Audio schedules each clip at cue.startMs against the video
clock; video.volume ducked while dub mode is on
```

**Playback approach (chosen over alternatives):** content-script `AudioContext`
plus `video.volume` ducking. Works identically on DRM sites (Netflix/Prime)
because the media stream is never touched, and it is pure content-script, so it
also runs on Firefox with no offscreen document.
Rejected: offscreen-document playback (audio must live in the tab: tab mute,
per-tab volume, tab sleep) and capture-and-remix of the site's audio (breaks on
DRM, adds nothing).

## Components

### background.js
- New `TTS` message: `{cueKey, text, voice, instructions}` → checks the `audio`
  store first and returns the cached clip if present (cache-through, so the
  content script never needs a separate lookup message); on miss, calls
  `POST /v1/audio/speech` with `gpt-4o-mini-tts`, `response_format: "mp3"`,
  persists the result (worker owns IndexedDB), then returns it. Same
  `TRANSIENT_HTTP` retry policy as translation.
  **Transport note:** `chrome.runtime` messages are JSON-serialized in MV3 —
  Blobs/ArrayBuffers do not survive — so audio crosses the channel as base64
  (~40 KB per cue; decoded to an ArrayBuffer in the content script).
- Every TTS call is logged in the existing Activity ring buffer (`callLog`)
  with characters in, audio seconds out, estimated cost, latency, ok/error.
- IndexedDB `copilot-subs` bumps to **version 2**, adding object store `audio`
  keyed `` `${trackKey}#${cueIdx}` `` → `{blob, voice, ms, chars, createdAt}`.
  Track eviction (`idbEvictOldest`) and per-clip delete (`idbDeletePrefix`)
  delete the track's audio rows in the same pass.
- `TRANSLATE` strict schema gains two optional arrays alongside `t`:
  `s` (small-int speaker index per line) and `g` (`"m" | "f" | "?"` gender
  guess). Prompt instructs the model to infer them from dialogue context.
  Old cached tracks without tags keep working (tags default to speaker 0).

### content/dub.js (new; listed in every site's content-script block)
- **DubEngine** owns: enable/disable, the look-ahead pump, scheduling, ducking.
- **Pump:** for cues within ~60 s of the playhead whose audio is not yet cached,
  request TTS — max 2 in flight, nearest-first. Obeys the same play/pause idle
  rules as the translation pump (spend only while the user is engaged).
- **Scheduling:** one `AudioBufferSourceNode` per cue, scheduled at
  `cue.startMs` against the video clock (`playheadMs()`); all sources cancelled
  and rescheduled on seek/pause/rate-change. A clip longer than its cue slot is
  sped up to at most **1.15×**; beyond that it may trail into the next cue —
  different-speaker overlap is allowed briefly, same-speaker overlap fast-fades
  the previous clip. Follows `liveVideoEl()` for players that swap the `<video>`
  element mid-play (DW).
- **Ducking:** on enable, remember `baseVolume = video.volume`, set
  `video.volume = baseVolume × duckLevel` (default 0.25). A `volumechange` not
  caused by us re-derives `baseVolume`, so the site's own slider keeps working.
  On disable/teardown, restore `baseVolume`. Constant duck while dub is on (no
  per-line pumping) — matches livdub and avoids audible breathing.
- The `AudioContext` is created inside the user's enable click, so browser
  autoplay policy never suspends it.
- Extends `window.csDiag()` and the toolbar `LOOKAHEAD` badge with dub-ahead
  state (clips ready / pending in the window).

### content/common.js (hooks only — no restructuring)
- Expose the active cue list + track cache key to dub.js.
- Store `s`/`g` speaker tags on cues when the translator returns them.

### shared/voices.js (new)
- Voice palette: male `cedar`/`onyx`/`echo`, female `marin`/`coral`/`shimmer`,
  neutral default `alloy`. Stable speaker→voice assignment (speaker id modulo
  gender-matched palette).
- Tone `instructions` builder: compact per-line hints from text signals —
  question marks, exclamations/caps (excited), parenthetical/bracketed cues
  (whisper, shouting), plus a fixed register hint per language (natural spoken
  Persian for `fa`).

### Popup
- New Dub section: on/off toggle, voice picker, "Multi-voice (beta)" toggle,
  duck-level slider (live-applied via `LIVE_KEYS`), and **Generate full dub**
  showing the estimate (e.g. "~$0.35") computed from total cue duration before
  any spend. Settings keys: `dubEnabled`, `dubVoice`, `dubMultiVoice`,
  `dubDuckLevel`.
- Generation progress state ("dubbing 214/380 lines") while a full generate runs.

### Library
- Per-track dub coverage indicator ("dubbed 84%").
- **Export .srt** (translated cues) and **Export .mp3**: decode cached clips,
  place each at its cue timestamp in an `OfflineAudioContext`, render, encode.
  MP3 encoding via a vendored JS encoder — **verify its license is compatible
  with this MIT repo at implementation time; if not, ship WAV export instead
  and revisit.** Export with gaps warns and offers "generate the missing N%".
- Delete dub audio for a clip (keeps the subtitle track).

## Cost, caching, transparency

- Cache key includes `(site, videoId, target, voice-config)` — changing voice or
  multi-voice regenerates; replays are free and the status line says so.
- Estimate formula: `total cue seconds × $0.015/min` (audio out dominates; text
  input at $0.60/1M tokens is noise). Shown before "Generate full dub".
- Look-ahead spends only during engaged playback; badge turns green "✓ no API
  cost" when the window ahead is fully cached.
- Storage ≈ 5 MB per 20 min of speech (mp3) — fine under `unlimitedStorage`;
  audio rows die with their evicted track.

## Error handling

- Per-cue TTS failure → line stays subtitle-only; never blocks playback.
- Transient HTTP → existing retry/backoff; 429 pauses the pump briefly.
- No API key → existing popup CTA path.
- Undecodable audio blob → drop cue, log, continue.
- Extension reload mid-playback → DubEngine teardown restores volume (same
  orphan-handling pattern as the overlay's `haltOrphaned`).

## Testing

No automated harness exists in this repo (plain JS, no package.json):
`tools/audit.mjs` must stay green, plus this manual smoke matrix —
YouTube, Udemy, Netflix × targets `fa`, `de`:

1. Sync during normal play (spoken line matches shown subtitle).
2. Seek forward/back; pause/resume; playback speed 1.5×.
3. Replay from cache produces **zero** new Activity entries.
4. Duck level slider applies live; disable restores original volume.
5. Multi-voice: distinct speakers get distinct stable voices.
6. Export: .mp3 + .srt open in VLC; two spot-checked timestamps land on the
   right lines.

## Out of scope (later specs)

- Audio descriptions for blind users (phase 2: frame capture + vision model +
  this same playback/cache layer, speaking scene descriptions in dialogue-free
  gaps).
- Live-capture dubbing for subtitle-less videos.
- Gemini TTS provider implementation (seam is in place).
- Firefox verification (expected to work — pure content script; folded into the
  existing B1 Firefox smoke-test phase).
- Word-level lip-sync.

## References

- OpenAI TTS guide (languages incl. Persian, voices, `instructions`, formats):
  https://developers.openai.com/api/docs/guides/text-to-speech
- Gemini speech generation (90+ languages incl. `fa`, 2-speaker, style control):
  https://ai.google.dev/gemini-api/docs/speech-generation
- Pricing basis: gpt-4o-mini-tts ≈ $0.015/min audio out ($0.60/1M text in,
  $12/1M audio out).
