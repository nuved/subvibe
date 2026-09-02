// shared/cues.js — pure cue helpers for the overlay. No chrome.*, no DOM, so
// tools/tests/cues.test.mjs loads it in node. Used by content/common.js.
(function (g) {
  // YouTube auto-captions arrive as fixed windows that ignore where the
  // speaker paused: "Schlüssel eine Tasse die" is the tail of one item, a
  // whole one, and the head of the next. When a cue carries per-word offsets
  // (`w`: [{o: ms from the cue start, t: word}]) we can re-cut it at the
  // pauses, so a line is a spoken phrase. A boundary is a gap of `gapMs` or
  // more between word starts, or a gap of `softGapMs` once the piece is
  // already `maxChars` long. Pieces get their own start/end and re-based
  // word offsets; a cue with no word timing (or no pause) comes back as is.
  function splitAtPauses(cue, opt) {
    const o = opt || {};
    const gapMs = o.gapMs == null ? 700 : o.gapMs, softGapMs = o.softGapMs == null ? 320 : o.softGapMs, maxChars = o.maxChars == null ? 48 : o.maxChars;
    const w = Array.isArray(cue && cue.w) ? cue.w.filter((x) => x && x.t) : [];
    if (w.length < 2) return [cue];
    const groups = [[w[0]]];
    let chars = w[0].t.length;
    for (let i = 1; i < w.length; i++) {
      const delta = (w[i].o || 0) - (w[i - 1].o || 0);
      const cut = delta >= gapMs || (chars >= maxChars && delta >= softGapMs);
      if (cut) { groups.push([w[i]]); chars = w[i].t.length; }
      else { groups[groups.length - 1].push(w[i]); chars += 1 + w[i].t.length; }
    }
    if (groups.length < 2) return [cue];
    const end = cue.endMs != null ? cue.endMs : cue.startMs + 2500;
    return groups.map((grp, k) => {
      const first = grp[0].o || 0;
      const startMs = k === 0 ? cue.startMs : cue.startMs + first;
      const nextStart = k + 1 < groups.length ? cue.startMs + (groups[k + 1][0].o || 0) : end;
      const endMs = Math.max(startMs + 400, k + 1 < groups.length ? nextStart - 1 : end);
      const base = k === 0 ? 0 : first;
      return { ...cue, startMs, endMs, text: grp.map((x) => x.t).join(" "), w: grp.map((x) => ({ o: (x.o || 0) - base, t: x.t })) };
    });
  }
  g.SV_CUES = { splitAtPauses };
})(globalThis);
