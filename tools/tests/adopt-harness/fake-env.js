// chrome stub + YouTube-shaped adapter for the adoption harness.
(function () {
  const settings = {
    enabled: true, targets: ["fa"], showOriginal: true, hideNative: true, karaokeHl: true,
    translationProvider: "openai", apiKey: "sk-test", debugHud: true,
    position: "bottom", size: "md", stylePreset: "classic", styleCustom: {}, syncOffset: 0,
  };
  // 400-cue WebVTT "file" the FETCH_SUBS stub serves.
  let vtt = "WEBVTT\n\n";
  for (let i = 0; i < 400; i++) {
    const s = i * 2, e = s + 1.8;
    const ts = (t) => "00:" + String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(Math.floor(t % 60)).padStart(2, "0") + "." + String(Math.round((t % 1) * 1000)).padStart(3, "0");
    vtt += (i + 1) + "\n" + ts(s) + " --> " + ts(e) + "\nFile line number " + (i + 1) + " spoken here.\n\n";
  }
  window.__fetchCount = 0;
  // ?slow=1 reproduces the real YouTube timing: getCaptionTracks is a slow
  // network call, and the caption file lands while a start() awaits it.
  window.__SLOW = new URLSearchParams(location.search).get("slow") === "1";
  window.__warns = [];
  const w = console.warn.bind(console);
  console.warn = (...a) => { window.__warns.push(a.map(String).join(" ")); w(...a); };
  window.chrome = {
    runtime: {
      id: "harness", lastError: undefined, getURL: (p) => "/" + p,
      onMessage: { addListener() {} },
      sendMessage: (msg, cb) => {
        let r = { ok: true };
        if (msg && msg.type === "FETCH_SUBS") { window.__fetchCount++; r = { ok: true, status: 200, text: vtt }; }
        else if (msg && msg.type === "CACHE_GET") r = { track: null };
        else if (msg && msg.type === "TRANSLATE") r = { lines: (msg.cues || []).map((s) => "FA·" + s) };
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
    async getCaptionTracks() {                     // direct download path finds nothing
      if (window.__SLOW) await new Promise((r) => setTimeout(r, 3000)); // real network latency
      return [];
    },
    async fetchCues() { return []; },
    readNativeText() { return window.__nativeLine || ""; }, // rolling captions → scrape engages
    onNavigate() {},
  };
  (window.__copilotAdapters = window.__copilotAdapters || []).push(adapter);
})();
