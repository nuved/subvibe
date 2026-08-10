// Proportional word distribution for cross-cue sentence groups. Translation
// happens per sentence-GROUP (context = quality), and every member cue stores
// the full group translation — so the overlay dumped whole paragraphs while
// the original line showed a few words. split() allocates the translation's
// words across the group's cues by each cue's share of the ORIGINAL text, so
// the translated line paces with the original. Display-only: caches keep the
// full sentence.
(function (g) {
  g.SV_TEXTSLICE = {
    // text: the group translation · weights: original char length per cue.
    // Returns one word-joined slice per cue; order kept, every word used,
    // the last cue takes any rounding remainder.
    split(text, weights) {
      const n = weights.length;
      if (!n) return [];
      const words = String(text || "").trim().split(/\s+/).filter(Boolean);
      if (!words.length) return Array(n).fill("");
      if (n === 1) return [words.join(" ")];
      const total = weights.reduce((a, b) => a + (b > 0 ? b : 1), 0);
      const out = [];
      let used = 0, acc = 0;
      for (let i = 0; i < n; i++) {
        acc += weights[i] > 0 ? weights[i] : 1;
        const upto = i === n - 1 ? words.length : Math.max(used, Math.round((acc / total) * words.length));
        out.push(words.slice(used, upto).join(" "));
        used = upto;
      }
      return out;
    },
  };
})(globalThis);
