 # SubVibe — Privacy Policy

_Last updated: 30 July 2026_

SubVibe is a browser extension that overlays AI‑generated subtitles (translated or
same‑language) on streaming video, and can optionally speak the translation (Dub Mode).
This policy explains exactly what data SubVibe handles and where it goes.

## The short version
- SubVibe has **no servers of its own.** The developer never receives, sees, or stores any
  of your data.
- You bring your **own API key** (BYOK) for the provider you choose — OpenAI or Anthropic
  for translation, optionally Google for dub voices. Keys are stored **locally** on your
  device and used only to call that provider directly from your browser.
- Subtitle text — and, only if you explicitly enable the optional audio feature, captured
  audio — is sent **to the provider you chose**. Nothing else is sent anywhere.
- Generated subtitles and dub audio are cached **locally** on your device so replays are
  instant and free.
- SubVibe contains **no analytics, no tracking, and sells no data.**

## What is stored, and where
All of this lives locally in your browser (`chrome.storage.local` and IndexedDB) and never
leaves your device except as described in the next section:

- **Your API key(s)** — OpenAI, Anthropic, and/or Google, saved locally so SubVibe can call
  the corresponding API on your behalf. Each key is transmitted only to its own provider
  (`api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`), as the
  standard authentication header on your own requests.
- **Your settings** — target language(s), translation engine and model, whether to show the
  original line, text size, position, style, sync offset, dub voice, and similar preferences.
- **A local subtitle and audio cache** — the subtitles and dub audio SubVibe generates,
  keyed per video, so re‑watching costs nothing and stays in sync.
- **A local activity log** — per‑call token counts and cost estimates, shown in the popup so
  you can see what your key is spending. It stays on your device.

You can clear the cache at any time from the popup (**Clear cache**). Removing the extension
deletes all of the above.

## What is sent to the AI provider you chose
To produce subtitles or dub audio, SubVibe sends the following **directly from your browser**
to the provider you selected, authenticated with **your** API key:

- **Subtitle / caption text** from the video you are watching — to OpenAI or Anthropic for
  translation (your choice of engine), and to OpenAI or Google to generate dub speech if you
  use Dub Mode.
- **Page text you choose to translate or simplify** — only when you invoke *Simplify with SubVibe*
  or *Screenshot with SubVibe* (right-click menu, popup or keyboard shortcut): the text you selected,
  or the text inside the page area you captured, goes to OpenAI or Anthropic. Nothing is sent, and
  no page is touched, until you invoke it.
- **Captured audio**, only if you explicitly enable the optional “audio fallback”
  transcription feature for videos that have no captions (sent to OpenAI). This feature is
  **off by default**, requires a one‑time setup, and only runs while you have started it.
- **Captured audio during Live Translate**, only while you have pressed Start: the current
  tab’s audio (or, if you pick one, an input device) streams to Google’s Gemini Live API with
  your key to produce translated speech and captions. Nothing is recorded or stored; the
  stream ends the moment you press Stop or close the tab.

This data is processed under the provider’s own API data‑usage policy:
[OpenAI](https://openai.com/policies/), [Anthropic](https://www.anthropic.com/legal/privacy),
[Google](https://ai.google.dev/gemini-api/terms). SubVibe adds no processing of its own and
routes this data through no other party.

## What is NOT collected
- No personal identifiers, browsing history, account information, or telemetry.
- No advertising, profiling, data sharing, or data selling.
- SubVibe reads page content only on the streaming sites it supports (YouTube, Netflix, ZDF,
  DW, Amazon Prime Video, Udemy), to locate the caption track and draw the subtitle overlay — and,
  only when you invoke *Simplify* or *Screenshot* on a tab, on that one tab, to read the text you
  selected or captured. Screenshots are stored only on your device and leave it only through your
  own Download, Copy or Share action.

## Permissions, briefly
- **Host access to the supported video sites** — to read the video’s caption track and draw
  the overlay.
- **api.openai.com / api.anthropic.com / generativelanguage.googleapis.com** — to send text
  (or, opt‑in, audio) for translation, speech generation, or transcription with your key.
- **activeTab / scripting / contextMenus** — run *Simplify* and *Screenshot* on the tab where you
  invoked them, and only then; no access to other tabs or to any site in the background.
- **storage / unlimitedStorage** — your local settings and the local subtitle/audio cache.
- **offscreen** — plays dub audio, and hosts the optional opt‑in audio‑fallback and Live
  Translate capture.
- **tabCapture** — reads the current tab’s audio for Live Translate, only after you press
  Start, and never in the background.

## Contact
Questions or requests: support@nimanou.com

## Changes
Material changes to this policy will be posted here with an updated date.
