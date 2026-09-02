// chrome-stub.js — just enough `chrome.*` for the REAL shot.html to run from
// file:// (design previews, screenshots). Inject BEFORE the page's scripts:
// chrome-devtools `navigate_page` with `initScript`, or paste into the console
// and reload with scripts blocked. Answers SHOT_TAB_ALIVE with alive:false (the
// source tab is closed) and refuses every re-shoot, so only local paths run.
// Preferences persist in localStorage so Frame/Export choices survive reloads.
(function () {
  if (window.chrome && window.chrome.runtime && window.chrome.runtime.id) return; // a real extension context
  const KEY = "sv-shot-stub-prefs";
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { return {}; } };
  const save = (o) => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} };
  window.chrome = {
    runtime: {
      lastError: undefined,
      getURL: (p) => p, // shot.html sits at the repo root, so relative paths resolve
      sendMessage: (msg, cb) => {
        if (!cb) return;
        setTimeout(() => cb(msg && msg.type === "SHOT_TAB_ALIVE" ? { ok: true, alive: false } : { ok: false, error: "stub" }), 0);
      },
      onMessage: { addListener() {} },
    },
    storage: {
      local: {
        get: async (keys) => { const all = load(); if (!keys) return all; const ks = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys); const out = {}; for (const k of ks) if (k in all) out[k] = all[k]; return out; },
        set: async (obj) => { save({ ...load(), ...obj }); },
      },
      onChanged: { addListener() {} },
    },
    tabs: { create: () => {}, query: async () => [] },
    i18n: { getUILanguage: () => "en" },
  };
  Element.prototype.setPointerCapture = function () {}; // synthetic pointer events
})();
