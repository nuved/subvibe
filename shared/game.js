// Pure session engine for the word game. No DOM, no chrome.* — node-tested.
// Selection: genuinely due reviews first (leitner order), then NEW cards up
// to the day's remaining allowance. Mastered (box 5) cards never enter
// rounds — finished words rest (spec's calm rule); "know it" and a fifth
// correct answer both land there.
(function (g) {
  const ORDER = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };

  function status(card) {
    if (!card.lastGradedAt) return "new";
    return (card.box || 1) >= 5 ? "mastered" : "learning";
  }

  function isSep(card) {
    return card.sep === true || /\|/.test(card.lemma || "");
  }

  // Enrichment is optional and paid — real decks mix enriched cards with
  // meaning-null ones. A round needs a meaning to quiz on (it's the correct
  // option), so unenriched cards never become session candidates.
  function isEnriched(card) {
    return !!(card.meaning && String(card.meaning).trim());
  }

  function matchesScope(card, scope) {
    const s = scope || {};
    if (s.source) {
      if (s.source.startsWith("base:") && card.base !== s.source.slice(5)) return false;
      if (s.source.startsWith("channel:") && card.channel !== s.source.slice(8)) return false;
    }
    if (s.minLevel) {
      const lv = ORDER[card.cefr] || 0;
      if (!lv || lv < ORDER[s.minLevel]) return false;
    }
    if (s.pos) {
      if (s.pos === "sep") { if (!isSep(card)) return false; }
      else if ((card.pos || "other") !== s.pos) return false;
    }
    return true;
  }

  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function buildSession({ cards, scope, perDay, introducedToday, now, rng, size = 10 }) {
    const inScope = (cards || []).filter((c) => matchesScope(c, scope) && isEnriched(c));
    const due = g.SV_LEITNER.sessionOrder(
      g.SV_LEITNER.dueCards(inScope.filter((c) => status(c) === "learning"), now));
    const allowance = Math.max(0, (perDay || 20) - (introducedToday || 0));
    const fresh = shuffle(inScope.filter((c) => status(c) === "new"), rng);
    const items = due.slice(0, size);
    const newCount = Math.min(allowance, Math.max(0, size - items.length), fresh.length);
    items.push(...fresh.slice(0, newCount));
    return { items, newCount };
  }

  function distractors(card, pool, rng, n = 3) {
    const seen = new Set([card.meaning]);
    const pick = (list, out) => {
      for (const c of shuffle(list, rng)) {
        if (out.length >= n) break;
        const m = (c.meaning || "").trim();
        if (m && !seen.has(m)) { seen.add(m); out.push(m); }
      }
      return out;
    };
    const out = pick(pool.filter((c) => c !== card && c.pos === card.pos), []);
    return pick(pool.filter((c) => c !== card), out);
  }

  // Strips leading/trailing punctuation so "auf." and "Kino," compare equal
  // to their bare word, without disturbing internal characters (umlauts, ß).
  function cleanToken(tok) {
    return String(tok || "").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  }

  function sentenceTokens(card) {
    const s = card && card.sentence;
    if (!s || typeof s !== "string") return null;
    const tokens = s.trim().split(/\s+/).filter(Boolean);
    return tokens.length ? tokens : null;
  }

  // Playable range: too short has no order to scramble, too long is a slog.
  function builderTokens(card) {
    const tokens = sentenceTokens(card);
    if (!tokens || tokens.length < 3 || tokens.length > 12) return null;
    return tokens;
  }

  function builderFor(card, rng) {
    const tokens = builderTokens(card);
    if (!tokens) return null;
    // solution.join(" ") happens to rebuild THIS sentence because tokenization is
    // whitespace-only — that's not a general reconstruction guarantee, so judge
    // correctness against `solution` itself, not against re-joining working in general.
    return { solution: tokens, chips: shuffle(tokens, rng) };
  }

  // Tokens with their exact start offset in the source string, so a match can be
  // sliced back out losslessly (original spacing/casing) instead of rejoined.
  function indexedTokens(sentence) {
    if (!sentence || typeof sentence !== "string") return null;
    const out = [];
    for (const m of sentence.matchAll(/\S+/g)) out.push({ text: m[0], index: m.index });
    return out.length ? out : null;
  }

  // Blanks the ONE occurrence of card.art sitting directly before the noun it
  // declines. Two-pass candidate selection: an exact match on card.word always
  // wins over a compound that merely CONTAINS the stem (e.g. "der Freundeskreis"
  // must never be picked over "der Freund" for word "Freund") — stem tolerance is
  // only a fallback for declined/compound forms when no exact form is present at
  // all. First candidate wins within either pass when a sentence has more than one.
  function gapFor(card) {
    if (!card || !/^(der|die|das)$/i.test(card.art || "")) return null;
    const toks = indexedTokens(card.sentence);
    if (!toks) return null;
    const art = String(card.art).toLowerCase();
    const lemmaOrWord = String(card.lemma || card.word || "");
    if (!lemmaOrWord) return null;
    const wordExact = String(card.word || "").toLowerCase();
    const stem = (lemmaOrWord.length > 3 ? lemmaOrWord.slice(0, -1) : lemmaOrWord).toLowerCase();

    const candidates = [];
    for (let i = 0; i < toks.length - 1; i++) {
      if (cleanToken(toks[i].text).toLowerCase() !== art) continue;
      const noun = cleanToken(toks[i + 1].text);
      if (!noun || !/^\p{Lu}/u.test(noun)) continue;
      candidates.push({ tok: toks[i], noun: noun.toLowerCase() });
    }
    let hit = wordExact && candidates.find((c) => c.noun === wordExact);
    if (!hit) hit = candidates.find((c) => c.noun.includes(stem));
    if (!hit) return null;

    const sentence = card.sentence;
    const start = hit.tok.index;
    const end = start + hit.tok.text.length;
    return {
      before: sentence.slice(0, start),
      after: sentence.slice(end),
      options: ["der", "die", "das"],
      correct: art,
    };
  }

  // Separable verbs: the prefix rides at the end of the clause, so we hunt
  // for it there first — the German word order the card is teaching.
  function findFor(card) {
    if (!card) return null;
    const tokens = sentenceTokens(card);
    if (!tokens) return null;
    if (isSep(card)) {
      const lemma = String(card.lemma || "");
      if (!lemma.includes("|")) return null; // sep flagged but no usable prefix — bail conservatively
      const prefix = lemma.split("|")[0].trim();
      if (!prefix) return null;
      let answerIndex = -1;
      for (let i = 0; i < tokens.length; i++) {
        if (cleanToken(tokens[i]).toLowerCase() === prefix.toLowerCase()) answerIndex = i; // last wins
      }
      return answerIndex === -1 ? null : { tokens, answerIndex, ask: "prefix" };
    }
    if (card.pos === "verb" && card.word) {
      const idx = tokens.findIndex((t) => cleanToken(t).toLowerCase() === String(card.word).toLowerCase());
      if (idx !== -1) return { tokens, answerIndex: idx, ask: "verb" };
    }
    return null;
  }

  function kindsFor(card) {
    const kinds = ["word"];
    if (builderTokens(card)) kinds.push("builder");
    if (gapFor(card)) kinds.push("gap");
    if (findFor(card)) kinds.push("find");
    return kinds;
  }

  function pickKind(card, gameMode, rng) {
    const sentenceKinds = kindsFor(card).filter((k) => k !== "word");
    if (gameMode === "words") return "word";
    if (gameMode === "sentences") {
      if (!sentenceKinds.length) return "word";
      return sentenceKinds[Math.floor(rng() * sentenceKinds.length)];
    }
    // mixed (default): ~40% word, the rest split across supported sentence kinds
    if (!sentenceKinds.length) return "word";
    if (rng() < 0.4) return "word";
    return sentenceKinds[Math.floor(rng() * sentenceKinds.length)];
  }

  function builderHint(card) {
    return card && isSep(card)
      ? "Separable verbs: the prefix moves to the very end of the clause."
      : "German main clauses put the conjugated verb in second position.";
  }

  const GENDER_WORD = { der: "masculine", die: "feminine", das: "neuter" };

  function gapRule(card) {
    if (!card || !/^(der|die|das)$/i.test(card.art || "")) return "";
    const art = String(card.art).toLowerCase();
    const word = card.lemma || card.word || "";
    let s = `${art} ${word} — ${GENDER_WORD[art]}`;
    if (card.note) s += `; ${card.note}`;
    return s;
  }

  function updateRecords(records, round, dayKey) {
    const r = { ...(records || {}) };
    const newRecords = [];
    const prevDay = r.lastDay;
    if (prevDay !== dayKey) {
      const y = new Date(dayKey + "T00:00:00Z").getTime() - 86400000;
      const yKey = new Date(y).toISOString().slice(0, 10);
      r.streakDays = prevDay === yKey ? (r.streakDays || 0) + 1 : 1;
      r.lastDay = dayKey;
      if ((r.streakDays || 0) > (r.bestStreak || 0)) { r.bestStreak = r.streakDays; if (r.streakDays > 1) newRecords.push("streak"); }
    }
    if ((round.correct || 0) > (r.bestRound || 0)) { r.bestRound = round.correct; newRecords.push("bestRound"); }
    if (round.perfect && (!r.fastestPerfectSec || round.seconds < r.fastestPerfectSec)) {
      r.fastestPerfectSec = round.seconds; newRecords.push("fastestPerfect");
    }
    if ((round.speedBonuses || 0) > (r.bestSpeedBonuses || 0)) { r.bestSpeedBonuses = round.speedBonuses; newRecords.push("speedBonuses"); }
    return { records: r, newRecords };
  }

  g.SV_GAME = {
    status, matchesScope, isEnriched, buildSession, distractors, shuffle, updateRecords,
    builderFor, gapFor, findFor, kindsFor, pickKind, builderHint, gapRule,
  };
})(globalThis);
