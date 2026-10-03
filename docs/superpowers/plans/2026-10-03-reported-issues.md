# Reported issues (2026-10-03) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix what the operator and the store review reported on 2026-10-03: the board can't be dismissed, tips cost more than people expect and repeat themselves, the board leads with translation instead of tips, Live Translate lags the picture, and the first-run wizard ends on "paste an API key".

**Architecture:** Six phases, each shippable on its own. Phase 1 (tips stop repeating, cost made visible) is spelled out task by task here. Phases 2–5 each touch a different subsystem (board layout, live audio, dub, onboarding/billing) and get their own detailed plan when they start; this file fixes their scope, order and acceptance checks so nothing reported gets lost.

**Tech Stack:** Chrome MV3 extension, plain JS (no bundler), `node:test` for pure logic in `shared/*.js`, playwright Chrome for Testing lab on port 9333 for in-page checks.

## Global Constraints

- Commits authored as `Novid <support@nimanou.com>`; no Co-Authored-By or "generated with" lines (operator house rule overrides the harness).
- Version line stays `1330.x` (father tribute); never renumber.
- Pure logic goes in `shared/*.js` attached to `globalThis` so content scripts, the background worker and `node:test` share it (see `shared/dossier.js`). `shared/dossier.js` is already loaded by every content script (manifest) and by the background (`importScripts`, background.js:14; Firefox list in build.sh:63), so new helpers go there to avoid touching 7 manifest entries.
- Existing paid explanations must never be thrown away: any cache-key change keeps reading the old key (pattern: background.js e3/e2 → e4 migration loop).
- Lab browser: playwright's Chrome for Testing with `--load-extension`, never the operator's installed Brave/Chrome, never their tabs on 9222.
- UI copy follows the writing voice in ~/.claude/CLAUDE.md; teach words through the original's own words, no translation glosses on the board.
- Test command: `node --test tools/tests/*.test.mjs` (276 passing at 0d58bba).
- Agent-readiness review 2026-10-03 (separate reader agent): Tasks 0 and 2 ready as written; Tasks 1, 3, 4, 5 corrected in place from its findings.

## Reported issues → where each is handled

| # | Reported | Phase | State |
|---|---|---|---|
| 1 | No way to turn the story board off from the board itself | 0 | Built in 0d58bba (× in the header), not yet seen in a browser, not pushed |
| 2 | Story board spends money people don't expect | 0, 1 | Tips ahead default flipped to Off in 0d58bba; Phase 1 adds the price on Explain all |
| 3 | Same scene sentence shown twice per chunk (row + "What's happening" pane) | 1 | Task 4 |
| 4 | Every chunk pays for a fresh scene sentence, even when nothing changed (songs: 228× "the singer tells the beloved…") | 1 | Tasks 2, 3 |
| 5 | Chorus lines paid again (">> I'm lost without you." ≠ "I'm lost without you.") | 1 | Task 1 |
| 6 | Same words re-explained in every chunk ("away" in drift away / fade away) | 1 | Task 3 |
| 7 | "the singer" / "the vocalist" flip between chunks | 1 | Task 3 (previous who sent as context) |
| 8 | Board repeats the translation already on the video; tips are hidden behind footnote numbers; six colours per chunk | 2 | Own plan |
| 9 | Board design doesn't feel like something to connect with | 2 | Own plan; needs the operator's answer on the feel (lyrics sheet / script / notebook) |
| 10 | On-video subtitle in pastel rainbow on a light pill is hard to read | 2 | Own plan, last task |
| 11 | Store review (Pierre Denis, 2026-10-01): Live Translate lags the video, no sync adjustment | 3 | Own plan |
| 12 | Same review: cue-based mode for films | 4 | Own plan |
| 13 | First-run wizard ends on "bring your own key"; individual Claude subscriptions are off the table | 5 | Decision gate, then own plan |
| 14 | Claude Code bridge must not be offered to store users (Anthropic terms, 2026-02-20) | 5 | Task 5.1 |

---

## Phase 0 — Land what's already built

### Task 0: See the × and the tips-off default work, then push

**Files:** none changed (verification only), unless the check fails.

- [ ] **Step 1: Reload the unpacked extension in the lab browser and open a YouTube video whose captions load** (the 2026-10-03 lab run got empty `timedtext` bodies for arj7oStGLkU without a logged-in profile; use the operator's own reload on their Brave if the lab can't get captions, and say which one was used).
- [ ] **Step 2: Check, in this order:** the board shows a × right of Hide; clicking it removes the board and, on a drawer site (Netflix), gives the player its full width back; `chrome.storage.local.get("storyBoard")` → `{storyBoard:false}`; reloading the page shows no board; the popup's "Story board beside the video" switch is off and turning it on brings the board back without a page reload.
- [ ] **Step 3: Check tips-off:** with a fresh profile, play 2 minutes with the board open; the Activity log (Library → Activity) shows no `Explain:` rows and no `So far:` rows. One `Context:` row (the dossier) is expected.
- [ ] **Step 4: Push main**

```bash
git push origin main
```

---

## Phase 1 — Tips stop repeating, and their cost is shown

### Task 1: One cache key for the same words

Chunks that differ only in `>>`, speaker dashes, case, spacing or trailing punctuation share one explanation.

**Files:**
- Modify: `shared/dossier.js` (add `tipKey`)
- Modify: `content/common.js:1811` (the cache map normalises its keys)
- Modify: `background.js` `explainLine` (hash the normalised text, read the old raw-text key as fallback)
- Test: `tools/tests/dossier.test.mjs`

**Interfaces:**
- Produces: `SV_DOSSIER.tipKey(text: string) → string`

- [ ] **Step 1: Write the failing test** (append to `tools/tests/dossier.test.mjs`)

```js
test("tipKey: speaker marks, case, spacing and end punctuation don't make a new chunk", () => {
  const k = D.tipKey;
  assert.equal(k(">> I'm lost without you."), k("I'm lost without you"));
  assert.equal(k("- I'm   lost\nwithout you!"), k("i'm lost without you"));
  assert.equal(k("[Music] I'm lost without you…"), k("I'm lost without you"));
  assert.notEqual(k("I'm lost without you tonight."), k("I'm lost without you."));
  assert.equal(k(""), "");
  assert.equal(k("Ça va? — Oui."), k("ça va? — oui"));
  // ch.text is the chunk's sentences joined by " " (content/common.js:2055), so a mark can sit mid-chunk
  assert.equal(k(">> Stay with me. >> I'm lost without you."), k("Stay with me. I'm lost without you"));
  assert.equal(k("&gt;&gt; Stay with me."), k("Stay with me"));
});
```

- [ ] **Step 2: Run it, expect FAIL** — `node --test tools/tests/dossier.test.mjs` → `TypeError: D.tipKey is not a function`.

- [ ] **Step 3: Implement** in `shared/dossier.js`, next to the other exported helpers on `SV_DOSSIER`:

```js
  // The cache key of a chunk's tips: the same words with a ">>" speaker mark,
  // a leading dash, [Music]-style tags, other spacing, case or end punctuation
  // are the same chunk — a chorus is explained (and paid for) once.
  const tipKey = (text) => String(text || "")
    .replace(/\[[^\]]{1,30}\]|\([A-Z ]{2,30}\)/g, " ")
    .replace(/(^|\s)(>>|&gt;&gt;|»)+\s*/g, " ")   // speaker marks anywhere (the board shows ">>" mid-chunk on the 2026-10-03 mix)
    .replace(/(^|\n)\s*[-–—]\s+/g, "$1")          // a leading dialogue dash
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.!…,;:]+$/u, "")
    .toLocaleLowerCase();
```

and add `tipKey` to the object assigned to `g.SV_DOSSIER`.

- [ ] **Step 4: Run it, expect PASS** — `node --test tools/tests/dossier.test.mjs`.

- [ ] **Step 5: Content side.** Replace `content/common.js:1811`

```js
    const lineExplainCache = new Map();   // sentence → { tr, g, words } (the ﹖ line-explain)
```

with

```js
    // sentence → { tr, g, words } (the ﹖ line-explain). Keyed by SV_DOSSIER.tipKey, so
    // ">> I'm lost without you." and "I'm lost without you" are one entry (one payment).
    const lineExplainCache = new (class extends Map {
      get(k) { return super.get(SV_DOSSIER.tipKey(k)); }
      has(k) { return super.has(SV_DOSSIER.tipKey(k)); }
      set(k, v) { return super.set(SV_DOSSIER.tipKey(k), v); }
      delete(k) { return super.delete(SV_DOSSIER.tipKey(k)); }
    })();
```

Only inside `explainChunk` (common.js ~2117; other `chunkFetching` uses at 2105 `.clear()` stay as they are) key `chunkFetching` the same way so two near-identical chunks in flight share one request: replace every `chunkFetching.has(ch.text)`, `.set(ch.text`, `.get(ch.text)`, `.delete(ch.text)` inside `explainChunk` with `tk` where `const tk = SV_DOSSIER.tipKey(ch.text);` is declared at its top.

- [ ] **Step 6: Background side.** In `explainLine` (background.js ~1288) hash `SV_DOSSIER.tipKey(sent)` instead of `sent`, and add the raw-text hash to the fallback loop so tips bought before this change are still served:

```js
  const hashOf = (t) => { let x = 5381; for (let i = 0; i < t.length; i++) x = ((x << 5) + x + t.charCodeAt(i)) | 0; return (x >>> 0).toString(36); };
  const h = hashOf(SV_DOSSIER.tipKey(sent)), hRaw = hashOf(sent);
  const explainPref = String(o.explain || "").trim();
  const suf = explainPref ? "|" + explainPref : "";
  const skey = "e4" + h + suf;
  // ...
  for (const k of ["e4" + hRaw + suf, "e3" + hRaw + suf, "e2" + hRaw + suf]) { if (!(cx.e[skey] && cx.e[skey].tr) && cx.e[k] && cx.e[k].tr && !o.fresh) cx.e[skey] = Object.assign({}, cx.e[k], { explain: explainPref, who: cx.e[k].who || [] }); }
```

This replaces the old `let h` hash loop and the `for (const old of ["e3", "e2"])` loop at background.js:1303.

- [ ] **Step 6b: Readers of the stored record.** The share page and Study look explanations up by text (background.js ~1480 `byText` and ~1503 `best`). Key both maps by `SV_DOSSIER.tipKey(e.s)` and look up with `SV_DOSSIER.tipKey(text)`, so a repeated chorus chunk finds the tips bought under its first spelling. The `/^e[234]/` filters stay as they are (the prefix is still `e4`).

- [ ] **Step 7: Run all tests** — `node --test tools/tests/*.test.mjs` → all pass; `node --check content/common.js background.js`.

- [ ] **Step 8: Commit**

```bash
git add shared/dossier.js content/common.js background.js tools/tests/dossier.test.mjs
git commit -m "A chorus is explained once: chunks that differ only in >>, dashes, case or end punctuation share their tips"
```

### Task 2: Music gets no scene line

**Files:**
- Modify: `shared/dossier.js` (add `isMusic`)
- Modify: `background.js` `explainPrompt` (~1150)
- Test: `tools/tests/dossier.test.mjs`

**Interfaces:**
- Produces: `SV_DOSSIER.isMusic(dossier: object|null) → boolean`

- [ ] **Step 1: Failing test**

```js
test("isMusic: songs and DJ sets, not films about music", () => {
  assert.equal(D.isMusic({ kind: "Music mix (deep house DJ set with vocal tracks)" }), true);
  assert.equal(D.isMusic({ kind: "music video" }), true);
  assert.equal(D.isMusic({ kind: "song lyrics video" }), true);
  assert.equal(D.isMusic({ kind: "crime drama series", about: "a band on tour" }), false);
  assert.equal(D.isMusic({ kind: "documentary about a music festival" }), false);
  assert.equal(D.isMusic(null), false);
});
```

- [ ] **Step 2: Run, expect FAIL** (`D.isMusic is not a function`).

- [ ] **Step 3: Implement** in `shared/dossier.js` and export it:

```js
  // A song or a mix: nothing "happens" from chunk to chunk, so no scene line is asked for.
  const isMusic = (d) => !!(d && /^\s*(music|song|lyric|dj|mix|playlist|album|track|karaoke|concert)\b/i.test(String(d.kind || "")));
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Prompt.** In `explainPrompt(source, target, dossier)` replace the `- scene:` line with a conditional:

```js
    (SV_DOSSIER.isMusic(dossier)
      ? `- scene: always "" (this is music; the lines are lyrics).\n`
      : `- scene: what happens and what is said in THIS passage, in ${fa ? "Persian" : langName(target)}: one plain sentence of at most 25 words — who speaks to whom, about what, and the mood (joking, serious, angry, selling, teaching…). Say the point of what they say, not just the mood. If "prevScene" in the user message already says it (same people, same situation, same mood), return "".\n`) +
```

(The `prevScene` clause is filled by Task 3; it is harmless before then.)

- [ ] **Step 6: Run all tests, `node --check background.js`, commit**

```bash
git add shared/dossier.js background.js tools/tests/dossier.test.mjs
git commit -m "Songs and mixes get no scene line, and a scene that hasn't changed comes back empty"
```

### Task 3: Each call knows the previous scene, who's speaking, and the words already taught

**Files:**
- Modify: `shared/dossier.js` (add `knownWords`)
- Modify: `content/common.js` `explainPayload` (~2084)
- Modify: `background.js` `explainLine` payload (~1313) and `explainPrompt` `who` and `words` lines
- Test: `tools/tests/dossier.test.mjs`

**Interfaces:**
- Consumes: `SV_DOSSIER.tipKey` (Task 1)
- Produces: `SV_DOSSIER.knownWords(explanations: Array<{words?:Array<{w:string}>}>, max: number) → string[]` (lower-cased, de-duplicated, most recent last, at most `max`); payload fields `prevScene: string`, `prevWho: string[]`, `known: string[]`

- [ ] **Step 1: Failing test**

```js
test("knownWords: every word already explained on this video, once, newest kept", () => {
  const ex = [{ words: [{ w: "drift away" }, { w: "City lights" }] }, { words: [{ w: "fade away" }, { w: "city lights" }] }, {}];
  assert.deepEqual(D.knownWords(ex, 10), ["drift away", "fade away", "city lights"]);
  assert.deepEqual(D.knownWords(ex, 2), ["fade away", "city lights"]);
  assert.deepEqual(D.knownWords([], 5), []);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** in `shared/dossier.js` and export:

```js
  // The words this video's tips have already taught, so the next call can skip them.
  const knownWords = (exs, max) => {
    const seen = new Map();
    for (const e of exs || []) for (const x of (e && e.words) || []) { const w = String(x && x.w || "").trim().toLowerCase(); if (!w) continue; seen.delete(w); seen.set(w, 1); }
    const all = [...seen.keys()];
    return all.slice(Math.max(0, all.length - max));
  };
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Content payload.** In `explainPayload(ch, list)` add, after `after:`:

```js
      // What the board already knows, so the model says only what's new:
      // the nearest earlier scene and speakers, and the words already taught.
      ...(() => { for (let j = ch.k - 1; j >= 0 && j >= ch.k - 6; j--) { const e = list[j] && lineExplainCache.get(list[j].text); if (e && !e.error) return { prevScene: e.scene || "", prevWho: e.who || [] }; } return { prevScene: "", prevWho: [] }; })(),
      known: SV_DOSSIER.knownWords(list.slice(0, ch.k).map((c) => lineExplainCache.get(c.text)).filter(Boolean), 60),
```

- [ ] **Step 6: Background payload.** In `explainLine`, after `if (o.k != null && o.n) …`:

```js
  if (o.prevScene) payload.prevScene = String(o.prevScene).slice(0, 240);
  if (Array.isArray(o.prevWho) && o.prevWho.length) payload.prevWho = o.prevWho.slice(0, 4).map((x) => String(x).slice(0, 60));
  if (Array.isArray(o.known) && o.known.length) payload.known = o.known.slice(-60).map((x) => String(x).slice(0, 40));
```

These go in the user message only; the system prompt (dossier prefix) stays byte-stable so prompt caching keeps working.

- [ ] **Step 6b: Pass the fields through.** The `VOCAB_EXPLAIN` handler (background.js ~3220) builds `explainLine`'s options field by field; add `prevScene: msg.prevScene, prevWho: msg.prevWho, known: msg.known` to that object, or the new fields never reach the prompt.

- [ ] **Step 7: Prompt.** In `explainPrompt`, append to the end of the template line that starts with `` `- who: `` (search for it; don't trust line numbers): ` When "prevWho" names the same person, reuse that exact name.` Append to the end of the line that starts with `` `- words: ``: ` Skip any word or phrase listed in "known" (already taught on this video); if that leaves fewer than 3, return fewer.` Update the user-message description at the top of the prompt to list the new optional keys: `{"s":…,"before":[…],"after":[…],"prevScene":"…","prevWho":[…],"known":[…]}` — "context only, never explain them".

- [ ] **Step 8: Check the saving is real.** In the lab, explain the same 10 chunks of a song twice: once on main before this task (Activity log: note `outTok` per `Explain:` row), once after. Record both medians in the commit message. Expected: output tokens fall; if they don't, say so in the commit and keep the change only if the tips still read well.

- [ ] **Step 9: Run all tests, check syntax, commit**

```bash
git add shared/dossier.js content/common.js background.js tools/tests/dossier.test.mjs
git commit -m "Each tip call carries the previous scene, the speaker names and the words already taught, so it says only what's new"
```

### Task 4: The scene is shown once, and only when it changes

**Files:**
- Modify: `content/common.js` `buildTips` (~2312), its two callers (2497 on-video card, 2796 board pane), and the row scene block in `boardRow` (~2694)

- [ ] **Step 1: `buildTips(ex, ch, opts)`** — wrap the "What's happening" section: `if (ex.scene && !(opts && opts.noScene)) { … }`.
- [ ] **Step 2: Board pane caller (2796)** → `buildTips(ex, ch, { noScene: true })`; the row already shows it. The on-video ﹖ card (2497) keeps the scene: there is no row there.
- [ ] **Step 3: Row.** In `boardRow(ch, k)`, show `ex.scene` only when it differs from the nearest earlier explained chunk's scene:

```js
      const prevEx = (() => { for (let j = k - 1; j >= 0 && j >= k - 6; j--) { const e = board.list[j] && lineExplainCache.get(board.list[j].text); if (e && !e.error) return e; } return null; })();
      const sceneNew = ex && ex.scene && !(prevEx && SV_DOSSIER.tipKey(prevEx.scene) === SV_DOSSIER.tipKey(ex.scene));
```

and use `sceneNew` instead of `ex.scene` in the condition and the text node. The `who` chips follow the same rule: hidden when `prevEx.who` lists the same names. `rowSig` (content/common.js:2678, one long line) already lists the row's own scene and who; add `sceneNew` as one more array element, computed with the same `prevEx` lookup inside `rowSig`, so the row re-renders when its neighbour's tips arrive.
- [ ] **Step 4: Lab check** on a song and on a Netflix episode: no chunk shows the same scene line as the one above it; the pane has no "What's happening"; the ﹖ card on the video still does. Screenshot both into the commit's PR notes.
- [ ] **Step 5: Run all tests, commit**

```bash
git add content/common.js
git commit -m "The scene line is shown once, in the row, and only when it changes"
```

### Task 5: Explain all shows its price first

**Files:**
- Modify: `background.js` (new message `TIPS_ESTIMATE`, beside `VOCAB_EXPLAIN` at ~3215)
- Modify: `content/common.js` Explain all button (~2985)
- Modify: `shared/pricing.js` (add `avgCost`)
- Test: `tools/tests/pricing.test.mjs`

**Interfaces:**
- Produces: `SV_PRICING.avgCost(records: Array<log rec>, prefix: string, last: number) → number|null`; message `{type:"TIPS_ESTIMATE", n}` → `{ok:true, usd:number|null, provider:string}`

- [ ] **Step 1: Failing test** (append to `tools/tests/pricing.test.mjs`)

```js
test("avgCost: mean of the last N matching calls, null when there are none", () => {
  const P = globalThis.SV_PRICING;
  const rec = (t, inTok, outTok) => ({ title: t, provider: "openai", inTok, outTok });
  const log = [rec("Explain: a", 1e6, 0), rec("Word: x", 9e6, 9e6), rec("Explain: b", 0, 1e6)];
  assert.equal(P.avgCost(log, "Explain:", 20), (0.15 + 0.60) / 2);
  assert.equal(P.avgCost(log, "Explain:", 1), 0.60);
  assert.equal(P.avgCost([], "Explain:", 20), null);
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** in `shared/pricing.js` and export on `SV_PRICING`:

```js
  const avgCost = (recs, prefix, last) => {
    const hits = (recs || []).filter((r) => r && String(r.title || "").startsWith(prefix) && r.ok !== false).slice(-last);
    return hits.length ? hits.reduce((s, r) => s + estCost(r), 0) / hits.length : null;
  };
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Background handler** next to `case "VOCAB_EXPLAIN"`:

```js
        case "TIPS_ESTIMATE": {
          const cur = await chrome.storage.local.get([CALL_LOG_KEY, "translationProvider"]);
          // Logged rows carry providerOf()'s name (background.js:861), which can differ from the popup's setting — normalise both the same way.
          const want = providerOf(cur.translationProvider || "openai");
          const log = (cur[CALL_LOG_KEY] || []).filter((r) => providerOf(r.provider) === want);
          const each = SV_PRICING.avgCost(log, "Explain:", 20);
          sendResponse({ ok: true, usd: each == null ? null : each * Math.max(0, msg.n | 0), provider: cur.translationProvider || "openai" });
          break;
        }
```

(`claude-cli` rows cost 0 by `estCost`, so the bridge shows "$0.00"; that's correct for the operator's own machine.)
- [ ] **Step 6: Button.** Where the board builds `Explain all →` (~2985), ask for the estimate for the chunks still missing (`n - st.doneN`) and write it into the label: `Explain all · ~$0.42 →`; under 1 cent → `Explain all · <$0.01 →`; `usd === null` → keep `Explain all →` with title "The price shows after the first tip on this provider". Cache the answer per `board` for 60 s so the pump's re-renders don't spam the worker.
- [ ] **Step 7: Lab check:** explain 3 chunks by hand, then the button shows a price; the Activity log's spend after Explain all is within ±50% of that price (record both numbers).
- [ ] **Step 8: Run all tests, commit**

```bash
git add shared/pricing.js background.js content/common.js tools/tests/pricing.test.mjs
git commit -m "Explain all shows what it will cost, from this provider's own recent tip calls"
```

### Phase 1 close

- [ ] Verifier pass (separate agent) over the Phase 1 diff: tests green, no old cache keys dropped, prompt prefix byte-stable (`SV_DOSSIER.block` unchanged).
- [ ] Merge to main by fast-forward, delete the branch, push.

---

## Phase 2 — Tips-first board (own plan: `2026-10-xx-tips-first-board.md`)

**Blocked on:** the operator's answer to "what should the board feel like" (lyrics sheet / script / notebook / other). Run the frontend-quality loop: 2–3 directions as one published HTML page with real chunks from the deep-house mix and a Netflix episode, then build the chosen one.

Scope fixed now:
- The board stops repeating the translation that's on the video: the per-sentence translation line is hidden while on-video subtitles are on ("Subtitles: on video"), shown when the operator chose "Subtitles: board only".
- A tip sits under its own line, next to its word: `leads back to · always returns to the same place or person`. No superscript numbers, no separate pane for word notes. At most 3 tips per chunk, the most learnable first.
- One accent colour, only on words that carry a tip; CEFR colours move out of the board (still in Study).
- "Put simply" shows only when the line is hard (model flags it, or the retelling differs from the line by more than a threshold to be fixed in the plan); never on plain lyrics.
- A chunk without tips is quiet: the line and a small `explain` link. Timestamps and counters drop the heavy monospace.
- Last task: the on-video subtitle goes back to plain readable text by default (word colours become opt-in), contrast checked against ux-golden-rules (4.5:1).

Acceptance: screenshot loop on YouTube (song + talk) and Netflix; critique score per frontend-quality; the operator's yes on the published page before code.

## Phase 3 — Live Translate sync (own plan: `2026-10-xx-live-sync.md`)

Answers the store review (2026-10-01). Gemini 3.5 Live Translate runs ~2.9 s behind by design (no newer translate model as of the 2026-09-22 changelog), so the fix is ours:
- A "Sync" control in the Live panel: delays the original tab audio we play under the translation (add a `DelayNode` between `pSrc` and `pGain` in the passthrough built at `offscreen-live.js` ~282; there is none yet) by 0–5 s, default "auto" = the measured lag (time from a speech chunk sent to its first translated audio, median of the session).
- Optional "hold the picture": when the translated queue runs more than N s behind, pause the video for the difference at the next sentence gap; off by default.
- Acceptance: on a talk with clear sentences, the measured lag shows in the panel and the translated voice lines up with the original audio within ±300 ms after 30 s.
- Then reply to the review from the store dashboard (operator's account): what changed, which version.

## Phase 4 — Film mode, cue-based dub (own plan: `2026-10-xx-film-mode.md`)

- Revive the hidden "Dub subtitles aloud" path (`popup.html:976-989`, `content/dub.js`) as "Film mode" for videos that have subtitles: translate ahead, synthesize a few cues ahead, start each clip at its cue time.
- Move TTS from `gemini-2.5-flash-preview-tts` to `gemini-3.8-flash-tts` (GA 2026-09-22; $9/M audio tokens ≈ $0.0135 per spoken minute through 2026-12-31, doubling 2027-01-01). Update `shared/pricing.js` and `shared/voices.js` together (they hold the same constant).
- Quality work: pass the speaker and mood the tips already know into the TTS style prompt; one voice per character (`dubMultiVoice`); a line longer than its slot is spoken faster up to 1.25×, then trimmed to the next cue.
- Cost shown up front: "≈ $0.80 for this film" from the subtitle file's spoken duration × the per-minute price, before Start.
- Acceptance: operator ear test on one film scene and one YouTube talk; sync error under 200 ms at cue starts.

## Phase 5 — First run without an API key (decision gate, then own plan)

- **5.1 (no decision needed):** the store listing (`tools/store-listing.md`), the welcome page and the popup stop presenting "Claude Code on this Mac" to store users; it stays reachable for the operator's own build. Reason: Anthropic's terms (2026-02-20) forbid routing Free/Pro/Max credentials through another product.
- **5.2 (decision, money, one-way-ish):** hosted credits: sign in, a few free minutes, then buy credits through Stripe; a small SubVibe server holds the provider keys and meters usage. "Use your own key" stays as the advanced path. The operator decides: whether to do it, the free allowance, the price per hour, and where the server runs. No code before that answer.
- Acceptance once decided: a new user goes from install to a translated video in under 60 s without leaving the wizard.

## Phase 6 — Release

- Build `1330.6.0` (Chrome + Firefox zips; build.sh must exclude `build/`), GitHub release with zips attached; store dashboard upload is the operator's step.
