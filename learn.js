// SubVibe Learn — the full trainer. Two tabs: Practice (the arcade, same
// round loop as the popup's Learn tab, at trainer scale) and Words (every
// collected word — search + filters, merged from the old Inbox+Dictionary).
// All data lives in the worker's vocab store; this page only renders and
// messages. Zero API calls except the two user-triggered buttons (Enrich,
// Conjugate), both priced/logged worker-side.
//
// Storage keys (SHARED with popup.js — editing scope/pace here or there
// updates the same deck): gameScope, gamePace, gameRecords, gameIntro, all
// keyed by language. The pure session engine (scope filter, pacing,
// distractors, records) lives in shared/game.js (SV_GAME); the round LOOP
// itself (session start, card render, answer handling, round end) lives in
// shared/gameui.js (SV_GAMEUI) — shared with popup.js's arcade — this file
// only builds the Practice/Words pane DOM and hands rounds off to it.
"use strict";

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || {})));
const el = (id) => document.getElementById(id);

let cards = [];           // every saved card, from VOCAB_LIST (each carries .key)
let gameScopeAll = {};    // storage: gameScope
let gamePaceAll = {};     // storage: gamePace
let gameRecordsAll = {};  // storage: gameRecords
let gameIntroAll = {};    // storage: gameIntro
let shareName = "";       // storage: shareName — optional sender name for the share sheet, blank by default

const prefersReducedMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function toast(text) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── tabs: Practice / Words (stored value migrates: unknown → practice) ─────
const TABS = ["practice", "words"];
function selectTab(name) {
  if (!TABS.includes(name)) name = "practice";
  for (const b of el("tabs").children) b.classList.toggle("on", b.dataset.tab === name);
  document.querySelectorAll("[data-pane]").forEach((p) => { p.hidden = p.dataset.pane !== name; });
}
el("tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (!b) return;
  selectTab(b.dataset.tab);
  chrome.storage.local.set({ uiLearnTab: b.dataset.tab });
});
async function initTab() {
  // Deep links from elsewhere: learn.html#practice / #words. The old
  // #leitner/#inbox/#dict hashes (pre-restructure) still resolve sensibly.
  const hash = (location.hash || "").slice(1);
  const { uiLearnTab } = await chrome.storage.local.get("uiLearnTab");
  let want = uiLearnTab;
  if (hash === "inbox" || hash === "dict" || hash === "words") want = "words";
  else if (hash === "leitner" || hash === "practice") want = "practice";
  selectTab(want);
}

// ── data ─────────────────────────────────────────────────────────────────
async function loadGameStorage() {
  const g = await chrome.storage.local.get(["gameScope", "gamePace", "gameRecords", "gameIntro", "shareName"]);
  gameScopeAll = g.gameScope || {};
  gamePaceAll = g.gamePace || {};
  gameRecordsAll = g.gameRecords || {};
  gameIntroAll = g.gameIntro || {};
  shareName = typeof g.shareName === "string" ? g.shareName : "";
}
async function refresh() {
  const r = await send({ type: "VOCAB_LIST" });
  cards = r.cards || [];
  el("wTabCount").textContent = cards.length ? "· " + cards.length : "";
  renderPractice();
  updateSourceOptions();
  renderWords();
  renderEnrichBar();
}

// ── Practice pane: deck cards (one per language, same semantics as popup) ──
function deckStatus(langCards) {
  const now = Date.now();
  let nw = 0, learning = 0, mastered = 0, due = 0;
  for (const c of langCards) {
    const st = SV_GAME.status(c);
    if (st === "new") nw++;
    else if (st === "mastered") mastered++;
    else { learning++; if ((c.nextDueAt || 0) <= now) due++; }
  }
  return { new: nw, learning, mastered, total: langCards.length, hot: due > 0 };
}

function describeScope(scope) {
  const s = scope || {};
  const POS_LABEL = { verb: "verbs", noun: "nouns", adj: "adjectives", adv: "adverbs", phrase: "phrases", sep: "separable verbs" };
  const rest = [s.minLevel ? s.minLevel + "+" : "", POS_LABEL[s.pos] || ""].filter(Boolean).join(" · ");
  let filterWord = "Everything";
  if (s.source && s.source.startsWith("base:")) filterWord = "one video";
  else if (s.source && s.source.startsWith("channel:")) filterWord = s.source.slice(8);
  return { filterWord, rest };
}

function topChannels(lang, n) {
  const counts = new Map();
  for (const c of cards) {
    if (c.lang !== lang || !c.channel || SV_GAME.status(c) === "mastered") continue;
    counts.set(c.channel, (counts.get(c.channel) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([ch]) => ch);
}

function fmtRecordsStrip(records) {
  const r = records || {};
  const bits = [];
  if (r.streakDays) bits.push("🔥 " + r.streakDays);
  if (r.bestRound) bits.push("best round: " + r.bestRound);
  if (r.fastestPerfectSec) bits.push("fastest perfect: " + r.fastestPerfectSec + "s");
  return bits.join(" · ");
}

function renderPractice() {
  const box = el("deckCards");
  box.innerHTML = ""; // wipes any open share sheet's DOM too — drop the dangling reference
  openShareSheet = null;
  const byLang = new Map();
  for (const c of cards) {
    if (!byLang.has(c.lang)) byLang.set(c.lang, []);
    byLang.get(c.lang).push(c);
  }
  if (!byLang.size) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Words you collect while watching become playable decks here — open a video with subtitles and click a few words to start.";
    box.appendChild(empty);
    return;
  }
  for (const [lang, langCards] of byLang) box.appendChild(buildDeckCard(lang, langCards));
}

function buildDeckCard(lang, langCards) {
  const [, name, flag] = window.svLangMeta(lang);
  const scope = gameScopeAll[lang] || { source: "", minLevel: "", pos: "" };
  const st = deckStatus(langCards);

  const wrap = document.createElement("div");
  const dcard = document.createElement("div");
  dcard.className = "deckcard" + (st.hot ? " hot" : "");

  const top = document.createElement("div");
  top.className = "dtop";

  const flagEl = document.createElement("span");
  flagEl.className = "dflag";
  flagEl.innerHTML = flag; // static table data — same pattern as popup.js's deck cards

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
  const change = document.createElement("button");
  change.className = "btn-quiet dchange";
  change.textContent = "Change";
  change.addEventListener("click", () => toggleScopeSheet(lang, wrap));
  info.append(nameEl, scopeEl, change);

  const share = document.createElement("button");
  share.className = "btn-quiet dshare";
  share.textContent = "⇪";
  share.title = "Share this deck";
  share.setAttribute("aria-label", "Share this deck");
  share.addEventListener("click", () => toggleShareSheet(lang, langCards, wrap));

  const play = document.createElement("button");
  play.className = "btn-primary dplay";
  play.textContent = "Play";
  play.addEventListener("click", () => startGame(lang));

  top.append(flagEl, info, share, play);
  dcard.appendChild(top);

  // Gifted-deck tag — any card in this deck carrying .gift (imported via
  // svbox, first one found in list order wins the shown name; textContent
  // only, gift names arrive off an untrusted file).
  const giftCard = langCards.find((c) => c.gift);
  if (giftCard) {
    const gift = document.createElement("div");
    gift.className = "dgift";
    gift.textContent = "from " + giftCard.gift + " 🎁";
    dcard.appendChild(gift);
  }

  const stripTxt = fmtRecordsStrip(gameRecordsAll[lang]); // records only ever celebrate — nothing renders until there's something to celebrate
  if (stripTxt) {
    const strip = document.createElement("div");
    strip.className = "trecords";
    strip.textContent = stripTxt;
    dcard.appendChild(strip);
  }

  // Stacked progress bar — no numerals ON the bar; counts are quiet meta in the legend below.
  const prog = document.createElement("div");
  prog.className = "tprogress";
  const bar = document.createElement("div");
  bar.className = "tbar";
  const segs = [["new", st.new, "new"], ["learning", st.learning, "learning"], ["mastered", st.mastered, "mastered"]];
  for (const [key, n] of segs) {
    const s = document.createElement("span");
    s.className = "seg-" + key;
    s.style.flexGrow = String(n);
    s.style.flexBasis = "0";
    bar.appendChild(s);
  }
  prog.appendChild(bar);
  const legend = document.createElement("div");
  legend.className = "tlegend";
  for (const [key, n, label] of segs) {
    const item = document.createElement("span");
    const dot = document.createElement("span");
    dot.className = "dot " + key;
    item.appendChild(dot);
    item.append(n + " " + label);
    legend.appendChild(item);
  }
  prog.appendChild(legend);
  dcard.appendChild(prog);

  wrap.appendChild(dcard);
  return wrap;
}

// ── Scope "Change" sheet — inline, per deck card (same storage as popup) ───
const POS_OPTIONS = [["", "All"], ["noun", "Nouns"], ["verb", "Verbs"], ["sep", "Separable"], ["phrase", "Phrases"]];
const LEVEL_OPTIONS = [["", "All"], ["A2", "A2+"], ["B1", "B1+"], ["C1", "C1+"]];
const GAME_OPTIONS = [["mixed", "Mixed"], ["words", "Words only"], ["sentences", "Sentences only"]];

function toggleScopeSheet(lang, wrap) {
  const existing = wrap.querySelector(".dsheet:not(.sharesheet)");
  if (existing) { existing.remove(); return; }
  closeCardShareSheet(wrap); // one inline sheet per card — the share sheet (if open here) makes way
  const sheet = buildScopeSheet(lang);
  sheet.className = "dsheet";
  wrap.appendChild(sheet);
}

function chipRow(options, current, onPick) {
  const row = document.createElement("div");
  row.className = "wchips";
  for (const [val, label] of options) {
    const chip = document.createElement("button");
    chip.className = "chip" + (current === val ? " on" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => onPick(val));
    row.appendChild(chip);
  }
  return row;
}

function buildScopeSheet(lang) {
  const scope = gameScopeAll[lang] || { source: "", minLevel: "", pos: "" };
  const sheet = document.createElement("div");

  const srcLbl = document.createElement("div");
  srcLbl.className = "fieldlbl";
  srcLbl.textContent = "Source";
  sheet.appendChild(srcLbl);
  const srcChips = [["", "Everything"], ...topChannels(lang, 5).map((ch) => ["channel:" + ch, ch])];
  sheet.appendChild(chipRow(srcChips, scope.source, (v) => setScopeField(lang, "source", v)));

  const lvlLbl = document.createElement("div");
  lvlLbl.className = "fieldlbl";
  lvlLbl.textContent = "Level";
  sheet.appendChild(lvlLbl);
  sheet.appendChild(chipRow(LEVEL_OPTIONS, scope.minLevel, (v) => setScopeField(lang, "minLevel", v)));

  const posLbl = document.createElement("div");
  posLbl.className = "fieldlbl";
  posLbl.textContent = "Type";
  sheet.appendChild(posLbl);
  sheet.appendChild(chipRow(POS_OPTIONS, scope.pos, (v) => setScopeField(lang, "pos", v)));

  const gameLbl = document.createElement("div");
  gameLbl.className = "fieldlbl";
  gameLbl.textContent = "Game";
  sheet.appendChild(gameLbl);
  sheet.appendChild(chipRow(GAME_OPTIONS, scope.game || "mixed", (v) => setScopeField(lang, "game", v)));

  const paceRow = document.createElement("div");
  paceRow.className = "paceRow";
  const paceLbl = document.createElement("span");
  paceLbl.textContent = "New words/day";
  const paceRange = document.createElement("input");
  paceRange.type = "range";
  paceRange.min = "5"; paceRange.max = "50"; paceRange.step = "1";
  paceRange.value = String(gamePaceAll[lang] || 20);
  const paceVal = document.createElement("span");
  paceVal.className = "paceval";
  paceVal.textContent = paceRange.value;
  paceRange.addEventListener("input", () => { paceVal.textContent = paceRange.value; });
  paceRange.addEventListener("change", () => setPace(lang, +paceRange.value));
  paceRow.append(paceLbl, paceRange, paceVal);
  sheet.appendChild(paceRow);

  return sheet;
}

async function setScopeField(lang, field, value) {
  gameScopeAll = (await chrome.storage.local.get("gameScope")).gameScope || {}; // re-read: a second tab/popup instance can write in between — see shared/gameui.js bumpIntro() for the same pattern
  const scope = { ...(gameScopeAll[lang] || { source: "", minLevel: "", pos: "" }) };
  scope[field] = value;
  gameScopeAll[lang] = scope;
  await chrome.storage.local.set({ gameScope: gameScopeAll });
  renderPractice(); // closes the sheet too — a rebuilt card has none open
}
async function setPace(lang, n) {
  gamePaceAll = (await chrome.storage.local.get("gamePace")).gamePace || {}; // re-read: a second tab/popup instance can write in between — see shared/gameui.js bumpIntro() for the same pattern
  gamePaceAll[lang] = n;
  await chrome.storage.local.set({ gamePace: gamePaceAll });
}

// ── Share sheet — inline, per deck card (shared/share.js: SV_SHARE, pure) ──
// Only one share sheet open at a time, across every deck card — opening a
// new one (or toggling the same card's) closes whatever else is open.
let openShareSheet = null;

function closeShareSheet() {
  if (openShareSheet) openShareSheet.remove();
  openShareSheet = null;
}

// Used by toggleScopeSheet (below) so opening the "Change" sheet on a card
// that currently has its share sheet open closes that one first — otherwise
// the two inline sheets stack under the same card.
function closeCardShareSheet(wrap) {
  const sheet = wrap.querySelector(".sharesheet");
  if (sheet) { sheet.remove(); if (openShareSheet === sheet) openShareSheet = null; }
}

function toggleShareSheet(lang, langCards, wrap) {
  const existing = wrap.querySelector(".sharesheet");
  closeShareSheet();
  if (existing) return; // was already open on this card — just closed it
  const scopeSheet = wrap.querySelector(".dsheet:not(.sharesheet)");
  if (scopeSheet) scopeSheet.remove(); // one inline sheet per card
  const sheet = buildShareSheet(lang, langCards);
  sheet.className = "dsheet sharesheet";
  wrap.appendChild(sheet);
  openShareSheet = sheet;
}

// exportDeck returns { filename, text } — the exportable cards live inside
// the JSON `text`, not as a separate array on the return value. Deriving the
// count FROM that text (rather than re-implementing exportDeck's own
// requireWord filter here) means it can never drift from what's actually
// shared.
function exportedCardCount(exported) {
  try { return (JSON.parse(exported.text).cards || []).length; } catch { return 0; }
}

function buildShareSheet(lang, langCards) {
  const sheet = document.createElement("div");

  const head = document.createElement("div");
  head.className = "shead";
  const headLbl = document.createElement("div");
  headLbl.className = "fieldlbl";
  headLbl.textContent = "Share this deck";
  const closeBtn = document.createElement("button");
  closeBtn.className = "btn-quiet";
  closeBtn.textContent = "✕";
  closeBtn.title = "Close";
  closeBtn.setAttribute("aria-label", "Close share sheet");
  closeBtn.addEventListener("click", closeShareSheet);
  head.append(headLbl, closeBtn);
  sheet.appendChild(head);

  // exportDeck returns null on bad input (non-array cards, malformed lang) —
  // langCards/lang always come from a real deck card here, but guard anyway
  // rather than let a null.text throw.
  let exported = SV_SHARE.exportDeck(langCards, lang, { name: shareName });
  if (!exported) {
    const err = document.createElement("div");
    err.className = "muted";
    err.style.cssText = "font-size:12.5px; padding:2px 0;";
    err.textContent = "Couldn't prepare this deck for sharing.";
    sheet.appendChild(err);
    return sheet;
  }

  const [, langDisplayName] = window.svLangMeta(lang);

  const nameLbl = document.createElement("div");
  nameLbl.className = "fieldlbl";
  nameLbl.textContent = "Your name (optional)";
  sheet.appendChild(nameLbl);
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "field";
  nameInput.placeholder = "Blank — no name in the gift";
  nameInput.maxLength = 24; // matches SV_SHARE's own sanitizeName cap
  nameInput.value = shareName;
  sheet.appendChild(nameInput);

  const msgLbl = document.createElement("div");
  msgLbl.className = "fieldlbl";
  msgLbl.textContent = "Message";
  sheet.appendChild(msgLbl);
  const msg = document.createElement("textarea");
  msg.className = "field";
  msg.rows = 5;
  sheet.appendChild(msg);

  function currentMessage() {
    return SV_SHARE.buildShareText(langDisplayName, exportedCardCount(exported), { name: nameInput.value });
  }
  msg.value = currentMessage();

  const linkRow = document.createElement("div");
  linkRow.className = "shareRow";
  const waLink = document.createElement("a");
  waLink.className = "btn-secondary";
  waLink.target = "_blank";
  waLink.rel = "noopener";
  waLink.textContent = "WhatsApp";
  const tgLink = document.createElement("a");
  tgLink.className = "btn-secondary";
  tgLink.target = "_blank";
  tgLink.rel = "noopener";
  tgLink.textContent = "Telegram";
  function refreshLinks() {
    const text = encodeURIComponent(msg.value);
    waLink.href = `https://wa.me/?text=${text}`;
    tgLink.href = `https://t.me/share/url?url=${encodeURIComponent(SV_SHARE.STORE_URL)}&text=${text}`;
  }
  refreshLinks();
  linkRow.append(waLink, tgLink);

  msg.addEventListener("input", refreshLinks);

  // Name changes regenerate filename + message live (every keystroke, cheap
  // for a deck-sized card list); storage is only written on commit
  // (blur/Enter) — same input/change split as the pace slider above.
  nameInput.addEventListener("input", () => {
    exported = SV_SHARE.exportDeck(langCards, lang, { name: nameInput.value }) || exported;
    msg.value = currentMessage();
    refreshLinks();
  });
  nameInput.addEventListener("change", () => setShareName(nameInput.value));

  // Primary OS-share button — only when the platform can actually share a
  // file (navigator.share/canShare are both feature-detected; some browsers
  // don't have canShare at all, or throw on an unfamiliar File — treat any
  // of that as "can't share files here" rather than let it crash the sheet).
  let canOsShare = false;
  try {
    const probe = new File([exported.text], exported.filename, { type: "application/json" });
    canOsShare = typeof navigator.share === "function" && typeof navigator.canShare === "function" &&
      navigator.canShare({ files: [probe] }) === true;
  } catch { canOsShare = false; }
  if (canOsShare) {
    const shareBtn = document.createElement("button");
    shareBtn.className = "btn-primary";
    shareBtn.textContent = "⇪ Share…";
    shareBtn.addEventListener("click", async () => {
      const f = new File([exported.text], exported.filename, { type: "application/json" });
      try {
        await navigator.share({ text: msg.value, files: [f] });
        closeShareSheet();
      } catch (e) {
        if (e && e.name === "AbortError") return; // user cancelled — silent
        toast("Couldn't open the share sheet — try a link below.");
      }
    });
    sheet.appendChild(shareBtn);
  }

  sheet.appendChild(linkRow);

  const actionRow = document.createElement("div");
  actionRow.className = "shareRow";
  const copyBtn = document.createElement("button");
  copyBtn.className = "btn-secondary";
  copyBtn.textContent = "📋 Copy text";
  const copied = document.createElement("span");
  copied.className = "sharecopied";
  copied.textContent = "copied ✓";
  copied.hidden = true;
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(msg.value);
      copied.hidden = false;
      setTimeout(() => { copied.hidden = true; }, 1800);
    } catch {
      toast("Couldn't copy — select and copy the text by hand.");
    }
  });

  const dlBtn = document.createElement("button");
  dlBtn.className = "btn-secondary";
  dlBtn.textContent = "⬇️ File only";
  dlBtn.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([exported.text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = exported.filename;
    a.click();
    URL.revokeObjectURL(url);
  });

  actionRow.append(copyBtn, copied, dlBtn);
  sheet.appendChild(actionRow);

  return sheet;
}

async function setShareName(name) {
  // A flat scalar key, not a per-lang dict like gameScope/gamePace — no
  // cross-tab merge to protect, so (unlike setScopeField/setPace) writing
  // straight from this tab's just-typed value can't drop anyone else's edit.
  shareName = name;
  await chrome.storage.local.set({ shareName: name });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openShareSheet) closeShareSheet();
});

// ── svbox import — file-input button AND drag-drop, both on the arcade
// section (shared/share.js: SV_SHARE, pure — validate the raw text, then
// merge against this lang's existing cards before asking background to
// write anything).
const IMPORT_ERR = {
  "too-large": "That file is too large to import.",
  "parse-error": "That doesn't look like a valid deck file.",
  "bad-version": "That deck file's format isn't supported here.",
  "bad-kind": "That doesn't look like a SubVibe deck file.",
  "bad-lang": "That deck file's language isn't recognized.",
  "bad-cards": "That deck file has no cards.",
  "too-many-cards": "That deck has too many cards to import.",
};

function setImportStatus(text) {
  el("importStatus").textContent = text;
}

async function importSvboxFile(file) {
  let text;
  try { text = await file.text(); } catch { setImportStatus("Couldn't read that file."); return; }
  const v = SV_SHARE.validateImport(text);
  if (!v.ok) { setImportStatus(IMPORT_ERR[v.error] || "Couldn't import that file."); return; }
  // Fresh read, not the cached `cards` — a stale in-memory list would
  // misreport an already-imported card as new (same re-read discipline as
  // setScopeField/setPace above).
  const listResp = await send({ type: "VOCAB_LIST" });
  const existing = (listResp.cards || []).filter((c) => c.lang === v.lang);
  const { toAdd, toUpdate } = SV_SHARE.mergeImport(existing, v.cards, v.lang);
  const resp = await send({ type: "VOCAB_IMPORT", lang: v.lang, name: v.name || "", toAdd, toUpdate });
  if (!resp || !resp.ok) { setImportStatus("Import failed — try again."); return; }
  await refresh();
  const giftBit = v.name ? " · from " + v.name + " 🎁" : "";
  setImportStatus("Added " + resp.added + " new · updated " + resp.updated + giftBit);
}

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

// ── Round engine — delegates to the shared runner (shared/gameui.js) ───────
// Everything session/round-specific (build, render, answer, requeue, round
// end + records) lives in SV_GAMEUI now; this file only resolves the chrome
// plumbing + this surface's own chrome (the schedule fold) and hands off.
function onGameExit({ lang, records } = {}) {
  if (lang && records) gameRecordsAll[lang] = records;
  renderPractice();
}

function startGame(lang) {
  startGameWithScope(lang, gameScopeAll[lang] || { source: "", minLevel: "", pos: "" });
}

function startGameWithScope(lang, scope) {
  SV_GAMEUI.start({
    mount: document,
    cards,
    lang, scope,
    perDay: gamePaceAll[lang] || 20,
    introSeed: gameIntroAll,
    storage: { get: (keys) => chrome.storage.local.get(keys), set: (obj) => chrome.storage.local.set(obj) },
    send,
    foldEl: el("scheduleFold"),
    onExit: onGameExit,
    ui: { reducedMotion: prefersReducedMotion, host: "learn" },
  });
}

// ── "How the schedule works" fold ───────────────────────────────────────────
function renderFoldBody() {
  const days = SV_LEITNER.INTERVALS.join(" · ");
  const body = el("foldBody");
  const p1 = document.createElement("p");
  p1.style.margin = "0 0 8px";
  p1.textContent = `Right → next box (reviews spread to ${days} days). Wrong → back to box 1.`;
  const p2 = document.createElement("p");
  p2.style.margin = "0";
  p2.textContent = 'Five correct reviews — or "know it ✓" — retires a word as mastered; mastered words stop appearing in rounds.';
  body.append(p1, p2);
}

// ── Words pane: search + filters + rows (merged Inbox + Dictionary) ────────
let wSearch = "", wSource = "", wLevel = "", wType = "", wStatus = "";
const TYPE_OPTIONS = [["", "All types"], ["noun", "Nouns"], ["verb", "Verbs"], ["sep", "Separable verbs"],
  ["adj", "Adjectives"], ["adv", "Adverbs"], ["phrase", "Phrases"], ["other", "Other"]];
const WSTATUS_OPTIONS = [["", "All"], ["new", "New"], ["learning", "Practicing"], ["mastered", "Mastered"]];

function initWordsFilters() {
  const search = el("wSearch");
  search.addEventListener("input", () => { wSearch = search.value; renderWords(); });

  const srcSel = el("wSource");
  srcSel.addEventListener("change", () => { wSource = srcSel.value; renderWords(); });

  const lvlChips = el("wLevelChips");
  lvlChips.innerHTML = "";
  for (const [val, label] of LEVEL_OPTIONS) {
    const chip = document.createElement("button");
    chip.className = "chip" + (val === "" ? " on" : "");
    chip.dataset.val = val;
    chip.textContent = label;
    chip.addEventListener("click", () => {
      wLevel = val;
      [...lvlChips.children].forEach((b) => b.classList.toggle("on", b.dataset.val === val));
      renderWords();
    });
    lvlChips.appendChild(chip);
  }

  const typeSel = el("wType");
  typeSel.innerHTML = "";
  for (const [val, label] of TYPE_OPTIONS) {
    const o = document.createElement("option");
    o.value = val; o.textContent = label;
    typeSel.appendChild(o);
  }
  typeSel.addEventListener("change", () => { wType = typeSel.value; renderWords(); });

  const statChips = el("wStatusChips");
  statChips.innerHTML = "";
  for (const [val, label] of WSTATUS_OPTIONS) {
    const chip = document.createElement("button");
    chip.className = "chip" + (val === "" ? " on" : "");
    chip.dataset.val = val;
    chip.textContent = label;
    chip.addEventListener("click", () => {
      wStatus = val;
      [...statChips.children].forEach((b) => b.classList.toggle("on", b.dataset.val === val));
      renderWords();
    });
    statChips.appendChild(chip);
  }
}

function updateSourceOptions() {
  const srcSel = el("wSource");
  const sources = [...new Set(cards.map((c) => c.videoTitle).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (wSource && !sources.includes(wSource)) wSource = "";
  srcSel.innerHTML = "";
  const all = document.createElement("option");
  all.value = ""; all.textContent = "All sources";
  srcSel.appendChild(all);
  for (const s of sources) {
    const o = document.createElement("option");
    o.value = s; o.textContent = s;
    srcSel.appendChild(o);
  }
  srcSel.value = wSource;
}

function resetWordsFilters() {
  wSearch = ""; wSource = ""; wLevel = ""; wType = ""; wStatus = "";
  el("wSearch").value = "";
  el("wSource").value = "";
  el("wType").value = "";
  document.querySelectorAll("#wLevelChips .chip").forEach((b) => b.classList.toggle("on", b.dataset.val === ""));
  document.querySelectorAll("#wStatusChips .chip").forEach((b) => b.classList.toggle("on", b.dataset.val === ""));
  renderWords();
}

function wordMatchesFilters(c) {
  if (wSearch) {
    const q = wSearch.trim().toLowerCase();
    const hay = [c.word, c.meaning, c.lemma].filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (wSource && (c.videoTitle || "") !== wSource) return false;
  if (!SV_GAME.matchesScope(c, { source: "", minLevel: wLevel, pos: wType })) return false;
  if (wStatus && SV_GAME.status(c) !== wStatus) return false;
  return true;
}

function sentenceWithMark(sentence, word) {
  const span = document.createElement("span");
  span.className = "wr-sent";
  const s = sentence || "";
  const i = word ? s.toLowerCase().indexOf(String(word).toLowerCase()) : -1;
  if (i < 0) { span.textContent = s; return span; }
  span.append(s.slice(0, i));
  const m = document.createElement("mark");
  m.textContent = s.slice(i, i + word.length);
  span.append(m, s.slice(i + word.length));
  span.title = s; // full sentence when the row clamps
  return span;
}

function buildWordDetail(c) {
  const d = document.createElement("div");
  d.className = "wr-detail";
  const gramBits = [];
  if (c.art) gramBits.push(`${c.art} ${c.lemma || c.word}`);
  else if (c.lemma && c.lemma !== c.word) gramBits.push(c.lemma);
  if (c.plural) gramBits.push("pl. " + c.plural);
  if (c.pos) gramBits.push(c.pos);
  if (gramBits.length) {
    const g = document.createElement("div");
    g.style.fontWeight = "600";
    g.textContent = gramBits.join(" · ");
    d.appendChild(g);
  }
  if (c.phrase) {
    const p = document.createElement("div");
    p.style.cssText = "margin-top:4px; font-style:italic;";
    p.textContent = SV_QUOTES.wrap(c.phrase, c.lang);
    d.appendChild(p);
  }
  if (c.sentenceT) {
    const st = document.createElement("div");
    st.style.marginTop = "4px";
    st.dir = "auto";
    st.textContent = c.sentenceT;
    d.appendChild(st);
  }
  if (c.note) {
    const n = document.createElement("div");
    n.style.marginTop = "4px";
    n.textContent = c.note;
    d.appendChild(n);
  }
  if (c.para) {
    const pa = document.createElement("div");
    pa.style.marginTop = "4px";
    pa.textContent = "≈ " + c.para;
    d.appendChild(pa);
  }
  if (c.pos === "verb") {
    const conj = document.createElement("button");
    conj.className = "btn-secondary";
    conj.style.marginTop = "8px";
    conj.textContent = "Conjugate";
    conj.addEventListener("click", (e) => { e.stopPropagation(); showConjugation(c); });
    d.appendChild(conj);
  }
  return d;
}

function buildWordRow(c) {
  const row = document.createElement("div");
  row.className = "wordrow";

  // A row-level button once wrapped the "know it ✓" button below — invalid
  // button-in-button nesting. A div+role="button" gives the same click/keyboard
  // affordance without nesting an interactive element inside another.
  const head = document.createElement("div");
  head.className = "wr-head";
  head.setAttribute("role", "button");
  head.tabIndex = 0;
  const top = document.createElement("span");
  top.className = "wr-top";

  const wstat = SV_GAME.status(c);
  const dot = document.createElement("span");
  dot.className = "wdot " + (wstat === "mastered" ? "done" : wstat === "learning" ? "learn" : "new");
  top.appendChild(dot);

  const word = document.createElement("b");
  word.className = "wr-word";
  word.textContent = c.art ? c.art + " " + c.word : c.word;
  top.appendChild(word);

  if (c.cefr && c.cefr !== "?") {
    const lvl = document.createElement("span");
    lvl.className = "lvl";
    lvl.textContent = c.cefr;
    top.appendChild(lvl);
  }

  if (c.meaning) {
    const mean = document.createElement("span");
    mean.className = "wr-meaning";
    mean.dir = "auto"; // Persian meanings flow RTL
    mean.textContent = c.meaning;
    top.appendChild(mean);
  }

  if (wstat !== "mastered") {
    const know = document.createElement("button");
    know.className = "btn-quiet wr-know";
    know.textContent = "know it ✓";
    know.title = "Mark as already known — mastered, no more reviews";
    know.addEventListener("click", async (e) => {
      e.stopPropagation();
      know.disabled = true;
      const resp = await send({ type: "VOCAB_KNOWN", word: c.word, lang: c.lang });
      if (resp && resp.ok) {
        c.box = 5; c.lastGradedAt = Date.now();
        dot.className = "wdot done";
        know.remove();
      } else {
        know.disabled = false;
      }
    });
    top.appendChild(know);
  }

  head.appendChild(top);
  head.appendChild(sentenceWithMark(c.sentence, c.word));
  if (c.videoTitle) {
    const src = document.createElement("span");
    src.className = "wr-src";
    src.textContent = c.videoTitle;
    head.appendChild(src);
  }
  row.appendChild(head);

  let detail = null;
  head.addEventListener("click", () => {
    if (!detail) { detail = buildWordDetail(c); row.appendChild(detail); }
    row.classList.toggle("open");
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

  return row;
}

function renderWords() {
  const box = el("wordRows");
  box.innerHTML = "";
  if (!cards.length) {
    el("wCount").textContent = "";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No words collected yet — click words on a video with subtitles to save them here.";
    box.appendChild(empty);
    return;
  }
  const rows = cards.filter(wordMatchesFilters).sort((a, b) => String(a.word).localeCompare(String(b.word)));
  el("wCount").textContent = `${rows.length} of ${cards.length} word${cards.length === 1 ? "" : "s"}`;
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No words match these filters.";
    box.appendChild(empty);
    const reset = document.createElement("button");
    reset.className = "btn-quiet";
    reset.style.display = "block";
    reset.style.margin = "6px auto 0";
    reset.textContent = "Reset filters";
    reset.addEventListener("click", resetWordsFilters);
    box.appendChild(reset);
    return;
  }
  for (const c of rows) box.appendChild(buildWordRow(c));
}

// ── Conjugation (one request per verb ever; cached on the card) ────────────
async function showConjugation(c) {
  const r = await send({ type: "VOCAB_CONJUGATE", key: c.key });
  if (r.error) return toast(r.error);
  if (!r.cached) { const idx = cards.findIndex((x) => x.key === c.key); if (idx >= 0) cards[idx].conj = r.conj; }
  const PERSONS = ["ich", "du", "er/sie/es", "wir", "ihr", "sie/Sie"];

  const modal = document.createElement("div");
  modal.className = "modal";
  const inner = document.createElement("div");
  inner.className = "inner";
  const h2 = document.createElement("h2");
  h2.textContent = c.lemma || c.word;
  inner.appendChild(h2);

  const table = document.createElement("table");
  const tbody = document.createElement("tbody");
  for (const [label, v] of Object.entries(r.conj || {})) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.style.cssText = "white-space:nowrap; vertical-align:top;";
    th.textContent = label;
    const td = document.createElement("td");
    if (Array.isArray(v)) {
      const usesPersons = v.length === 6 && !v.some((f) => /^\s*(ich|du|er|wir|ihr|sie)/i.test(String(f)));
      v.forEach((f, i) => {
        if (i) td.appendChild(document.createElement("br"));
        td.append(usesPersons ? `${PERSONS[i]} ${f}` : String(f));
      });
    } else {
      td.textContent = String(v);
    }
    tr.append(th, td);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  inner.appendChild(table);

  const closeRow = document.createElement("div");
  closeRow.style.cssText = "margin-top:14px; text-align:right;";
  const closeBtn = document.createElement("button");
  closeBtn.className = "btn-secondary";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => modal.remove());
  closeRow.appendChild(closeBtn);
  inner.appendChild(closeRow);

  modal.appendChild(inner);
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

// ── Enrichment bar (never automatic; price shown BEFORE the click) ─────────
async function renderEnrichBar() {
  const todo = cards.filter((c) => !c.cefr || c.cefr === "?");
  const bar = el("enrichBar");
  if (!todo.length) { bar.hidden = true; return; }
  const s = await chrome.storage.local.get(["translationProvider", "claudeModel"]);
  const provider = s.translationProvider === "claude" ? "claude" : "openai";
  const model = provider === "claude" ? (s.claudeModel || "claude-sonnet-5") : "gpt-4o-mini";
  // ~35 tokens per word+sentence in, ~45 out, ~260-token system prompt per batch of 50.
  const n = todo.length;
  const usd = SV_PRICING.estCost({ provider, model, inTok: n * 35 + Math.ceil(n / 50) * 260, outTok: n * 45 });
  bar.hidden = false;
  el("enrichText").textContent = `${n} word${n === 1 ? "" : "s"} without article, level and meaning yet.`;
  const btn = el("enrichBtn");
  btn.textContent = `Enrich ${n} new word${n === 1 ? "" : "s"} · ~$${usd < 0.005 ? usd.toFixed(4) : usd.toFixed(2)}`;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Enriching…";
    const r = await send({ type: "VOCAB_ENRICH", keys: todo.map((c) => c.key) });
    btn.disabled = false;
    if (r.error) { toast(r.error); renderEnrichBar(); return; }
    toast(r.failed
      ? `${r.enriched} enriched, ${r.failed} failed (${r.err || "provider error"}) — the rest stay enrichable`
      : `${r.enriched} enriched · $${(r.usd || 0).toFixed(4)} (logged in Activity)`);
    refresh();
  };
}

// ── boot ─────────────────────────────────────────────────────────────────
(async () => {
  await initTab();
  initWordsFilters();
  renderFoldBody();
  await loadGameStorage();
  await refresh();
})();
