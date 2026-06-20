# SubVibe — Privacy Policy

_Last updated: 13 June 2026_

SubVibe is a browser extension that overlays AI‑generated subtitles (translated or
same‑language) on streaming video. This policy explains exactly what data SubVibe handles
and where it goes.

## The short version
- SubVibe has **no servers of its own.** The developer never receives, sees, or stores any
  of your data.
- You bring your **own OpenAI API key** (BYOK). It is stored **locally** on your device and
  used only to call OpenAI directly from your browser.
- Subtitle text — and, only if you explicitly enable the optional audio feature, captured
  audio — is sent **to OpenAI** to translate or transcribe it. Nothing else is sent anywhere.
- Generated subtitles are cached **locally** on your device so replays are instant and free.
- SubVibe contains **no analytics, no tracking, and sells no data.**

## What is stored, and where
All of this lives locally in your browser (`chrome.storage.local` and IndexedDB) and never
leaves your device except as described in the next section:

- **Your OpenAI API key** — saved locally so SubVibe can call the OpenAI API on your behalf.
  It is transmitted only to OpenAI (`api.openai.com`), as the standard `Authorization`
  header on your own requests.
- **Your settings** — target language(s), whether to show the original line, text size,
  position, sync offset, and similar preferences.
- **A local subtitle cache** — the subtitles SubVibe generates, keyed per video, so
  re‑watching costs nothing and stays in sync.

You can clear the cache at any time from the popup (**Clear cache**). Removing the extension
deletes all of the above.

## What is sent to OpenAI
To produce subtitles, SubVibe sends the following **directly from your browser to OpenAI**,
authenticated with **your** API key:

- **Subtitle / caption text** from the video you are watching, for translation (the default
  mode).
- **Captured audio**, only if you explicitly enable the optional “audio fallback”
  transcription feature for videos that have no captions. This feature is **off by default**,
  requires a one‑time setup, and only runs while you have started it.

This data is processed under [OpenAI’s API data‑usage policy](https://openai.com/policies/).
SubVibe adds no processing of its own and routes this data through no third party.

## What is NOT collected
- No personal identifiers, browsing history, account information, or telemetry.
- No advertising, profiling, data sharing, or data selling.
- SubVibe reads page content only on the streaming sites it supports, and only to locate the
  caption track and draw the subtitle overlay.

## Permissions, briefly
- **Host access to the supported video sites** — to read the video’s caption track and draw
  the overlay.
- **api.openai.com** — to send text (or, opt‑in, audio) for translation/transcription with
  your key.
- **storage / unlimitedStorage** — your local settings and the local subtitle cache.
- **tabCapture / offscreen** — used **only** by the optional audio‑fallback feature, and only
  when you turn it on.

## Contact
Questions or requests: _‹add your contact email here before publishing›_

## Changes
Material changes to this policy will be posted here with an updated date.
