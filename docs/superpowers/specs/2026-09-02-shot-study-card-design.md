# Shot — the Study card (grammar hints on the bilingual card)

Date: 2026-09-02 · Status: built (branch `shot-study-card`) from the operator's
ask during the Shot playtest; mock approved by default-plus-veto:
https://claude.ai/code/artifact/5b341743-34da-4cbc-b2bf-e7b0f0033677

## Ask, in the operator's words

More hints for the German side: the character of each word (noun, adjective,
verb), gender with **different colours** for masculine / feminine, dative and
accusative, verbs that have two parts, numbers attached to each thing with the
grammar explained; and when the original is German, the hints in the same
German with paragraphing, simpler words, the meaning and a summary of each
part, "to give confidence to people having less knowledge of that language".

## Shape

A fourth **Reading card** layout, **Study**, next to Blocks · Pairs · Columns.
Two controls appear with it:

- **Grammar of**: Translation · Original (labelled with the two languages).
  Default: the language set as "I'm learning" in the popup if it is one of the
  two, else the translation.
- **Explain in**: your language · the same language. Default: your language
  (the popup's primary language) when studying the translation; the same
  language (immersion) when studying the original.

The card, per sentence of the studied side:

1. The sentence with marks. Nouns and the article / pronoun / adjective that
   agree with them are coloured by gender (blue der, red die, green das: the
   textbook convention) on a light tint; both parts of a two-part verb
   (auxiliary + participle, modal + infinitive, separable prefix + stem,
   verb + zu + infinitive) get a dotted coral underline; small coral numbers
   after a word point to the notes. Colour never encodes case; case is
   explained in the notes.
2. The meaning: the other side of the pair, verbatim (never generated).
3. "Einfacher gesagt": the sentence said more simply, always in the studied
   language, in a soft box.
4. Numbered notes (3–7): the term as it appears, then what the form is and why,
   in the explanation language.

Per block, a summary box ("Kurz gesagt" / "خلاصه" / "In short") in the
explanation language. A legend at the top shows only the marks that occur.
Labels follow the explanation language (de / fa / en; English fallback), the
simpler-version label follows the studied language.

## Data

`rec.study[side + ":" + lang + "|" + explain]` =
`{ side, lang, explain, ts, provider, model, count, truncated, blocks: [{ b, summary,
sentences: [{ text, meaning, simple, tokens: [{ w, g: ""|m|f|n, v: 0|group, n: [note numbers] }],
notes: [{ n, term, text }] }] }] }`.

One analysis per shot/side/explanation language, on first look, through the
engine and model set in the popup (so Claude Code on this Mac works — the
schema goes through `--json-schema`). Sentences come from the pairs
(`S.studySentences`, capped at 30 with `truncated`), batched ~10 per call
(`llmJSON` + `STUDY_SCHEMA`), the model's output made safe by
`S.buildStudy` (invalid gender dropped, note numbers kept only when the note
exists, a skipped sentence falls back to plain tokens). Activity rows: kind
`study`.

## Rendering

`drawStudyCard` in `shot.js`: two passes (layout ops, then paint) on the
same paper as the pairs card. Tokens wrap as units (word + superscript); a
right-to-left studied language lays each line out from the right edge; notes
are runs (bold term + regular text) wrapped together, placed from the right
for a right-to-left explanation language. Every text line feeds
`biLineBoxes`, so the text-highlight tool snaps to lines on this card too.
Frame, background and badge are shared with the other cards; export uses the
same renderer.

## Verification

- `tools/tests/shot.test.mjs`: `studySentences` (side, meaning, cap,
  numbering), `buildStudy` (defensive merge), `studyMarks`.
- Harness: a seeded analysis renders the card (legend, rows, textmark
  available); an un-analysed side asks background, the stub refuses, the
  warning shows and the pairs card stays usable.
- Real run in the operator's Brave on the tweet Shot through Claude Code.

## Not doing

- Word-level hover cards on the canvas (a picture, not a page).
- Other languages' specifics beyond what the prompt carries (gender for
  French/Spanish, cases for Russian come out of the same schema; the legend
  adapts). Persian-specific marks (ezafe, verb prefixes) are a follow-up.
- Storing the analysis outside the shot (no Leitner hookup yet).
