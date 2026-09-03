# Story Board Dossier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The story board learns what it is watching (the episode's identity, the cast with photos, the kind of video), explains chunks ahead of the playhead over one cached prompt, and shows the tips in a fixed pane plus an L-shaped scene strip under the picture.

**Architecture:** A per-video *dossier* (site metadata + TMDb cast + the model's reading + a frozen subtitle sample) is built once in the background and stored in `clipexplain:<base>`; it becomes a byte-stable block inside the explain system prompt (the cached prefix), so each chunk sends only its own lines. The content script gains a tips pump (next 3 chunks, one call in flight) and, in drawer mode, splits the drawer into list + tips pane and adds `#sv-strip` under the player. Pure logic lives in two new node-tested modules, `shared/dossier.js` and `shared/tmdb.js`.

**Tech Stack:** Chrome MV3 extension, vanilla JS (content script closure style — dense one-liners are the house dialect), IndexedDB via `idbVocabGet/Put`, `node --test` for pure modules, Anthropic/OpenAI/Claude-CLI via the existing `llmJSON`.

Spec: `docs/superpowers/specs/2026-09-03-story-board-dossier-design.md` (approved; layout A).
Mock: the "SubVibe L-Board" artifact (https://claude.ai/code/artifact/f152235e-cc0d-4b41-8c6e-9d6d6febdddf).

## Global Constraints

- Branch `board-dossier` (already created, spec committed). Commit as `Novid <support@nimanou.com>`; **no** Co-Authored-By / session trailers (house rule).
- `node --test tools/tests/*.test.mjs` must stay green (219 pass today) plus the new tests.
- Never launch the installed Brave/Chrome. Lab = playwright's Chrome for Testing on port 9333 with `--load-extension=/Users/novid/claude/subvibe` (see Task 11). The operator's Brave is attach-only, and only when they exposed port 9222.
- Existing cache entries stay readable: `e3…`/`e2…` explanations are served (without `who`); `ctx` stays as the kind/about/register/speakers of the dossier.
- Prompt prefix is cache-stable per (source, target, dossier): nothing per-call in the system string. The API path keeps `cache_control: {type: "ephemeral"}` on the system block (already in `llmJSON`).
- Netflix's CSP is report-only and allows `img-src https:` — TMDb photos load as plain `<img>` (verified on /browse; the watch page is assumed the same).
- TMDb terms: show "Cast & episode data · TMDB" wherever TMDb data is displayed. Images: `https://image.tmdb.org/t/p/w185<profile_path>`.
- Storage keys added: `tmdbKey` (string, default ""), `tipsAhead` ("off" | "3" | "all", default "3").
- Copy: plain words, no jargon in UI strings; the strip and pane follow the board's existing tone ("Explain all →", "Tips paused — …").

---

## File map

| File | Responsibility in this feature |
|---|---|
| `shared/dossier.js` (new) | Pure: `block(d)` prefix text, `sampleLines`, `whoFaces`, `aheadWindow`, `initials`, `identityLine` |
| `shared/tmdb.js` (new) | Pure: pick the right search hit, shape credits/episode, image URLs |
| `tools/tests/dossier.test.mjs`, `tools/tests/tmdb.test.mjs` (new) | Node tests for the two modules |
| `background.js` | `ensureDossier`, `tmdbLookup`, `DOSSIER`/`TMDB_TEST` handlers, `explainPrompt(source, target, dossier)`, `EXPLAIN_SCHEMA.who`, e4 keys, `tipsCached` returns the dossier |
| `manifest.json` | host permissions for `api.themoviedb.org` and `image.tmdb.org` |
| `content/page/netflix-seek.js` | MAIN world: answers `op: "meta"` with Netflix's episode metadata |
| `content/subs-intercept.js` | MAIN world (YouTube): answers `META_REQ` with `ytInitialPlayerResponse.videoDetails` when it matches the current video |
| `content/adapters/netflix.js`, `content/adapters/youtube.js` | `getMeta()` → Promise of the site's identity |
| `content/common.js` | `DOSSIER` on board creation; tips pump; compact rows; `.svb-pane`; `#sv-strip`; `fitPlayer` bottom inset; teardown |
| `styles/overlay.css` | pane, strip, row scene/who chips |
| `popup.html`, `popup.js` | TMDb key row (Keys tab), "Tips ahead" select (Subtitles tab), DEFAULTS |
| `share.js` | `who` under the scene line; invite footer with the store link |

Message contracts (the content script ↔ background):

```
DOSSIER      → { type: "DOSSIER", base, meta: MetaIn, sample: string[], lang }        ← { ok: true, dossier: Dossier }
VOCAB_EXPLAIN→ { …as today…, k, n }                                                     ← { …as today…, who: string[] }
TMDB_TEST    → { type: "TMDB_TEST", key }                                              ← { ok: true } | { ok: false, error }
TIPS_CACHED  → unchanged                                                                ← { …, ctx, dossier: Dossier | null }

MetaIn  = { site, url, title, show, season, episode, epTitle, year, runtimeMin, synopsis, channel, description }   (strings/numbers, any may be "")
Dossier = { v: 1, at, site, title, show, season, episode, epTitle, year, runtimeMin, synopsis, channel, description,
            kind, about, register, speakers, people: [{ name, character, role, photo, order, src }], tmdb: { type, id, matched } | null,
            poster, sample: string[], tmdbAt }
```

---

### Task 1: `shared/dossier.js` — the pure pieces

**Files:**
- Create: `shared/dossier.js`
- Test: `tools/tests/dossier.test.mjs`

**Interfaces:**
- Produces global `SV_DOSSIER` (same IIFE pattern as `shared/cli.js`: `(function (g) { … g.SV_DOSSIER = {…}; })(globalThis)`) with:
  - `block(d)` → string: the byte-stable DOSSIER block for the prompt (empty string when `d` is null).
  - `identityLine(d)` → string: "Show · S1 E3 · Episode title" / "Title" for the UI.
  - `sampleLines(lines, max)` → string[]: `max` lines spread evenly (all of them when fewer), each trimmed to 160 chars, blanks dropped.
  - `whoFaces(who, people)` → `[{ label, person }]` (≤ 4).
  - `aheadWindow(ki, n, ahead, isExplained)` → index of the next chunk to explain, or −1.
  - `initials(name)` → 1–2 uppercase letters.

- [ ] **Step 1: Write the failing tests**

```js
// tools/tests/dossier.test.mjs — the dossier block, sample, who→faces, tips-ahead window (shared/dossier.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/dossier.js";

const D = globalThis.SV_DOSSIER;
const netflix = { v: 1, site: "netflix", title: "", show: "The Block", season: 1, episode: 3, epTitle: "Raymond", year: 2024, runtimeMin: 44,
  synopsis: "Two men come to the block to pick something up for a friend who isn't around.", channel: "", description: "",
  kind: "crime drama series", about: "a street crew and a missing friend", register: "casual, slang", speakers: "young men outside a building",
  people: [{ name: "Ada Lee", character: "Boobie", role: "", photo: "", order: 0, src: "tmdb" }, { name: "Ben Ito", character: "Raymond", role: "", photo: "", order: 1, src: "tmdb" }],
  tmdb: { type: "tv", id: 1, matched: true }, poster: "", sample: ["No. Y'all know Boobie?", "Boobie, huh? Yeah, he ain't here, though."] };

test("block: byte-stable, one line per fact, the sample numbered, nothing per-call", () => {
  const a = D.block(netflix), b = D.block(JSON.parse(JSON.stringify(netflix)));
  assert.equal(a, b);
  assert.match(a, /^VIDEO DOSSIER \(context only — never explain or translate it\):\n/);
  assert.match(a, /- Title: The Block — S1E3 "Raymond" \(2024\)\n/);
  assert.match(a, /- Synopsis: Two men come to the block/);
  assert.match(a, /- Kind: crime drama series — a street crew and a missing friend\. Register: casual, slang\. Speakers: young men outside a building\n/);
  assert.match(a, /- People \(character — actor\): Boobie — Ada Lee; Raymond — Ben Ito\n/);
  assert.match(a, /SUBTITLE SAMPLE \(spread over the whole video\):\n1\. No\. Y'all know Boobie\?\n2\. Boobie, huh\?/);
  assert.ok(!/\b(at|tmdbAt|Date)\b/.test(a), "no timestamps in the prefix");
  assert.equal(D.block(null), "");
});

test("block: a YouTube dossier names the channel and description; people from the model read 'name (role)'", () => {
  const yt = { site: "youtube", title: "Interview with a climber", channel: "Peak TV", description: "Anna talks about her Everest attempt.\nLinks below.", kind: "interview", about: "mountaineering",
    register: "calm", speakers: "host and guest", people: [{ name: "Anna", character: "", role: "guest, climber", src: "model" }, { name: "Tom", character: "", role: "host", src: "model" }], sample: [] };
  const t = D.block(yt);
  assert.match(t, /- Title: Interview with a climber\n- Channel: Peak TV\n- Description: Anna talks about her Everest attempt\. Links below\.\n/);
  assert.match(t, /- People: Anna \(guest, climber\); Tom \(host\)\n/);
  assert.ok(!/SUBTITLE SAMPLE/.test(t), "no sample section when the sample is empty");
});

test("block: the description is cut at 600 chars, the synopsis at 400, the sample at 300 lines", () => {
  const long = { site: "youtube", title: "T", description: "x".repeat(2000), synopsis: "y".repeat(2000), people: [], sample: Array.from({ length: 500 }, (_, i) => "line " + i) };
  const t = D.block(long);
  assert.equal(t.match(/- Description: (x+)\n/)[1].length, 600); assert.equal(t.match(/- Synopsis: (y+)\n/)[1].length, 400);
  assert.ok(t.includes("300. line 299") && !t.includes("301. line"));
});

test("identityLine: show · S1 E3 · title, else the title", () => {
  assert.equal(D.identityLine(netflix), "The Block · S1 E3 · Raymond");
  assert.equal(D.identityLine({ title: "Only a title" }), "Only a title");
  assert.equal(D.identityLine(null), "");
});

test("sampleLines: spread evenly, trimmed, blanks dropped", () => {
  const lines = Array.from({ length: 100 }, (_, i) => (i % 10 === 5 ? "  " : "L" + i));
  const s = D.sampleLines(lines, 10);
  assert.equal(s.length, 10); assert.equal(s[0], "L0"); assert.ok(!s.includes("")); assert.ok(s.every((x) => x.length <= 160));
  assert.deepEqual(D.sampleLines(["a", "b"], 40), ["a", "b"]);
  assert.equal(D.sampleLines(["x".repeat(500)], 5)[0].length, 160);
});

test("whoFaces: matches a character or actor by whole name or first name, keeps unknown names as initials-only", () => {
  const f = D.whoFaces(["Boobie", "raymond", "the doorman", "Ada"], netflix.people);
  assert.equal(f.length, 4);
  assert.equal(f[0].person.character, "Boobie"); assert.equal(f[1].person.character, "Raymond");
  assert.equal(f[2].person, null); assert.equal(f[2].label, "the doorman");
  assert.equal(f[3].person.name, "Ada Lee");
  assert.equal(D.whoFaces(["a", "b", "c", "d", "e"], []).length, 4, "at most four faces");
  assert.deepEqual(D.whoFaces(null, netflix.people), []);
});

test("aheadWindow: the first unexplained chunk in [ki, ki+ahead), nothing before play, all = to the end", () => {
  const done = new Set([3, 4]);
  const ex = (k) => done.has(k);
  assert.equal(D.aheadWindow(3, 10, 3, ex), 5);
  assert.equal(D.aheadWindow(3, 10, 2, ex), -1, "3 and 4 are done, the window of 2 is satisfied");
  assert.equal(D.aheadWindow(-1, 10, 3, ex), -1, "nothing playing yet");
  assert.equal(D.aheadWindow(-1, 10, Infinity, ex), 0, "explain all starts at the top even before play");
  assert.equal(D.aheadWindow(8, 10, 3, ex), 8);
  assert.equal(D.aheadWindow(9, 10, Infinity, () => true), -1);
});

test("initials: two letters from two words, one from one, ? for nothing", () => {
  assert.equal(D.initials("Ada Lee"), "AL"); assert.equal(D.initials("boobie"), "B"); assert.equal(D.initials("the doorman"), "TD"); assert.equal(D.initials(""), "?");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tools/tests/dossier.test.mjs`
Expected: FAIL — `Cannot find module '../../shared/dossier.js'`.

- [ ] **Step 3: Write `shared/dossier.js`**

```js
// shared/dossier.js — the video's dossier as prompt text and as UI facts.
// Pure (node-tested). The block is CACHE-STABLE: the same dossier object gives
// the same bytes, and nothing that changes per call (times, counts) is in it.
(function (g) {
  const s = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n || 4000);
  const clip = (arr, n) => (Array.isArray(arr) ? arr : []).slice(0, n);
  function identityLine(d) {
    if (!d) return "";
    const show = s(d.show, 120), title = s(d.title, 120), ep = s(d.epTitle, 120);
    if (show) { const se = d.season && d.episode ? "S" + d.season + " E" + d.episode : d.episode ? "E" + d.episode : ""; return [show, se, ep].filter(Boolean).join(" · "); }
    return title;
  }
  function block(d) {
    if (!d) return "";
    const out = ["VIDEO DOSSIER (context only — never explain or translate it):"];
    const show = s(d.show, 120), title = s(d.title, 160), ep = s(d.epTitle, 120), year = d.year ? " (" + s(d.year, 4) + ")" : "";
    if (show) out.push("- Title: " + show + (d.season && d.episode ? " — S" + d.season + "E" + d.episode : d.episode ? " — E" + d.episode : "") + (ep ? ' "' + ep + '"' : "") + year);
    else if (title) out.push("- Title: " + title + year);
    if (d.channel) out.push("- Channel: " + s(d.channel, 80));
    if (d.description) out.push("- Description: " + s(d.description, 600));
    if (d.synopsis) out.push("- Synopsis: " + s(d.synopsis, 400));
    if (d.kind) out.push("- Kind: " + s(d.kind, 80) + (d.about ? " — " + s(d.about, 200) : "") + (d.register ? ". Register: " + s(d.register, 120) : "") + (d.speakers ? ". Speakers: " + s(d.speakers, 160) : ""));
    const people = clip(d.people, 12).filter((p) => p && (p.name || p.character));
    if (people.length) {
      const tmdb = people.some((p) => p.character);
      out.push(tmdb ? "- People (character — actor): " + people.map((p) => s(p.character || "?", 60) + " — " + s(p.name || "?", 60)).join("; ")
                    : "- People: " + people.map((p) => s(p.name, 60) + (p.role ? " (" + s(p.role, 60) + ")" : "")).join("; "));
    }
    const sample = clip(d.sample, 300).map((l) => s(l, 160)).filter(Boolean);
    if (sample.length) { out.push("SUBTITLE SAMPLE (spread over the whole video):"); sample.forEach((l, i) => out.push((i + 1) + ". " + l)); }
    return out.join("\n") + "\n";
  }
  function sampleLines(lines, max) {
    const all = (Array.isArray(lines) ? lines : []).map((l) => s(l, 160)).filter(Boolean);
    const n = Math.max(1, max | 0);
    if (all.length <= n) return all;
    const step = all.length / n, out = [];
    for (let i = 0; i < n; i++) out.push(all[Math.floor(i * step)]);
    return out;
  }
  const norm = (x) => s(x, 80).toLowerCase();
  const first = (x) => norm(x).split(/[\s,.'’-]+/).filter((w) => w.length >= 3)[0] || "";
  function whoFaces(who, people) {
    const ps = Array.isArray(people) ? people : [];
    return clip(who, 4).map((w) => s(w, 60)).filter(Boolean).map((label) => {
      const n = norm(label), f = first(label);
      const person = ps.find((p) => norm(p.character) === n || norm(p.name) === n) || (f && ps.find((p) => first(p.character) === f || first(p.name) === f)) || null;
      return { label, person };
    });
  }
  function aheadWindow(ki, n, ahead, isExplained) {
    const all = !(ahead < Infinity);
    const from = ki >= 0 ? ki : all ? 0 : -1; if (from < 0) return -1;
    const to = all ? n - 1 : Math.min(n - 1, from + ahead - 1);
    for (let k = from; k <= to; k++) if (!isExplained(k)) return k;
    return -1;
  }
  function initials(name) {
    const w = s(name, 60).split(/\s+/).filter(Boolean);
    if (!w.length) return "?";
    return (w.length > 1 ? w[0][0] + w[w.length - 1][0] : w[0][0]).toUpperCase();
  }
  g.SV_DOSSIER = { block, identityLine, sampleLines, whoFaces, aheadWindow, initials };
})(typeof globalThis !== "undefined" ? globalThis : this);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tools/tests/dossier.test.mjs`
Expected: 8 pass.

- [ ] **Step 5: Commit**

```bash
git add shared/dossier.js tools/tests/dossier.test.mjs
git commit -m "Dossier: the video's file as cache-stable prompt text, who→faces, the tips-ahead window"
```

---

### Task 2: `shared/tmdb.js` — shaping TMDb answers

**Files:**
- Create: `shared/tmdb.js`
- Test: `tools/tests/tmdb.test.mjs`

**Interfaces:**
- Produces global `SV_TMDB`:
  - `pickTitle(results, want, year)` → the best search hit or null (exact name match first, then year, then `popularity`).
  - `cast(credits, max)` → `[{ name, character, photo, order, src: "tmdb" }]` from `/aggregate_credits` (`roles[0].character`) or `/credits` (`character`).
  - `episode(ep)` → `{ epTitle, synopsis, guests: [{name, character, photo, order, src}] }` from `/tv/{id}/season/{s}/episode/{e}`.
  - `imageUrl(path, size)` → `https://image.tmdb.org/t/p/<size><path>` or "".
  - `urls(key)` → the request builders used by the background: `search(kind, q)`, `credits(kind, id)`, `episode(id, s, e)`, `configuration()`.

- [ ] **Step 1: Write the failing tests**

```js
// tools/tests/tmdb.test.mjs — shaping TMDb search/credits/episode answers (shared/tmdb.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/tmdb.js";

const T = globalThis.SV_TMDB;

test("pickTitle: an exact name beats popularity; the year breaks ties; nothing matches → the most popular", () => {
  const rs = [{ id: 1, name: "The Block", first_air_date: "2019-01-01", popularity: 50 }, { id: 2, name: "The Block", first_air_date: "2024-05-01", popularity: 10 }, { id: 3, name: "Block Party", popularity: 900 }];
  assert.equal(T.pickTitle(rs, "the block", 2024).id, 2);
  assert.equal(T.pickTitle(rs, "The Block", null).id, 1);
  assert.equal(T.pickTitle(rs, "Nothing like it", null).id, 3);
  assert.equal(T.pickTitle([], "x", null), null);
  assert.equal(T.pickTitle([{ id: 9, title: "A Movie", release_date: "2020-02-02", popularity: 1 }], "a movie", 2020).id, 9, "movies carry title/release_date");
});

test("cast: aggregate credits (roles[]) and plain credits (character) shape the same way, sorted by order, capped", () => {
  const agg = { cast: [{ name: "Ben Ito", roles: [{ character: "Raymond" }], profile_path: "/b.jpg", order: 1 }, { name: "Ada Lee", roles: [{ character: "Boobie" }], profile_path: null, order: 0 }] };
  assert.deepEqual(T.cast(agg, 12), [{ name: "Ada Lee", character: "Boobie", photo: "", order: 0, src: "tmdb" }, { name: "Ben Ito", character: "Raymond", photo: "https://image.tmdb.org/t/p/w185/b.jpg", order: 1, src: "tmdb" }]);
  const plain = { cast: [{ name: "C", character: "Cop", profile_path: "/c.jpg", order: 0 }, { name: "D", character: "", profile_path: "", order: 1 }] };
  assert.equal(T.cast(plain, 1).length, 1); assert.equal(T.cast(plain, 5)[0].character, "Cop");
  assert.deepEqual(T.cast(null, 5), []);
});

test("episode: title, overview and guest stars", () => {
  const e = T.episode({ name: "Raymond", overview: "Two men come to the block.", guest_stars: [{ name: "G", character: "Guest", profile_path: "/g.jpg", order: 3 }] });
  assert.equal(e.epTitle, "Raymond"); assert.equal(e.synopsis, "Two men come to the block.");
  assert.deepEqual(e.guests, [{ name: "G", character: "Guest", photo: "https://image.tmdb.org/t/p/w185/g.jpg", order: 3, src: "tmdb" }]);
  assert.deepEqual(T.episode(null), { epTitle: "", synopsis: "", guests: [] });
});

test("imageUrl and urls", () => {
  assert.equal(T.imageUrl("/x.jpg", "w185"), "https://image.tmdb.org/t/p/w185/x.jpg"); assert.equal(T.imageUrl("", "w185"), ""); assert.equal(T.imageUrl(null), "");
  const u = T.urls("KEY");
  assert.equal(u.search("tv", "The Block"), "https://api.themoviedb.org/3/search/tv?query=The%20Block&api_key=KEY");
  assert.equal(u.credits("tv", 7), "https://api.themoviedb.org/3/tv/7/aggregate_credits?api_key=KEY");
  assert.equal(u.credits("movie", 7), "https://api.themoviedb.org/3/movie/7/credits?api_key=KEY");
  assert.equal(u.episode(7, 1, 3), "https://api.themoviedb.org/3/tv/7/season/1/episode/3?api_key=KEY");
  assert.equal(u.configuration(), "https://api.themoviedb.org/3/configuration?api_key=KEY");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tools/tests/tmdb.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `shared/tmdb.js`**

```js
// shared/tmdb.js — shaping TMDb (themoviedb.org) answers. Pure; the fetches
// live in background.js (tmdbLookup). Attribution is required wherever the
// data shows: "Cast & episode data · TMDB".
(function (g) {
  const API = "https://api.themoviedb.org/3", IMG = "https://image.tmdb.org/t/p/";
  const s = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n || 200);
  const norm = (x) => s(x, 200).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const yearOf = (r) => parseInt(String(r.first_air_date || r.release_date || "").slice(0, 4), 10) || 0;
  function pickTitle(results, want, year) {
    const rs = (Array.isArray(results) ? results : []).filter((r) => r && r.id);
    if (!rs.length) return null;
    const w = norm(want), y = year | 0;
    const score = (r) => (norm(r.name || r.title) === w ? 100 : 0) + (y && yearOf(r) === y ? 10 : 0) + Math.min(9, (r.popularity || 0) / 100);
    return rs.slice().sort((a, b) => score(b) - score(a))[0];
  }
  const imageUrl = (path, size) => (path ? IMG + (size || "w185") + path : "");
  const person = (c) => ({ name: s(c.name, 80), character: s(c.character || (Array.isArray(c.roles) && c.roles[0] && c.roles[0].character) || "", 80), photo: imageUrl(c.profile_path, "w185"), order: c.order | 0, src: "tmdb" });
  function cast(credits, max) {
    const list = credits && Array.isArray(credits.cast) ? credits.cast.filter((c) => c && c.name) : [];
    return list.map(person).sort((a, b) => a.order - b.order).slice(0, Math.max(0, max | 0));
  }
  function episode(ep) {
    if (!ep) return { epTitle: "", synopsis: "", guests: [] };
    return { epTitle: s(ep.name, 120), synopsis: s(ep.overview, 600), guests: (Array.isArray(ep.guest_stars) ? ep.guest_stars : []).filter((c) => c && c.name).map(person).slice(0, 6) };
  }
  const urls = (key) => {
    const k = "api_key=" + encodeURIComponent(String(key || ""));
    return {
      search: (kind, q) => API + "/search/" + (kind === "movie" ? "movie" : "tv") + "?query=" + encodeURIComponent(String(q || "")) + "&" + k,
      credits: (kind, id) => API + "/" + (kind === "movie" ? "movie/" + id + "/credits" : "tv/" + id + "/aggregate_credits") + "?" + k,
      episode: (id, season, ep) => API + "/tv/" + id + "/season/" + season + "/episode/" + ep + "?" + k,
      configuration: () => API + "/configuration?" + k,
    };
  };
  g.SV_TMDB = { pickTitle, cast, episode, imageUrl, urls };
})(typeof globalThis !== "undefined" ? globalThis : this);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tools/tests/tmdb.test.mjs`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add shared/tmdb.js tools/tests/tmdb.test.mjs
git commit -m "TMDb: pick the right title, shape cast and episode answers, build the request URLs"
```

---

### Task 3: Background — build the dossier (site meta + TMDb + the model's reading)

**Files:**
- Modify: `background.js` — `importScripts` line (~14), `CONTEXT_SCHEMA`/`contextPrompt`/`videoContext` (~997–1018), the message switch (add cases near `case "TIPS_CACHED"` ~3021)
- Modify: `manifest.json` — `host_permissions`

**Interfaces:**
- Consumes: `SV_DOSSIER.sampleLines`, `SV_TMDB.*` (Tasks 1–2); `llmJSON`, `idbVocabGet/Put`, `logCall`.
- Produces: `async ensureDossier(base, meta, sample, lang)` → `Dossier | null` (single-flight per base); `async tmdbLookup(meta, key)` → `{ tmdb, people, poster, epTitle, synopsis }`; message handlers `DOSSIER` and `TMDB_TEST`; `contextLine(ctx)` stays as is for `studyPrompt` (the explain path renders the dossier instead, Task 4). Built later (T3b): a title-only dossier is upgraded when site facts arrive; TMDb never runs from a bare title or on YouTube.

- [ ] **Step 1: Add the host permissions and the imports**

In `manifest.json` `host_permissions`, add after the Anthropic entry:

```json
    "https://api.themoviedb.org/*",
    "https://image.tmdb.org/*",
```

In `background.js` line 14, extend the import list:

```js
if (typeof importScripts === "function") importScripts("shared/pricing.js", "shared/leitner.js", "shared/stopwords.js", "shared/vocab.js", "shared/simplify.js", "shared/shot.js", "shared/cli.js", "shared/dossier.js", "shared/tmdb.js");
```

Check the Firefox build script (`build.sh`) for a list of background scripts — if it enumerates them, add the two files there too.

- [ ] **Step 2: Extend the model's reading to take the site's data and return people**

Replace `CONTEXT_SCHEMA` and `contextPrompt`:

```js
// What kind of video this is — read once from the site's own data (title,
// episode, synopsis, channel, description) and a sample of the lines, cached
// in the dossier, and put in front of every explanation.
const CONTEXT_SCHEMA = { name: "video_context", strict: true, schema: { type: "object", additionalProperties: false,
  properties: { kind: { type: "string" }, about: { type: "string" }, register: { type: "string" }, speakers: { type: "string" },
    people: { type: "array", items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, role: { type: "string" } }, required: ["name", "role"] } } },
  required: ["kind", "about", "register", "speakers", "people"] } };
function contextPrompt(source) {
  return `You are given what a video site says about a video (title, series and episode, synopsis, channel, description — some may be empty) and a sample of its ${langName(source)} subtitle lines. Return STRICT JSON {"kind":"…","about":"…","register":"…","speakers":"…","people":[{"name":"…","role":"…"}]}: ` +
    `kind = what kind of video this is (interview, vlog, language lesson, news report, documentary, football match commentary, video-game stream, comedy sketch, talk, podcast, drama series episode, film …); ` +
    `about = the topic in one short sentence; register = how people speak (casual/formal, slang, dialect, jokes, technical terms); speakers = who is talking to whom; ` +
    `people = up to 8 named people who speak or matter here (a host, a guest, a reporter, a character) as {name, role} — ONLY names you are sure of from the given data or the lines; [] when unsure. English, ≤ 90 words in total.`;
}
```

- [ ] **Step 3: Write `tmdbLookup` and `ensureDossier`; keep `videoContext` as a thin wrapper**

Replace the whole `videoContext` function and `contextLine` with:

```js
// TMDb: the cast (character — actor, photo), the poster and the episode's own
// title/synopsis. Optional (needs tmdbKey); every failure returns nothing and
// the dossier goes on without it.
async function tmdbLookup(meta, key) {
  const none = { tmdb: null, people: [], poster: "", epTitle: "", synopsis: "" };
  if (!key || !meta) return none;
  const u = SV_TMDB.urls(key);
  const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error("tmdb " + r.status); return r.json(); };
  try {
    const kind = meta.show ? "tv" : "movie", want = meta.show || meta.title; if (!want) return none;
    const hit = SV_TMDB.pickTitle((await get(u.search(kind, want))).results, want, meta.year);
    if (!hit) return { ...none, tmdb: { type: kind, id: 0, matched: false } };
    const people = SV_TMDB.cast(await get(u.credits(kind, hit.id)), 12);
    let ep = { epTitle: "", synopsis: "", guests: [] };
    if (kind === "tv" && meta.season && meta.episode) { try { ep = SV_TMDB.episode(await get(u.episode(hit.id, meta.season, meta.episode))); } catch (e) {} }
    for (const g of ep.guests) if (people.length < 12 && !people.some((p) => p.name === g.name)) people.push(g);
    return { tmdb: { type: kind, id: hit.id, matched: true, title: String(hit.name || hit.title || "") }, people, poster: SV_TMDB.imageUrl(hit.poster_path, "w185"), epTitle: ep.epTitle, synopsis: ep.synopsis };
  } catch (e) { return none; }
}
// The dossier: one file per video — the site's identity, the cast, the model's
// reading, a frozen sample of the lines. Built once (single-flight), kept in
// clipexplain:<base>.dossier; every explanation's prefix is made from it.
const dossierBuilding = new Map(); // base → promise
async function ensureDossier(base, meta, sample, lang) {
  if (!base) return null;
  if (dossierBuilding.has(base)) return dossierBuilding.get(base);
  const run = (async () => {
    const cx = (await idbVocabGet("clipexplain:" + base)) || { base, at: Date.now(), e: {} };
    const m = meta || {};
    const lines = SV_DOSSIER.sampleLines(sample || [], Array.isArray(sample) && sample.length >= 120 ? 300 : 40);
    let d = cx.dossier && cx.dossier.v === 1 ? cx.dossier : null;
    if (d) {
      // The prefix must not drift: only a sample built from too few lines is
      // replaced, once, and only before any e4 explanation was bought on it.
      const bought = Object.keys(cx.e || {}).some((k) => k.startsWith("e4"));
      if (!bought && (d.sample || []).length < 40 && lines.length >= 120) { d.sample = lines; cx.dossier = d; await idbVocabPut("clipexplain:" + base, cx); }
      return d;
    }
    const { tmdbKey } = await chrome.storage.local.get("tmdbKey");
    const t = await tmdbLookup(m, String(tmdbKey || "").trim());
    d = { v: 1, at: Date.now(), site: String(m.site || ""), title: String(m.title || "").slice(0, 160), show: String(m.show || "").slice(0, 120), season: +m.season || 0, episode: +m.episode || 0,
      epTitle: String(m.epTitle || t.epTitle || "").slice(0, 120), year: +m.year || 0, runtimeMin: +m.runtimeMin || 0, synopsis: String(m.synopsis || t.synopsis || "").slice(0, 600),
      channel: String(m.channel || "").slice(0, 80), description: String(m.description || "").slice(0, 1500),
      kind: (cx.ctx && cx.ctx.kind) || "", about: (cx.ctx && cx.ctx.about) || "", register: (cx.ctx && cx.ctx.register) || "", speakers: (cx.ctx && cx.ctx.speakers) || "",
      people: t.people, tmdb: t.tmdb, poster: t.poster, sample: lines, tmdbAt: t.tmdb ? Date.now() : 0 };
    if (!d.kind && (lines.length || d.title || d.show)) {
      try {
        const r = await llmJSON(contextPrompt(lang || "auto"), { title: d.title, show: d.show, season: d.season, episode: d.episode, epTitle: d.epTitle, synopsis: d.synopsis, channel: d.channel, description: d.description.slice(0, 600), lines: lines.slice(0, 40) }, CONTEXT_SCHEMA);
        const p = (r && r.parsed) || {};
        d.kind = String(p.kind || "").trim(); d.about = String(p.about || "").trim(); d.register = String(p.register || "").trim(); d.speakers = String(p.speakers || "").trim();
        if (!d.people.length && Array.isArray(p.people)) d.people = p.people.filter((x) => x && x.name).slice(0, 8).map((x, i) => ({ name: String(x.name).trim().slice(0, 60), character: "", role: String(x.role || "").trim().slice(0, 60), photo: "", order: i, src: "model" }));
        await logCall({ ts: Date.now(), site: "learn", title: "Context: " + (d.show || d.title).slice(0, 40), kind: "enrich", lines: lines.length, ms: 0, inTok: (r.usage && r.usage.prompt_tokens) || 0, outTok: (r.usage && r.usage.completion_tokens) || 0, ok: true, provider: r.provider, model: r.model });
      } catch (e) { /* no provider yet — the dossier still carries the site's data */ }
    }
    if (d.kind) cx.ctx = { kind: d.kind, about: d.about, register: d.register, speakers: d.speakers, at: Date.now() }; // the old field, still read by older code paths
    cx.dossier = d; await idbVocabPut("clipexplain:" + base, cx);
    return d;
  })().finally(() => dossierBuilding.delete(base));
  dossierBuilding.set(base, run);
  return run;
}
// Older callers (Study card): the kind of video, from the dossier.
async function videoContext(base, title, lines, source) {
  const d = await ensureDossier(base, { title }, lines, source);
  return d && d.kind ? { kind: d.kind, about: d.about, register: d.register, speakers: d.speakers } : null;
}
const contextLine = (ctx) => (ctx && ctx.kind ? `VIDEO CONTEXT: ${ctx.kind}${ctx.about ? " — " + ctx.about : ""}${ctx.register ? ". Register: " + ctx.register : ""}${ctx.speakers ? ". Speakers: " + ctx.speakers : ""}. Read the lines in that light (a joke, a chant, a command in a game, an idiom of that world).\n` : "");
```

Note: `contextLine` stays for `studyPrompt` (unchanged); Task 4 replaces its use in `explainPrompt`.

- [ ] **Step 4: Add the two message handlers**

In the message switch, next to `case "TIPS_CACHED"`:

```js
        case "DOSSIER": { // the board asks once per video, before any explanation
          try { const d = await ensureDossier(String(msg.base || ""), msg.meta || {}, Array.isArray(msg.sample) ? msg.sample : [], msg.lang); sendResponse({ ok: !!d, dossier: d || null }); }
          catch (e2) { sendResponse({ ok: false, error: String((e2 && e2.message) || e2) }); }
          break;
        }
        case "TMDB_TEST": { // the popup's Verify for the TMDb key
          try { const r = await fetch(SV_TMDB.urls(String(msg.key || "").trim()).configuration()); sendResponse(r.ok ? { ok: true } : { ok: false, error: r.status === 401 ? "TMDb didn't accept this key" : "TMDb answered " + r.status }); }
          catch (e2) { sendResponse({ ok: false, error: "couldn't reach TMDb" }); }
          break;
        }
```

- [ ] **Step 5: Make `tipsCached` return the dossier**

In `tipsCached`'s return, add `dossier: cx && cx.dossier ? cx.dossier : null` beside `ctx`.

- [ ] **Step 6: Run the suite and load the extension**

Run: `node --test tools/tests/*.test.mjs` → all pass. Reload the unpacked extension in the lab (Task 11 setup) and check the service-worker console has no load error (`chrome://extensions` → service worker → Console).

- [ ] **Step 7: Commit**

```bash
git add background.js manifest.json
git commit -m "Background: the dossier — site identity, TMDb cast, the model's reading, a frozen sample; DOSSIER and TMDB_TEST"
```

---

### Task 4: Background — the cached prefix carries the dossier; explanations name who is there

**Files:**
- Modify: `background.js` — `EXPLAIN_SCHEMA` (~988), `explainPrompt` (~1022), `explainLine` (~1125–1168), the `VOCAB_EXPLAIN` handler (~2852), `shareTips`/`tipsCached` word/tips mapping (add `who`)

**Interfaces:**
- Consumes: `ensureDossier`, `SV_DOSSIER.block`.
- Produces: `explainPrompt(source, target, dossier)`; explanation entries `e4<hash>|<explain>` with `who: string[]`; `VOCAB_EXPLAIN` response `{ …, who }`.

- [ ] **Step 1: Schema and prompt**

Add `who` to `EXPLAIN_SCHEMA`: property `who: { type: "array", items: { type: "string" } }`, and add `"who"` to `required`.

Change `explainPrompt`'s signature to `(source, target, dossier)` and its body: replace `contextLine(ctx) +` with

```js
    (dossier ? SV_DOSSIER.block(dossier) + "Read the passage in that light (a joke, a chant, a command in a game, an idiom of that world). Names in the dossier are the people's real names — use the CHARACTER names for who.\n" : "") +
```

and in the JSON shape line add `"who":["…"]` after `"scene":"…"`, with a new bullet after the `scene` bullet:

```js
    `- who: the characters or speakers present or speaking in THIS passage (0–4), by the dossier's character names when they fit, else a short role ("the doorman", "the host"); [] when unclear.\n` +
```

- [ ] **Step 2: `explainLine` — e4 keys, the dossier prefix, a slim user turn**

Replace, inside `explainLine`:

```js
  const skey = "e4" + (h >>> 0).toString(36) + (explainPref ? "|" + explainPref : ""); // e4: with who, on the dossier prefix
```

and the older-shape fallback:

```js
  // An explanation bought under a previous shape (e3…, e2…) is still an explanation: serve it rather than paying again (it only lacks who / Put simply).
  for (const old of ["e3", "e2"]) { const k = old + (h >>> 0).toString(36) + (explainPref ? "|" + explainPref : ""); if (!(cx.e[skey] && cx.e[skey].tr) && cx.e[k] && cx.e[k].tr && !o.fresh) cx.e[skey] = Object.assign({}, cx.e[k], { explain: explainPref, who: cx.e[k].who || [] }); }
```

In the cached return add `who: Array.isArray(c.who) ? c.who : []`. Replace the `ctx`/`payload`/`llmJSON` lines with:

```js
  // The dossier (identity, cast, kind, a frozen sample) is the cached prefix; the passage and its neighbours are the only per-call bytes.
  const dossier = await ensureDossier(base, { title: o.title }, o.sample, lang || "auto");
  const ctx = dossier && dossier.kind ? { kind: dossier.kind, about: dossier.about, register: dossier.register, speakers: dossier.speakers } : null;
  const payload = { s: sent, before: (o.before || []).slice(-2).map((x) => String(x).slice(0, 300)), after: (o.after || []).slice(0, 1).map((x) => String(x).slice(0, 300)) };
  if (o.k != null && o.n) { payload.k = o.k + 1; payload.n = o.n; }
  const r = await llmJSON(explainPrompt(lang || "auto", target, dossier), payload, EXPLAIN_SCHEMA);
```

In `out` add `who: Array.isArray(p.who) ? p.who.map((x) => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 4) : []`, and in the final return add `who: out.who`.

- [ ] **Step 3: Pass `k`/`n` from the handler; carry `who` through the cached lists**

`VOCAB_EXPLAIN`: add `k: msg.k, n: msg.n` to the opts object. In `tipsCached` and `shareTips`, the entry filters `/^e[23]/` become `/^e[234]/`, e4 preferred over e3 over e2 (extend the "seen" logic: iterate keys sorted so that `e4` wins: build `byText` with a rank `{e4: 3, e3: 2, e2: 1}` and keep the highest). Add `who: e.who || []` to both mapped shapes.

- [ ] **Step 4: Verify by execution**

Run `node --test tools/tests/*.test.mjs` (green). In the lab service-worker console (Task 11 setup), seed a dossier and call the prompt builder:

```js
SV_DOSSIER.block({ show: "X", season: 1, episode: 2, people: [{ name: "A", character: "B" }], sample: ["one", "two"] }).length > 0
```

Expected: `true`; and `explainPrompt("en", "fa", null)` still returns the old shape without a dossier block.

- [ ] **Step 5: Commit**

```bash
git add background.js
git commit -m "Explain: the dossier is the cached prefix, the passage the only per-call bytes; answers name who is in the passage (e4)"
```

---

### Task 5: The sites' identity — `getMeta()` and the `DOSSIER` call

**Files:**
- Modify: `content/page/netflix-seek.js` (MAIN world) — answer `op: "meta"`
- Modify: `content/subs-intercept.js` (MAIN world) — answer `META_REQ` on YouTube
- Modify: `content/adapters/netflix.js`, `content/adapters/youtube.js` — `getMeta()`
- Modify: `content/common.js` — `ensureBoard` sends `DOSSIER`; `explainPayload` sends `k`, `n`

**Interfaces:**
- Produces: `adapter.getMeta()` → `Promise<MetaIn>` (always resolves within 3 s, at worst `{ site, url, title }`); `board.dossier` (a `Dossier`), `setDossier(d)`.

- [ ] **Step 1: Netflix, page world**

In `content/page/netflix-seek.js`, inside the message listener, add before the `try`:

```js
    if (d.op === "meta") { netflixMeta(d.id).then((meta) => window.postMessage({ __sv: "netflix", type: "META", id: d.id, meta }, "*")); return; }
```

and add the helper after `player()`:

```js
  // Netflix's own words about what is playing: the member API's metadata
  // (show, season/episode, titles, synopses); the player's title block is the fallback.
  const netflixMeta = async (id) => {
    const out = { site: "netflix", url: location.href, title: "", show: "", season: 0, episode: 0, epTitle: "", synopsis: "", year: 0, runtimeMin: 0 };
    try {
      const build = window.netflix.reactContext.models.serverDefs.data.BUILD_IDENTIFIER;
      const r = await fetch("/nq/website/memberapi/" + build + "/metadata?movieid=" + encodeURIComponent(id), { credentials: "include" });
      const v = (await r.json()).video || {};
      if (v.type === "show") {
        out.show = v.title || ""; out.year = v.year || 0; out.synopsis = v.synopsis || "";
        for (const s of v.seasons || []) for (const e of s.episodes || []) if (String(e.id) === String(v.currentEpisode || id)) { out.season = s.seq || 0; out.episode = e.seq || 0; out.epTitle = e.title || ""; out.synopsis = e.synopsis || out.synopsis; out.runtimeMin = Math.round((e.runtime || 0) / 60); }
      } else { out.title = v.title || ""; out.year = v.year || 0; out.synopsis = v.synopsis || ""; out.runtimeMin = Math.round((v.runtime || 0) / 60); }
    } catch (e) {}
    if (!out.show && !out.title) { // the player's title block (visible with the controls)
      const t = document.querySelector('[data-uia="video-title"]');
      if (t) { const h = t.querySelector("h4"); const sp = [...t.querySelectorAll("span")].map((x) => x.textContent.trim()).filter(Boolean); if (h) { out.show = h.textContent.trim(); const m = (sp[0] || "").match(/E(\d+)/i); if (m) out.episode = +m[1]; out.epTitle = sp[1] || ""; } else out.title = t.textContent.trim(); }
    }
    return out;
  };
```

- [ ] **Step 2: Netflix adapter**

In `content/adapters/netflix.js`, add to the adapter object:

```js
    // What Netflix says is playing — asked from the page world (cookies, the player API).
    getMeta() {
      const id = adapter.getVideoId();
      return new Promise((resolve) => {
        const done = (meta) => { window.removeEventListener("message", on); clearTimeout(t); resolve(Object.assign({ site: "netflix", url: location.href, title: "" }, meta || {})); };
        const on = (ev) => { if (ev.source === window && ev.data && ev.data.__sv === "netflix" && ev.data.type === "META" && String(ev.data.id) === String(id)) done(ev.data.meta); };
        window.addEventListener("message", on);
        const t = setTimeout(() => done(null), 3000);
        window.postMessage({ __sv: "netflix", op: "meta", id }, "*");
      });
    },
```

- [ ] **Step 3: YouTube, page world + adapter**

In `content/subs-intercept.js`, inside the YouTube branch (near the `SUBS_URL` interval), add:

```js
    // The video's own words (title, channel, description) for the story board's dossier.
    window.addEventListener("message", (ev) => {
      if (ev.source !== window || !ev.data || !ev.data.__copilotSubs || ev.data.type !== "META_REQ") return;
      let meta = null;
      try { const vd = window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails; const v = new URL(location.href).searchParams.get("v"); if (vd && vd.videoId === v) meta = { title: vd.title || "", channel: vd.author || "", description: (vd.shortDescription || "").slice(0, 1500), keywords: (vd.keywords || []).slice(0, 20) }; } catch (e) {}
      window.postMessage({ __copilotSubs: true, type: "META", meta }, "*");
    });
```

In `content/adapters/youtube.js`, add:

```js
    // Title, channel, description — from the page's own data when it is for this video, else the DOM.
    getMeta() {
      const dom = () => ({ site: "youtube", url: location.href, title: (document.querySelector("ytd-watch-metadata h1") || {}).textContent || document.title, channel: adapter.getChannel(),
        description: ((document.querySelector("#description-inline-expander") || {}).innerText || "").slice(0, 1500) });
      return new Promise((resolve) => {
        const done = (m) => { window.removeEventListener("message", on); clearTimeout(t); const d = dom(); resolve(Object.assign(d, m || {}, { site: "youtube", url: location.href, title: (m && m.title) || d.title.trim() })); };
        const on = (ev) => { if (ev.source === window && ev.data && ev.data.__copilotSubs && ev.data.type === "META") done(ev.data.meta); };
        window.addEventListener("message", on);
        const t = setTimeout(() => done(null), 1500);
        window.postMessage({ __copilotSubs: true, type: "META_REQ" }, "*");
      });
    },
```

`SV_TITLE.clean` runs on the content-script side (Step 4), so `dom().title` may still carry "(4)" and " - YouTube" here.

- [ ] **Step 4: The board asks for the dossier once**

In `content/common.js`, in the board state add `dossier: null, dossierAsked: false`. Add next to `setCtx`:

```js
    const setDossier = (d) => {
      if (!d) return; board.dossier = d; if (d.kind) setCtx({ kind: d.kind, about: d.about, register: d.register, speakers: d.speakers });
      // Under the title: "interview · Peak TV · Anna, Tom" (YouTube) or "crime drama series · The Block · S1 E3" (Netflix)
      const el = board.el && board.el.querySelector(".svb-ctx");
      if (el) { const who = (d.people || []).slice(0, 3).map((p) => p.character || p.name).filter(Boolean).join(", "); el.textContent = [d.kind, d.show ? SV_DOSSIER.identityLine(d) : d.channel, who].filter(Boolean).join(" · ").slice(0, 110); el.title = [d.kind, d.about, SV_DOSSIER.identityLine(d), d.channel, d.synopsis || d.description].filter(Boolean).join("\n"); }
      board.sig = "";
    };
    const askDossier = () => {
      if (board.dossierAsked || !adapter) return; board.dossierAsked = true;
      const metaP = adapter.getMeta ? adapter.getMeta() : Promise.resolve({ site: adapter.site, url: location.href, title: SV_TITLE.clean(document.title) });
      metaP.then((meta) => { meta.title = SV_TITLE.clean(meta.title || ""); return send({ type: "DOSSIER", base, meta, sample: sampleLines(), lang: vocabPoolLang }); })
        .then((r) => { if (r && r.ok) setDossier(r.dossier); }).catch(() => {});
    };
```

Change `sampleLines` to use the shared helper: `const sampleLines = () => { const us = sentenceUnits().map((u) => u.original); return globalThis.SV_DOSSIER ? SV_DOSSIER.sampleLines(us, us.length >= 120 ? 300 : 40) : us.slice(0, 40); };` and add `"shared/dossier.js"` to every content-script `js` list in `manifest.json` (after `shared/cues.js`).

In `ensureBoard`, after `applyLinesOff(); seedExplained();` add `askDossier();`. In `seedExplained`'s response handling add `if (r.dossier) setDossier(r.dossier);`. In `explainPayload` add `k: ch.k, n: list.length`. In `explainChunk`'s success mapping add `who: r.who || []` to the `ex` object; in `seedExplained` add `who: e.who || []`.

- [ ] **Step 5: Verify**

Lab (Task 11 setup) on a YouTube watch page: in the page console, `document.documentElement.dataset.svBoard` exists; in the service-worker console run `idbVocabGet("clipexplain:youtube:<id>").then(x => console.log(x.dossier))` → an object with `title`, `channel`, `description`, `sample.length ≥ 1`, `kind` (empty when no provider key in the lab — acceptable; the site data must be there).

- [ ] **Step 6: Commit**

```bash
git add content/page/netflix-seek.js content/subs-intercept.js content/adapters/netflix.js content/adapters/youtube.js content/common.js manifest.json
git commit -m "Board: the site's own identity (Netflix episode, YouTube description) goes into the dossier once per video"
```

---

### Task 6: The tips pump and the "Tips ahead" setting

**Files:**
- Modify: `content/common.js` — board closure (state, `tipsPump`, call from `boardTick`), `getSettings` key list (~128), `LIVE_KEYS`
- Modify: `popup.html` (row after `storyBoard`), `popup.js` (DEFAULTS, hydrate, change handler)

**Interfaces:**
- Produces: `tips` state `{ inflight, k, errors, pausedUntil, all, stopped, lastError }`; `tipsPump(list, ki)`; `tipsStatus()` → `{ readyToMs, doneN, totalN, k, state: "idle"|"busy"|"paused"|"off", reason }` for the strip (Task 8); storage `tipsAhead`.

- [ ] **Step 1: Popup**

`popup.html`, right after the `storyBoard` row:

```html
      <div class="row">
        <label for="tipsAhead">Tips ahead</label>
        <select id="tipsAhead" title="How far the board explains chunks before you reach them — one call at a time, cached ones skipped">
          <option value="off">Off — only when I ask</option>
          <option value="3">Next 3 chunks</option>
          <option value="all">The whole video</option>
        </select>
        <span class="info" title="With Claude (API key) each chunk costs about a cent; on the Claude Code bridge it's on your subscription">i</span>
      </div>
```

`popup.js`: DEFAULTS gains `tipsAhead: "3", tmdbKey: ""`; next to the `storyBoard` change handler add `el("tipsAhead").addEventListener("change", () => persist({ tipsAhead: el("tipsAhead").value }));`; in the hydrate block add `el("tipsAhead").value = ["off", "3", "all"].includes(state.tipsAhead) ? state.tipsAhead : "3";`.

- [ ] **Step 2: Content script — read the setting live**

In `getSettings` add `"tipsAhead", "tmdbKey"` to the key list. Add both to `LIVE_KEYS` so a change does not restart the engine. In the board closure, after the `tipsExplain` loader:

```js
    let tipsAhead = "3";
    try { chrome.storage.local.get("tipsAhead", (r) => { tipsAhead = String((r && r.tipsAhead) || "3"); }); } catch (e) {}
    try { chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.tipsAhead) { tipsAhead = String(ch.tipsAhead.newValue || "3"); tips.stopped = false; tips.errors = 0; tips.pausedUntil = 0; board.sig = ""; } }); } catch (e) {}
```

- [ ] **Step 3: The pump**

After `explainChunk`:

```js
    // Tips ahead: the next chunks after the playhead are always being explained —
    // one call in flight, in order, cached ones skipped — so the prompt cache
    // stays warm and the tips are there when a chunk starts. "Explain all" runs to the end.
    const tips = { inflight: null, k: -1, errors: 0, pausedUntil: 0, all: false, stopped: false, lastError: "" };
    const tipsPump = (list, ki) => {
      if (!globalThis.SV_DOSSIER || tips.inflight || tips.stopped || performance.now() < tips.pausedUntil || !list.length) return;
      const mode = tips.all ? "all" : tipsAhead; if (mode === "off") return;
      if (!engaged && mode !== "all") return; // nothing before the video has played once
      const k = SV_DOSSIER.aheadWindow(ki, list.length, mode === "all" ? Infinity : 3, (j) => lineExplainCache.has(list[j].text));
      if (k < 0) { if (tips.all) tips.all = false; return; }
      tips.k = k;
      tips.inflight = explainChunk(list[k], list).then((ex) => {
        if (!ex || ex.error) { tips.errors++; tips.lastError = (ex && ex.error) || "no explanation"; tips.pausedUntil = performance.now() + 30000; if (tips.errors >= 3) tips.stopped = true; }
        else { tips.errors = 0; tips.lastError = ""; }
      }).catch(() => { tips.errors++; tips.pausedUntil = performance.now() + 30000; if (tips.errors >= 3) tips.stopped = true; })
        .finally(() => { tips.inflight = null; tips.k = -1; board.sig = ""; });
    };
    const tipsStatus = (list, ki) => {
      const doneN = list.filter((ch) => lineExplainCache.has(ch.text)).length;
      let readyTo = -1; for (let j = Math.max(0, ki); j < list.length && lineExplainCache.has(list[j].text); j++) readyTo = j;
      const mode = tips.all ? "all" : tipsAhead;
      return { readyToMs: readyTo >= 0 ? list[readyTo].endMs : 0, doneN, totalN: list.length, k: tips.k, all: tips.all,
        state: mode === "off" ? "off" : tips.stopped ? "stopped" : tips.inflight ? "busy" : performance.now() < tips.pausedUntil ? "paused" : "idle", reason: tips.lastError };
    };
    const tipsAll = (on) => { tips.all = !!on; tips.stopped = false; tips.errors = 0; tips.pausedUntil = 0; board.sig = ""; boardTick(true); };
    const tipsRetry = () => { tips.stopped = false; tips.errors = 0; tips.pausedUntil = 0; board.sig = ""; boardTick(true); };
```

In `boardTick`, after `const ki = …` and before the signature: `if (boardVisible()) tipsPump(list, ki);`. Add `tips.inflight ? 1 : 0` and `tips.stopped ? 1 : 0` and `tips.all ? 1 : 0` to the `sig` array so the UI re-renders when the pump's state changes.

- [ ] **Step 4: Verify**

Lab, YouTube, no provider key: play the video; within a few seconds the service-worker console logs a `VOCAB_EXPLAIN` failure ("No OpenAI API key yet"); after three, `tips.stopped` — check `document.documentElement.dataset.svBoard` (Task 8 adds the pump state to the stamp; for now, confirm via the strip in Task 8 or by adding `tips: tipsStatus(list, ki).state` to the stamp here). With a seeded explanation for chunk `ki` (Task 11's seed), the pump asks chunk `ki+1` next.

Run `node --test tools/tests/*.test.mjs` — `popup-ids` sees `tipsAhead` in the HTML.

- [ ] **Step 5: Commit**

```bash
git add content/common.js popup.html popup.js
git commit -m "Tips ahead: the next 3 chunks are always being explained, one call at a time; Explain all runs to the end"
```

---

### Task 7: The split drawer — compact rows and the tips pane

**Files:**
- Modify: `content/common.js` — `boardRow`, `renderBoard`, `boardFocus`, `boardTick` follow rule, `ensureBoard` (pane element)
- Modify: `styles/overlay.css` — `.svb-pane`, row scene/who chips, drawer flex

**Interfaces:**
- Consumes: `buildTips(ex, ch)`, `buildActions(ctx)`, `SV_DOSSIER.whoFaces/initials`, `board.dossier`.
- Produces: `.svb-pane` DOM (`.svb-ph` header, `.svb-pb` body, `.wt-actions`); `board.pinnedAt`; `renderPane()`.

- [ ] **Step 1: Rows never expand; scene + who chips**

In `boardRow`, replace the `if (k === board.open) { … } else if (ex && !ex.error) … else if (on) …` block with:

```js
      if (ex && !ex.error && (ex.scene || (ex.who && ex.who.length))) { // one line about the scene, and who is in it
        const sc = mk("div", "svb-scene");
        if (ex.scene) { const t = mk("span", "svb-scene-txt", ex.scene); t.dir = explainDir(ex); sc.appendChild(t); }
        for (const f of SV_DOSSIER.whoFaces(ex.who, board.dossier && board.dossier.people)) { const chip = mk("span", "svb-who"); const av = mk("i", null, f.person && f.person.photo ? "" : SV_DOSSIER.initials((f.person && f.person.character) || f.label)); if (f.person && f.person.photo) av.style.backgroundImage = "url(" + f.person.photo + ")"; chip.append(av, document.createTextNode((f.person && f.person.character) || f.label)); chip.title = f.person ? (f.person.character || f.person.name) + (f.person.name && f.person.character ? " — " + f.person.name : "") : f.label; sc.appendChild(chip); }
        main.appendChild(sc);
      }
      if (ex && !ex.error) aside.appendChild(mk("i", "svb-mark", k === board.open ? "▸ tips" : "✓ tips"));
      else if (tips.k === k) aside.appendChild(mk("i", "svb-mark busy", "explaining"));
      else if (on) { const b = mk("button", "svb-explain", "Explain"); b.type = "button"; b.addEventListener("click", (ev) => { ev.stopPropagation(); boardFocus(k, false); }); aside.appendChild(b); }
```

Row click: `if (board.open === k && board.pinnedAt) { board.pinnedAt = 0; board.sig = ""; boardTick(true); } else boardFocus(k, false);` (a second click on the pinned row hands the pane back to the playhead). In `rowSig` add `ex && ex.scene ? ex.scene : ""`, `(ex && ex.who || []).join("|")`, `tips.k === k ? 1 : 0`.

- [ ] **Step 2: The pane**

Add `pinnedAt: 0, paneSig: ""` to `board`. In `ensureBoard`, after `b.appendChild(listEl);`:

```js
      const pane = mk("div", "svb-pane"); pane.appendChild(mk("div", "svb-ph")); pane.appendChild(mk("div", "svb-pb")); b.appendChild(pane);
      for (const evn of ["wheel", "touchstart", "pointerdown"]) pane.addEventListener(evn, () => { board.userScrollAt = performance.now(); }, { passive: true });
```

Add after `renderBoard`:

```js
    // The tips pane: the open chunk's tips in one fixed place — it follows the
    // playhead unless the reader pinned a row (click), and "following ▸" hands it back.
    const renderPane = () => {
      const b = board.el; if (!b) return;
      const pane = b.querySelector(".svb-pane"), head = pane.querySelector(".svb-ph"), body = pane.querySelector(".svb-pb");
      const k = board.open, ch = board.list[k]; const ex = ch ? lineExplainCache.get(ch.text) : null;
      const sig = [k, ch ? ch.text : "", ex ? 1 : 0, ex && ex.error ? ex.error : "", snapChunks, tipsExplain, board.loop, board.pinnedAt ? 1 : 0, tips.k === k ? 1 : 0].join("");
      if (sig === board.paneSig) return; board.paneSig = sig;
      head.textContent = ""; body.textContent = "";
      if (!ch) { head.appendChild(mk("b", null, "Tips")); body.appendChild(mk("div", "wt-val svb-empty", "The tips of the playing chunk appear here.")); return; }
      head.appendChild(mk("b", null, "Tips · " + fmtT(ch.startMs) + " · chunk " + (k + 1) + " / " + board.list.length));
      const fol = mk("button", "svb-follow" + (board.pinnedAt ? "" : " on"), board.pinnedAt ? "follow ▸" : "following ▸"); fol.type = "button"; fol.title = board.pinnedAt ? "Back to the playing chunk" : "The pane follows the video";
      fol.addEventListener("click", (ev) => { ev.stopPropagation(); board.pinnedAt = 0; board.open = board.ki; board.sig = ""; boardTick(true); }); head.appendChild(fol);
      if (!ex) { body.appendChild(mk("div", "wt-val svb-empty", tips.k === k ? "Explaining…" : "Not explained yet.")); if (tips.k !== k) { const b2 = mk("button", "svb-explain", "Explain"); b2.type = "button"; b2.addEventListener("click", () => boardFocus(k, false)); body.appendChild(b2); } return; }
      body.appendChild(buildTips(ex, ch));
      body.appendChild(buildActions({ list: board.list, k0: k, n: snapChunks, setN: (m) => { snapChunks = m; board.sig = ""; boardTick(true); }, anchor: () => els.__orig }));
    };
```

Call `renderPane()` at the end of `renderBoard()` and also right after `renderBoard()` in `boardTick` when the sig did not change but `tips`/`open` did — simplest: call `renderPane()` unconditionally at the end of `boardTick` (it is cheap: it returns on an equal `paneSig`). Remove the inline `buildTips`/`buildActions` from rows (done in Step 1).

`boardFocus(k)`: set `board.pinnedAt = performance.now();` when the click came from the reader (both call sites pass `flash=false`; add a third param `pin` and pass `true` from the row click and the Explain button; `false` from `openLineCard`'s ﹖ path). The `boardTick` follow rule becomes:

```js
      if (ki >= 0 && ki !== board.ki && (!board.pinnedAt || now - board.pinnedAt > 20000)) { board.open = ki; board.pinnedAt = 0; }
```

(replacing the old "open only if explained" rule — the pane shows "Explaining…" until the pump delivers).

- [ ] **Step 3: CSS**

Append to `styles/overlay.css`:

```css
/* ── Split drawer: compact rows over a tips pane that follows the playhead ── */
#sv-board.drawer .svb-list { flex: 1 1 54%; min-height: 120px; }
#sv-board .svb-pane { display: flex; flex-direction: column; min-height: 0; border-top: 2px solid #C93F2B; background: #fff; }
#sv-board.drawer .svb-pane { flex: 0 0 46%; }
#sv-board:not(.drawer) .svb-pane { max-height: min(40vh, 420px); }
#sv-board:not(.drawer) .svb-list { max-height: min(44vh, 460px); }
#sv-board.collapsed .svb-pane { display: none; }
#sv-board .svb-ph { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-bottom: 1px solid #EDE5DA; font: 700 10.5px/1.3 ui-monospace, Menlo, Consolas, monospace; letter-spacing: .06em; text-transform: uppercase; color: #C93F2B; }
#sv-board .svb-follow { margin-left: auto; border: 1px solid #EDE5DA; background: #fff; color: #5B5348; font: 600 10.5px/1.3 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; padding: 2px 8px; border-radius: 999px; cursor: pointer; text-transform: none; letter-spacing: 0; }
#sv-board .svb-follow.on { color: #1F7A6D; background: #E4F2EF; border-color: #E4F2EF; }
#sv-board .svb-pb { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 4px 0 8px; }
#sv-board .svb-pb .wt-body { margin: 0; border-top: 0; overflow: visible; }
#sv-board .svb-pb .wt-actions { margin: 8px 0 0; padding: 8px 12px 2px; }
#sv-board .svb-empty { padding: 10px 12px; color: #8A7F72; }
#sv-board .svb-scene { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin: 4px 0 0 22px; }
#sv-board .svb-scene-txt { font: 500 11.5px/1.4 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #5B5348; background: #F3EDE4; border-radius: 6px; padding: 2px 7px; }
#sv-board .svb-who { display: inline-flex; align-items: center; gap: 4px; font: 600 10.5px/1 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #5B5348; background: #fff; border: 1px solid #EDE5DA; border-radius: 999px; padding: 2px 7px 2px 2px; }
#sv-board .svb-who i { width: 16px; height: 16px; border-radius: 50%; background: #A39684 center / cover no-repeat; color: #fff; font: 700 8px/16px ui-monospace, Menlo, Consolas, monospace; text-align: center; font-style: normal; }
#sv-board .svb-mark.busy { color: #B45309; }
#sv-board .svb-mark.busy::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #B45309; margin-right: 4px; animation: svb-pulse 1.2s ease-in-out infinite; }
@keyframes svb-pulse { 50% { opacity: .25; } }
@media (prefers-reduced-motion: reduce) { #sv-board .svb-mark.busy::before { animation: none; } }
```

- [ ] **Step 4: Verify in the lab (YouTube side column, then forced drawer)**

Lab: on YouTube with the board on, rows show no inline tips; the pane header reads "Tips · 0:xx · chunk k / n" with "following ▸"; clicking a row pins ("follow ▸" appears), a second click on that row or the button unpins. Force drawer mode with `localStorage.setItem("sv-board-drawer","1")` and reload: list over pane at 54/46 %. Seed one explanation (Task 11) → its row shows the scene line and chips, and the pane shows the tips when that chunk plays.

- [ ] **Step 5: Commit**

```bash
git add content/common.js styles/overlay.css
git commit -m "Board: rows stay short (scene line, who's in it); the tips live in a pane that follows the playhead or a pinned row"
```

---

### Task 8: The scene strip under the picture (drawer mode)

**Files:**
- Modify: `content/common.js` — `ensureStrip`, `renderStrip`, `fitPlayer` (bottom inset), `boardTick`, teardown (~853 and ~3024), tools row ("Scene" button)
- Modify: `styles/overlay.css` — `#sv-strip`

**Interfaces:**
- Consumes: `board.dossier`, `tipsStatus`, `tipsAll`, `tipsRetry`, `SV_DOSSIER.identityLine/whoFaces/initials`.
- Produces: `#sv-strip` (fixed, `left: 0; right: <drawer width>px; bottom: 0; height: 112px`), `board.stripHidden` (localStorage `sv-strip-collapsed`).

- [ ] **Step 1: `fitPlayer` gets a bottom inset**

Replace `fitPlayer` with:

```js
    const STRIP_H = 112;
    const stripOn = () => !!(board.el && board.el.classList.contains("drawer") && !board.collapsed && !board.stripHidden && !document.fullscreenElement);
    const fitPlayer = (on) => {
      const w = board.el && board.el.classList.contains("drawer") ? Math.round(board.el.getBoundingClientRect().width) : 0;
      const h = stripOn() ? STRIP_H : 0;
      if (on && w > 0) {
        const el = playerBox(); if (!el) return;
        if (fit.el !== el) { fitPlayer(false); fit.el = el; fit.prev = { right: el.style.right, width: el.style.width, bottom: el.style.bottom, height: el.style.height, transition: el.style.transition }; }
        if (!el.dataset.svFit) { el.dataset.svFit = "1"; el.dataset.svFitRight = fit.prev.right || ""; el.dataset.svFitWidth = fit.prev.width || ""; el.dataset.svFitBottom = fit.prev.bottom || ""; el.dataset.svFitHeight = fit.prev.height || ""; }
        el.style.transition = "right .2s ease, bottom .2s ease"; el.style.right = w + "px"; el.style.width = "auto"; el.style.bottom = h + "px"; el.style.height = h ? "auto" : fit.prev.height; fit.on = true;
      } else if (fit.el) {
        try { fit.el.style.right = fit.prev.right; fit.el.style.width = fit.prev.width; fit.el.style.bottom = fit.prev.bottom; fit.el.style.height = fit.prev.height; fit.el.style.transition = fit.prev.transition; delete fit.el.dataset.svFit; } catch (e) {}
        fit.el = null; fit.prev = null; fit.on = false;
      }
    };
```

Both teardown sites (the two `{ const b = document.getElementById("sv-board"); … }` blocks) restore `bottom`/`height` too and remove `#sv-strip`:

```js
    { const b = document.getElementById("sv-board"); if (b) b.remove(); const s = document.getElementById("sv-strip"); if (s) s.remove(); for (const el of document.querySelectorAll("[data-sv-fit]")) { el.style.right = el.dataset.svFitRight || ""; el.style.width = el.dataset.svFitWidth || ""; el.style.bottom = el.dataset.svFitBottom || ""; el.style.height = el.dataset.svFitHeight || ""; delete el.dataset.svFit; } }
```

- [ ] **Step 2: The strip**

Add `stripHidden: false, stripSig: ""` to `board`; load it with the other localStorage flags: `board.stripHidden = localStorage.getItem("sv-strip-collapsed") === "1";`. Add after `renderPane`:

```js
    // The scene strip under the picture (drawer players): what is playing, what
    // is happening now and who is in it, the cast, and the tips pipeline.
    const ensureStrip = () => {
      if (!stripOn()) { const s = document.getElementById("sv-strip"); if (s) s.remove(); board.stripSig = ""; return null; }
      let s = document.getElementById("sv-strip"); if (s) return s;
      s = mk("div", "sv-strip"); s.id = "sv-strip"; s.dir = "auto";
      s.append(mk("div", "svs-ident"), mk("div", "svs-now"), mk("div", "svs-cast"), mk("div", "svs-pump"));
      document.body.appendChild(s); return s;
    };
    const face = (p, label, big, talk) => {
      const f = mk("span", "svs-face" + (big ? "" : " small") + (talk ? " talk" : ""));
      const av = mk("i", null, p && p.photo ? "" : SV_DOSSIER.initials((p && (p.character || p.name)) || label)); if (p && p.photo) av.style.backgroundImage = "url(" + p.photo + ")";
      f.appendChild(av); f.appendChild(mk("b", null, (p && (p.character || p.name)) || label));
      if (big) f.appendChild(mk("small", null, p ? (p.character ? p.name : p.role || "") : "")); f.title = p ? [p.character, p.name, p.role].filter(Boolean).join(" — ") : label;
      return f;
    };
    const renderStrip = () => {
      const s = ensureStrip(); if (!s) return;
      s.style.right = Math.round(board.el.getBoundingClientRect().width) + "px";
      const d = board.dossier, ch = board.list[board.ki], ex = ch ? lineExplainCache.get(ch.text) : null, st = tipsStatus(board.list, board.ki);
      const sig = [d ? d.at : 0, ch ? ch.text : "", ex ? (ex.scene || "") + (ex.who || []).join("|") : "", st.state, st.doneN, st.readyToMs, st.k, st.all, st.reason].join("");
      if (sig === board.stripSig) return; board.stripSig = sig;
      const ident = s.querySelector(".svs-ident"); ident.textContent = "";
      if (d && d.poster) { const img = mk("img", "svs-poster"); img.src = d.poster; img.alt = ""; ident.appendChild(img); }
      const idb = mk("div", "svs-id"); idb.appendChild(mk("b", null, (d && (d.show || d.title)) || SV_TITLE.clean(document.title)));
      if (d && d.show) idb.appendChild(mk("div", "svs-ep", ["S" + d.season + " · E" + d.episode, d.epTitle, d.runtimeMin ? d.runtimeMin + " min" : ""].filter((x) => x && x !== "S0 · E0").join(" · ")));
      else if (d && d.channel) idb.appendChild(mk("div", "svs-ep", d.channel));
      if (d && (d.synopsis || d.description)) { const sy = mk("div", "svs-syn", d.synopsis || d.description); sy.title = d.synopsis || d.description; idb.appendChild(sy); }
      ident.appendChild(idb);
      const now = s.querySelector(".svs-now"); now.textContent = "";
      const scene = mk("div", "svs-scene", ex && ex.scene ? ex.scene : ex ? "" : ch && tips.k === board.ki ? "Explaining this chunk…" : ""); if (ex) scene.dir = explainDir(ex); now.appendChild(scene);
      const faces = mk("div", "svs-faces"); const who = ex ? SV_DOSSIER.whoFaces(ex.who, d && d.people) : [];
      who.forEach((f, i) => faces.appendChild(face(f.person, f.label, true, i === 0))); now.appendChild(faces);
      const cast = s.querySelector(".svs-cast"); cast.textContent = "";
      const people = (d && d.people) || []; const shown = new Set(who.map((f) => f.person).filter(Boolean));
      if (people.length) { cast.appendChild(mk("div", "svs-lbl", (people[0].src === "tmdb" ? "Cast" : "People (from the model)") + " · " + people.length)); const row = mk("div", "svs-faces"); for (const p of people.filter((p) => !shown.has(p)).slice(0, 8)) row.appendChild(face(p, "", false, false)); cast.appendChild(row); if (people[0].src === "tmdb") cast.appendChild(mk("div", "svs-attr", "Cast & episode data · TMDB")); }
      const pump = s.querySelector(".svs-pump"); pump.textContent = "";
      const lbl = mk("div", "svs-lbl"); lbl.append(mk("span", null, "Tips ahead"), mk("span", null, st.doneN + " of " + st.totalN)); pump.appendChild(lbl);
      const bar = mk("div", "svs-bar"); const done = mk("i"); done.style.width = (st.totalN ? (100 * st.doneN / st.totalN) : 0) + "%"; bar.appendChild(done); if (st.totalN && board.ki >= 0) { const u = mk("u"); u.style.left = (100 * board.ki / st.totalN) + "%"; bar.appendChild(u); } pump.appendChild(bar);
      const txt = st.state === "off" ? "Off — set Tips ahead in the popup" : st.state === "stopped" ? "Tips paused — " + (st.reason || "couldn't explain") : (st.readyToMs ? "Ready to " + fmtT(st.readyToMs) : "Nothing ahead yet") + (st.k >= 0 && board.list[st.k] ? " · explaining " + fmtT(board.list[st.k].startMs) : "");
      pump.appendChild(mk("div", "svs-st", txt));
      const acts = mk("div", "svs-acts");
      if (st.state === "stopped") { const r = mk("button", "svs-btn coral", "Retry"); r.type = "button"; r.addEventListener("click", tipsRetry); acts.appendChild(r); }
      else if (st.all) { const b = mk("button", "svs-btn", "Stop"); b.type = "button"; b.addEventListener("click", () => tipsAll(false)); acts.appendChild(b); }
      else if (st.doneN < st.totalN) { const b = mk("button", "svs-btn coral", "Explain all →"); b.type = "button"; b.title = "Explain every chunk of this video now, one after the other"; b.addEventListener("click", () => tipsAll(true)); acts.appendChild(b); }
      const hide = mk("button", "svs-btn", "Hide"); hide.type = "button"; hide.title = "Hide this strip (the Scene button on the board brings it back)"; hide.addEventListener("click", () => { board.stripHidden = true; try { localStorage.setItem("sv-strip-collapsed", "1"); } catch (e) {} ensureStrip(); fitPlayer(true); board.sig = ""; boardTick(true); }); acts.appendChild(hide);
      pump.appendChild(acts);
    };
```

In `ensureBoard`'s tools row, add a "Scene" button that shows only in drawer mode: `const sceneBtn = mk("button", "svb-scene-btn", "Scene"); sceneBtn.type = "button"; sceneBtn.title = "Show the scene strip under the picture"; sceneBtn.addEventListener("click", () => { board.stripHidden = false; try { localStorage.setItem("sv-strip-collapsed", ""); } catch (e) {} fitPlayer(true); board.sig = ""; boardTick(true); }); if (drawer) tools.append(sceneBtn); board.sceneBtn = sceneBtn;` — and at the top of `renderStrip` (before the early return) `if (board.sceneBtn) board.sceneBtn.hidden = !board.stripHidden;`.

In `boardTick`, after `renderBoard()` (and the new `renderPane()`), call `renderStrip()`; also call `ensureStrip()` in the collapsed/fullscreen early-return path so the strip goes away with the board. The `fitPlayer(!board.collapsed && !document.fullscreenElement)` call stays; it now reads `stripOn()` for the bottom inset.

- [ ] **Step 3: CSS**

Append to `styles/overlay.css`:

```css
/* ── The scene strip under the picture (drawer players) ── */
#sv-strip { position: fixed; left: 0; bottom: 0; height: 112px; z-index: 2147483000; background: #FAF6F0; color: #241F1A; border-top: 1px solid #EDE5DA; box-shadow: 0 -6px 24px rgba(0,0,0,.3); display: grid; grid-template-columns: 290px minmax(0,1fr) auto 236px; font: 12px/1.4 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
#sv-strip * { box-sizing: border-box; }
#sv-strip > div { padding: 9px 14px; min-width: 0; overflow: hidden; border-right: 1px solid #EDE5DA; }
#sv-strip > div:last-child { border-right: 0; }
#sv-strip .svs-ident { display: grid; grid-template-columns: auto 1fr; gap: 10px; }
#sv-strip .svs-poster { width: 58px; height: 88px; border-radius: 6px; object-fit: cover; box-shadow: 0 0 0 1px rgba(36,31,26,.12); }
#sv-strip .svs-id b { display: block; font-size: 14px; font-weight: 800; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#sv-strip .svs-ep { font: 600 10.5px/1.4 ui-monospace, Menlo, Consolas, monospace; color: #C93F2B; margin: 2px 0 3px; }
#sv-strip .svs-syn { color: #5B5348; font-size: 11.5px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
#sv-strip .svs-now { display: grid; grid-template-rows: auto auto; gap: 4px; align-content: start; }
#sv-strip .svs-scene { font: 500 11.5px/1.35 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #241F1A; background: #F3EDE4; border-radius: 6px; padding: 2px 8px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 18px; }
#sv-strip .svs-faces { display: flex; gap: 8px; align-items: flex-start; }
#sv-strip .svs-face { display: grid; justify-items: center; gap: 2px; width: 60px; }
#sv-strip .svs-face i { width: 30px; height: 30px; border-radius: 50%; background: #A39684 center / cover no-repeat; color: #fff; font: 700 11px/30px ui-monospace, Menlo, Consolas, monospace; text-align: center; font-style: normal; box-shadow: 0 0 0 2px #fff, 0 0 0 4px #EDE5DA; }
#sv-strip .svs-face.talk i { box-shadow: 0 0 0 2px #fff, 0 0 0 4px #C93F2B; }
#sv-strip .svs-face b { font-size: 10.5px; line-height: 1.1; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 60px; }
#sv-strip .svs-face small { font: 500 9px/1.1 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #786D60; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 60px; }
#sv-strip .svs-face.small { width: 30px; opacity: .55; }
#sv-strip .svs-face.small i { width: 26px; height: 26px; font-size: 9px; line-height: 26px; }
#sv-strip .svs-face.small b { display: none; }
#sv-strip .svs-lbl { display: flex; justify-content: space-between; font: 700 9.5px/1.3 ui-monospace, Menlo, Consolas, monospace; letter-spacing: .06em; text-transform: uppercase; color: #786D60; margin-bottom: 6px; }
#sv-strip .svs-attr { font: 500 9px/1.3 ui-monospace, Menlo, Consolas, monospace; color: #A39684; margin-top: 8px; letter-spacing: .04em; text-transform: uppercase; }
#sv-strip .svs-bar { height: 6px; border-radius: 999px; background: #EDE5DA; position: relative; margin: 0 0 6px; overflow: hidden; }
#sv-strip .svs-bar i { position: absolute; left: 0; top: 0; bottom: 0; background: #1F7A6D; border-radius: 999px; }
#sv-strip .svs-bar u { position: absolute; top: -3px; bottom: -3px; width: 2px; background: #C93F2B; }
#sv-strip .svs-st { font: 500 11px/1.4 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #5B5348; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#sv-strip .svs-acts { display: flex; gap: 6px; margin-top: 6px; }
#sv-strip .svs-btn { border: 1px solid #EDE5DA; background: #fff; color: #5B5348; font: 600 11px/1.3 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; padding: 3px 8px; border-radius: 6px; cursor: pointer; }
#sv-strip .svs-btn.coral { color: #C93F2B; border-color: #F3D4CD; }
#sv-strip .svs-btn:hover { background: #F3EDE4; }
#sv-board .svb-scene-btn { border: 1px solid #EDE5DA; background: #fff; color: #5B5348; font: 600 11px/1.3 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; padding: 3px 8px; border-radius: 6px; cursor: pointer; }
```

- [ ] **Step 4: Verify in the lab (forced drawer on YouTube)**

With `sv-board-drawer=1`: the strip appears at the bottom, left of the drawer; the player box gets `bottom: 112px` (inspect the element with `data-sv-fit`); Hide removes it and restores the inset; "Scene" on the board brings it back; the pump box shows "Tips paused — …" after three failures with a Retry button. With a seeded dossier containing `people` with `photo` URLs (any https image), faces render as photos; with `photo: ""`, initials.

- [ ] **Step 5: Commit**

```bash
git add content/common.js styles/overlay.css
git commit -m "Scene strip under the picture: the episode, what's happening and who's in it, the cast, tips ahead"
```

---

### Task 9: Popup — the TMDb key row

**Files:**
- Modify: `popup.html` (Keys tab, after the Google section), `popup.js`

- [ ] **Step 1: Markup**

After the Google `keysection`:

```html
      <div class="keysection">
        <div class="keyhead"><span class="keyname"><span id="tmdbKeyDot" class="keydot"></span>TMDb</span> <a id="getTmdbKey" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">Get a free key →</a></div>
        <div class="keyused">used for: cast photos, character names and episode info on the story board — optional</div>
        <div class="keyrow">
          <input type="password" id="tmdbKey" placeholder="TMDb API key (v3)" autocomplete="off" spellcheck="false" />
          <button class="btn ghost" id="verifyTmdb">Verify</button>
        </div>
        <div id="tmdbKeyStatus">Without it the board still shows Netflix's own episode data and names from the model, without photos.</div>
      </div>
```

Add `#tmdbKeyStatus` to the three status-colour selectors in `popup.html`'s `<style>` (the `.ok`/`.err`/`.warn` lines that list `#keyStatus, #anthropicKeyStatus, …`).

- [ ] **Step 2: Behaviour**

`popup.js`, next to the Gemini handlers:

```js
function setTmdbKeyStatus(text, cls) { const s = el("tmdbKeyStatus"); s.textContent = text; s.className = cls || ""; }
let tmdbKeyFailed = false, tmdbKeyT;
const refreshTmdbDot = () => setKeyDot("tmdbKeyDot", el("tmdbKey").value.trim() ? (tmdbKeyFailed ? "red" : "green") : "");
el("tmdbKey").addEventListener("input", () => { clearTimeout(tmdbKeyT); tmdbKeyFailed = false; refreshTmdbDot(); tmdbKeyT = setTimeout(() => persist({ tmdbKey: el("tmdbKey").value.trim() }), 400); });
el("verifyTmdb").addEventListener("click", async () => {
  const key = el("tmdbKey").value.trim(); if (!key) { setTmdbKeyStatus("Paste a TMDb key first.", "warn"); return; }
  setTmdbKeyStatus("Checking…", "");
  const r = await new Promise((res) => chrome.runtime.sendMessage({ type: "TMDB_TEST", key }, res));
  tmdbKeyFailed = !(r && r.ok); refreshTmdbDot();
  setTmdbKeyStatus(r && r.ok ? "TMDb accepted the key — cast photos and episode info will show on the board." : (r && r.error) || "Couldn't reach TMDb", r && r.ok ? "ok" : "err");
});
```

In the hydrate block: `el("tmdbKey").value = state.tmdbKey || ""; refreshTmdbDot();`. Do not add TMDb to `KEY_PROVIDERS` (an empty optional key must not force the Keys panel open).

- [ ] **Step 3: Verify**

`node --test tools/tests/popup-ids.test.mjs` passes. In the lab popup: paste a wrong key → Verify → "TMDb didn't accept this key" in red; clear it → grey dot.

- [ ] **Step 4: Commit**

```bash
git add popup.html popup.js
git commit -m "Popup: an optional TMDb key for cast photos and episode info"
```

---

### Task 10: Share page — who is in each chunk, and an invitation

**Files:**
- Modify: `share.js` (tips box, footer), `share.html` (footer style)

- [ ] **Step 1: `who` under the scene**

In `share.js`, after the `tp.scene` line: `if (tp.who && tp.who.length) { const w = mk("div", "who", "Who: " + tp.who.join(" · ")); w.dir = "auto"; box.appendChild(w); }`. In `background.js` `shareTips`, the tips shape already carries `who` (Task 4 Step 3). Add to `share.html` styles: `.who { font: 600 11px/1.4 ui-monospace, Menlo, Consolas, monospace; color: var(--muted); margin: 2px 0 6px; }`.

- [ ] **Step 2: The footer invites**

Replace the footer line with:

```js
    const foot = mk("footer"); foot.appendChild(document.createTextNode("Made with SubVibe — subtitles, tips and study cards for language learners. "));
    const get = mk("a", "get", "Get SubVibe free →"); get.href = SV_SHARE.STORE_URL; get.target = "_blank"; get.rel = "noopener"; foot.appendChild(get);
    if (rec.dossier && (rec.dossier.people || []).some((p) => p.src === "tmdb")) foot.appendChild(mk("div", "attr", "Cast & episode data · TMDB"));
    wrap.appendChild(foot);
```

`share.html` must load `shared/share.js` before `share.js` (check; add the script tag if missing) and style `footer .get { color: var(--coral-600); font-weight: 700; text-decoration: none; }`. In `background.js` `shareTips`, add `dossier: (cx && cx.dossier) || null` to the record, and in `share.js` show `SV_DOSSIER.identityLine(rec.dossier)` as the page's subtitle when present (load `shared/dossier.js` in `share.html`).

- [ ] **Step 3: Verify**

`node --test tools/tests/share*.test.mjs` green. Lab: Share ↗ from the board opens the page; the footer link points at the store; a downloaded copy keeps the link (it is inline HTML).

- [ ] **Step 4: Commit**

```bash
git add share.js share.html background.js
git commit -m "Share page: who is in each chunk, the episode's identity, and a link to get SubVibe"
```

---

### Task 11: Verification — lab run and the Netflix playtest list

**Files:** none (evidence goes into the PR description and `build/shots/`).

- [ ] **Step 1: Lab setup**

```bash
CFT="$HOME/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
S=/private/tmp/claude-501/-Users-novid-claude-subvibe/82b487ce-af23-4db6-83e6-7d705e9d379d/scratchpad
nohup "$CFT" --user-data-dir="$S/lab-cft" --remote-debugging-port=9333 --load-extension=/Users/novid/claude/subvibe --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required "https://www.youtube.com/watch?v=uzNrP5ZyH0A" >/dev/null 2>&1 &
```

Drive it over CDP (`http://127.0.0.1:9333/json`); reload the extension from its service worker (`chrome.runtime.reload()`), reload the page for content scripts. Seed an explanation for chunk k by calling, in the service-worker console, `idbVocabPut("clipexplain:<base>", cx)` with `cx.e["e4<hash>"] = { s: <chunk text>, tr: "…", simple: "…", g: "«a» — b", scene: "two people talk", who: ["Host"], words: [], explain: "", at: Date.now() }` (the key is `"e4" + (h >>> 0).toString(36)` with `let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;` over the chunk text — the same loop as `explainLine`), and a `cx.dossier` with two `people` (one with an https `photo`).

- [ ] **Step 2: Checks (all must pass; screenshot each to `build/shots/`)**

1. `node --test tools/tests/*.test.mjs` → previous count + 12 new, all pass.
2. YouTube side column: list over pane; pane follows; pin/unpin; the identity line under the title shows the channel/kind.
3. Forced drawer (`sv-board-drawer=1`): 54/46 split; `#sv-strip` at the bottom, left of the drawer; the player box has `bottom: 112px`; Hide/Scene toggle; strip gone in fullscreen and when the board is collapsed.
4. Pump: with no key, three failures → "Tips paused — …" + Retry; with seeded chunk k, the pump asks k+1 next (service-worker console shows the `VOCAB_EXPLAIN` with `k`, `n`).
5. Seeded dossier: faces with a photo and with initials; `who` chips on the seeded row; the strip's Now box lights the first face.
6. Share ↗ → the page shows "Who:" and the store link.

- [ ] **Step 3: Netflix — the operator's playtest (cannot run in the lab: no Netflix session, no bridge)**

Hand the operator this list in the PR description:

1. Open an episode; the strip shows the show, S/E, episode title and Netflix's synopsis (if not: open DevTools → Console; report what `netflix.reactContext.models.serverDefs.data.BUILD_IDENTIFIER` prints, and whether `[data-uia="video-title"]` exists while the controls are visible).
2. With a TMDb key pasted and verified: faces with photos, character names, the "Cast & episode data · TMDB" line.
3. Activity (popup): the second and later "Explain:" rows show cache reads (`cacheR > 0` in the log row; the popup's Activity list shows the token columns).
4. The picture keeps its size when the strip appears (compare `document.querySelector("video").getBoundingClientRect()` with the strip hidden and shown).
5. Explain all → counts up; Stop stops; a reload keeps the marks.

- [ ] **Step 4: PR**

`git push -u origin board-dossier`; open the PR with the checks above, the screenshots, and the Netflix list. Title: "Story board dossier: the scene strip, the tips pane, TMDb cast, one cached prompt, tips ahead".
