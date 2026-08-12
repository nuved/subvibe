// Pure svbox share module for the word game. No DOM, no chrome.* — node-tested.
// Imported .svbox files are UNTRUSTED input from strangers' chat apps: every
// field is type-checked and length-capped, unknown fields are dropped, and
// nothing is ever built with a spread over attacker-controlled data — every
// output object is assembled field-by-field from a fixed whitelist so review
// state (box/nextDueAt/lastGradedAt/history/addedAt/key/n/gift) and anything
// unrecognized can never ride along, no matter what the file contains.
(function (g) {
  // TODO(operator): replace with the real Chrome Web Store listing URL once published.
  const STORE_URL = "https://chromewebstore.google.com/detail/subvibe";

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
  const MAX_TEXT = 2 * 1024 * 1024; // 2MB raw text cap — reject before JSON.parse ever runs
  const NAME_CHARS = /[^A-Za-z0-9 _-]/g;

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
    for (const f of OPTIONAL_STRING_FIELDS) {
      const v = raw[f];
      if (typeof v === "string" && v.length <= STRING_CAPS[f]) out[f] = v;
    }
    if (typeof raw.sep === "boolean") out.sep = raw.sep;
    if (typeof raw.ms === "number" && Number.isFinite(raw.ms)) out.ms = raw.ms;
    return out;
  }

  // Strips to [A-Za-z0-9 _-] and caps at 24 — used for both the export
  // filename/payload name and, defensively, for a name arriving on import.
  function sanitizeName(name) {
    if (!name) return "";
    return String(name).replace(NAME_CHARS, "").trim().slice(0, MAX_NAME);
  }

  function buildFilename(lang, cleanName) {
    const code = String(lang || "");
    const langPart = code.slice(0, 1).toUpperCase() + code.slice(1);
    return cleanName ? `${langPart}-by-${cleanName}.svbox` : `${langPart}.svbox`;
  }

  // No langMeta-style display-name table is available to this pure module,
  // so the filename uses the lang CODE capitalized ("de" → "De"), not a full
  // language name. A caller wanting "German-by-Nima.svbox" would need to
  // rename the returned file client-side — documented, not implemented here.
  function exportDeck(cards, lang, opts) {
    const o = opts || {};
    const cleanName = sanitizeName(o.name);
    // requireWord: a card without a usable word would write an svbox entry
    // that validateImport itself would reject on re-import — so it's
    // silently dropped here rather than written out malformed. Real deck
    // cards always have a word; this only guards against bad input.
    const outCards = (cards || []).map((c) => whitelistCard(c, { requireWord: true })).filter(Boolean);
    const payload = { v: 1, kind: "svbox", lang, cards: outCards };
    if (cleanName) payload.name = cleanName;
    return { filename: buildFilename(lang, cleanName), text: JSON.stringify(payload) };
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
    if (typeof data.lang !== "string" || !/^[a-z]{2,8}$/.test(data.lang)) return { ok: false, error: "bad-lang" };
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
    return String(lang) + ":" + String(word).toLowerCase();
  }

  // existingCards/importedCards are both treated as untrusted here too
  // (defense in depth — importedCards is expected to already be
  // validateImport's output, but mergeImport re-applies the same
  // whitelist-copy rather than trust that blindly).
  function mergeImport(existingCards, importedCards, lang) {
    // Real card objects carry their own .lang (decks are per-language) — guard
    // against a caller accidentally passing an unfiltered, multi-language
    // store by excluding any card whose OWN lang explicitly disagrees. Cards
    // silent on lang (no field at all) are still included, for callers that
    // already pre-filter to a single-language array before calling in.
    const byKey = new Map();
    for (const c of existingCards || []) {
      if (!c || typeof c.word !== "string") continue;
      if (c.lang !== undefined && c.lang !== lang) continue;
      byKey.set(dedupeKey(lang, c.word), c);
    }

    const toAdd = [];
    const toUpdate = [];
    for (const raw of importedCards || []) {
      const imp = whitelistCard(raw, { requireWord: true });
      if (!imp) continue;
      const key = dedupeKey(lang, imp.word);
      const existing = byKey.get(key);
      if (!existing) {
        toAdd.push(imp);
        continue;
      }
      const fields = {};
      for (const f of UPDATABLE_FIELDS) {
        const impVal = imp[f];
        if (isEmpty(impVal)) continue;
        const curVal = existing[f];
        if (isEmpty(curVal) || curVal !== impVal) fields[f] = impVal;
      }
      if (Object.keys(fields).length) toUpdate.push({ key, fields });
    }
    return { toAdd, toUpdate };
  }

  function buildShareText(langName, count, opts) {
    const o = opts || {};
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const lang = langName || "language";
    const n = Number.isFinite(count) ? count : 0;
    const words = `${n} ${lang} word${n === 1 ? "" : "s"}`;
    const intro = name
      ? `${name} put together a deck of ${words} for you — a gift, free to play.`
      : `Here's a deck of ${words} — a gift, free to play.`;
    return `${intro}\nInstall SubVibe (free) and open my file to play.\n${STORE_URL}\nFree, no AI key needed.`;
  }

  g.SV_SHARE = { STORE_URL, exportDeck, validateImport, mergeImport, buildShareText };
})(globalThis);
