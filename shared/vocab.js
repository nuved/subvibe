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
      else out.push({ o: s.o, t: s.t, ms: s.ms }); // ms = the merged sentence's START — the jump-to point
    }
    return out;
  }

  // Persian text hygiene: models drift into Urdu/Arabic codepoints (ہ ھ ے ي ك)
  // that render as foreign glyphs in Iranian Farsi. Map them to the standard
  // Persian letters. (Wrong WORDS — e.g. Urdu «ہے» — are the prompt's job;
  // this fixes the characters.)
  const FA_FIX = { "ہ": "ه", "ھ": "ه", "ے": "ی", "ي": "ی", "ك": "ک", "ۂ": "هٔ", "ۃ": "ه" };
  function normalizeFa(s) {
    return String(s || "").replace(/[ہھےيكۂۃ]/g, (c) => FA_FIX[c] || c);
  }

  // Model output that SHOULD be JSON but arrived wrapped: markdown fences,
  // a prose preamble, a trailing note. Try verbatim first, then the outermost
  // {...} slice. Returns the parsed object or throws.
  function parseLooseJSON(text) {
    const t = String(text || "").trim();
    try { return JSON.parse(t); } catch {}
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("no JSON object found");
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
            e.samples.push({ o: s.o, st: s.t || "", ms: s.ms });
          }
        } else {
          const entry = { w, n: 1, sentence: s.o, st: s.t || "", ms: s.ms }; // ms → jump the video to the word
          if (extra) entry.samples = [];
          seen.set(lw, entry);
        }
      }
    }
    return [...seen.values()].sort((a, b) => b.n - a.n);
  }

  // Learnability ranking for a clip's word pool. Raw frequency favors filler
  // ("going", "bit" top every interview); content words are LONGER and only
  // mildly helped by repetition. Length carries DOUBLE weight so a short
  // frequent word can never outrank a long rare one ("bit" ×40 = 11,
  // "fallible" ×1 = 17). Transparent and local. Returns a NEW sorted array.
  function rankLearnable(entries) {
    const score = (e) => 2 * Math.min(String(e.w).length, 12) + Math.min(e.n || 1, 5);
    return (entries || []).slice().sort((a, b) => score(b) - score(a) || b.n - a.n || String(a.w).localeCompare(String(b.w)));
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
        para: val(e.para),
        sep: e.sep === true ? true : false,
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

  // Append one save-context to a card's capped `contexts` list (the cross-video
  // history: every video a word was saved from, with that video's sentence).
  // Deduped by base+sentence; keeps the most recent `cap` (default 6) so a heavy
  // learner's IndexedDB never bloats. Returns a NEW array; never mutates input.
  function appendContext(contexts, ctx, cap) {
    const CAP = cap || 6;
    const list = Array.isArray(contexts) ? contexts.slice() : [];
    if (!ctx || !ctx.sentence) return list.slice(-CAP);
    if (list.some((c) => c.base === ctx.base && c.sentence === ctx.sentence)) return list.slice(-CAP);
    list.push(ctx);
    return list.slice(-CAP);
  }

  // Cross-video sightings: for each pool word, how many OTHER videos' inboxes
  // already contain it (the "seen N× before" signal) plus a few of those
  // sentences (the "other videos" accordion). Reads the inbox rows the worker
  // already owns — no new store. Annotates each word with `seenCount` (distinct
  // other videos) and `seen: [{base, videoTitle, sentence, st, ms}]` (capped),
  // and returns the same array. Matching is by surface form (inflected forms
  // across videos don't merge — a deliberate v1 simplification).
  function crossVideoSightings(words, inboxRows, currentBase, cap) {
    const CAP = cap || 3;
    const byWord = new Map(); // lowercased surface → [sighting]
    for (const row of inboxRows || []) {
      if (!row || row.base === currentBase) continue; // only OTHER videos
      for (const w of row.words || []) {
        const lw = String(w.w || "").toLowerCase();
        if (!lw) continue;
        let arr = byWord.get(lw);
        if (!arr) { arr = []; byWord.set(lw, arr); }
        arr.push({ base: row.base, videoTitle: row.videoTitle || "", sentence: w.sentence || "", st: w.st || "", ms: w.ms || 0 });
      }
    }
    for (const w of words || []) {
      const arr = byWord.get(String(w.w || "").toLowerCase()) || [];
      w.seenCount = arr.length;   // distinct OTHER videos this word appeared in
      w.seen = arr.slice(0, CAP); // a few example contexts for the accordion
    }
    return words;
  }

  // Parse chrome.i18n.detectLanguage's result into a base language code, or null
  // when detection is unreliable, undetermined, or low-confidence (< 60%). Kept
  // pure + node-testable; the chrome.i18n call itself is a thin shell.
  function pickI18nLang(res) {
    const top = res && res.isReliable && Array.isArray(res.languages) && res.languages[0];
    if (!top || !top.language || top.language === "und") return null;
    if (typeof top.percentage === "number" && top.percentage < 60) return null;
    return top.language.split("-")[0].toLowerCase();
  }

  g.SV_VOCAB = { tokenize, mergeCueSentences, parseLooseJSON, normalizeFa, extractInboxWords, rankLearnable, mergeEnrichment, pickClipTrack, appendContext, crossVideoSightings, pickI18nLang };
})(globalThis);
