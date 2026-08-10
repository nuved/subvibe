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

Wait ~19s. Verdict lands in the tab title: `PASS 3/3` or `FAIL n/3`, details
in the page. The three checks: German adopted before the switch (guards
against a vacuous pass), English rendered after the switch, German never
returns.

Pre-fix state fails 1/3 (baseline passes, both switch checks fail).
