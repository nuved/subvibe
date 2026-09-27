// SubVibe Shots — every saved screenshot in one grid, newest first, so an old
// shot can be found and opened without taking a new one. Reads the `shots`
// store in IndexedDB directly (same database and version as shot.js and
// background.js). A card is a plain link to the editor (shot.html?id=…);
// Delete removes the record, the same thing the editor's Delete does.

const el = (id) => document.getElementById(id);
const L = window.SV_SHOTS_LIST;
const langName = (c) => (c && c !== "xx" && window.svLangMeta ? window.svLangMeta(String(c).split("-")[0])[1] : "");

// ── IndexedDB (same DB/version as background.js; the upgrade mirrors it) ──────
let dbP = null;
function db() {
  if (!dbP) {
    dbP = new Promise((resolve, reject) => {
      const req = indexedDB.open("copilot-subs", 5);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of ["tracks", "audio", "vocab", "shots", "clips"]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbP.catch(() => { dbP = null; }); // a failed open is retried by the next read, not remembered
  }
  return dbP;
}
// A cursor, keeping only what a card needs: hundreds of records with their
// text blocks and study cards never sit in memory together. A Blob read back
// from IndexedDB is a handle; its bytes load only when an <img> asks for them.
function readShots() {
  return db().then((d) => new Promise((resolve, reject) => {
    const out = [];
    const req = d.transaction("shots", "readonly").objectStore("shots").openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { resolve(L.sortNewest(out)); return; }
      if (c.value && typeof c.value === "object" && typeof c.primaryKey === "string") out.push(L.summarize(c.primaryKey, c.value));
      c.continue();
    };
    req.onerror = () => reject(req.error);
  }));
}
// Resolves when the delete is committed, not just queued.
function deleteShot(id) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction("shots", "readwrite");
    t.objectStore("shots").delete(id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

// ── state ─────────────────────────────────────────────────────────────────────
let all = [];          // card summaries, newest first
let query = "";
let site = "";         // "" = every site, else one host
let loaded = false;
const cards = new Map(); // shot id → { s, node }

// ── pictures: made only near the screen, let go when they leave it ────────────
// A full-page shot can decode to hundreds of megabytes, so a long grid must
// never hold every picture at once. Hidden cards (search) count as left.
const live = new Map();   // <img> → its object URL
const blobOf = new WeakMap();
function release(img) {
  const u = live.get(img);
  if (!u) return;
  img.removeAttribute("src");
  URL.revokeObjectURL(u);
  live.delete(img);
}
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const img = e.target;
    if (!e.isIntersecting) { release(img); continue; }
    if (live.has(img)) continue;
    const u = URL.createObjectURL(blobOf.get(img));
    live.set(img, u);
    img.src = u;
  }
}, { rootMargin: "600px 0px" });
function releaseAll() { for (const img of [...live.keys()]) release(img); }
addEventListener("pagehide", releaseAll);

// ── cards ─────────────────────────────────────────────────────────────────────
const icon = (id) => el(id).content.firstElementChild.cloneNode(true); // <template> icons in shots.html
const nameOf = (s) => s.title || s.host || "Untitled shot";
const siteName = L.siteName;
// "Sep 27, 4:19 PM" — the year only when it isn't this one, so the site keeps its room on the card.
function fmtWhen(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d)) return "";
  const o = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  if (d.getFullYear() !== new Date().getFullYear()) o.year = "numeric";
  return d.toLocaleString(undefined, o);
}
function span(cls, text) { const x = document.createElement("span"); x.className = cls; x.textContent = text; return x; }

// The first sentence and its translation, in the picture's place.
function textPreview(pic, s) {
  pic.classList.add("is-text");
  const box = document.createElement("div");
  box.className = "shot__text";
  if (s.pair && (s.pair.o || s.pair.t)) {
    for (const [cls, text] of [["o", s.pair.o], ["t", s.pair.t]]) {
      if (!text) continue;
      const p = document.createElement("p");
      p.className = cls; p.dir = "auto"; p.textContent = text; // XSS-safe: page text
      box.appendChild(p);
    }
  } else {
    box.appendChild(span("none", "No picture saved"));
  }
  pic.appendChild(box);
}

function card(s) {
  const c = document.createElement("article");
  c.className = "shot";

  const a = document.createElement("a");
  a.className = "shot__open";
  a.href = "shot.html?id=" + encodeURIComponent(s.id);

  const pic = document.createElement("div");
  pic.className = "shot__pic";
  if (s.blob) {
    const img = document.createElement("img");
    img.alt = ""; // the title is right under it
    img.decoding = "async";
    blobOf.set(img, s.blob);
    // A picture that won't decode falls back to the text, not a broken icon.
    img.addEventListener("error", () => { if (!live.has(img)) return; io.unobserve(img); release(img); img.remove(); textPreview(pic, s); });
    pic.appendChild(img);
    io.observe(img);
  } else {
    textPreview(pic, s);
  }
  a.appendChild(pic);

  const body = document.createElement("div");
  body.className = "shot__body";
  const ttl = document.createElement("div");
  ttl.className = "shot__title";
  ttl.dir = "auto"; // a Persian or Arabic title reads right to left
  ttl.textContent = nameOf(s); // XSS-safe: titles come from arbitrary pages
  body.appendChild(ttl);
  const meta = document.createElement("div");
  meta.className = "shot__meta";
  if (s.host) meta.appendChild(span("host", siteName(s.host)));
  const when = fmtWhen(s.ts);
  if (when) {
    const t = document.createElement("time");
    t.className = "when"; t.dateTime = new Date(s.ts).toISOString(); t.textContent = when;
    meta.appendChild(t);
  }
  body.appendChild(meta);
  const tags = document.createElement("div");
  tags.className = "shot__tags";
  const pair = L.langPair(s.source, s.target);
  if (pair) {
    const chip = span("chip", pair);
    const names = [langName(s.source), langName(s.target)].filter(Boolean);
    if (names.length) chip.title = names.join(" → ");
    tags.appendChild(chip);
  }
  tags.appendChild(span("chip", L.kindLabel(s.mode)));
  body.appendChild(tags);
  a.appendChild(body);
  c.appendChild(a);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "shot__del";
  del.appendChild(icon("icoTrash"));
  del.title = "Delete this shot";
  del.setAttribute("aria-label", "Delete “" + nameOf(s) + "”");
  del.addEventListener("click", () => askDelete(s));
  c.appendChild(del);
  return c;
}

// ── states ────────────────────────────────────────────────────────────────────
function showState(kind, head, lines, action) {
  const st = el("state");
  st.textContent = "";
  st.className = "state " + kind;
  const ico = document.createElement("div");
  ico.className = "state__ico";
  ico.appendChild(icon("icoShot"));
  st.appendChild(ico);
  const h = document.createElement("h2");
  h.textContent = head;
  st.appendChild(h);
  for (const line of lines) { const p = document.createElement("p"); p.textContent = line; st.appendChild(p); }
  if (action) st.appendChild(action);
  st.hidden = false;
}
function button(cls, text, onclick) {
  const b = document.createElement("button");
  b.type = "button"; b.className = cls; b.textContent = text; b.addEventListener("click", onclick);
  return b;
}
// The area shortcut as this browser has it (the user can change or remove
// it); ⌥⇧S is the manifest default when the commands API isn't there.
async function areaKey() {
  try {
    const cmds = await chrome.commands.getAll();
    const c = cmds.find((x) => x.name === "sv-shot-area");
    return c ? c.shortcut || "" : "⌥⇧S";
  } catch (e) { return "⌥⇧S"; }
}
async function showEmpty() {
  const key = await areaKey();
  if (all.length) return; // a shot arrived while the key was looked up
  showState("empty", "No shots yet", [
    "Open the SubVibe popup and pick Visible, Full page, Area or Element under “Screenshot this page, then translate”.",
    ...(key ? ["Or press " + key + " on any page and drag over the part you want."] : []),
    "Every shot you take is kept here.",
  ]);
}
function showError(e) {
  el("grid").textContent = ""; el("grid").removeAttribute("aria-busy");
  el("count").textContent = "";
  const why = e && e.name ? " (" + e.name + ")" : "";
  showState("error", "Couldn't read your shots", [
    "The browser's storage didn't answer" + why + ". Your shots are still there; try again.",
  ], button("btn-primary", "Try again", () => load()));
}

// ── filtering ─────────────────────────────────────────────────────────────────
function applyFilter() {
  let shown = 0;
  for (const { s, node } of cards.values()) {
    const on = (!site || s.host === site) && L.matches(s, query, langName);
    node.hidden = !on;
    if (on) shown++;
  }
  const n = all.length;
  el("count").textContent = !n ? "" : shown === n ? String(n) : shown + " of " + n;
  if (!n) { showEmpty(); return; }
  if (!shown) {
    const where = site ? " from " + siteName(site) : "";
    showState("nohits", query ? "No shots" + where + " match “" + query + "”" : "No shots" + where, [
      "Search looks at the title, the site, the link and the languages.",
    ], button("btn-secondary", site && query ? "Show all shots" : query ? "Clear search" : "Show all sites", () => {
      query = ""; el("search").value = ""; site = ""; renderSites(); applyFilter(); el("search").focus();
    }));
    return;
  }
  el("state").hidden = true;
}

// The most-used sites as a filter, like the Library's platforms.
function renderSites() {
  const top = L.hostCounts(all, 6);
  if (site && !all.some((s) => s.host === site)) site = ""; // its last shot was deleted
  if (site && !top.some(([h]) => h === site)) top.push(L.hostCounts(all).find(([h]) => h === site)); // the chosen site stays visible
  const wrap = el("sites");
  wrap.textContent = "";
  el("sitesBlock").hidden = top.length < 2;
  const item = (key, label, count) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pf" + (site === key ? " on" : "");
    b.setAttribute("aria-pressed", site === key ? "true" : "false");
    b.appendChild(span("pf-name", label));
    b.appendChild(span("pf-count", String(count)));
    b.addEventListener("click", () => { site = key; renderSites(); applyFilter(); });
    wrap.appendChild(b);
  };
  item("", "All sites", all.length);
  for (const [host, n] of top) item(host, siteName(host), n);
}

// ── load ──────────────────────────────────────────────────────────────────────
function build() {
  releaseAll();
  io.disconnect();
  cards.clear();
  const grid = el("grid");
  grid.textContent = "";
  grid.removeAttribute("aria-busy");
  const frag = document.createDocumentFragment();
  for (const s of all) { const node = card(s); cards.set(s.id, { s, node }); frag.appendChild(node); }
  grid.appendChild(frag);
  renderSites();
  applyFilter();
}
const signature = (list) => list.map((s) => s.id + "@" + s.ts).join("|");
// quiet: a re-check when the tab comes back; it only redraws when a shot was
// added or removed elsewhere, and a failed re-check keeps what's on screen.
async function load(quiet) {
  if (!quiet) { el("state").hidden = true; el("status").textContent = ""; el("count").textContent = "Loading…"; }
  let next;
  try { next = await readShots(); }
  catch (e) { console.warn("[SubVibe shots] read failed", e); if (!quiet) showError(e); return; }
  if (quiet && signature(next) === signature(all)) return;
  all = next; loaded = true;
  build();
}

// ── delete ────────────────────────────────────────────────────────────────────
let pending = null; // the shot the dialog is asking about
function askDelete(s) {
  pending = s;
  el("delName").textContent = "“" + nameOf(s) + "”";
  el("delMeta").textContent = [siteName(s.host), fmtWhen(s.ts), L.kindLabel(s.mode)].filter(Boolean).join(" · ");
  el("delDialog").returnValue = ""; // Escape keeps the last value; a stale "delete" must never carry over
  el("delDialog").showModal();
}
el("delDialog").addEventListener("close", async () => {
  const s = pending; pending = null;
  if (!s || el("delDialog").returnValue !== "delete") return;
  try { await deleteShot(s.id); }
  catch (e) { console.warn("[SubVibe shots] delete failed", e); el("status").textContent = "Couldn't delete “" + nameOf(s) + "”. Try again."; return; }
  const entry = cards.get(s.id);
  // Focus goes to the next card still shown (or the one before), else the search.
  const shownNodes = [...cards.values()].map((x) => x.node).filter((n) => !n.hidden);
  const at = entry ? shownNodes.indexOf(entry.node) : -1;
  const nextNode = at >= 0 ? shownNodes[at + 1] || shownNodes[at - 1] : null;
  if (entry) {
    const img = entry.node.querySelector("img");
    if (img) { io.unobserve(img); release(img); }
    entry.node.remove();
    cards.delete(s.id);
  }
  all = all.filter((x) => x.id !== s.id);
  el("status").textContent = "Deleted “" + nameOf(s) + "”.";
  renderSites();
  applyFilter();
  const target = nextNode && !nextNode.hidden ? nextNode.querySelector(".shot__open") : el("search");
  if (target) target.focus();
});

// ── events ────────────────────────────────────────────────────────────────────
el("search").addEventListener("input", () => { query = el("search").value.trim(); if (loaded) applyFilter(); });
// A shot taken in another tab shows up when this tab is looked at again.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && loaded) load(true); });
// Back from the editor via the browser's cache: the pictures were let go on
// pagehide and the shot may have been deleted there, so read again.
addEventListener("pageshow", (e) => { if (e.persisted && loaded) load(); });

load();
