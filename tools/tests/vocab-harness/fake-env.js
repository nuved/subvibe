// chrome stub + YouTube-shaped adapter for the vocab click-to-save harness.
(function () {
  const settings = {
    enabled: true, targets: ["en"], showOriginal: true, hideNative: true, karaokeHl: true,
    karaokeStyle: new URLSearchParams(location.search).get("hl") || "classic",
    translationProvider: "openai", apiKey: "sk-test", debugHud: false,
    position: "bottom", size: "md", stylePreset: "classic", styleCustom: {}, syncOffset: 0,
  };
  // 10-cue German WebVTT "file" the FETCH_SUBS stub serves. Sentence 1 is the
  // click target; the words are plain single-space tokens so lineUnits() builds
  // karaoke spans from estimated timings.
  const LINES = [
    "Der Hund läuft schnell über die Straße.",
    "Ich habe das gestern nicht gewusst.",
    "Wir gehen jetzt nach Hause zurück.",
    "Das Wetter ist heute wirklich schön.",
    "Sie liest jeden Abend ein Buch.",
    "Der Zug kommt gleich am Bahnhof an.",
    "Kannst du mir bitte kurz helfen?",
    "Morgen fahren wir in die Berge.",
    "Das Essen schmeckt mir sehr gut.",
    "Er arbeitet seit Jahren in Berlin.",
  ];
  let vtt = "WEBVTT\n\n";
  LINES.forEach((l, i) => {
    const s = i * 8, e = s + 7.8; // long cues: cue 0 must still be on screen when the driver clicks at ~5s
    const ts = (t) => "00:" + String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(Math.floor(t % 60)).padStart(2, "0") + "." + String(Math.round((t % 1) * 1000)).padStart(3, "0");
    vtt += (i + 1) + "\n" + ts(s) + " --> " + ts(e) + "\n" + l + "\n\n";
  });
  window.__vocabMsgs = []; // every VOCAB_ADD the content script sends
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
        else if (msg && msg.type === "VOCAB_WORD_ENRICH") r = { ok: true, e: { meaning: "خیابان", cefr: "A1", pos: "noun" }, g: "زمان حال ساده" };
        else if (msg && msg.type === "VOCAB_CLIP_WORDS") r = { enriched: true, lang: "de", title: "t", dim: ["die"], words: [
          { w: "Hund", n: 1, sentence: "", st: "", meaning: "سگ" },              // enriched → tooltip shows the meaning
          { w: "Straße", n: 1, sentence: "", st: "" },                           // pool word without meaning → hinted, honest tooltip
          { w: "schnell", n: 2, sentence: "", st: "", cefr: "B1", meaning: "سریع" } ] }; // leveled → CEFR-colored underline
        if (cb) setTimeout(() => cb(r), 20);
      },
    },
    storage: {
      onChanged: { addListener() {} },
      local: {
        get: async (keys) => { const out = {}; const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(settings); for (const k of list) if (k in settings) out[k] = settings[k]; return out; },
        set: async (o) => Object.assign(settings, o),
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
