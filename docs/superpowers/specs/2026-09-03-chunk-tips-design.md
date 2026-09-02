# Chunk tips — the passage as the unit of learning

Date: 2026-09-03. Branch `chunk-tips`. Follows the overlay tips work (`2026-09-02-*`).

## Why

On the video overlay the ﹖ card explained one line. Lines are YouTube's
windows or our re-cut sentences; either way a learner got a grammar note and a
word list for a fragment, and asking for the next line repeated half of it.
The operator asked for a bigger minimum unit ("our chunk"), tips shown once
at the start of each chunk, a way to pick how many chunks a snap or a clip
covers without cutting one in the middle, word notes that carry the level,
the part of speech and the verb forms (regular or irregular), the surrounding
subtitles as context, the video's kind (interview, lesson, match, game) known
to the model, and everything cached so repeated tips cost nothing.

## What a chunk is

`SV_CUES.chunkCues(units, {maxSents 4, maxChars 300})` in `shared/cues.js`
cuts an ordered list of sentence units into passages:

- a cut at a silence of at least max(1.5 s, 2.5 × the median gap between
  units), so a speaker who pauses a lot still gets whole thoughts;
- a cut after four sentences, or before a sentence that would push the passage
  past 300 characters;
- a chunk's end never runs past the next chunk's start (overlapping ASR
  windows), so a trim cut at a chunk end lands where the next begins.

Units are sentences: on the overlay the groups that partition the cues
(`cue.grp`), in the clip editor consecutive cues sharing one translation
(the group translation is stamped on every window of the sentence). ASR stage
tags (`[Music]`, `[Applause]`) are dropped from chunk text.

## The ﹖ card (content/common.js)

Pressing ﹖ explains the chunk that holds the current line: the card lists the
chunk's sentences with numbers, a "CHUNK k / n" label, Translation, Grammar
(bullets), Words. Each word row shows `term`, then `pos · level` in a small
label, the meaning, and the forms line ("sit · sat · sat · irregular",
"das Modell · die Modelle").

`VOCAB_EXPLAIN` carries `s` (the passage), `before` and `after` (the
neighbouring chunks, context only), `title`, and `sample` (40 lines spread
over the whole video). The background caches explanations per passage in
`clipexplain:<base>` (`e2…` keys; the old `e1…` line entries stay readable by
the tips sheet).

The actions row has a `1 · 2 · 3` selector next to "Frame + this chunk".
Snapping N chunks explains the following chunks on the way (each cached),
then sends `TIPS_SNAP {frame, lineRect, chunks:[{s, tr, g, words, lang,
sentences:[{s, tr}]}]}`. The record has one block per chunk (pairs per
sentence) and a v2 study entry (`tipsSheet`), so the Study card shows the
chunk's sentences numbered, then the chunk's grammar box and its notes.

## Video context (background.js)

`videoContext(base, title, sample, lang)` asks the model once per video what
kind of video this is (`kind`, `about`, `register`, `speakers`) from the title
and the sampled lines, caches it as `ctx` in `clipexplain:<base>`, and
`contextLine(ctx)` is prepended to the explain and study prompts: "VIDEO
CONTEXT: football match commentary — … Read the lines in that light (a joke,
a chant, a command in a game, an idiom of that world)". A web-page Study card
has no video and gets no context line.

## Study analysis v2

`STUDY_SCHEMA` and `studyPrompt` are block-level: `{blocks:[{b, grammar,
simple, notes:[{n, term, pos, level, forms, text}], sentences:[{i,
tokens:[{w, g, v, n, p}]}]}]}`. Tips are given once per chunk; tokens carry
`p`, the word's character (`n v aux adj adv prep conj pron art num int
part`). `SV_SHOT.buildStudy(input, out, lang)` validates it; `normalizeStudy`
turns a stored v1 analysis (tips per sentence) into one block per sentence, so
old records still render. Records store `v: 2`.

`shot.js` `layoutStudy`: inside a chunk each sentence gets a coral number in
a 22 px gutter; when any token has `p`, its character is drawn in a small
mono label under the word; after the chunk's sentences come the grammar box,
the simpler version and the notes ("term  ·  pos · level — text", forms
underneath). Slides paginate at the same break points as before.

## Clip editor

`clip.html` loads `shared/cues.js`. The Trim group gains "Chunks 1 · 2 · 3":
trim to that many whole chunks from the in-point (150 ms lead, 300 ms tail).
"Tips for this clip" sends one entry per chunk the trim range touches, with
the clip's lines as the context sample, and opens the sheet ("CLIP · TIPS").

## Verification

- `node --test tools/tests/*.test.mjs` — 219 pass (chunkCues boundaries,
  buildStudy v2, normalizeStudy, tipsSheet v2 with chunk sentences).
- Harness `tools/tests/shot-harness/harness.html` — PASS 22/22 (its v1 seed
  renders through `normalizeStudy`).
- Brave, via the CDP driver: the ﹖ card on youtube.com/watch?v=uzNrP5ZyH0A
  showed "chunk 1 / 36" with 4 numbered sentences, Persian grammar bullets and
  six words with pos · level · forms; "Frame + 2 chunks" opened a snap whose
  Study card had both chunks, numbered sentences, one grammar box and notes
  per chunk (`build/shots/brave-chunk-card.png`, `brave-chunk-snap.png`).
  The clip editor found 2 chunks in an 8 s recording, trimmed to both, and
  "Tips for this clip" opened a two-chunk sheet (`brave-clip-chunk-sheet.png`).

## Not done

- The painted "Translated" view of a multi-chunk snap stacks the extra
  chunks above the line's rectangle; it has no real place for them on the
  frame — the Study card is the deliverable there.
- The context inference costs one extra model call per video the first time
  a chunk is explained; the ﹖ card does not show it yet.
