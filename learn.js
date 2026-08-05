// SubVibe Learn — the Leitner trainer page. All data lives in the worker's
// vocab store; this page only renders and messages. Zero API calls except the
// two user-triggered buttons (Enrich, Conjugate), both priced/logged worker-side.
"use strict";

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || {})));
const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let cards = [];   // [{key, word, lang, box, nextDueAt, …}]
let inbox = [];   // [{base, lang, videoTitle, at, words:[{w,n,sentence,st}]}]
let lastBuild = null; // VOCAB_INBOX_BUILD result — the empty state explains itself from this

// ── tabs ─────────────────────────────────────────────────────────────────────
el("tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (!b) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t === b));
  document.querySelectorAll("[data-pane]").forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
});

// ── data ─────────────────────────────────────────────────────────────────────
async function refresh() {
  const [v, i] = await Promise.all([send({ type: "VOCAB_LIST" }), send({ type: "VOCAB_INBOX_LIST" })]);
  cards = v.cards || [];
  inbox = (i.inbox || []).filter((r) => r.words && r.words.length).sort((a, b) => (b.at || 0) - (a.at || 0));
  renderToday();
  renderBoxes();
  renderInbox();
  renderBrowse();
  renderEnrichBar();
}

function toast(text) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── Today: due count + review session ────────────────────────────────────────
let session = null; // { queue: cards[], i, flipped, artPick }

function renderToday() {
  const due = SV_LEITNER.dueCards(cards, Date.now());
  el("nDue").textContent = due.length ? `· ${due.length}` : "";
  el("dueBig").textContent = due.length;
  el("dueSub").textContent = due.length === 1 ? "card due for review" : "cards due for review";
  el("startBtn").disabled = !due.length;
}

el("startBtn").addEventListener("click", () => {
  const due = SV_LEITNER.dueCards(cards, Date.now());
  if (!due.length) return;
  session = { queue: SV_LEITNER.sessionOrder(due), i: 0, flipped: false, artPick: null };
  el("todayCard").hidden = true;
  el("reviewCard").hidden = false;
  renderReview();
});

function endSession(done) {
  session = null;
  el("reviewCard").hidden = true;
  el("todayCard").hidden = false;
  if (done) toast(`Session done — ${done} card${done === 1 ? "" : "s"} reviewed ✓`);
  refresh();
}

function renderReview() {
  const s = session;
  if (!s || s.i >= s.queue.length) return endSession(s ? s.i : 0);
  const c = s.queue[s.i];
  const isArtCard = c.pos === "noun" && c.art; // article quiz first, then flip
  const r = el("reviewCard");
  let html = `<div class="muted" style="font-size:12px;">Box ${c.box} · ${esc(c.videoTitle || "")}</div>`;
  if (isArtCard && !s.flipped) {
    html += `<div class="word">${s.artPick ? esc(c.art) + " " : "___ "}${esc(c.word)}</div>`;
    if (!s.artPick) {
      html += `<div class="arts">` + ["der", "die", "das"].map((a) => `<button class="btn art" data-art="${a}">${a}</button>`).join("") + `</div>`;
      html += `<div class="sentence">${esc(c.sentence || "")}</div>`;
    } else {
      const right = s.artPick === c.art;
      html += `<div class="arts"><button class="btn art ${right ? "right" : "wrong"}">${esc(s.artPick)}</button></div>`;
      html += `<div class="${right ? "" : "muted"}" style="font-weight:700;">${right ? "Richtig ✓" : `→ ${esc(c.art)} ${esc(c.word)}`}</div>`;
      html += `<div class="sentence">${esc(c.sentence || "")}</div>`;
      html += `<div style="margin-top:16px;"><button class="btn primary" id="flipBtn">Flip</button></div>`;
    }
  } else if (!s.flipped) {
    html += `<div class="word">${esc(c.word)}</div>`;
    html += `<div class="sentence">${esc(c.sentence || "")}</div>`;
    html += `<div style="margin-top:16px;"><button class="btn primary" id="flipBtn">Flip</button></div>`;
  }
  if (s.flipped) {
    html += `<div class="word">${c.art ? `<span style="color:var(--brand-3)">${esc(c.art)}</span> ` : ""}${esc(c.word)}</div>`;
    html += `<div class="back">`;
    html += `<div class="meaning">${esc(c.meaning || "(not enriched yet)")}</div>`;
    const bits = [];
    if (c.lemma && c.lemma !== c.word) bits.push(esc(c.lemma));
    if (c.plural) bits.push("pl. " + esc(c.plural));
    if (c.pos) bits.push(esc(c.pos));
    if (c.cefr) bits.push(esc(c.cefr));
    if (bits.length) html += `<div class="extra">${bits.join(" · ")}</div>`;
    if (c.phrase) html += `<div class="extra">„${esc(c.phrase)}“</div>`;
    if (c.sentence) html += `<div class="extra">${esc(c.sentence)}${c.sentenceT ? `<br>${esc(c.sentenceT)}` : ""}</div>`;
    if (c.note) html += `<div class="extra">${esc(c.note)}</div>`;
    if (c.pos === "verb") html += `<div style="margin-top:10px;"><button class="btn small" id="conjBtn">Conjugate</button></div>`;
    html += `</div>`;
    html += `<div class="grade"><button class="btn again" id="againBtn">Again</button><button class="btn good" id="goodBtn">Good</button></div>`;
  }
  html += `<div class="progress">${s.i + 1} / ${s.queue.length}</div>`;
  r.innerHTML = html;

  r.querySelectorAll("[data-art]").forEach((b) => b.addEventListener("click", () => { s.artPick = b.dataset.art; renderReview(); }));
  const flip = r.querySelector("#flipBtn");
  if (flip) flip.addEventListener("click", () => { s.flipped = true; renderReview(); });
  const conj = r.querySelector("#conjBtn");
  if (conj) conj.addEventListener("click", () => showConjugation(c));
  const grade = async (ok) => {
    const resp = await send({ type: "VOCAB_GRADE", key: c.key, ok });
    if (resp.card) { const idx = cards.findIndex((x) => x.key === c.key); if (idx >= 0) cards[idx] = { key: c.key, ...resp.card }; }
    s.i++; s.flipped = false; s.artPick = null;
    renderReview();
  };
  const again = r.querySelector("#againBtn");
  if (again) again.addEventListener("click", () => grade(false));
  const good = r.querySelector("#goodBtn");
  if (good) good.addEventListener("click", () => grade(true));
}

// ── Boxes ────────────────────────────────────────────────────────────────────
function renderBoxes() {
  const cols = el("boxCols");
  cols.innerHTML = "";
  const fmt = (t) => t <= Date.now() ? "due now" : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  for (let b = 1; b <= 5; b++) {
    const inBox = cards.filter((c) => (c.box || 1) === b);
    const next = inBox.length ? Math.min(...inBox.map((c) => c.nextDueAt || 0)) : null;
    const d = document.createElement("div");
    d.className = "box";
    d.innerHTML = `<div class="cnt">${inBox.length}</div><div class="lbl">Box ${b} · ${SV_LEITNER.INTERVALS[b - 1]}d</div>` +
      `<div class="nxt">${next != null ? "next: " + fmt(next) : ""}</div>`;
    cols.appendChild(d);
  }
}

// ── Inbox ────────────────────────────────────────────────────────────────────
function renderInbox() {
  const totalWords = inbox.reduce((a, r) => a + r.words.length, 0);
  el("nInbox").textContent = totalWords ? `· ${totalWords}` : "";
  const list = el("inboxList");
  list.textContent = "";
  if (!inbox.length) {
    const d = document.createElement("div");
    d.className = "muted";
    // Say WHY it's empty: no cache at all, cache too old to carry original
    // sentences, or everything already promoted/dismissed.
    d.textContent = !lastBuild || !lastBuild.clips
      ? "Nothing here yet — watch a subtitled video, then reopen this page."
      : lastBuild.noOrig
        ? `${lastBuild.noOrig} cached video${lastBuild.noOrig === 1 ? "" : "s"} were saved before SubVibe kept the original sentence text (2026-07-29), so they can't feed the inbox. Videos you watch from now on will show up here — and clicking words on the video itself always works.`
        : "All caught up — every cached video's words are already in the trainer or dismissed.";
    list.appendChild(d);
  }
  for (const row of inbox) {
    const d = document.createElement("details");
    d.className = "vid";
    d.open = inbox.length <= 3;
    const sum = document.createElement("summary");
    sum.textContent = row.videoTitle + " ";
    const meta = document.createElement("span");
    meta.className = "muted";
    meta.textContent = `· ${row.words.length} words · ${row.lang}`;
    sum.appendChild(meta);
    d.appendChild(sum);
    const chips = document.createElement("div");
    chips.className = "chips";
    for (const w of row.words) {
      const c = document.createElement("button");
      c.className = "chip";
      c.title = w.sentence || "";
      c.textContent = w.w + " ";
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = "×" + w.n;
      c.appendChild(n);
      c.addEventListener("click", () => c.classList.toggle("sel"));
      c.dataset.w = w.w;
      chips.appendChild(c);
    }
    d.appendChild(chips);
    const acts = document.createElement("div");
    acts.className = "acts";
    const selected = () => [...chips.querySelectorAll(".chip.sel")].map((c) => c.dataset.w);
    const mk = (label, cls, fn) => {
      const b = document.createElement("button");
      b.className = "btn small " + cls;
      b.textContent = label;
      b.addEventListener("click", fn);
      return b;
    };
    acts.appendChild(mk("Promote selected", "primary", async () => {
      const words = selected();
      if (!words.length) return toast("Tap some words first");
      const r = await send({ type: "VOCAB_PROMOTE", base: row.base, words });
      toast(`${r.promoted || 0} word${r.promoted === 1 ? "" : "s"} promoted → box 1`);
      refresh();
    }));
    acts.appendChild(mk("Dismiss selected", "", async () => {
      const words = selected();
      if (!words.length) return toast("Tap some words first");
      await send({ type: "VOCAB_DISMISS", base: row.base, words });
      refresh();
    }));
    acts.appendChild(mk("Select all", "", () => chips.querySelectorAll(".chip").forEach((c) => c.classList.add("sel"))));
    d.appendChild(acts);
    list.appendChild(d);
  }
}

// ── Browse ───────────────────────────────────────────────────────────────────
["fLevel", "fArt", "fPos"].forEach((id) => el(id).addEventListener("change", renderBrowse));

function renderBrowse() {
  el("nCards").textContent = cards.length ? `· ${cards.length}` : "";
  const lv = el("fLevel").value, ar = el("fArt").value, po = el("fPos").value;
  const rows = cards
    .filter((c) => (!lv || c.cefr === lv) && (!ar || c.art === ar) && (!po || c.pos === po))
    .sort((a, b) => String(a.word).localeCompare(String(b.word)));
  const wrap = el("browseWrap");
  if (!rows.length) {
    wrap.textContent = "";
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "No cards match. Save words by clicking them on a video, or promote from the Inbox.";
    wrap.appendChild(d);
    return;
  }
  const fmt = (t) => (t || 0) <= Date.now() ? "due" : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  wrap.innerHTML = `<table><thead><tr><th>Word</th><th>Meaning</th><th>Type</th><th>Level</th><th>Box</th><th>Due</th><th></th></tr></thead><tbody>` +
    rows.map((c) => `<tr>
      <td>${c.art ? `<span class="art-tag">${esc(c.art)}</span> ` : ""}${esc(c.word)}${c.plural ? `<div class="muted" style="font-size:11px;">pl. ${esc(c.plural)}</div>` : ""}</td>
      <td>${esc(c.meaning || "")}${c.phrase ? `<div class="muted" style="font-size:11.5px;">„${esc(c.phrase)}“</div>` : ""}</td>
      <td>${esc(c.pos || "—")}</td>
      <td><span class="lvl">${esc(c.cefr || "·")}</span></td>
      <td>${c.box || 1}</td>
      <td class="muted">${fmt(c.nextDueAt)}</td>
      <td>${c.pos === "verb" ? `<button class="btn small" data-conj="${esc(c.key)}">Conjugate</button>` : ""}</td>
    </tr>`).join("") + "</tbody></table>";
  wrap.querySelectorAll("[data-conj]").forEach((b) => b.addEventListener("click", () => {
    const c = cards.find((x) => x.key === b.dataset.conj);
    if (c) showConjugation(c);
  }));
}

// ── Conjugation (one request per verb ever; cached on the card) ──────────────
async function showConjugation(c) {
  const r = await send({ type: "VOCAB_CONJUGATE", key: c.key });
  if (r.error) return toast(r.error);
  if (!r.cached) { const idx = cards.findIndex((x) => x.key === c.key); if (idx >= 0) cards[idx].conj = r.conj; }
  const PERSONS = ["ich", "du", "er/sie/es", "wir", "ihr", "sie/Sie"];
  const rows = Object.entries(r.conj || {}).map(([label, v]) => {
    const val = Array.isArray(v)
      ? v.map((f, i) => (v.length === 6 && !/^\s*(ich|du|er|wir|ihr|sie)/i.test(String(f)) ? `${PERSONS[i]} ${esc(f)}` : esc(f))).join("<br>")
      : esc(v);
    return `<tr><th style="white-space:nowrap; vertical-align:top;">${esc(label)}</th><td>${val}</td></tr>`;
  }).join("");
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="inner"><h2>${esc(c.lemma || c.word)}</h2><table>${rows}</table>
    <div style="margin-top:14px; text-align:right;"><button class="btn" id="closeConj">Close</button></div></div>`;
  m.addEventListener("click", (e) => { if (e.target === m || e.target.id === "closeConj") m.remove(); });
  document.body.appendChild(m);
}

// ── Enrichment bar (never automatic; price shown BEFORE the click) ───────────
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

// ── boot: build the inbox (free, local scan of the subtitle cache), then render ──
(async () => {
  lastBuild = await send({ type: "VOCAB_INBOX_BUILD" });
  await refresh();
})();
