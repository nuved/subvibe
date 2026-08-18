// shared/simplify.js
// Prompt building + response validation for the Simplify Reader card.
// Pure (no chrome.*) so tools/tests/simplify.test.mjs can load it in node.
(function (g) {
  const MAX_CHARS = 6000;
  const LONG_CHARS = 600;

  function prep(text) {
    let t = String(text || "").trim().replace(/\n{3,}/g, "\n\n").split("\n").map((line) => line.trim()).join("\n");
    let truncated = false;
    if (t.length > MAX_CHARS) {
      t = t.slice(0, MAX_CHARS);
      const sp = t.lastIndexOf(" ");
      if (sp > MAX_CHARS - 80) t = t.slice(0, sp);
      t = t.trimEnd();
      truncated = true;
    }
    return { text: t, truncated };
  }

  function buildMessages(text, level) {
    const long = text.length > LONG_CHARS;
    const pointsRule = long
      ? 'Also give 2-4 key-point bullets in "points" (same language, one short sentence each).'
      : 'Set "points": [] (input is short).';
    const system =
      "Rewrite the user's text in the SAME language it is written in. " +
      "Make it simpler: short sentences, common words. Keep all names, numbers and facts. " +
      `Target CEFR level ${level}. ${pointsRule} ` +
      'Reply with ONLY JSON: {"simple": "...", "points": [...]}.';
    return [
      { role: "system", content: system },
      { role: "user", content: text },
    ];
  }

  function parse(raw) {
    let s = String(raw || "").trim();
    const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (fence) s = fence[1];
    let obj;
    try { obj = JSON.parse(s); } catch { throw new Error("bad-response"); }
    if (!obj || typeof obj.simple !== "string" || !obj.simple.trim()) throw new Error("bad-response");
    const points = Array.isArray(obj.points)
      ? obj.points.map((p) => String(p).trim()).filter(Boolean).slice(0, 4)
      : [];
    return { simple: obj.simple.trim(), points };
  }

  g.SV_SIMPLIFY = { MAX_CHARS, LONG_CHARS, prep, buildMessages, parse };
})(globalThis);
