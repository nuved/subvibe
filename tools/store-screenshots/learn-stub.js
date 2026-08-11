// chrome.* stub for capturing/exercising learn.html over plain http.
// Injected via Playwright addInitScript BEFORE learn.js runs. Seeds a spread
// of cards across statuses (new/learning/mastered) and two languages (German
// + Italian) so both Practice deck cards and Words rows render fully.
// Card shape matches VOCAB_LIST's real response ({key, ...card}) — see
// background.js vocabAdd()/idbVocabList() — same seed data as popup-stub.js's
// GAME_CARDS so screenshots/behavior stay comparable across both surfaces.
(function () {
  const settings = {
    translationProvider: "claude", claudeModel: "claude-sonnet-5",
    uiTheme: "light", uiLearnTab: "practice",
    gameScope: {}, gamePace: {}, gameRecords: {}, gameIntro: {},
  };
  const now = Date.now();
  const DAY = 86400000;
  const deCards = [
    { word: "Geduld", box: 1, cefr: "B1", pos: "noun", art: "die", meaning: "صبر، شکیبایی", sentence: "Man braucht viel Geduld beim Lernen.", sentenceT: "برای یادگیری صبر زیادی لازم است.", channel: "Easy German", videoTitle: "Café in Berlin", base: "youtube:demo1" },
    { word: "verbessern", box: 2, cefr: "B1", pos: "verb", meaning: "بهبود دادن", sentence: "Ich möchte mein Deutsch verbessern.", sentenceT: "می‌خواهم آلمانی‌ام را بهتر کنم.", channel: "Easy German", videoTitle: "Café in Berlin", base: "youtube:demo1" },
    { word: "Erfahrung", box: 3, cefr: "A2", pos: "noun", art: "die", meaning: "تجربه", sentence: "Jede Reise ist eine neue Erfahrung.", channel: "Deutsch für Euch", videoTitle: "Reisen in Deutschland", base: "youtube:demo2" },
    { word: "neugierig", box: 2, cefr: "A2", pos: "adj", meaning: "کنجکاو", sentence: "Kinder sind von Natur aus neugierig.", channel: "Easy German", videoTitle: "Café in Berlin", base: "youtube:demo1" },
    { word: "Wortschatz", box: 4, cefr: "B2", pos: "noun", art: "der", meaning: "دایره واژگان", sentence: "Filme erweitern deinen Wortschatz.", channel: "Deutsch für Euch", videoTitle: "Reisen in Deutschland", base: "youtube:demo2" },
    { word: "aufstehen", box: 1, cefr: "A2", pos: "verb", lemma: "auf|stehen", sep: true, meaning: "بلند شدن", sentence: "Ich stehe jeden Tag um sieben Uhr auf.", channel: "Easy German", videoTitle: "Café in Berlin", base: "youtube:demo1" },
    { word: "Möglichkeit", box: 5, cefr: "B1", pos: "noun", art: "die", meaning: "امکان", sentence: "Es gibt viele Möglichkeiten, Deutsch zu lernen.", channel: "Deutsch für Euch", videoTitle: "Reisen in Deutschland", base: "youtube:demo2" },
    { word: "erreichen", box: 5, cefr: "B1", pos: "verb", meaning: "رسیدن به", sentence: "Wir haben unser Ziel erreicht.", channel: "Easy German", videoTitle: "Café in Berlin", base: "youtube:demo1" },
    { word: "Freiheit", box: 0, cefr: "B2", pos: "noun", art: "die", meaning: "آزادی", sentence: "Freiheit bedeutet für jeden etwas anderes.", channel: "Deutsch für Euch", videoTitle: "Reisen in Deutschland", base: "youtube:demo2" },
    { word: "vorschlagen", box: 0, cefr: "B1", pos: "verb", lemma: "vor|schlagen", sep: true, meaning: "پیشنهاد دادن", sentence: "Ich schlage vor, dass wir morgen anfangen.", channel: "Easy German", videoTitle: "Café in Berlin", base: "youtube:demo1" },
    { word: "gemütlich", box: 3, cefr: "A2", pos: "adj", meaning: "دنج، راحت", sentence: "Das Café ist sehr gemütlich.", channel: "Deutsch für Euch", videoTitle: "Reisen in Deutschland", base: "youtube:demo2" },
    { word: "Herausforderung", box: 1, cefr: "B2", pos: "noun", art: "die", meaning: "چالش", sentence: "Das war eine große Herausforderung für mich.", channel: "Easy German", videoTitle: "Café in Berlin", base: "youtube:demo1" },
  ].map((c, i) => {
    const graded = c.box > 0;
    return { key: "de:" + c.word.toLowerCase(), lang: "de", n: 1, addedAt: now - i * DAY,
      lastGradedAt: graded ? now - i * DAY : 0, nextDueAt: graded ? now + (i % 3 === 0 ? -DAY : (i + 1) * DAY) : now,
      ...c, box: c.box || 1 };
  });
  const itCards = [
    { word: "la pazienza", box: 1, cefr: "B1", pos: "noun", meaning: "صبر", sentence: "Ci vuole molta pazienza per imparare.", channel: "Podcast Italiano", videoTitle: "Imparare l'italiano", base: "youtube:demo3" },
    { word: "migliorare", box: 2, cefr: "B1", pos: "verb", meaning: "بهبود دادن", sentence: "Voglio migliorare il mio italiano.", channel: "Podcast Italiano", videoTitle: "Imparare l'italiano", base: "youtube:demo3" },
    { word: "curioso", box: 0, cefr: "A2", pos: "adj", meaning: "کنجکاو", sentence: "I bambini sono naturalmente curiosi.", channel: "Podcast Italiano", videoTitle: "Imparare l'italiano", base: "youtube:demo3" },
    { word: "raggiungere", box: 5, cefr: "B1", pos: "verb", meaning: "رسیدن به", sentence: "Abbiamo raggiunto il nostro obiettivo.", channel: "Podcast Italiano", videoTitle: "Imparare l'italiano", base: "youtube:demo3" },
  ].map((c, i) => {
    const graded = c.box > 0;
    return { key: "it:" + c.word.toLowerCase(), lang: "it", n: 1, addedAt: now - i * DAY,
      lastGradedAt: graded ? now - i * DAY : 0, nextDueAt: graded ? now + (i % 2 === 0 ? -DAY : (i + 1) * DAY) : now,
      ...c, box: c.box || 1 };
  });
  const CARDS = [...deCards, ...itCards];

  window.chrome = {
    runtime: {
      id: "learn-stub", lastError: undefined, getURL: (p) => "/" + p,
      onMessage: { addListener() {} },
      sendMessage: (msg, cb) => {
        let r = { ok: true };
        const t = msg && msg.type;
        if (t === "VOCAB_LIST") r = { cards: CARDS };
        else if (t === "VOCAB_GRADE") {
          const c = CARDS.find((x) => x.key === msg.key);
          if (c) { c.box = msg.ok ? Math.min(5, (c.box || 1) + 1) : 1; c.lastGradedAt = Date.now(); c.nextDueAt = Date.now() + 86400000; }
          r = { ok: true, card: c };
        } else if (t === "VOCAB_KNOWN") {
          const key = (msg.lang || "xx") + ":" + String(msg.word || "").toLowerCase();
          const c = CARDS.find((x) => x.key === key);
          if (c) { c.box = 5; c.lastGradedAt = Date.now(); }
          r = { ok: true };
        } else if (t === "VOCAB_CONJUGATE") {
          r = { conj: { Präsens: ["verbessere", "verbesserst", "verbessert", "verbessern", "verbessert", "verbessern"], Perfekt: "habe verbessert" } };
        } else if (t === "VOCAB_ENRICH") {
          r = { enriched: 0, usd: 0 };
        }
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
    i18n: { detectLanguage: (s, cb) => cb && cb({ languages: [{ language: "de", percentage: 90 }] }) },
  };
})();
