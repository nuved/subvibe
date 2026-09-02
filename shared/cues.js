// shared/cues.js — pure cue helpers for the overlay. No chrome.*, no DOM, so
// tools/tests/cues.test.mjs loads it in node. Used by content/common.js.
(function (g) {
  const SENT_END = /[.!?…؟。！？](["'”’»)\]]*)$/;
  const CLAUSE_END = /[,;:،]$/;
  // YouTube auto-captions arrive as fixed windows that ignore where a sentence
  // ends: a line carries the tail of one sentence and the head of the next
  // ("… in Udine. Ud"). When the cues carry per-word offsets (`w`: [{o: ms
  // from the cue start, t: word}]) the whole word stream can be re-chunked
  // into SENTENCES, the unit the creator's own captions use: a line ends at
  // sentence punctuation, at a silence long for THIS speaker, or — past
  // `maxChars` — at the next clause end or breath, with a hard cap. Pieces get their own start and
  // end and re-based word offsets, and may span the original windows. Cues
  // without word timing come back untouched, in place.
  function rechunkTimed(cues, opt) {
    const o = opt || {};
    const maxChars = o.maxChars == null ? 84 : o.maxChars, hardChars = o.hardChars == null ? 120 : o.hardChars, minWords = o.minWords == null ? 2 : o.minWords;
    const list = Array.isArray(cues) ? cues : [];
    // Flatten to words with absolute times; keep untimed cues as opaque items.
    const words = [];
    for (const c of list) {
      const w = Array.isArray(c && c.w) ? c.w.filter((x) => x && x.t) : [];
      if (w.length) for (const x of w) words.push({ at: c.startMs + (x.o || 0), t: x.t, end: c.endMs != null ? c.endMs : c.startMs + 2500 });
      else if (c) words.push({ raw: c });
    }
    // A "silence" is relative to the speaker's own pace: a slow learner video
    // leaves 1–2.5 s between ordinary words, a news reader 0.2 s. Median gap
    // between consecutive words (ignoring outliers) × `silenceFactor`, never
    // under `silenceMs`.
    const gaps = [];
    for (let i = 1; i < words.length; i++) if (!words[i].raw && !words[i - 1].raw) { const g = words[i].at - words[i - 1].at; if (g > 0 && g < 6000) gaps.push(g); }
    gaps.sort((a, b) => a - b);
    const median = gaps.length ? gaps[gaps.length >> 1] : 300;
    const silenceMs = Math.max(o.silenceMs == null ? 1400 : o.silenceMs, median * (o.silenceFactor == null ? 3 : o.silenceFactor));
    const breathMs = Math.max(o.breathMs == null ? 350 : o.breathMs, median * 1.3);
    const out = [];
    let cur = [], chars = 0;
    const flush = (nextAt) => {
      if (!cur.length) return;
      const startMs = cur[0].at;
      const lastEnd = cur[cur.length - 1].end;
      const endMs = Math.max(startMs + 400, nextAt != null ? Math.min(nextAt - 1, lastEnd) : lastEnd);
      out.push({ startMs, endMs, text: cur.map((x) => x.t).join(" "), w: cur.map((x) => ({ o: x.at - startMs, t: x.t })) });
      cur = []; chars = 0;
    };
    for (let i = 0; i < words.length; i++) {
      const x = words[i];
      if (x.raw) { flush(x.raw.startMs); out.push(x.raw); continue; }
      cur.push(x); chars += (chars ? 1 : 0) + x.t.length;
      const next = words[i + 1];
      const gap = next && !next.raw ? next.at - x.at : Infinity;
      const enough = cur.length >= minWords; // a silence or a length cut never leaves a one-word line
      const cut = SENT_END.test(x.t) || (enough && gap >= silenceMs) || (enough && chars >= maxChars && (CLAUSE_END.test(x.t) || gap >= breathMs)) || (enough && chars >= hardChars);
      if (cut) flush(next && !next.raw ? next.at : null);
    }
    flush(null);
    return out;
  }
  const isTimed = (c) => Array.isArray(c && c.w) && c.w.length > 1 && c.w.some((x) => x && x.o > 0);

  // A CHUNK is the unit tips are given for: a passage of consecutive lines
  // (sentences) that belong together. Boundaries fall at a silence that is
  // long for this speaker (max of `silenceMs` and 2.5× the median gap between
  // lines), or once a chunk reaches `maxSents` lines or `maxChars` characters —
  // never inside a line. Returns [{ from, to, startMs, endMs }] over cue indices.
  function chunkCues(cues, opt) {
    const o = opt || {};
    const maxSents = o.maxSents == null ? 4 : o.maxSents, maxChars = o.maxChars == null ? 300 : o.maxChars;
    const list = Array.isArray(cues) ? cues : [];
    const gaps = [];
    for (let i = 1; i < list.length; i++) { const gp = list[i].startMs - (list[i - 1].endMs != null ? list[i - 1].endMs : list[i - 1].startMs); if (gp > 0 && gp < 30000) gaps.push(gp); }
    gaps.sort((a, b) => a - b);
    const median = gaps.length ? gaps[gaps.length >> 1] : 400;
    const silence = Math.max(o.silenceMs == null ? 1500 : o.silenceMs, median * 2.5);
    const out = [];
    let from = 0, chars = 0;
    const text = (c) => String((c && (c.original != null ? c.original : c.text)) || "");
    for (let i = 0; i < list.length; i++) {
      chars += text(list[i]).length + 1;
      const next = list[i + 1];
      const gap = next ? next.startMs - (list[i].endMs != null ? list[i].endMs : list[i].startMs) : Infinity;
      const n = i - from + 1;
      const nextLen = next ? text(next).length + 1 : 0;
      if (!next || gap >= silence || n >= maxSents || chars + nextLen > maxChars) { // never let the next line push a chunk past the cap
        out.push({ from, to: i, startMs: list[from].startMs, endMs: list[i].endMs != null ? list[i].endMs : list[i].startMs });
        from = i + 1; chars = 0;
      }
    }
    // Overlapping windows (a line's end past the next line's start) must not
    // make one chunk's time range swallow the next — a trim cut at the chunk's
    // end lands where the next chunk begins.
    for (let k = 0; k + 1 < out.length; k++) if (out[k + 1].startMs > out[k].startMs && out[k + 1].startMs < out[k].endMs) out[k].endMs = out[k + 1].startMs;
    return out;
  }
  const chunkOf = (chunks, idx) => (chunks || []).findIndex((ch) => idx >= ch.from && idx <= ch.to);
  g.SV_CUES = { rechunkTimed, isTimed, chunkCues, chunkOf };
})(globalThis);
