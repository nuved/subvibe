# SubVibe — AI subtitles for streaming video

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/lmlnalcdaojhipggkcgdpibobbolbfne?label=Chrome%20Web%20Store&color=4F46E5)](https://chromewebstore.google.com/detail/lmlnalcdaojhipggkcgdpibobbolbfne)

Overlay **AI-translated subtitles** on streaming video, in your language — pre-translated
*ahead* of the playhead so there's no lag, perfectly synced to playback, and **cached
locally** so re-watching costs nothing. Or **hear it translated aloud, live**, in your language.

**Supported:** YouTube · Netflix · ZDF · Deutsche Welle · Amazon Prime Video · Udemy

## Features
- **Pre-translated ahead** of the playhead — grabs the whole caption track up front and
  translates the upcoming lines before you reach them. A toolbar badge shows how far ahead
  it's ready.
- **Perfect sync** — cues are keyed to the exact playback time; scrub, pause, rewatch — they follow.
- **Live Translate** — hear the video in your language *as it plays*, in real time, powered by
  Google Gemini. Keeps the original speaker's own voice; 70+ languages; one click, no microphone.
- **Style the original, free** — apply your style and the karaoke highlight to the video's *own*
  captions, with no translation and no cost (also handy just to resync captions to the picture).
- **Cached & free on replay** — generated once, stored locally (IndexedDB); replays cost nothing.
- **Dual subtitles** — show the translation, the original line, or both stacked (great for learning).
- **Karaoke highlight** — words light up as they're spoken; word-exact on auto-captions,
  closely estimated elsewhere.
- **60+ subtitle languages** (70+ for Live Translate), right-to-left support (Persian, Arabic,
  Hebrew, Urdu) + a bundled Persian font.
- **Per-video settings** — language(s), position (drag each line), size, and a sync nudge,
  remembered per video.
- **Style presets & custom looks** — Classic, YouTube, TikTok, Pill, Snapchat, Cinema and
  Minimal presets, plus custom font, text color, background color/opacity, outline/shadow —
  and a free size slider.
- **Bring your own key (BYOK)** — uses *your* OpenAI, Anthropic, or Google key, stored only on
  your device. **No SubVibe servers, no accounts, no ads, no tracking.**

## Install
**From the Chrome Web Store:**
👉 **[Install SubVibe](https://chromewebstore.google.com/detail/lmlnalcdaojhipggkcgdpibobbolbfne)** — then click the icon, add your API key, and pick your language.

**From source:**
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Click the icon → paste your API key (OpenAI, Anthropic, or Google), pick your language(s).

**Firefox (experimental):** `./build.sh --firefox` builds a Firefox package (same source,
two manifest tweaks). Load it via `about:debugging#/runtime/this-firefox` → **Load Temporary
Add-on** — an AMO listing is planned, which Firefox needs for permanent installs. The live
audio features are Chrome-only (Firefox has no offscreen API).

### On Android?
Chrome for Android can't run extensions — no extension can work there. What does work:
- **Firefox for Android** (planned, via the AMO listing): realistic on DRM-free sites —
  ZDF, DW, Udemy, and YouTube in "Request desktop site" mode. Netflix and Prime Video
  don't allow mobile-browser playback at all (app-only DRM), on any browser.
- **Chromium browsers with extension support** (Quetta, Lemur, Edge Canary) can install
  the normal Chrome build today — same site caveats as above.

## Use
1. Play a video (turn the player's own captions **on** once, so SubVibe can read the track).
2. Subtitles appear over the player, pre-translating ahead — or start **Live Translate** from the
   popup's Dub tab to hear it spoken in your language.
3. Re-watch anytime — it replays from cache, free (DevTools ▸ Network shows no provider calls).

## Privacy & BYOK
SubVibe has **no servers of its own.** Your API key (OpenAI, Anthropic, or Google) is stored
locally and used to call that provider **directly from your browser**; only the video's caption
or audio text is sent there, to translate it. Nothing else leaves your device.
→ **[Privacy policy](https://nimanou.com/subvibe/privacy)**

## Open source & verifiable builds
SubVibe has **no build step** — it's vanilla JS/HTML/CSS, nothing minified or bundled. **The
files in this repo are exactly what ships and runs.**

**Reproduce the published package** from source:
```bash
./build.sh        # → subvibe-v<version>.zip, the exact zip uploaded to the Web Store
```

**Verify the published extension matches this source:**
1. Chrome installs extensions *unpacked* at `…/Chrome/Default/Extensions/<id>/<version>/`.
2. `diff -r` that folder against this repo at the matching release tag (e.g. `v1330.2.0`).
3. A clean diff means identical code — and because nothing is minified, the diff is human-readable.

> Note: the `.crx` Google *serves* is re-signed/re-packaged, so it isn't byte-identical to the
> upload — but the file **contents** are, which is exactly what the `diff` confirms.

## Project structure
- `manifest.json` — MV3 config & permissions.
- `background.js` — service worker: IndexedDB cache + provider calls (cross-origin lives here, never in a content script).
- `content/common.js` — the engine: detect source, build per-language cues, render & sync the overlay.
- `content/adapters/*` — per-site caption acquisition (YouTube, Netflix, ZDF, DW, Prime, Udemy).
- `content/subs-intercept.js` — MAIN-world subtitle/segment sniffer + page-world playhead relay.
- `offscreen-live.js` — the Live Translate audio session (tab capture ↔ Gemini ↔ playback).
- `popup.html` / `popup.js` — settings (keys, languages, appearance, per-video).
- `shared/`, `styles/`, `fonts/`, `icons/` — shared data, overlay styling, RTL font, icons.

## License
MIT — see [LICENSE](LICENSE).

—

Made by [Nimanou](https://nimanou.com).
