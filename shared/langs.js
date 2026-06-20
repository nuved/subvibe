// Shared language table (flag + name) used by BOTH the popup and the Library page,
// so the two never drift. Exposed on window for plain <script src> includes (no
// modules needed). Persian uses the Lion & Sun (شیر و خورشید) flag as an inline
// SVG — there is no emoji for it.
(function (g) {
  const FA_FLAG =
    '<svg viewBox="0 0 28 18" style="width:1.4em;height:auto;border-radius:2px;vertical-align:-.24em;box-shadow:0 0 0 .5px rgba(0,0,0,.25)">' +
    '<rect width="28" height="18" fill="#fff"/><rect width="28" height="6" fill="#239f40"/><rect y="12" width="28" height="6" fill="#da0000"/>' +
    '<g fill="#b58a2b"><g stroke="#b58a2b" stroke-width=".5" stroke-linecap="round">' +
    '<path d="M14 4.3V3M11.8 4.9 11.1 3.8M16.2 4.9 16.9 3.8M10.5 6.3 9.4 5.7M17.5 6.3 18.6 5.7"/></g>' +
    '<circle cx="14" cy="6.6" r="1.7"/>' +
    '<path d="M9.7 12.1c.5-1 1.7-1.6 2.9-1.4.3-.7 1.1-1 1.8-.6.5-.6 1.4-.5 1.7.2.6-.1 1.1.3 1.2 1 .5.2.8.8.7 1.4l-.9.1c0-.5-.4-.9-.9-.8.4.7.1 1.6-.5 2l-.6-.3c.3-.5.3-1.2 0-1.7-1 .7-2.3.6-3.2-.1-.5.5-1.4.6-2.1.3-.3.2-.7.3-1 .1z"/></g></svg>';

  const LANGS = [
    ["en", "English", "🇬🇧"], ["es", "Spanish", "🇪🇸"], ["fr", "French", "🇫🇷"], ["de", "German", "🇩🇪"],
    ["it", "Italian", "🇮🇹"], ["pt", "Portuguese", "🇵🇹"], ["ru", "Russian", "🇷🇺"], ["ja", "Japanese", "🇯🇵"],
    ["ko", "Korean", "🇰🇷"], ["zh", "Chinese", "🇨🇳"], ["ar", "Arabic", "🇸🇦"], ["fa", "Persian", FA_FLAG],
    ["hi", "Hindi", "🇮🇳"], ["tr", "Turkish", "🇹🇷"], ["nl", "Dutch", "🇳🇱"], ["pl", "Polish", "🇵🇱"],
    ["sv", "Swedish", "🇸🇪"], ["uk", "Ukrainian", "🇺🇦"], ["id", "Indonesian", "🇮🇩"], ["th", "Thai", "🇹🇭"],
    ["vi", "Vietnamese", "🇻🇳"], ["el", "Greek", "🇬🇷"], ["he", "Hebrew", "🇮🇱"], ["ro", "Romanian", "🇷🇴"],
    ["cs", "Czech", "🇨🇿"], ["da", "Danish", "🇩🇰"], ["fi", "Finnish", "🇫🇮"], ["no", "Norwegian", "🇳🇴"],
    ["hu", "Hungarian", "🇭🇺"], ["bn", "Bengali", "🇧🇩"], ["ur", "Urdu", "🇵🇰"], ["ta", "Tamil", "🇮🇳"],
  ];

  g.SV_FA_FLAG = FA_FLAG;
  g.SV_LANGS = LANGS;
  g.svLangMeta = (code) => LANGS.find((l) => l[0] === code) || [code, (code || "").toUpperCase(), "🏳️"];
})(window);
