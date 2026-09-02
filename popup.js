// SubVibe popup. Every control writes to chrome.storage.local immediately; the
// content script watches that store and re-renders live — no Save, no reload.

// Language table + the Persian Lion & Sun (شیر و خورشید) flag live in
// shared/langs.js (loaded first in popup.html) so the popup and the Library page
// share one source of truth.
const FA_FLAG = window.SV_FA_FLAG;
const LANGS = window.SV_LANGS;                 // subtitle "Translate to" set (GPT/Claude)
const LIVE_LANGS = window.SV_LIVE_LANGS;       // Dub set (Gemini live-translate, authoritative)
const LIVE_CODES = new Set(LIVE_LANGS.map((l) => l[0]));
const LIVE_ALIAS = window.SV_LIVE_ALIAS || {};
// Coerce a code to one Gemini's live model accepts, or null if it can't voice it.
const normLiveCode = (code) => (LIVE_CODES.has(code) ? code : (LIVE_CODES.has(LIVE_ALIAS[code]) ? LIVE_ALIAS[code] : null));

const DEFAULTS = { enabled: true, translateOn: true, targets: ["en"], showOriginal: true, hideNative: true, karaokeHl: true, karaokeStyle: "classic", learnLang: "", apiKey: "", translationProvider: "openai", claudeModel: "claude-sonnet-5", anthropicKey: "", cliBridgeOk: false, cliBridgeInfo: "", keepNames: true, keepTerms: "", position: "bottom", size: "md", stylePreset: "classic", styleCustom: {}, syncOffset: 0, dubEnabled: false, ttsProvider: "openai", geminiKey: "", dubVoice: "marin", dubGeminiVoice: "Kore", dubMultiVoice: false, dubDuckLevel: 0.12, dubPace: 1, liveModel: "gemini-3.5-live-translate-preview", audioDeviceId: "", liveTarget: "", debugHud: false, uiTheme: "light" };
const el = (id) => document.getElementById(id);
// Promise wrapper for chrome.runtime.sendMessage — same shape as learn.js's
// helper, used by the word-game wiring below (async/await reads cleaner than
// the callback style the rest of this file uses for its older messages).
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || {})));

// Popup theme UI — the mechanics (light default, auto via matchMedia, cross-
// page follow through storage.onChanged) live in shared/theme.js; this only
// forwards the choice and keeps the gear-pane segment in sync.
function applyTheme(pref) {
  window.SV_THEME.set(pref);
  for (const b of document.querySelectorAll("#themeSeg .segopt")) b.classList.toggle("on", b.dataset.themeOpt === pref);
}
el("themeSeg").addEventListener("click", (e) => {
  const b = e.target.closest("[data-theme-opt]");
  if (!b) return;
  state.uiTheme = b.dataset.themeOpt;
  persist({ uiTheme: state.uiTheme });
  applyTheme(state.uiTheme);
});
const fmtSync = (v) => (v > 0 ? "+" : "") + v.toFixed(2) + "s";
const langMeta = (code) => window.svLangMeta(code);   // resolves a code from EITHER set

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
  { input: "cliBridge", failed: () => cliBridgeFailed, name: "Claude Code" },
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

// ── tabs: Subtitles / Style / Learn, plus Keys (opened only via the header gear).
// Header, scope bar and the This-video strip stay visible above whichever tab is
// open; the choice persists like uiFold.
const TABS = ["translate", "style", "learn", "keys"]; // keys reachable via gear only
function selectTab(name) {
  if (!TABS.includes(name)) name = "translate"; // heals stored "dub" (old default) or any unknown/absent value
  for (const b of el("tabBar").children) b.classList.toggle("on", b.dataset.tab === name);
  el("gearBtn").classList.toggle("on", name === "keys");
  for (const p of document.querySelectorAll(".pane")) p.hidden = p.dataset.pane !== name;
  // Deck render: on Learn-pane show, refresh from the vocab store — but never
  // while a round is live (arcade is hidden then; a mid-flight VOCAB_LIST
  // refetch would just be wasted work, and tab pills stay usable mid-round).
  if (name === "learn" && !SV_GAMEUI.isActive()) renderDecks();
}
el("gearBtn").addEventListener("click", () => {
  const open = !el("gearBtn").classList.contains("on");
  selectTab(open ? "keys" : "translate");
  chrome.storage.local.set({ uiTab: open ? "keys" : "translate" });
});
async function initTabs() {
  const { uiTab } = await chrome.storage.local.get("uiTab");
  selectTab(uiTab);
  el("tabBar").addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b) return;
    selectTab(b.dataset.tab);
    chrome.storage.local.set({ uiTab: b.dataset.tab });
  });
}

// ── Hero setup state: no key yet → show the setup checklist card; any key
// present → show the live-translate hero. Called at load with the freshly
// loaded settings, and again after each successful key verify (passing the
// current input values — `state`'s key fields are only ever set at load,
// see load(), so re-reading the inputs is what actually stays current).
function updateSetupHero(s) {
  const hasKey = !!(s.apiKey || s.anthropicKey || s.geminiKey || s.cliBridgeOk || (state && state.cliBridgeOk));
  el("setupCard").hidden = hasKey;
  el("liveBtn").hidden = !hasKey;
  el("livePerm").hidden = !hasKey;
  el("liveSettingsFold").hidden = !hasKey;
}
const liveKeyInputs = () => ({ apiKey: el("apiKey").value, anthropicKey: el("anthropicKey").value, geminiKey: el("geminiKey").value });
el("finishSetup").addEventListener("click", () => selectTab("keys"));
// Learn tab: every line explained with ? on this video, gathered as one Study sheet in the Shot editor.
el("lnTipsSheet").addEventListener("click", () => {
  const st = el("lnTipsStatus");
  if (!clipBase) { st.textContent = "Open a video with subtitles first."; return; }
  st.textContent = "Opening…";
  chrome.runtime.sendMessage({ type: "TIPS_SHEET", base: clipBase }, (r) => {
    if (chrome.runtime.lastError || !r || !r.ok) st.textContent = r && r.error === "empty" ? "No tips yet — press ? on a subtitle line first." : "Couldn't open the sheet.";
    else st.textContent = r.count + (r.count === 1 ? " line" : " lines") + " — opened in the Shot editor.";
  });
});

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
  if (r && r.ok) { setKeyStatus("Key works ✓ — you're all set.", "ok"); updateSetupHero(liveKeyInputs()); }
  else setKeyStatus("Key rejected" + (r && r.status ? " (HTTP " + r.status + ")" : "") + " — check it and try again.", "err");
  refreshKeyDot();
});

// ── Claude Code on this Mac (the native-messaging bridge, bridge/) ──────────
let cliBridgeFailed = false;
function setCliStatus(text, cls) { const s = el("cliBridgeStatus"); s.textContent = text; s.className = cls || ""; }
function cliBridgeHint() {
  setKeyDot("cliBridgeDot", keyDotColor(el("cliBridge").value, cliBridgeFailed));
  if (el("cliBridge").value) setCliStatus("Connected · " + (state.cliBridgeInfo || "Claude Code") + " · translations run on your Claude subscription, no key needed.", "ok");
  else if (!cliBridgeFailed) setCliStatus("Needs Claude Code installed and logged in on this Mac. Run the command once in a terminal from the SubVibe folder, then Test.", "");
}
el("cliBridgeCmd").textContent = "bash bridge/install.sh " + chrome.runtime.id;
el("cliBridgeCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(el("cliBridgeCmd").textContent); el("cliBridgeCopy").textContent = "Copied"; setTimeout(() => { el("cliBridgeCopy").textContent = "Copy"; }, 1500); } catch (e) { /* clipboard blocked */ }
});
el("cliBridgeTest").addEventListener("click", () => {
  el("cliBridgeTest").disabled = true; setCliStatus("Testing…", "");
  chrome.runtime.sendMessage({ type: "CLI_PING" }, (r) => {
    el("cliBridgeTest").disabled = false;
    const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : (!r || !r.ok) ? ((r && r.error) || "No reply from the bridge.") : "";
    if (err) {
      cliBridgeFailed = true; el("cliBridge").value = ""; state.cliBridgeOk = false; persist({ cliBridgeOk: false });
      setCliStatus(err, "err");
    } else {
      cliBridgeFailed = false; el("cliBridge").value = "ok"; state.cliBridgeOk = true; state.cliBridgeInfo = r.claude || "";
      persist({ cliBridgeOk: true, cliBridgeInfo: state.cliBridgeInfo });
      cliBridgeHint();
    }
    setKeyDot("cliBridgeDot", keyDotColor(el("cliBridge").value, cliBridgeFailed));
    updateProviderAvailability(); updateClaudeModelUI();
    updateSetupHero({ ...liveKeyInputs(), cliBridgeOk: state.cliBridgeOk });
  });
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
  if (r && r.ok) { setAnthropicKeyStatus("Key works ✓ — you're all set.", "ok"); updateSetupHero(liveKeyInputs()); }
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
  if (r && r.ok) { setGeminiKeyStatus("Key works ✓ — you're all set.", "ok"); updateSetupHero(liveKeyInputs()); }
  else setGeminiKeyStatus("Key rejected" + (r && r.status ? " (HTTP " + r.status + ")" : "") + " — check it and try again.", "err");
  refreshGeminiKeyDot();
});

// ── Translation + TTS engine selects: options disabled/labeled by key availability ──
// Base labels are constants so rebuilding never accumulates " — add key" suffixes.
const TRANSLATION_OPTIONS = [["openai", "OpenAI GPT-4o-mini"], ["claude", "Claude (API key)"], ["claude-cli", "Claude Code on this Mac"]];
const TTS_OPTIONS = [["openai", "OpenAI gpt-4o-mini-tts"], ["gemini", "Gemini 2.5 Flash TTS (native Persian voices)"]];
// Which stored key (input id) each engine option requires, and the two display
// names used in the missing-key warning ("<engine> selected but no <provider> key…").
// "claude-cli" has no key: the hidden #cliBridge input holds "ok" once the
// bridge answered a Test, so the same availability logic applies.
const ENGINE_KEY = { openai: "apiKey", claude: "anthropicKey", "claude-cli": "cliBridge", gemini: "geminiKey" };
const ENGINE_KEY_LABEL = { openai: "OpenAI", claude: "Anthropic", "claude-cli": "Claude Code bridge", gemini: "Gemini" };
const ENGINE_NAME = { openai: "OpenAI", claude: "Claude", "claude-cli": "Claude Code", gemini: "Gemini" };

function rebuildEngineSelect(selectEl, baseOptions, warnEl) {
  const current = selectEl.value;
  selectEl.innerHTML = "";
  for (const [value, label] of baseOptions) {
    const hasKey = !!el(ENGINE_KEY[value]).value.trim();
    const o = document.createElement("option");
    o.value = value;
    o.textContent = hasKey ? label : label + (value === "claude-cli" ? " — install the bridge" : " — add key");
    o.disabled = !hasKey && value !== current; // never disable the persisted selection itself
    selectEl.appendChild(o);
  }
  selectEl.value = current; // restore selection — never auto-switch away from it
  const stillHasKey = !!el(ENGINE_KEY[current]).value.trim();
  if (!stillHasKey) {
    warnEl.textContent = current === "claude-cli"
      ? "Claude Code selected but the bridge isn't connected — install it under Keys and press Test."
      : `${ENGINE_NAME[current]} selected but no ${ENGINE_KEY_LABEL[current]} key — falls back to errors until you add one.`;
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
  const isClaude = el("translationProvider").value === "claude" || el("translationProvider").value === "claude-cli";
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
// Subtitle mode = the pair (enabled, translateOn) shown as ONE 3-way control.
// Both are global (like the old master toggle), so the mode is a global preference
// while languages/position/timing stay per-video.
function currentMode() { return !state.enabled ? "off" : (state.translateOn === false ? "original" : "translate"); }
function renderMode() {
  const mode = currentMode();
  [...el("subMode").children].forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  el("translateOnly").hidden = mode !== "translate";
  el("subModeHint").textContent =
    mode === "off" ? "SubVibe subtitles are off. Live Translate (Dub tab) still works on its own."
    : mode === "original" ? "Styling the video's own captions — karaoke and timing work, nothing is sent to a translator. No cost."
    : "Translated to the languages below, using your OpenAI/Claude key.";
}
function setMode(mode) {
  state.enabled = mode !== "off";
  state.translateOn = mode === "translate";
  persist({ enabled: state.enabled, translateOn: state.translateOn });
  renderMode();
}
[...el("subMode").children].forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
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
const HL_STYLES = window.SV_HL_STYLES;
function buildHlRow() {
  const row = el("hlRow");
  row.innerHTML = "";
  for (const [key, h] of Object.entries(HL_STYLES)) {
    const b = document.createElement("button");
    b.dataset.hl = key;
    b.title = h.label + " karaoke highlight";
    const abc = document.createElement("span");
    abc.className = "abc";
    abc.textContent = "Abc";
    abc.style.cssText = "font-weight:800;" + h.css;
    const name = document.createElement("span");
    name.className = "pname";
    name.textContent = h.label;
    b.append(abc, name);
    b.addEventListener("click", () => {
      state.karaokeStyle = key;
      persist({ karaokeStyle: key }); // GLOBAL — taste follows the user, like stylePreset
      updateStyleUI();
    });
    row.appendChild(b);
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
  [...el("hlRow").children].forEach((b) => b.classList.toggle("on", b.dataset.hl === (state.karaokeStyle || "classic")));
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
let liveStateAt = 0; // when the last LIVE_STATE arrived — silence after Start is itself a diagnosis
let liveMyTabId = null, liveIsMine = false, liveElsewhere = false; // is the running session bound to THIS popup's tab?
let liveNoOffscreen = false; // true where there's no offscreen audio API (Firefox) — Live can't run
// Live Translate needs the offscreen document (capture tab audio + play the voice).
// Firefox has no offscreen API, so say so plainly instead of letting Start fail with
// the 10s "no answer from the capture page" timeout.
function liveDisableNoOffscreen() {
  liveNoOffscreen = true;
  const btn = el("liveBtn");
  btn.disabled = true;
  btn.textContent = "Live Translate (Chrome only)";
  el("livePerm").textContent = "Live Translate needs Chrome — Firefox has no offscreen audio API. Subtitles still work in the Translate tab.";
  const s = el("liveStatus"); s.textContent = ""; s.className = "hint";
}
function liveUI(running, statusText, isErr) {
  liveRunning = !!running;
  const b = el("liveBtn");
  b.classList.toggle("live-on", liveRunning);
  b.setAttribute("aria-pressed", liveRunning ? "true" : "false");
  if (liveRunning) {
    // Build the button ONCE on the off→on transition — the 2s stats heartbeat
    // re-calls liveUI, and rebuilding innerHTML each time would reset the idle
    // ring mid-fill. Constant markup, XSS-safe. Clicking anywhere stops.
    const wasOn = b.querySelector(".livelbl");
    if (!wasOn) {
      b.innerHTML = '<span class="livedot" aria-hidden="true"></span><span class="livelbl">Live Translating Audio…</span>' +
        '<span class="livegrow"></span>' +
        '<span class="liveidle" id="liveIdle" hidden title="Nothing to translate — auto-stops at 5:00 idle">' +
        '<svg class="idlering" viewBox="0 0 24 24" aria-hidden="true"><circle class="idlering-bg" cx="12" cy="12" r="9"/><circle class="idlering-fg" cx="12" cy="12" r="9"/></svg>' +
        '<span class="idletxt"></span></span>' +
        '<span class="livestop">✕ Stop</span>';
      b.title = "Stop live translation";
    }
  } else {
    b.classList.remove("live-elsewhere");
    b.textContent = "▶ Start Live Translate";
    b.title = "";
  }
  if (statusText != null) {
    const s = el("liveStatus");
    s.textContent = statusText;
    s.style.color = isErr ? "var(--red)" : "";
  }
}
// Idle ring + countdown next to Stop. idleSecs comes from the offscreen stats
// heartbeat; the amber ring fills toward 5:00, at which point the offscreen
// auto-stops. Hidden while the model is actively hearing (idle ~0).
function updateLiveIdle(idleSecs) {
  const wrap = el("liveIdle");
  if (!wrap) return;
  const MAX = 300; // 5 minutes, matches LV_IDLE_MS in offscreen-live.js
  wrap.hidden = false; // always visible while THIS tab's session runs — empty ring
                       // + "5:00" while audio flows, fills + counts down when idle.
  idleSecs = Math.max(0, idleSecs || 0);
  const remain = Math.max(0, MAX - idleSecs);
  wrap.querySelector(".idletxt").textContent = Math.floor(remain / 60) + ":" + String(remain % 60).padStart(2, "0");
  const fg = wrap.querySelector(".idlering-fg");
  const C = 2 * Math.PI * 9; // r = 9
  fg.style.strokeDasharray = C.toFixed(2);
  fg.style.strokeDashoffset = (C * (1 - Math.min(1, idleSecs / MAX))).toFixed(2);
}
// A live session is running on a DIFFERENT tab: show a slate "Stop" button so it
// can be ended from here (LIVE_END stops the one global session, whatever tab it
// captures) — otherwise a session you can hear becomes uncontrollable off-tab.
function liveUIElsewhere() {
  const b = el("liveBtn");
  b.classList.remove("live-on");
  b.classList.add("live-elsewhere");
  b.setAttribute("aria-pressed", "true");
  b.innerHTML = '<span class="livedot" aria-hidden="true"></span><span class="livelbl">Live running on another tab</span><span class="livegrow"></span><span class="livestop">✕ Stop</span>';
  b.title = "Stop the live session (it is running on another tab)";
}
// The reassurance line under the Live button stays truthful: the default path
// captures the tab (no mic), but a chosen input device DOES need microphone access.
function updateLivePerm() {
  const p = el("livePerm");
  if (!p) return;
  p.textContent = state.audioDeviceId
    ? "🎙 Using a selected input device — microphone access required."
    : "🔒 Capturing this tab's audio safely — no microphone access required.";
}
async function livePopulateDevices() {
  const sel = el("liveDevice");
  sel.replaceChildren();
  const add = (v, t, selected) => { const o = document.createElement("option"); o.value = v; o.textContent = t; if (selected) o.selected = true; sel.appendChild(o); };
  add("", "This tab's audio (no mic needed)", !state.audioDeviceId);
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    devs.filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default")
      .forEach((d, i) => add(d.deviceId, d.label || "Input " + (i + 1), d.deviceId === state.audioDeviceId));
  } catch {}
}
el("liveDevice").addEventListener("change", () => { state.audioDeviceId = el("liveDevice").value; persist({ audioDeviceId: state.audioDeviceId }); updateLivePerm(); });

// ── Dub audio language: ONE searchable pick (not the subtitle multi-chip). Kept
//    separate from `targets` so you can clear "Translate to" — styling the
//    original captions for free — while Live still speaks your chosen language.
function liveTargetCode() { return state.liveTarget || (state.targets && state.targets[0]) || "en"; }
function renderLiveMenu(showAll) {
  const menu = el("liveLangMenu");
  // The box holds the CURRENT language's name, so treat a focus (showAll) as an
  // empty query — otherwise the picker filters down to just the current pick.
  const q = showAll ? "" : el("liveLangSearch").value.trim().toLowerCase();
  const list = LIVE_LANGS.filter(([code, name]) => !q || name.toLowerCase().includes(q) || code.toLowerCase().includes(q)).slice(0, 100);
  menu.innerHTML = "";
  if (!list.length) { menu.innerHTML = '<div class="none">No match</div>'; menu.classList.add("show"); return; }
  const cur = liveTargetCode();
  list.forEach((l) => {
    const row = document.createElement("div");
    row.className = "opt" + (l[0] === cur ? " active" : "");
    row.innerHTML = `<span class="fl">${l[2]}</span><span>${l[1]}</span><span class="code">${l[0]}</span>`;
    row.onmousedown = (e) => { e.preventDefault(); setLiveTarget(l[0]); };
    menu.appendChild(row);
  });
  menu.classList.add("show");
}
// The field shows the picked language's flag where the magnifier sits (an
// <input> can't render the flag inline — Persian's is an SVG string).
function showLiveFlag(searching) {
  const flag = searching ? "" : langMeta(liveTargetCode())[2] || "";
  el("liveLangFlag").innerHTML = flag;
  el("liveLangFlag").hidden = !flag;
  el("liveLangSearch").classList.toggle("hasflag", !!flag);
}
function setLiveTarget(code) {
  state.liveTarget = code;
  saveSetting({ liveTarget: code });
  el("liveLangSearch").value = langMeta(code)[1];
  showLiveFlag();
  el("liveLangMenu").classList.remove("show");
}
el("liveLangSearch").addEventListener("input", () => { showLiveFlag(true); renderLiveMenu(); });
el("liveLangSearch").addEventListener("focus", () => { showLiveFlag(true); el("liveLangSearch").select(); renderLiveMenu(true); });
el("liveLangSearch").addEventListener("keydown", (e) => { if (e.key === "Escape") el("liveLangMenu").classList.remove("show"); });
el("liveLangSearch").addEventListener("blur", () => setTimeout(() => { el("liveLangSearch").value = langMeta(liveTargetCode())[1]; showLiveFlag(); el("liveLangMenu").classList.remove("show"); }, 150));
document.addEventListener("click", (e) => { if (!el("liveLangSearch").contains(e.target) && !el("liveLangMenu").contains(e.target)) el("liveLangMenu").classList.remove("show"); });

el("dbgHud").addEventListener("change", () => { state.debugHud = el("dbgHud").checked; persist({ debugHud: state.debugHud }); });
el("liveBtn").addEventListener("click", async () => {
  if (liveNoOffscreen) return; // disabled here (no offscreen API) — belt-and-suspenders
  // LIVE_BEGIN/LIVE_END are popup→background ONLY. A runtime broadcast reaches
  // every extension page — sending LIVE_START from here delivered it to the
  // capture page TWICE (direct + background's forward), and the two parallel
  // starts raced to consume the same single-use tab stream id.
  if (liveRunning) { chrome.runtime.sendMessage({ type: "LIVE_END" }); liveIsMine = false; liveUI(false, "Stopped."); return; }
  if (liveElsewhere) { chrome.runtime.sendMessage({ type: "LIVE_END" }); liveElsewhere = false; liveUI(false, "Stopped."); return; } // stop the other tab's session from here
  if (!(state.geminiKey || el("geminiKey").value.trim())) { liveUI(false, "Add your Google (Gemini) key in the Keys tab first.", true); selectTab("keys"); return; }
  // Two voices can't share the stage: a running dub would talk over the live
  // translation (and both spend the same Gemini quota) — switch it off.
  let note = "";
  if (el("dubEnabled").checked) {
    el("dubEnabled").checked = false;
    state.dubEnabled = false;
    persist({ dubEnabled: false });
    syncDubConfig();
    note = " (Dub switched off while Live runs)";
  }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tabId = tabs && tabs[0] ? tabs[0].id : null;
  liveMyTabId = tabId; liveIsMine = true; liveElsewhere = false; // THIS tab is the captured one now
  // Prefer the browser's own name; fall back to our table for codes Intl can't
  // resolve (ceb/haw/fy…), so Gemini never gets handed a bare "English" default.
  let target = "";
  try { target = new Intl.DisplayNames(["en"], { type: "language" }).of(liveTargetCode()) || ""; } catch {}
  if (!target || target === liveTargetCode()) target = langMeta(liveTargetCode())[1] || "English";
  liveUI(true, "Connecting…" + note);
  // NOTE: the tab-capture stream id is minted in the BACKGROUND worker, not
  // here — an id minted without consumerTabId is only consumable in the
  // caller's own render process (Chrome 116+), so a popup-minted id was dead
  // on arrival at the offscreen capture page. The popup click still counts as
  // the user invocation tabCapture requires.
  if (state.audioDeviceId) {
    // A real input device was picked (mic / BlackHole) — that DOES need the mic
    // permission, and the invisible offscreen page can never show the prompt.
    // The popup is a visible extension page on the same origin: authorize here,
    // and the grant carries over.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
      livePopulateDevices(); // device NAMES unlock with the grant (e.g. BlackHole)
    } catch (e) {
      if (e && e.name === "NotAllowedError") {
        // A previously denied permission REJECTS instantly without re-prompting —
        // only a full tab can show the prompt again (or undo the block via the
        // padlock menu). Open ours and point the user there.
        chrome.tabs.create({ url: chrome.runtime.getURL("mic-permission.html") });
        liveUI(false, "Microphone blocked — opened a page to grant access. Allow it there, then press Start again.", true);
      } else {
        liveUI(false, "Microphone blocked (" + (e.name || e) + "). Allow microphone access for the extension, then press Start again.", true);
      }
      return;
    }
  }
  chrome.runtime.sendMessage({ type: "LIVE_BEGIN", tabId, wantTab: !state.audioDeviceId, deviceId: state.audioDeviceId || "", origVol: typeof state.dubDuckLevel === "number" ? state.dubDuckLevel : 0.12, target, targetCode: liveTargetCode(), model: state.liveModel || "gemini-3.5-live-translate-preview" });
  // Total-silence watchdog: if NOTHING reports back within 10s, every layer's
  // own error path failed too — say so instead of sitting on "Connecting…".
  const sentAt = Date.now();
  setTimeout(() => {
    if (liveRunning && liveStateAt < sentAt) liveUI(false, "No answer from the capture page in 10s — reload the extension (chrome://extensions ↻), reload this tab, and press Start again.", true);
  }, 10000);
});
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "LIVE_STATE") {
    if (msg.running && !liveIsMine) return; // a live session bound to ANOTHER tab — don't reflect it here
    liveStateAt = Date.now();
    // The stats line is the whole diagnosis: "sent" proves capture works,
    // "heard/spoke" prove Gemini responds, "voice" proves playback scheduled.
    let text;
    if (msg.error) text = msg.error;
    else if (!msg.running) text = "Stopped.";
    else if (msg.stats) text = `Live ${Math.floor(msg.stats.secs / 60)}:${String(msg.stats.secs % 60).padStart(2, "0")} · sent ${msg.stats.upSecs}s audio · heard ${msg.stats.heard} · spoke ${msg.stats.spoke} (${msg.stats.voiceSecs}s voice)`
      + (msg.stats.chunks != null ? ` · out ${msg.stats.chunks}ch/${msg.stats.ints}int/${msg.stats.ctx} → ${msg.stats.tgt}` : "");
    else if (msg.stage) text = msg.stage; // pre-session progress — a stall names its stage
    else text = "Live — connected, waiting for audio…";
    liveUI(msg.running, text, !!msg.error);
    updateLiveIdle(msg.running && msg.stats ? msg.stats.idleSecs : 0);
    if (!msg.running) { liveIsMine = false; liveElsewhere = false; }
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

// Shot (translated screenshots): hand the mode to background, which injects
// the capture script into the active tab, then get out of the way.
for (const [id, mode] of [["shotVisible", "visible"], ["shotFull", "full"], ["shotArea", "area"], ["shotElement", "element"]]) {
  el(id).addEventListener("click", async () => {
    // Resolve the tab HERE (popup context is unambiguous) and hand its id to the
    // background so injection targets exactly the tab the user is viewing.
    let tabId;
    try { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = t && t.id; } catch (e) {}
    chrome.runtime.sendMessage({ type: "SHOT_START", mode, tabId }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        el("status").textContent = (res && res.detail) ? ("Screenshot: " + res.detail) : "Can't run on this page";
        return;
      }
      window.close();
    });
  });
}
// Clip: start recording the playing video on the active tab, then get out of
// the way (the on-page pill / ⌥⇧C stops it). Re-triggering toggles start/stop.
el("clipRecord").addEventListener("click", async () => {
  let tabId;
  try { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = t && t.id; } catch (e) {}
  chrome.runtime.sendMessage({ type: "CLIP_RECORD", tabId }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      const m = (res && (res.error || res.detail)) || "Can't record on this page";
      el("status").textContent = /^[A-Z]/.test(m) ? m : ("Clip: " + m); // full sentences (e.g. the Live conflict) shown as-is
      return;
    }
    window.close();
  });
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
  // This video IS the default now, so drop its per-video override — otherwise the
  // override keeps masking the very default we just set, and nothing changes on
  // screen, which reads as "it didn't work". Clearing it also hides Reset (visible
  // proof it took), on top of the confirmation flashed on the button itself.
  if (clipBase && clipOverrides[clipBase]) { delete clipOverrides[clipBase]; chrome.storage.local.set({ clipOverrides }); updateScope(); }
  const b = el("setDefault"), was = b.textContent;
  b.textContent = "Saved ✓"; b.disabled = true;
  setTimeout(() => { b.textContent = was; b.disabled = false; }, 1500);
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

// ── Learn tab: this video's words, straight from the cache ───────────────────
// The word inside its sentence, lit like the karaoke fill it was born from.
function lnSentence(sentence, word) {
  const s = document.createElement("span");
  s.className = "s";
  const txt = sentence || "";
  const i = txt.toLowerCase().indexOf(String(word).toLowerCase());
  if (i < 0) { s.textContent = txt; return s; }
  s.append(txt.slice(0, i));
  const m = document.createElement("mark");
  m.textContent = txt.slice(i, i + word.length);
  s.append(m, txt.slice(i + word.length));
  s.title = txt;
  return s;
}
let lnData = null; // last VOCAB_CLIP_WORDS response
let lnMin = "";    // level filter: "" | "A2" | "B1"
let lnPos = "";    // word-type filter: "" | verb | noun | adj | adv | phrase
const LN_LVL = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };

// 4631200 → "1:17:11" — the shadowing jump chip's label.
function lnTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function lnSeek(ms) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: "SV_SEEK", ms }, () => chrome.runtime.lastError);
  });
}

function lnRenderRows() {
  const box = el("lnWords"), foot = el("lnFoot");
  box.textContent = "";
  const r = lnData;
  const min = LN_LVL[lnMin] || 0;
  let rows = (r.words || []).filter((w) => (!min || (LN_LVL[w.cefr] || 0) >= min) && (!lnPos || w.pos === lnPos));
  // Type filter honesty: each option carries its count, so "Verbs (0)" is
  // visible BEFORE selecting it instead of a surprise empty list.
  if (r.enriched) {
    const LBL = { verb: "Verbs", noun: "Nouns", adj: "Adjectives", adv: "Adverbs", phrase: "Phrases" };
    const counts = {};
    for (const w of r.words || []) counts[w.pos] = (counts[w.pos] || 0) + 1;
    for (const o of el("lnPos").options) if (o.value) o.textContent = `${LBL[o.value]} (${counts[o.value] || 0})`;
  }
  // Enriched → important-first: highest level, then how often the video says it.
  if (r.enriched) rows = rows.slice().sort((a, b) => (LN_LVL[b.cefr] || 0) - (LN_LVL[a.cefr] || 0) || b.n - a.n);
  el("lnAddAll").hidden = true; // retired — collected words are auto-available to the trainer; pacing feeds them in
  if (!rows.length) {
    if (min || lnPos) {
      // Say what the filters hid and hand back the way out — never a dead end.
      foot.textContent = `The ${[lnMin && lnMin + "+", lnPos].filter(Boolean).join(" · ")} filter hides all ${r.words.length} words — `;
      const a = document.createElement("button");
      a.className = "linkbtn";
      a.textContent = "show all";
      a.addEventListener("click", () => {
        lnMin = "";
        lnPos = "";
        el("lnPos").value = "";
        [...el("lnLvls").children].forEach((x) => x.classList.toggle("on", !x.dataset.min && x.classList.contains("lnlvl")));
        lnRenderRows();
      });
      foot.appendChild(a);
    } else {
      foot.textContent = "No words to show.";
    }
    return;
  }
  foot.textContent = "Tap a word for details (article, plural, examples) — or mark it known";
  for (const w of rows) box.appendChild(lnWordRow(w, r));
}

// One word row: the header line collapses/expands a detail view — article +
// plural + lemma, the enrichment phrase, every collected sentence from the
// video (with its Persian line), and a deliberate "Add to Leitner" button.
function lnWordRow(w, r) {
  const b = document.createElement("div");
  b.className = "lnw";
  // A row-level button once wrapped the "know it ✓" button below — invalid
  // button-in-button nesting. A div+role="button" gives the same click/keyboard
  // affordance without nesting an interactive element inside another.
  const head = document.createElement("div");
  head.className = "head";
  head.setAttribute("role", "button");
  head.tabIndex = 0;
  const top = document.createElement("span");
  top.className = "top";
  // Status dot — gray new / orange learning / teal mastered — from the box +
  // lastGradedAt background.js now attaches to every collected word row.
  const wstat = SV_GAME.status({ box: w.box, lastGradedAt: w.lastGradedAt });
  const dot = document.createElement("span");
  dot.className = "wdot " + (wstat === "mastered" ? "done" : wstat === "learning" ? "learn" : "new");
  top.appendChild(dot);
  const word = document.createElement("b");
  word.textContent = w.art ? `${w.art} ${w.w}` : w.w;
  const n = document.createElement("span");
  n.className = "n";
  n.textContent = "×" + w.n;
  top.append(word, n);
  if (w.cefr && w.cefr !== "?") {
    const lv = document.createElement("span");
    lv.className = "lvl";
    lv.textContent = w.cefr;
    top.appendChild(lv);
  }
  if (w.meaning) {
    const mn = document.createElement("span");
    mn.className = "mean";
    mn.dir = "auto"; // Persian meanings flow RTL
    mn.textContent = w.meaning;
    top.appendChild(mn);
  }
  if (w.seenCount > 0) {
    // This word already turned up in other videos you've watched.
    const sb = document.createElement("span");
    sb.className = "seenb";
    sb.textContent = "seen " + w.seenCount + "×";
    sb.title = "Also in " + w.seenCount + " other video" + (w.seenCount === 1 ? "" : "s") + " you've watched";
    top.appendChild(sb);
  }
  if (typeof w.ms === "number" && w.ms > 0) {
    // Jump chip: seek the video 1s before the word — listen, pause, shadow.
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = "▶ " + lnTime(w.ms);
    t.title = "Jump the video to this line";
    t.addEventListener("click", (e) => { e.stopPropagation(); lnSeek(w.ms); });
    top.appendChild(t);
  }
  if (wstat !== "mastered") {
    // Instant mastery — the fold's one per-word action now (bulk "Add all" is
    // retired); a word never graded gets a fresh box-5 card, an existing one
    // is upgraded in place (background.js VOCAB_KNOWN).
    const know = document.createElement("button");
    know.className = "linkbtn";
    know.textContent = "know it ✓";
    know.title = "Mark as already known — mastered, no more reviews";
    know.addEventListener("click", async (e) => {
      e.stopPropagation();
      know.disabled = true;
      const resp = await send({ type: "VOCAB_KNOWN", word: w.w, lang: r.lang });
      if (resp && resp.ok) {
        w.box = 5; w.lastGradedAt = Date.now();
        dot.className = "wdot done";
        know.remove();
      } else {
        know.disabled = false;
      }
    });
    top.appendChild(know);
  }
  head.appendChild(top);
  head.appendChild(lnSentence(w.sentence, w.w));
  if (w.st) {
    const fa = document.createElement("span");
    fa.className = "fa";
    fa.dir = "auto";
    fa.textContent = w.st;
    fa.title = w.st;
    head.appendChild(fa);
  }
  b.appendChild(head);
  let detail = null;
  head.addEventListener("click", () => {
    if (!detail) { detail = lnWordDetail(w, r, b, n); b.appendChild(detail); }
    b.classList.toggle("open");
  });
  // Native <button> gets Enter/Space-activates-click for free; a div role="button"
  // needs it wired by hand. Guard on e.target so a keypress on the nested "know
  // it ✓" button (which bubbles through here) doesn't double-fire the row toggle.
  head.addEventListener("keydown", (e) => {
    if (e.target !== head) return;
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      head.click();
    }
  });
  return b;
}

function lnWordDetail(w, r, row, nEl) {
  const d = document.createElement("div");
  d.className = "detail";
  const gramBits = [];
  if (w.art) gramBits.push(`${w.art} ${w.lemma || w.w}`);
  else if (w.lemma && w.lemma !== w.w) gramBits.push(w.lemma);
  if (w.plural) gramBits.push("pl. " + w.plural);
  if (w.pos) gramBits.push(w.pos);
  if (gramBits.length) {
    const g = document.createElement("div");
    g.className = "gram";
    g.textContent = gramBits.join(" · ");
    d.appendChild(g);
  }
  if (w.phrase) {
    const p = document.createElement("div");
    p.className = "phrase";
    p.textContent = SV_QUOTES.wrap(w.phrase, r.lang);
    d.appendChild(p);
  }
  for (const s of w.samples || []) {
    const wrap = document.createElement("div");
    wrap.className = "sample";
    if (typeof s.ms === "number" && s.ms > 0) {
      const t = document.createElement("span");
      t.className = "t";
      t.style.cssText = "float:right; margin-left:6px;";
      t.textContent = "▶ " + lnTime(s.ms);
      t.title = "Jump the video to this line";
      t.addEventListener("click", (e) => { e.stopPropagation(); lnSeek(s.ms); });
      wrap.appendChild(t);
    }
    wrap.appendChild(lnSentence(s.o, w.w));
    if (s.st) {
      const fa = document.createElement("span");
      fa.className = "fa";
      fa.dir = "auto";
      fa.textContent = s.st;
      wrap.appendChild(fa);
    }
    d.appendChild(wrap);
  }
  // Other videos this word appeared in — collapsed by default so the current
  // video's context stays the focus; the toggle expands the past sentences.
  if (w.seen && w.seen.length) {
    const toggle = document.createElement("button");
    toggle.className = "ctxtoggle";
    toggle.textContent = "other videos (" + (w.seenCount || w.seen.length) + ")";
    const list = document.createElement("div");
    list.className = "ctxlist";
    for (const s of w.seen) {
      const wrap = document.createElement("div");
      wrap.className = "sample ctx";
      if (s.videoTitle) {
        const vt = document.createElement("span");
        vt.className = "ctxvid";
        vt.textContent = s.videoTitle;
        wrap.appendChild(vt);
      }
      wrap.appendChild(lnSentence(s.sentence, w.w));
      if (s.st) {
        const fa = document.createElement("span");
        fa.className = "fa";
        fa.dir = "auto";
        fa.textContent = s.st;
        wrap.appendChild(fa);
      }
      list.appendChild(wrap);
    }
    toggle.addEventListener("click", (e) => { e.stopPropagation(); toggle.classList.toggle("open"); list.classList.toggle("open"); });
    d.appendChild(toggle);
    d.appendChild(list);
  }
  if (w.note) {
    const nt = document.createElement("div");
    nt.className = "note";
    nt.textContent = w.note;
    d.appendChild(nt);
  }
  if (w.para) {
    const pa = document.createElement("div");
    pa.className = "note"; // same muted small-text family — no new CSS needed
    pa.textContent = "≈ " + w.para;
    d.appendChild(pa);
  }
  const add = document.createElement("button");
  add.className = "lnadd";
  add.textContent = "Add to Leitner box";
  add.addEventListener("click", () => {
    if (row.classList.contains("added")) return;
    add.disabled = true;
    chrome.runtime.sendMessage({ type: "VOCAB_ADD", word: w.w, sentence: w.sentence, translation: w.st || "",
      lang: r.lang, videoTitle: r.title || "", base: clipBase, ms: w.ms || 0 }, (resp) => {
      if (chrome.runtime.lastError || !resp || resp.error) { add.disabled = false; return; }
      row.classList.add("added");
      nEl.textContent = "✓ saved";
      add.textContent = "In the box ✓";
    });
  });
  d.appendChild(add);
  return d;
}

function renderLearnWords() {
  const box = el("lnWords"), foot = el("lnFoot"), enrich = el("lnEnrich"), lvls = el("lnLvls");
  box.textContent = "";
  enrich.hidden = true;
  lvls.hidden = true;
  el("lnCount").textContent = "";
  el("lnPlayThese").hidden = true;
  if (!clipBase) {
    foot.textContent = "Open a video with subtitles — its words show up here to learn from.";
    return;
  }
  chrome.runtime.sendMessage({ type: "VOCAB_CLIP_WORDS", base: clipBase, limit: 150 }, (r) => {
    if (chrome.runtime.lastError || !r) return;
    lnData = r;
    if (!r.words || !r.words.length) {
      foot.textContent = r.reason === "native"
        ? "This video is in a language you already read — nothing to learn here."
        : r.reason === "other-lang"
          ? `This video isn't in the language you're learning (detected: ${r.lang || "unknown"}) — switch "Learning" above to include it.`
          : r.reason === "no-target"
            ? "No translation in your target language cached yet — watch a bit with subtitles on."
            : "No words cached for this video yet — play it with subtitles on, then reopen.";
      return;
    }
    lvls.hidden = !r.enriched; // level filter only means something once levels exist
    if (r.enriching) {
      // A run is underway worker-side (survives the popup closing) — show state,
      // never a second pay button. Poll until it lands.
      enrich.hidden = false;
      enrich.disabled = true;
      enrich.textContent = "Translating & leveling — keep watching, this finishes on its own…";
      setTimeout(renderLearnWords, 4000);
    } else if (r.enrichable) {
      // Meaning + level come from batched requests (50 words each), cached
      // forever for this clip — price up front, never automatic. Delta-aware:
      // a clip enriched when the pool was smaller offers just the missing words.
      const nW = r.enrichable;
      const batches = Math.ceil(nW / 50);
      const prov = state.translationProvider === "claude" ? "claude" : state.translationProvider === "claude-cli" ? "claude-cli" : "openai";
      const usd = window.SV_PRICING.estCost({
        provider: prov,
        model: prov === "openai" ? "gpt-4o-mini" : (state.claudeModel || "claude-sonnet-5"),
        inTok: nW * 35 + batches * 260, outTok: nW * 45,
      });
      enrich.hidden = false;
      enrich.disabled = false;
      enrich.textContent = `Translate & level ${r.enriched ? nW + " more" : "these " + nW} words · ${prov === "claude-cli" ? "on your Claude subscription" : "~$" + (usd < 0.005 ? usd.toFixed(4) : usd.toFixed(2))}`;
      enrich.onclick = () => {
        enrich.disabled = true;
        enrich.textContent = "Translating…";
        chrome.runtime.sendMessage({ type: "VOCAB_CLIP_ENRICH", base: clipBase }, (resp) => {
          if (chrome.runtime.lastError || !resp || resp.error) {
            enrich.disabled = false;
            enrich.textContent = "Failed — try again";
            el("lnFoot").textContent = (resp && resp.error) || "The provider call failed.";
            return;
          }
          renderLearnWords(); // refetch: words come back with meaning/level merged
        });
      };
    }
    el("lnCount").textContent = r.words.length + " collected";
    lnRenderRows();
    updatePlayThese();
  });
}

// ── Word game: arcade decks + rounds (Learn tab) ──────────────────────────
// Storage: gameScope {lang:{source,minLevel,pos}}, gamePace {lang:n} (default
// 20), gameRecords {lang:records}, gameIntro {lang:{day,count}}. The session
// engine itself (scope filter, pacing, distractors, records) lives in
// shared/game.js (SV_GAME) and shared/leitner.js (SV_LEITNER, via
// VOCAB_GRADE/VOCAB_KNOWN worker-side); the round LOOP itself (session start,
// card render, answer handling, round end) lives in shared/gameui.js
// (SV_GAMEUI) — shared with learn.js's trainer — this file only builds the
// deck/scope-sheet DOM and hands the round off via SV_GAMEUI.start().
let gamePool = [];        // every saved card, from VOCAB_LIST (each carries .key)
let gameScopeAll = {};    // storage: gameScope
let gamePaceAll = {};     // storage: gamePace
let gameRecordsAll = {};  // storage: gameRecords
let gameIntroAll = {};    // storage: gameIntro

const prefersReducedMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

async function loadGameStorage() {
  const g = await chrome.storage.local.get(["gameScope", "gamePace", "gameRecords", "gameIntro"]);
  gameScopeAll = g.gameScope || {};
  gamePaceAll = g.gamePace || {};
  gameRecordsAll = g.gameRecords || {};
  gameIntroAll = g.gameIntro || {};
}

function deckStatus(cards) {
  const now = Date.now();
  let nw = 0, learning = 0, mastered = 0, due = 0;
  for (const c of cards) {
    const st = SV_GAME.status(c);
    if (st === "new") nw++;
    else if (st === "mastered") mastered++;
    else { learning++; if ((c.nextDueAt || 0) <= now) due++; }
  }
  return { new: nw, learning, mastered, total: cards.length, hot: due > 0 };
}

// One bolded "filter word" (the source) plus the rest as plain muted text —
// matches the .dscope contract from Task 2 (<b> is required for the teal color).
function describeScope(scope) {
  const s = scope || {};
  const POS_LABEL = { verb: "verbs", noun: "nouns", adj: "adjectives", adv: "adverbs", phrase: "phrases", sep: "separable verbs" };
  const rest = [s.minLevel ? s.minLevel + "+" : "", POS_LABEL[s.pos] || ""].filter(Boolean).join(" · ");
  let filterWord = "Everything";
  if (s.source && s.source.startsWith("base:")) filterWord = clipBase && s.source === "base:" + clipBase ? "this video" : "one video";
  else if (s.source && s.source.startsWith("channel:")) filterWord = s.source.slice(8);
  return { filterWord, rest };
}

function topChannels(lang, n) {
  const counts = new Map();
  for (const c of gamePool) {
    if (c.lang !== lang || !c.channel || SV_GAME.status(c) === "mastered") continue;
    counts.set(c.channel, (counts.get(c.channel) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([ch]) => ch);
}

async function renderDecks() {
  const r = await send({ type: "VOCAB_LIST" });
  gamePool = r.cards || [];
  const box = el("deckCards");
  box.innerHTML = "";
  const byLang = new Map();
  for (const c of gamePool) {
    if (!byLang.has(c.lang)) byLang.set(c.lang, []);
    byLang.get(c.lang).push(c);
  }
  if (!byLang.size) {
    // Cards auto-exist, never created by hand — with nothing collected yet,
    // the arcade just points down at the fold instead of showing an empty card.
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Collect words below and your first game appears here.";
    box.appendChild(hint);
  } else {
    for (const [lang, cards] of byLang) box.appendChild(buildDeckCard(lang, cards));
  }
  updatePlayThese();
}

function buildDeckCard(lang, cards) {
  const [, name, flag] = langMeta(lang);
  const scope = gameScopeAll[lang] || { source: "", minLevel: "", pos: "" };
  const st = deckStatus(cards);

  const wrap = document.createElement("div");
  const dcard = document.createElement("div");
  dcard.className = "deckcard" + (st.hot ? " hot" : "");

  const flagEl = document.createElement("span");
  flagEl.className = "dflag";
  flagEl.innerHTML = flag; // static table data — same pattern as the language chips elsewhere in this file

  const info = document.createElement("div");
  info.className = "dinfo";

  const nameEl = document.createElement("div");
  nameEl.className = "dname";
  nameEl.textContent = name;

  const scopeEl = document.createElement("div");
  scopeEl.className = "dscope";
  const { filterWord, rest } = describeScope(scope);
  const bTag = document.createElement("b");
  bTag.textContent = filterWord;
  scopeEl.appendChild(bTag);
  if (rest) scopeEl.append(" · " + rest);

  // Gifted-deck tag — any card in this deck carrying .gift (imported via
  // svbox, first one found in list order wins the shown name; textContent
  // only, gift names arrive off an untrusted file).
  const giftCard = cards.find((c) => c.gift);
  let giftEl = null;
  if (giftCard) {
    giftEl = document.createElement("div");
    giftEl.className = "dgift";
    giftEl.textContent = "from " + giftCard.gift + " 🎁";
  }

  // True composition bar — segment widths proportional to new/learning/mastered
  // counts, same flexGrow math as the trainer's .tbar (learn.js buildDeckCard).
  // No numerals here — the popup stays quiet.
  const bar = document.createElement("div");
  bar.className = "dbar";
  for (const [key, n] of [["new", st.new], ["learning", st.learning], ["mastered", st.mastered]]) {
    const seg = document.createElement("span");
    seg.className = "seg-" + key;
    seg.style.flexGrow = String(n);
    seg.style.flexBasis = "0";
    bar.appendChild(seg);
  }

  const change = document.createElement("button");
  change.className = "linkbtn";
  change.textContent = "Change";
  change.addEventListener("click", () => toggleScopeSheet(lang, wrap));

  info.append(nameEl, scopeEl);
  if (giftEl) info.append(giftEl);
  info.append(bar, change);

  const play = document.createElement("button");
  play.className = "btn-primary";
  play.textContent = "Play";
  play.addEventListener("click", () => startGame(lang));

  dcard.append(flagEl, info, play);
  wrap.appendChild(dcard);
  return wrap;
}

// ── svbox import — drag-drop only here (the trainer also gets a file-input
// button; this popup is small enough that a drop target on the whole arcade
// is the only affordance). shared/share.js: SV_SHARE (pure, validate+merge).
// parse-error/bad-version/bad-kind all mean the same thing to the user —
// "this isn't a file we can read as a deck" — so they share one precise,
// actionable message rather than three subtly different phrasings; too-large
// is its own distinct, actionable message (a size cap, not a format problem).
// bad-cards only fires when validateImport's `cards` field isn't an array at
// all — a structural rejection like parse-error/bad-version/bad-kind, not
// "no cards" (a structurally-valid file with a genuinely empty cards:[] is
// handled separately below, before this map is ever consulted).
const IMPORT_ERR = {
  "too-large": "That file is too large to import.",
  "parse-error": "That doesn't look like a SubVibe deck file.",
  "bad-version": "That doesn't look like a SubVibe deck file.",
  "bad-kind": "That doesn't look like a SubVibe deck file.",
  "bad-lang": "That deck file's language isn't recognized.",
  "bad-cards": "That doesn't look like a SubVibe deck file.",
  "too-many-cards": "That deck has too many cards to import.",
};
const IMPORT_MAX_BYTES = 2 * 1024 * 1024; // mirrors SV_SHARE.validateImport's own MAX_TEXT cap

function setImportStatus(text) {
  el("importStatus").textContent = text;
}

async function importSvboxFile(file) {
  // Cheap, synchronous, no I/O — reject an obviously oversized file before
  // ever reading it into memory. validateImport's own MAX_TEXT check (on the
  // decoded string's UTF-16 length) still runs below and stays authoritative
  // for anything this pre-check lets through.
  if (file.size > IMPORT_MAX_BYTES) { setImportStatus(IMPORT_ERR["too-large"]); return; }
  let text;
  try { text = await file.text(); } catch { setImportStatus("Couldn't read that file."); return; }
  const v = SV_SHARE.validateImport(text);
  if (!v.ok) { setImportStatus(IMPORT_ERR[v.error] || "Couldn't import that file."); return; }
  // A structurally-valid file whose cards array was genuinely empty from the
  // start (not "every card failed validation" — that's the skipped-count
  // line below) reads as confusing silence otherwise ("Added 0 · updated 0"
  // with no explanation).
  if (v.cards.length === 0 && !v.skipped) { setImportStatus("That deck file is empty."); return; }
  // Fresh read, not the cached gamePool — a stale in-memory list would
  // misreport an already-imported card as new (same re-read discipline as
  // setScopeField/bumpIntro elsewhere in this file).
  const listResp = await send({ type: "VOCAB_LIST" });
  const existing = (listResp.cards || []).filter((c) => c.lang === v.lang);
  const { toAdd, toUpdate } = SV_SHARE.mergeImport(existing, v.cards, v.lang);
  const resp = await send({ type: "VOCAB_IMPORT", lang: v.lang, name: v.name || "", toAdd, toUpdate });
  if (!resp || !resp.ok) { setImportStatus("Import failed — try again."); return; }
  await renderDecks();
  // skipped: cards validateImport itself couldn't read (bad/missing word,
  // oversize field, …) — calm, no error styling, since some cards may still
  // have landed fine; only shown when it's actually nonzero.
  const skippedBit = v.skipped ? " · skipped " + v.skipped + " unreadable" : "";
  const giftBit = v.name ? " · from " + v.name + " 🎁" : "";
  setImportStatus("Added " + resp.added + " new · updated " + resp.updated + skippedBit + giftBit);
}

// File-input Import affordance — drag-drop-only in a tiny popup is a real
// discoverability risk (dragging a file from Finder can steal focus and
// close an extension popup before the drop lands); this mirrors the
// trainer's importBtn/importFile pattern exactly (review fix round 2 —
// needs a real-popup playtest, unverifiable from a stub page since stub
// pages are normal tabs that never auto-close on focus loss).
el("importBtn").addEventListener("click", () => el("importFile").click());
el("importFile").addEventListener("change", async () => {
  const file = el("importFile").files && el("importFile").files[0];
  el("importFile").value = ""; // clears the picked file — allows re-picking the same one back to back
  if (file) await importSvboxFile(file);
});

// dragenter/dragleave fire per child element crossed — a depth counter
// avoids the highlight flickering off as the pointer passes between deck cards.
let arcadeDragDepth = 0;
el("arcade").addEventListener("dragenter", (e) => { e.preventDefault(); arcadeDragDepth++; el("arcade").classList.add("dragover"); });
el("arcade").addEventListener("dragover", (e) => e.preventDefault()); // required so drop fires at all
el("arcade").addEventListener("dragleave", (e) => {
  e.preventDefault();
  arcadeDragDepth = Math.max(0, arcadeDragDepth - 1);
  if (!arcadeDragDepth) el("arcade").classList.remove("dragover");
});
el("arcade").addEventListener("drop", (e) => {
  e.preventDefault();
  arcadeDragDepth = 0;
  el("arcade").classList.remove("dragover");
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) importSvboxFile(file);
});

// ── Scope "Change" sheet — inline, per deck card ────────────────────────────
const POS_OPTIONS = [["", "All"], ["noun", "Nouns"], ["verb", "Verbs"], ["sep", "Separable"], ["phrase", "Phrases"]];
const LEVEL_OPTIONS = [["", "All"], ["A2", "A2+"], ["B1", "B1+"], ["C1", "C1+"]];
const GAME_OPTIONS = [["mixed", "Mixed"], ["words", "Words only"], ["sentences", "Sentences only"]];

function toggleScopeSheet(lang, wrap) {
  const existing = wrap.querySelector(".dsheet");
  if (existing) { existing.remove(); return; }
  const sheet = buildScopeSheet(lang);
  sheet.className = "dsheet";
  wrap.appendChild(sheet);
}

function buildScopeSheet(lang) {
  const scope = gameScopeAll[lang] || { source: "", minLevel: "", pos: "" };
  const sheet = document.createElement("div");
  sheet.style.cssText = "margin-top:6px; padding:10px 12px; background:var(--surface); border:1px solid var(--border); border-radius:var(--r-md);";

  const srcLbl = document.createElement("div");
  srcLbl.className = "hint";
  srcLbl.textContent = "Source";
  sheet.appendChild(srcLbl);

  const srcRow = document.createElement("div");
  srcRow.className = "lnlvls";
  srcRow.style.margin = "3px 0 8px";
  const srcChips = [["", "Everything"]];
  if (clipBase) srcChips.push(["base:" + clipBase, "This video"]);
  for (const ch of topChannels(lang, 3)) srcChips.push(["channel:" + ch, ch]);
  for (const [val, label] of srcChips) {
    const chip = document.createElement("button");
    chip.className = "lnlvl" + (scope.source === val ? " on" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => setScopeField(lang, "source", val));
    srcRow.appendChild(chip);
  }
  sheet.appendChild(srcRow);

  const srcSearch = document.createElement("div");
  srcSearch.className = "ac";
  srcSearch.style.marginBottom = "10px";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Search a channel…";
  input.autocomplete = "off";
  const menu = document.createElement("div");
  menu.className = "menu";
  const runSearch = () => renderChannelSearch(lang, input.value, menu);
  input.addEventListener("input", runSearch);
  input.addEventListener("focus", runSearch);
  // Closing the dropdown on an outside click is handled by ONE listener
  // registered once at module scope below — not here, which would otherwise
  // add a fresh document-level listener (never removed) every time a scope
  // sheet is opened.
  srcSearch.append(input, menu);
  sheet.appendChild(srcSearch);

  const lvlLbl = document.createElement("div");
  lvlLbl.className = "hint";
  lvlLbl.textContent = "Level";
  sheet.appendChild(lvlLbl);
  const lvlRow = document.createElement("div");
  lvlRow.className = "lnlvls";
  lvlRow.style.margin = "3px 0 8px";
  for (const [val, label] of LEVEL_OPTIONS) {
    const chip = document.createElement("button");
    chip.className = "lnlvl" + (scope.minLevel === val ? " on" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => setScopeField(lang, "minLevel", val));
    lvlRow.appendChild(chip);
  }
  sheet.appendChild(lvlRow);

  const posLbl = document.createElement("div");
  posLbl.className = "hint";
  posLbl.textContent = "Type";
  sheet.appendChild(posLbl);
  const posRow = document.createElement("div");
  posRow.className = "lnlvls";
  posRow.style.margin = "3px 0 8px";
  for (const [val, label] of POS_OPTIONS) {
    const chip = document.createElement("button");
    chip.className = "lnlvl" + (scope.pos === val ? " on" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => setScopeField(lang, "pos", val));
    posRow.appendChild(chip);
  }
  sheet.appendChild(posRow);

  const gameLbl = document.createElement("div");
  gameLbl.className = "hint";
  gameLbl.textContent = "Game";
  sheet.appendChild(gameLbl);
  const gameRow = document.createElement("div");
  gameRow.className = "lnlvls";
  gameRow.style.margin = "3px 0 8px";
  for (const [val, label] of GAME_OPTIONS) {
    const chip = document.createElement("button");
    chip.className = "lnlvl" + ((scope.game || "mixed") === val ? " on" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => setScopeField(lang, "game", val));
    gameRow.appendChild(chip);
  }
  sheet.appendChild(gameRow);

  const paceRow = document.createElement("div");
  paceRow.className = "row";
  paceRow.style.marginTop = "6px";
  const paceLbl = document.createElement("span");
  paceLbl.style.cssText = "min-width:98px; color:var(--muted); font-size:12px;";
  paceLbl.textContent = "New words/day";
  const paceRange = document.createElement("input");
  paceRange.type = "range";
  paceRange.min = "5"; paceRange.max = "50"; paceRange.step = "1";
  paceRange.style.flex = "1";
  paceRange.value = String(gamePaceAll[lang] || 20);
  const paceVal = document.createElement("span");
  paceVal.className = "sizeval";
  paceVal.textContent = paceRange.value;
  paceRange.addEventListener("input", () => { paceVal.textContent = paceRange.value; });
  paceRange.addEventListener("change", () => setPace(lang, +paceRange.value));
  paceRow.append(paceLbl, paceRange, paceVal);
  sheet.appendChild(paceRow);

  return sheet;
}

function renderChannelSearch(lang, q, menu) {
  const query = (q || "").trim().toLowerCase();
  const channels = [...new Set(gamePool.filter((c) => c.lang === lang && c.channel).map((c) => c.channel))]
    .filter((c) => !query || c.toLowerCase().includes(query)).slice(0, 20);
  menu.innerHTML = "";
  if (!channels.length) { menu.innerHTML = '<div class="none">No match</div>'; menu.classList.add("show"); return; }
  for (const ch of channels) {
    const row = document.createElement("div");
    row.className = "opt";
    row.textContent = ch;
    row.addEventListener("mousedown", (e) => { e.preventDefault(); setScopeField(lang, "source", "channel:" + ch); });
    menu.appendChild(row);
  }
  menu.classList.add("show");
}

async function setScopeField(lang, field, value) {
  gameScopeAll = (await chrome.storage.local.get("gameScope")).gameScope || {}; // re-read: a second tab/popup instance can write in between — see shared/gameui.js bumpIntro() for the same pattern
  const scope = { ...(gameScopeAll[lang] || { source: "", minLevel: "", pos: "" }) };
  scope[field] = value;
  gameScopeAll[lang] = scope;
  await chrome.storage.local.set({ gameScope: gameScopeAll });
  renderDecks(); // closes the sheet too — a rebuilt card has none open
}

async function setPace(lang, n) {
  gamePaceAll = (await chrome.storage.local.get("gamePace")).gamePace || {}; // re-read: a second tab/popup instance can write in between — see shared/gameui.js bumpIntro() for the same pattern
  gamePaceAll[lang] = n;
  await chrome.storage.local.set({ gamePace: gamePaceAll });
}

// One listener for every scope-sheet channel search, however many sheets get
// opened and rebuilt over the popup's life — avoids stacking a fresh
// document-level listener (never removed) on each "Change" click.
document.addEventListener("mousedown", (e) => {
  const openMenu = document.querySelector("#deckCards .menu.show");
  if (openMenu && !openMenu.closest(".ac").contains(e.target)) openMenu.classList.remove("show");
});

function updatePlayThese() {
  // Visible whenever this video has collected words — NOT gated on already
  // having saved cards for it: the click handler auto-adds enriched words on
  // the spot when there aren't enough saved yet (see below).
  el("lnPlayThese").hidden = !(lnData && lnData.words && lnData.words.length);
}
el("lnPlayThese").addEventListener("click", async () => {
  if (!lnData || !clipBase) return;
  const btn = el("lnPlayThese");
  const scope = { source: "base:" + clipBase, minLevel: "", pos: "" };
  // Mastered cards never enter a round (SV_GAME.buildSession excludes them),
  // so they don't count toward "enough to play" here either.
  const playable = gamePool.filter((c) => c.base === clipBase && c.lang === lnData.lang && SV_GAME.status(c) !== "mastered").length;
  if (playable < 4) {
    const enrichedWords = (lnData.words || []).filter((w) => w.meaning);
    if (!enrichedWords.length) {
      // No meanings yet anywhere in this clip's pool — a round would have no
      // options to quiz on. Same nudge as the enrich button already in the
      // fold, rather than starting a dead round.
      el("lnFoot").textContent = "Enrich this video's words first (button below) so they have meanings to quiz on.";
      return;
    }
    btn.disabled = true;
    try {
      await send({ type: "VOCAB_ADD_MANY", lang: lnData.lang, videoTitle: lnData.title || "", base: clipBase,
        channel: "", // popup-side adds don't know the channel (content-script-only); the base/video facet still scopes them
        items: enrichedWords.map((w) => ({ word: w.w, sentence: w.sentence, translation: w.st || "", ms: w.ms || 0 })) });
      const r = await send({ type: "VOCAB_LIST" });
      gamePool = r.cards || [];
    } finally {
      btn.disabled = false;
    }
  }
  startGameWithScope(lnData.lang, scope);
});

// ── Round engine — delegates to the shared runner (shared/gameui.js) ───────
// Everything session/round-specific (build, render, answer, requeue, round
// end + records) lives in SV_GAMEUI now; this file only resolves the chrome
// plumbing + this surface's own chrome (the video-words fold) and hands off.
function onGameExit({ lang, records } = {}) {
  if (lang && records) gameRecordsAll[lang] = records;
  renderDecks();
}

function startGame(lang) {
  startGameWithScope(lang, gameScopeAll[lang] || { source: "", minLevel: "", pos: "" });
}

function startGameWithScope(lang, scope) {
  const foldSection = el("clipWordsFold").closest("section");
  SV_GAMEUI.start({
    mount: document,
    cards: gamePool,
    lang, scope,
    perDay: gamePaceAll[lang] || 20,
    introSeed: gameIntroAll,
    storage: { get: (keys) => chrome.storage.local.get(keys), set: (obj) => chrome.storage.local.set(obj) },
    send,
    foldEl: foldSection,
    onExit: onGameExit,
    ui: { reducedMotion: prefersReducedMotion, host: "popup" },
  });
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
  renderMode();
  el("apiKey").value = state.apiKey || "";
  el("translationProvider").value = ["claude", "claude-cli"].includes(state.translationProvider) ? state.translationProvider : "openai";
  updateClaudeModelUI();
  el("anthropicKey").value = state.anthropicKey || "";
  anthropicKeyHint();
  el("cliBridge").value = state.cliBridgeOk ? "ok" : "";
  cliBridgeHint();
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
  livePopulateDevices();
  updateLivePerm();
  // Keep liveTarget to a code Gemini can actually voice: inherit the subtitle
  // primary on first run, and heal any stored value the model no longer supports.
  {
    const want = state.liveTarget || (state.targets && state.targets[0]) || "en";
    const ok = normLiveCode(want) || normLiveCode((state.targets && state.targets[0]) || "en") || "en";
    if (ok !== state.liveTarget) { state.liveTarget = ok; persist({ liveTarget: ok }); }
  }
  el("liveLangSearch").value = langMeta(liveTargetCode())[1];
  showLiveFlag();
  el("dbgHud").checked = !!state.debugHud;
  applyTheme(state.uiTheme || "light");
  chrome.runtime.sendMessage({ type: "LIVE_QUERY" }, async (r) => {
    if (r && r.hasOffscreen === false) { liveDisableNoOffscreen(); return; } // Firefox: mark Live as Chrome-only
    if (!r || !r.running) return;
    const t = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    liveMyTabId = t && t[0] ? t[0].id : null;
    if (r.tabId != null && r.tabId === liveMyTabId) { liveIsMine = true; liveUI(true, "Live — running."); } // this tab IS the captured one
    else { liveElsewhere = true; liveUIElsewhere(); el("liveStatus").textContent = "Live is running on another tab — Stop it here, or open that tab."; }
  });
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
  // 🎓 Learn: the tab shows THIS video's words + sentences (tap to save);
  // review, inbox and dictionary live on learn.html.
  const openLearn = () => chrome.tabs.create({ url: chrome.runtime.getURL("learn.html") });
  el("lnOpenFull").addEventListener("click", openLearn);
  el("lnLvls").addEventListener("click", (e) => {
    const b = e.target.closest(".lnlvl");
    if (!b) return;
    lnMin = b.dataset.min;
    [...el("lnLvls").children].forEach((x) => x.classList.toggle("on", x === b));
    lnRenderRows();
  });
  // Learning language (the SOURCE side of the direction; the target side
  // follows the translation setting). Options = the languages the stopword
  // detector actually recognizes — offering more would silently match nothing.
  el("lnLang").value = state.learnLang || "";
  const tgLang = (LANGS.find((l) => l[0] === (state.targets && state.targets[0])) || [])[1];
  el("lnDir").textContent = tgLang ? "→ " + tgLang : "";
  el("lnLang").addEventListener("change", () => {
    persist({ learnLang: el("lnLang").value });
    state.learnLang = el("lnLang").value;
    renderLearnWords();
  });
  el("lnPos").addEventListener("change", () => { lnPos = el("lnPos").value; lnRenderRows(); });
  renderLearnWords();
  pollDub();
  updateStyleUI();
  renderChips();
  keyHint();
  updateSetupHero(state);
  updateScope();
  loadThisVideo();
  updateFoldSummaries();
  await loadGameStorage();
  renderDecks();
}

// ── hidden tribute: tap the logo three times, or hold the version line ────────
// In memory of Agha Mansoor. The portrait + words live in shared/tribute.js
// (window.SV_TRIBUTE), loaded before this script. The header's version line
// (v1330.2 · Mansoor — his year, his name) is the quiet door: park the mouse on
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
buildHlRow();
load();
initFolds();
initTabs();
