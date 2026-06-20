// SubVibe — background service worker.
//
// Owns the two things a content script can't: (1) the IndexedDB subtitle
// cache, and (2) cross-origin OpenAI calls (content-script fetches to
// api.openai.com would be blocked by page CORS; the worker has host
// permission and is exempt). Everything is request/response over
// chrome.runtime messaging.

const OPENAI_CHAT = "https://api.openai.com/v1/chat/completions";
const TRANSLATE_MODEL = "gpt-4o-mini";
const BATCH = 60; // cues per translation request — keeps JSON responses reliable
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

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capture audio to transcribe live subtitles.",
  });
}

// ─── IndexedDB cache (inlined so the worker needs no imports) ────────────────

let _dbPromise = null;
function db() {
  if (!_dbPromise) {
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("copilot-subs", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("tracks");
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
    const r = d.transaction("tracks", "readwrite").objectStore("tracks").clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

// Delete only the cache entries for ONE clip (keys starting with its base prefix,
// e.g. "youtube:…:auto:fa" / ":auto:de"). Returns how many were removed.
async function idbDeletePrefix(prefix) {
  if (!prefix) return 0;
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
        else { items.sort((a, b) => (a[1] < b[1] ? -1 : 1)); for (let i = 0; i < over; i++) store.delete(items[i][0]); resolve(); }
      };
    };
    cnt.onerror = () => resolve();
  });
}

// ─── Translation (Mode A) ────────────────────────────────────────────────────

// Reused, condensed from scenarios/interview_helper.yaml's "PURE TRANSLATION
// engine" prompt. Returns a JSON object so we can validate exact line counts.
function systemPrompt(source, target, n, keepTerms, keepNames) {
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
  if ((target || "").split("-")[0] === "fa") {
    p +=
      `6. Persian: use natural spoken Persian for casual dialogue (e.g. «می‌کنی»، «بهت»، «بریم»), ` +
      `Persian punctuation (؟ ،), and Latin digits. Avoid stiff/over-formal phrasing unless the speaker is formal.\n`;
  }
  if (keepNames) {
    p += `\nIMPORTANT: Keep ALL proper nouns — people, places, companies, brands, and product/technical ` +
      `names (e.g. MySQL, React, Wharton) — in their ORIGINAL spelling and script; do NOT translate or transliterate them.\n`;
  }
  if (keepTerms && keepTerms.trim()) {
    p += `Also keep these exact terms unchanged: ${keepTerms.trim()}.\n`;
  }
  p += `\nReturn STRICT JSON: {"t": [...]} with EXACTLY ${n} strings, in the same order as "lines".`;
  return p;
}

async function translateChunk(lines, source, target, apiKey, context, keepTerms, keepNames) {
  const userPayload = context && context.length ? { context, lines } : { lines };
  const body = {
    model: TRANSLATE_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt(source, target, lines.length, keepTerms, keepNames) },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
  };
  let lastStatus = 0, lastBody = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 500 * attempt)); // brief backoff between retries
    const res = await fetch(OPENAI_CHAT, {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    if (res.ok) {
      if (!txt) throw new Error("OpenAI returned an empty response");
      let data;
      try { data = JSON.parse(txt); } catch { throw new Error("OpenAI returned a non-JSON response"); }
      const content = data?.choices?.[0]?.message?.content || "{}";
      let parsed;
      try { parsed = JSON.parse(content); } catch { throw new Error("the model returned malformed JSON"); }
      const arr = parsed.t || parsed.translations || parsed.lines || [];
      return { lines: Array.isArray(arr) ? arr : [], usage: data.usage || null };
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

async function translateAll(lines, source, target, context) {
  const { apiKey, keepTerms, keepNames } = await chrome.storage.local.get(["apiKey", "keepTerms", "keepNames"]);
  if (!apiKey) throw new Error("No OpenAI API key yet — open the SubVibe popup and paste your key.");
  const keepN = keepNames !== false; // default ON
  const out = new Array(lines.length);
  let lastErr = null, failedBatches = 0, totalBatches = 0, inTok = 0, outTok = 0;
  for (let i = 0; i < lines.length; i += BATCH) {
    const chunk = lines.slice(i, i + BATCH);
    totalBatches++;
    let r = null;
    try {
      r = await translateChunk(chunk, source, target, apiKey, context, keepTerms, keepN);
    } catch (e) {
      lastErr = e; // one retry before giving up on this batch
      try { r = await translateChunk(chunk, source, target, apiKey, null, keepTerms, keepN); }
      catch (e2) { lastErr = e2; r = null; }
    }
    if (r && r.usage) { inTok += r.usage.prompt_tokens || 0; outTok += r.usage.completion_tokens || 0; }
    const translated = r && r.lines;
    if (!translated) {
      failedBatches++;
      console.warn("[CopilotSubs bg] translate batch failed:", lastErr && lastErr.message);
      for (let j = 0; j < chunk.length; j++) out[i + j] = chunk[j]; // fall back to original text
    } else {
      for (let j = 0; j < chunk.length; j++) out[i + j] = translated[j] ?? chunk[j];
    }
  }
  // If EVERY batch failed, surface the real reason instead of silently handing
  // back untranslated text (which used to look like "nothing happened").
  if (failedBatches === totalBatches && lastErr) throw new Error(lastErr.message);
  return { out, inTok, outTok };
}

// ─── Provider call log (local-only transparency) ─────────────────────────────
// Every OpenAI call is recorded ON-DEVICE: when, which site, #lines, tokens in/
// out (→ estimated cost), latency, ok/error. Surfaced in the Library's Activity
// tab so the user can SEE exactly what was sent, how often, and what it costs.
// Bounded ring buffer; nothing here ever leaves the device.
const CALL_LOG_KEY = "callLog";
const CALL_LOG_MAX = 300;
async function logCall(rec) {
  try {
    const cur = (await chrome.storage.local.get(CALL_LOG_KEY))[CALL_LOG_KEY];
    const arr = Array.isArray(cur) ? cur : [];
    arr.push(rec);
    if (arr.length > CALL_LOG_MAX) arr.splice(0, arr.length - CALL_LOG_MAX);
    await chrome.storage.local.set({ [CALL_LOG_KEY]: arr });
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
          const meta = { ts: started, site: msg.site, title: msg.title, target: msg.target, lines: (msg.cues || []).length };
          try {
            const r = await translateAll(msg.cues, msg.source, msg.target, msg.context);
            await logCall({ ...meta, ms: Date.now() - started, inTok: r.inTok, outTok: r.outTok, ok: true });
            sendResponse({ lines: r.out });
          } catch (e) {
            await logCall({ ...meta, ms: Date.now() - started, inTok: 0, outTok: 0, ok: false, err: String((e && e.message) || e) });
            throw e; // let the outer catch send the {error} response
          }
          break;
        }
        case "LOG_LIST":
          sendResponse({ calls: (await chrome.storage.local.get(CALL_LOG_KEY))[CALL_LOG_KEY] || [] });
          break;
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
        case "LOOKAHEAD": {
          // Toolbar icon as a COST signal for the reporting tab:
          //   "✓" green  = caught up — replaying cached/ready lines, NO API cost
          //   number     = actively pre-translating ahead (may be spending); amber,
          //                or red when a line is about to show untranslated.
          // The hover tooltip spells it out in words.
          const tabId = sender && sender.tab && sender.tab.id;
          if (tabId != null) {
            try {
              if (msg.off) {
                await chrome.action.setBadgeText({ tabId, text: "" });
                await chrome.action.setTitle({ tabId, title: "SubVibe" });
              } else if (msg.free) {
                await chrome.action.setBadgeText({ tabId, text: "✓" });
                await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2e9e5b" });
                await chrome.action.setTitle({ tabId, title: "SubVibe — caught up · replaying ready/cached lines · no API cost" });
              } else {
                const n = Math.max(0, msg.count | 0);
                await chrome.action.setBadgeText({ tabId, text: n > 99 ? "99+" : String(n) });
                await chrome.action.setBadgeBackgroundColor({ tabId, color: msg.state === "miss" ? "#c0392b" : "#c77f0a" });
                await chrome.action.setTitle({ tabId, title: `SubVibe — translating ahead · ${n} line${n === 1 ? "" : "s"} ready` });
              }
            } catch {}
          }
          sendResponse({ ok: true });
          break;
        }
        case "START_AUDIO":
          audioTabId = sender?.tab?.id ?? msg.tabId;
          await ensureOffscreen();
          chrome.runtime.sendMessage({ type: "AUDIO_START", deviceId: msg.deviceId });
          sendResponse({ ok: true });
          break;
        case "STOP_AUDIO":
          chrome.runtime.sendMessage({ type: "AUDIO_STOP" });
          if (audioTabId != null) chrome.tabs.sendMessage(audioTabId, { type: "AUDIO_STOP" }).catch(() => {});
          try { await chrome.offscreen.closeDocument(); } catch {}
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
