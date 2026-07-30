// SubVibe popup. Every control writes to chrome.storage.local immediately; the
// content script watches that store and re-renders live — no Save, no reload.

// Language table + the Persian Lion & Sun (شیر و خورشید) flag live in
// shared/langs.js (loaded first in popup.html) so the popup and the Library page
// share one source of truth.
const FA_FLAG = window.SV_FA_FLAG;
const LANGS = window.SV_LANGS;

const DEFAULTS = { enabled: true, targets: ["en"], showOriginal: true, hideNative: true, karaokeHl: true, apiKey: "", translationProvider: "openai", claudeModel: "claude-sonnet-5", anthropicKey: "", keepNames: true, keepTerms: "", position: "bottom", size: "md", stylePreset: "classic", styleCustom: {}, syncOffset: 0, dubEnabled: false, ttsProvider: "openai", geminiKey: "", dubVoice: "marin", dubGeminiVoice: "Kore", dubMultiVoice: false, dubDuckLevel: 0.12, dubPace: 1, liveModel: "gemini-3.5-live-translate", audioDeviceId: "" };
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
let clipLoadSeq = 0; // guards loadThisVideo()'s async audioRows() fills against a stale re-run (e.g. Clear cache)
const CLIP_FIELDS = ["targets", "showOriginal", "position", "size", "syncOffset", "linePositions"];
// Mirrors manifest.json content_scripts matches — update both together.
const SUPPORTED_SITES = [
  ["YouTube", /(^|\.)youtube\.com$/],
  ["Netflix", /(^|\.)netflix\.com$/],
  ["Prime Video", /(^|\.)(primevideo\.com|amazon\.de)$/],
  ["ZDF", /(^|\.)zdf\.de$/],
  ["DW", /(^|\.)dw\.com$/],
  ["Udemy", /(^|\.)udemy\.com$/],
];
async function activeTabHost() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  // tab.url is exposed only where we hold host permissions — i.e. exactly on supported sites.
  try { return tabs[0] && tabs[0].url ? new URL(tabs[0].url).hostname : ""; } catch { return ""; }
}

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

// ── API keys (OpenAI, Anthropic, Gemini) — all three rows always visible ────
// Each key's status dot is green when a Verify succeeded this session OR a
// non-empty key is stored; red after a failed Verify; grey when empty.
// keyDotColor() is the single source of truth for that decision — both the
// per-row dots (.keydot background) and the collapsed-summary dots (colored
// "●" text) read it, so the two views can never drift apart.
function keyDotColor(value, failedFlag) {
  return failedFlag ? "red" : value.trim() ? "green" : null;
}
function setKeyStatus(text, cls) { const s = el("keyStatus"); s.textContent = text; s.className = cls || ""; }
function keyHint() {
  if (!el("apiKey").value.trim()) setKeyStatus("Paste your key above to start — it's stored only on this device.", "warn");
  else setKeyStatus("Stored only on this device · a few cents per hour · cached replays are free.", "");
}
function setKeyDot(id, color) { el(id).className = "keydot" + (color ? " " + color : ""); }

// ── Summary pills + auto-open (collapsed keys section) ──────────────────────
// Order: OpenAI, Anthropic, Google — matches the row order inside the fold.
const KEY_PROVIDERS = [
  { input: "apiKey", failed: () => keyVerifyFailed, name: "OpenAI" },
  { input: "anthropicKey", failed: () => anthropicKeyVerifyFailed, name: "Anthropic" },
  { input: "geminiKey", failed: () => geminiKeyVerifyFailed, name: "Google" },
];
function refreshKeysSummary() {
  const host = el("keysPills");
  if (!host.childElementCount) {
    for (const p of KEY_PROVIDERS) {
      const s = document.createElement("span");
      s.textContent = p.name;
      host.appendChild(s);
    }
  }
  let anyEmpty = false, anyFailed = false;
  KEY_PROVIDERS.forEach((p, i) => {
    const value = el(p.input).value;
    const failed = p.failed();
    const color = keyDotColor(value, failed);
    host.children[i].className = color || "";
    if (!value.trim()) anyEmpty = true;
    if (failed) anyFailed = true;
  });
  // Auto-open only: a key needing attention forces the panel open. Never force-close —
  // closing is either the user's own click or the default-collapsed initial markup state.
  if (anyEmpty || anyFailed) el("keysDetails").open = true;
}

// ── Folded config remembers how you left it ─────────────────────────────────
// The panel always reopens the way the user arranged it. Keys auto-open-on-attention
// (hydrateKeys/refreshKeysSummary) still wins: it sets .open AFTER this runs, and that
// programmatic toggle is saved too, which is fine — after fixing the key the user closes
// it once.
const FOLD_IDS = ["keysDetails", "voiceFold", "transFold", "lookFold", "timeFold"];
async function initFolds() {
  const { uiFold } = await chrome.storage.local.get("uiFold");
  const st = uiFold || {};
  for (const id of FOLD_IDS) {
    const d = el(id);
    if (!d) continue;
    if (typeof st[id] === "boolean") d.open = st[id];
    d.addEventListener("toggle", () => {
      const cur = {};
      for (const i of FOLD_IDS) { const x = el(i); if (x) cur[i] = x.open; }
      chrome.storage.local.set({ uiFold: cur });
    });
  }
}

// ── tabs: Translate / Dub / Style. Header, scope bar and the This-video strip
// stay visible above whichever tab is open; the choice persists like uiFold.
const TAB_NAMES = ["translate", "dub", "style"];
function selectTab(name) {
  for (const b of el("tabBar").children) b.classList.toggle("on", b.dataset.tab === name);
  for (const p of document.querySelectorAll(".pane")) p.hidden = p.dataset.pane !== name;
}
async function initTabs() {
  const { uiTab } = await chrome.storage.local.get("uiTab");
  if (TAB_NAMES.includes(uiTab)) selectTab(uiTab);
  el("tabBar").addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b) return;
    selectTab(b.dataset.tab);
    chrome.storage.local.set({ uiTab: b.dataset.tab });
  });
}

function updateFoldSummaries() {
  const txt = (id, v) => { const n = el(id); if (n) n.textContent = v; };
  const sel = (id) => { const s = el(id); return (s && s.selectedOptions[0] && s.selectedOptions[0].textContent) || ""; };
  const gem = el("ttsProvider").value === "gemini";
  txt("voiceVal", sel(gem ? "dubGeminiVoice" : "dubVoice") || sel("ttsProvider"));
  txt("transVal", [el("keepNames").checked ? "keep names" : "",
                   el("keepTerms").value.trim() ? "glossary" : ""].filter(Boolean).join(" · ") || "defaults");
  txt("lookVal", [sizePct(+el("sizeRange").value),
                  el("showOriginal").checked ? "dual" : "translation only",
                  el("karaokeHl").checked ? "karaoke" : "",
                  el("hideNative").checked ? "no doubles" : ""].filter(Boolean).join(" · "));
  txt("timeVal", fmtSync(parseFloat(el("syncInput").value) || 0));
}

let keyVerifyFailed = false;
function refreshKeyDot() {
  setKeyDot("apiKeyDot", keyDotColor(el("apiKey").value, keyVerifyFailed));
  refreshKeysSummary();
}
let keyT;
el("apiKey").addEventListener("input", () => {
  clearTimeout(keyT); keyHint();
  keyVerifyFailed = false; refreshKeyDot();
  updateProviderAvailability();
  keyT = setTimeout(() => persist({ apiKey: el("apiKey").value.trim() }), 400);
});
let termsT;
el("keepTerms").addEventListener("input", () => { clearTimeout(termsT); termsT = setTimeout(() => persist({ keepTerms: el("keepTerms").value }), 400); });
el("verify").addEventListener("click", async () => {
  const key = el("apiKey").value.trim();
  if (!key) return setKeyStatus("Paste your key first.", "warn");
  setKeyStatus("Checking…", "");
  const r = await chrome.runtime.sendMessage({ type: "VERIFY_KEY", apiKey: key }).catch(() => null);
  keyVerifyFailed = !(r && r.ok);
  if (r && r.ok) setKeyStatus("Key works ✓ — you're all set.", "ok");
  else setKeyStatus("Key rejected" + (r && r.status ? " (HTTP " + r.status + ")" : "") + " — check it and try again.", "err");
  refreshKeyDot();
});

function setAnthropicKeyStatus(text, cls) { const s = el("anthropicKeyStatus"); s.textContent = text; s.className = cls || ""; }
function anthropicKeyHint() {
  if (!el("anthropicKey").value.trim()) setAnthropicKeyStatus("Paste your key above to start — it's stored only on this device.", "warn");
  else setAnthropicKeyStatus("Stored only on this device. Applies to newly translated lines — cached lines keep their existing translation.", "");
}
let anthropicKeyVerifyFailed = false;
function refreshAnthropicKeyDot() {
  setKeyDot("anthropicKeyDot", keyDotColor(el("anthropicKey").value, anthropicKeyVerifyFailed));
  refreshKeysSummary();
}
let anthropicKeyT;
el("anthropicKey").addEventListener("input", () => {
  clearTimeout(anthropicKeyT); anthropicKeyHint();
  anthropicKeyVerifyFailed = false; refreshAnthropicKeyDot();
  updateProviderAvailability();
  anthropicKeyT = setTimeout(() => persist({ anthropicKey: el("anthropicKey").value.trim() }), 400);
});
el("verifyAnthropic").addEventListener("click", async () => {
  const key = el("anthropicKey").value.trim();
  if (!key) return setAnthropicKeyStatus("Paste your key first.", "warn");
  setAnthropicKeyStatus("Checking…", "");
  const r = await chrome.runtime.sendMessage({ type: "VERIFY_ANTHROPIC", apiKey: key }).catch(() => null);
  anthropicKeyVerifyFailed = !(r && r.ok);
  if (r && r.ok) setAnthropicKeyStatus("Key works ✓ — you're all set.", "ok");
  else setAnthropicKeyStatus("Key rejected" + (r && r.status ? " (HTTP " + r.status + ")" : "") + " — check it and try again.", "err");
  refreshAnthropicKeyDot();
});

// ── Gemini API key (TTS/dub provider) ────────────────────────────────────────
function setGeminiKeyStatus(text, cls) { const s = el("geminiKeyStatus"); s.textContent = text; s.className = cls || ""; }
function geminiKeyHint() {
  if (!el("geminiKey").value.trim()) setGeminiKeyStatus("Paste your key above to start — it's stored only on this device.", "warn");
  else setGeminiKeyStatus("Stored only on this device. Used only for text-to-speech (dub), never for translation.", "");
}
let geminiKeyVerifyFailed = false;
function refreshGeminiKeyDot() {
  setKeyDot("geminiKeyDot", keyDotColor(el("geminiKey").value, geminiKeyVerifyFailed));
  refreshKeysSummary();
}
let geminiKeyT;
el("geminiKey").addEventListener("input", () => {
  clearTimeout(geminiKeyT); geminiKeyHint();
  geminiKeyVerifyFailed = false; refreshGeminiKeyDot();
  updateProviderAvailability();
  geminiKeyT = setTimeout(() => persist({ geminiKey: el("geminiKey").value.trim() }), 400);
});
el("verifyGemini").addEventListener("click", async () => {
  const key = el("geminiKey").value.trim();
  if (!key) return setGeminiKeyStatus("Paste your key first.", "warn");
  setGeminiKeyStatus("Checking…", "");
  const r = await chrome.runtime.sendMessage({ type: "VERIFY_GEMINI", apiKey: key }).catch(() => null);
  geminiKeyVerifyFailed = !(r && r.ok);
  if (r && r.ok) setGeminiKeyStatus("Key works ✓ — you're all set.", "ok");
  else setGeminiKeyStatus("Key rejected" + (r && r.status ? " (HTTP " + r.status + ")" : "") + " — check it and try again.", "err");
  refreshGeminiKeyDot();
});

// ── Translation + TTS engine selects: options disabled/labeled by key availability ──
// Base labels are constants so rebuilding never accumulates " — add key" suffixes.
const TRANSLATION_OPTIONS = [["openai", "OpenAI GPT-4o-mini"], ["claude", "Claude"]];
const TTS_OPTIONS = [["openai", "OpenAI gpt-4o-mini-tts"], ["gemini", "Gemini 2.5 Flash TTS (native Persian voices)"]];
// Which stored key (input id) each engine option requires, and the two display
// names used in the missing-key warning ("<engine> selected but no <provider> key…").
const ENGINE_KEY = { openai: "apiKey", claude: "anthropicKey", gemini: "geminiKey" };
const ENGINE_KEY_LABEL = { openai: "OpenAI", claude: "Anthropic", gemini: "Gemini" };
const ENGINE_NAME = { openai: "OpenAI", claude: "Claude", gemini: "Gemini" };

function rebuildEngineSelect(selectEl, baseOptions, warnEl) {
  const current = selectEl.value;
  selectEl.innerHTML = "";
  for (const [value, label] of baseOptions) {
    const hasKey = !!el(ENGINE_KEY[value]).value.trim();
    const o = document.createElement("option");
    o.value = value;
    o.textContent = hasKey ? label : label + " — add key";
    o.disabled = !hasKey && value !== current; // never disable the persisted selection itself
    selectEl.appendChild(o);
  }
  selectEl.value = current; // restore selection — never auto-switch away from it
  const stillHasKey = !!el(ENGINE_KEY[current]).value.trim();
  if (!stillHasKey) {
    warnEl.textContent = `${ENGINE_NAME[current]} selected but no ${ENGINE_KEY_LABEL[current]} key — falls back to errors until you add one.`;
    warnEl.hidden = false;
  } else {
    warnEl.hidden = true;
  }
}
function updateProviderAvailability() {
  rebuildEngineSelect(el("translationProvider"), TRANSLATION_OPTIONS, el("translationProviderWarn"));
  rebuildEngineSelect(el("ttsProvider"), TTS_OPTIONS, el("ttsProviderWarn"));
}
el("translationProvider").addEventListener("change", () => {
  persist({ translationProvider: el("translationProvider").value });
  updateProviderAvailability();
  updateClaudeModelUI();
});

// ── Claude model picker: always visible; dim+inert unless the engine is Claude ──
function updateClaudeModelUI() {
  const isClaude = el("translationProvider").value === "claude";
  const row = el("claudeModelRow");
  row.classList.toggle("dim", !isClaude);
  // `inert` (not pointer-events): keyboard focus must not reach a dimmed
  // control — a prior review caught Tab+Enter activating a pointer-blocked one.
  if (isClaude) row.removeAttribute("inert"); else row.setAttribute("inert", "");
  for (const b of row.querySelectorAll(".segopt")) b.classList.toggle("on", b.dataset.model === (state.claudeModel || "claude-sonnet-5"));
}
for (const b of document.querySelectorAll("#claudeModelRow .segopt")) {
  b.addEventListener("click", () => { state.claudeModel = b.dataset.model; persist({ claudeModel: state.claudeModel }); updateClaudeModelUI(); });
}

// ── TTS engine select (dub voice provider) ───────────────────────────────────
function updateTtsProviderUI() {
  const isGemini = el("ttsProvider").value === "gemini";
  el("dubVoice").hidden = isGemini;
  el("dubGeminiVoice").hidden = !isGemini;
  // Multi-voice is OpenAI-only in v1 — disable (not hide) under Gemini so the
  // control stays visible/discoverable, with a hint explaining why it's off.
  const multi = el("dubMultiVoice");
  multi.disabled = isGemini;
  multi.title = isGemini ? "OpenAI voices only for now" : "";
  el("dubMultiVoiceRow").title = isGemini ? "OpenAI voices only for now" : "";
}
el("ttsProvider").addEventListener("change", () => {
  persist({ ttsProvider: el("ttsProvider").value });
  updateTtsProviderUI();
  updateProviderAvailability();
});

// ── simple toggles / selects (live) ──────────────────────────────────────────
el("enabled").addEventListener("change", () => persist({ enabled: el("enabled").checked }));
el("showOriginal").addEventListener("change", () => saveSetting({ showOriginal: el("showOriginal").checked }));
el("hideNative").addEventListener("change", () => persist({ hideNative: el("hideNative").checked }));
el("karaokeHl").addEventListener("change", () => persist({ karaokeHl: el("karaokeHl").checked }));
el("position").addEventListener("change", () => saveSetting({ position: el("position").value }));
el("keepNames").addEventListener("change", () => persist({ keepNames: el("keepNames").checked }));

// ── size slider ───────────────────────────────────────────────────────────────
// The stored size is a FRACTION of the video height (slider 12–50 → 0.012–0.050).
// Legacy "sm|md|lg|xl" values from existing users map onto the same scale and
// keep working — the content script interprets both, nothing is migrated.
const SIZE_TIER = { sm: 24, md: 30, lg: 38, xl: 48 };
const sliderFromSize = (s) => (typeof s === "number" && isFinite(s) ? Math.round(s * 1000) : SIZE_TIER[s] || SIZE_TIER.md);

// Display only — 100% = the default (md tier, slider 30). The stored value
// stays a fraction of video height; px would lie the moment fullscreen hits.
const sizePct = (v) => Math.round((v / SIZE_TIER.md) * 100) + "%";

function setSizeUI(size) {
  const v = Math.max(12, Math.min(50, sliderFromSize(size)));
  el("sizeRange").value = v;
  el("sizeVal").textContent = sizePct(v);
}
let sizeT;
el("sizeRange").addEventListener("input", () => {
  const v = +el("sizeRange").value;
  el("sizeVal").textContent = sizePct(v);
  clearTimeout(sizeT);
  sizeT = setTimeout(() => saveSetting({ size: v / 1000 }), 120); // live via the storage watcher
});

// ── Dub controls (all global; dub.js applies changes live, no restart) ──────
function buildVoiceSelect() {
  const sel = el("dubVoice");
  sel.innerHTML = "";
  for (const [id, label] of window.SV_VOICES.VOICE_LABELS) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = label;
    sel.appendChild(o);
  }
  const gsel = el("dubGeminiVoice");
  gsel.innerHTML = "";
  for (const [id, label] of window.SV_VOICES.GEMINI_VOICE_LABELS) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = label;
    gsel.appendChild(o);
  }
}
// Dim + freeze the voice/mix config while the master toggle is off — instant
// feedback that none of it does anything until "Dub subtitles aloud" is on.
// inert (not just pointer-events) so keyboard focus can't reach the frozen
// controls either — Tab+Enter on Generate would start a paid run.
function syncDubConfig() {
  const off = !el("dubEnabled").checked;
  const box = el("dubConfig");
  box.classList.toggle("off", off);
  box.inert = off;
}
el("dubEnabled").addEventListener("change", () => { state.dubEnabled = el("dubEnabled").checked; persist({ dubEnabled: state.dubEnabled }); syncDubConfig(); });
el("dubVoice").addEventListener("change", () => persist({ dubVoice: el("dubVoice").value }));
el("dubGeminiVoice").addEventListener("change", () => persist({ dubGeminiVoice: el("dubGeminiVoice").value }));
el("dubMultiVoice").addEventListener("change", () => persist({ dubMultiVoice: el("dubMultiVoice").checked }));
let duckT;
el("dubDuck").addEventListener("input", () => {
  el("dubDuckVal").textContent = el("dubDuck").value + "%";
  clearTimeout(duckT);
  duckT = setTimeout(() => persist({ dubDuckLevel: +el("dubDuck").value / 100 }), 120);
});
let paceT;
el("dubPace").addEventListener("input", () => {
  el("dubPaceVal").textContent = (+el("dubPace").value / 100).toFixed(2) + "×";
  clearTimeout(paceT);
  paceT = setTimeout(() => persist({ dubPace: +el("dubPace").value / 100 }), 120);
});

// Poll the active tab's dub status while the popup is open (1.5s, best-effort).
let lastDubStatus = null;
async function pollDub() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tab = tabs && tabs[0];
  const st = tab ? await chrome.tabs.sendMessage(tab.id, { type: "DUB_STATUS" }).catch(() => null) : null;
  lastDubStatus = st;
  const btn = el("dubGenAll"), s = el("dubStatus"), prog = el("dubProg"), now = el("dubNow");
  if (!st || !st.attached) {
    btn.hidden = true;
    s.textContent = state.dubEnabled ? "Open a video with subtitles to dub it." : "";
    prog.hidden = true;
    now.textContent = "";
    maybeRefreshSpend();
    updateFoldSummaries();
    return;
  }
  if (st.live) { btn.hidden = true; s.textContent = "Live streams can't be dubbed."; prog.hidden = true; now.textContent = ""; maybeRefreshSpend(); updateFoldSummaries(); return; }
  if (st.generating) {
    btn.hidden = false;
    btn.textContent = "Cancel";
    s.textContent = `Generating dub — ${st.generating.done}/${st.generating.total} (${st.generating.phase})`;
    prog.hidden = !(st.cachedPct > 0 || st.generating);
    el("dubProgFill").style.width = Math.round((st.cachedPct || 0) * 100) + "%";
    now.textContent = st.nowText ? "🔊 " + st.nowText : ""; // textContent — the line is page-derived
    maybeRefreshSpend();
    updateFoldSummaries();
    return;
  }
  btn.hidden = false;
  btn.textContent = st.estRemainingUSD >= 0.005
    ? `Generate full dub (~$${st.estRemainingUSD.toFixed(2)})`
    : "Full dub cached ✓";
  s.textContent = st.lastError
    ? `Full-dub run stopped: ${st.lastError}`
    : st.cachedPct > 0
    ? `${Math.round(st.cachedPct * 100)}% of this video's dub is cached — replays are free.`
    : "Dub is generated ~1 min ahead while you watch; you pay only for what you see.";
  prog.hidden = !(st.cachedPct > 0 || st.generating);
  el("dubProgFill").style.width = Math.round((st.cachedPct || 0) * 100) + "%";
  now.textContent = st.nowText ? "🔊 " + st.nowText : ""; // textContent — the line is page-derived
  maybeRefreshSpend();
  updateFoldSummaries();
}
setInterval(pollDub, 1500);

// ── spend line: "📊 Today ~$X.XX (est.)" in the bottom bar ──────────────────
// Riding pollDub's 1.5s tick but recomputed only every 4th tick (~6s) — LOG_LIST
// reads the whole call log, which is cheap but not worth doing 40x/min.
// Display rounds to 2dp (4dp reads like a database dump); the hover title
// carries the 4dp figures and the this-video split.
const fmtCost = (c) => "$" + c.toFixed(2);
const fmtCostFull = (c) => "$" + c.toFixed(4);
let dubPollTick = 0;
function maybeRefreshSpend() {
  dubPollTick = (dubPollTick + 1) % 4;
  if (dubPollTick === 1) refreshSpend();
}
async function refreshSpend() {
  const spend = el("spendToday");
  if (!spend) return;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tab = tabs && tabs[0];
  const info = tab ? await chrome.tabs.sendMessage(tab.id, { type: "GET_CLIP" }).catch(() => null) : null;
  const base = info && info.base;
  const title = window.SV_TITLE.clean((info && info.title) || "");

  const res = await chrome.runtime.sendMessage({ type: "LOG_LIST" }).catch(() => null);
  const calls = (res && res.calls) || [];
  const estCost = window.SV_PRICING.estCost;
  const t0 = new Date().setHours(0, 0, 0, 0);
  let today = 0, thisVideo = 0, clipCalls = 0;
  for (const c of calls) {
    if ((c.ts || 0) >= t0) today += estCost(c);
    // exact match on clip base for new rows; cleaned-title match for legacy rows
    const mine = c.base ? c.base === base : (title && window.SV_TITLE.clean(c.title || "") === title);
    if (mine) { thisVideo += estCost(c); clipCalls++; }
  }
  spend.textContent = `Today ~${fmtCost(today)}`;
  el("dubSpend").title = ((base || title) ? `this video ~${fmtCostFull(thisVideo)} · ` : "")
    + `today ~${fmtCostFull(today)} — open the Library → Activity for the full breakdown`;
  const stats = el("clipStats");
  if (stats) {
    const show = (base || title) && clipCalls;
    stats.textContent = show
      ? `~${fmtCost(thisVideo)} · ${clipCalls} API call${clipCalls === 1 ? "" : "s"} (recent)`
      : "";
    stats.title = show ? `exactly ~${fmtCostFull(thisVideo)}` : "";
  }
}
el("dubSpend").addEventListener("click", openLibrary);

el("dubGenAll").addEventListener("click", async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tab = tabs && tabs[0];
  if (!tab) return;
  const type = lastDubStatus && lastDubStatus.generating ? "DUB_CANCEL" : "DUB_GENERATE_ALL";
  await chrome.tabs.sendMessage(tab.id, { type }).catch(() => null);
  pollDub();
});

// ── style preset + custom tweaks (GLOBAL — taste follows the user, not the video) ──
const PRESETS = window.SV_PRESETS;
const FONT_STACKS = window.SV_FONT_STACKS;
const resolveStyle = window.SV_RESOLVE_STYLE;

function paintStyled(elm, r) {
  const v = r.vars;
  elm.style.fontFamily = v["--cs-font-family"];
  elm.style.fontWeight = v["--cs-weight"];
  elm.style.color = v["--cs-color"];
  elm.style.background = v["--cs-bg"];
  elm.style.borderRadius = v["--cs-radius"];
  elm.style.padding = v["--cs-pad"];
  elm.style.textShadow = v["--cs-shadow"];
  // banner (Snap) spans the full strip; boxSizing so the padding stays inside
  elm.style.width = r.banner ? "100%" : "";
  elm.style.boxSizing = r.banner ? "border-box" : "";
  elm.style.textAlign = r.banner ? "center" : "";
}
function buildPresetRow() {
  const row = el("presetRow");
  row.innerHTML = "";
  for (const key of Object.keys(PRESETS)) {
    const b = document.createElement("button");
    b.dataset.preset = key;
    b.title = PRESETS[key].label + " subtitle style";
    const abc = document.createElement("span");
    abc.className = "abc";
    abc.textContent = "Abc";
    paintStyled(abc, resolveStyle({ stylePreset: key }));
    const name = document.createElement("span");
    name.className = "pname";
    name.textContent = PRESETS[key].label;
    b.append(abc, name);
    b.addEventListener("click", () => {
      // Switching presets drops the custom tweaks — they were relative to the old one.
      state.stylePreset = key;
      state.styleCustom = {};
      persist({ stylePreset: key, styleCustom: {} });
      updateStyleUI();
    });
    row.appendChild(b);
  }
  const fontSel = el("styleFont");
  fontSel.innerHTML = '<option value="">Preset default</option>';
  for (const [k, f] of Object.entries(FONT_STACKS)) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = f.label;
    fontSel.appendChild(o);
  }
}
// Merge a tweak into styleCustom (null/"" clears that key back to the preset).
function setCustom(patch) {
  const c = { ...(state.styleCustom || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || v === "") delete c[k];
    else c[k] = v;
  }
  state.styleCustom = c;
  persist({ styleCustom: c });
  updateStyleUI();
}
function updateStyleUI() {
  [...el("presetRow").children].forEach((b) => b.classList.toggle("on", b.dataset.preset === state.stylePreset));
  const c = state.styleCustom || {};
  const r = resolveStyle(state);
  paintStyled(el("stylePrevText"), r);
  el("styleFont").value = c.font && FONT_STACKS[c.font] ? c.font : "";
  const col = window.SV_PARSE_COLOR(r.vars["--cs-color"]);
  el("styleColor").value = col ? col.hex : "#ffffff";
  el("styleEdge").value = c.edge || "";
  // Background controls mirror the EFFECTIVE bg (preset + tweaks), so e.g. the
  // Pill preset shows a white swatch at 96 % — not the classic dark defaults.
  const bg = window.SV_PARSE_COLOR(r.vars["--cs-bg"]);
  el("styleBg").checked = !!bg;
  el("styleBgColor").value = bg ? bg.hex : "#080a0e";
  el("styleBgOpacity").value = Math.round((bg ? bg.a : 0.78) * 100);
  el("styleBgColor").disabled = el("styleBgOpacity").disabled = !bg;
}
let colT;
el("styleColor").addEventListener("input", () => { clearTimeout(colT); colT = setTimeout(() => setCustom({ color: el("styleColor").value }), 120); });
el("styleEdge").addEventListener("change", () => setCustom({ edge: el("styleEdge").value }));
el("styleBg").addEventListener("change", () => setCustom({ bg: el("styleBg").checked }));
let bgT;
el("styleBgColor").addEventListener("input", () => { clearTimeout(bgT); bgT = setTimeout(() => setCustom({ bg: true, bgColor: el("styleBgColor").value }), 120); });
el("styleBgOpacity").addEventListener("input", () => { clearTimeout(bgT); bgT = setTimeout(() => setCustom({ bg: true, bgOpacity: +el("styleBgOpacity").value / 100 }), 120); });
el("styleFont").addEventListener("change", () => setCustom({ font: el("styleFont").value }));
el("styleReset").addEventListener("click", () => { state.styleCustom = {}; persist({ styleCustom: {} }); updateStyleUI(); });

// ── Live Translate (experimental) ─────────────────────────────────────────────
// One Gemini Live session per run: session-based free tier (token budget, no
// request counter), so it keeps running where the TTS dub rate-limits.
let liveRunning = false;
function liveUI(running, statusText, isErr) {
  liveRunning = !!running;
  el("liveBtn").textContent = liveRunning ? "■ Stop Live Translate" : "▶ Start Live Translate";
  if (statusText != null) {
    const s = el("liveStatus");
    s.textContent = statusText;
    s.style.color = isErr ? "#e08585" : "";
  }
}
async function livePopulateDevices() {
  const sel = el("liveDevice");
  sel.replaceChildren();
  const add = (v, t, selected) => { const o = document.createElement("option"); o.value = v; o.textContent = t; if (selected) o.selected = true; sel.appendChild(o); };
  add("", "System default input", !state.audioDeviceId);
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    devs.filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default")
      .forEach((d, i) => add(d.deviceId, d.label || "Input " + (i + 1), d.deviceId === state.audioDeviceId));
  } catch {}
}
el("liveDevice").addEventListener("change", () => { state.audioDeviceId = el("liveDevice").value; persist({ audioDeviceId: state.audioDeviceId }); });
el("liveModel").addEventListener("change", () => {
  state.liveModel = el("liveModel").value.trim() || "gemini-3.5-live-translate";
  el("liveModel").value = state.liveModel;
  el("liveModelVal").textContent = state.liveModel;
  persist({ liveModel: state.liveModel });
});
el("liveBtn").addEventListener("click", async () => {
  if (liveRunning) { chrome.runtime.sendMessage({ type: "LIVE_STOP" }); liveUI(false, "Stopped."); return; }
  if (!(state.geminiKey || el("geminiKey").value.trim())) { liveUI(false, "Add your Google (Gemini) key under API keys first.", true); return; }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tabId = tabs && tabs[0] ? tabs[0].id : null;
  let target = "English";
  try { target = new Intl.DisplayNames(["en"], { type: "language" }).of((state.targets && state.targets[0]) || "en") || "English"; } catch {}
  liveUI(true, "Connecting…");
  chrome.runtime.sendMessage({ type: "LIVE_START", tabId, deviceId: state.audioDeviceId || "", target, model: state.liveModel });
});
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "LIVE_STATE") {
    liveUI(msg.running, msg.error ? msg.error : msg.running ? "Live — listening and speaking…" : "Stopped.", !!msg.error);
  }
});

// Sync dock — writes instantly so the overlay shifts without a reload.
// The dock shows subtitle DELAY (standard player convention: − = earlier,
// + = later); the STORED syncOffset is the engine's look-ahead where positive
// means earlier. The sign flips only at this UI boundary, so every stored /
// per-clip value keeps its exact engine meaning.
function setSyncFromShown(shown) {
  const stored = Math.max(-15, Math.min(15, Math.round(-shown * 100) / 100));
  state.syncOffset = stored;
  el("syncInput").value = (-stored).toFixed(2);
  saveSetting({ syncOffset: stored });
}
const shownSync = () => parseFloat(el("syncInput").value) || 0;
el("syncBack").addEventListener("click", () => setSyncFromShown(shownSync() - 0.25));
el("syncFwd").addEventListener("click", () => setSyncFromShown(shownSync() + 0.25));
el("syncInput").addEventListener("change", () => setSyncFromShown(shownSync()));
el("syncReset").addEventListener("click", () => setSyncFromShown(0));

function flashStatus(t) { el("status").textContent = t; setTimeout(() => { if (el("status").textContent === t) el("status").textContent = ""; }, 2500); }
function openLibrary() { chrome.tabs.create({ url: chrome.runtime.getURL("library.html") }); }
el("openLibrary").addEventListener("click", openLibrary);
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
  const seq = ++clipLoadSeq; // bump before any await — a stale run's async fills below check against this
  const box = el("clipCache");
  const res = await chrome.runtime.sendMessage({ type: "CACHE_LIST" }).catch(() => null);
  const tracks = (res && res.tracks) || [];

  // Library count = number of distinct clips cached (across all languages).
  const bases = new Set();
  for (const t of tracks) { const m = t && t.key && /^(.*):auto:[^:]+$/.exec(t.key); if (m) bases.add(m[1]); }
  el("libCount").textContent = `(${bases.size})`;

  el("clearClip").hidden = true;
  if (!clipBase) {
    // No video: the strip becomes the platform list — the lit chip is the
    // "SubVibe recognizes this tab" signal, no sentence needed.
    el("clipTitleLbl").textContent = "Supported platforms";
    box.className = "clipcache muted";
    box.innerHTML = "";
    const sites = document.createElement("div");
    sites.className = "sites";
    const host = await activeTabHost();
    if (seq !== clipLoadSeq) return; // a newer loadThisVideo() ran during the await
    for (const [name, re] of SUPPORTED_SITES) {
      const c = document.createElement("span");
      c.className = "site" + (re.test(host) ? " on" : "");
      c.textContent = name;
      sites.appendChild(c);
    }
    box.appendChild(sites);
    el("clipExports").hidden = true;
    return;
  }
  el("clipTitleLbl").textContent = "This video";
  const mine = tracks.filter((t) => t.key && t.key.startsWith(clipBase + ":auto:"));
  if (!mine.length) {
    box.className = "clipcache muted";
    box.textContent = "Not cached yet — press play and SubVibe translates ahead.";
    el("clipExports").hidden = true;
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

  const exp = el("clipExports");
  exp.innerHTML = "";
  // title from the cached track rows (in scope here) — NOT from a GET_CLIP
  // `info` variable, which loadThisVideo() does not have
  const gr = { base: clipBase, title: window.SV_TITLE.clean((mine[0] && mine[0].title) || "") || "subvibe" };
  let any = false;
  for (const t of mine) {
    const m = /^.*:auto:([^:]+)$/.exec(t.key);
    if (!m) continue;
    const target = m[1];
    any = true;
    const srtBtn = document.createElement("button");
    srtBtn.className = "btn ghost";
    srtBtn.textContent = `⬇ srt · ${target}`;
    srtBtn.title = "Download the translated subtitles (.srt)";
    srtBtn.onclick = () => window.SV_EXPORT.exportSrt(gr, target);
    exp.appendChild(srtBtn);
    window.SV_EXPORT.audioRows(`${clipBase}:auto:${target}:dub:`).then((rows) => {
      if (seq !== clipLoadSeq) return; // a newer loadThisVideo() ran since — don't paint into its result
      if (!rows.length) return;
      const audBtn = document.createElement("button");
      audBtn.className = "btn ghost";
      audBtn.textContent = `⬇ dub · ${target}`;
      audBtn.title = "Download the dub as one audio file";
      audBtn.onclick = () => window.SV_EXPORT.exportAudio(gr, target);
      exp.appendChild(audBtn);
    });
  }
  exp.hidden = !any;
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
  el("translationProvider").value = state.translationProvider === "claude" ? "claude" : "openai";
  updateClaudeModelUI();
  el("anthropicKey").value = state.anthropicKey || "";
  anthropicKeyHint();
  el("keepNames").checked = state.keepNames !== false;
  el("keepTerms").value = state.keepTerms || "";
  el("showOriginal").checked = state.showOriginal;
  el("hideNative").checked = state.hideNative;
  el("karaokeHl").checked = state.karaokeHl !== false;
  el("position").value = state.position || "bottom";
  el("syncInput").value = (-(state.syncOffset || 0)).toFixed(2);
  setSizeUI(state.size || "md");
  el("dubEnabled").checked = !!state.dubEnabled;
  syncDubConfig();
  el("ttsProvider").value = state.ttsProvider === "gemini" ? "gemini" : "openai";
  el("geminiKey").value = state.geminiKey || "";
  updateTtsProviderUI();
  geminiKeyHint();
  el("liveModel").value = state.liveModel || "gemini-3.5-live-translate";
  el("liveModelVal").textContent = el("liveModel").value;
  livePopulateDevices();
  chrome.runtime.sendMessage({ type: "LIVE_QUERY" }, (r) => { if (r && r.running) liveUI(true, "Live — running."); });
  // Refresh all key dots only AFTER every key input is hydrated — an earlier
  // refresh saw the still-empty Google field and auto-opened the panel forever.
  refreshKeyDot();
  refreshAnthropicKeyDot();
  refreshGeminiKeyDot();
  updateProviderAvailability();
  buildVoiceSelect();
  el("dubVoice").value = state.dubVoice || "marin";
  el("dubGeminiVoice").value = state.dubGeminiVoice || "Kore";
  el("dubMultiVoice").checked = !!state.dubMultiVoice;
  el("dubDuck").value = Math.round((typeof state.dubDuckLevel === "number" ? state.dubDuckLevel : 0.12) * 100);
  el("dubDuckVal").textContent = el("dubDuck").value + "%";
  el("dubPace").value = Math.round((typeof state.dubPace === "number" ? state.dubPace : 1) * 100);
  el("dubPaceVal").textContent = (el("dubPace").value / 100).toFixed(2) + "×";
  pollDub();
  updateStyleUI();
  renderChips();
  keyHint();
  updateScope();
  loadThisVideo();
  updateFoldSummaries();
}

// ── hidden tribute: tap the logo three times, or hold the version line ────────
// In memory of Agha Mansoor. The portrait + words live in shared/tribute.js
// (window.SV_TRIBUTE), loaded before this script. The header's version line
// (v1330.1 · Mansoor — his year, his name) is the quiet door: park the mouse on
// it for 2.5s; its slow shift to mint + glow IS the countdown (see header .ver).
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
    const card = el("memoryCard");
    card.hidden = false;
    // Double rAF: the card must PAINT at opacity 0 before .show lands, or the
    // 1.5s fade-in is skipped and it snaps into view.
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add("show")));
  }
  // The whole card closes it (the bottom hint says so); the × stays for instinct.
  const closeCard = () => { const c = el("memoryCard"); c.classList.remove("show"); c.hidden = true; };
  const close = el("memClose");
  if (close) close.addEventListener("click", closeCard);
  el("memoryCard").addEventListener("click", closeCard);

  // Version line: text from the manifest (single source of truth), hover-hold to open.
  const ver = el("verTag");
  if (ver) {
    try { const m = chrome.runtime.getManifest(); ver.textContent = "v" + (m.version_name || m.version); } catch { ver.textContent = ""; }
    let holdT = 0;
    ver.addEventListener("mouseenter", () => {
      ver.classList.add("arming"); // starts the 2.5s color/glow "unlocking" cue
      holdT = setTimeout(() => { ver.classList.remove("arming"); showMemory(); }, 2500);
    });
    ver.addEventListener("mouseleave", () => { ver.classList.remove("arming"); clearTimeout(holdT); });
  }
})();

buildPresetRow();
load();
initFolds();
initTabs();
