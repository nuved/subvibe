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
    { word: "Geduld", box: 1, cefr: "B1", pos: "noun", art: "die", meaning: "صبر، شکیبایی", sentence: "Die Geduld beim Lernen zahlt sich aus.", sentenceT: "شکیبایی در یادگیری ارزشش را دارد.", channel: "Easy German", videoTitle: "Café in Berlin", base: "youtube:demo1" },
    { word: "verbessern", box: 2, cefr: "B1", pos: "verb", meaning: "بهبود دادن", sentence: "Ich möchte mein Deutsch verbessern.", sentenceT: "می‌خواهم آلمانی‌ام را بهتر کنم.", channel: "Easy German", videoTitle: "Café in Berlin", base: "youtube:demo1" },
    { word: "Erfahrung", box: 3, cefr: "A2", pos: "noun", art: "die", meaning: "تجربه", sentence: "Die Erfahrung hat mir sehr geholfen.", channel: "Deutsch für Euch", videoTitle: "Reisen in Deutschland", base: "youtube:demo2", ms: 252000 },
    { word: "neugierig", box: 2, cefr: "A2", pos: "adj", meaning: "کنجکاو", sentence: "Kinder sind von Natur aus neugierig.", channel: "Easy German", videoTitle: "Café in Berlin", base: "youtube:demo1" },
    { word: "Wortschatz", box: 4, cefr: "B2", pos: "noun", art: "der", meaning: "دایره واژگان", sentence: "Filme erweitern deinen Wortschatz.", channel: "Deutsch für Euch", videoTitle: "Reisen in Deutschland", base: "youtube:demo2" },
    { word: "aufstehen", box: 1, cefr: "A2", pos: "verb", lemma: "auf|stehen", sep: true, meaning: "بلند شدن", sentence: "Ich stehe jeden Tag um sieben Uhr auf.", channel: "Easy German", videoTitle: "Café in Berlin", base: "youtube:demo1", ms: 47000 },
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
        } else if (t === "VOCAB_IMPORT") {
          // Mimics background.js's (post review-fix-round-1) VOCAB_IMPORT
          // write path closely enough to exercise the client-side import flow
          // live (svbox task 4): tokenize-derived key, idbVocabGet-before-
          // write on toAdd (merge onto an existing card + count it as
          // updated, never blind-overwrite review state — the bug review
          // round 1 found), toUpdate patches only the given fields. Mutates
          // CARDS in place so a second VOCAB_LIST call (and a reimport) sees
          // the result — real reimport-idempotence proof for the CLIENT flow;
          // the actual IndexedDB write path this stands in for is reviewed by
          // hand, not exercised here.
          const lang = String(msg.lang || "").toLowerCase();
          const gift = String(msg.name || "").replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 24);
          const now2 = Date.now();
          const tokenize = (t) => String(t || "").match(/\p{L}+(?:['’‘‌-]\p{L}+)*/gu) || [];
          // Mirrors background.js's (post review-fix-round-2) pickImportFields
          // exactly: empty string never copied, sep only when true, ms only
          // when a positive number — an empty value must never blank a
          // receiver's real enrichment on a toAdd-collision merge.
          const STRING_FIELDS = ["lemma", "cefr", "pos", "art", "meaning", "sentence", "sentenceT", "para",
            "note", "phrase", "videoTitle", "channel"];
          const pickFields = (raw) => {
            const out = {};
            if (!raw || typeof raw !== "object") return out;
            for (const f of STRING_FIELDS) { const v = raw[f]; if (typeof v === "string" && v.length > 0) out[f] = v; }
            if (raw.sep === true) out.sep = true;
            if (typeof raw.ms === "number" && Number.isFinite(raw.ms) && raw.ms > 0) out.ms = raw.ms;
            return out;
          };
          let added = 0, updated = 0;
          for (const raw of msg.toAdd || []) {
            const word = String((raw && raw.word) || "").trim();
            if (!word) continue;
            const clean = tokenize(word)[0] || word;
            const key = lang + ":" + clean.toLowerCase();
            const cur = CARDS.find((x) => x.key === key);
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
            CARDS.push(card);
            added++;
          }
          for (const u of msg.toUpdate || []) {
            const c = CARDS.find((x) => x.key === (u && u.key));
            const f = pickFields(u && u.fields);
            if (c && Object.keys(f).length) { Object.assign(c, f); updated++; }
          }
          r = { ok: true, added, updated };
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
