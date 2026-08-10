# Track-switch harness — the player's subtitle menu must swap the cue list

Pins the operator's report: watching with German subtitles on a native-track
site (ZDF/DW-shaped: every language preloaded in `video.textTracks`, no
caption-file refetch on switch), picking English in the player's subtitle menu
changed nothing — SubVibe kept translating the German lines until a hard
refresh.

Two root causes, both in `content/common.js`:

1. `readVideoCueList` returned the FIRST track with cues, ignoring the
   player's selection — and its disabled→hidden cue-loading nudge resurrected
   the track the viewer had just deselected.
2. Nothing listened for the player's track-mode changes, and the held cue
   list is keyed by clip id only, so a same-clip language switch was
   invisible: the upgrade poll's `!(interceptedCues && …)` guard refused to
   adopt anything while cues were held.

The fix: `readVideoCueList` prefers the showing (or last-shown) track, and a
`change` listener on `TextTrackList` drops + re-adopts when the shown track
differs from the one the held cues came from (native-sourced only — URL/file
sites refetch on switch and `fetchSubsByUrl` already owns that path).

Runs the REAL `content/common.js` against a chrome stub + a generic
native-track adapter. Two programmatic tracks with identical timing; the
driver flips modes at t=8s exactly like a site's subtitle menu (no network).

## Run

Serve the repo root over HTTP (file:// is blocked for some drivers, and
browsers may heuristically cache `common.js` — hard-reload after edits):

    python3 -m http.server 8642
    open http://127.0.0.1:8642/tools/tests/track-switch-harness/harness.html?autorun=1

Wait ~65s (two phases, chained by navigation; results carried in
window.name). Verdict lands in the tab title: `PASS 6/6` or `FAIL n/6`.

Phase 1 (`autorun=1`) — NATIVE tracks: two programmatic tracks, the driver
flips modes at t=8s like a site's subtitle menu (no network). Checks: German
adopted before the switch (guards against a vacuous pass), English rendered
after, German never returns. Pre-fix: FAIL (switch ignored).

Phase 2 (`autorun=2`) — the URL/timedtext path (YouTube-shaped): each pick
posts that track's file URL; the driver goes German → English → BACK to
German (the operator's original → auto-translate → original sequence).
Checks: first file adopted, switch-away adopts the new file, switch-BACK
re-adopts the first. Pre-fix: switch-back FAILED — `fetchedSubUrls` treated
"fetched once" as "active forever", so A→B→A stuck on B. The fix remembers
parsed files per dedup key (`subFilesByKey`) and swaps back without a
refetch.
