// chrome.* shim so content/common.js runs OUTSIDE an extension (file:// harness).
// In-memory storage.local with onChanged; canned background-worker replies —
// TRANSLATE echoes "EN·<line>" so the display provably renders per-cue output.
(function () {
  const store = {};
  const changedListeners = [];
  const msgListeners = [];

  function getKeys(keys) {
    const out = {};
    const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || store);
    for (const k of list) if (k in store) out[k] = JSON.parse(JSON.stringify(store[k]));
    return out;
  }

  window.chrome = {
    runtime: {
      id: "harness-ext-id",
      lastError: undefined,
      getURL: (p) => "/ext/" + p,
      onMessage: { addListener: (fn) => msgListeners.push(fn) },
      sendMessage: (msg, cb) => {
        let resp = { ok: true };
        if (msg && msg.type === "TRANSLATE") resp = { lines: (msg.cues || []).map((s) => "EN·" + s) };
        else if (msg && msg.type === "CACHE_GET") resp = { track: null };
        else if (msg && msg.type === "CACHE_LIST") resp = { tracks: [] };
        setTimeout(() => { try { cb && cb(resp); } catch (e) { console.error(e); } }, 30);
      },
    },
    storage: {
      onChanged: { addListener: (fn) => changedListeners.push(fn) },
      local: {
        get: (keys) => Promise.resolve(getKeys(keys)),
        set: (obj) => {
          const changes = {};
          for (const k of Object.keys(obj)) {
            changes[k] = { oldValue: store[k], newValue: JSON.parse(JSON.stringify(obj[k])) };
            store[k] = JSON.parse(JSON.stringify(obj[k]));
          }
          setTimeout(() => { for (const fn of changedListeners) { try { fn(changes, "local"); } catch (e) { console.error(e); } } }, 0);
          return Promise.resolve();
        },
      },
    },
  };
  window.__shim = { store };
})();
