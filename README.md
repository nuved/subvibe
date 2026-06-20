# SubVibe — AI subtitles for streaming video

Overlay **AI-translated subtitles** on streaming video, in your language — pre-translated
*ahead* of the playhead so there's no lag, perfectly synced to playback, and **cached
locally** so re-watching costs nothing.

**Supported:** YouTube · Netflix · ZDF · Deutsche Welle · Amazon Prime Video

## Features
- **Pre-translated ahead** of the playhead — grabs the whole caption track up front and
  translates the upcoming lines before you reach them. A toolbar badge shows how far ahead
  it's ready.
- **Perfect sync** — cues are keyed to the exact playback time; scrub, pause, rewatch — they follow.
- **Cached & free on replay** — generated once, stored locally (IndexedDB); replays cost nothing.
- **Dual subtitles** — show the translation, the original line, or both stacked (great for learning).
- **30+ languages**, right-to-left support (Persian, Arabic, Hebrew, Urdu) + a bundled Persian font.
- **Per-video settings** — language(s), position (drag each line), size, and a sync nudge,
  remembered per video.
- **Bring your own key (BYOK)** — uses *your* OpenAI key, stored only on your device. **No
  SubVibe servers, no accounts, no ads, no tracking.**

## Install
**From source (until the Chrome Web Store listing is live):**
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
3. Click the icon → paste your **OpenAI API key**, pick your language(s).

## Use
1. Play a video (turn the player's own captions **on** once, so SubVibe can read the track).
2. Subtitles appear over the player, pre-translating ahead.
3. Re-watch anytime — it replays from cache, free (DevTools ▸ Network shows no `api.openai.com` calls).

## Privacy & BYOK
SubVibe has **no servers of its own.** Your OpenAI key is stored locally and used to call
OpenAI **directly from your browser**; only the video's caption text is sent there, to
translate it. Nothing else leaves your device. → **[Privacy policy](https://nimanou.com/subvibe/privacy)**

## Open source &amp; verifiable builds
SubVibe has **no build step** — it's vanilla JS/HTML/CSS, nothing minified or bundled. **The
files in this repo are exactly what ships and runs.**

**Reproduce the published package** from source:
```bash
./build.sh        # → subvibe-v<version>.zip, the exact zip uploaded to the Web Store
```

**Verify the published extension matches this source:**
1. Chrome installs extensions *unpacked* at `…/Chrome/Default/Extensions/<id>/<version>/`.
2. `diff -r` that folder against this repo at the matching release tag (e.g. `v1330.0.0`).
3. A clean diff means identical code — and because nothing is minified, the diff is human-readable.

> Note: the `.crx` Google *serves* is re-signed/re-packaged, so it isn't byte-identical to the
> upload — but the file **contents** are, which is exactly what the `diff` confirms.

## Project structure
- `manifest.json` — MV3 config &amp; permissions.
- `background.js` — service worker: IndexedDB cache + OpenAI calls (cross-origin lives here, never in a content script).
- `content/common.js` — the engine: detect source, build per-language cues, render &amp; sync the overlay.
- `content/adapters/*` — per-site caption acquisition (YouTube, Netflix, ZDF, DW, Prime).
- `content/subs-intercept.js` — MAIN-world subtitle/segment sniffer + page-world playhead relay.
- `popup.html` / `popup.js` — settings (key, languages, appearance, per-video).
- `shared/`, `styles/`, `fonts/`, `icons/` — shared data, overlay styling, RTL font, icons.

## License
MIT — see [LICENSE](LICENSE).

—

Made by [Nimanou](https://nimanou.com).
