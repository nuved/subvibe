// SubVibe — vocabulary inbox extraction + enrichment merge (pure logic,
// node-testable; globalThis pattern). Load shared/stopwords.js first.
(function (g) {
  // Unicode-aware tokenizer: letter runs incl. umlauts/ß, keeping in-word
  // apostrophes, hyphens AND the Persian ZWNJ joiner ("geht's", "U-Bahn",
  // "می‌شه" stays ONE token). Numbers never tokenize.
  function tokenize(text) {
    return String(text || "").match(/\p{L}+(?:['’‌-]\p{L}+)*/gu) || [];
  }

  // One clip's sentences → inbox words: unique non-stopword words with a seen
  // count and the FIRST sentence they appeared in (plus that sentence's cached
  // translation). `dismissed`/`known` are Sets of lowercased words to skip —
  // tombstoned words and words already in the trainer never re-inbox.
  // The engine translates whole sentence GROUPS: several consecutive cues share
  // ONE translation, while each cue's `o` is only its fragment. Rebuild the
  // pairs: consecutive entries with the same non-empty translation merge into
  // one sentence (fragments joined), so original and translation always match.
  function mergeCueSentences(list) {
    const out = [];
    for (const s of list || []) {
      const prev = out[out.length - 1];
      if (prev && s.t && prev.t === s.t) prev.o = (prev.o + " " + s.o).replace(/\s+/g, " ").trim();
      else out.push({ o: s.o, t: s.t });
    }
    return out;
  }

  // maxSamples > 1 additionally collects up to that many DISTINCT sentences
  // per word into `samples: [{o, st}]` (the first one stays in sentence/st) —
  // the popup's word-detail view shows real context beyond one line. The inbox
  // build keeps the default 1 so 15k-word inbox rows stay light.
  function extractInboxWords(sentences, lang, dismissed, known, maxSamples) {
    const stop = g.SV_STOPWORDS.set(lang);
    const extra = Math.max(0, (maxSamples || 1) - 1);
    const seen = new Map(); // lowercased → entry
    for (const s of sentences || []) {
      // Bracketed non-speech tags ([musik], [applaus]) are annotations, not
      // vocabulary — a song's [musik] tag repeated 400× is not a word to learn.
      for (const w of tokenize(String(s.o).replace(/\[[^\]]*\]/g, " "))) {
        const lw = w.toLowerCase();
        if (lw.length < 2 || stop.has(lw)) continue;
        if ((dismissed && dismissed.has(lw)) || (known && known.has(lw))) continue;
        const e = seen.get(lw);
        if (e) {
          e.n++;
          if (extra && e.samples.length < extra && s.o !== e.sentence && !e.samples.some((x) => x.o === s.o)) {
            e.samples.push({ o: s.o, st: s.t || "" });
          }
        } else {
          const entry = { w, n: 1, sentence: s.o, st: s.t || "" };
          if (extra) entry.samples = [];
          seen.set(lw, entry);
        }
      }
    }
    return [...seen.values()].sort((a, b) => b.n - a.n);
  }

  // Enrichment merge: response entries (aligned to the request order) onto the
  // cards. Short/missing entries back-fill pos:"other", cefr:"?" so the word
  // reads visibly un-enriched and STAYS enrichable. Enum garbage is sanitized —
  // corrupted model output can never plant an unknown pos/art/cefr in storage.
  function mergeEnrichment(cards, entries) {
    const POS = new Set(["noun", "verb", "adj", "adv", "phrase", "other"]);
    const CEFR = new Set(["A1", "A2", "B1", "B2", "C1", "C2"]);
    const val = (v) => (typeof v === "string" && v.trim() && v.trim() !== "-" ? v.trim() : null);
    return (cards || []).map((card, i) => {
      const e = (entries || [])[i];
      if (!e || typeof e !== "object") return { ...card, pos: "other", cefr: "?" };
      return {
        ...card,
        lemma: val(e.lemma) || card.word,
        pos: POS.has(e.pos) ? e.pos : "other",
        art: /^(der|die|das)$/i.test((e.art || "").trim()) ? e.art.trim().toLowerCase() : null,
        plural: val(e.plural),
        cefr: CEFR.has(e.cefr) ? e.cefr : "?",
        meaning: val(e.meaning) || "",
        phrase: val(e.phrase) || "",
        note: val(e.note),
      };
    });
  }

  // Choose which cached track row feeds a clip's inbox. Only rows translated
  // into one of the user's TARGET languages qualify — the trainer's sentence
  // translations must be in a language the user actually reads; a clip cached
  // only in some other language is out of scope. Preference: primary target
  // first, then the row with the most original text. A `tg: null` row is a
  // stream row (one row, all targets inside each cue's `t` map) — it qualifies
  // when any cue carries any configured target.
  // Returns { row, tg, o } (o = count of cues with original text; the caller
  // treats o === 0 as "in scope but no original sentences"), or null when the
  // clip has no track in a configured target.
  function pickClipTrack(rows, targets) {
    const prim = (targets || [])[0];
    const has = new Set(targets || []);
    const withOrig = (r) => (r.cues || []).filter((c) => c.o || c.original).length;
    const resolveTg = (r) => r.tg || (targets || []).find((tg) => (r.cues || []).some((c) => c.t && c.t[tg])) || null;
    const cand = (rows || [])
      .map((r) => ({ row: r, tg: resolveTg(r), o: withOrig(r) }))
      .filter((x) => x.tg && has.has(x.tg));
    if (!cand.length) return null;
    const usable = cand.filter((x) => x.o > 0);
    if (!usable.length) return cand[0]; // caller counts this clip as noOrig
    usable.sort((a, b) => (b.tg === prim) - (a.tg === prim) || b.o - a.o);
    return usable[0];
  }

  g.SV_VOCAB = { tokenize, mergeCueSentences, extractInboxWords, mergeEnrichment, pickClipTrack };
})(globalThis);
