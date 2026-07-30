// SubVibe — background service worker.
//
// Owns the two things a content script can't: (1) the IndexedDB subtitle
// cache, and (2) cross-origin OpenAI calls (content-script fetches to
// api.openai.com would be blocked by page CORS; the worker has host
// permission and is exempt). Everything is request/response over
// chrome.runtime messaging.

importScripts("shared/pricing.js"); // SV_PRICING — one cost model shared with Library/popup

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
const CLAUDE_MODELS = ["claude-sonnet-5", "claude-haiku-4-5"];
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
      const req = indexedDB.open("copilot-subs", 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("tracks")) d.createObjectStore("tracks");
        if (!d.objectStoreNames.contains("audio")) d.createObjectStore("audio");
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
function systemPrompt(source, target, keepTerms, keepNames) {
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

async function translateChunk(lines, source, target, apiKey, context, keepTerms, keepNames) {
  const userPayload = context && context.length ? { count: lines.length, context, lines } : { count: lines.length, lines };
  const body = {
    model: TRANSLATE_MODEL,
    temperature: 0,
    response_format: { type: "json_schema", json_schema: TRANSLATE_SCHEMA },
    messages: [
      { role: "system", content: systemPrompt(source, target, keepTerms, keepNames) },
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
async function translateChunkClaude(lines, source, target, apiKey, context, keepTerms, keepNames, model) {
  const userPayload = context && context.length ? { count: lines.length, context, lines } : { count: lines.length, lines };
  const body = {
    model,
    max_tokens: CLAUDE_MAX_TOKENS,
    // cache_control: the system prompt is cache-stable (see systemPrompt) — on
    // cache hits its tokens bill at ~10% instead of full price. Engages only
    // once the prefix clears Anthropic's ~1024-token minimum (the Persian
    // prompt with examples does; a shorter one is silently uncached, no harm).
    system: [{ type: "text", text: systemPrompt(source, target, keepTerms, keepNames), cache_control: { type: "ephemeral" } }],
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

async function translateAll(lines, source, target, context) {
  const { apiKey, anthropicKey, keepTerms, keepNames, translationProvider, claudeModel } =
    await chrome.storage.local.get(["apiKey", "anthropicKey", "keepTerms", "keepNames", "translationProvider", "claudeModel"]);
  const provider = translationProvider === "claude" ? "claude" : "openai";
  const key = provider === "claude" ? anthropicKey : apiKey;
  if (!key) {
    throw new Error(provider === "claude"
      ? "No Anthropic API key yet — open the SubVibe popup and paste your key."
      : "No OpenAI API key yet — open the SubVibe popup and paste your key.");
  }
  const chunkFn = provider === "claude" ? translateChunkClaude : translateChunk;
  const model = provider === "claude" ? resolveClaudeModel(claudeModel) : TRANSLATE_MODEL;
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
      return await chunkFn(chunk, source, target, key, ctx, keepTerms, keepN, model);
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
  for (let i = 0; i < lines.length; i += BATCH) {
    const chunk = lines.slice(i, i + BATCH);
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
  return { out, spk, gen, dub, inTok, outTok, cacheR, cacheW, provider, model };
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
            const provider = translationProvider === "claude" ? "claude" : "openai";
            await logCall({ ...meta, ms: Date.now() - started, inTok: 0, outTok: 0, ok: false, err: String((e && e.message) || e), provider, model: provider === "claude" ? resolveClaudeModel(claudeModel) : TRANSLATE_MODEL });
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
            chrome.runtime.sendMessage({ type: "LIVE_START", streamId: msg.streamId, origVol: msg.origVol, deviceId: msg.deviceId, target: msg.target, model: msg.model });
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
          sendResponse({ running: liveActive });
          break;
        case "LIVE_TEXT":
          if (liveTabId != null) chrome.tabs.sendMessage(liveTabId, { type: "LIVE_LINE", original: msg.original, translated: msg.translated }).catch(() => {});
          sendResponse({ ok: true });
          break;
        case "LIVE_STATE":
          if (!msg.running) liveActive = false; // any terminal state — clean stop OR death-with-error
          if (liveTabId != null) chrome.tabs.sendMessage(liveTabId, { type: "LIVE_STATE", running: msg.running, error: msg.error }).catch(() => {});
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
        default:
          sendResponse({ error: "unknown message: " + (msg && msg.type) });
      }
    } catch (e) {
      sendResponse({ error: String((e && e.message) || e) });
    }
  })();
  return true; // keep the channel open for the async response
});
