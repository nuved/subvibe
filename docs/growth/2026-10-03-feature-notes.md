# SubVibe feature notes for nimanou.com posts and store acquisition (2026-10-03)

For the nimanou.com blog (the site itself is owned by the `nimanou-home-redesign` session's claim; hand these notes over, don't edit the site from here). One post per feature, written around what a person searches for, each ending on "Add to Chrome". Store copy rule from `tools/store-listing.md` still holds: no streaming-brand names in the store listing or promo images. A blog post on our own site may name the sites it was tested on.

Baseline to beat: 48 users, 5.0 from 3 ratings (store page, 2026-10-03).

| Feature | What people search | Post angle | Proof to show | Ships in |
|---|---|---|---|---|
| Dual subtitles on any video | "dual subtitles chrome", "two subtitles at once" | Learn from the shows you already watch: original line above, your language below | 10-second clip, one line in both languages | live now |
| Story board with tips | "learn english with songs", "understand song lyrics" | A song explained line by line: the phrase, what it means here, nothing repeated | Screenshot of the tips-first row (after Phase 2) | Phase 2 |
| Live Translate (tab audio) | "translate video audio live", "real time video translation chrome" | Any video in your language by voice, and why it runs ~3 s behind (and the sync fix) | Before/after clip with the sync control | Phase 3 |
| Film mode | "dub any movie into my language" | Subtitles spoken on time, and what it costs per film (~$0.80 for 2 h) | Cost line before Start | Phase 4 |
| Shots (translated screenshots) | "translate text in video screenshot" | Grab a frame, get it translated and explained | Shot editor screenshot | live now |
| Honest cost | "subtitle translator free", "ai translator cost" | You pay the provider cents, never us; the price is shown before anything expensive runs | Explain all · ~$0.42 button (Phase 1) | Phase 1 |
| Free styled captions | "make youtube captions bigger", "caption style chrome" | Free, no account: captions you can actually read | Style presets screenshot | live now |

## What to measure

- Store: weekly installs and uninstalls (developer dashboard), rating count. One post a week for 6 weeks, then compare installs per week against the 48-user baseline.
- Posts: link to the store with `?utm_source=nimanou&utm_campaign=<feature>` so the dashboard's traffic sources separate blog visits from store search.
- Inside the extension: none. SubVibe sends no analytics (PRIVACY.md); keep it that way, and say so in every post, since it's part of the pitch.

## Reviews

- Reply to the 2026-10-01 review when Phase 3 ships, naming the version.
- The welcome page's last step can ask for a rating after the third translated video, once, never again.
