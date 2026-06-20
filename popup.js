// SubVibe popup. Every control writes to chrome.storage.local immediately; the
// content script watches that store and re-renders live — no Save, no reload.

// Language table + the Persian Lion & Sun (شیر و خورشید) flag live in
// shared/langs.js (loaded first in popup.html) so the popup and the Library page
// share one source of truth.
const FA_FLAG = window.SV_FA_FLAG;
const LANGS = window.SV_LANGS;

const DEFAULTS = { enabled: true, targets: ["en"], showOriginal: true, hideNative: true, apiKey: "", keepNames: true, keepTerms: "", position: "bottom", size: "md", syncOffset: 0 };
const el = (id) => document.getElementById(id);
const fmtSync = (v) => (v > 0 ? "+" : "") + v.toFixed(2) + "s";
const langMeta = (code) => LANGS.find((l) => l[0] === code) || [code, code.toUpperCase(), "🏳️"];

let state = { ...DEFAULTS };
let menuActive = -1;

// Per-clip settings: languages, appearance and timing apply to the CURRENT video
// when one is open (saved under clipOverrides[clipBase]); with no video open they
// edit the global defaults that every NEW video starts from. CLIP_FIELDS is exactly
// the set we scope per-video — everything else (key, on/off, keep-names) stays global.
let clipBase = null;
let clipOverrides = {};
const CLIP_FIELDS = ["targets", "showOriginal", "position", "size", "syncOffset", "linePositions"];

let savedT;
function showSaved() { const s = el("saved"); s.classList.add("show"); clearTimeout(savedT); savedT = setTimeout(() => s.classList.remove("show"), 900); }
function persist(obj) { chrome.storage.local.set(obj); showSaved(); }

// Save per-clip setting(s) when a video is open, else to the global defaults.
// Keeps local `state` in step so "Save as default" reads accurate values.
function saveSetting(obj) {
  Object.assign(state, obj);
  if (clipBase) {
    clipOverrides[clipBase] = { ...(clipOverrides[clipBase] || {}), ...obj };
    chrome.storage.local.set({ clipOverrides });
  } else {
    chrome.storage.local.set(obj);
  }
  showSaved();
  updateScope();
}

// ── languages: chips + flag autocomplete ─────────────────────────────────────
function renderChips() {
  const box = el("chips"); box.innerHTML = "";
  state.targets.forEach((code, i) => {
    const [, name, flag] = langMeta(code);
    const chip = document.createElement("span");
    chip.className = "chip" + (i === 0 ? " primary" : "");
    chip.innerHTML = `<span class="fl">${flag}</span><span>${name}</span>` + (i === 0 ? '<span class="star">★</span>' : "");
    const x = document.createElement("button"); x.textContent = "×"; x.title = "Remove";
    x.onclick = () => { state.targets = state.targets.filter((c) => c !== code); saveSetting({ targets: state.targets }); renderChips(); };
    chip.appendChild(x); box.appendChild(chip);
  });
}
function filteredLangs(q) {
  q = (q || "").trim().toLowerCase();
  return LANGS.filter(([code, name]) => !state.targets.includes(code) && (!q || name.toLowerCase().includes(q) || code.includes(q)));
}
function renderMenu() {
  const menu = el("langMenu"), list = filteredLangs(el("langSearch").value).slice(0, 40);
  menu.innerHTML = "";
  if (!list.length) { menu.innerHTML = '<div class="none">No match</div>'; menu.classList.add("show"); return; }
  list.forEach((l, i) => {
    const row = document.createElement("div");
    row.className = "opt" + (i === menuActive ? " active" : "");
    row.innerHTML = `<span class="fl">${l[2]}</span><span>${l[1]}</span><span class="code">${l[0]}</span>`;
    row.onmousedown = (e) => { e.preventDefault(); addLang(l[0]); };
    menu.appendChild(row);
  });
  menu.classList.add("show");
}
function addLang(code) {
  if (!state.targets.includes(code)) state.targets.push(code);
  saveSetting({ targets: state.targets });
  el("langSearch").value = ""; menuActive = -1; renderChips();
  el("langMenu").classList.remove("show"); el("langSearch").focus();
}
el("langSearch").addEventListener("input", () => { menuActive = -1; renderMenu(); });
el("langSearch").addEventListener("focus", renderMenu);
el("langSearch").addEventListener("keydown", (e) => {
  const list = filteredLangs(el("langSearch").value).slice(0, 40);
  if (e.key === "ArrowDown") { menuActive = Math.min(list.length - 1, menuActive + 1); renderMenu(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { menuActive = Math.max(0, menuActive - 1); renderMenu(); e.preventDefault(); }
  else if (e.key === "Enter") { const pick = list[menuActive] || list[0]; if (pick) addLang(pick[0]); e.preventDefault(); }
  else if (e.key === "Escape") { el("langMenu").classList.remove("show"); }
});
document.addEventListener("click", (e) => { if (!el("langSearch").contains(e.target) && !el("langMenu").contains(e.target)) el("langMenu").classList.remove("show"); });

// ── API key ──────────────────────────────────────────────────────────────────
function setKeyStatus(text, cls) { const s = el("keyStatus"); s.textContent = text; s.className = cls || ""; }
function keyHint() {
  if (!el("apiKey").value.trim()) setKeyStatus("Paste your key above to start — it's stored only on this device.", "warn");
  else setKeyStatus("Stored only on this device · a few cents per hour · cached replays are free.", "");
}
let keyT;
el("apiKey").addEventListener("input", () => {
  clearTimeout(keyT); keyHint();
  keyT = setTimeout(() => persist({ apiKey: el("apiKey").value.trim() }), 400);
});
let termsT;
el("keepTerms").addEventListener("input", () => { clearTimeout(termsT); termsT = setTimeout(() => persist({ keepTerms: el("keepTerms").value }), 400); });
el("verify").addEventListener("click", async () => {
  const key = el("apiKey").value.trim();
  if (!key) return setKeyStatus("Paste your key first.", "warn");
  setKeyStatus("Checking…", "");
  const r = await chrome.runtime.sendMessage({ type: "VERIFY_KEY", apiKey: key }).catch(() => null);
  if (r && r.ok) setKeyStatus("Key works ✓ — you're all set.", "ok");
  else setKeyStatus("Key rejected" + (r && r.status ? " (HTTP " + r.status + ")" : "") + " — check it and try again.", "err");
});

// ── simple toggles / selects (live) ──────────────────────────────────────────
el("enabled").addEventListener("change", () => persist({ enabled: el("enabled").checked }));
el("showOriginal").addEventListener("change", () => saveSetting({ showOriginal: el("showOriginal").checked }));
el("hideNative").addEventListener("change", () => persist({ hideNative: el("hideNative").checked }));
el("position").addEventListener("change", () => saveSetting({ position: el("position").value }));
el("keepNames").addEventListener("change", () => persist({ keepNames: el("keepNames").checked }));

function setSize(size, save) {
  state.size = size;
  [...el("sizeSeg").children].forEach((b) => b.classList.toggle("on", b.dataset.size === size));
  if (save) saveSetting({ size });
}
el("sizeSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setSize(b.dataset.size, true); });

// Sync nudge — writes instantly so the overlay shifts without a reload.
function nudgeSync(delta) {
  state.syncOffset = Math.max(-15, Math.min(15, Math.round((state.syncOffset + delta) * 100) / 100));
  el("syncVal").textContent = fmtSync(state.syncOffset);
  saveSetting({ syncOffset: state.syncOffset });
}
el("syncBack").addEventListener("click", () => nudgeSync(-0.25));
el("syncFwd").addEventListener("click", () => nudgeSync(0.25));
// Click the value to snap back to 0 — handy after a big live shift (e.g. +8s).
el("syncVal").title = "Click to reset to 0";
el("syncVal").style.cursor = "pointer";
el("syncVal").addEventListener("click", () => { state.syncOffset = 0; el("syncVal").textContent = fmtSync(0); saveSetting({ syncOffset: 0 }); });

function flashStatus(t) { el("status").textContent = t; setTimeout(() => { if (el("status").textContent === t) el("status").textContent = ""; }, 2500); }
el("openLibrary").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("library.html") });
});
el("clearClip").addEventListener("click", async () => {
  // clipBase is resolved in loadThisVideo() from the active tab's content script.
  if (!clipBase) return;
  const r = await chrome.runtime.sendMessage({ type: "CACHE_DELETE", prefix: clipBase }).catch(() => null);
  flashStatus(r && r.ok ? `Cleared this video (${r.removed || 0} entries).` : "Could not clear this video.");
  loadThisVideo();
});

// ── per-clip scope: which video the settings apply to ─────────────────────────
// Ask the active tab's content script for this clip's stable id (same key as the
// cache). Language/appearance/timing edits then save under that id so they don't
// bleed to other videos; with no video open they edit the global defaults.
async function resolveClipBase() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tab = tabs && tabs[0];
  if (!tab) return null;
  const info = await chrome.tabs.sendMessage(tab.id, { type: "GET_CLIP" }).catch(() => null);
  return info && info.base ? info.base : null;
}
function updateScope() {
  const txt = el("scopeText"), sd = el("setDefault"), rc = el("resetClip");
  if (clipBase) {
    txt.textContent = "Settings for this video";
    txt.title = clipBase;
    sd.hidden = false;
    rc.hidden = !(clipOverrides[clipBase] && Object.keys(clipOverrides[clipBase]).length);
  } else {
    txt.textContent = "Editing your defaults";
    txt.title = "";
    sd.hidden = true; rc.hidden = true;
  }
}
el("setDefault").addEventListener("click", () => {
  // Lift this video's settings up to the global defaults → applied to every NEW video.
  chrome.storage.local.set({
    targets: state.targets, showOriginal: el("showOriginal").checked, position: el("position").value,
    size: state.size, syncOffset: state.syncOffset, linePositions: state.linePositions || {},
  });
  flashStatus("Saved as the default for new videos.");
});
el("resetClip").addEventListener("click", () => {
  if (!clipBase) return;
  delete clipOverrides[clipBase];
  chrome.storage.local.set({ clipOverrides });
  flashStatus("This video reset to your defaults.");
  load();
});

// ── this video cache + library count ──────────────────────────────────────────
// Shows only the CURRENT clip's cached languages (the full categorized list lives
// in the Library). Uses the clipBase already resolved by load().
async function loadThisVideo() {
  const box = el("clipCache");
  const res = await chrome.runtime.sendMessage({ type: "CACHE_LIST" }).catch(() => null);
  const tracks = (res && res.tracks) || [];

  // Library count = number of distinct clips cached (across all languages).
  const bases = new Set();
  for (const t of tracks) { const m = t && t.key && /^(.*):auto:[^:]+$/.exec(t.key); if (m) bases.add(m[1]); }
  el("libCount").textContent = bases.size
    ? `${bases.size} video${bases.size === 1 ? "" : "s"} cached · reopen any for free`
    : "No cached videos yet";

  el("clearClip").hidden = true;
  if (!clipBase) {
    box.className = "clipcache muted";
    box.textContent = "Open a YouTube, Netflix, Prime Video, ZDF or DW video to translate it.";
    return;
  }
  const mine = tracks.filter((t) => t.key && t.key.startsWith(clipBase + ":auto:"));
  if (!mine.length) {
    box.className = "clipcache muted";
    box.textContent = "Not cached yet — press play and SubVibe translates ahead.";
    return;
  }
  box.className = "clipcache";
  box.innerHTML = "";
  for (const t of mine) {
    const target = t.target || (/:auto:([^:]+)$/.exec(t.key) || [])[1] || "";
    const meta = langMeta(target);
    const chip = document.createElement("span");
    chip.className = "clang";
    const fl = document.createElement("span"); fl.className = "fl"; fl.innerHTML = meta[2]; chip.appendChild(fl);
    const name = document.createElement("span"); name.textContent = meta[1]; chip.appendChild(name);
    const full = !t.totalCues || t.cueCount >= t.totalCues * 0.95;
    const dot = document.createElement("span");
    dot.className = "dot " + (full ? "full" : "partial");
    dot.textContent = full ? "●" : "◐";
    chip.appendChild(dot);
    box.appendChild(chip);
  }
  el("clearClip").hidden = false;
}

// ── load ─────────────────────────────────────────────────────────────────────
async function load() {
  const g = await chrome.storage.local.get([...Object.keys(DEFAULTS), "linePositions", "clipOverrides"]);
  clipOverrides = g.clipOverrides || {};
  clipBase = await resolveClipBase();                       // which video (if any) is open
  const ov = (clipBase && clipOverrides[clipBase]) || {};   // this clip's saved tweaks
  state = { ...DEFAULTS, linePositions: {}, ...g, ...ov };  // effective = defaults ← global ← clip
  delete state.clipOverrides;
  if (!(state.targets && state.targets.length)) state.targets = ["en"];
  el("enabled").checked = state.enabled;
  el("apiKey").value = state.apiKey || "";
  el("keepNames").checked = state.keepNames !== false;
  el("keepTerms").value = state.keepTerms || "";
  el("showOriginal").checked = state.showOriginal;
  el("hideNative").checked = state.hideNative;
  el("position").value = state.position || "bottom";
  el("syncVal").textContent = fmtSync(state.syncOffset || 0);
  setSize(state.size || "md", false);
  renderChips();
  keyHint();
  updateScope();
  loadThisVideo();
}

// ── hidden tribute: tap the logo three times ──────────────────────────────────
// In memory of Agha Mansoor. The portrait + words live in shared/tribute.js
// (window.SV_TRIBUTE), loaded before this script.
(function () {
  const logo = document.querySelector("header img");
  if (!logo) return;
  let taps = 0, t;
  logo.style.cursor = "pointer";
  logo.addEventListener("click", () => {
    taps++; clearTimeout(t); t = setTimeout(() => (taps = 0), 1500);
    if (taps >= 3) { taps = 0; showMemory(); }
  });
  function showMemory() {
    const tr = window.SV_TRIBUTE; if (!tr) return;
    el("memArt").textContent = tr.portrait;
    el("memName").textContent = "In memory of " + tr.name;
    el("memDed").textContent = tr.dedication;
    el("memoryCard").hidden = false;
  }
  const close = el("memClose");
  if (close) close.addEventListener("click", () => (el("memoryCard").hidden = true));
})();

load();
