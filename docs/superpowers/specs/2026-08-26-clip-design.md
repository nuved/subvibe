# SubVibe Clip — record a video clip with translated subtitles

Date: 2026-08-26 · Status: approved design (mock confirmed)

## Goal

While watching a supported non-DRM video (YouTube, DW, ZDF, Udemy), the user records a short cut of it with SubVibe's already-translated subtitles burned in, then trims and finishes it in a full editor tab (the same big-workspace pattern as the Shot editor), and downloads it as WebM — for social reels/posts and study notes.

Netflix / Prime and any DRM-protected video are out: captured frames come back black (EME/Widevine), so Clip is hidden there.

## Flow

1. **Capture (on the video tab, one small step):** a "Record clip" control (from the popup, mirroring the Shot row). Recording must happen where the video plays, in real time — MediaRecorder can't go faster than playback. The user records from the current point and presses stop (v1); a rough range is fine because trimming is precise in the editor.
2. **Editor (a new full tab `clip.html`, like `shot.html`):** opens on the recorded clip.
   - **Trim** in/out precisely on a timeline (export re-cuts to exactly this range).
   - **Subtitles** — reused from SubVibe's cache (cue text + timings, per target language), kept as *data*, not baked pixels, so the editor can restyle: Both / Target / Original / Off, font (Vazirmatn / site), size, position, color. Burned in only at export.
   - **Caption & badge** — optional headline, SubVibe badge on/off.
   - **Export** — WebM at native or a smaller size; Download and/or Save to a Clips gallery.

## Why these choices

- **Capture raw, overlay subs in the editor.** We capture the video (frames + audio) without subs baked, and carry the cue data alongside; the editor overlays and restyles them and burns them only at export. This is the Shot editor's "edit then export" philosophy and lets the user change subtitle style/track after recording.
- **WebM (vp9/opus).** MediaRecorder's native output; plays everywhere and uploads to most social apps. MP4 would need heavy in-browser transcoding (ffmpeg.wasm) — deferred.
- **Real-time capture.** No way around it; the UI sets that expectation ("recording plays the range, ~Ns").

## Technical approach

- **Capture:** draw the `<video>` element to a canvas each frame + `canvas.captureStream()` for video, plus the media element's audio track, muxed into one MediaStream → MediaRecorder → WebM Blob stored in IndexedDB (new `clips` store in `copilot-subs`). Validated in a browser: vp9+opus supported, audio muxes, MediaRecorder emits a valid WebM container. The one unproven bit (frame encoding in an occluded test window) is cleared first by a real-tab capture test on YouTube.
- **Editor export re-cut:** load the stored clip into a `<video>`, play the trim range, composite video + styled subtitle overlay onto a canvas, `captureStream` + audio → MediaRecorder → the final trimmed WebM. Real-time but on a local file, reliable.
- **Subtitles:** reuse the cached cues (shape + access mapped from the existing pipeline). Map clip time → original video time → cue.
- **On-demand injection:** mirror the Shot pattern (background injects `content/clip-capture.js` on the SHOT-like trigger; guard flag; message listener). activeTab + tabCapture are already in the manifest.

## Scope

**v1:** record → editor → trim + subtitle style + caption → export WebM (+ Save to Clips). Non-DRM guard.

**Later:** Clips gallery like Shots, multiple cuts per video, logo/caption overlays, MP4 via transcoding.

## Risk cleared first

A real-tab capture test on a live YouTube video (the frame-encode step that an occluded/headless test window can't prove). Everything else builds on the confirmed format/audio/WebM layer and the existing subtitle cache.

## Audio & dubbing — decided 2026-08-26 (after testing)

Live Translate and Clip both need `tabCapture`, and a tab can only be captured once — so they can't run together. Worse, Live's translated speech is synthesized *outside* the tab (in the offscreen audio engine) and never enters the tab's audio, so a tab capture can't pick it up anyway. Dub mode (Web-Audio TTS played in the page) *does* land in the tab audio and is captured fine.

Decision (the operator's call): **don't try to record Live's audio. Capture the video plainly, then dub it in the editor** — a post-capture step that translates the clip's speech and lays the dubbed voice onto the captured video, so the final export has the translated audio. This sidesteps the Live/tab-capture collision entirely (Live doesn't even need to be running to make a dubbed clip).

To align the dub, capture stores `startSec` (the source video's playhead when recording began); the editor maps clip time → source time → the cached translated cues, synthesizes speech per cue (reusing SubVibe's dub/TTS), ducks the original, and mixes at export. Original-audio + burned subtitles remains the default; dubbing is an editor action.
