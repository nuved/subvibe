# Live Translate (experimental) — voice-to-voice via Gemini Live API

**Date:** 2026-07-30 · **Branch:** live-translate · **Status:** approved design (operator: "confirmed go for it")

## Purpose

Hear any audio translated into your language in near-realtime, free. The
offscreen document captures the loopback audio device, streams it over one
WebSocket session to Gemini's Live translate model, plays the returned
translated speech, and (on supported sites) shows the streamed transcript
through the existing overlay.

## Why this beats the alternatives (operator's correction, recorded)

The cue-timed TTS dub is *better synced* but burns one request per subtitle
group — on the free Gemini tier (tiny requests-per-minute cap) it stalls
within seconds. The Live API has **no request counter**: one session per run,
budgeted in tokens/minute (20K for the translate model; realtime audio uses
~4–5K/min). So Live Translate runs continuously and free where the TTS dub
can't. Positioning: Live = the free voice path, available EVERYWHERE
(including caption sites); TTS dub = the precision path (cue-exact, cacheable)
for paid keys. No gating of Live behind "captions missing."

## Decisions

- Entry point: a **"Live Translate (experimental)" section in the Dub tab**.
- Output: **voice + transcript together** — audio never waits for text;
  transcript lines render via the audio-overlay pattern on supported sites.
- Scope v1: voice works anywhere (device-level capture); on-page text only on
  supported sites (existing manifest, no new permissions). "Text everywhere"
  via an extension-owned floating window is v2, out of scope.
- Model id is a **setting** (`liveModel`, default `gemini-3.5-live-translate`)
  because the exact API string is unverified — the dashboard shows the display
  name "Gemini 3.5 Live Translate" only. A wrong id fails at setup with the
  server's message surfaced in the popup, fixable without code changes.

## Protocol facts (fetched from ai.google.dev/api/live, 2026-07-30)

- Endpoint: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=<geminiKey>`
- Setup: `{"setup": {"model": "models/<id>", "generationConfig": {"responseModalities": ["AUDIO"]}, "systemInstruction": <interpreter prompt>, "inputAudioTranscription": {}, "outputAudioTranscription": {}}}`
- Audio in: `{"realtimeInput": {"audio": {"mimeType": "audio/pcm;rate=16000", "data": "<base64 PCM16 LE mono>"}}}`
- Server: `{"serverContent": {"modelTurn": {parts: [{inlineData: {mimeType: "audio/pcm;rate=24000", data}}]}, "inputTranscription": {"text"}, "outputTranscription": {"text"}, "turnComplete": bool, "interrupted": bool}}` and `{"setupComplete": {}}`
- Input 16kHz PCM16 LE, output 24kHz PCM16 LE (Live overview page).
- Uncertainty, handled defensively: `systemInstruction` is documented as a
  string in the reference summary; if the server rejects it, retry once with
  the `Content` object form (`{parts:[{text}]}`) before surfacing the error.

## Units

1. **`offscreen-live.js`** (new; loaded by offscreen.html alongside offscreen.js)
   — the whole audio loop, mirroring the existing transcription client's shape:
   `LIVE_START {deviceId, target, model}` → read `geminiKey` from storage,
   getUserMedia(deviceId), AudioContext({sampleRate:16000}) → ScriptProcessor →
   PCM16 base64 → `realtimeInput`. Incoming `inlineData` audio → base64 →
   Int16 → Float32 → AudioBuffer scheduled sequentially on a 24kHz context
   (cursor = max(now, cursor) + duration). `inputTranscription` /
   `outputTranscription` accumulate per turn; on `turnComplete` (or ~2.5s
   text idle) emit `LIVE_TEXT {original, translated}`. `interrupted` clears the
   scheduled audio queue. State via `LIVE_STATE {running, error?}`.
   Reconnect on unexpected close while running: 1s/2s/5s backoff, fresh session.
2. **`background.js`** — routes: `LIVE_START` (from popup; resolves the active
   tab, remembers `liveTabId`, `ensureOffscreen()`, forwards), `LIVE_STOP`,
   `LIVE_TEXT` → `chrome.tabs.sendMessage(liveTabId, {type:"LIVE_LINE",...})`,
   `LIVE_STATE` → broadcast (popup shows it; content script toggles live mode).
3. **`content/common.js`** — `LIVE_LINE` handler in the existing
   runtime.onMessage listener, mirroring audio mode: on first line, tear down
   the running engine and build the overlay (same as buildAudioOverlay's
   takeover precedent); show original + translated rows (translated text
   arrives ready — no TRANSLATE calls); fade the line after ~7s idle;
   `LIVE_STATE {running:false}` restores normal engine via schedule().
4. **Popup (Dub tab)** — section under the dub block: Start/Stop button,
   status line (running / error / reconnecting), the `liveModel` text setting
   inside a fold, and honest requirement hints: needs the Gemini key
   (`geminiKey`) and the loopback input device (`audioDeviceId`, shared with
   the transcription fallback). Copy states the trade plainly: "free, works
   everywhere · speaks a moment behind · Dub Mode stays sharper for videos
   with captions."

## Storage

`liveModel` (global, default `"gemini-3.5-live-translate"`). No persisted
on/off — Live runs only while explicitly started, dies with the session.
Reuses existing `geminiKey`, `audioDeviceId`, `targets[0]` (target language).

## Errors

Every failure path surfaces a human sentence in the popup status line AND the
overlay status (missing key, missing device, ws refused, setup rejected with
the server's own message, rate/quota messages passed through). Stop always
tears everything down (tracks, contexts, socket).

## Testing

- Harness `tools/tests/live-harness/` (same pattern as the others): chrome
  stub + WebSocket monkey-patch playing a scripted server (setupComplete →
  transcriptions → inlineData audio → turnComplete), getUserMedia stubbed with
  an oscillator MediaStream. Asserts: setup message shape, PCM chunks flowing,
  LIVE_TEXT pairs emitted, playback cursor advancing, stop cleans up.
- `node --check` on all touched files; existing suites stay green.
- **Acceptance: operator ear test with a real Gemini key** (I have no key —
  the live protocol against Google is unverified until then). The PR stays a
  DRAFT until that test passes; wrong model id or field drift gets fixed then.

## Out of scope

Floating caption window (text on unsupported sites), voice choice for Live,
recording/caching the live output, all-sites host permissions, store release
(this is 1330.2 material).
