// chrome stub + YouTube-shaped adapter for the story-board harness (tips once per chorus, scene once, price, ×).
(function () {
  const NOPOOL = new URLSearchParams(location.search).get("nopool"); // clip's language isn't the one being learned → empty pool
  const SPLIT = new URLSearchParams(location.search).get("split");   // a sentence split across two cues (buildGroups breaks it)
  const RUNAWAY = new URLSearchParams(location.search).get("runaway"); // many cues, NO sentence punctuation (slow-German ASR)
  const settings = {
    enabled: true, targets: ["en"], showOriginal: true, hideNative: true, karaokeHl: true,
    karaokeStyle: new URLSearchParams(location.search).get("hl") || "classic",
    translationProvider: "openai", apiKey: "sk-test", debugHud: false,
    position: "bottom", size: "md", stylePreset: "classic", styleCustom: {}, syncOffset: 0, storyBoard: true,
  };
  // 10-cue German WebVTT "file" the FETCH_SUBS stub serves. Sentence 1 is the
  // click target; the words are plain single-space tokens so lineUnits() builds
  // karaoke spans from estimated timings.
  // A song: the chorus comes back with and without ">>", each line its own cue, far apart so each is its own chunk.
  // A song where every line is its own chunk (a ">>" speaker mark starts one), as in the 2026-10-03 deep-house mix:
  // the chorus comes back with a different end ("." vs none) and must reuse the first chunk's tips (no second call).
  const LINES = [">> I'm lost without you.", ">> We drift away through city lights.", ">> I'm lost without you", ">> Stay with me tonight."];
  let vtt = "WEBVTT\n\n";
  LINES.forEach((l, i) => {
    const s = i * 8, e = s + 3;
    const ts = (t) => "00:" + String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(Math.floor(t % 60)).padStart(2, "0") + "." + String(Math.round((t % 1) * 1000)).padStart(3, "0");
    vtt += (i + 1) + "\n" + ts(s) + " --> " + ts(e) + "\n" + l + "\n\n";
  });
  window.__vocabMsgs = []; window.__explainMsgs = []; // every VOCAB_ADD / VOCAB_EXPLAIN the content script sends
  window.chrome = {
    runtime: {
      id: "harness", lastError: undefined, getURL: (p) => "/" + p,
      onMessage: { addListener() {} },
      sendMessage: (msg, cb) => {
        let r = { ok: true };
        if (msg && msg.type === "FETCH_SUBS") r = { ok: true, status: 200, text: vtt };
        else if (msg && msg.type === "CACHE_GET") r = { track: null };
        else if (msg && msg.type === "TRANSLATE") r = { lines: (msg.cues || []).map((s) => "EN·" + s) };
        else if (msg && msg.type === "VOCAB_ADD") { window.__vocabMsgs.push(msg); r = { ok: true, key: "de:x", card: {} }; }
        else if (msg && msg.type === "VOCAB_WORD_ENRICH") { window.__enrichS = msg.s; r = { ok: true, e: { meaning: "خیابان", cefr: "A1", pos: "noun" }, g: "زمان حال ساده" }; }
        else if (msg && msg.type === "VOCAB_EXPLAIN") { window.__explainMsgs.push(msg); const w = String(msg.s).match(/[A-Za-z']{4,}/g) || []; r = { ok: true, tr: "TR·" + msg.s, g: "«" + msg.s + "» — a note", scene: "The singer tells the beloved they are lost without them.", who: ["the singer"], words: w.slice(0, 4).map((x) => ({ w: x.toLowerCase(), m: "what “" + x.toLowerCase() + "” means here", pos: "verb" })) }; }
        else if (msg && msg.type === "TIPS_ESTIMATE") r = { ok: true, each: 0.021, provider: "openai" };
        else if (msg && msg.type === "VOCAB_CLIP_WORDS") r = (NOPOOL || SPLIT || RUNAWAY) ? { words: [], reason: "other-lang", lang: "de" } : { enriched: true, lang: "de", title: "t", dim: ["die"], words: [
          { w: "Hund", n: 1, sentence: "", st: "", meaning: "سگ" },              // enriched → tooltip shows the meaning
          { w: "Straße", n: 1, sentence: "", st: "" },                           // pool word without meaning → hinted, honest tooltip
          { w: "schnell", n: 2, sentence: "", st: "", cefr: "B1", meaning: "سریع" } ] }; // leveled → CEFR-colored underline
        if (cb) setTimeout(() => cb(r), 20);
      },
    },
    storage: {
      onChanged: { addListener() {} },
      local: {
        get: (keys, cb) => { const out = {}; const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(settings); for (const k of list) if (k in settings) out[k] = settings[k]; if (cb) { cb(out); return; } return Promise.resolve(out); },
        set: async (o) => { Object.assign(settings, o); window.__storageSets = (window.__storageSets || []).concat([o]); },
      },
    },
  };
  const adapter = {
    site: "youtube",
    matches: () => true,
    getVideoId: () => "vid123",
    getVideoEl: () => document.getElementById("vid"),
    getPlayerContainer: () => document.getElementById("player"),
    async getCaptionTracks() { return []; },
    async fetchCues() { return []; },
    readNativeText() { return ""; }, // scrape idles empty; the SUBS_URL file then upgrades to cuelist — the proven adopt flow
    onNavigate() {},
  };
  (window.__copilotAdapters = window.__copilotAdapters || []).push(adapter);
})();
