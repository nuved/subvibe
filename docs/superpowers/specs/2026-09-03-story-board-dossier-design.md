# Story board dossier — the board learns what it's watching

Date: 2026-09-03 · Status: **approved** (operator, 2026-09-03: "that is fine
if you think as a designer" — layout A, TMDb key pasted under Keys, tips ahead
= next 3 chunks). Mock: the "SubVibe L-Board" artifact, variants A · B · C.
Follows `2026-09-03-chunk-tips-design.md`. Tier: Fable (brain) — this file is
the decomposition; the build goes to Opus executors.

## Why

The board on Netflix (see the operator's screenshot, 2026-09-03) reads the
episode from its subtitle lines alone: `document.title` on a Netflix watch
page is "Netflix", so the model guessed "Crime drama series (scripted TV)"
from 40 sampled lines and nothing else. Tips are bought one chunk at a time,
only when the reader clicks, so the prompt cache goes cold between clicks and
every chunk re-sends the same 40-line sample in its user turn. The tips open
inline in the list at every chunk start, and the list re-scrolls.

The operator asked for: the space under the picture used as well (an L), the
events and the people of each chunk or scene, actor photos, real names and
characters (IMDb-like), the video's own identity (which series, which
episode, Netflix's own description) fed to the model, a cache so later calls
don't resend the context, a pipeline that runs ahead instead of stopping
after one chunk, tips shown so they don't disturb, and the same care for a
YouTube report or interview. "Don't break everything" and good UX first.

## What ships

### 1. The dossier — one file per video

`clipexplain:<base>.dossier`, built once, reused by every prompt and screen:

```
dossier: {
  v: 1, at, site,                      // "netflix" | "youtube" | "prime" | …
  title, show, season, episode, epTitle, year, runtimeMin, synopsis,   // the site's own data
  channel, description,                // YouTube
  kind, about, register, speakers,     // the model's reading (today's ctx)
  people: [{ name, character, role, photo, order, src: "tmdb" | "model" }],  // ≤ 12
  tmdb: { type: "tv" | "movie", id, matched: true|false } | null,
  poster: "https://image.tmdb.org/t/p/w185/…" | "",
  sample: [ "…" ],                     // the subtitle lines frozen into the cached prefix
}
```

**Sources, by site.** The content script's adapter gains `getMeta()`:

- **Netflix.** The movie id is in the URL. Episode identity: the page-world
  helper (`content/page/netflix-seek.js`, MAIN world) reads Netflix's own
  metadata: first choice the member API
  (`/nq/website/memberapi/<BUILD>/metadata?movieid=<id>`, BUILD from
  `netflix.reactContext.models.serverDefs.data.BUILD_IDENTIFIER`, cookies
  carried by a same-origin fetch) → show title, type, synopsis, the current
  episode's season/number/title/synopsis; fallback the player's title block
  (`[data-uia="video-title"]`: `h4` = show, spans = episode number and
  title), which is in the DOM whenever the controls are shown. Both are
  **unverified from memory** and are the executor's first check in the
  operator's Brave (attach only, never launch — see the lab memory).
- **YouTube.** Title (cleaned `document.title`), channel (`adapter.getChannel`),
  description (`#description-inline-expander` text, else
  `ytInitialPlayerResponse.videoDetails.shortDescription` relayed from the
  MAIN world), first 1500 characters. No TMDb on YouTube.
- **Prime, ZDF, DW, Udemy.** Title only (v1).

**TMDb** (background, `shared/tmdb.js` pure + fetch in `background.js`):
optional key `tmdbKey` (Keys tab row "TMDb — cast photos & episode info,
free"). `/3/search/tv?query=<show>` → top hit; `/3/tv/<id>/aggregate_credits`
→ cast by `order` (≤ 12: name, `roles[0].character`, `profile_path`);
`/3/tv/<id>/season/<s>/episode/<e>` → overview and `guest_stars`; movies via
`/3/search/movie` + `/3/movie/<id>/credits`. Photos are `<img>` from
`image.tmdb.org` (Netflix's CSP is report-only and allows `img-src https:`,
verified on the /browse response header 2026-09-03; the watch page is assumed
the same — executor checks). Host permissions: `https://api.themoviedb.org/*`,
`https://image.tmdb.org/*`. Attribution line in the strip: "Cast & episode
data · TMDB" (TMDb's terms). Cached in the dossier 30 days. No key → `people`
come from the model's reading (`people` added to `CONTEXT_SCHEMA`: name,
character/role), marked `src: "model"`, initials instead of photos, and the
strip says "names from the model".

**The model's reading** — today's `videoContext` — now gets the site data
(title, show, episode, synopsis, channel, description) in its user turn and
returns `people` as well. It runs once per video, at dossier build.

**Dossier build** — `DOSSIER {base, meta}` from the content script when the
board is created (before any explanation): cached and fresh → returned;
else built (single-flight per base) and returned. `explainLine` awaits the
same `ensureDossier(base)`, so every explanation shares one prefix.

### 2. One cached prompt

`explainPrompt(lang, target, dossier)` = the existing instructions + a
DOSSIER block (identity · synopsis · "Character — Actor" list · kind, register,
speakers) + the **sample lines** (moved out of the user turn; when the full
cue list is known, up to 300 lines spread evenly, else the 40 known; frozen in
the dossier — rebuilt once if it was built from fewer than 40 lines, the list
later reaches 120+, and no e4 entry has been bought yet). The user turn is
`{s, before: [2 chunks], after: [1 chunk], k, n}`.

- API path: the system block already carries `cache_control: ephemeral`
  (5-minute TTL; every read refreshes it; Sonnet 5's minimum cacheable prefix
  is 512 tokens, ours is 4–6k). No 1-hour TTL, no keep-alive: the pipeline
  keeps it warm while playing; a pause over 5 minutes costs one re-write
  (1.25 × ~5k input tokens ≈ a cent). Verified by `cache_r > 0` on the second
  chunk in the Activity log.
- CLI path: the same system string per call; the CLI's own caching applies
  (`cache_read_input_tokens` is in the envelope).
- Output: `EXPLAIN_SCHEMA` gains `who: [string]` (characters or speakers
  present or speaking in the passage, by the dossier's names when they fit,
  else a role: "the doorman"). Cache keys move to `e4<hash>|<explain>`;
  e3/e2 entries still serve (no `who`), like today.

### 3. Tips ahead — the pump

In `content/common.js`, beside the translation pump:

- State `tips = { ahead: 3, all: false, inflight: null, errors: 0, pausedUntil: 0 }`;
  the popup setting `tipsAhead ∈ {"off", "3", "all"}` (default `"3"`).
- Every `boardTick`: board visible, a provider configured (a key or the
  bridge), the video has played once → ensure chunks `ki … ki+ahead−1` are
  explained, in order, **one call in flight**, cached ones skipped. Runs
  while paused too (like translation). `all` continues to the end.
- Errors: back off 30 s; after 3 in a row, stop with the reason on the
  strip ("Tips paused — no key / bridge not answering · Retry").
- The strip shows: ready-to time, the chunk being explained, count done / all,
  "Explain all →" / "Stop", "Retry" after a stop, "Hide". The per-chunk cost
  stays where it already is (the popup's Activity list); the strip shows counts.
  (v1 simplification — a cost figure on the strip needs a log read from the
  content script; later.)
- The floating ﹖ card and "Frame + N chunks" use the same `explainChunk`
  and therefore the same cache and prefix.

### 4. Layout — variant A (chosen; B and C stay in the mock for the record)

**Drawer players (Netflix, Prime, …): the L.**

- `#sv-board.drawer` splits: `.svb-list` (flex 1, compact rows) over
  `.svb-pane` (46 %, own scroll, collapsible "Tips ▾", remembered). Rows
  never expand: sentences, translations, one `scene` line (from the tips),
  `who` chips. The pane shows `board.open`, which follows the playing chunk
  unless the reader clicked a row in the last 20 s ("following ▸" chip
  returns it). The pane's body is today's `buildTips` + `buildActions`.
- `#sv-strip` (fixed; left 0; right = drawer width; bottom 0; height 112 px;
  hidden in fullscreen and with the board collapsed; own "Hide" remembered in
  `sv-strip-collapsed`): identity (poster, show, "S1 · E3 · title · 44 min",
  synopsis 3 lines, rest on hover) · Now (the playing chunk's scene line, the
  `who` faces large, the speaking one ringed coral, "mentioned" small) · Cast
  rail (the rest, small, dim) · Tips ahead (progress bar: done teal, in-flight
  amber, playhead coral; status; Explain all; Pause).
- `fitPlayer` sets `bottom: 112px` on the player box as it sets `right`
  today. At 1440 × 815 the picture with the drawer open is 1060 × 596 with
  107 px of letterbox above and below; the strip takes the bottom band and the
  picture keeps its size. It shrinks only when the box becomes
  height-limited (ultrawide windows).
- `who` → faces: match `who[]` against `dossier.people[].character` (case-
  insensitive, first-name match), else an initials face with the name as
  given.

**YouTube.** No strip. The same list-over-pane split inside the side-column
board (list `max-height` becomes the board's, pane 40 %), the identity line
under the title ("Interview · host and guest names · channel"), `who` chips on
rows. Description feeds the dossier.

**Popup.** Learn tab: "Tips ahead: off · next 3 chunks · whole video". Keys
tab: TMDb key row with "Get a free key" link, Test (fetches
`/3/configuration`), status dot.

**Share page.** Each chunk's `who` under its scene line; the dossier's
identity as the page header. Study card unchanged.

## Not doing (v1)

A "story so far" recap; scene segmentation beyond chunks; TMDb on YouTube;
IMDb scraping (no free API; TMDb is the IMDb-like source); Wikipedia;
Windows or Firefox specifics; a keep-alive ping for the cache.

## Verification

- `node --test tools/tests/*.test.mjs`: new tests for `shared/tmdb.js`
  parsing (search pick, credits shape, episode overview, empty key), the
  dossier block text (byte-stable for the same dossier; sample frozen), the
  `who` → face matcher, and `tipsAhead` window arithmetic.
- Lab (Chrome for Testing, port 9333, per the lab memory): YouTube — the
  split board renders, the pane follows the playhead, a row click pins, the
  pump explains 3 ahead with one call in flight (seeded cache where the
  bridge is unreachable), the identity line shows.
- Operator's Brave (attach only): Netflix — meta read from the page, the
  strip in the letterbox band with the picture unchanged (measure
  `video.getBoundingClientRect()` before and after), TMDb faces load, the
  Activity log shows `cache_r > 0` from the second chunk, "Explain all"
  counts up and stops on Stop.

## Risks, stated

- Netflix's metadata routes are from memory; if both fail, the dossier
  holds the movie id and the model's reading only, and the strip still shows
  the scene, faces from the model's names, and the pipeline.
- TMDb's top search hit can be the wrong show; the strip shows the matched
  title so it's visible. A "Not this show" fix is a follow-up.
- Cost: with the whole-video setting an episode is ~147 calls (≈ $1.30 on
  Sonnet 5 via API; free on the bridge). The default explains only what is
  watched.
- The `who` names are the model's inference from dialogue plus the cast
  list, not Netflix's speaker tags; shown as "≈" when `src: "model"`.
