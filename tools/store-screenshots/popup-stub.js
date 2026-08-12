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
  // Word-game deck seed: 12 German cards (boxes spread new/learning/mastered)
  // + 4 Italian, so both the arcade decks and fold status dots render fully
  // in captured screenshots. Field shape matches VOCAB_LIST's real response
  // ({key, ...card}) — see background.js vocabAdd()/idbVocabList().
  const now = Date.now();
  const DAY = 86400000;
  const deCards = [
    // Nouns: `word` is the bare noun (as the real extraction pipeline tokenizes
    // it — the article is a stopword, dropped before this field is ever set);
    // `art` carries der/die/das separately, exactly like enrichment attaches it.
    // These two carry base: "youtube:demo" — the GET_CLIP stub's clip id —
    // so "Play only these →" on the fold has something to scope a round to.
    { word: "Geduld", box: 1, cefr: "B1", pos: "noun", art: "die", meaning: "صبر، شکیبایی", sentence: "Die Geduld beim Lernen zahlt sich aus.", sentenceT: "شکیبایی در یادگیری ارزشش را دارد.", channel: "Easy German", videoTitle: "Café in Berlin", base: "youtube:demo" },
    { word: "verbessern", box: 2, cefr: "B1", pos: "verb", meaning: "بهبود دادن", sentence: "Ich möchte mein Deutsch verbessern.", sentenceT: "می‌خواهم آلمانی‌ام را بهتر کنم.", channel: "Easy German", videoTitle: "Café in Berlin", base: "youtube:demo" },
    { word: "Erfahrung", box: 3, cefr: "A2", pos: "noun", art: "die", meaning: "تجربه", sentence: "Die Erfahrung hat mir sehr geholfen.", channel: "Deutsch für Euch", videoTitle: "Reisen in Deutschland", ms: 252000 },
    { word: "neugierig", box: 2, cefr: "A2", pos: "adj", meaning: "کنجکاو", sentence: "Kinder sind von Natur aus neugierig.", channel: "Easy German", videoTitle: "Café in Berlin" },
    { word: "Wortschatz", box: 4, cefr: "B2", pos: "noun", art: "der", meaning: "دایره واژگان", sentence: "Filme erweitern deinen Wortschatz.", channel: "Deutsch für Euch", videoTitle: "Reisen in Deutschland" },
    { word: "aufstehen", box: 1, cefr: "A2", pos: "verb", lemma: "auf|stehen", meaning: "بلند شدن", sentence: "Ich stehe jeden Tag um sieben Uhr auf.", channel: "Easy German", videoTitle: "Café in Berlin", ms: 47000 },
    { word: "Möglichkeit", box: 5, cefr: "B1", pos: "noun", art: "die", meaning: "امکان", sentence: "Es gibt viele Möglichkeiten, Deutsch zu lernen.", channel: "Deutsch für Euch", videoTitle: "Reisen in Deutschland" },
    { word: "erreichen", box: 5, cefr: "B1", pos: "verb", meaning: "رسیدن به", sentence: "Wir haben unser Ziel erreicht.", channel: "Easy German", videoTitle: "Café in Berlin" },
    { word: "Freiheit", box: 0, cefr: "B2", pos: "noun", art: "die", meaning: "آزادی", sentence: "Freiheit bedeutet für jeden etwas anderes.", channel: "Deutsch für Euch", videoTitle: "Reisen in Deutschland" },
    { word: "vorschlagen", box: 0, cefr: "B1", pos: "verb", lemma: "vor|schlagen", meaning: "پیشنهاد دادن", sentence: "Ich schlage vor, dass wir morgen anfangen.", channel: "Easy German", videoTitle: "Café in Berlin" },
    { word: "gemütlich", box: 3, cefr: "A2", pos: "adj", meaning: "دنج، راحت", sentence: "Das Café ist sehr gemütlich.", channel: "Deutsch für Euch", videoTitle: "Reisen in Deutschland" },
    { word: "Herausforderung", box: 1, cefr: "B2", pos: "noun", art: "die", meaning: "چالش", sentence: "Das war eine große Herausforderung für mich.", channel: "Easy German", videoTitle: "Café in Berlin" },
  ].map((c, i) => {
    const graded = c.box > 0;
    return { key: "de:" + c.word.toLowerCase(), lang: "de", n: 1, addedAt: now - i * DAY,
      lastGradedAt: graded ? now - i * DAY : 0, nextDueAt: graded ? now + (i % 3 === 0 ? -DAY : (i + 1) * DAY) : now,
      ...c, box: c.box || 1 };
  });
  const itCards = [
    { word: "la pazienza", box: 1, cefr: "B1", pos: "noun", meaning: "صبر", sentence: "Ci vuole molta pazienza per imparare.", channel: "Podcast Italiano" },
    { word: "migliorare", box: 2, cefr: "B1", pos: "verb", meaning: "بهبود دادن", sentence: "Voglio migliorare il mio italiano.", channel: "Podcast Italiano" },
    { word: "curioso", box: 0, cefr: "A2", pos: "adj", meaning: "کنجکاو", sentence: "I bambini sono naturalmente curiosi.", channel: "Podcast Italiano" },
    { word: "raggiungere", box: 5, cefr: "B1", pos: "verb", meaning: "رسیدن به", sentence: "Abbiamo raggiunto il nostro obiettivo.", channel: "Podcast Italiano" },
  ].map((c, i) => {
    const graded = c.box > 0;
    return { key: "it:" + c.word.toLowerCase(), lang: "it", n: 1, addedAt: now - i * DAY,
      lastGradedAt: graded ? now - i * DAY : 0, nextDueAt: graded ? now + (i % 2 === 0 ? -DAY : (i + 1) * DAY) : now,
      ...c, box: c.box || 1 };
  });
  const GAME_CARDS = [...deCards, ...itCards];
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
        else if (t === "VOCAB_LIST") r = { cards: GAME_CARDS };
        else if (t === "VOCAB_IMPORT") {
          // Mimics background.js's (post review-fix-round-1) VOCAB_IMPORT
          // write path closely enough to exercise the client-side import flow
          // live (svbox task 4) — see learn-stub.js's identical handler for
          // the full comment (tokenize-derived key, idbVocabGet-before-write
          // merge on toAdd collisions rather than a blind overwrite).
          const lang = String(msg.lang || "").toLowerCase();
          const gift = String(msg.name || "").replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 24);
          const now2 = Date.now();
          const tokenize = (t) => String(t || "").match(/\p{L}+(?:['’‘‌-]\p{L}+)*/gu) || [];
          const CARD_FIELDS = ["lemma", "cefr", "pos", "art", "meaning", "sentence", "sentenceT", "para",
            "note", "phrase", "videoTitle", "channel", "sep", "ms"];
          const pickFields = (raw) => {
            const out = {};
            if (!raw || typeof raw !== "object") return out;
            for (const f of CARD_FIELDS) if (raw[f] !== undefined && raw[f] !== null) out[f] = raw[f];
            return out;
          };
          let added = 0, updated = 0;
          for (const raw of msg.toAdd || []) {
            const word = String((raw && raw.word) || "").trim();
            if (!word) continue;
            const clean = tokenize(word)[0] || word;
            const key = lang + ":" + clean.toLowerCase();
            const cur = GAME_CARDS.find((x) => x.key === key);
            if (cur) {
              const f = pickFields(raw);
              if (Object.keys(f).length) { Object.assign(cur, f); updated++; }
              continue;
            }
            const f = pickFields(raw);
            const card = { key, word: clean, lang, box: 1, nextDueAt: now2, addedAt: now2, lastGradedAt: 0,
              sentence: f.sentence || "", sentenceT: f.sentenceT || "", videoTitle: f.videoTitle || "",
              base: "", ms: f.ms || 0, channel: f.channel || "", n: 1,
              lemma: f.lemma || null, pos: f.pos || null, art: f.art || null, plural: null,
              cefr: f.cefr || null, meaning: f.meaning || null, phrase: f.phrase || null, note: f.note || null,
              para: f.para || null, sep: f.sep === true, conj: null, history: [], contexts: [] };
            if (gift) card.gift = gift;
            GAME_CARDS.push(card);
            added++;
          }
          for (const u of msg.toUpdate || []) {
            const c = GAME_CARDS.find((x) => x.key === (u && u.key));
            const f = pickFields(u && u.fields);
            if (c && Object.keys(f).length) { Object.assign(c, f); updated++; }
          }
          r = { ok: true, added, updated };
        }
        // VOCAB_GRADE / VOCAB_KNOWN fall through to the default { ok: true } —
        // the word-game screenshots only need the round to keep advancing,
        // not a stateful mock of the Leitner store.
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
