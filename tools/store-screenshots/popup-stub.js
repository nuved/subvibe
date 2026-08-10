// chrome.* stub for capturing popup.html over plain http (store screenshots).
// Injected via Playwright addInitScript BEFORE popup.js runs. Seeds: Claude +
// Sonnet 5, Persian primary target, all keys present, a cached clip, and a
// small enriched German word pool for the Learn tab.
(function () {
  const settings = {
    enabled: true, translateOn: true, subMode: "translate", targets: ["fa", "en"],
    showOriginal: true, hideNative: true, karaokeHl: true, karaokeStyle: "classic",
    learnLang: "de", apiKey: "sk-demo", anthropicKey: "sk-ant-demo", geminiKey: "AIza-demo",
    translationProvider: "claude", claudeModel: "claude-sonnet-5",
    position: "bottom", size: "md", stylePreset: "classic", styleCustom: {}, syncOffset: 0,
    dubEnabled: false, ttsProvider: "openai", dubVoice: "marin", dubGeminiVoice: "Kore",
    dubMultiVoice: false, dubDuckLevel: 0.12, dubPace: 1,
    liveModel: "gemini-3.5-live-translate-preview", audioDeviceId: "", liveTarget: "fa",
    debugHud: false, uiTheme: "light", uiTab: "translate",
    keyVerified: true, anthropicKeyVerified: true, geminiKeyVerified: true,
  };
  const WORDS = [
    { w: "die Geduld", n: 3, cefr: "B1", pos: "noun", meaning: "صبر، شکیبایی", s: "Man braucht viel Geduld beim Lernen.", fa: "برای یادگیری صبر زیادی لازم است." },
    { w: "verbessern", n: 2, cefr: "B1", pos: "verb", meaning: "بهبود دادن", s: "Ich möchte mein Deutsch verbessern.", fa: "می‌خواهم آلمانی‌ام را بهتر کنم." },
    { w: "die Erfahrung", n: 4, cefr: "A2", pos: "noun", meaning: "تجربه", s: "Jede Reise ist eine neue Erfahrung.", fa: "هر سفر یک تجربه‌ی تازه است." },
    { w: "neugierig", n: 1, cefr: "A2", pos: "adj", meaning: "کنجکاو", s: "Kinder sind von Natur aus neugierig.", fa: "کودکان ذاتاً کنجکاو هستند." },
    { w: "der Wortschatz", n: 2, cefr: "B2", pos: "noun", meaning: "دایره واژگان", s: "Filme erweitern deinen Wortschatz.", fa: "فیلم‌ها دایره واژگانت را گسترش می‌دهند." },
  ];
  window.chrome = {
    runtime: {
      id: "shoot", lastError: undefined, getURL: (p) => "/" + p,
      onMessage: { addListener() {} },
      sendMessage: (msg, cb) => {
        let r = { ok: true };
        const t = msg && msg.type;
        if (t === "LIVE_QUERY") r = { running: false, hasOffscreen: true };
        else if (t === "CACHE_LIST") r = { clips: [{ base: "youtube:demo", title: "Learn German with Stories — Café in Berlin", site: "youtube", langs: { fa: 214, en: 214 }, cues: 214, when: Date.now() - 3600e3 }], count: 23 };
        else if (t === "LOG_LIST") r = { rows: [], spendToday: 0.14 };
        else if (t === "VOCAB_CLIP_WORDS") r = { ok: true, lang: "de", title: "Learn German with Stories — Café in Berlin", words: WORDS, enriched: true };
        else if (t === "VOCAB_ADD" || t === "VOCAB_ADD_MANY") r = { ok: true, added: 1, due: 12 };
        const pr = new Promise((res) => setTimeout(() => res(r), 15));
        if (cb) { pr.then(cb); return true; }
        return pr;
      },
    },
    storage: {
      onChanged: { addListener() {} },
      local: {
        get: (keys, cb) => {
          const out = {};
          const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || settings);
          for (const k of list) out[k] = k in settings ? settings[k] : (keys && !Array.isArray(keys) && typeof keys === "object" ? keys[k] : undefined);
          if (cb) { setTimeout(() => cb(out), 5); return; }
          return Promise.resolve(out);
        },
        set: (o, cb) => { Object.assign(settings, o); if (cb) cb(); return Promise.resolve(); },
      },
    },
    tabs: {
      query: (q, cb) => { const r = [{ id: 1, url: "https://www.youtube.com/watch?v=demo", title: "Learn German with Stories" }]; const pr = Promise.resolve(r); if (cb) { pr.then(cb); return; } return pr; },
      sendMessage: (id, msg, cb) => {
        const t = msg && msg.type;
        let r = { ok: true };
        if (t === "GET_CLIP") r = { ok: true, base: "youtube:demo", title: "Learn German with Stories — Café in Berlin" };
        else if (t === "DUB_STATUS") r = { on: false };
        const pr = new Promise((res) => setTimeout(() => res(r), 10));
        if (cb) { pr.then(cb); return; }
        return pr;
      },
      create: () => {},
    },
    i18n: { detectLanguage: (s, cb) => cb && cb({ languages: [{ language: "de", percentage: 90 }] }) },
  };
})();
