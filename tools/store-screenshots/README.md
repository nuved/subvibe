# Chrome Web Store screenshots

The `store-*-1280x800.jpg` files are the listing screenshots (exact store
spec: 1280×800 JPEG). Daylight set (2026-08-10) — dashboard order in
../store-listing.md: **hero** (real footage) → live → subtitles → learn →
trust (style is the spare). Regenerate after any popup or overlay change
worth showing.

## How they're made (repeatable, any agent session with Playwright MCP)

Serve the repo root: `python3 -m http.server 8642`.

1. **Popup captures** — `popup-stub.js` fakes `chrome.*` (Claude + Sonnet 5,
   Persian primary, keys verified, a cached clip, enriched German words).
   Inject it with Playwright `addInitScript`, viewport 500×672, open
   `/popup.html`, then per shot:
   - subtitles: default load
   - live: `liveUI(true, "Live — running.")` (popup.js fns are globals)
   - style: `selectTab("style")` + open `#lookFold`
   - learn: `selectTab("learn")` (words come from the stub)
   Save as `shots/raw-<tab>.png`. If the header logo shows the old cached
   icon, re-point it: `header img` src → `/icons/icon-48.png?bust`.
2. **Compose** — `compose.html?tab=live|subtitles|style|learn|trust` at
   viewport 1280×800 (`trust` is a full-bleed text card, no popup) →
   `shots/composed-<tab>.png`. Copy lives in the TABS map inside.
3. **Hero** — `real-video.html?clip=sintel&style=classic` (see below), wait
   for READY in the title, 1280×800 → `shots/hero-sintel.png`.
4. **Finalize** — captures with `scale: "css"` are already 1280×800:
   `sips -s format jpeg -s formatOptions 92 shots/<x>.png --out store-<x>-1280x800.jpg`

## Icon

`icon.html` renders the Daylight mark (coral tile, Baloo S, subtitle bar) at
512 CSS px. Capture `#mark` with `omitBackground: true, scale: "css"` (body
set transparent first), then `sips -z <s> <s>` to 128/48/32/16 → `icons/`.
Viewport must be wider than 512 — a stale narrow viewport silently clips.

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
