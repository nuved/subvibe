# SubVibe — Chrome Web Store listing (ready to paste)

> Fill the `‹…›` blanks, host PRIVACY.md, then copy each section into the
> Developer Dashboard. Category: **Productivity**. Language: English.

---

## Name (manifest already set)
`SubVibe - AI Subtitle Translator`

## Short description (summary — max 132 chars)
AI subtitles that translate any streaming video into your language — in perfect sync, pre-translated ahead, and cached free on replay.

## Detailed description
**Watch anything in your language.** SubVibe overlays AI-translated subtitles on streaming
video — YouTube, Netflix, ZDF, Deutsche Welle and more — translated by OpenAI into natural,
idiomatic language, not stiff word-for-word machine output.

**What makes it different**
• **Pre-translated AHEAD of the playhead** — SubVibe grabs the whole subtitle track up front and
  translates the next lines *before* you reach them, so there's no lag. A little counter on the
  toolbar shows how far ahead it's ready.
• **Perfect sync** — subtitles are keyed to the exact playback time. Scrub, pause, rewatch — they
  follow.
• **Cached & free on replay** — once a video is translated it's saved locally, so watching it
  again costs nothing and appears instantly.
• **Dual subtitles** — show the translation, the original line, or both stacked together — great
  for language learning.
• **32 languages**, with right-to-left support (Persian, Arabic, Hebrew, Urdu) and a beautiful
  Persian font.
• **Sized to the player & adjustable** — position, text size, and a sync nudge if a video is off.

**Bring your own key (BYOK).** SubVibe uses *your* OpenAI API key, stored only on your device.
Translation costs a few cents per hour of video; cached replays are free. There are no SubVibe
servers, no accounts, no ads, and no tracking.

**How it works**
1. Open the SubVibe popup, paste your OpenAI key, pick your language(s).
2. Play a video. On YouTube/Netflix, turn the player's own captions ON once so SubVibe can read
   the track — then it pre-translates the rest in sync.
3. Re-watch anytime — it replays from cache for free.

*Note: a video must have a caption/subtitle track (or you can enable the optional audio-
transcription fallback for uncaptioned clips). SubVibe renders its own overlay; it does not
modify the site.*

---

## Single purpose
SubVibe overlays AI-translated (or same-language) subtitles on streaming video and keeps them
in sync with playback, caching them locally for free replay.

## Permission justifications (paste per item)
- **Host access — youtube.com, netflix.com, zdf.de, dw.com:** read the video's caption track and
  draw the subtitle overlay on those streaming sites.
- **api.openai.com:** send caption text to OpenAI for translation, authenticated with the user's
  own API key (BYOK). No other destination.
- **storage / unlimitedStorage:** save the user's settings and cache generated subtitles locally
  so re-watching is free and instant.
- **scripting:** inject the subtitle overlay and sync engine into the supported video pages.
- **tabCapture / offscreen:** used ONLY by the optional, off-by-default audio-transcription
  fallback for videos that ship no captions; nothing is captured unless the user starts it.
- **activeTab:** ‹remove this permission before submitting unless you add a feature that needs it›

## Data usage (Privacy practices form)
- **What's handled:** the user's OpenAI API key (stored locally; transmitted only to OpenAI),
  and the caption text of the video being watched (sent to OpenAI to translate). Optional audio
  is captured only if the user explicitly enables transcription.
- **Sold to third parties:** No.
- **Used/transferred for purposes unrelated to the single purpose:** No.
- **Used to determine creditworthiness / for lending:** No.
- **Privacy policy URL:** ‹host the included PRIVACY.md and paste its public URL here›

---

## Before you submit — checklist
- [ ] Host `PRIVACY.md` (GitHub Pages / repo / gist) and add its URL above + in the dashboard.
- [ ] Add your contact email to `PRIVACY.md`.
- [ ] Decide on **Netflix**: it works, but Netflix's ToS forbids overlays — keeping `*.netflix.com`
      raises review risk and possible complaints. Drop it for v1, or keep and accept the risk.
- [ ] Remove the unused `activeTab` permission (and Netflix host perm if dropping it).
- [ ] 1–5 screenshots at **1280×800** (the overlay translating + the popup).
- [ ] Quick trademark / Web-Store name check for "SubVibe".
- [ ] $5 one-time developer registration, then upload a zip of the `extension/` folder.
