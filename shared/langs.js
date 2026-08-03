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
    ["ms", "Malay", "🇲🇾"], ["tl", "Filipino", "🇵🇭"], ["sw", "Swahili", "🇰🇪"], ["af", "Afrikaans", "🇿🇦"],
    ["bg", "Bulgarian", "🇧🇬"], ["hr", "Croatian", "🇭🇷"], ["sk", "Slovak", "🇸🇰"], ["sl", "Slovenian", "🇸🇮"],
    ["sr", "Serbian", "🇷🇸"], ["lt", "Lithuanian", "🇱🇹"], ["lv", "Latvian", "🇱🇻"], ["et", "Estonian", "🇪🇪"],
    ["is", "Icelandic", "🇮🇸"], ["sq", "Albanian", "🇦🇱"], ["mk", "Macedonian", "🇲🇰"], ["hy", "Armenian", "🇦🇲"],
    ["ka", "Georgian", "🇬🇪"], ["az", "Azerbaijani", "🇦🇿"], ["kk", "Kazakh", "🇰🇿"], ["ne", "Nepali", "🇳🇵"],
    ["si", "Sinhala", "🇱🇰"], ["km", "Khmer", "🇰🇭"], ["my", "Burmese", "🇲🇲"], ["lo", "Lao", "🇱🇦"],
    ["mr", "Marathi", "🇮🇳"], ["te", "Telugu", "🇮🇳"], ["ml", "Malayalam", "🇮🇳"], ["kn", "Kannada", "🇮🇳"],
    ["gu", "Gujarati", "🇮🇳"], ["pa", "Punjabi", "🇮🇳"], ["am", "Amharic", "🇪🇹"], ["cy", "Welsh", "🏴󠁧󠁢󠁷󠁬󠁳󠁿"],
  ];

  // Dub / Live-Translate target set — the EXACT list Gemini's live-translate model
  // documents as supported (ai.google.dev/gemini-api/docs/live-api/live-translate,
  // 70+ languages, bidirectional). Codes are Google's own BCP-47 (zh-Hans/zh-Hant,
  // pt-BR/pt-PT, fil), so the code we hand the model is one it actually speaks.
  // This is deliberately its OWN list, not the subtitle set: it adds languages the
  // text translator doesn't offer (Basque, Catalan, Akan…) and drops ones Gemini
  // can't voice (e.g. Welsh). Keep it in sync with the doc, not with SV_LANGS.
  const LIVE_LANGS = [
    ["af", "Afrikaans", "🇿🇦"], ["ak", "Akan", "🇬🇭"], ["sq", "Albanian", "🇦🇱"], ["am", "Amharic", "🇪🇹"],
    ["ar", "Arabic", "🇸🇦"], ["hy", "Armenian", "🇦🇲"], ["az", "Azerbaijani", "🇦🇿"], ["eu", "Basque", "🏳️"],
    ["be", "Belarusian", "🇧🇾"], ["bn", "Bengali", "🇧🇩"], ["bg", "Bulgarian", "🇧🇬"], ["my", "Burmese", "🇲🇲"],
    ["ca", "Catalan", "🏳️"], ["zh-Hans", "Chinese (Simplified)", "🇨🇳"], ["zh-Hant", "Chinese (Traditional)", "🇹🇼"],
    ["hr", "Croatian", "🇭🇷"], ["cs", "Czech", "🇨🇿"], ["da", "Danish", "🇩🇰"], ["nl", "Dutch", "🇳🇱"],
    ["en", "English", "🇬🇧"], ["et", "Estonian", "🇪🇪"], ["fil", "Filipino", "🇵🇭"], ["fi", "Finnish", "🇫🇮"],
    ["fr", "French", "🇫🇷"], ["gl", "Galician", "🏳️"], ["ka", "Georgian", "🇬🇪"], ["de", "German", "🇩🇪"],
    ["el", "Greek", "🇬🇷"], ["gu", "Gujarati", "🇮🇳"], ["ha", "Hausa", "🇳🇬"], ["he", "Hebrew", "🇮🇱"],
    ["hi", "Hindi", "🇮🇳"], ["hu", "Hungarian", "🇭🇺"], ["is", "Icelandic", "🇮🇸"], ["id", "Indonesian", "🇮🇩"],
    ["it", "Italian", "🇮🇹"], ["ja", "Japanese", "🇯🇵"], ["jv", "Javanese", "🇮🇩"], ["kn", "Kannada", "🇮🇳"],
    ["kk", "Kazakh", "🇰🇿"], ["km", "Khmer", "🇰🇭"], ["rw", "Kinyarwanda", "🇷🇼"], ["ko", "Korean", "🇰🇷"],
    ["lo", "Lao", "🇱🇦"], ["lv", "Latvian", "🇱🇻"], ["lt", "Lithuanian", "🇱🇹"], ["mk", "Macedonian", "🇲🇰"],
    ["ms", "Malay", "🇲🇾"], ["ml", "Malayalam", "🇮🇳"], ["mr", "Marathi", "🇮🇳"], ["mn", "Mongolian", "🇲🇳"],
    ["ne", "Nepali", "🇳🇵"], ["no", "Norwegian", "🇳🇴"], ["fa", "Persian", FA_FLAG], ["pl", "Polish", "🇵🇱"],
    ["pt-BR", "Portuguese (Brazil)", "🇧🇷"], ["pt-PT", "Portuguese (Portugal)", "🇵🇹"], ["pa", "Punjabi", "🇮🇳"],
    ["ro", "Romanian", "🇷🇴"], ["ru", "Russian", "🇷🇺"], ["sr", "Serbian", "🇷🇸"], ["sd", "Sindhi", "🇵🇰"],
    ["si", "Sinhala", "🇱🇰"], ["sk", "Slovak", "🇸🇰"], ["sl", "Slovenian", "🇸🇮"], ["es", "Spanish", "🇪🇸"],
    ["su", "Sundanese", "🇮🇩"], ["sw", "Swahili", "🇰🇪"], ["sv", "Swedish", "🇸🇪"], ["ta", "Tamil", "🇮🇳"],
    ["te", "Telugu", "🇮🇳"], ["th", "Thai", "🇹🇭"], ["tr", "Turkish", "🇹🇷"], ["uk", "Ukrainian", "🇺🇦"],
    ["ur", "Urdu", "🇵🇰"], ["uz", "Uzbek", "🇺🇿"], ["vi", "Vietnamese", "🇻🇳"], ["zu", "Zulu", "🇿🇦"],
  ];

  // Old simple codes → Google's live-translate code, so a subtitle target inherited
  // by Dub (or a saved pick from before) maps to something the model recognises.
  const LIVE_ALIAS = { zh: "zh-Hans", "zh-CN": "zh-Hans", "zh-TW": "zh-Hant", pt: "pt-BR", tl: "fil", nb: "no" };

  const META = {};
  LANGS.concat(LIVE_LANGS).forEach((l) => { if (!META[l[0]]) META[l[0]] = l; });

  g.SV_FA_FLAG = FA_FLAG;
  g.SV_LANGS = LANGS;             // subtitle "Translate to" set (GPT/Claude)
  g.SV_LIVE_LANGS = LIVE_LANGS;   // Dub set (Gemini live-translate, authoritative)
  g.SV_LIVE_ALIAS = LIVE_ALIAS;
  // Resolve a code from EITHER set so both pickers can name any stored value.
  g.svLangMeta = (code) => META[code] || [code, (code || "").toUpperCase(), "🏳️"];
})(window);
