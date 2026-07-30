# Chrome Web Store screenshots

The `store-*-1280x800.jpg` files are the listing screenshots (exact store
spec: 1280×800 JPEG). Suggested order in the dashboard: **action first**
(the product doing its job), then translate, dub, style. Regenerate after any
popup or overlay change worth showing.

## The action shot

`action.html` renders SubVibe's REAL subtitle output — the actual
`styles/overlay.css` plus the exact DOM `setLineText()` produces (word spans,
`.sung` karaoke fill, dual lines, RTL) — over a mock cinematic frame with
generic player chrome. Mock scene on purpose: frames from other people's
videos are their copyright. Two traps encoded in the file's comments: caption
markup must be single-line (`pre-wrap` renders source newlines), and the
overlay must keep its natural `inset: 0` geometry (only `--cs-font` and
z-index are overridden). Capture at 1280×800 → same `sips` downscale.

## How they're made (repeatable)

1. **Capture each tab** — open `popup.html` in a Chromium with `chrome.*` stubbed
   (seeded storage: Claude engine + Sonnet 5, Persian target, keys present,
   dub enabled). Viewport 500×672 (Chrome's minimum window width is 500; the
   340px popup fills the left side — the composer crops the rest).
   - Translate: close `#keysDetails`, scroll top.
   - Dub: enable dub, open `#voiceFold`, scroll top.
   - Style: open `#lookFold`, scroll to bottom (`scrollHeight - innerHeight`)
     so the expanded Appearance options and footer end cleanly.
   Save as `shots/raw-<tab>.png`.
2. **Compose** — open `compose.html?tab=<tab>` at viewport 1280×800 and
   screenshot → `shots/composed-<tab>.png`. Headlines/bullets live in the
   `TABS` map inside `compose.html`; edit copy there.
3. **Finalize** — retina captures are 2560×1600; downscale:
   `sips -z 800 1280 -s format jpeg -s formatOptions 92 shots/composed-<tab>.png --out store-<tab>-1280x800.jpg`

Any agent session can re-run this via the chrome-devtools MCP (the capture
stub + fold/scroll steps above are the whole recipe). The store dashboard
upload itself is manual: Store listing → Screenshots → replace.

## Promo tiles

`promo-small-440x280.jpg` (category grids / search rails — required for any
featuring consideration) and `promo-marquee-1400x560.jpg` (featured banners).
Sources: `promo-small.html` (designed at 2×, 880×560 — Chrome's minimum window
width is 500 so a 440 viewport can't be captured directly) and
`promo-marquee.html` (1400×560 natively). Capture at the design size, then
`sips -z <h> <w> … --out promo-*.jpg`.

## Real-footage shots

`real-video.html?clip=sintel|bunny&style=classic|tiktok` streams a Blender
Foundation open movie (CC-BY, attribution rendered in-frame) from
download.blender.org and lays the real overlay on top — Sintel wears Classic,
Big Buck Bunny wears TikTok (Baloo 2 + heavy outline, loaded from ../../fonts).
MUST be served over http (file:// pages can't load remote video):
`python3 -m http.server 8734` from the repo root, then open
`http://localhost:8734/tools/store-screenshots/real-video.html?...`, wait for
the title to say READY, resize 1280×800 (re-check EVERY capture — a stale
window size from a previous tile silently distorts), screenshot, sips.

Store allows 5 screenshots — suggested set: real-sintel, real-bunny,
translate, dub, style (the mock `action` shot is the spare).
