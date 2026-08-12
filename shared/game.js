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

  // German separable-verb prefixes, longest-first so a longer prefix ("zurück")
  // wins over a shorter one that's also valid on its own ("zu") when matching
  // the START of a reunited lemma like "zurückkommen".
  const SEP_PREFIXES = Object.freeze([
    "zusammen",
    "zurück", "weiter", "wieder",
    "dabei", "durch", "statt",
    "fest", "fort", "nach", "teil",
    "auf", "aus", "bei", "dar", "ein", "her", "hin", "los", "mit", "vor", "weg",
    "ab", "an", "da", "um", "zu",
  ]);

  // Stub/demo data names the separable prefix directly via a pipe
  // ("auf|stehen"). Real enrichment always returns the REUNITED lemma
  // ("aufstehen", no pipe) — fall back to matching it against the known
  // prefix list (fail closed: no match → null). Shared by findFor (locating
  // the prefix token) and builderHint (illustrating where it lands).
  function prefixFor(card) {
    if (!isSep(card)) return null;
    const lemma = String((card && card.lemma) || "").toLowerCase();
    if (lemma.includes("|")) return lemma.split("|")[0].trim() || null;
    if (card && card.sep === true) return SEP_PREFIXES.find((p) => lemma.startsWith(p)) || null;
    return null;
  }

  // Separable verbs: the prefix rides at the end of the clause, so we hunt
  // for it there first — the German word order the card is teaching.
  function findFor(card) {
    if (!card) return null;
    const tokens = sentenceTokens(card);
    if (!tokens) return null;
    if (isSep(card)) {
      const prefix = prefixFor(card);
      if (!prefix) return null;
      let answerIndex = -1;
      for (let i = 0; i < tokens.length; i++) {
        if (cleanToken(tokens[i]).toLowerCase() === prefix) answerIndex = i; // last wins
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

  // Multi-line composer: line 1 is the general rule, line 2 illustrates it
  // against THIS card's own sentence tokens (a sep verb gets a further line
  // pinpointing its actual prefix), and an optional final line surfaces the
  // enrichment note verbatim. Returns an array of short strings — never a
  // single joined string — so gameui can render each as its own stacked line.
  //
  // Line 2 (and the sep-prefix line) are FRAGMENT-SAFE: subtitle cues are
  // often mid-sentence fragments ("bis nur noch deine Nähe ist." — verb
  // final, not second: no verb-second claim holds here) or have a subject
  // spanning more than one token (verb genuinely at index 2+, not index 1).
  // Rather than blindly quote tokens[0]/tokens[1], each claim only renders
  // once it's VERIFIED against the card's own data — never an illustration
  // that contradicts the visible sentence (playtest fix). Line 1's general
  // rule always stays; it's a standalone grammar fact, not a claim ABOUT
  // this sentence.
  function builderHint(card) {
    if (!card) return [];
    const sep = isSep(card);
    const lines = [sep
      ? "Separable verbs: the prefix moves to the very end of the clause."
      : "German main clauses put the conjugated verb in second position."];
    const tokens = builderTokens(card);
    if (tokens && tokens.length >= 2) {
      if (sep) {
        // Verified ONLY when the prefix is a standalone token AND it's
        // genuinely the LAST one — a reunited form (subordinate clause,
        // "weil ich früh aufstehe") or an interior placement (a trailing
        // clause after the prefix) can't confirm either claim, so BOTH are
        // omitted together rather than assert a half-true illustration.
        const prefix = prefixFor(card);
        const lastTok = tokens[tokens.length - 1];
        if (prefix && cleanToken(lastTok).toLowerCase() === prefix) {
          lines.push(`Das Verb steht an Position 2: '${tokens[0]} ${tokens[1]} …'`);
          lines.push(`Das Präfix '${prefix}' steht am Satzende: '… ${lastTok}'`);
        }
      } else if (card.pos === "verb" && card.word && cleanToken(tokens[1]).toLowerCase() === String(card.word).toLowerCase()) {
        // Verified ONLY when this is a verb-pos card AND its own surface
        // form genuinely sits at index 1 — any other position (verb-final,
        // multi-token subject) or no verb identity to check at all (a
        // noun/adj/adv card) omits the line instead of guessing.
        lines.push(`Das Verb steht an Position 2: '${tokens[0]} ${tokens[1]} …'`);
      }
    }
    if (card.note) lines.push(card.note);
    return lines;
  }

  const GENDER_WORD = { der: "masculine", die: "feminine", das: "neuter" };
  // These three suffixes are (with vanishingly rare loanword exceptions)
  // ALWAYS feminine in German — a genuine pattern worth teaching, unlike a
  // generic "nouns can be gendered by ending" claim that doesn't hold up.
  // Only fires when the noun's own ending actually matches AND the card's
  // gender agrees (die) — never a false generality on a non-matching noun.
  const FEMININE_SUFFIXES = ["ung", "heit", "keit"];

  // Multi-line composer mirroring builderHint: line 1 is the existing art/
  // gender line, an optional line 2 names the -ung/-heit/-keit pattern only
  // when this noun genuinely fits it, and an optional final line surfaces
  // the enrichment note verbatim. Empty array (not "") when there's no art.
  function gapRule(card) {
    if (!card || !/^(der|die|das)$/i.test(card.art || "")) return [];
    const art = String(card.art).toLowerCase();
    const word = card.lemma || card.word || "";
    const lines = [`${art} ${word} — ${GENDER_WORD[art]}`];
    const lower = String(word).toLowerCase();
    const suffix = art === "die" && FEMININE_SUFFIXES.find((suf) => lower.length > suf.length && lower.endsWith(suf));
    if (suffix) lines.push(`Nomen auf '-${suffix}' sind (fast) immer feminin (die).`);
    if (card.note) lines.push(card.note);
    return lines;
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
    status, matchesScope, isEnriched, isSep, buildSession, distractors, shuffle, updateRecords,
    builderFor, gapFor, findFor, kindsFor, pickKind, builderHint, gapRule,
  };
})(globalThis);
