// Pure svbox share module for the word game. No DOM, no chrome.* — node-tested.
// Imported .svbox files are UNTRUSTED input from strangers' chat apps: every
// field is type-checked and length-capped, unknown fields are dropped, and
// nothing is ever built with a spread over attacker-controlled data — every
// output object is assembled field-by-field from a fixed whitelist so review
// state (box/nextDueAt/lastGradedAt/history/addedAt/key/n/gift) and anything
// unrecognized can never ride along, no matter what the file contains.
(function (g) {
  const STORE_URL = "https://chromewebstore.google.com/detail/lmlnalcdaojhipggkcgdpibobbolbfne";

  // The only enrichment fields a card is allowed to carry across the wire.
  // "word" is required; the rest are optional with their own length cap.
  const STRING_CAPS = {
    word: 80, lemma: 500, cefr: 500, pos: 500, art: 500, meaning: 500,
    sentence: 1000, sentenceT: 1000, para: 1000, note: 500, phrase: 500,
    videoTitle: 500, channel: 500,
  };
  const OPTIONAL_STRING_FIELDS = Object.keys(STRING_CAPS).filter((f) => f !== "word");
  // Fields mergeImport is allowed to update on an existing card (word is the
  // dedupe key, not an updatable field — first-seen casing wins).
  const UPDATABLE_FIELDS = [...OPTIONAL_STRING_FIELDS, "sep", "ms"];

  const MAX_CARDS = 5000;
  const MAX_NAME = 24;
  const MAX_TEXT = 2 * 1024 * 1024; // 2M UTF-16 code units (string .length, not bytes) — reject before JSON.parse ever runs
  const NAME_CHARS = /[^A-Za-z0-9 _-]/g;
  const LANG_RE = /^[a-z]{2,8}$/;

  // Builds a brand-new object by copying ONLY whitelisted, type/length-valid
  // fields off `raw` — never `{...raw}`, never `Object.assign({}, raw)`. This
  // is what makes review state, unknown keys, and a `__proto__` payload in
  // imported JSON all equally inert: they're simply never read.
  function whitelistCard(raw, { requireWord } = {}) {
    if (!raw || typeof raw !== "object") return null;
    const out = {};
    const w = raw.word;
    if (typeof w === "string" && w.length > 0 && w.length <= STRING_CAPS.word) {
      out.word = w;
    } else if (requireWord) {
      return null;
    }
    // Empty is never emitted, not even as an explicit "" — a bare presence
    // check downstream (mergeImport's isEmpty, background.js's pickImportFields)
    // is what stands between an unenriched export and quietly blanking a
    // receiver's real enrichment on a toAdd-collision merge; not emitting the
    // field in the first place closes that at the source (review fix round 2).
    for (const f of OPTIONAL_STRING_FIELDS) {
      const v = raw[f];
      if (typeof v === "string" && v.length > 0 && v.length <= STRING_CAPS[f]) out[f] = v;
    }
    // sep:false and ms:0 are exactly as "nothing to say" as an absent field —
    // an unenriched card's sep defaults false and ms defaults 0, so emitting
    // them as real values would let a plain export switch OFF a receiver's
    // separable-verb flag or zero their video timestamp on reimport.
    if (raw.sep === true) out.sep = true;
    if (typeof raw.ms === "number" && Number.isFinite(raw.ms) && raw.ms > 0) out.ms = raw.ms;
    return out;
  }

  // Strips to [A-Za-z0-9 _-] and caps at 24 — used for both the export
  // filename/payload name and, defensively, for a name arriving on import.
  function sanitizeName(name) {
    if (!name) return "";
    return String(name).replace(NAME_CHARS, "").trim().slice(0, MAX_NAME);
  }

  // Feature-detected, never imported: shared/langs.js is optional to this
  // pure module. When it's loaded (globalThis.svLangMeta from shared/langs.js,
  // bound to globalThis so it's reachable from a node:test process too), use
  // its display name ("de" → "German"); otherwise fall back to the
  // capitalized code ("de" → "De"). `code` here is already regex-validated
  // by the caller, but the result is guarded regardless — a hostile or
  // future svLangMeta returning something odd never reaches the filename raw.
  function langDisplayName(code) {
    const meta = typeof globalThis.svLangMeta === "function" ? globalThis.svLangMeta(code) : null;
    const fromMeta = meta && typeof meta[1] === "string" ? meta[1].trim() : "";
    if (fromMeta) return fromMeta;
    return code.slice(0, 1).toUpperCase() + code.slice(1);
  }

  function buildFilename(lang, cleanName) {
    const langPart = langDisplayName(String(lang || ""));
    let name = cleanName ? `${langPart}-by-${cleanName}.svbox` : `${langPart}.svbox`;
    // Belt-and-suspenders: nothing in the current call graph can produce a
    // leading '-' (langPart always starts with a letter), but a filename
    // starting with '-' is a classic footgun once it reaches any shell/CLI
    // (mistaken for a flag) — guard the OUTPUT, not just today's inputs.
    if (name.startsWith("-")) name = "_" + name;
    return name;
  }

  function exportDeck(cards, lang, opts) {
    if (!Array.isArray(cards)) return null;
    const langCode = typeof lang === "string" ? lang.toLowerCase() : "";
    if (!LANG_RE.test(langCode)) return null;
    const o = opts || {};
    const cleanName = sanitizeName(o.name);
    // requireWord: a card without a usable word would write an svbox entry
    // that validateImport itself would reject on re-import — so it's
    // silently dropped here rather than written out malformed. Real deck
    // cards always have a word; this only guards against bad input.
    const outCards = cards.map((c) => whitelistCard(c, { requireWord: true })).filter(Boolean);
    const payload = { v: 1, kind: "svbox", lang: langCode, cards: outCards };
    if (cleanName) payload.name = cleanName;
    return { filename: buildFilename(langCode, cleanName), text: JSON.stringify(payload) };
  }

  function validateImport(text) {
    // Length-check BEFORE JSON.parse — a giant string is a memory/CPU cost
    // an attacker can impose just by handing over a file, independent of
    // anything JSON.parse would later reject about its contents.
    if (typeof text !== "string" || text.length > MAX_TEXT) return { ok: false, error: "too-large" };
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, error: "parse-error" };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "parse-error" };
    if (data.v !== 1) return { ok: false, error: "bad-version" };
    if (data.kind !== "svbox") return { ok: false, error: "bad-kind" };
    if (typeof data.lang !== "string" || !LANG_RE.test(data.lang)) return { ok: false, error: "bad-lang" };
    if (!Array.isArray(data.cards)) return { ok: false, error: "bad-cards" };
    if (data.cards.length > MAX_CARDS) return { ok: false, error: "too-many-cards" };

    // A malformed/oversize name is a cosmetic problem, not a structural one —
    // sanitize it like export does rather than reject the whole file over it.
    let name;
    if (typeof data.name === "string") {
      const clean = sanitizeName(data.name);
      if (clean) name = clean;
    }

    let skipped = 0;
    const cards = [];
    for (const raw of data.cards) {
      const c = whitelistCard(raw, { requireWord: true });
      if (c) cards.push(c); else skipped++;
    }
    return { ok: true, lang: data.lang, name, cards, skipped };
  }

  function isEmpty(v) {
    return v === undefined || v === null || v === "";
  }

  function dedupeKey(lang, word) {
    return String(lang).toLowerCase() + ":" + String(word).toLowerCase();
  }

  // existingCards/importedCards are both treated as untrusted here too
  // (defense in depth — importedCards is expected to already be
  // validateImport's output, but mergeImport re-applies the same
  // whitelist-copy rather than trust that blindly).
  function mergeImport(existingCards, importedCards, lang) {
    // Both args are expected to be arrays; a caller handing in an array-like
    // (e.g. {0: card, length: 1}) instead of a real array would blow up the
    // `for...of` below with an uncaught TypeError (array-likes aren't
    // iterable) — fail closed with the same empty shape rather than throw.
    if (!Array.isArray(existingCards) || !Array.isArray(importedCards)) return { toAdd: [], toUpdate: [] };

    // Canonicalize the same way exportDeck/validateImport do. Without this,
    // a caller passing "DE" here while existing cards carry lowercase
    // .lang "de" would silently defeat both the filter below AND dedupeKey
    // (which used to lowercase only the WORD half of the key) — every card
    // would look "new" instead of matching, turning updates into duplicates.
    const langCode = String(lang == null ? "" : lang).toLowerCase();

    // Real card objects carry their own .lang (decks are per-language) — guard
    // against a caller accidentally passing an unfiltered, multi-language
    // store by excluding any card whose OWN lang explicitly disagrees. Cards
    // silent on lang (no field at all) are still included, for callers that
    // already pre-filter to a single-language array before calling in.
    const byKey = new Map();
    for (const c of existingCards) {
      if (!c || typeof c.word !== "string") continue;
      if (c.lang !== undefined && String(c.lang).toLowerCase() !== langCode) continue;
      byKey.set(dedupeKey(langCode, c.word), c);
    }

    const toAdd = [];
    const toUpdate = [];
    for (const raw of importedCards) {
      const imp = whitelistCard(raw, { requireWord: true });
      if (!imp) continue;
      const key = dedupeKey(langCode, imp.word);
      const existing = byKey.get(key);
      if (!existing) {
        toAdd.push(imp);
        continue;
      }
      const fields = {};
      for (const f of UPDATABLE_FIELDS) {
        const impVal = imp[f];
        // sep/ms are boolean/numeric — isEmpty's ""/null/undefined check
        // doesn't cover THEIR "nothing to say" values (false, 0). whitelistCard
        // no longer emits sep:false or ms:0 at all, so imp[f] can only be
        // `true`/a positive number/absent here — this stays explicit rather
        // than relying solely on that upstream invariant (review fix round 2).
        const impEmpty = f === "sep" ? impVal !== true
          : f === "ms" ? !(typeof impVal === "number" && impVal > 0)
          : isEmpty(impVal);
        if (impEmpty) continue;
        const curVal = existing[f];
        if (isEmpty(curVal) || curVal !== impVal) fields[f] = impVal;
      }
      if (Object.keys(fields).length) toUpdate.push({ key, fields });
    }
    return { toAdd, toUpdate };
  }

  function buildShareText(langName, count, opts) {
    const o = opts || {};
    // sanitizeName (not a bare .trim()) so a name carrying "\n" or other
    // control/markup characters can't inject extra lines or content into a
    // message that's about to be pasted straight into WhatsApp/Telegram.
    const name = sanitizeName(o.name);
    const lang = langName || "language";
    const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    const words = `${n} ${lang} word${n === 1 ? "" : "s"}`;
    const intro = name
      ? `${name} put together a deck of ${words} for you — a gift, free to play.`
      : `Here's a deck of ${words} — a gift, free to play.`;
    return `${intro}\nInstall SubVibe (free) and open the file to play.\n${STORE_URL}\nFree, no AI key needed.`;
  }

  g.SV_SHARE = { STORE_URL, exportDeck, validateImport, mergeImport, buildShareText };
})(globalThis);
