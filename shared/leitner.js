// SubVibe — Leitner box math (pure logic, node-testable).
// Attached to globalThis so plain <script src> includes, the worker's
// importScripts, AND node:test all share it — same pattern as shared/pricing.js.
(function (g) {
  const DAY = 86400000;
  // Boxes 1–5; review interval per box, in days. Box 5 stays at 16 days forever.
  const INTERVALS = [1, 2, 4, 8, 16];

  // Apply a self-grade. ok → next box (capped at 5); wrong → back to box 1.
  // Returns a NEW card; never mutates the input. History keeps the last 20.
  function grade(card, ok, now) {
    const box = ok ? Math.min(5, (card.box || 1) + 1) : 1;
    const history = [...(card.history || []), { at: now, ok: !!ok }].slice(-20);
    return { ...card, box, nextDueAt: now + INTERVALS[box - 1] * DAY, lastGradedAt: now, history };
  }

  // Cards due at `now` — due exactly now counts; a card without nextDueAt
  // (bad storage) counts too, so it can never get stuck invisible.
  function dueCards(cards, now) {
    return (cards || []).filter((c) => (c.nextDueAt || 0) <= now);
  }

  // Session order: shakiest cards first (lowest box), oldest due first within a
  // box, then by word so the order is deterministic. Noun article-quiz cards
  // ride along — the quiz is a presentation stage of the card, not a second card.
  function sessionOrder(cards) {
    return (cards || []).slice().sort((a, b) =>
      (a.box || 1) - (b.box || 1) ||
      (a.nextDueAt || 0) - (b.nextDueAt || 0) ||
      String(a.word).localeCompare(String(b.word)));
  }

  g.SV_LEITNER = { DAY, INTERVALS, grade, dueCards, sessionOrder };
})(globalThis);
