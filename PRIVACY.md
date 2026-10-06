 # SubVibe — Privacy Policy

_Last updated: 6 October 2026_

SubVibe is a browser extension that overlays AI‑generated subtitles (translated or
same‑language) on streaming video, and can optionally speak the translation (Dub Mode).
This policy explains exactly what data SubVibe handles and where it goes.

## The short version
- SubVibe has **one optional service of its own**, *Community tips*, and it is **off until you
  say yes**. With it off, the developer never receives, sees, or stores any of your data. With
  it on, only the tips you get from your AI provider and an unreadable fingerprint of the
  chunk they explain are shared (see *Community tips* below).
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

## Community tips (optional, off until you say yes)
The story board asks once, and the popup has a switch (*Share tips with other learners*). With
it on, before asking your AI provider to explain a chunk of a video, SubVibe asks
`tips.nimanou.com` whether another learner already shared tips for it, and after your provider
explains a chunk, the tips are shared back so the next learner gets them for free.

- **What is sent:** a fingerprint (SHA-256) of the video's ID, the chunk's words and the tips
  language, a second fingerprint of the video's ID (so tips are released at playback pace),
  and, when sharing, the learning part of the tips: the words with their meanings, levels and
  forms, grammar notes (quotes cut to six words), the one-line scene and speaker names as the
  tips name them. **Translations are never sent**: the translation of a passage, its simpler
  retelling and the sentence translations stay in your browser. Never the video's ID or name in
  readable form, never the subtitle text, never an account, a key, your settings or your history.
- **A one-time human check:** turning Community tips on opens a Cloudflare Turnstile check on
  `tips.nimanou.com`. Passing it gives this browser a random token for 30 days, which every
  request carries; it identifies no person. Tips for a video are then released no faster than
  the video plays, which keeps automated scraping out.
- **What the service stores:** the fingerprint, the tips language, the video's language and the
  tips. It stores no IP address; for rate limits and to count one report per person it uses a
  salted hash of the address that changes every day.
- **Who sees it:** learners who use SubVibe with Community tips on, and only for a chunk they
  are watching (a fingerprint can only be made by someone who has that chunk). There is no
  list or search of stored tips. Shared tips are not sold, not used for advertising or training,
  and not used for any purpose other than showing them to learners.
- **Reports:** tips marked *Report* by two different people are hidden for everyone.
- Turn the switch off at any time; nothing is sent while it is off. The service runs on the
  developer's own server in Germany (Hetzner), behind Cloudflare's proxy.

## What is NOT collected
- No personal identifiers, browsing history, account information, or telemetry.
- No advertising, profiling, or data selling. The only sharing is Community tips, above, and
  only after you turn it on.
- SubVibe reads page content only on the streaming sites it supports (YouTube, Netflix, ZDF,
  DW, Amazon Prime Video, Udemy, X, LinkedIn Learning), to locate the caption track and draw the subtitle overlay — and,
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
