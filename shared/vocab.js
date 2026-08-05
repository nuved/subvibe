// SubVibe — vocabulary inbox extraction + enrichment merge (pure logic,
// node-testable; globalThis pattern). Load shared/stopwords.js first.
(function (g) {
  // Unicode-aware tokenizer: letter runs incl. umlauts/ß, keeping in-word
  // apostrophes and hyphens ("geht's", "U-Bahn"). Numbers never tokenize.
  function tokenize(text) {
    return String(text || "").match(/\p{L}+(?:['’-]\p{L}+)*/gu) || [];
  }

  // One clip's sentences → inbox words: unique non-stopword words with a seen
  // count and the FIRST sentence they appeared in (plus that sentence's cached
  // translation). `dismissed`/`known` are Sets of lowercased words to skip —
  // tombstoned words and words already in the trainer never re-inbox.
  function extractInboxWords(sentences, lang, dismissed, known) {
    const stop = g.SV_STOPWORDS.set(lang);
    const seen = new Map(); // lowercased → entry
    for (const s of sentences || []) {
      for (const w of tokenize(s.o)) {
        const lw = w.toLowerCase();
        if (lw.length < 2 || stop.has(lw)) continue;
        if ((dismissed && dismissed.has(lw)) || (known && known.has(lw))) continue;
        const e = seen.get(lw);
        if (e) e.n++;
        else seen.set(lw, { w, n: 1, sentence: s.o, st: s.t || "" });
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

  g.SV_VOCAB = { tokenize, extractInboxWords, mergeEnrichment };
})(globalThis);
