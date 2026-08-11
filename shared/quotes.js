// Quotation marks for TRANSLATED subtitle lines. German sources write
// „quote“ and the model faithfully copies that style into its translations —
// so an English line opened with a low-9 „ and a Persian line got Latin
// quotes. Each target has its own convention: «…» for the Arabic-script
// languages, “…” for the rest. Originals are never passed through here —
// their native marks are correct by definition.
(function (g) {
  const GUILLEMET = new Set(["fa", "ar", "ur", "ps", "ckb"]);
  g.SV_QUOTES = {
    fix(s, lang) {
      if (!s || s.indexOf("„") === -1) return s; // „ marks German-style quoting
      const open = GUILLEMET.has(lang) ? "«" : "“";
      const close = GUILLEMET.has(lang) ? "»" : "”";
      // Order matters: German's CLOSE mark “ is Latin's OPEN — convert closes
      // first, then the unambiguous „ opens, so fresh opens aren't re-eaten.
      return s.split("“").join(close).split("„").join(open);
    },
    // Wrap an example phrase in the quotation marks of ITS language — the
    // word cards had „…“ hardcoded, which is right for German words only.
    wrap(s, lang) {
      if (!s) return s;
      const l = (lang || "").toLowerCase();
      if (GUILLEMET.has(l)) return "«" + s + "»";
      return "“" + s + "”";
    },
  };
})(globalThis);
