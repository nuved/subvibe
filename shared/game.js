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
    const inScope = (cards || []).filter((c) => matchesScope(c, scope));
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

  g.SV_GAME = { status, matchesScope, buildSession, distractors, shuffle, updateRecords };
})(globalThis);
