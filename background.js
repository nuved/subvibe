// SubVibe — background service worker.
//
// Owns the two things a content script can't: (1) the IndexedDB subtitle
// cache, and (2) cross-origin OpenAI calls (content-script fetches to
// api.openai.com would be blocked by page CORS; the worker has host
// permission and is exempt). Everything is request/response over
// chrome.runtime messaging.

// SV_PRICING + SV_LEITNER + SV_STOPWORDS + SV_VOCAB — pure modules shared with
// pages and node tests. Chrome runs this file as a service WORKER (importScripts
// exists); the Firefox build runs it as an EVENT PAGE (importScripts is a
// worker-only API) where build.sh lists these files in background.scripts
// instead — same globalThis globals either way, so guard rather than crash.
if (typeof importScripts === "function") importScripts("shared/pricing.js", "shared/leitner.js", "shared/stopwords.js", "shared/vocab.js", "shared/simplify.js", "shared/shot.js", "shared/cli.js");

const OPENAI_CHAT = "https://api.openai.com/v1/chat/completions";
const TRANSLATE_MODEL = "gpt-4o-mini";
const BATCH = 60; // cues per translation request — keeps JSON responses reliable

// Claude (Anthropic) translation provider — an alternative BYOK engine, selected
// via translationProvider in chrome.storage.local ("openai" default | "claude").
const ANTHROPIC_MESSAGES = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// The Claude model is user-selectable (popup → storage key `claudeModel`).
// Resolve through an allowlist so corrupted/stale storage can never put an
// unknown model id on the wire — unknown values fall back to Sonnet 5.
const CLAUDE_MODELS = ["claude-sonnet-5", "claude-haiku-4-5", "claude-opus-5"];
const resolveClaudeModel = (v) => (CLAUDE_MODELS.includes(v) ? v : CLAUDE_MODELS[0]);
// max_tokens is REQUIRED on /v1/messages. 16k, not 8k: a 60-cue batch answers
// with FOUR arrays (t + the condensed dub "d" ≈ two full Persian renditions),
// and Persian is token-expensive — 8k truncated long music batches, which fell
// back to untranslated English lines.
const CLAUDE_MAX_TOKENS = 16384;
// Pricing (used for cost estimation) lives in library.js as named constants,
// verified via WebFetch against https://platform.claude.com/docs/en/about-claude/pricing.

// Structured Outputs schema (strict) — the OpenAI-recommended replacement for
// JSON mode: the model is GUARANTEED to return {"t": [ ...strings ]}, so a
// missing key / malformed-JSON response can't happen. Supported on gpt-4o-mini
// and later. (Strict mode can't constrain array LENGTH, so we still ask for
// EXACTLY N in the prompt and back-fill any short array per-line.)
// Ref: https://developers.openai.com/api/docs/guides/structured-outputs
const TRANSLATE_SCHEMA = {
  name: "subtitle_translation",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      t: { type: "array", items: { type: "string" } },
      s: { type: "array", items: { type: "integer" } },
      g: { type: "array", items: { type: "string", enum: ["m", "f", "?"] } },
      d: { type: "array", items: { type: "string" } },
    },
    required: ["t", "s", "g", "d"],
  },
};
// Vocabulary enrichment — batched (50 words/request, the spec's economy
// contract), strict-schema like TRANSLATE_SCHEMA. Strict mode requires every
// property; "-" marks not-applicable (mergeEnrichment turns it into null).
const ENRICH_BATCH = 50;
const ENRICH_SCHEMA = {
  name: "vocab_enrichment",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      e: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            lemma: { type: "string" },
            pos: { type: "string", enum: ["noun", "verb", "adj", "adv", "phrase", "other"] },
            art: { type: "string" },
            plural: { type: "string" },
            cefr: { type: "string", enum: ["A1", "A2", "B1", "B2", "C1", "C2"] },
            meaning: { type: "string" },
            phrase: { type: "string" },
            note: { type: "string" },
            sep: { type: "boolean" },
            para: { type: "string" },
          },
          required: ["lemma", "pos", "art", "plural", "cefr", "meaning", "phrase", "note", "sep", "para"],
        },
      },
    },
    required: ["e"],
  },
};

// HTTP statuses worth retrying: OpenAI/Cloudflare blips (520/52x), gateway errors,
// and rate limits are transient — a short backoff usually clears them.
const TRANSIENT_HTTP = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);

const LANG_NAMES = {
  auto: "the source language",
  fa: "Persian (Farsi)", de: "German", en: "English", fr: "French",
  es: "Spanish", it: "Italian", pt: "Portuguese", ja: "Japanese",
  ko: "Korean", ru: "Russian", hi: "Hindi", ar: "Arabic", tr: "Turkish",
  zh: "Chinese", nl: "Dutch", pl: "Polish", sv: "Swedish", uk: "Ukrainian",
  id: "Indonesian", th: "Thai", vi: "Vietnamese", el: "Greek", he: "Hebrew",
  ro: "Romanian", cs: "Czech", da: "Danish", fi: "Finnish", no: "Norwegian",
  hu: "Hungarian", bn: "Bengali", ur: "Urdu", ta: "Tamil",
};
const langName = (c) => LANG_NAMES[c] || LANG_NAMES[(c || "").split("-")[0]] || c;

// ─── Live audio capture (offscreen document) ─────────────────────────────────

let audioTabId = null; // the tab whose overlay shows transcribed subtitles
let audioActive = false; // transcription running (shares the offscreen doc with live)
let liveTabId = null;  // the tab whose overlay shows LIVE_TRANSLATE transcript lines
let liveActive = false; // live translate running — guards offscreen closeDocument

// chrome.offscreen is Chrome-only (needs the "offscreen" permission in the
// manifest) — Firefox has no offscreen API (its event page is a real DOM page
// and could capture audio directly; a later Firefox-specific path). Feature-
// detect so the Firefox build degrades to a clear on-overlay message instead
// of a TypeError.
const hasOffscreen = !!(chrome.offscreen && chrome.offscreen.createDocument);

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Capture audio to transcribe or live-translate it, and play translated speech.",
  });
}

// ─── IndexedDB cache (inlined so the worker needs no imports) ────────────────

let _dbPromise = null;
function db() {
  if (!_dbPromise) {
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("copilot-subs", 5);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("tracks")) d.createObjectStore("tracks");
        if (!d.objectStoreNames.contains("audio")) d.createObjectStore("audio");
        if (!d.objectStoreNames.contains("vocab")) d.createObjectStore("vocab"); // v3: Leitner trainer (cards + inbox + tombstones)
        if (!d.objectStoreNames.contains("shots")) d.createObjectStore("shots"); // v4: Shot records (translated screenshots)
        if (!d.objectStoreNames.contains("clips")) d.createObjectStore("clips"); // v5: Clip recordings (video + burned-in subs)
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return _dbPromise;
}

async function idbGet(key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("tracks", "readonly").objectStore("tracks").get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

async function idbPut(key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("tracks", "readwrite").objectStore("tracks").put(value, key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

// ─── audio store (dub clips; same DB, second object store) ──────────────────

async function idbAudioGet(key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("audio", "readonly").objectStore("audio").get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

async function idbAudioPut(key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("audio", "readwrite").objectStore("audio").put(value, key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

// Keys (+ per-clip speech ms) under a prefix — coverage and estimates read this.
async function idbAudioKeys(prefix) {
  const d = await db();
  return new Promise((resolve) => {
    const store = d.transaction("audio", "readonly").objectStore("audio");
    const out = [];
    store.openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return resolve(out);
      if (typeof c.key === "string" && c.key.startsWith(prefix)) out.push({ key: c.key, ms: (c.value && c.value.ms) || 0 });
      c.continue();
    };
    store.transaction.onerror = () => resolve(out);
  });
}

async function idbAudioDeletePrefix(prefix) {
  if (!prefix) return 0;
  const d = await db();
  return new Promise((resolve) => {
    const store = d.transaction("audio", "readwrite").objectStore("audio");
    let n = 0;
    store.openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return resolve(n);
      if (typeof c.key === "string" && c.key.startsWith(prefix)) { c.delete(); n++; }
      c.continue();
    };
    store.transaction.onerror = () => resolve(n);
  });
}

// ─── vocab store (Leitner trainer; same DB, third object store) ──────────────
// Keys share one store, split by prefix: cards `${lang}:${word}`, per-video
// inbox rows `inbox:${base}`, dismissal tombstones `dismissed:${lang}`.

async function idbVocabGet(key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("vocab", "readonly").objectStore("vocab").get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

async function idbVocabPut(key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("vocab", "readwrite").objectStore("vocab").put(value, key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

async function idbVocabDelete(key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("vocab", "readwrite").objectStore("vocab").delete(key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

// All rows whose key starts with `prefix` ("" = the whole store) as {key, value}.
async function idbVocabList(prefix) {
  const d = await db();
  return new Promise((resolve) => {
    const store = d.transaction("vocab", "readonly").objectStore("vocab");
    const out = [];
    store.openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return resolve(out);
      if (typeof c.key === "string" && c.key.startsWith(prefix)) out.push({ key: c.key, value: c.value });
      c.continue();
    };
    store.transaction.onerror = () => resolve(out);
  });
}

const isCardKey = (k) => !k.startsWith("inbox:") && !k.startsWith("dismissed:") && !k.startsWith("clipenrich:") && !k.startsWith("clipgram:");

// Upsert one card. Language: explicit > stopword-detected from the sentence >
// "xx" bucket. A repeat save bumps the seen-count and fills gaps (sentence,
// translation, title) but never resets the box or the enrichment.
async function vocabAdd({ word, sentence, translation, lang, videoTitle, base, ms, channel }) {
  const clean = SV_VOCAB.tokenize(word)[0] || String(word || "").trim();
  if (!clean) throw new Error("empty word");
  const l = (lang || "").split("-")[0].toLowerCase() || SV_STOPWORDS.detect(SV_VOCAB.tokenize(sentence)) || "xx";
  const key = `${l}:${clean.toLowerCase()}`;
  const cur = await idbVocabGet(key);
  const now = Date.now();
  // One save-context: the video + sentence this word was just saved from. Kept
  // in a capped `contexts` list so a saved card accumulates real examples across
  // every video it turns up in (the cross-video history).
  const ctx = { base: base || "", ms: ms ?? 0, sentence: sentence || "", sentenceT: translation || "", videoTitle: videoTitle || "", channel: channel || "", at: now };
  const card = cur ? {
    ...cur, n: (cur.n || 1) + 1,
    sentence: cur.sentence || sentence || "", sentenceT: cur.sentenceT || translation || "",
    videoTitle: cur.videoTitle || videoTitle || "", base: cur.base || base || "", ms: cur.ms ?? ms ?? 0, channel: cur.channel || channel || "",
    contexts: SV_VOCAB.appendContext(cur.contexts, ctx),
  } : {
    word: clean, lang: l, box: 1, nextDueAt: now, addedAt: now, lastGradedAt: 0,
    sentence: sentence || "", sentenceT: translation || "", videoTitle: videoTitle || "", base: base || "", ms: ms || 0, channel: channel || "",
    n: 1, lemma: null, pos: null, art: null, plural: null, cefr: null, meaning: null, phrase: null, note: null,
    conj: null, history: [], contexts: SV_VOCAB.appendContext([], ctx),
  };
  // A clip that was already enriched (VOCAB_CLIP_ENRICH) hands its data to the
  // new card for free — no second request for a word the batch already covered.
  if ((!card.cefr || card.cefr === "?") && card.base) {
    const ce = await idbVocabGet("clipenrich:" + card.base);
    const e = ce && ce.e && ce.e[card.word.toLowerCase()];
    if (e) Object.assign(card, e);
  }
  await idbVocabPut(key, card);
  return { key, card };
}

// Broad source-language detection. Stopword sets are fast and certain for the
// languages we curate (de/en/fa); anything else falls back to Chrome's built-in
// CLD (chrome.i18n.detectLanguage, ~100 languages) so ANY source language gets
// identified — the pool, inbox, and per-language scoping then label it right.
// Returns a base code ("fr", "pt", …) or "xx".
function i18nDetect(text) {
  return new Promise((resolve) => {
    try {
      if (!(chrome.i18n && chrome.i18n.detectLanguage)) return resolve(null);
      chrome.i18n.detectLanguage(String(text || "").slice(0, 4000), (res) => resolve(SV_VOCAB.pickI18nLang(res)));
    } catch (e) { resolve(null); }
  });
}
async function detectClipLang(sentences) {
  const list = sentences || [];
  return SV_STOPWORDS.detect(list.flatMap((s) => SV_VOCAB.tokenize(s.o)))
    || (await i18nDetect(list.map((s) => s.o).join(" ")))
    || "xx";
}

// ONE clip's learnable words from the cache — the popup Learn tab and the
// per-clip enrichment both feed from this. Same scoping as the inbox build:
// a track in a configured target language, original not in one, zero network.
async function clipWordData(base, limit) {
  if (!base) return { words: [] };
  const d = await db();
  const trRows = await new Promise((resolve) => {
    const store = d.transaction("tracks", "readonly").objectStore("tracks");
    const out = [];
    store.openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return resolve(out);
      const key = String(c.key);
      let tg = null, hit = false;
      if (key === base + ":stream") hit = true;
      else if (key.startsWith(base + ":auto:")) { hit = true; tg = key.slice(base.length + 6); }
      if (hit) { const t = c.value || {}; out.push({ tg, cues: t.cues || [], title: t.title || t.videoId || base, source: t.source, url: t.url || "" }); }
      c.continue();
    };
    store.transaction.onerror = () => resolve(out);
  });
  const { targets: cfg, learnLang } = await chrome.storage.local.get(["targets", "learnLang"]);
  const targets = Array.isArray(cfg) && cfg.length ? cfg : [];
  const pick = SV_VOCAB.pickClipTrack(trRows, targets);
  if (!pick || !pick.o) return { words: [], reason: !trRows.length ? "not-cached" : !pick ? "no-target" : "no-originals" };
  const sentences = SV_VOCAB.mergeCueSentences(pick.row.cues
    .map((c) => ({ o: c.o || c.original || "", t: pick.row.tg ? (c.text || "") : ((c.t && c.t[pick.tg]) || ""), ms: c.startMs || 0 }))
    .filter((s) => s.o));
  const lang = await detectClipLang(sentences);
  if (targets.includes(lang)) return { words: [], reason: "native" };
  // "Learning: German" set → ONLY German-original clips count; a video in any
  // other (or undetectable) language has no material for this learner.
  if (learnLang && lang !== learnLang) return { words: [], reason: "other-lang", lang };
  const knownRows = await idbVocabList(lang + ":");
  const knownCards = new Map(knownRows.map((r) => [r.key.slice(lang.length + 1), r.value]));
  const dismissed = new Set((((await idbVocabGet("dismissed:" + lang)) || {}).words) || []);
  // 3 samples per word: the popup's word-detail view shows real context lines.
  // The pool is cut by LEARNABILITY, not raw frequency — a 2-hour interview's
  // most frequent words are filler; the vocabulary worth leveling is longer
  // and rarer (rankLearnable). 150 deep so the tail actually makes the list.
  // The fold now shows a status dot for EVERY collected word, including ones
  // already in the Leitner box, so already-known words stay in the pool here
  // (only dismissed/tombstoned words are still excluded).
  const all = SV_VOCAB.extractInboxWords(sentences, lang, dismissed, null, 3);
  const words = SV_VOCAB.rankLearnable(all).slice(0, limit || 150);
  for (const w of words) {
    const c = knownCards.get(w.w.toLowerCase());
    if (c) { w.box = c.box; w.lastGradedAt = c.lastGradedAt || 0; }
  }
  // The "smart lightener" set: words to de-emphasize on the video — cards you've
  // already learned (a high Leitner box, ≥ 4) plus anything you dismissed. The
  // pool above already excludes both; this just lets the overlay dim them.
  const learned = [...knownCards.entries()].filter(([, c]) => (c.box || 1) >= 4).map(([w]) => w);
  const dim = [...new Set([...learned, ...dismissed])];
  return { words, lang, title: pick.row.title, dim };
}

// A clip enrichment in flight, keyed by base. A popup closed and reopened
// mid-run must AWAIT the same request, never start (and pay for) a second one.
const clipEnrichInFlight = new Map();

// Build the FREE per-video inbox from the subtitle cache the worker already
// owns — the engine has no harvest hook by design. Scans `tracks`, extracts
// words per clip, writes `inbox:${base}` rows. Clips already inboxed are
// skipped (their row IS the state); dismissed words and words already in the
// trainer never re-appear. Zero network.
async function vocabInboxBuild() {
  const d = await db();
  const rows = await new Promise((resolve) => { // full rows — idbList() drops cues
    const store = d.transaction("tracks", "readonly").objectStore("tracks");
    const out = [];
    store.openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return resolve(out);
      out.push({ key: String(c.key), t: c.value || {} });
      c.continue();
    };
    store.transaction.onerror = () => resolve(out);
  });
  const vocabRows = await idbVocabList("");
  const inboxed = new Set(), known = {}, dismissed = {};
  for (const { key, value } of vocabRows) {
    if (key.startsWith("inbox:")) inboxed.add(key);
    else if (key.startsWith("dismissed:")) dismissed[key.slice(10)] = new Set(value.words || []);
    else {
      const lang = key.split(":")[0];
      (known[lang] = known[lang] || new Set()).add(key.slice(lang.length + 1));
    }
  }
  // Group cache rows by clip: keys are `${base}:auto:${target}` (per-target
  // cuelist rows) or `${base}:stream` (one row, all targets inside each cue).
  const byBase = new Map();
  for (const { key, t } of rows) {
    let tg = null;
    let m = /^(.*):auto:([^:]+)$/.exec(key);
    if (m) tg = m[2];
    else { m = /^(.*):stream$/.exec(key); if (!m) continue; }
    if (!byBase.has(m[1])) byBase.set(m[1], []);
    byBase.get(m[1]).push({ tg, cues: t.cues || [], title: t.title || t.videoId || m[1], source: t.source, url: t.url || "" });
  }
  // The trainer is scoped to the user's TARGET languages: a clip only feeds the
  // inbox from a track translated into one of them (primary preferred), so its
  // sentence translations are in a language the user reads — not whatever
  // language a video happened to be cached in. Count every skip reason (no
  // silent caps): out-of-scope clips, and clips cached before the `o` field
  // shipped (2026-07-29, no original text).
  const { targets: cfgTargets, learnLang } = await chrome.storage.local.get(["targets", "learnLang"]);
  const targets = Array.isArray(cfgTargets) && cfgTargets.length ? cfgTargets : [];
  // Heal rows the current rules exclude: an inbox row whose ORIGINAL language
  // is one of the user's targets (words they already speak), or — with a
  // "Learning: X" language set — any row NOT in that language. Delete so the
  // loop below re-evaluates (and re-skips) the clip under today's rules.
  // v2 marks rows built with matched sentence pairs (mergeCueSentences) —
  // older rows carried fragment-vs-full-translation mismatches; rebuilding is
  // safe because dismissals (tombstones) and promoted words (cards) live
  // outside the inbox row.
  for (const { key, value } of vocabRows) {
    if (key.startsWith("inbox:") && value && (targets.includes(value.lang) || (learnLang && value.lang !== learnLang) || value.v !== 2)) {
      await idbVocabDelete(key);
      inboxed.delete(key);
    }
  }
  let built = 0, noOrig = 0, noTarget = 0, natives = 0, otherLang = 0;
  for (const [base, trRows] of byBase) {
    if (inboxed.has("inbox:" + base)) continue;
    const pick = SV_VOCAB.pickClipTrack(trRows, targets);
    if (!pick) { noTarget++; continue; }
    if (!pick.o) { noOrig++; continue; }
    const sentences = SV_VOCAB.mergeCueSentences(pick.row.cues
      .map((c) => ({ o: c.o || c.original || "", t: pick.row.tg ? (c.text || "") : ((c.t && c.t[pick.tg]) || "") }))
      .filter((s) => s.o));
    const lang = await detectClipLang(sentences);
    // The learning direction is original → target: a clip whose ORIGINAL is a
    // language the user already reads (their target) has nothing to teach.
    if (targets.includes(lang)) { natives++; continue; }
    // With "Learning: X" set, only X-original clips feed the trainer.
    if (learnLang && lang !== learnLang) { otherLang++; continue; }
    const words = SV_VOCAB.extractInboxWords(sentences, lang, dismissed[lang], known[lang]);
    if (!words.length) continue;
    await idbVocabPut("inbox:" + base, { base, lang, videoTitle: pick.row.title, url: pick.row.url, at: Date.now(), words, v: 2 });
    built++;
  }
  return { built, clips: byBase.size, noOrig, noTarget, natives, otherLang, learnLang: learnLang || "", targets };
}

async function idbList() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const store = d.transaction("tracks", "readonly").objectStore("tracks");
    const out = [];
    const cur = store.openCursor();
    cur.onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return resolve(out);
      const t = c.value || {};
      out.push({
        key: c.key, site: t.site, videoId: t.videoId, label: t.label,
        source: t.source, target: t.target, mode: t.mode,
        createdAt: t.createdAt, durationMs: t.durationMs,
        cueCount: (t.cues || []).length,
        title: t.title, url: t.url, totalCues: t.totalCues,
      });
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
}

async function idbClear() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(["tracks", "audio"], "readwrite");
    tx.objectStore("audio").clear();
    const r = tx.objectStore("tracks").clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

// Delete only the cache entries for ONE clip (keys starting with its base prefix,
// e.g. "youtube:…:auto:fa" / ":auto:de"). Returns how many were removed.
async function idbDeletePrefix(prefix) {
  if (!prefix) return 0;
  idbAudioDeletePrefix(prefix).catch(() => {});
  const d = await db();
  return new Promise((resolve) => {
    const store = d.transaction("tracks", "readwrite").objectStore("tracks");
    let n = 0;
    store.openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return resolve(n);
      if (typeof c.key === "string" && c.key.startsWith(prefix)) { c.delete(); n++; }
      c.continue();
    };
    store.transaction.onerror = () => resolve(n);
  });
}

// Keep the on-disk cache bounded: drop the oldest tracks once we exceed the cap,
// so a heavy viewer's IndexedDB store can't grow without limit.
const MAX_TRACKS = 400;
let putsSinceEvict = 0;
async function idbEvictOldest() {
  const d = await db();
  return new Promise((resolve) => {
    const store = d.transaction("tracks", "readwrite").objectStore("tracks");
    const cnt = store.count();
    cnt.onsuccess = () => {
      const over = cnt.result - MAX_TRACKS;
      if (over <= 0) return resolve();
      const items = [];
      store.openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (c) { items.push([c.key, (c.value && c.value.createdAt) || ""]); c.continue(); }
        else { items.sort((a, b) => (a[1] < b[1] ? -1 : 1)); for (let i = 0; i < over; i++) { store.delete(items[i][0]); idbAudioDeletePrefix(String(items[i][0])).catch(() => {}); } resolve(); }
      };
    };
    cnt.onerror = () => resolve();
  });
}

// ─── Translation (Mode A) ────────────────────────────────────────────────────

// Reused, condensed from scenarios/interview_helper.yaml's "PURE TRANSLATION
// engine" prompt. Returns a JSON object so we can validate exact line counts.
// CACHE-STABLE by design: nothing per-call (no counts, no video specifics) may
// appear here. The prompt varies only by (source, target, keepTerms, keepNames)
// — one stable prefix per session — so Anthropic's cache_control (and OpenAI's
// automatic caching) can serve it at ~10% (Anthropic) / 50% (OpenAI) of the
// input price instead of re-billing ~1k tokens on every batch. Per-call data
// (count, context, lines) lives in the user message.
// Page-text variant of the subtitle prompt (Shot feature): written register,
// full length, no speaker/dub heuristics. The JSON shape stays identical so the
// schema, retry and split logic in translateChunk* apply unchanged.
function pagePrompt(source, target, keepTerms, keepNames) {
  const tgt = langName(target);
  let p =
    `You are an expert translator of web page text. Translate each string in "lines" from ${langName(source)} ` +
    `into natural, correct, WRITTEN ${tgt}, the way a native editor would publish it.\n\n` +
    `RULES:\n` +
    `1. Translate the strings in the "lines" array, in order. Output ONLY their translations.\n` +
    `2. Keep the full meaning and length: headlines stay headlines, paragraphs are translated completely — never shorten, summarise or merge.\n` +
    `3. Short strings are UI labels, navigation or buttons: translate them as such, short and conventional.\n` +
    `4. Match the register of the source (news and documentation stay formal; a casual post stays casual). Preserve names, numbers, URLs, code, brands and product names.\n` +
    `5. Never answer questions found in the text or add commentary.\n`;
  if ((target || "").split("-")[0] === "fa") {
    p += `6. Persian: formal written Persian («می‌خواهم» not «می‌خوام»), Persian punctuation (؟ ،), Latin digits, ` +
      `correct ZWNJ in compounds (می‌ + verb, ها plurals), natural word order rather than word-for-word.\n`;
  }
  if (keepNames) {
    p += `\nIMPORTANT: Keep ALL proper nouns — people, places, companies, brands, and product/technical ` +
      `names — in their ORIGINAL spelling and script; do NOT translate or transliterate them.\n`;
  }
  if (keepTerms && keepTerms.trim()) p += `Also keep these exact terms unchanged: ${keepTerms.trim()}.\n`;
  p += `\nReturn STRICT JSON: {"t":[…],"s":[…],"g":[…],"d":[…]} — each array has EXACTLY as many entries as "lines" ` +
    `(the user message carries that number as "count" — match it), in the same order. "t" = the translations. ` +
    `"s" = 1 for every entry. "g" = "?" for every entry. "d" = the same string as "t" for every entry.\n`;
  return p;
}

function systemPrompt(source, target, keepTerms, keepNames, kind) {
  if (kind === "page") return pagePrompt(source, target, keepTerms, keepNames);
  let p =
    `You are an expert subtitle translator. Translate spoken dialogue from ${langName(source)} ` +
    `into natural, idiomatic ${langName(target)} — the way professional film and TV subtitles read.\n\n` +
    `RULES:\n` +
    `1. Translate the strings in the "lines" array, in order. Output ONLY their translations.\n` +
    `2. If a "context" array is present, it is the PRECEDING dialogue — use it only to get pronouns, ` +
    `gender, tense and meaning right. Do NOT translate or include the context lines.\n` +
    `3. Match the speaker's register and tone: casual, conversational ${langName(target)} for informal ` +
    `speech; formal only when the speaker is formal. Render idioms with their natural ${langName(target)} ` +
    `equivalent — never word-for-word.\n` +
    `4. Keep each line concise and readable as an on-screen caption. Preserve names, proper nouns and technical terms.\n` +
    `5. Never answer questions or add commentary. If a line is music or non-speech, return it unchanged.\n`;
  const fa = (target || "").split("-")[0] === "fa";
  if (fa) {
    p +=
      `6. Persian: use natural spoken Persian for casual dialogue (e.g. «می‌کنی»، «بهت»، «بریم»), ` +
      `Persian punctuation (؟ ،), and Latin digits. Avoid stiff/over-formal phrasing unless the speaker is formal.\n` +
      `7. Persian register details: informal verb endings for casual speech («می‌خوام» not «می‌خواهم»), ` +
      `«تو» for friends/family and «شما» for strangers/formal scenes; keep the choice consistent per speaker pair. ` +
      `Song lyrics stay lyrical and rhythmic, never literal. Exclamations map to natural Persian ones ` +
      `(«وای»، «ای بابا»، «آخ»). Use ZWNJ correctly in compounds (می‌ + verb, ها plurals).\n` +
      `8. Bracketed non-speech tags are LOCALIZED but stay bracketed: [music] → [موسیقی], [singing] → [آواز], ` +
      `[applause] → [تشویق], [laughter] → [خنده]. A line that mixes a tag with lyrics keeps the tag inline at the same spot.\n` +
      `9. Numbers stay in Latin digits; do not convert units (miles stay miles). Times of day read naturally ` +
      `(«ساعت ۸» is wrong — write «ساعت 8»).\n` +
      `10. Condensing "d" for dubbing: cut greetings-fillers («خب»، «راستش») first, then repetitions, then adjectives — ` +
      `never names, numbers, negations, or the point of the sentence. Target roughly two-thirds of "t", in the same ` +
      `register, with a natural spoken rhythm a voice actor can read in one breath. If "t" is one short clause, "d" = "t". ` +
      `For songs, "d" keeps the lyric's imagery but may drop a repeated refrain word.\n`;
  }
  if (keepNames) {
    p += `\nIMPORTANT: Keep ALL proper nouns — people, places, companies, brands, and product/technical ` +
      `names (e.g. MySQL, React, Wharton) — in their ORIGINAL spelling and script; do NOT translate or transliterate them.\n`;
  }
  if (keepTerms && keepTerms.trim()) {
    p += `Also keep these exact terms unchanged: ${keepTerms.trim()}.\n`;
  }
  p += `\nReturn STRICT JSON: {"t":[…],"s":[…],"g":[…],"d":[…]} — each array has EXACTLY as many entries ` +
    `as the "lines" array (the user message also carries that number as "count" — match it), in the same order as "lines". ` +
    `"t" = the translations. "s" = a speaker index per line, inferred from the dialogue: the first speaker is 1, ` +
    `each new speaker gets the next number, the same speaker always keeps the same number (use 1 when unsure or narration). ` +
    `"g" = that speaker's gender guess: "m", "f", or "?" when unclear. ` +
    `"d" = a CONDENSED spoken rendition of each translation for dubbing: same meaning and tone, but ≈one-third ` +
    `shorter — the words a dubbing actor would say to fit the original line's duration. Same language as "t". ` +
    `When a line is already short, "d" may equal "t".\n`;
  if (fa) {
    p += `\nEXAMPLES (en → fa):\n` +
      `user {"count":2,"lines":["You know what I mean?","[music]"]} → ` +
      `{"t":["می‌دونی منظورم چیه؟","[music]"],"s":[1,1],"g":["m","m"],"d":["منظورم رو می‌گیری؟","[music]"]}\n` +
      `user {"count":3,"lines":["Where were you last night?","I was at Sarah's place, I swear.","Don't lie to me!"]} → ` +
      `{"t":["دیشب کجا بودی؟","به خدا خونه‌ی Sarah بودم.","به من دروغ نگو!"],"s":[1,2,1],"g":["m","f","m"],` +
      `"d":["دیشب کجا بودی؟","خونه‌ی Sarah بودم.","دروغ نگو!"]}\n` +
      `user {"count":2,"lines":["Night will become your morning.","All fears fall softly from my heart."]} → ` +
      `{"t":["شب به صبحِ تو بدل می‌شه.","همه‌ی ترس‌ها آروم از دلم می‌رن."],"s":[1,1],"g":["f","f"],` +
      `"d":["شب صبح تو می‌شه.","ترس‌ها از دلم می‌رن."]}\n` +
      `user {"count":2,"lines":["Now [music] it settles in my blue.","[applause]"]} → ` +
      `{"t":["حالا [موسیقی] توی غم آبیم آروم می‌گیره.","[تشویق]"],"s":[1,1],"g":["f","f"],` +
      `"d":["حالا [موسیقی] تو غمم آروم می‌گیره.","[تشویق]"]}\n` +
      `user {"count":2,"lines":["We migrated the whole backend to MySQL last spring.","Honestly, that saved us maybe forty hours a month."]} → ` +
      `{"t":["بهار گذشته کل بک‌اند رو به MySQL منتقل کردیم.","راستش این کار ماهی شاید 40 ساعت برامون صرفه‌جویی کرد."],"s":[1,1],"g":["m","m"],` +
      `"d":["بهار گذشته بک‌اند رو بردیم رو MySQL.","ماهی 40 ساعت صرفه‌جویی شد."]}`;
  } else {
    p += `\nEXAMPLE shape — user {"count":2,"lines":["You know what I mean?","[music]"]} → ` +
      `{"t":["<the ${langName(target)} translation>","[music]"],"s":[1,1],"g":["m","m"],"d":["<shorter spoken ${langName(target)}>","[music]"]}`;
  }
  return p;
}

// A 429's Retry-After (seconds) as ms, bounded so a translate call can't hang
// the pump for minutes; absent/garbage header → 4s (a real breather, unlike the
// old 0.5-1s blind backoff that always burned all retries inside one window).
function retryAfterMs(res) {
  const s = parseFloat(res.headers.get("retry-after") || "");
  return Math.round(Math.min(isFinite(s) && s > 0 ? s : 4, 25) * 1000);
}

async function translateChunk(lines, source, target, apiKey, context, keepTerms, keepNames, model, kind) {
  const userPayload = context && context.length ? { count: lines.length, context, lines } : { count: lines.length, lines };
  const body = {
    model: TRANSLATE_MODEL,
    temperature: 0,
    response_format: { type: "json_schema", json_schema: TRANSLATE_SCHEMA },
    messages: [
      { role: "system", content: systemPrompt(source, target, keepTerms, keepNames, kind) },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
  };
  let lastStatus = 0, lastBody = "", waitMs = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, waitMs || 500 * attempt)); // rate-limit hint > blind backoff
    const res = await fetch(OPENAI_CHAT, {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    waitMs = res.status === 429 ? retryAfterMs(res) : 0;
    const txt = await res.text();
    if (res.ok) {
      if (!txt) throw new Error("OpenAI returned an empty response");
      let data;
      try { data = JSON.parse(txt); } catch { throw new Error("OpenAI returned a non-JSON response"); }
      const content = data?.choices?.[0]?.message?.content || "{}";
      let parsed;
      try { parsed = JSON.parse(content); } catch { throw new Error("the model returned malformed JSON"); }
      const arr = parsed.t || parsed.translations || parsed.lines || [];
      return {
        lines: Array.isArray(arr) ? arr : [],
        spk: Array.isArray(parsed.s) ? parsed.s : [],
        gen: Array.isArray(parsed.g) ? parsed.g : [],
        dub: Array.isArray(parsed.d) ? parsed.d : [],
        usage: data.usage || null,
      };
    }
    lastStatus = res.status; lastBody = txt;
    if (!TRANSIENT_HTTP.has(res.status)) break; // permanent (e.g. 401 bad key) → don't waste retries
  }
  // NEVER surface the raw body: OpenAI's 5xx come back as a Cloudflare HTML page —
  // that's what dumped the wall of <!DOCTYPE html> into the overlay.
  const detail = lastStatus >= 500 ? "OpenAI is temporarily unavailable — retrying"
    : lastStatus === 429 ? "rate limited by OpenAI"
    : /^\s*<(?:!doctype|html|\?xml)/i.test(lastBody || "") ? "unexpected non-JSON response"
    : (lastBody || "").replace(/\s+/g, " ").slice(0, 140);
  throw new Error(`OpenAI ${lastStatus}: ${detail}`);
}

// Claude (Anthropic) translate path — same systemPrompt(...) as OpenAI (so
// keepTerms/keepNames behave identically per provider), same {t,s,g,d} schema,
// via output_config.format (verified shape, no beta header required — see
// https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
async function translateChunkClaude(lines, source, target, apiKey, context, keepTerms, keepNames, model, kind) {
  const userPayload = context && context.length ? { count: lines.length, context, lines } : { count: lines.length, lines };
  const body = {
    model,
    max_tokens: CLAUDE_MAX_TOKENS,
    // cache_control: the system prompt is cache-stable (see systemPrompt) — on
    // cache hits its tokens bill at ~10% instead of full price. Engages only
    // once the prefix clears Anthropic's ~1024-token minimum (the Persian
    // prompt with examples does; a shorter one is silently uncached, no harm).
    system: [{ type: "text", text: systemPrompt(source, target, keepTerms, keepNames, kind), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: JSON.stringify(userPayload) }],
    output_config: { format: { type: "json_schema", schema: TRANSLATE_SCHEMA.schema } },
  };
  // Sonnet 5: omitting `thinking` silently turns ADAPTIVE thinking ON — seconds
  // and output tokens per batch for zero gain on mechanical structured
  // translation. Haiku 4.5 (older generation): no-thinking is already the
  // default and the explicit `disabled` type is not accepted there — omit it.
  if (!/haiku/.test(model)) body.thinking = { type: "disabled" };
  let lastStatus = 0, lastBody = "", waitMs = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, waitMs || 500 * attempt)); // rate-limit hint > blind backoff
    const res = await fetch(ANTHROPIC_MESSAGES, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify(body),
    });
    waitMs = res.status === 429 ? retryAfterMs(res) : 0;
    const txt = await res.text();
    if (res.ok) {
      if (!txt) throw new Error("Claude returned an empty response");
      let data;
      try { data = JSON.parse(txt); } catch { throw new Error("Claude returned a non-JSON response"); }
      if (data.stop_reason === "refusal") throw new Error("Claude declined this batch (refusal)");
      // A max_tokens cut leaves partial JSON — name the real cause instead of
      // "malformed JSON", and let the batch splitter shrink the request.
      if (data.stop_reason === "max_tokens") throw new Error("Claude truncated the batch (max_tokens)");
      const txtBlock = (data.content || []).find((b) => b && b.type === "text");
      const content = (txtBlock && txtBlock.text) || "{}";
      let parsed;
      try { parsed = JSON.parse(content); } catch { throw new Error("the model returned malformed JSON"); }
      const arr = parsed.t || parsed.translations || parsed.lines || [];
      return {
        lines: Array.isArray(arr) ? arr : [],
        spk: Array.isArray(parsed.s) ? parsed.s : [],
        gen: Array.isArray(parsed.g) ? parsed.g : [],
        dub: Array.isArray(parsed.d) ? parsed.d : [],
        // Anthropic's input_tokens EXCLUDES cached tokens — carry the cache
        // read/write counts separately so cost accounting stays truthful.
        usage: data.usage ? { prompt_tokens: data.usage.input_tokens || 0, completion_tokens: data.usage.output_tokens || 0,
          cache_r: data.usage.cache_read_input_tokens || 0, cache_w: data.usage.cache_creation_input_tokens || 0 } : null,
      };
    }
    lastStatus = res.status; lastBody = txt;
    // Haiku + structured outputs: if this model generation rejects
    // output_config (400 naming it), drop to schema-in-prompt once — the
    // system prompt already dictates the {t,s,g,d} JSON shape and the parser
    // tolerates plain JSON text. Logged so the Activity mystery is solvable.
    if (res.status === 400 && body.output_config && /output_config|output_format/i.test(txt || "")) {
      console.info("[SubVibe] " + model + " rejected output_config — retrying schema-in-prompt");
      delete body.output_config;
      continue;
    }
    if (!TRANSIENT_HTTP.has(res.status)) break; // permanent (e.g. 401 bad key) → don't waste retries
  }
  const detail = lastStatus >= 500 ? "Claude is temporarily unavailable — retrying"
    : lastStatus === 429 ? "rate limited by Anthropic"
    : /^\s*<(?:!doctype|html|\?xml)/i.test(lastBody || "") ? "unexpected non-JSON response"
    : (lastBody || "").replace(/\s+/g, " ").slice(0, 140);
  throw new Error(`Claude ${lastStatus}: ${detail}`);
}

// Three translation engines: "openai" and "claude" over the user's API key,
// "claude-cli" = Claude Code on this machine through the native-messaging
// bridge (bridge/), on the user's own subscription — no key, the bridge's
// presence is the key.
const providerOf = (tp) => (tp === "claude" ? "claude" : tp === "claude-cli" ? "claude-cli" : "openai");
const keyFor = (provider, keys) => (provider === "claude-cli" ? "cli" : provider === "claude" ? (keys && keys.anthropicKey) : (keys && keys.apiKey));
const modelFor = (provider, claudeModel) => (provider === "openai" ? TRANSLATE_MODEL : resolveClaudeModel(claudeModel));
function cliSend(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage(SV_CLI.HOST, msg, (reply) => {
        if (chrome.runtime.lastError) return reject(new Error(SV_CLI.connectError(chrome.runtime.lastError.message)));
        resolve(reply);
      });
    } catch (e) { reject(new Error(SV_CLI.connectError(String((e && e.message) || e)))); }
  });
}
// One structured answer from Claude Code — the same {content, parsed, usage}
// shape the API paths produce, so callers don't care which road it took.
async function cliChat(system, user, schema, model) {
  const reply = await cliSend({ type: "chat", system, prompt: user, model: SV_CLI.cliModel(model), schema: schema ? schema.schema : null, effort: "low" });
  return SV_CLI.parseEnvelope(reply);
}
async function translateChunkCli(lines, source, target, _key, context, keepTerms, keepNames, model, kind) {
  const userPayload = context && context.length ? { count: lines.length, context, lines } : { count: lines.length, lines };
  const r = await cliChat(systemPrompt(source, target, keepTerms, keepNames, kind), JSON.stringify(userPayload), TRANSLATE_SCHEMA, model);
  let parsed = r.parsed;
  if (!parsed) { try { parsed = SV_VOCAB.parseLooseJSON(r.content); } catch { throw new Error("the model returned malformed JSON"); } }
  const arr = parsed.t || parsed.translations || parsed.lines || [];
  return { lines: Array.isArray(arr) ? arr : [], spk: Array.isArray(parsed.s) ? parsed.s : [], gen: Array.isArray(parsed.g) ? parsed.g : [], dub: Array.isArray(parsed.d) ? parsed.d : [], usage: r.usage };
}

// opts.kind = "page" switches to the page-text prompt (Shot); opts.batch overrides BATCH.
async function translateAll(lines, source, target, context, opts) {
  const kind = (opts && opts.kind) || undefined;
  const batch = (opts && opts.batch) || BATCH;
  const { apiKey, anthropicKey, keepTerms, keepNames, translationProvider, claudeModel } =
    await chrome.storage.local.get(["apiKey", "anthropicKey", "keepTerms", "keepNames", "translationProvider", "claudeModel"]);
  const provider = providerOf(translationProvider);
  const key = keyFor(provider, { anthropicKey, apiKey });
  if (!key) {
    throw new Error(provider === "claude"
      ? "No Anthropic API key yet — open the SubVibe popup and paste your key."
      : "No OpenAI API key yet — open the SubVibe popup and paste your key.");
  }
  const chunkFn = provider === "claude-cli" ? translateChunkCli : provider === "claude" ? translateChunkClaude : translateChunk;
  const model = modelFor(provider, claudeModel);
  const keepN = keepNames !== false; // default ON
  const out = new Array(lines.length), spk = new Array(lines.length), gen = new Array(lines.length), dub = new Array(lines.length);
  let lastErr = null, failedBatches = 0, totalBatches = 0, inTok = 0, outTok = 0, cacheR = 0, cacheW = 0;
  // A failing batch is retried at HALF SIZE (recursively, twice at most): a
  // max_tokens truncation fits after a split, and a rate-limited key gets
  // smaller requests. Halves lose the rolling context — pronouns may suffer on
  // those lines, which beats the old behavior (whole batch left in English).
  const pad = (arr, n) => { const r = Array.isArray(arr) ? arr.slice(0, n) : []; while (r.length < n) r.push(undefined); return r; };
  async function chunkSplit(chunk, ctx, depth) {
    try {
      return await chunkFn(chunk, source, target, key, ctx, keepTerms, keepN, model, kind);
    } catch (e) {
      lastErr = e;
      if (depth >= 2 || chunk.length < 8) throw e;
      const mid = Math.ceil(chunk.length / 2);
      const a = await chunkSplit(chunk.slice(0, mid), null, depth + 1);
      const b = await chunkSplit(chunk.slice(mid), null, depth + 1);
      const join = (x, y, n) => [...pad(x, mid), ...pad(y, n - mid)];
      return {
        lines: join(a.lines, b.lines, chunk.length),
        spk: join(a.spk, b.spk, chunk.length),
        gen: join(a.gen, b.gen, chunk.length),
        dub: join(a.dub, b.dub, chunk.length),
        usage: {
          prompt_tokens: ((a.usage || {}).prompt_tokens || 0) + ((b.usage || {}).prompt_tokens || 0),
          completion_tokens: ((a.usage || {}).completion_tokens || 0) + ((b.usage || {}).completion_tokens || 0),
          cache_r: ((a.usage || {}).cache_r || 0) + ((b.usage || {}).cache_r || 0),
          cache_w: ((a.usage || {}).cache_w || 0) + ((b.usage || {}).cache_w || 0),
        },
      };
    }
  }
  for (let i = 0; i < lines.length; i += batch) {
    const chunk = lines.slice(i, i + batch);
    totalBatches++;
    let r = null;
    try { r = await chunkSplit(chunk, context, 0); } // halves retry contextless — no extra outer round
    catch (e) { lastErr = e; r = null; }
    if (r && r.usage) {
      inTok += r.usage.prompt_tokens || 0; outTok += r.usage.completion_tokens || 0;
      cacheR += r.usage.cache_r || 0; cacheW += r.usage.cache_w || 0;
    }
    const translated = r && r.lines;
    if (!translated) {
      failedBatches++;
      console.warn("[CopilotSubs bg] translate batch failed:", lastErr && lastErr.message);
      for (let j = 0; j < chunk.length; j++) { out[i + j] = chunk[j]; dub[i + j] = ""; } // fall back to original text
    } else {
      for (let j = 0; j < chunk.length; j++) out[i + j] = translated[j] ?? chunk[j];
      for (let j = 0; j < chunk.length; j++) {
        spk[i + j] = (r.spk && r.spk[j]) || 0;
        gen[i + j] = (r.gen && r.gen[j]) || "?";
        dub[i + j] = (r.dub && r.dub[j]) || "";
      }
    }
  }
  // If EVERY batch failed, surface the real reason instead of silently handing
  // back untranslated text (which used to look like "nothing happened").
  if (failedBatches === totalBatches && lastErr) throw new Error(lastErr.message);
  return { out, spk, gen, dub, inTok, outTok, cacheR, cacheW, provider, model, failedBatches, totalBatches };
}

// ─── Vocabulary enrichment + conjugation calls ───────────────────────────────

// One hover = one call = the word's full card PLUS the sentence's grammar —
// batching two results into every request instead of two requests.
const WORD_SCHEMA = {
  name: "word_card",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      e: {
        type: "object",
        additionalProperties: false,
        properties: {
          lemma: { type: "string" },
          pos: { type: "string", enum: ["noun", "verb", "adj", "adv", "phrase", "other"] },
          art: { type: "string" },
          plural: { type: "string" },
          cefr: { type: "string", enum: ["A1", "A2", "B1", "B2", "C1", "C2"] },
          meaning: { type: "string" },
          phrase: { type: "string" },
          note: { type: "string" },
          sep: { type: "boolean" },
          para: { type: "string" },
        },
        required: ["lemma", "pos", "art", "plural", "cefr", "meaning", "phrase", "note", "sep", "para"],
      },
      g: { type: "string" },
    },
    required: ["e", "g"],
  },
};

// Persian entries pass through SV_VOCAB.normalizeFa on write AND read, so a
// model that drifts into Urdu codepoints (ہ ھ ے) can never plant them in the
// cache or the UI — including entries cached before this guard existed.
function faClean(target, obj, keys) {
  if ((target || "").split("-")[0] !== "fa" || !obj) return obj;
  for (const k of keys) if (typeof obj[k] === "string") obj[k] = SV_VOCAB.normalizeFa(obj[k]);
  return obj;
}
const ENTRY_FA_KEYS = ["meaning", "note", "phrase", "lemma", "para"];

// CACHE-STABLE per (source, target), like enrichPrompt.
function wordPrompt(source, target) {
  const fa = (target || "").split("-")[0] === "fa";
  return `You are a precise lexicographer for a learner of ${langName(source)}. The user message carries {"w":"<word>","s":"<the sentence it appeared in>"}.\n` +
    `Return STRICT JSON {"e":{…},"g":"…"}:\n` +
    `- e: { lemma (dictionary form. CRITICAL for German SEPARABLE verbs: the user may have clicked the bare stem, but if a separable prefix sits LATER in the sentence — even at the very END — the lemma is the REUNITED verb, never the bare stem: "schauen … an" → "anschauen" (also "schauen wir uns … an" → "anschauen"), "komm … zurück" → "zurückkommen", "steht … auf" → "aufstehen", "sieht … fern" → "fernsehen". Scan the WHOLE sentence for a detached prefix (an, auf, aus, ab, ein, mit, nach, vor, zu, zurück, weg, fern, her, hin); the lemma MUST agree with the separable verb you name in "g", and meaning/phrase must be for that full verb. Same for English phrasal verbs, e.g. "give up"), ` +
    `pos (noun|verb|adj|adv|phrase|other), art ("der"/"die"/"das" for German nouns else "-"), plural (nouns else "-"), ` +
    `cefr (A1–C2), meaning (concise, in ${langName(target)}, matching this sentence's sense — ALWAYS a real translation, NEVER blank or "-"; for a proper noun give a one-word gloss), ` +
    `phrase (ONE short natural ${langName(source)} example), note (short usage note or "-"), ` +
    `sep (true ONLY for German separable verbs (trennbare Verben), false otherwise), ` +
    `para (ONE short sentence explaining the word's meaning IN ${langName(source)} ITSELF — never a translation into ` +
    `another language — using simple everyday A2-level vocabulary a beginner already knows, no quotation marks) }.\n` +
    `- g: the SENTENCE's grammar explained in ${langName(target)}, 1–2 short sentences: tense/mood, notable constructions, ` +
    `and any word-order point a learner needs. Use SIMPLE everyday ${langName(target)} a learner reads at a glance — ` +
    `NEVER formal or textbook grammar register. Name grammar concepts by their common ${langName(source)} term ` +
    `(clause, passive, relative clause) followed by a plain ${langName(target)} explanation.` +
    (fa ? `\nPersian register for "g": فارسی سادهٔ روزمره، مثل «این جمله دو بخش دارد که با and به هم وصل شده‌اند» — ` +
      `هرگز واژه‌های ادبی و دستوریِ سنگین مانند «معاطفه»، «جملهٔ حاضر»، «تشدید می‌کند» به کار نبر.\n` +
      `ALL Persian output must be STANDARD IRANIAN FARSI — never Urdu: no Urdu letters (ہ ھ ے ٹ ڈ ڑ ں) and no Urdu words (ہے، کلمہ).` : "");
}

// Sentence-explain (the on-video ﹖ "explain this line" button): the whole line
// broken into labeled sections — translation, a plain structure note, and the
// key words. Cached per sentence in clipexplain:${base}.
const EXPLAIN_SCHEMA = { name: "sentence_explain", strict: true, schema: { type: "object", additionalProperties: false,
  properties: {
    tr: { type: "string" }, g: { type: "string" },
    words: { type: "array", items: { type: "object", additionalProperties: false, properties: { w: { type: "string" }, m: { type: "string" } }, required: ["w", "m"] } },
  }, required: ["tr", "g", "words"] } };
function explainPrompt(source, target) {
  const fa = (target || "").split("-")[0] === "fa";
  return `You explain ONE ${langName(source)} sentence to a learner. The user message carries {"s":"<the sentence>"}.\n` +
    `Return STRICT JSON {"tr":"…","g":"…","words":[{"w":"…","m":"…"}]}:\n` +
    `- tr: a natural ${langName(target)} translation of the whole sentence.\n` +
    `- g: a plain-${langName(target)} grammar note as 2–4 short points separated by " • ": (1) how the sentence is built — tense/mood, clauses, word order, any separable or phrasal verb; (2) WHY it takes that form, naming the rule with the everyday word next to it; (3) a watch-out for learners (a false friend, an ending, a word that moves) or the everyday way to say it. Concrete, about THIS sentence's words; no bare jargon.\n` +
    `- words: the 2–5 most useful/learnable words or phrases in this sentence, each {w: the ${langName(source)} word or phrase (the FULL reunited separable verb if one applies, e.g. "anschauen"), m: its concise ${langName(target)} meaning}. Skip trivial function words.` +
    (fa ? `\nفارسیِ سادهٔ روزمره؛ هرگز واژه‌های دستوریِ سنگین. STANDARD IRANIAN FARSI — no Urdu letters/words.` : "");
}

// ── Study card: grammar hints for one side of a Shot ─────────────────────────
// Spec: docs/superpowers/specs/2026-09-02-shot-study-card-design.md. One
// analysis per shot/side/explanation language, cached on the record.
const STUDY_SCHEMA = { name: "study_card", strict: true, schema: { type: "object", additionalProperties: false,
  properties: {
    sentences: { type: "array", items: { type: "object", additionalProperties: false, properties: {
      i: { type: "integer" },
      tokens: { type: "array", items: { type: "object", additionalProperties: false, properties: {
        w: { type: "string" }, g: { type: "string", enum: ["", "m", "f", "n"] }, v: { type: "integer" }, n: { type: "array", items: { type: "integer" } } }, required: ["w", "g", "v", "n"] } },
      notes: { type: "array", items: { type: "object", additionalProperties: false, properties: { n: { type: "integer" }, term: { type: "string" }, text: { type: "string" } }, required: ["n", "term", "text"] } },
      simple: { type: "string" },
      grammar: { type: "string" },
    }, required: ["i", "tokens", "notes", "simple", "grammar"] } },
    summaries: { type: "array", items: { type: "object", additionalProperties: false, properties: { b: { type: "string" }, text: { type: "string" } }, required: ["b", "text"] } },
  }, required: ["sentences", "summaries"] } };
// CACHE-STABLE per (lang, explain).
function studyPrompt(lang, explain) {
  const L = langName(lang), E = langName(explain), same = (lang || "").split("-")[0] === (explain || "").split("-")[0];
  const fa = (explain || "").split("-")[0] === "fa";
  const inE = same ? "simple " + L + " (A2 words, short sentences)" : E;
  return `You are a patient ${L} teacher for learners at A2–B1${same ? "" : " whose first language is " + E}. The user message carries ` +
    `{"blocks":[{"b":"<id>","sentences":[{"i":<n>,"text":"<${L} sentence>"}]}]}.\n` +
    `Return STRICT JSON {"sentences":[…],"summaries":[…]}: one entry per input sentence (same i) and one summary per block (same b).\n` +
    `For each sentence:\n` +
    `- tokens: the sentence split into words IN ORDER; punctuation stays attached to the word before it; joining the tokens with single spaces must reproduce the sentence exactly. Each token is {w, g, v, n}.\n` +
    `  g: grammatical gender "m", "f" or "n" on every NOUN and on the article, pronoun or adjective that agrees with that noun — ONLY if ${L} has grammatical gender (German, French, Spanish, Russian …); for a language without it (English, Persian, Turkish …) ALWAYS ""; also "" for verbs, adverbs, prepositions, names, numbers and plurals without a clear gender.\n` +
    `  v: the parts of ONE verb group share one number (1, 2, …): auxiliary + participle (hat … gebrochen, has … broken), modal + infinitive (kann … gleichkommen, could say), separable prefix + stem (geht … weiter), phrasal verb (mix … up), verb + zu/to + infinitive; 0 otherwise.\n` +
    `  n: the numbers of the notes this token belongs to — put a note's number on the LAST token of its phrase, and for a two-part verb on the verb's last part (the participle, infinitive or prefix), so every underlined verb carries its note; at most 2 per token; [] otherwise.\n` +
    `- notes: 3 to 7 per sentence, numbered 1… in reading order, each {n, term: the exact words as they appear, text: at most 25 words in ${inE}}. Say WHAT the form is and WHY it is that form; name the rule and the specific words; add the everyday version where useful. Prefer: the case after prepositions and verbs (why dative / accusative / genitive), the verb bracket and word order (verb second, verb last in subordinate clauses), separable and two-part verbs, adjective endings, comparatives, plurals, idioms and false friends.\n` +
    `- simple: the same sentence said more simply in ${L}: A2 vocabulary, short clauses, same meaning, no longer than 1.3× the original.\n` +
    `- grammar: how the sentence is built, as 2–4 short points in ${inE} separated by " • ": the clauses and their order, the tense or mood, what moves where and why — the sentence's skeleton, not the word notes.\n` +
    `summaries: for each block, one sentence in ${inE} (at most 25 words) saying what that paragraph says.\n` +
    `Never invent words that are not in the sentence. Be concrete and encouraging; whenever you use a grammar term, put the everyday word next to it.` +
    (fa ? `\nفارسیِ سادهٔ روزمره. STANDARD IRANIAN FARSI — no Urdu letters/words.` : "");
}
// Analyses one side of a shot (≤ 30 sentences, batches of ~10) and caches the
// card data on the record under side:lang|explain.
async function shotStudy(msg) {
  const rec = await shotGet(String(msg.id || ""));
  if (!rec) return { ok: false, error: "gone" };
  const side = msg.side === "source" ? "source" : "target";
  const lang = side === "source" ? (rec.source && rec.source !== "xx" ? rec.source : "") : rec.target;
  if (!lang) return { ok: false, error: "no-lang" };
  const explain = String(msg.explain || lang);
  const key = SV_SHOT.studyKey(side + ":" + lang, explain);
  const input = SV_SHOT.studySentences(rec, side);
  if (!input.count) return { ok: false, error: "empty" };
  const started = Date.now();
  const meta = { ts: started, site: "shot", title: "Study: " + (rec.title || "").slice(0, 50), kind: "study", lines: input.count };
  let inTok = 0, outTok = 0, cacheR = 0, cacheW = 0, provider, model;
  const merged = { sentences: [], summaries: [] };
  try {
    const batches = []; let cur = [], n = 0;
    for (const b of input.blocks) { if (n && n + b.sentences.length > 10) { batches.push(cur); cur = []; n = 0; } cur.push(b); n += b.sentences.length; }
    if (cur.length) batches.push(cur);
    for (const batch of batches) {
      const r = await llmJSON(studyPrompt(lang, explain), { blocks: batch.map((b) => ({ b: b.b, sentences: b.sentences.map((x) => ({ i: x.i, text: x.text })) })) }, STUDY_SCHEMA);
      provider = r.provider; model = r.model;
      if (r.usage) { inTok += r.usage.prompt_tokens || 0; outTok += r.usage.completion_tokens || 0; cacheR += r.usage.cache_r || 0; cacheW += r.usage.cache_w || 0; }
      const pr = r.parsed || {};
      if (Array.isArray(pr.sentences)) merged.sentences.push(...pr.sentences);
      if (Array.isArray(pr.summaries)) merged.summaries.push(...pr.summaries);
    }
  } catch (e) {
    const m = String((e && e.message) || e);
    await logCall({ ...meta, ms: Date.now() - started, inTok, outTok, cacheR, cacheW, ok: false, err: m, provider, model });
    if (/key/i.test(m)) return { ok: false, error: "no-key" };
    return { ok: false, error: "network", detail: m };
  }
  await logCall({ ...meta, ms: Date.now() - started, inTok, outTok, cacheR, cacheW, ok: true, provider, model });
  const blocks = SV_SHOT.buildStudy(input, merged, lang);
  if (!rec.study || typeof rec.study !== "object") rec.study = {};
  rec.study[key] = { side, lang, explain, ts: Date.now(), provider, model, truncated: input.truncated, count: input.count, blocks };
  await shotPut(rec);
  return { ok: true, key };
}

// ── Tips sheet: every ﹖-explained line of a video as one Study card ─────────
// Reads clipexplain:<base>, builds (or refreshes) the shot record tips-<base>
// with the sentence pairs and a ready-made study analysis (no model call), and
// opens it in the Shot editor. Entries explained before the sentence text was
// stored alongside (pre-2026-09-02) are skipped.
async function tipsSheet(msg) {
  const base = String(msg.base || "");
  const cx = base ? await idbVocabGet("clipexplain:" + base) : null;
  const entries = cx && cx.e ? Object.values(cx.e).filter((e) => e && e.s && e.tr).sort((a, b) => (a.at || 0) - (b.at || 0)) : [];
  if (!entries.length) return { ok: false, error: "empty" };
  const built = SV_SHOT.tipsSheet(entries);
  let tab = null; try { tab = await activeTabHere(); } catch { tab = null; }
  const title = String(msg.title || (tab && tab.title) || "Tips");
  const url = String(msg.url || (tab && tab.url) || "");
  const tally = {}; for (const e of entries) if (e.lang && e.lang !== "xx") tally[e.lang] = (tally[e.lang] || 0) + 1;
  const detected = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0] || "";
  const lang = detected || String(cx.lang && cx.lang !== "xx" ? cx.lang : (msg.lang && msg.lang !== "xx" ? msg.lang : "")) || "";
  const { targets } = await chrome.storage.local.get("targets");
  const target = String(cx.target || (Array.isArray(targets) && targets[0]) || "en");
  const id = "tips-" + base.replace(/[^a-z0-9_-]/gi, "-").slice(0, 60);
  const prev = await shotGet(id);
  // A small paper card as the sheet's raster: it is what History shows and
  // what the page views fall back to; the Study card is the real content.
  let blob = prev && prev.variant instanceof Blob ? prev.variant : null;
  try {
    const c = new OffscreenCanvas(640, 360), g = c.getContext("2d");
    g.fillStyle = "#FAF6F0"; g.fillRect(0, 0, 640, 360);
    g.fillStyle = "#FFFFFF"; g.beginPath(); g.roundRect(40, 40, 560, 280, 16); g.fill();
    g.fillStyle = "#C93F2B"; g.font = "700 12px ui-monospace, Menlo, monospace"; g.fillText("SUBVIBE · TIPS SHEET", 64, 80);
    g.fillStyle = "#241F1A"; g.font = "700 24px system-ui, -apple-system, sans-serif";
    const t = title.length > 40 ? title.slice(0, 39) + "…" : title; g.fillText(t, 64, 130);
    g.fillStyle = "#5B5348"; g.font = "500 16px system-ui, -apple-system, sans-serif";
    g.fillText(entries.length + (entries.length === 1 ? " explained line" : " explained lines"), 64, 170);
    blob = await c.convertToBlob({ type: "image/png" });
  } catch (e) { /* keep the previous raster, if any */ }
  if (!(blob instanceof Blob)) return { ok: false, error: "raster" };
  const key = SV_SHOT.studyKey("source:" + (lang || "xx"), target);
  const rec = {
    id, ts: Date.now(), url, title, host: hostOf(url) || "tips", source: lang || "xx", target, mode: "tips", layout: "bilingual", dpr: 1,
    w: 640, h: 360, rect: { x: 0, y: 0, w: 640, h: 360 }, original: blob, variant: blob, views: { original: blob },
    blocks: built.blocks, annots: (prev && Array.isArray(prev.annots)) ? prev.annots : [], crop: null, font: (prev && prev.font) || "",
    tabId: (tab && tab.id) || -1, windowId: (tab && tab.windowId) || -1, partial: false, truncated: "", sameLang: false, noKey: false,
    study: { [key]: { side: "source", lang: lang || "xx", explain: target, ts: Date.now(), provider: "tips", model: "", count: entries.length, truncated: false, blocks: built.study } },
  };
  try { SV_SHOT.validateRecord(rec); await shotPut(rec); } catch (e) { return { ok: false, error: "store" }; }
  await chrome.tabs.create({ url: chrome.runtime.getURL("shot.html?id=" + encodeURIComponent(id)) });
  return { ok: true, id, count: entries.length };
}

// ── Snap this line: the video frame as a Shot with one line's tips attached ─
// The page draws the frame off its <video> (media-source players allow it; a
// DRM stream doesn't — there the popup's Screenshot is the route, and it picks
// the line up via window.__svOverlayLine in shotCompose). The record is a
// normal shot: the frame is the Original, the line is its one text block (so
// Translated paints the translation where the subtitle sat, Notes puts it in
// the margin), and the tips are its ready-made Study analysis. tabId −1:
// nothing to re-shoot.
async function tipsSnap(msg, sender) {
  const tab = sender && sender.tab;
  if (!tab) return { ok: false, error: "no-tab" };
  // The frame arrives from the page (drawn off the <video> at native size).
  const rw = Math.round(+msg.w || 0), rh = Math.round(+msg.h || 0);
  if (!msg.frame || typeof msg.frame !== "string" || rw < 8 || rh < 8) return { ok: false, error: "frame" };
  let blob;
  try { blob = await (await fetch(msg.frame)).blob(); } catch (e) { return { ok: false, error: "frame" }; }
  const dpr = 1;
  const line = msg.line || {};
  const sTxt = String(line.s || "").replace(/\s+/g, " ").trim(), tr = String(line.tr || "").replace(/\s+/g, " ").trim();
  const lr = msg.lineRect && +msg.lineRect.w > 0 ? msg.lineRect : null;
  const blocks = sTxt ? [{ id: "b0", text: sTxt, tr, rect: lr ? { x: +lr.x || 0, y: +lr.y || 0, w: +lr.w, h: +lr.h || 24 } : { x: 24, y: Math.max(0, rh - 80), w: Math.max(1, rw - 48), h: 40 }, pairs: [{ o: sTxt, t: tr }], segs: [sTxt] }] : [];
  const lang = String(line.lang && line.lang !== "xx" ? line.lang : (msg.lang && msg.lang !== "xx" ? msg.lang : "")) || "";
  const { targets } = await chrome.storage.local.get("targets");
  const target = String((Array.isArray(targets) && targets[0]) || "en");
  const url = String(msg.url || tab.url || ""), title = String(msg.title || tab.title || "");
  const rec = {
    id: SV_SHOT.newId(), ts: Date.now(), url, title, host: hostOf(url), source: lang || "xx", target, mode: "snap", layout: sTxt && tr ? "bilingual" : "original", dpr,
    w: rw, h: rh, rect: { x: 0, y: 0, w: rw, h: rh }, original: blob, variant: blob, views: { original: blob },
    blocks, annots: [], crop: null, font: "", tabId: -1, windowId: -1, partial: false, truncated: "", sameLang: false, noKey: false,
  };
  if (sTxt && tr) {
    const built = SV_SHOT.tipsSheet([{ s: sTxt, tr, g: line.g, words: line.words }]);
    built.study.forEach((b) => { b.b = "b0"; });
    rec.study = { [SV_SHOT.studyKey("source:" + (lang || "xx"), target)]: { side: "source", lang: lang || "xx", explain: target, ts: Date.now(), provider: "tips", model: "", count: 1, truncated: false, blocks: built.study } };
  }
  try { SV_SHOT.validateRecord(rec); await shotPut(rec); } catch (e) { return { ok: false, error: "store" }; }
  await chrome.tabs.create({ url: chrome.runtime.getURL("shot.html?id=" + encodeURIComponent(rec.id)), openerTabId: tab.id });
  return { ok: true, id: rec.id };
}

// CACHE-STABLE per (source, target) — same rule as systemPrompt(): nothing
// per-call in here, so provider prompt caching can serve repeat batches.
function enrichPrompt(source, target) {
  return `You are a precise lexicographer helping a learner of ${langName(source)}. The user message carries ` +
    `{"words":[{"w":"<word>","s":"<the sentence it appeared in>"}, …]}.\n` +
    `Return STRICT JSON {"e":[…]} with EXACTLY one entry per input word, in the same order:\n` +
    `- lemma: the dictionary form (infinitive for verbs, nominative singular for nouns). ` +
    `For a German SEPARABLE verb, the prefix may sit LATER in the sentence — even at the very END — ` +
    `and the lemma is still the REUNITED verb, never the bare stem: "schauen … an" → "anschauen", ` +
    `"gibt … auf" → "aufgeben", "steht … auf" → "aufstehen", "sieht … fern" → "fernsehen". ` +
    `Scan the whole sentence for a detached prefix (an, auf, aus, ab, ein, mit, nach, vor, zu, zurück, weg, fern). ` +
    `Same for English phrasal verbs ("give up").\n` +
    `- pos: noun|verb|adj|adv|phrase|other — the word's role in the given sentence.\n` +
    `- art: for German nouns the article "der", "die" or "das"; otherwise "-".\n` +
    `- plural: for nouns the plural form; otherwise "-".\n` +
    `- cefr: the word's CEFR level, A1–C2.\n` +
    `- meaning: a concise meaning in ${langName(target)}, matching the sentence's sense.\n` +
    `- phrase: ONE short, natural ${langName(source)} example phrase using the word.\n` +
    `- note: a short usage or irregularity note when genuinely useful, else "-".\n` +
    `- sep: true ONLY for German separable verbs (trennbare Verben), false otherwise.\n` +
    `- para: ONE short sentence explaining the word's meaning IN ${langName(source)} ITSELF — never a translation ` +
    `into another language — using simple everyday A2-level vocabulary a beginner already knows, no quotation marks.` +
    ((target || "").split("-")[0] === "fa"
      ? `\nALL Persian output must be STANDARD IRANIAN FARSI — never Urdu: no Urdu letters (ہ ھ ے ٹ ڈ ڑ ں) and no Urdu words.`
      : "");
}

// Conjugation (verbs, on demand; cached forever on the card). Keys are display
// labels — German gets the canonical five rows; other languages fill equivalent
// tense rows. Free-keyed object, so this call uses json_object, not a strict schema.
function conjPrompt(source) {
  return `You are a ${langName(source)} verb conjugation table generator. The user message carries {"verb":"…"}.\n` +
    `Return STRICT JSON {"forms":{…}}. For German verbs exactly these keys:\n` +
    `{"forms":{"präsens":["ich …","du …","er/sie/es …","wir …","ihr …","sie/Sie …"],` +
    `"präteritum":[6 forms in the same person order],"perfekt":"er/sie/es form, e.g. \\"hat gemacht\\",` +
    `"imperativ":["du form","ihr form"],"konjunktivII":"ich form"}}.\n` +
    `For other languages: the equivalent core tense rows — each key a display label in that language, ` +
    `each value a string or an array of person-forms. Table content only, no commentary.`;
}

// One structured-JSON call on the user's selected TRANSLATION provider — the
// enrichment/conjugation twin of translateChunk/translateChunkClaude, sharing
// their retry, schema and error-shaping rules. schema=null → plain JSON mode
// (json_object on OpenAI, prompt-dictated JSON on Claude).
async function llmJSON(system, userPayload, schema) {
  const { apiKey, anthropicKey, translationProvider, claudeModel } =
    await chrome.storage.local.get(["apiKey", "anthropicKey", "translationProvider", "claudeModel"]);
  const provider = providerOf(translationProvider);
  const key = keyFor(provider, { anthropicKey, apiKey });
  if (!key) {
    throw new Error(provider === "claude"
      ? "No Anthropic API key yet — open the SubVibe popup and paste your key."
      : "No OpenAI API key yet — open the SubVibe popup and paste your key.");
  }
  const model = modelFor(provider, claudeModel);
  const user = JSON.stringify(userPayload);
  if (provider === "claude-cli") {
    const r = await cliChat(system, user, schema, model);
    let parsed;
    try { parsed = r.parsed || SV_VOCAB.parseLooseJSON(r.content); } catch { throw new Error("the model returned malformed JSON"); }
    return { parsed, usage: r.usage, provider, model };
  }
  let body, url, headers;
  if (provider === "claude") {
    url = ANTHROPIC_MESSAGES;
    headers = { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json", "anthropic-dangerous-direct-browser-access": "true" };
    body = {
      model, max_tokens: 8192,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    };
    if (schema) body.output_config = { format: { type: "json_schema", schema: schema.schema } };
    if (!/haiku/.test(model)) body.thinking = { type: "disabled" }; // same rule as translateChunkClaude
  } else {
    url = OPENAI_CHAT;
    headers = { Authorization: "Bearer " + key, "Content-Type": "application/json" };
    body = {
      model, temperature: 0,
      response_format: schema ? { type: "json_schema", json_schema: schema } : { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };
  }
  let lastStatus = 0, lastBody = "", waitMs = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, waitMs || 500 * attempt));
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    waitMs = res.status === 429 ? retryAfterMs(res) : 0;
    const txt = await res.text();
    if (res.ok) {
      if (!txt) throw new Error("the provider returned an empty response");
      let data;
      try { data = JSON.parse(txt); } catch { throw new Error("the provider returned a non-JSON response"); }
      let content, usage;
      if (provider === "claude") {
        if (data.stop_reason === "refusal") throw new Error("Claude declined this request (refusal)");
        if (data.stop_reason === "max_tokens") throw new Error("Claude truncated the response (max_tokens)");
        const blk = (data.content || []).find((b) => b && b.type === "text");
        content = (blk && blk.text) || "{}";
        usage = data.usage ? { prompt_tokens: data.usage.input_tokens || 0, completion_tokens: data.usage.output_tokens || 0,
          cache_r: data.usage.cache_read_input_tokens || 0, cache_w: data.usage.cache_creation_input_tokens || 0 } : null;
      } else {
        content = data?.choices?.[0]?.message?.content || "{}";
        usage = data.usage || null;
      }
      let parsed;
      // Loose parse: Haiku's schema-in-prompt fallback may fence or preface the
      // JSON — the outermost {...} still parses instead of failing the batch.
      try { parsed = SV_VOCAB.parseLooseJSON(content); } catch { throw new Error("the model returned malformed JSON"); }
      return { parsed, usage, provider, model };
    }
    lastStatus = res.status; lastBody = txt;
    // Same fallback as translateChunkClaude: a model generation that rejects
    // output_config drops to schema-in-prompt once (the prompt dictates the shape).
    if (provider === "claude" && res.status === 400 && body.output_config && /output_config|output_format/i.test(txt || "")) {
      console.info("[SubVibe] " + model + " rejected output_config — retrying schema-in-prompt");
      delete body.output_config;
      continue;
    }
    if (!TRANSIENT_HTTP.has(res.status)) break;
  }
  const who = provider === "claude" ? "Claude" : "OpenAI";
  const detail = lastStatus >= 500 ? `${who} is temporarily unavailable — retrying`
    : lastStatus === 429 ? `rate limited by ${who}`
    : /^\s*<(?:!doctype|html|\?xml)/i.test(lastBody || "") ? "unexpected non-JSON response"
    : (lastBody || "").replace(/\s+/g, " ").slice(0, 140);
  throw new Error(`${who} ${lastStatus}: ${detail}`);
}

// ─── TTS (dub speech) ────────────────────────────────────────────────────────

const OPENAI_TTS = "https://api.openai.com/v1/audio/speech";
const TTS_MODEL = "gpt-4o-mini-tts";

// Gemini TTS provider — an alternative BYOK engine with native Persian voices,
// selected via ttsProvider in chrome.storage.local ("openai" default | "gemini").
// Endpoint/model/response-shape verified via WebFetch+curl against
// https://ai.google.dev/gemini-api/docs/generate-content/speech-generation
// (checked 2026-07-24; this is the REST/generateContent surface — the newer
// "Interactions API" the docs now recommend is SDK-oriented and not needed
// here, since this worker always talks raw REST, same as the OpenAI/Claude
// paths above).
const GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";
const GEMINI_GENERATE = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`;
const GEMINI_MODELS = "https://generativelanguage.googleapis.com/v1beta/models";
// Gemini TTS returns RAW PCM (no container): 16-bit signed little-endian,
// 24000 Hz, mono — verified in the same docs (the curl example pipes the
// decoded base64 straight into `ffmpeg -f s16le -ar 24000 -ac 1`).
const GEMINI_PCM_RATE = 24000;

// ArrayBuffer → base64. chrome.runtime messages are JSON-serialized, so audio
// can only cross to the content script as a string.
function b64FromBuf(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}
function bufFromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// Wrap already-int16 PCM bytes (Gemini's raw output) in a 44-byte RIFF/WAVE
// header — same byte layout as shared/audio-export.js's wavFromPcm, but that
// helper takes Float32 samples (it re-quantizes); here the bytes are ALREADY
// 16-bit PCM, so this just prepends the header around them unchanged. The
// content script's decodeAudioData (content/dub.js) can decode a WAV exactly
// like it decodes OpenAI's mp3 — the wrap happens here, worker-side, so the
// cached/returned base64 is always something decodeAudioData understands.
function wavFromPcm16(pcmBuf, sampleRate) {
  const n = pcmBuf.byteLength; // already bytes, 2 per sample (mono, 16-bit)
  const buf = new ArrayBuffer(44 + n);
  const dv = new DataView(buf);
  const w4 = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w4(0, "RIFF"); dv.setUint32(4, 36 + n, true); w4(8, "WAVE");
  w4(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w4(36, "data"); dv.setUint32(40, n, true);
  new Uint8Array(buf, 44).set(new Uint8Array(pcmBuf));
  return buf;
}

async function ttsChunk(text, voice, instructions, apiKey) {
  const body = { model: TTS_MODEL, voice: voice || "alloy", input: text, response_format: "mp3" };
  if (instructions) body.instructions = instructions;
  let lastStatus = 0, lastBody = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 700 * attempt));
    const res = await fetch(OPENAI_TTS, {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return b64FromBuf(await res.arrayBuffer());
    lastStatus = res.status;
    lastBody = await res.text();
    if (res.status === 429) {
      // An RPM window will not clear in this loop's 0.7–1.4 s backoff — stop
      // burning requests and surface how long OpenAI asked us to wait.
      const err = new Error("OpenAI TTS 429: rate limited by OpenAI");
      err.status = 429;
      const ra = res.headers.get("retry-after");
      if (ra && /^\d+(\.\d+)?$/.test(ra)) err.retryAfterMs = Math.round(+ra * 1000);
      throw err;
    }
    if (!TRANSIENT_HTTP.has(res.status)) break;
  }
  const detail = lastStatus >= 500 ? "OpenAI is temporarily unavailable — retrying"
    : lastStatus === 429 ? "rate limited by OpenAI"
    : (lastBody || "").replace(/\s+/g, " ").slice(0, 140);
  throw new Error(`OpenAI TTS ${lastStatus}: ${detail}`);
}

// Gemini TTS path — v1 is single-voice only (multi-voice stays OpenAI-only;
// the popup disables that toggle when Gemini is selected). Style/tone is
// passed as a natural-language prefix in the SAME text part (the docs' own
// examples do this, e.g. "Say cheerfully: …") — ttsInstructions(...)'s output
// is prepended, followed by ": ", then the line to speak. Returns a WAV-
// wrapped base64 clip so content/dub.js's decodeAudioData path never has to
// know Gemini returns raw PCM.
async function ttsChunkGemini(text, voice, instructions, apiKey) {
  const prompt = instructions ? `${instructions}: ${text}` : text;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || "Kore" } } },
    },
  };
  let lastStatus = 0, lastBody = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 700 * attempt));
    const res = await fetch(GEMINI_GENERATE, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    if (res.ok) {
      if (!txt) throw new Error("Gemini returned an empty response");
      let data;
      try { data = JSON.parse(txt); } catch { throw new Error("Gemini returned a non-JSON response"); }
      const b64Pcm = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!b64Pcm) throw new Error("Gemini response had no audio data");
      const pcmBuf = bufFromB64(b64Pcm); // raw s16le mono 24kHz — see GEMINI_PCM_RATE
      return b64FromBuf(wavFromPcm16(pcmBuf, GEMINI_PCM_RATE));
    }
    lastStatus = res.status; lastBody = txt;
    if (res.status === 429) {
      // An RPM window will not clear in this loop's 0.7–1.4 s backoff — stop
      // burning requests and surface how long Google asked us to wait.
      const err = new Error("Gemini TTS 429: rate limited by Gemini");
      err.status = 429;
      const ra = res.headers.get("retry-after");
      if (ra && /^\d+(\.\d+)?$/.test(ra)) err.retryAfterMs = Math.round(+ra * 1000);
      else {
        try {
          const j = JSON.parse(txt);
          const ri = ((j.error && j.error.details) || []).find((d) => String(d["@type"] || "").endsWith("RetryInfo"));
          const m = /^([\d.]+)s$/.exec((ri && ri.retryDelay) || "");
          if (m) err.retryAfterMs = Math.round(+m[1] * 1000);
        } catch {}
      }
      throw err;
    }
    if (!TRANSIENT_HTTP.has(res.status)) break;
  }
  const detail = lastStatus >= 500 ? "Gemini is temporarily unavailable — retrying"
    : lastStatus === 429 ? "rate limited by Gemini"
    : (lastBody || "").replace(/\s+/g, " ").slice(0, 140);
  throw new Error(`Gemini TTS ${lastStatus}: ${detail}`);
}

// TTS rate-limit cooldown, per provider. In-memory only: the worker dying
// forgets it, and the next 429 simply re-arms — never worth persisting.
const ttsCooldownUntil = { openai: 0, gemini: 0 };
const ttsCooldownStreak = { openai: 0, gemini: 0 };

// ─── Provider call log (local-only transparency) ─────────────────────────────
// Every OpenAI call is recorded ON-DEVICE: when, which site, #lines, tokens in/
// out (→ estimated cost), latency, ok/error. Surfaced in the Library's Activity
// tab so the user can SEE exactly what was sent, how often, and what it costs.
// Bounded ring buffer; nothing here ever leaves the device.
const CALL_LOG_KEY = "callLog";
// 2000, not 300: one heavy day of translating evicted the previous day's
// Gemini/TTS rows, which read as "my Gemini activity disappeared". ~250 B/row
// keeps even a full ring near 500 KB — far under the storage.local quota.
const CALL_LOG_MAX = 2000;
// Running spend per provider, independent of the ring buffer: eviction made
// the Library's "all-time" read ~$1.20 while the provider console showed ~$14 —
// a heavy day simply pushed most rows out. These totals only ever add.
const SPEND_KEY = "spendTotals";
const localDayKey = (ts) => {
  const d = new Date(ts || Date.now());
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};
async function logCall(rec) {
  try {
    const cur = await chrome.storage.local.get([CALL_LOG_KEY, SPEND_KEY]);
    const arr = Array.isArray(cur[CALL_LOG_KEY]) ? cur[CALL_LOG_KEY] : [];
    arr.push(rec);
    if (arr.length > CALL_LOG_MAX) arr.splice(0, arr.length - CALL_LOG_MAX);
    const totals = cur[SPEND_KEY] || {};
    const p = rec.provider || "openai";
    const t = totals[p] || (totals[p] = { all: 0, days: {} });
    const usd = SV_PRICING.estCost(rec);
    t.all += usd;
    const day = localDayKey(rec.ts);
    t.days[day] = (t.days[day] || 0) + usd;
    const days = Object.keys(t.days).sort();
    while (days.length > 90) delete t.days[days.shift()];
    await chrome.storage.local.set({ [CALL_LOG_KEY]: arr, [SPEND_KEY]: totals });
  } catch {}
}

// ─── Installation hook ───────────────────────────────────────────────────────

// First run only — never on update: the welcome page sets up language + key.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  // Re-create on every install/update/reload — contextMenus.create throws
  // "duplicate id" if the menu already exists, so clear first.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "svSimplify",
      title: "Simplify with SubVibe",
      contexts: ["selection"],
    });
    // Shot: one parent with the four capture modes (activeTab is granted by
    // the click, so the capture script can be injected on any page).
    chrome.contextMenus.create({ id: "svShot", title: "Screenshot with SubVibe", contexts: ["all"] });
    for (const [id, title] of [["svShotVisible", "Visible area"], ["svShotFull", "Full page"], ["svShotArea", "Select area"], ["svShotElement", "Pick element"]]) {
      chrome.contextMenus.create({ id, parentId: "svShot", title, contexts: ["all"] });
    }
  });
});

// ---- Simplify Reader: right-click "Simplify with SubVibe" on any selection.
// Nothing is injected anywhere until the user clicks the menu item (activeTab).
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (Object.prototype.hasOwnProperty.call(SHOT_MENU, info.menuItemId)) {
    if (tab && tab.id != null) startShot(tab, SHOT_MENU[info.menuItemId]);
    return;
  }
  if (info.menuItemId !== "svSimplify" || !tab || tab.id == null) return;
  const frameId = info.frameId || 0;
  // Clear any stale "can't run" badge from a previous failed attempt on this
  // tab before we know this run's outcome.
  chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, files: ["content/reader.js"] });
  } catch (e) {
    // chrome://, Web Store, PDFs: injection is refused. Flag it on the badge.
    chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    chrome.action.setTitle({ tabId: tab.id, title: "SubVibe: can't run on this page" });
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "SV_SIMPLIFY_OPEN",
      fallbackText: info.selectionText || "",
    }, { frameId });
  } catch (e) {
    // reader.js is injected but didn't respond — not an injection failure,
    // so don't touch the badge.
  }
});

// SIMPLIFY_TEXT handler — mirrors the TRANSLATE path's provider/model resolution.
async function simplifyText(rawText) {
  const { apiKey, anthropicKey, translationProvider, claudeModel, readerLevel } =
    await chrome.storage.local.get(["apiKey", "anthropicKey", "translationProvider", "claudeModel", "readerLevel"]);
  const provider = providerOf(translationProvider);
  const key = keyFor(provider, { anthropicKey, apiKey });
  if (!key) return { ok: false, error: "no-key" };

  const { text, truncated } = SV_SIMPLIFY.prep(rawText);
  if (!text) return { ok: false, error: "bad-response" };
  const messages = SV_SIMPLIFY.buildMessages(text, readerLevel || "B1");

  const started = Date.now();
  const model = modelFor(provider, claudeModel);
  const meta = { ts: started, site: "reader", title: "Simplify: " + text.slice(0, 40), kind: "simplify", lines: 1, provider, model };

  let raw, usage;
  try {
    if (provider === "claude-cli") {
      const r = await cliChat(messages[0].content, messages[1].content, null, model);
      raw = r.content; usage = r.usage;
    } else if (provider === "claude") {
      const res = await fetch(ANTHROPIC_MESSAGES, {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          system: messages[0].content,
          messages: [{ role: "user", content: messages[1].content }],
        }),
      });
      if (!res.ok) { await logCall({ ...meta, ms: Date.now() - started, ok: false, err: "http-" + res.status }); return { ok: false, error: "http-" + res.status }; }
      const data = await res.json();
      const blk = (data.content || []).find((b) => b && b.type === "text");
      raw = blk && blk.text;
      usage = data.usage ? { prompt_tokens: data.usage.input_tokens || 0, completion_tokens: data.usage.output_tokens || 0,
        cache_r: data.usage.cache_read_input_tokens || 0, cache_w: data.usage.cache_creation_input_tokens || 0 } : null;
    } else {
      const res = await fetch(OPENAI_CHAT, {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: TRANSLATE_MODEL, messages, response_format: { type: "json_object" } }),
      });
      if (!res.ok) { await logCall({ ...meta, ms: Date.now() - started, ok: false, err: "http-" + res.status }); return { ok: false, error: "http-" + res.status }; }
      const data = await res.json();
      raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      usage = data.usage ? { prompt_tokens: data.usage.prompt_tokens || 0, completion_tokens: data.usage.completion_tokens || 0, cache_r: 0, cache_w: 0 } : null;
    }
  } catch (e) {
    await logCall({ ...meta, ms: Date.now() - started, inTok: 0, outTok: 0, ok: false, err: String((e && e.message) || e) });
    return { ok: false, error: "network" };
  }

  try {
    const { simple, points } = SV_SIMPLIFY.parse(raw);
    await logCall({ ...meta, ms: Date.now() - started, inTok: (usage && usage.prompt_tokens) || 0, outTok: (usage && usage.completion_tokens) || 0,
      cacheR: (usage && usage.cache_r) || 0, cacheW: (usage && usage.cache_w) || 0, ok: true });
    return { ok: true, simple, points, truncated };
  } catch {
    await logCall({ ...meta, ms: Date.now() - started, inTok: (usage && usage.prompt_tokens) || 0, outTok: (usage && usage.completion_tokens) || 0, ok: false, err: "bad-response" });
    return { ok: false, error: "bad-response" };
  }
}


// ─── Shot: translated screenshots ────────────────────────────────────────────
// Spec: docs/superpowers/specs/2026-08-24-shot-translate-design.md. Menu, popup
// row and Alt+Shift+S all grant activeTab; content/shot-capture.js is injected
// on demand, picks the rect, swaps translated text into the page and drives a
// scroll-and-capture loop. captureVisibleTab runs HERE, so tile bitmaps never
// travel to the page; compose stitches them off-screen and the record is in
// IndexedDB before shot.html opens.
const SHOT_MENU = { svShotVisible: "visible", svShotFull: "full", svShotArea: "area", svShotElement: "element" };
const SHOT_SESSION_TTL = 3 * 60 * 1000;
const shotSessions = new Map(); // tabId → in-flight capture
let lastShotCaptureAt = 0;

function hostOf(url) { try { return new URL(url).hostname; } catch { return ""; } }

async function shotTarget() {
  // A new shot defaults to the popup's language (targets[0]). Picking another
  // language in the editor re-translates THAT shot only — it does not change
  // this default, so shots never get stuck on a one-off choice.
  const { targets } = await chrome.storage.local.get("targets");
  const target = Array.isArray(targets) && targets.length ? String(targets[0]) : "";
  return { target, targetName: target ? langName(target) : "" };
}

async function shotPut(rec) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("shots", "readwrite").objectStore("shots").put(rec, rec.id);
    r.onsuccess = () => resolve(); r.onerror = () => reject(r.error);
  });
}
async function shotGet(id) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("shots", "readonly").objectStore("shots").get(id);
    r.onsuccess = () => resolve(r.result || null); r.onerror = () => reject(r.error);
  });
}

async function activeTabHere() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// One entry for menu, popup and keyboard command. Injection failing means a
// page Chrome won't let us touch (chrome://, Web Store, PDF viewer) → badge,
// exactly like the Simplify path.
async function startShot(tab, mode) {
  if (!tab || tab.id == null) return { ok: false, error: "no-tab" };
  chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["shared/shot.js", "shared/langs.js", "content/shot-capture.js"] });
  } catch (e) {
    const detail = String((e && e.message) || e);
    console.warn("[SubVibe shot] inject failed on tab " + tab.id + " (" + (tab.url || "") + "): " + detail);
    chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    chrome.action.setTitle({ tabId: tab.id, title: "SubVibe: can't run on this page" });
    return { ok: false, error: "inject", detail };
  }
  const { shotLayout, shotFont } = await chrome.storage.local.get(["shotLayout", "shotFont"]);
  const { target, targetName } = await shotTarget();
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "SV_SHOT_START", mode, layout: shotLayout === "bilingual" ? "bilingual" : "translated", target, targetName, font: shotFont || "",
    });
  } catch (e) {
    return { ok: false, error: "inject", detail: String((e && e.message) || e) };
  }
  return { ok: true };
}

const shotSessionOf = (sender) => (sender && sender.tab && shotSessions.get(sender.tab.id)) || null;

async function shotBegin(msg, sender) {
  const tab = sender && sender.tab;
  if (!tab) return { ok: false, error: "no-tab" };
  const now = Date.now();
  for (const [k, s] of shotSessions) if (now - s.startedAt > SHOT_SESSION_TTL) shotSessions.delete(k);
  const st = await shotTarget();
  const target = msg.target ? String(msg.target) : st.target; // pill's live choice wins
  const rect = msg.rect || {};
  const sess = {
    id: SV_SHOT.newId(), tabId: tab.id, windowId: tab.windowId,
    url: String(msg.url || tab.url || ""), title: String(msg.title || tab.title || ""),
    mode: String(msg.mode || "visible"), layout: msg.layout === "bilingual" ? "bilingual" : "translated",
    target, source: "xx",
    rect: { x: +rect.x || 0, y: +rect.y || 0, w: Math.max(1, +rect.w || 1), h: Math.max(1, +rect.h || 1) },
    dpr: +msg.dpr || 1, scrollX: +msg.scrollX || 0,
    viewport: { w: (msg.viewport && +msg.viewport.w) || 1, h: (msg.viewport && +msg.viewport.h) || 1 },
    tiles: { original: [], variant: [] }, startedAt: now,
  };
  shotSessions.set(tab.id, sess);
  return { ok: true, id: sess.id };
}

async function shotTranslate(msg, sender) {
  const sess = shotSessionOf(sender);
  if (!sess) return { ok: false, error: "no-session" };
  const lines = (Array.isArray(msg.lines) ? msg.lines : []).map((l) => String(l || ""));
  const { apiKey, anthropicKey, translationProvider, claudeModel } =
    await chrome.storage.local.get(["apiKey", "anthropicKey", "translationProvider", "claudeModel"]);
  const provider = providerOf(translationProvider);
  if (!keyFor(provider, { anthropicKey, apiKey })) return { ok: false, error: "no-key" };
  if (!sess.target) return { ok: false, error: "no-target" };
  const source = await detectClipLang(lines.map((o) => ({ o })));
  sess.source = source;
  if (source !== "xx" && source === sess.target.split("-")[0]) return { ok: true, sameLang: true, source };
  const started = Date.now();
  const meta = { ts: started, site: "shot", title: "Shot: " + sess.title.slice(0, 60), kind: "shot", lines: lines.length,
    provider, model: modelFor(provider, claudeModel) };
  try {
    const r = await translateAll(lines, source === "xx" ? "auto" : source, sess.target, null, { kind: "page", batch: 20 });
    await logCall({ ...meta, provider: r.provider, model: r.model, ms: Date.now() - started,
      inTok: r.inTok, outTok: r.outTok, cacheR: r.cacheR, cacheW: r.cacheW, ok: true });
    // A partially-failed translation returns source text for the failed batches;
    // flag it so the shot isn't silently stored as fully translated.
    return { ok: true, source, target: sess.target, tr: r.out, partial: (r.failedBatches || 0) > 0 };
  } catch (e) {
    const m = String((e && e.message) || e);
    const http = m.match(/\b(4\d\d|5\d\d)\b/);
    await logCall({ ...meta, ms: Date.now() - started, inTok: 0, outTok: 0, ok: false, err: m });
    return { ok: false, error: http ? "http-" + http[1] : "network" };
  }
}

// captureVisibleTab occasionally never settles (a known headless/headful quirk
// on busy pages) — race it against a timeout so one wedged tile can't freeze the
// whole capture; the caller retries once, then aborts cleanly.
function captureWithTimeout(windowId, ms) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error("capture-timeout")); } }, ms);
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }).then(
      (d) => { if (!settled) { settled = true; clearTimeout(timer); resolve(d); } },
      (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
  });
}

// captureVisibleTab shoots the ACTIVE tab of the window and allows 2 calls/s:
// refuse when the user switched tabs mid-capture, space calls out, retry once.
async function shotCapture(sess) {
  const [active] = await chrome.tabs.query({ active: true, windowId: sess.windowId });
  if (!active || active.id !== sess.tabId) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = lastShotCaptureAt + SV_SHOT.CAPTURE_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      lastShotCaptureAt = Date.now();
      return await captureWithTimeout(sess.windowId, 5000);
    } catch (e) {
      if (attempt) { console.warn("[SubVibe shot] capture failed:", (e && e.message) || e); return null; }
      await new Promise((r) => setTimeout(r, 900));
    }
  }
  return null;
}

async function shotTile(msg, sender) {
  const sess = shotSessionOf(sender);
  if (!sess) return { ok: false, error: "no-session" };
  const dataUrl = await shotCapture(sess);
  if (!dataUrl) return { ok: false, error: "capture" };
  const pass = msg.pass === "variant" ? "variant" : "original";
  sess.tiles[pass][Math.max(0, msg.index | 0)] = { dataUrl, scrollY: +msg.scrollY || 0 };
  return { ok: true };
}

async function shotComposePass(sess, tiles, rect) {
  const lay = SV_SHOT.stitchLayout(rect || sess.rect, tiles.map((t) => t.scrollY), sess.viewport, sess.scrollX, sess.dpr);
  const canvas = new OffscreenCanvas(Math.max(1, lay.width), Math.max(1, lay.height));
  const ctx = canvas.getContext("2d");
  for (const op of lay.ops) {
    const bmp = await createImageBitmap(await (await fetch(tiles[op.i].dataUrl)).blob());
    ctx.drawImage(bmp, op.sx, op.sy, op.sw, op.sh, op.dx, op.dy, op.sw, op.sh);
    bmp.close();
  }
  return canvas.convertToBlob({ type: "image/png" });
}

// Blocks come from the page: rebuilt field by field, never spread.
function shotBlocks(raw) {
  return (Array.isArray(raw) ? raw : []).map((b) => {
    const r = (b && b.rect) || {};
    const segs = Array.isArray(b && b.segs) ? b.segs.map((t) => String(t || "")).filter(Boolean) : null; // per-text-node text, for paragraph-true pairing
    return { id: String((b && b.id) || ""), text: String((b && b.text) || ""), tr: String((b && b.tr) || ""),
      rect: { x: +r.x || 0, y: +r.y || 0, w: +r.w || 0, h: +r.h || 0 }, ...(segs && segs.length ? { segs } : {}) };
  }).filter((b) => b.id && b.text);
}

async function shotCompose(msg, sender) {
  const sess = shotSessionOf(sender);
  if (!sess) return { ok: false, error: "no-session" };
  shotSessions.delete(sess.tabId);
  const tilesO = sess.tiles.original.filter(Boolean);
  const tilesV = sess.tiles.variant.filter(Boolean);
  const passes = Array.isArray(msg.passes) ? msg.passes : ["original", "variant"];
  // original is optional: multi-tile translated shots capture only the variant
  // and render Original via re-shoot. variant is always required.
  // The content script sends the rect it actually captured (planned per pass,
  // after any translation reflow); fall back to the session's provisional rect.
  const r = msg.rect && +msg.rect.w > 0 && +msg.rect.h > 0
    ? { x: +msg.rect.x || 0, y: +msg.rect.y || 0, w: +msg.rect.w, h: +msg.rect.h } : sess.rect;
  let original = null, variant = null, layout = sess.layout;
  try {
    if (passes.includes("original") && tilesO.length) original = await shotComposePass(sess, tilesO, r);
    if (passes.includes("variant") && tilesV.length) variant = await shotComposePass(sess, tilesV, r);
    if (!variant) { variant = original; layout = "original"; } // no-translation shot
  } catch (e) {
    console.warn("[SubVibe shot] compose failed:", (e && e.message) || e);
    return { ok: false, error: "compose" };
  }
  if (!variant) return { ok: false, error: "capture" };
  const rec = {
    id: sess.id, ts: sess.startedAt, url: sess.url, title: sess.title, host: hostOf(sess.url),
    source: sess.source || "xx", target: sess.target, mode: sess.mode, layout, dpr: sess.dpr,
    rect: { ...r }, w: r.w, h: r.h, original, variant, blocks: shotBlocks(msg.blocks),
    partial: !!msg.partial, truncated: msg.truncated === "text" || msg.truncated === "height" ? msg.truncated : "",
    sameLang: !!msg.sameLang, noKey: !!msg.noKey, font: typeof msg.font === "string" ? msg.font : "", tabId: sess.tabId, windowId: sess.windowId,
  };
  // Per-view blob cache: a view renders at most once, then it's instant in the
  // editor and never re-touches the page. Other views fill in lazily via
  // re-shoot and are cached the same way. Keyed by view name.
  rec.views = {};
  if (original instanceof Blob) rec.views.original = original;
  if (variant instanceof Blob) rec.views[layout] = variant;
  // A line explained on the video overlay (window.__svOverlayLine, sent as
  // msg.tip): its own text block at the line's spot and a ready-made Study
  // card — the DRM-safe way to snap a frame with its tips (see tipsSnap).
  const tip = msg.tip && typeof msg.tip === "object" && msg.tip.s && msg.tip.tr ? msg.tip : null;
  if (tip) {
    const tr0 = tip.rect || {};
    const inside = typeof tr0.x === "number" && tr0.x + (tr0.w || 0) > rec.rect.x && tr0.x < rec.rect.x + rec.rect.w && tr0.y + (tr0.h || 0) > rec.rect.y && tr0.y < rec.rect.y + rec.rect.h;
    const tipRect = inside ? { x: +tr0.x, y: +tr0.y, w: +tr0.w || 1, h: +tr0.h || 24 } : { x: rec.rect.x + 24, y: rec.rect.y + Math.max(0, rec.rect.h - 80), w: Math.max(1, rec.rect.w - 48), h: 40 };
    const sTxt = String(tip.s).replace(/\s+/g, " ").trim(), trT = String(tip.tr).replace(/\s+/g, " ").trim();
    rec.blocks = rec.blocks.filter((b) => b.text !== sTxt); // the overlay's own line may have been collected as page text
    rec.blocks.push({ id: "tip0", text: sTxt, tr: trT, rect: tipRect, pairs: [{ o: sTxt, t: trT }], segs: [sTxt] });
    const lang = tip.lang && tip.lang !== "xx" ? String(tip.lang) : (rec.source && rec.source !== "xx" ? rec.source : "");
    const built = SV_SHOT.tipsSheet([{ s: sTxt, tr: trT, g: tip.g, words: tip.words }]);
    built.study.forEach((b) => { b.b = "tip0"; });
    rec.study = { [SV_SHOT.studyKey("source:" + (lang || "xx"), rec.target)]: { side: "source", lang: lang || "xx", explain: rec.target, ts: Date.now(), provider: "tips", model: "", count: 1, truncated: false, blocks: built.study } };
  }
  try { SV_SHOT.validateRecord(rec); await shotPut(rec); }
  catch (e) { console.warn("[SubVibe shot] store failed:", (e && e.message) || e); return { ok: false, error: "store" }; }
  await chrome.tabs.create({ url: chrome.runtime.getURL("shot.html?id=" + encodeURIComponent(rec.id)), openerTabId: sess.tabId });
  return { ok: true, id: rec.id };
}

// Editor → re-render the variant on the source tab with edited translations
// and/or the other layout. Never re-translates. The source tab must still be
// on the same URL; it's brought forward for the second the capture takes
// (captureVisibleTab shoots the active tab) and the editor is re-activated.
async function shotReshoot(msg, sender) {
  const rec = await shotGet(String(msg.id || ""));
  if (!rec) return { ok: false, error: "gone" };
  let tab = null;
  try { tab = await chrome.tabs.get(rec.tabId); } catch { tab = null; }
  if (!tab || (tab.url || "") !== rec.url) return { ok: false, error: "tab-gone" };
  // Block only a genuinely in-flight capture (recent, non-reshoot); a stale or
  // abandoned session (a cancelled/errored capture) is cleared so it can't wedge
  // re-shoot / re-translate forever.
  const inflight = shotSessions.get(rec.tabId);
  if (inflight && !inflight.reshoot && Date.now() - (inflight.startedAt || 0) < 20000) return { ok: false, error: "busy" };
  if (inflight) shotSessions.delete(rec.tabId);
  const editorTab = sender && sender.tab ? sender.tab.id : null;
  const back = async () => { if (editorTab != null) { try { await chrome.tabs.update(editorTab, { active: true }); } catch {} } };
  const edits = new Map((Array.isArray(msg.blocks) ? msg.blocks : []).map((b) => [String(b && b.id), String((b && b.tr) || "")]));
  const blocks = rec.blocks.map((b) => ({ id: b.id, text: b.text, tr: edits.has(b.id) ? edits.get(b.id) : b.tr, rect: b.rect, pairs: b.pairs }));
  const layout = msg.layout === "bilingual" ? "bilingual" : msg.layout === "original" ? "original" : "translated";
  const font = typeof msg.font === "string" ? msg.font : (rec.font || "");
  const rect = rec.rect || { x: 0, y: 0, w: rec.w, h: rec.h };
  // Build the real session and reserve the tab's slot NOW, before the awaits
  // below, so a capture starting on this tab in that window can't slip in and
  // get clobbered. It's a valid session (with tiles), so a stray SHOT_TILE
  // would be stored, not crash.
  const sess = {
    id: rec.id, tabId: rec.tabId, windowId: tab.windowId, url: rec.url, title: rec.title, mode: rec.mode, layout,
    target: rec.target, source: rec.source, rect: { ...rect }, dpr: rec.dpr, scrollX: 0, viewport: { w: 1, h: 1 },
    tiles: { original: [], variant: [] }, startedAt: Date.now(), reshoot: true,
  };
  shotSessions.set(rec.tabId, sess);
  try { await chrome.tabs.update(rec.tabId, { active: true }); } catch { shotSessions.delete(rec.tabId); return { ok: false, error: "tab-gone" }; }
  try {
    await chrome.scripting.executeScript({ target: { tabId: rec.tabId }, files: ["shared/shot.js", "shared/langs.js", "content/shot-capture.js"] });
  } catch (e) { shotSessions.delete(rec.tabId); await back(); return { ok: false, error: "inject" }; }
  let reply = null;
  try {
    reply = await chrome.tabs.sendMessage(rec.tabId, { type: "SV_SHOT_RESHOOT", rect, layout, blocks, target: rec.target, mode: rec.mode, font });
  } catch (e) { reply = null; }
  shotSessions.delete(rec.tabId);
  await back();
  if (!reply || !reply.ok) return { ok: false, error: (reply && reply.error) || "capture" };
  sess.dpr = +reply.dpr || sess.dpr; sess.scrollX = +reply.scrollX || 0;
  sess.viewport = { w: (reply.viewport && +reply.viewport.w) || 1, h: (reply.viewport && +reply.viewport.h) || 1 };
  const tiles = sess.tiles.variant.filter(Boolean);
  if (!tiles.length) return { ok: false, error: "capture" };
  const effRect = reply.rect && +reply.rect.w > 0 && +reply.rect.h > 0
    ? { x: +reply.rect.x || 0, y: +reply.rect.y || 0, w: +reply.rect.w, h: +reply.rect.h } : sess.rect;
  let blob;
  try { blob = await shotComposePass(sess, tiles, effRect); } catch { return { ok: false, error: "compose" }; }
  const trunc = reply.truncated === "height" ? "height" : "";
  // Ensure the per-view cache exists (records stored before this feature won't
  // have it; seed it from the legacy original/variant fields).
  if (!rec.views || typeof rec.views !== "object") {
    rec.views = {};
    if (rec.original instanceof Blob) rec.views.original = rec.original;
    if (rec.variant instanceof Blob && rec.layout) rec.views[rec.layout] = rec.variant;
  }
  // A font change re-bakes the translated text, so any cached translated /
  // bilingual view is now stale — drop them; each re-renders on next visit.
  // Original is untranslated, so the font never touches it.
  const fontChanged = typeof msg.font === "string" && msg.font !== (rec.font || "");
  if (layout === "original") {
    rec.original = blob; // fills in the Original view a multi-tile shot didn't capture up front
    rec.views.original = blob;
    // rect/w/h/dpr describe the variant (the primary view) — leave them untouched.
    if (trunc && rec.truncated !== "text") rec.truncated = trunc;
  } else {
    if (fontChanged) { delete rec.views.translated; delete rec.views.bilingual; }
    rec.variant = blob; rec.layout = layout; rec.blocks = blocks; rec.partial = !!reply.partial; rec.font = font;
    rec.dpr = sess.dpr; rec.rect = { ...effRect }; rec.w = effRect.w; rec.h = effRect.h;
    rec.truncated = rec.truncated === "text" ? "text" : trunc;
    rec.views[layout] = blob;
  }
  await shotPut(rec);
  return { ok: true, missing: reply.missing | 0 };
}

// Editor asks whether a shot's source tab is still open on the same URL, so it
// can disable re-shoot up front (background has the activeTab grant to read url).
async function shotTabAlive(id) {
  const rec = await shotGet(String(id || ""));
  if (!rec) return { ok: true, alive: false };
  try { const t = await chrome.tabs.get(rec.tabId); return { ok: true, alive: !!t && (t.url || "") === rec.url }; }
  catch { return { ok: true, alive: false }; }
}

// Editor language picker: re-translate a shot's original text to a NEW target
// language, then re-render it on the source tab (needs the tab open). Reuses
// shotReshoot for the render — this only adds the fresh translation step.
async function shotRetranslate(msg, sender) {
  const rec = await shotGet(String(msg.id || ""));
  if (!rec) return { ok: false, error: "gone" };
  const newTarget = String(msg.target || "");
  if (!newTarget) return { ok: false, error: "no-target" };
  const wantBilingual = msg.layout === "bilingual";
  // Bilingual is a generated card (drawn in the editor from sentence pairs) — it
  // needs no tab. Translated re-renders the page, so it needs the source tab.
  let tab = null;
  try { tab = await chrome.tabs.get(rec.tabId); } catch { tab = null; }
  const tabOk = !!tab && (tab.url || "") === rec.url;
  if (!wantBilingual && !tabOk) return { ok: false, error: "tab-gone" };
  if (!(rec.blocks || []).length) { rec.target = newTarget; await shotPut(rec); return { ok: true, empty: true }; }
  // Split each block into sentences and translate per-sentence, so the bilingual
  // card can pair each original sentence with its own translation. Blocks that
  // remember their text nodes (`segs`) split per node first, so a paragraph
  // break is always a pair boundary and the swap can keep the paragraphs.
  const blockSents = rec.blocks.map((b) => (Array.isArray(b.segs) && b.segs.length ? b.segs.flatMap((t) => SV_SHOT.splitSentences(t)) : SV_SHOT.splitSentences(b.text)));
  const uniq = [...new Set(blockSents.flat())];
  if (!uniq.length) { rec.target = newTarget; await shotPut(rec); return { ok: true, empty: true }; }
  const started = Date.now();
  const meta = { ts: started, site: "shot", title: "Retranslate: " + (rec.title || "").slice(0, 50), kind: "shot", lines: uniq.length };
  let out;
  try {
    const r = await translateAll(uniq, rec.source === "xx" ? "auto" : rec.source, newTarget, null, { kind: "page", batch: 20 });
    out = r.out;
    await logCall({ ...meta, provider: r.provider, model: r.model, ms: Date.now() - started, inTok: r.inTok, outTok: r.outTok, cacheR: r.cacheR, cacheW: r.cacheW, ok: true });
  } catch (e) {
    const m = String((e && e.message) || e);
    await logCall({ ...meta, ms: Date.now() - started, inTok: 0, outTok: 0, ok: false, err: m });
    if (/key/i.test(m)) return { ok: false, error: "no-key" };
    const http = m.match(/\b(4\d\d|5\d\d)\b/);
    return { ok: false, error: http ? "http-" + http[1] : "network", detail: m };
  }
  const map = new Map(uniq.map((t, i) => [t, String(out[i] || "")]));
  // New language ⇒ cached translated / bilingual raster views are stale.
  if (rec.views && typeof rec.views === "object") { delete rec.views.translated; delete rec.views.bilingual; }
  rec.target = newTarget; rec.noKey = false; rec.sameLang = false;
  rec.blocks = rec.blocks.map((b, i) => {
    const pairs = blockSents[i].map((o) => ({ o, t: map.get(o) || "" }));
    const tr = pairs.map((p) => p.t).filter(Boolean).join(" ");
    return { ...b, tr, pairs };
  });
  await shotPut(rec);
  if (wantBilingual) return { ok: true }; // editor draws the pairs card from rec.blocks
  // Translated: render the page in the target language (needs the tab).
  shotSessions.delete(rec.tabId);
  const edits = rec.blocks.map((x) => ({ id: x.id, tr: x.tr }));
  return await shotReshoot({ id: rec.id, layout: "translated", blocks: edits, font: rec.font || "" }, sender);
}

// ─── Clip: the content script records JUST the <video> element (clean frames,
// no player UI, no tabCapture → no Live collision) and streams the WebM here in
// base64 chunks; we reassemble, store in "clips", and open the editor. ────────
const clipXfer = new Map(); // id → { parts:[], meta }

async function startClip(tab) {
  if (!tab || tab.id == null) return { ok: false, error: "no-tab" };
  chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  try {
    // The script self-toggles start/stop on re-injection.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/clip-capture.js"] });
    return { ok: true };
  } catch (e) {
    const detail = String((e && e.message) || e);
    chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    chrome.action.setTitle({ tabId: tab.id, title: "SubVibe: can't record on this page" });
    return { ok: false, error: "inject", detail };
  }
}

async function clipStore(id) {
  const x = clipXfer.get(id); clipXfer.delete(id);
  if (!x) return;
  const meta = x.meta || {};
  let blob = null;
  try { blob = await (await fetch("data:" + (meta.mime || "video/webm") + ";base64," + x.parts.join(""))).blob(); }
  catch (e) { console.warn("[SubVibe clip] assemble failed:", (e && e.message) || e); return; }
  if (!blob || !blob.size) return;
  const { target } = await shotTarget();
  const rec = {
    id, ts: Date.now(), blob, mime: meta.mime || "video/webm", durationMs: +meta.durationMs || 0,
    w: +meta.w || 0, h: +meta.h || 0, startSec: +meta.startSec || 0, crop: null,
    title: meta.title || "", url: meta.url || "", host: hostOf(meta.url || ""), target,
  };
  try {
    const d = await db();
    await new Promise((res, rej) => { const r = d.transaction("clips", "readwrite").objectStore("clips").put(rec, rec.id); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
  } catch (e) { console.warn("[SubVibe clip] store failed:", (e && e.message) || e); return; }
  try { await chrome.tabs.create({ url: chrome.runtime.getURL("clip.html?id=" + encodeURIComponent(id)) }); } catch (e) {}
}

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command, tab) => {
    const t = tab || await activeTabHere();
    if (command === "sv-shot-area") startShot(t, "area");
    else if (command === "sv-clip-record") startClip(t);
  });
}

// ─── Message router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case "CACHE_GET":
          sendResponse({ track: await idbGet(msg.key) });
          break;
        case "CACHE_PUT":
          await idbPut(msg.key, msg.track);
          if (++putsSinceEvict >= 25) { putsSinceEvict = 0; idbEvictOldest().catch(() => {}); }
          sendResponse({ ok: true });
          break;
        case "CACHE_LIST":
          sendResponse({ tracks: await idbList() });
          break;
        case "CACHE_CLEAR":
          await idbClear();
          sendResponse({ ok: true });
          break;
        case "CACHE_DELETE":
          sendResponse({ ok: true, removed: await idbDeletePrefix(msg.prefix) });
          break;
        case "FETCH_SUBS": {
          // Fetch the page's own subtitle file — often on a different ZDF
          // subdomain (utstreaming.zdf.de). The worker has host permission, so
          // this cross-origin GET is CORS-exempt, unlike a content-script fetch.
          // Returns raw text; the content script parses it (the worker, being a
          // service worker, has no DOMParser).
          try {
            const r = await fetch(msg.url, { credentials: "omit" });
            sendResponse({ ok: r.ok, status: r.status, text: await r.text() });
          } catch (e) {
            sendResponse({ error: String((e && e.message) || e) });
          }
          break;
        }
        case "TRANSLATE": {
          const started = Date.now();
          const meta = { ts: started, site: msg.site, title: msg.title, target: msg.target, lines: (msg.cues || []).length, base: msg.base };
          try {
            const r = await translateAll(msg.cues, msg.source, msg.target, msg.context);
            await logCall({ ...meta, ms: Date.now() - started, inTok: r.inTok, outTok: r.outTok, cacheR: r.cacheR || 0, cacheW: r.cacheW || 0, ok: true, provider: r.provider, model: r.model });
            sendResponse({ lines: r.out, spk: r.spk, gen: r.gen, dub: r.dub });
          } catch (e) {
            const { translationProvider, claudeModel } = await chrome.storage.local.get(["translationProvider", "claudeModel"]);
            const provider = providerOf(translationProvider);
            await logCall({ ...meta, ms: Date.now() - started, inTok: 0, outTok: 0, ok: false, err: String((e && e.message) || e), provider, model: modelFor(provider, claudeModel) });
            throw e; // let the outer catch send the {error} response
          }
          break;
        }
        case "TTS": {
          // Cache-through: a cached clip is returned instantly, free, unlogged.
          const cached = await idbAudioGet(msg.key);
          if (cached && cached.b64) { sendResponse({ b64: cached.b64, cached: true }); break; }
          const { apiKey, geminiKey, ttsProvider } = await chrome.storage.local.get(["apiKey", "geminiKey", "ttsProvider"]);
          const provider = ttsProvider === "gemini" ? "gemini" : "openai";
          const key = provider === "gemini" ? geminiKey : apiKey;
          if (!key) {
            sendResponse({ error: provider === "gemini"
              ? "No Gemini API key yet — open the SubVibe popup and paste your key."
              : "No OpenAI API key yet — open the SubVibe popup and paste your key." });
            break;
          }
          if (Date.now() < (ttsCooldownUntil[provider] || 0)) {
            // Local, instant, unlogged — the whole point is zero network and
            // zero log spam while the provider's window resets.
            sendResponse({ error: "rate-limited — cooling down", cooldownUntil: ttsCooldownUntil[provider] });
            break;
          }
          const started = Date.now();
          const meta = { ts: started, site: msg.site, title: msg.title, target: msg.target, kind: "tts", chars: (msg.text || "").length, durMs: msg.durMs || 0, provider, base: msg.base };
          try {
            const b64 = provider === "gemini"
              ? await ttsChunkGemini(msg.text, msg.voice, msg.instructions, key)
              : await ttsChunk(msg.text, msg.voice, msg.instructions, key);
            await idbAudioPut(msg.key, { b64, voice: msg.voice, ms: msg.durMs || 0, chars: meta.chars, createdAt: new Date().toISOString() });
            await logCall({ ...meta, ms: Date.now() - started, ok: true });
            ttsCooldownStreak[provider] = 0;
            sendResponse({ b64 });
          } catch (e) {
            if (e && e.status === 429) {
              const s = ++ttsCooldownStreak[provider];
              const fallback = Math.min(300000, 30000 * 2 ** (s - 1)); // 30s → 60s → … → 5min
              ttsCooldownUntil[provider] = Date.now() + (e.retryAfterMs || fallback);
            }
            await logCall({ ...meta, ms: Date.now() - started, ok: false, err: String((e && e.message) || e) });
            sendResponse({ error: String((e && e.message) || e), cooldownUntil: ttsCooldownUntil[provider] > Date.now() ? ttsCooldownUntil[provider] : undefined });
            break;
          }
          break;
        }
        case "AUDIO_KEYS":
          sendResponse({ keys: await idbAudioKeys(msg.prefix || "") });
          break;
        case "AUDIO_DELETE":
          sendResponse({ ok: true, removed: await idbAudioDeletePrefix(msg.prefix || "") });
          break;
        case "REPAIR_LABELS": {
          // One-time healing: a YouTube track whose stored url's ?v= disagrees
          // with its KEY's ?v= was label-stamped by an SPA hop (pre-fix builds).
          // The key is ground truth. Rewrite url from the key, drop the stolen
          // title (the card falls back to videoId; the real title heals on the
          // next watch). Idempotent: repaired rows no longer mismatch.
          const d = await db();
          const n = await new Promise((resolve) => {
            const store = d.transaction("tracks", "readwrite").objectStore("tracks");
            let fixed = 0;
            store.openCursor().onsuccess = (e) => {
              const c = e.target.result;
              if (!c) return resolve(fixed);
              const m = /^youtube:\/watch\?v=([\w-]+):/.exec(String(c.key));
              const t = c.value || {};
              const uv = /[?&]v=([\w-]+)/.exec(t.url || "");
              if (m && uv && uv[1] !== m[1]) {
                c.update({ ...t, url: "https://www.youtube.com/watch?v=" + m[1], title: "" });
                fixed++;
              }
              c.continue();
            };
            store.transaction.onerror = () => resolve(fixed);
          });
          sendResponse({ ok: true, repaired: n });
          break;
        }
        case "LOG_LIST": {
          const s = await chrome.storage.local.get([CALL_LOG_KEY, SPEND_KEY]);
          sendResponse({ calls: s[CALL_LOG_KEY] || [], totals: s[SPEND_KEY] || {} });
          break;
        }
        case "LOG_CLEAR":
          await chrome.storage.local.set({ [CALL_LOG_KEY]: [] });
          sendResponse({ ok: true });
          break;
        case "VERIFY_KEY": {
          // Free, no-token check that the key is valid (GET /v1/models). Lets the
          // popup show ✓/✗ before the user hits a video.
          try {
            const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: "Bearer " + (msg.apiKey || "") } });
            sendResponse({ ok: r.ok, status: r.status });
          } catch (e) {
            sendResponse({ ok: false, error: String((e && e.message) || e) });
          }
          break;
        }
        case "VERIFY_ANTHROPIC": {
          // Same idea as VERIFY_KEY but for the Claude BYOK key: a cheap
          // GET /v1/models with the Anthropic auth headers.
          try {
            const r = await fetch("https://api.anthropic.com/v1/models", {
              headers: { "x-api-key": msg.apiKey || "", "anthropic-version": ANTHROPIC_VERSION, "anthropic-dangerous-direct-browser-access": "true" },
            });
            sendResponse({ ok: r.ok, status: r.status });
          } catch (e) {
            sendResponse({ ok: false, error: String((e && e.message) || e) });
          }
          break;
        }
        case "VERIFY_GEMINI": {
          // Same idea as VERIFY_KEY but for the Gemini BYOK key: a cheap
          // GET /v1beta/models with the x-goog-api-key header.
          try {
            const r = await fetch(GEMINI_MODELS, { headers: { "x-goog-api-key": msg.apiKey || "" } });
            sendResponse({ ok: r.ok, status: r.status });
          } catch (e) {
            sendResponse({ ok: false, error: String((e && e.message) || e) });
          }
          break;
        }
        case "LOOKAHEAD": {
          // Toolbar icon as a COST signal for the reporting tab:
          //   "✓" green  = caught up — replaying cached/ready lines, NO API cost
          //   number     = actively pre-translating ahead (may be spending); amber,
          //                or red when a line is about to show untranslated.
          // The hover tooltip spells it out in words.
          const tabId = sender && sender.tab && sender.tab.id;
          if (tabId != null) {
            try {
              // Dub Mode's readiness counter, appended (not restructuring the
              // existing subtitle look-ahead title) to the free/counting titles
              // whenever the content script sent it.
              const dubSuffix = msg.dubReady != null ? ` · dub: ${msg.dubReady} clips buffered ahead` : "";
              if (msg.off) {
                await chrome.action.setBadgeText({ tabId, text: "" });
                await chrome.action.setTitle({ tabId, title: "SubVibe" });
              } else if (msg.free) {
                await chrome.action.setBadgeText({ tabId, text: "✓" });
                await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2e9e5b" });
                await chrome.action.setTitle({ tabId, title: "SubVibe — caught up · replaying ready/cached lines · no API cost" + dubSuffix });
              } else {
                const n = Math.max(0, msg.count | 0);
                await chrome.action.setBadgeText({ tabId, text: n > 99 ? "99+" : String(n) });
                await chrome.action.setBadgeBackgroundColor({ tabId, color: msg.state === "miss" ? "#c0392b" : "#c77f0a" });
                await chrome.action.setTitle({ tabId, title: `SubVibe — translating ahead · ${n} line${n === 1 ? "" : "s"} ready` + dubSuffix });
              }
            } catch {}
          }
          sendResponse({ ok: true });
          break;
        }
        case "START_AUDIO":
          audioActive = true;
          audioTabId = sender?.tab?.id ?? msg.tabId;
          if (!hasOffscreen) {
            // START_AUDIO is fire-and-forget in the content script, so an error
            // response alone would vanish — surface it on the overlay via the
            // existing AUDIO_ERROR → setStatus path.
            if (audioTabId != null) chrome.tabs.sendMessage(audioTabId, { type: "AUDIO_ERROR", error: "live transcription isn't available in this browser yet" }).catch(() => {});
            sendResponse({ error: "offscreen API unavailable" });
            break;
          }
          await ensureOffscreen();
          chrome.runtime.sendMessage({ type: "AUDIO_START", deviceId: msg.deviceId });
          sendResponse({ ok: true });
          break;
        case "STOP_AUDIO":
          audioActive = false;
          chrome.runtime.sendMessage({ type: "AUDIO_STOP" });
          if (audioTabId != null) chrome.tabs.sendMessage(audioTabId, { type: "AUDIO_STOP" }).catch(() => {});
          if (!liveActive) { try { await chrome.offscreen.closeDocument(); } catch {} } // live shares the doc
          sendResponse({ ok: true });
          break;
        // ── Live Translate (experimental): popup ⇄ offscreen ⇄ content ──────
        case "LIVE_BEGIN": { // popup→background; the offscreen page only ever hears background's LIVE_START
          if (!hasOffscreen) { sendResponse({ error: "offscreen API unavailable in this browser" }); break; }
          liveTabId = msg.tabId ?? null;
          if (liveTabId == null) {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
            liveTabId = tabs && tabs[0] ? tabs[0].id : null;
          }
          liveActive = true;
          try {
            await ensureOffscreen();
            // A just-created document may still be parsing its scripts when a
            // broadcast goes out — a lost LIVE_START was an eternal
            // "Connecting…". Ping until the live script answers, THEN forward.
            let ready = false;
            for (let i = 0; i < 10 && !ready; i++) {
              ready = await new Promise((res) => chrome.runtime.sendMessage({ type: "LIVE_PING" }, (r) => res(!chrome.runtime.lastError && !!(r && r.pong))));
              if (!ready) await new Promise((r) => setTimeout(r, 150));
            }
            if (!ready) throw new Error("loaded but never answered the ready ping");
            let streamId = null;
            if (msg.wantTab) {
              // Minted HERE, not in the popup: without consumerTabId a stream
              // id is only consumable in the caller's render process (Chrome
              // 116+) — a popup-minted id was dead on arrival at the offscreen
              // page. The worker mint is Google's own offscreen-recording
              // pattern and is consumable extension-wide.
              streamId = await Promise.race([
                new Promise((res, rej) => chrome.tabCapture.getMediaStreamId({ targetTabId: liveTabId }, (id) => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(id))),
                new Promise((_, rej) => setTimeout(() => rej(new Error("no tab stream id after 5s — the browser may be blocking tabCapture")), 5000)),
              ]);
            }
            // Hand the key over instead of letting the capture page read
            // storage itself — one less await over there that could stall.
            const { geminiKey } = await chrome.storage.local.get("geminiKey");
            chrome.runtime.sendMessage({ type: "LIVE_START", key: geminiKey || "", streamId, origVol: msg.origVol, deviceId: msg.deviceId, target: msg.target, targetCode: msg.targetCode, model: msg.model });
          } catch (e) {
            liveActive = false;
            chrome.runtime.sendMessage({ type: "LIVE_STATE", running: false, error: "capture page: " + (e.message || e) });
          }
          sendResponse({ ok: true });
          break;
        }
        case "LIVE_END": // popup→background; forwarded to the capture page as LIVE_STOP
          liveActive = false;
          chrome.runtime.sendMessage({ type: "LIVE_STOP" });
          if (liveTabId != null) chrome.tabs.sendMessage(liveTabId, { type: "LIVE_STATE", running: false }).catch(() => {});
          if (!audioActive) { try { await chrome.offscreen.closeDocument(); } catch {} }
          sendResponse({ ok: true });
          break;
        case "LIVE_QUERY":
          sendResponse({ running: liveActive, tabId: liveTabId, hasOffscreen }); // hasOffscreen=false on Firefox (no offscreen API) → popup marks Live as Chrome-only
          break;
        case "LIVE_TEXT":
          if (liveTabId != null) chrome.tabs.sendMessage(liveTabId, { type: "LIVE_LINE", original: msg.original, translated: msg.translated }).catch(() => {});
          sendResponse({ ok: true });
          break;
        case "LIVE_STATE":
          if (!msg.running) liveActive = false; // any terminal state — clean stop OR death-with-error
          // Stage breadcrumbs ("opening audio…") are popup-only progress. The
          // content script tears the subtitle engine down on ANY running:true —
          // forwarding a breadcrumb killed subtitles/badge before a session
          // even existed. Only real transitions reach the tab.
          if (liveTabId != null && !(msg.running && msg.stage)) chrome.tabs.sendMessage(liveTabId, { type: "LIVE_STATE", running: msg.running, error: msg.error }).catch(() => {});
          // popup (if open) listens on runtime for the same message — nothing to do
          sendResponse({ ok: true });
          break;
        case "AUDIO_TEXT":
          console.debug("[CopilotSubs audio] heard:", msg.text);
          if (audioTabId != null) chrome.tabs.sendMessage(audioTabId, { type: "AUDIO_CUE", text: msg.text }).catch(() => {});
          sendResponse({ ok: true });
          break;
        case "AUDIO_ERROR":
          console.warn("[CopilotSubs audio] error:", msg.error);
          if (audioTabId != null) chrome.tabs.sendMessage(audioTabId, { type: "AUDIO_ERROR", error: msg.error }).catch(() => {});
          sendResponse({ ok: true });
          break;
        // ── Vocabulary trainer (all local — capture/inbox/review cost nothing) ──
        case "VOCAB_ADD":
          sendResponse({ ok: true, ...(await vocabAdd(msg)) });
          break;
        case "VOCAB_ADD_MANY": {
          // Bulk save — "add all A2+ words of this clip" in one message. Each
          // card still goes through vocabAdd (dedupe, clipenrich adoption).
          let added = 0;
          for (const it of msg.items || []) {
            try {
              await vocabAdd({ word: it.word, sentence: it.sentence, translation: it.translation,
                lang: msg.lang, videoTitle: msg.videoTitle, base: msg.base, ms: it.ms || 0, channel: msg.channel });
              added++;
            } catch {}
          }
          sendResponse({ ok: true, added });
          break;
        }
        case "VOCAB_LIST":
          sendResponse({ cards: (await idbVocabList("")).filter((r) => isCardKey(r.key)).map((r) => ({ key: r.key, ...r.value })) });
          break;
        case "VOCAB_INBOX_LIST":
          sendResponse({ inbox: (await idbVocabList("inbox:")).map((r) => r.value) });
          break;
        case "VOCAB_INBOX_BUILD":
          sendResponse({ ok: true, ...(await vocabInboxBuild()) });
          break;
        case "VOCAB_PROMOTE": {
          const row = await idbVocabGet("inbox:" + msg.base);
          let promoted = 0;
          if (row) {
            const pick = new Set((msg.words || []).map((w) => String(w).toLowerCase()));
            for (const e of (row.words || []).filter((e) => pick.has(e.w.toLowerCase()))) {
              await vocabAdd({ word: e.w, sentence: e.sentence, translation: e.st || "", lang: row.lang, videoTitle: row.videoTitle, base: row.base, ms: 0 });
              promoted++;
            }
            row.words = (row.words || []).filter((e) => !pick.has(e.w.toLowerCase()));
            await idbVocabPut("inbox:" + msg.base, row);
          }
          sendResponse({ ok: true, promoted });
          break;
        }
        case "VOCAB_DISMISS": {
          const row = await idbVocabGet("inbox:" + msg.base);
          if (row) {
            const pick = new Set((msg.words || []).map((w) => String(w).toLowerCase()));
            const tomb = new Set(((await idbVocabGet("dismissed:" + row.lang)) || {}).words || []);
            for (const e of row.words || []) if (pick.has(e.w.toLowerCase())) tomb.add(e.w.toLowerCase());
            await idbVocabPut("dismissed:" + row.lang, { words: [...tomb] }); // never re-inboxed
            row.words = (row.words || []).filter((e) => !pick.has(e.w.toLowerCase()));
            await idbVocabPut("inbox:" + msg.base, row);
          }
          sendResponse({ ok: true });
          break;
        }
        case "VOCAB_GRADE": {
          const cur = await idbVocabGet(msg.key);
          if (!cur) { sendResponse({ error: "no such card: " + msg.key }); break; }
          const card = SV_LEITNER.grade(cur, !!msg.ok, Date.now());
          await idbVocabPut(msg.key, card);
          sendResponse({ ok: true, card });
          break;
        }
        case "VOCAB_IMPORT": {
          // {lang, name, toAdd, toUpdate} — the popup/trainer already ran the
          // file through SV_SHARE.validateImport + mergeImport before sending
          // this, but background listens on the whole extension: this handler
          // re-validates from scratch (arrays, per-field caps, a fixed
          // whitelist of writable fields) rather than trust an already-clean
          // payload, same discipline as shared/share.js's whitelistCard.
          const lang = typeof msg.lang === "string" ? msg.lang.toLowerCase() : "";
          // isCardKey(lang + ":x") is false exactly when `lang` collides with
          // a reserved internal key namespace (inbox/dismissed/clipenrich/
          // clipgram) — two of those are short enough to pass the regex
          // below, and a colliding lang would let BOTH toAdd's derived key
          // (`${lang}:word`) and toUpdate's key.startsWith(lang+":") guard
          // land inside a reserved prefix (review fix round 1).
          if (!/^[a-z]{2,8}$/.test(lang) || !isCardKey(lang + ":x")) { sendResponse({ error: "bad lang" }); break; }
          // Same sanitizeName rule as shared/share.js: strip to [A-Za-z0-9 _-], cap 24.
          const gift = String(msg.name || "").replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 24);
          const toAddIn = Array.isArray(msg.toAdd) ? msg.toAdd.slice(0, 5000) : [];
          const toUpdateIn = Array.isArray(msg.toUpdate) ? msg.toUpdate.slice(0, 5000) : [];
          // Mirrors shared/share.js's STRING_CAPS (word aside) — duplicated
          // rather than imported since that module exports no whitelist helper,
          // only its own pure functions.
          const IMPORT_CAPS = { lemma: 500, cefr: 500, pos: 500, art: 500, meaning: 500, sentence: 1000,
            sentenceT: 1000, para: 1000, note: 500, phrase: 500, videoTitle: 500, channel: 500 };
          // Mirrors shared/share.js's whitelistCard: empty is never copied —
          // this message could be hand-crafted and sent straight to
          // background.js, bypassing SV_SHARE.validateImport entirely, so
          // this defense can't assume the sender already dropped sep:false/
          // ms:0/empty strings the way a real export does (review fix round 2).
          const pickImportFields = (raw) => {
            const out = {};
            if (!raw || typeof raw !== "object") return out;
            for (const f of Object.keys(IMPORT_CAPS)) {
              const v = raw[f];
              if (typeof v === "string" && v.length > 0 && v.length <= IMPORT_CAPS[f]) out[f] = v;
            }
            if (raw.sep === true) out.sep = true;
            if (typeof raw.ms === "number" && Number.isFinite(raw.ms) && raw.ms > 0) out.ms = raw.ms;
            return out;
          };
          // Shared by both loops below: patch ONLY the whitelisted enrichment
          // fields present in `raw` onto an already-stored `cur` card — never
          // box/nextDueAt/lastGradedAt/history/n/key/gift. Returns false (no
          // write happened) when `raw` carries nothing new, so a no-op merge
          // never gets counted as though something changed.
          const mergeOntoExisting = async (key, cur, raw) => {
            const f = pickImportFields(raw);
            if (!Object.keys(f).length) return false;
            await idbVocabPut(key, { ...cur, ...f });
            return true;
          };

          const now = Date.now();
          let added = 0, updated = 0;
          for (const raw of toAddIn) {
            try {
              const word = typeof raw.word === "string" ? raw.word.trim() : "";
              if (!word || word.length > 80) continue;
              const clean = SV_VOCAB.tokenize(word)[0] || word;
              const key = `${lang}:${clean.toLowerCase()}`;
              // vocabAdd is idempotent by always idbVocabGet-ing before it
              // writes (background.js:275-306) — this loop has to be too.
              // A "new" card can already have a row here: a second surface's
              // concurrent import, a duplicate word within this same toAdd
              // batch (an earlier iteration's write is already visible to
              // this idbVocabGet), or a reimport whose file-side word didn't
              // tokenize-match the CLIENT's dedupe key (mergeImport's own
              // dedupeKey is a bare lowercase compare, not SV_VOCAB.tokenize
              // — shared/share.js) even though it matches the key the SERVER
              // derives right here. Any of those must never blindly overwrite
              // an existing card's review state — merge onto it instead and
              // count it as an update, not a fresh add (review fix round 1).
              const cur = await idbVocabGet(key);
              if (cur) {
                if (await mergeOntoExisting(key, cur, raw)) updated++;
                continue;
              }
              const f = pickImportFields(raw);
              // Store defaults for a fresh card (vocabAdd's new-card shape) —
              // no review-state field ever arrives from the wire, so every one
              // of box/nextDueAt/addedAt/lastGradedAt/n/history/contexts starts
              // clean here regardless of what the imported card claims.
              const card = {
                word: clean, lang, box: 1, nextDueAt: now, addedAt: now, lastGradedAt: 0,
                sentence: f.sentence || "", sentenceT: f.sentenceT || "", videoTitle: f.videoTitle || "",
                base: "", ms: f.ms || 0, channel: f.channel || "",
                n: 1, lemma: f.lemma || null, pos: f.pos || null, art: f.art || null, plural: null,
                cefr: f.cefr || null, meaning: f.meaning || null, phrase: f.phrase || null, note: f.note || null,
                para: f.para || null, sep: f.sep === true,
                conj: null, history: [], contexts: [],
              };
              if (gift) card.gift = gift;
              await idbVocabPut(key, card);
              added++;
            } catch {}
          }
          for (const u of toUpdateIn) {
            try {
              const key = typeof (u && u.key) === "string" ? u.key : "";
              // isCardKey guard is belt-and-suspenders on top of the lang-level
              // check above (review fix round 1) — key.startsWith(lang + ":")
              // alone only excludes reserved namespaces THROUGH lang being
              // clean; this keeps the exclusion correct even if that changes.
              if (!key || !key.startsWith(lang + ":") || !isCardKey(key)) continue;
              const cur = await idbVocabGet(key);
              if (!cur) continue;
              if (await mergeOntoExisting(key, cur, u.fields)) updated++;
            } catch {}
          }
          sendResponse({ ok: true, added, updated });
          break;
        }
        case "VOCAB_KNOWN": {
          // "know it ✓" — instantly mastered (box 5), same card shape as
          // vocabAdd for a word that was never saved yet (fold rows may or
          // may not already have a Leitner card). Keyed the same way vocabAdd
          // computes it, so an existing card is found and upgraded in place.
          const clean = SV_VOCAB.tokenize(msg.word)[0] || String(msg.word || "").trim();
          if (!clean) { sendResponse({ error: "missing word" }); break; }
          const lang = (msg.lang || "xx").split("-")[0].toLowerCase();
          const key = `${lang}:${clean.toLowerCase()}`;
          const cur = await idbVocabGet(key);
          const now = Date.now();
          const nextDueAt = now + 16 * SV_LEITNER.DAY;
          const card = cur
            ? { ...cur, box: 5, lastGradedAt: now, nextDueAt }
            : { word: clean, lang, box: 5, nextDueAt, addedAt: now, lastGradedAt: now,
                sentence: "", sentenceT: "", videoTitle: "", base: "", ms: 0, n: 1,
                lemma: null, pos: null, art: null, plural: null, cefr: null, meaning: null,
                phrase: null, note: null, conj: null, history: [], contexts: [] };
          await idbVocabPut(key, card);
          sendResponse({ ok: true, key, card });
          break;
        }
        case "VOCAB_DUE_COUNT": {
          // Also the popup Learn tab's dashboard feed: per-box counts, inbox
          // totals, enrichment progress — one message, one store scan.
          const rows = await idbVocabList("");
          const cards = rows.filter((r) => isCardKey(r.key)).map((r) => r.value);
          const boxes = [0, 0, 0, 0, 0];
          for (const c of cards) boxes[Math.min(5, Math.max(1, c.box || 1)) - 1]++;
          const inboxRows = rows.filter((r) => r.key.startsWith("inbox:")).map((r) => r.value).filter((v) => v && v.words && v.words.length);
          sendResponse({
            due: SV_LEITNER.dueCards(cards, Date.now()).length, total: cards.length, boxes,
            enriched: cards.filter((c) => c.cefr && c.cefr !== "?").length,
            inboxVideos: inboxRows.length,
            inboxWords: inboxRows.reduce((a, v) => a + v.words.length, 0),
          });
          break;
        }
        case "VOCAB_CLIP_WORDS": {
          // The popup's Learn tab: THIS video's words + their sentences,
          // extracted on demand from the cache — same scoping rules as the
          // inbox build, zero network. A cached clip enrichment (see
          // VOCAB_CLIP_ENRICH) rides along: meaning/level/article per word.
          const data = await clipWordData(String(msg.base || ""), (msg.limit | 0) > 0 ? (msg.limit | 0) : 150);
          if (data.words.length) {
            const ce = await idbVocabGet("clipenrich:" + msg.base);
            if (ce && ce.e) {
              for (const w of data.words) Object.assign(w, faClean(ce.target, { ...(ce.e[w.w.toLowerCase()] || {}) }, ENTRY_FA_KEYS));
              data.enriched = true;
            }
            // Lemma dedup: once enrichment knows lemmas, inflected forms
            // ("geht/ging/gegangen") collapse onto one entry — counts add up,
            // the highest-ranked surface form stays visible.
            if (data.enriched) {
              const byLemma = new Map();
              const out = [];
              for (const w of data.words) {
                const k = (w.lemma || w.w).toLowerCase();
                const prev = byLemma.get(k);
                if (prev) prev.n += w.n;
                else { byLemma.set(k, w); out.push(w); }
              }
              data.words = out;
            }
            // How many pool words still lack USABLE enrichment — junk back-fill
            // rows from a failed run ("?" level, no meaning) count as missing,
            // so a broken batch is re-buyable instead of frozen.
            data.enrichable = data.words.filter((w) => !w.cefr || (w.cefr === "?" && !w.meaning)).length;
            data.enriching = clipEnrichInFlight.has(String(msg.base)); // a run is underway — the popup shows progress, not a pay button
          }
          if (data.words && data.words.length) {
            // "Seen N× before": annotate each pool word with the OTHER videos it
            // already turned up in (from the inbox rows the worker owns).
            const inboxRows = (await idbVocabList("inbox:")).map((r) => r.value);
            SV_VOCAB.crossVideoSightings(data.words, inboxRows, String(msg.base || ""));
          }
          sendResponse(data);
          break;
        }
        case "VOCAB_WORD_ENRICH": {
          // ONE word + its sentence's GRAMMAR — one call, two results, both
          // cached forever (clipenrich for the word, clipgram for the
          // sentence). A deliberate hover IS the user trigger; every call is
          // logged; a fully-cached pair costs nothing.
          const base = String(msg.base || ""), word = String(msg.w || "").trim();
          if (!base || !word) { sendResponse({ error: "missing word" }); break; }
          const wkey = word.toLowerCase();
          const sent = String(msg.s || "").slice(0, 320); // room for a sentence reconstructed across cues
          // djb2 — stable, tiny key for the sentence cache.
          let h = 5381;
          for (let i = 0; i < sent.length; i++) h = ((h << 5) + h + sent.charCodeAt(i)) | 0;
          const skey = "s2" + (h >>> 0).toString(36); // s2 = plain-register prompt; old stiff-register entries regenerate on next hover
          const ce = (await idbVocabGet("clipenrich:" + base)) || { base, lang: msg.lang || "xx", at: Date.now(), e: {} };
          const cg = (await idbVocabGet("clipgram:" + base)) || { base, at: Date.now(), e: {} };
          const have = ce.e[wkey];
          const haveG = cg.e[skey];
          // Serve from cache ONLY when it actually carries a meaning — a blank
          // meaning (a word the model once returned empty) must re-fetch, never
          // freeze the card on "no meaning".
          if (have && have.meaning && haveG !== undefined) {
            sendResponse({ ok: true, e: faClean(have.tl || ce.target, { ...have }, ENTRY_FA_KEYS),
              g: (have.tl || ce.target || "").startsWith("fa") ? SV_VOCAB.normalizeFa(haveG) : haveG, cached: true });
            break;
          }
          const { targets: cfgW } = await chrome.storage.local.get(["targets"]);
          const target = (Array.isArray(cfgW) && cfgW[0]) || "en";
          try {
            // Models occasionally blank a valid word's meaning; give it one more
            // shot before giving up (each attempt is logged for cost honesty).
            let entry = null, gram = "";
            for (let attempt = 0; attempt < 2; attempt++) {
              const started = Date.now();
              const r = await llmJSON(wordPrompt(msg.lang && msg.lang !== "xx" ? msg.lang : "auto", target),
                { w: word, s: sent }, WORD_SCHEMA);
              const [m] = SV_VOCAB.mergeEnrichment([{ word }], [(r.parsed && r.parsed.e) || null]);
              entry = faClean(target, { lemma: m.lemma, pos: m.pos, art: m.art, plural: m.plural, cefr: m.cefr, meaning: m.meaning, phrase: m.phrase, note: m.note, sep: m.sep, para: m.para, tl: target }, ENTRY_FA_KEYS);
              gram = target.startsWith("fa") ? SV_VOCAB.normalizeFa((r.parsed && r.parsed.g) || "").trim() : ((r.parsed && typeof r.parsed.g === "string") ? r.parsed.g.trim() : "");
              await logCall({ ts: started, site: "learn", title: "Word: " + word + (attempt ? " (retry)" : ""), kind: "enrich", lines: 1, ms: Date.now() - started,
                inTok: (r.usage && r.usage.prompt_tokens) || 0, outTok: (r.usage && r.usage.completion_tokens) || 0,
                cacheR: (r.usage && r.usage.cache_r) || 0, cacheW: (r.usage && r.usage.cache_w) || 0, ok: true, provider: r.provider, model: r.model });
              if (entry.meaning) break; // got a real meaning → stop
            }
            // Cache the word only when it has a meaning, so a still-empty result
            // stays re-fetchable instead of frozen. Grammar caches regardless.
            if (entry && entry.meaning) {
              ce.e[wkey] = entry;
              ce.target = target;
              ce.at = Date.now();
              await idbVocabPut("clipenrich:" + base, ce);
            }
            cg.e[skey] = gram;
            cg.target = target;
            cg.at = Date.now();
            await idbVocabPut("clipgram:" + base, cg);
            sendResponse({ ok: true, e: entry, g: gram });
          } catch (e2) {
            sendResponse({ error: String((e2 && e2.message) || e2) });
          }
          break;
        }
        case "VOCAB_EXPLAIN": {
          // The whole line in labeled sections (translation + structure + key
          // words) for the on-video ﹖ button. Cached per sentence forever.
          const base = String(msg.base || ""), sent = String(msg.s || "").slice(0, 320);
          if (!sent) { sendResponse({ error: "missing sentence" }); break; }
          let h = 5381;
          for (let i = 0; i < sent.length; i++) h = ((h << 5) + h + sent.charCodeAt(i)) | 0;
          const skey = "e1" + (h >>> 0).toString(36);
          const cx = (await idbVocabGet("clipexplain:" + base)) || { base, at: Date.now(), e: {} };
          const { targets: cfgX } = await chrome.storage.local.get(["targets"]);
          const target = (Array.isArray(cfgX) && cfgX[0]) || "en";
          const fa = (target || "").split("-")[0] === "fa";
          const faS = (s) => (fa ? SV_VOCAB.normalizeFa(String(s || "")) : String(s || ""));
          if (cx.e[skey] && cx.e[skey].tr) {
            const c = cx.e[skey];
            sendResponse({ ok: true, tr: faS(c.tr), g: faS(c.g), lang: c.lang || "", words: (c.words || []).map((x) => ({ w: x.w, m: faS(x.m) })), cached: true });
            break;
          }
          const started = Date.now();
          // The sentence's OWN language drives the prompt: the popup's "I'm
          // learning" setting is a preference, not a fact about this video —
          // an English line on a German learner's account was being explained
          // as "not a German sentence".
          let lang = msg.lang && msg.lang !== "xx" ? String(msg.lang) : "";
          try { const det = await detectClipLang([{ o: sent }]); if (det && det !== "xx") lang = det; } catch {}
          try {
            const r = await llmJSON(explainPrompt(lang || "auto", target), { s: sent }, EXPLAIN_SCHEMA);
            const p = (r && r.parsed) || {};
            const out = { tr: String(p.tr || "").trim(), g: String(p.g || "").trim(), lang,
              words: Array.isArray(p.words) ? p.words.filter((x) => x && x.w && x.m).slice(0, 6).map((x) => ({ w: String(x.w).trim(), m: String(x.m).trim() })) : [] };
            if (out.tr) { out.s = sent; out.at = started; cx.e[skey] = out; cx.target = target; cx.lang = lang || String(cx.lang || ""); cx.at = Date.now(); await idbVocabPut("clipexplain:" + base, cx); }
            await logCall({ ts: started, site: "learn", title: "Explain: " + sent.slice(0, 40), kind: "enrich", lines: 1, ms: Date.now() - started,
              inTok: (r.usage && r.usage.prompt_tokens) || 0, outTok: (r.usage && r.usage.completion_tokens) || 0,
              cacheR: (r.usage && r.usage.cache_r) || 0, cacheW: (r.usage && r.usage.cache_w) || 0, ok: true, provider: r.provider, model: r.model });
            sendResponse({ ok: true, tr: faS(out.tr), g: faS(out.g), lang, words: out.words.map((x) => ({ w: x.w, m: faS(x.m) })) });
          } catch (e2) {
            sendResponse({ error: String((e2 && e2.message) || e2) });
          }
          break;
        }
        case "VOCAB_CLIP_ENRICH": {
          // One batched request for THIS clip's top words — meaning in the
          // user's primary target, CEFR level, article. Cached FOREVER under
          // clipenrich:${base}: the list display, the level filter, and every
          // card later saved from this clip reuse it for free.
          const base = String(msg.base || "");
          if (clipEnrichInFlight.has(base)) { sendResponse(await clipEnrichInFlight.get(base)); break; }
          const run = (async () => {
            // DELTA enrichment: only pool words the clip's cache doesn't cover
            // yet — a first run does everything, a re-run after the pool grew
            // (or a partial earlier run) levels just the missing words.
            const data = await clipWordData(base, 150);
            if (!data.words.length) return { error: "no words to enrich for this video" };
            const cached0 = (await idbVocabGet("clipenrich:" + base)) || { base, lang: data.lang, at: Date.now(), e: {} };
            // Junk back-fill from a failed earlier run is retryable, not "covered".
            const junk = (e) => e && e.cefr === "?" && !e.meaning;
            const todo = data.words.filter((w) => { const e = cached0.e[w.w.toLowerCase()]; return !e || junk(e); });
            if (!todo.length) return { ok: true, cached: true };
            const { targets: cfg2 } = await chrome.storage.local.get(["targets"]);
            const target = (Array.isArray(cfg2) && cfg2[0]) || "en";
            const started = Date.now();
            let inTok = 0, outTok = 0, cacheR = 0, cacheW = 0, provider = null, model = null, enriched = 0, lastErr = null;
            for (let i = 0; i < todo.length; i += ENRICH_BATCH) {
              const batch = todo.slice(i, i + ENRICH_BATCH);
              try {
                const r = await llmJSON(enrichPrompt(data.lang === "xx" ? "auto" : data.lang, target),
                  { words: batch.map((w) => ({ w: w.w, s: (w.sentence || "").slice(0, 160) })) }, ENRICH_SCHEMA);
                provider = r.provider; model = r.model;
                if (r.usage) { inTok += r.usage.prompt_tokens || 0; outTok += r.usage.completion_tokens || 0; cacheR += r.usage.cache_r || 0; cacheW += r.usage.cache_w || 0; }
                const merged = SV_VOCAB.mergeEnrichment(batch.map((w) => ({ word: w.w })), (r.parsed && r.parsed.e) || []);
                merged.forEach((m, j) => {
                  // tl = the meaning's language: De→Fa data is a different pair
                  // than De→En and must never masquerade as it.
                  cached0.e[batch[j].w.toLowerCase()] = faClean(target, { lemma: m.lemma, pos: m.pos, art: m.art, plural: m.plural, cefr: m.cefr, meaning: m.meaning, phrase: m.phrase, note: m.note, sep: m.sep, para: m.para, tl: target }, ENTRY_FA_KEYS);
                });
                enriched += merged.length;
              } catch (e2) { lastErr = e2; }
            }
            if (enriched) { cached0.target = target; cached0.at = Date.now(); await idbVocabPut("clipenrich:" + base, cached0); }
            if (!provider) {
              const { translationProvider } = await chrome.storage.local.get("translationProvider");
              provider = providerOf(translationProvider);
            }
            await logCall({ ts: started, site: "learn", title: "Words: " + (data.title || base), kind: "enrich", lines: todo.length,
              ms: Date.now() - started, inTok, outTok, cacheR, cacheW, ok: !lastErr,
              err: lastErr ? String((lastErr && lastErr.message) || lastErr) : undefined, provider, model });
            if (!enriched && lastErr) return { error: String((lastErr && lastErr.message) || lastErr) };
            return { ok: true, enriched, failed: todo.length - enriched,
              usd: SV_PRICING.estCost({ provider, model, inTok, outTok, cacheR, cacheW }) };
          })();
          clipEnrichInFlight.set(base, run);
          try { sendResponse(await run); } finally { clipEnrichInFlight.delete(base); }
          break;
        }
        case "VOCAB_ENRICH": {
          // Batches of 50, grouped by the cards' language (one prompt per
          // source language), merged via SV_VOCAB.mergeEnrichment (short-array
          // back-fill included), one Activity row for the whole run.
          const { targets } = await chrome.storage.local.get(["targets"]);
          const target = (Array.isArray(targets) && targets[0]) || "en";
          const started = Date.now();
          const loaded = [];
          for (const k of msg.keys || []) { const c = await idbVocabGet(k); if (c) loaded.push({ key: k, card: c }); }
          const byLang = new Map();
          for (const it of loaded) {
            if (!byLang.has(it.card.lang)) byLang.set(it.card.lang, []);
            byLang.get(it.card.lang).push(it);
          }
          let enriched = 0, inTok = 0, outTok = 0, cacheR = 0, cacheW = 0, provider = null, model = null, lastErr = null;
          for (const [lang, items] of byLang) {
            for (let i = 0; i < items.length; i += ENRICH_BATCH) {
              const batch = items.slice(i, i + ENRICH_BATCH);
              try {
                const r = await llmJSON(enrichPrompt(lang === "xx" ? "auto" : lang, target),
                  { words: batch.map((b) => ({ w: b.card.word, s: (b.card.sentence || "").slice(0, 160) })) }, ENRICH_SCHEMA);
                provider = r.provider; model = r.model;
                if (r.usage) { inTok += r.usage.prompt_tokens || 0; outTok += r.usage.completion_tokens || 0; cacheR += r.usage.cache_r || 0; cacheW += r.usage.cache_w || 0; }
                const merged = SV_VOCAB.mergeEnrichment(batch.map((b) => b.card), (r.parsed && r.parsed.e) || []);
                for (let j = 0; j < batch.length; j++) { await idbVocabPut(batch[j].key, faClean(target, { ...merged[j], tl: target }, ENTRY_FA_KEYS)); enriched++; }
              } catch (e) { lastErr = e; }
            }
          }
          if (!provider) {
            const { translationProvider } = await chrome.storage.local.get("translationProvider");
            provider = providerOf(translationProvider);
          }
          await logCall({ ts: started, site: "learn", title: "Vocabulary enrichment", kind: "enrich", lines: loaded.length,
            ms: Date.now() - started, inTok, outTok, cacheR, cacheW, ok: !lastErr,
            err: lastErr ? String((lastErr && lastErr.message) || lastErr) : undefined, provider, model });
          if (!enriched && lastErr) { sendResponse({ error: String((lastErr && lastErr.message) || lastErr) }); break; }
          // Partial failure is still a failure the user must see: report how many
          // batches' words missed out and why, not just the success count.
          sendResponse({ ok: true, enriched, failed: loaded.length - enriched,
            err: lastErr ? String((lastErr && lastErr.message) || lastErr) : undefined,
            usd: SV_PRICING.estCost({ provider, model, inTok, outTok, cacheR, cacheW }) });
          break;
        }
        case "VOCAB_CONJUGATE": {
          const card = await idbVocabGet(msg.key);
          if (!card) { sendResponse({ error: "no such card: " + msg.key }); break; }
          if (card.conj) { sendResponse({ ok: true, conj: card.conj, cached: true }); break; } // cached forever — free
          const started = Date.now();
          const label = "Conjugation: " + (card.lemma || card.word);
          try {
            const r = await llmJSON(conjPrompt(card.lang === "xx" ? "auto" : card.lang), { verb: card.lemma || card.word }, null);
            const forms = r.parsed && r.parsed.forms;
            if (!forms || typeof forms !== "object" || Array.isArray(forms)) throw new Error("the model returned no conjugation table");
            card.conj = forms;
            await idbVocabPut(msg.key, card);
            await logCall({ ts: started, site: "learn", title: label, kind: "enrich", lines: 1, ms: Date.now() - started,
              inTok: (r.usage && r.usage.prompt_tokens) || 0, outTok: (r.usage && r.usage.completion_tokens) || 0,
              cacheR: (r.usage && r.usage.cache_r) || 0, cacheW: (r.usage && r.usage.cache_w) || 0,
              ok: true, provider: r.provider, model: r.model });
            sendResponse({ ok: true, conj: forms });
          } catch (e) {
            const { translationProvider } = await chrome.storage.local.get("translationProvider");
            await logCall({ ts: started, site: "learn", title: label, kind: "enrich", lines: 1, ms: Date.now() - started,
              inTok: 0, outTok: 0, ok: false, err: String((e && e.message) || e),
              provider: providerOf(translationProvider) });
            sendResponse({ error: String((e && e.message) || e) });
          }
          break;
        }
        case "SIMPLIFY_TEXT":
          sendResponse(await simplifyText(msg.text));
          break;
        case "CLI_PING": { // popup → Keys → Claude Code on this Mac → Test
          try { const r = await cliSend({ type: "ping" }); sendResponse(r && r.ok ? { ok: true, claude: r.claude || "", bin: r.bin || "" } : { ok: false, error: (r && r.error) || "no reply from the bridge" }); }
          catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
          break;
        }
        case "SHOT_START": {
          let shotTab = null;
          if (msg.tabId != null) { try { shotTab = await chrome.tabs.get(msg.tabId); } catch (e) { shotTab = null; } }
          if (!shotTab) shotTab = await activeTabHere();
          sendResponse(await startShot(shotTab, String(msg.mode || "area")));
          break;
        }
        case "CLIP_RECORD": {
          let clipTab = null;
          if (msg.tabId != null) { try { clipTab = await chrome.tabs.get(msg.tabId); } catch (e) { clipTab = null; } }
          if (!clipTab) clipTab = await activeTabHere();
          sendResponse(await startClip(clipTab));
          break;
        }
        case "CLIP_BEGIN": clipXfer.set(String(msg.id), { parts: new Array(msg.total | 0), meta: msg.meta || {} }); sendResponse({ ok: true }); break;
        case "CLIP_CHUNK": { const x = clipXfer.get(String(msg.id)); if (x) x.parts[msg.i | 0] = String(msg.b64 || ""); sendResponse({ ok: !!x }); break; }
        case "CLIP_END": sendResponse({ ok: true }); clipStore(String(msg.id)); break;
        case "SHOT_BEGIN": sendResponse(await shotBegin(msg, sender)); break;
        case "SHOT_TRANSLATE": sendResponse(await shotTranslate(msg, sender)); break;
        case "SHOT_TILE": sendResponse(await shotTile(msg, sender)); break;
        case "SHOT_COMPOSE": sendResponse(await shotCompose(msg, sender)); break;
        case "SHOT_ABORT": { const s = shotSessionOf(sender); if (s) shotSessions.delete(s.tabId); sendResponse({ ok: true }); break; }
        case "SHOT_RESHOOT": sendResponse(await shotReshoot(msg, sender)); break;
        case "SHOT_TAB_ALIVE": sendResponse(await shotTabAlive(msg.id)); break;
        case "SHOT_RETRANSLATE": sendResponse(await shotRetranslate(msg, sender)); break;
        case "SHOT_STUDY": sendResponse(await shotStudy(msg)); break;
        case "TIPS_SHEET": sendResponse(await tipsSheet(msg)); break;
        case "TIPS_SNAP": sendResponse(await tipsSnap(msg, sender)); break;
        default:
          sendResponse({ error: "unknown message: " + (msg && msg.type) });
      }
    } catch (e) {
      sendResponse({ error: String((e && e.message) || e) });
    }
  })();
  return true; // keep the channel open for the async response
});
