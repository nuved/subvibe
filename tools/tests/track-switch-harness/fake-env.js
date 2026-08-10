// chrome stub + generic native-track adapter for the track-switch harness.
// Models a ZDF/DW-shaped site: subtitles live ONLY in the <video>'s textTracks
// (no caption-file URL, no scrapeable rolling text) — the readVideoCueList path.
(function () {
  const settings = {
    enabled: true, targets: ["fa"], showOriginal: true, hideNative: true, karaokeHl: true,
    translationProvider: "openai", apiKey: "sk-test", debugHud: true,
    position: "bottom", size: "md", stylePreset: "classic", styleCustom: {}, syncOffset: 0,
  };
  window.__warns = [];
  const w = console.warn.bind(console);
  console.warn = (...a) => { window.__warns.push(a.map(String).join(" ")); w(...a); };
  // Phase 2 serves timedtext-shaped subtitle FILES per language (the YouTube
  // path): ?lang=de → German lines, ?lang=en → English lines.
  window.__PHASE = new URLSearchParams(location.search).get("autorun") === "2" ? 2 : 1;
  const vttFor = (lang) => {
    const word = lang === "de" ? "German" : "English";
    let vtt = "WEBVTT\n\n";
    for (let i = 0; i < 60; i++) {
      const s = i * 2, e = s + 1.8;
      const ts = (t) => "00:" + String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(Math.floor(t % 60)).padStart(2, "0") + "." + String(Math.round((t % 1) * 1000)).padStart(3, "0");
      vtt += (i + 1) + "\n" + ts(s) + " --> " + ts(e) + "\n" + word + " line " + (i + 1) + "\n\n";
    }
    return vtt;
  };
  window.__fetchLog = [];
  window.chrome = {
    runtime: {
      id: "harness", lastError: undefined, getURL: (p) => "/" + p,
      onMessage: { addListener() {} },
      sendMessage: (msg, cb) => {
        let r = { ok: true };
        if (msg && msg.type === "FETCH_SUBS") {
          const lang = /[?&]lang=(\w+)/.exec(msg.url || "");
          window.__fetchLog.push(msg.url);
          r = { ok: true, status: 200, text: vttFor(lang ? lang[1] : "en") };
        }
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
    site: "generic",
    matches: () => true,
    getVideoId: () => "clip42",
    getVideoEl: () => document.getElementById("vid"),
    getPlayerContainer: () => document.getElementById("player"),
    async getCaptionTracks() { return []; }, // no direct-download path
    async fetchCues() { return []; },
    readNativeText() { return ""; },         // nothing to scrape — cue list or bust
    onNavigate() {},
  };
  (window.__copilotAdapters = window.__copilotAdapters || []).push(adapter);
})();
