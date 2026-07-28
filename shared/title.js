// SubVibe — page-title cleanup (pure logic, node-testable).
// Attached to globalThis so <script src> includes, content scripts AND
// node:test share it (same pattern as shared/pricing.js).
(function (g) {
  // "(4) Barack Obama … - YouTube" → "Barack Obama …"
  //  • a leading "(N) " with 1–3 digits is a tab notification counter, never
  //    content — a "(2024) …" year prefix (4 digits) must survive;
  //  • the counter is only stripped when something follows it;
  //  • " - YouTube" at the end is tab-title chrome, not the video's name.
  const clean = (t) => {
    let s = String(t || "");
    const m = /^\(\d{1,3}\) (.+)$/s.exec(s);
    if (m) s = m[1];
    return s.replace(/ - YouTube$/, "").trim();
  };
  g.SV_TITLE = { clean };
})(globalThis);
