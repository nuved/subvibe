// SubVibe Library — a full-tab view of every cached video, grouped by site or by
// date. Each card links to the original URL so the user can reopen it and replay
// the cached translation for free. Reads the same IndexedDB cache the overlay
// writes, via the background worker (CACHE_LIST / CACHE_DELETE / CACHE_CLEAR).

const el = (id) => document.getElementById(id);
const langMeta = window.svLangMeta;
const { audioRows, trackCues, download, safeName, exportSrt, exportAudio } = window.SV_EXPORT;

let repaired = false;

// Site → display chrome. Keys come from the adapter (adapter.site) or the cache
// key prefix. Order here is the order categories appear on the page.
const SITES = {
  youtube: { label: "YouTube", color: "#ff2d55" },
  netflix: { label: "Netflix", color: "#e50914" },
  prime: { label: "Prime Video", color: "#00a8e1" },
  zdf: { label: "ZDF", color: "#fa7d19" },
  dw: { label: "DW · Deutsche Welle", color: "#00a5ff" },
  udemy: { label: "Udemy", color: "#a435f0" },
};
const OTHER = { label: "Other", color: "#5b6678" };
const siteMeta = (s) => SITES[s] || OTHER;
const SITE_ORDER = [...Object.keys(SITES), "__other"];

let groupBy = "site"; // "site" | "date"
let siteFilter = "all"; // "all" | a SITES key | "__other" — the sidebar platform filter
let query = "";
let allGroups = [];
let logTotals = null; // running per-provider spend totals from the worker (survives the ring buffer)

// ── data ──────────────────────────────────────────────────────────────────────
function prettyBase(base) {
  // strip the "<site>:" prefix for a readable fallback label
  const i = base.indexOf(":");
  return i >= 0 ? base.slice(i + 1) : base;
}

function groupTracks(tracks) {
  const groups = new Map(); // base -> {base, site, title, url, createdAt, langs}
  for (const t of tracks) {
    if (!t || !t.key) continue;
    const m = /^(.*):auto:([^:]+)$/.exec(t.key);
    if (!m) continue;
    const base = m[1], target = t.target || m[2];
    let g = groups.get(base);
    if (!g) {
      const site = t.site || base.split(":")[0] || "__other";
      g = { base, site: SITES[site] ? site : (t.site || "__other"), title: "", url: "", createdAt: "", langs: new Map() };
      groups.set(base, g);
    }
    if (!g.title) g.title = window.SV_TITLE.clean(t.title || t.videoId || prettyBase(base));
    if (!g.url && t.url) g.url = t.url;
    if (t.createdAt && String(t.createdAt) > String(g.createdAt)) g.createdAt = t.createdAt;
    g.langs.set(target, { cueCount: t.cueCount || 0, totalCues: t.totalCues || 0 });
  }
  // newest first within any grouping
  return [...groups.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// Per-clip cost/calls from the on-device call log. Exact via row.base for new
// rows; cleaned-title match covers rows logged before base existed. The log is
// a 300-row ring buffer, so these figures mean "recent activity", not lifetime.
let logAgg = { byBase: new Map(), byTitle: new Map() };
async function loadLogAgg() {
  const res = await chrome.runtime.sendMessage({ type: "LOG_LIST" }).catch(() => null);
  logTotals = (res && res.totals) || null; // lifetime spend for the hero metric, not just the ring buffer
  const byBase = new Map(), byTitle = new Map();
  for (const c of ((res && res.calls) || [])) {
    const cost = window.SV_PRICING.estCost(c);
    const bump = (map, key) => {
      if (!key) return;
      const a = map.get(key) || { calls: 0, cost: 0 };
      a.calls++; a.cost += cost; map.set(key, a);
    };
    bump(byBase, c.base);
    bump(byTitle, window.SV_TITLE.clean(c.title || ""));
  }
  logAgg = { byBase, byTitle };
}

// ── filtering ──────────────────────────────────────────────────────────────────
function matches(g, q) {
  if (!q) return true;
  if ((g.title || "").toLowerCase().includes(q)) return true;
  if ((g.url || "").toLowerCase().includes(q)) return true;
  // match the platform too — "prime" / "youtube" / "netflix" filter by site,
  // even though the title/URL (e.g. an amazon.de movie page) don't contain it.
  if ((g.site || "").toLowerCase().includes(q) || (siteMeta(g.site).label || "").toLowerCase().includes(q)) return true;
  for (const target of g.langs.keys()) {
    const meta = langMeta(target);
    if (target.includes(q) || (meta[1] || "").toLowerCase().includes(q)) return true;
  }
  return false;
}

// ── date bucketing (browser Date is available here) ─────────────────────────────
function dateBucket(iso) {
  if (!iso) return { key: "zz-unknown", label: "Date unknown", order: 9 };
  const d = new Date(iso);
  if (isNaN(d)) return { key: "zz-unknown", label: "Date unknown", order: 9 };
  const now = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days <= 0) return { key: "0-today", label: "Today", order: 0 };
  if (days === 1) return { key: "1-yesterday", label: "Yesterday", order: 1 };
  if (days <= 7) return { key: "2-week", label: "Earlier this week", order: 2 };
  if (days <= 31) return { key: "3-month", label: "In the past month", order: 3 };
  return { key: "4-older", label: "Older", order: 4 };
}
function fmtWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
const fmtCost = (c) => (c >= 1 ? "$" + c.toFixed(2) : "$" + c.toFixed(4));
const localDayKey = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };

// ── rendering ───────────────────────────────────────────────────────────────────
function flag(target) {
  const fl = document.createElement("span");
  fl.className = "fl";
  fl.innerHTML = langMeta(target)[2]; // emoji or trusted inline SVG (constant)
  return fl;
}

// Inline SVG icons (Lucide-style, currentColor). The markup is constant, so
// assigning it via innerHTML is XSS-safe — the same pattern flag() already uses.
const SVG = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICONS = {
  activity: SVG('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  open: SVG('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  download: SVG('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
  audio: SVG('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
  trash: SVG('<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>'),
  x: SVG('<path d="M18 6 6 18"/><path d="M6 6l12 12"/>'),
};
// One icon action button. `label` (a language code) is appended as text, never
// interpolated into markup. `title` doubles as the accessible name.
function iconBtn(name, label, title, onclick, variant) {
  const b = document.createElement("button");
  b.className = "iconbtn" + (variant ? " " + variant : "");
  b.innerHTML = ICONS[name];
  if (label) b.appendChild(document.createTextNode(label));
  if (title) b.title = title;
  b.setAttribute("aria-label", title || label || name);
  if (onclick) b.onclick = onclick;
  return b;
}

function card(g) {
  const c = document.createElement("div");
  c.className = "card";
  c.style.setProperty("--spine", siteMeta(g.site).color); // platform-colored left spine

  const ttl = document.createElement("div");
  ttl.className = "card__title";
  ttl.textContent = g.title;         // XSS-safe: titles come from arbitrary pages
  ttl.title = g.url ? g.title + "\n" + g.url : g.title;
  if (g.url) ttl.onclick = () => chrome.tabs.create({ url: g.url });
  else ttl.classList.add("plain");
  c.appendChild(ttl);

  const langs = document.createElement("div");
  langs.className = "card__langs";
  for (const [target, stat] of g.langs) {
    const meta = langMeta(target);
    const chip = document.createElement("span");
    chip.className = "clang";
    chip.appendChild(flag(target));
    const nm = document.createElement("span");
    nm.textContent = meta[1];        // XSS-safe language name
    chip.appendChild(nm);
    const full = !stat.totalCues || stat.cueCount >= stat.totalCues * 0.95;
    const dot = document.createElement("span");
    dot.className = "dot " + (full ? "full" : "partial");
    dot.textContent = full ? "●" : "◐";
    chip.appendChild(dot);
    if (stat.totalCues) {
      const ct = document.createElement("span");
      ct.className = "ct";
      ct.textContent = full ? `${stat.totalCues}` : `${stat.cueCount}/${stat.totalCues}`;
      chip.appendChild(ct);
    }
    langs.appendChild(chip);
  }
  c.appendChild(langs);

  const agg = logAgg.byBase.get(g.base) || logAgg.byTitle.get(g.title);
  const stats = document.createElement("div");
  stats.className = "card__stats";
  if (agg) stats.textContent = `~${fmtCost(agg.cost)} · ${agg.calls} call${agg.calls === 1 ? "" : "s"}`;
  c.appendChild(stats);

  // date + platform — margin-top:auto on .card__meta pins this and the actions
  // to the bottom so every card's footer aligns regardless of language count.
  const meta = document.createElement("div");
  meta.className = "card__meta";
  const when = document.createElement("span");
  when.className = "when";
  when.textContent = fmtWhen(g.createdAt);
  meta.appendChild(when);
  const platform = document.createElement("span");
  platform.className = "platform";
  platform.textContent = siteMeta(g.site).label;
  meta.appendChild(platform);
  c.appendChild(meta);

  // action footer: Activity · Open · SRT (per language) · [dub] · Delete
  const act = document.createElement("div");
  act.className = "card__actions";
  act.appendChild(iconBtn("activity", "", "This video's API calls, tokens and cost", () => {
    actBase = g.base; actBaseTitle = g.title;
    el("actFilter").value = ""; actQuery = "";
    actMode = "clip"; // the jump is this video's summary — always land grouped
    el("actByClip").classList.add("on"); el("actAll").classList.remove("on");
    setView("activity");
  }));
  if (g.url) {
    act.appendChild(iconBtn("open", "Open", "Reopen this video — subtitles replay from cache, free",
      () => chrome.tabs.create({ url: g.url }), "primary"));
  }

  // flex spacer: srt/dub sit to its left, the quiet Delete to its right
  const grow = document.createElement("span");
  grow.className = "grow";

  for (const [target] of g.langs) {
    act.appendChild(iconBtn("download", target, "Download the translated subtitles (.srt)", () => exportSrt(g, target)));
    audioRows(`${g.base}:auto:${target}:dub:`).then((rows) => {
      if (!rows.length) return;
      const ms = rows.reduce((a, r) => a + (r.ms || 0), 0);
      if (ms) stats.textContent += (stats.textContent ? " · " : "") + `${Math.round(ms / 60000)} min dub audio`;
      // Play stays a text button so playDub can toggle ▶/⏸/… via textContent.
      const playBtn = document.createElement("button");
      playBtn.className = "iconbtn";
      playBtn.textContent = `▶ ${target}`;
      playBtn.title = `Play the stitched dub (~${Math.round(ms / 60000)} min cached)`;
      playBtn.onclick = () => playDub(g, target, playBtn);
      const audBtn = iconBtn("audio", "", "Download the dub as one audio file", () => exportAudio(g, target));
      const rmBtn = iconBtn("x", "", "Delete this language's dub audio (keeps the subtitles)", async () => {
        await chrome.runtime.sendMessage({ type: "AUDIO_DELETE", prefix: `${g.base}:auto:${target}:dub:` }).catch(() => null);
        refresh();
      }, "quiet");
      act.insertBefore(playBtn, grow);
      act.insertBefore(audBtn, grow);
      act.insertBefore(rmBtn, grow);
    });
  }

  act.appendChild(grow);
  act.appendChild(iconBtn("trash", "", "Remove this video's cached subtitles", async () => {
    await chrome.runtime.sendMessage({ type: "CACHE_DELETE", prefix: g.base }).catch(() => null);
    refresh();
  }, "danger"));
  c.appendChild(act);
  return c;
}

// One preview at a time; a sequence counter invalidates any in-flight stitch
// when a new press (or a refresh) supersedes it, so a slow stitch can never
// resurrect a stopped preview or leak its object URL. The blob is stitched
// fresh per press (a long video takes a few seconds — acceptable v1; the
// button shows … while stitching).
let dubPreview = null; // { el, url, btn }
let previewSeq = 0;    // bumped on every stop/press — stale stitches see a mismatch and bail

function stopDubPreview() {
  previewSeq++;
  if (!dubPreview) return;
  dubPreview.el.pause();
  URL.revokeObjectURL(dubPreview.url);
  dubPreview.btn.textContent = dubPreview.btn.textContent.replace("⏸", "▶");
  dubPreview = null;
}

async function playDub(g, target, btn) {
  if (btn.textContent === "…") return; // already stitching this one — ignore the extra click
  const wasMine = dubPreview && dubPreview.btn === btn;
  stopDubPreview();
  if (wasMine) return; // same button = toggle off
  const seq = ++previewSeq;
  const old = btn.textContent;
  btn.textContent = "…";
  const out = await window.SV_EXPORT.stitchDubBlob(g, target, { interactive: false });
  if (seq !== previewSeq) { btn.textContent = old; return; } // superseded while stitching — nothing was created yet
  if (!out) { btn.textContent = old; return alert("No dub audio cached for this language yet."); }
  const url = URL.createObjectURL(out.blob);
  const el = new Audio(url);
  dubPreview = { el, url, btn };
  btn.textContent = old.replace("▶", "⏸");
  el.onended = () => {
    if (dubPreview && dubPreview.el === el) { URL.revokeObjectURL(url); btn.textContent = old; dubPreview = null; }
  };
  el.play();
}

function groupHead(badgeText, badgeColor, title, count) {
  const head = document.createElement("div");
  head.className = "ghead";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.style.background = badgeColor;
  badge.textContent = badgeText;
  head.appendChild(badge);
  const h2 = document.createElement("h2");
  h2.textContent = title;
  head.appendChild(h2);
  const cnt = document.createElement("span");
  cnt.className = "cnt";
  cnt.textContent = count === 1 ? "1 video" : count + " videos";
  head.appendChild(cnt);
  const rule = document.createElement("span");
  rule.className = "rule";
  head.appendChild(rule);
  return head;
}

function section(headEl, items) {
  const sec = document.createElement("section");
  sec.className = "group";
  sec.appendChild(headEl);
  const grid = document.createElement("div");
  grid.className = "grid";
  for (const g of items) grid.appendChild(card(g));
  sec.appendChild(grid);
  return sec;
}

function badgeFor(site) {
  const m = siteMeta(site);
  const txt = site === "youtube" ? "YT" : site === "netflix" ? "N" : site === "prime" ? "PV"
    : site === "zdf" ? "ZDF" : site === "dw" ? "DW" : site === "udemy" ? "U" : "•";
  return { txt, color: m.color, label: m.label };
}

// ── sidebar platform filter + hero metrics ──────────────────────────────────────
function siteKey(g) { return SITES[g.site] ? g.site : "__other"; }
function platformCounts() {
  const counts = new Map();
  for (const g of allGroups) counts.set(siteKey(g), (counts.get(siteKey(g)) || 0) + 1);
  return counts;
}
function renderPlatformNav() {
  const nav = el("platformNav");
  const counts = platformCounts();
  if (siteFilter !== "all" && !counts.get(siteFilter)) siteFilter = "all"; // filtered platform emptied out
  nav.innerHTML = "";
  const item = (key, label, color, count) => {
    const b = document.createElement("button");
    b.className = "pf" + (siteFilter === key ? " on" : "");
    b.setAttribute("aria-pressed", siteFilter === key ? "true" : "false");
    const sw = document.createElement("span"); sw.className = "swatch"; sw.style.background = color;
    const nm = document.createElement("span"); nm.className = "pf-name"; nm.textContent = label;
    const ct = document.createElement("span"); ct.className = "pf-count"; ct.textContent = String(count);
    b.appendChild(sw); b.appendChild(nm); b.appendChild(ct);
    b.onclick = () => { siteFilter = key; renderPlatformNav(); render(); };
    nav.appendChild(b);
  };
  item("all", "All platforms", "#6366F1", allGroups.length);
  for (const site of SITE_ORDER) {
    const n = counts.get(site) || 0;
    if (!n) continue;
    const m = site === "__other" ? OTHER : siteMeta(site);
    item(site, m.label, m.color, n);
  }
}

function totalSpend() {
  if (logTotals) {
    let sum = 0;
    for (const p of Object.keys(logTotals)) sum += (logTotals[p] && logTotals[p].all) || 0;
    return sum;
  }
  let sum = 0; // fallback: sum the ring-buffer rows we do have
  for (const a of logAgg.byBase.values()) sum += a.cost || 0;
  return sum;
}
function metricCard(label, value, unit, sub, accent) {
  const d = document.createElement("div"); d.className = "metric";
  if (accent) d.style.setProperty("--accent", accent);
  const l = document.createElement("div"); l.className = "metric__label"; l.textContent = label;
  const v = document.createElement("div"); v.className = "metric__value"; v.textContent = value;
  if (unit) { const s = document.createElement("small"); s.textContent = " " + unit; v.appendChild(s); }
  d.appendChild(l); d.appendChild(v);
  if (sub) { const su = document.createElement("div"); su.className = "metric__sub"; su.textContent = sub; d.appendChild(su); }
  return d;
}
function renderLibStats() {
  const wrap = el("libStats");
  wrap.innerHTML = "";
  if (!allGroups.length) return; // hero hides on the empty state — nothing to celebrate yet
  const platforms = platformCounts().size;
  const tracks = allGroups.reduce((a, g) => a + g.langs.size, 0);
  wrap.appendChild(metricCard("Videos translated", String(allGroups.length), "", "cached for free replay", "#6366F1"));
  wrap.appendChild(metricCard("Cached translations", String(tracks), tracks === 1 ? "track" : "tracks", "replay without re-charge", "#34D399"));
  wrap.appendChild(metricCard("Active platforms", String(platforms), platforms === 1 ? "site" : "sites", "", "#F59E0B"));
  wrap.appendChild(metricCard("Est. spent", "~" + fmtCost(totalSpend()), "", "one-time · replays are free", "#818CF8"));
}

function render() {
  stopDubPreview();
  const content = el("content");
  content.innerHTML = "";
  const visible = allGroups.filter((g) => matches(g, query) &&
    (siteFilter === "all" || siteKey(g) === siteFilter));

  if (!allGroups.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.innerHTML = '<div class="big">🍿</div>';
    const p1 = document.createElement("p");
    p1.style.fontSize = "16px";
    p1.style.color = "#cdd6e3";
    p1.textContent = "No cached videos yet.";
    const p2 = document.createElement("p");
    p2.textContent = "Play a video on YouTube, Netflix, Prime Video, ZDF or DW — SubVibe translates ahead and saves it here for free replay.";
    e.appendChild(p1); e.appendChild(p2);
    content.appendChild(e);
    return;
  }
  if (!visible.length) {
    const e = document.createElement("div");
    e.className = "empty";
    const p = document.createElement("p");
    const plat = siteFilter !== "all" ? (siteFilter === "__other" ? OTHER.label : siteMeta(siteFilter).label) : "";
    p.textContent = query ? "No videos match “" + query + "”" + (plat ? " in " + plat : "") + "."
      : plat ? "No videos from " + plat + " yet." : "No videos match your filters.";
    e.appendChild(p);
    content.appendChild(e);
    return;
  }

  if (groupBy === "site") {
    for (const site of SITE_ORDER) {
      const items = visible.filter((g) => (SITES[g.site] ? g.site : "__other") === site);
      if (!items.length) continue;
      const b = badgeFor(site === "__other" ? "__other" : site);
      content.appendChild(section(groupHead(b.txt, b.color, b.label, items.length), items));
    }
  } else {
    const buckets = new Map();
    for (const g of visible) {
      const bk = dateBucket(g.createdAt);
      if (!buckets.has(bk.key)) buckets.set(bk.key, { label: bk.label, order: bk.order, items: [] });
      buckets.get(bk.key).items.push(g);
    }
    const ordered = [...buckets.values()].sort((a, b) => a.order - b.order);
    for (const bk of ordered) {
      content.appendChild(section(groupHead("📅", "#2a3340", bk.label, bk.items.length), bk.items));
    }
  }
}

// ── load + events ───────────────────────────────────────────────────────────────
async function refresh() {
  if (!repaired) {
    repaired = true;
    await chrome.runtime.sendMessage({ type: "REPAIR_LABELS" }).catch(() => null);
  }
  const res = await chrome.runtime.sendMessage({ type: "CACHE_LIST" }).catch(() => null);
  allGroups = groupTracks((res && res.tracks) || []);
  titleByBase = new Map(allGroups.map((g) => [g.base, g.title])); // names Activity rows whose call lacked a title (streaming path, legacy)
  await loadLogAgg();
  const n = allGroups.length;
  el("note").textContent = n
    ? `${n} video${n === 1 ? "" : "s"} cached · stored only on this device. Reopening any of them costs nothing.`
    : "";
  renderPlatformNav();
  renderLibStats();
  render();
}

el("search").addEventListener("input", () => { query = el("search").value.trim().toLowerCase(); render(); });
function setGroup(by) {
  groupBy = by;
  el("bySite").classList.toggle("on", by === "site");
  el("byDate").classList.toggle("on", by === "date");
  render();
}
el("bySite").addEventListener("click", () => setGroup("site"));
el("byDate").addEventListener("click", () => setGroup("date"));
el("clearAll").addEventListener("click", async () => {
  if (!allGroups.length) return;
  if (!confirm("Delete ALL cached subtitles for every video? This cannot be undone.")) return;
  await chrome.runtime.sendMessage({ type: "CACHE_CLEAR" }).catch(() => null);
  refresh();
});

// ── Activity tab: a local, on-device log of every provider call ────────────────
// Pricing constants + estCost live in shared/pricing.js (SV_PRICING) — shared
// with the popup's spend line so both compute identical totals from one source.
const estCost = window.SV_PRICING.estCost;
let actQuery = "";
let actMode = "clip";     // "clip" (grouped per video) | "flat" (every call, scroll-loaded)
let actBase = null, actBaseTitle = ""; // set by a card's Activity button — shows one video only
let actObserver = null;   // flat mode's scroll autoloader
let titleByBase = new Map();
const providerLabel = (p) => (p === "claude" ? "Claude" : p === "gemini" ? "Gemini" : "OpenAI");
// Best available name for a call row: its own title, else the cached video's
// title via base (streaming-path rows carry no title), else site, else base.
function rowName(c) {
  return window.SV_TITLE.clean(c.title || "") || (c.base && titleByBase.get(c.base)) ||
    (c.site ? siteMeta(c.site).label : "") || (c.base ? prettyBase(c.base) : "") || "—";
}
function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + hm;
}
function statCard(k, main, sub, cls) {
  const d = document.createElement("div"); d.className = "stat" + (cls ? " " + cls : "");
  const a = document.createElement("div"); a.className = "k"; a.textContent = k;
  const b = document.createElement("div"); b.className = "v"; b.textContent = main;
  if (sub) { const s = document.createElement("small"); s.textContent = " " + sub; b.appendChild(s); }
  d.appendChild(a); d.appendChild(b); return d;
}
async function loadActivity() {
  const res = await chrome.runtime.sendMessage({ type: "LOG_LIST" }).catch(() => null);
  const calls = (res && res.calls) || [];
  const q = actQuery;
  let shown = !actBase ? calls : calls.filter((c) => c.base === actBase || (!c.base && rowName(c) === actBaseTitle));
  if (q) shown = shown.filter((c) =>
    (rowName(c) + " " + (c.site || "") + " " + (c.target || "") + " " + providerLabel(c.provider)).toLowerCase().includes(q) ||
    (langMeta(c.target || "")[1] || "").toLowerCase().includes(q));
  el("actChip").classList.toggle("on", !!actBase);
  if (actBase) el("actChipTitle").textContent = actBaseTitle || prettyBase(actBase);
  let inTok = 0, outTok = 0, ms = 0, ok = 0, fail = 0, lines = 0, ttsMs = 0;
  // costByProvider tracks all-time/today split per provider so the stat cards can
  // show one "Est. cost" card normally, or several (OpenAI / Claude / Gemini)
  // once a user has called more than one — most people will only ever see one
  // card. Translation providers (openai/claude) and the TTS provider
  // (openai/gemini) are independent axes — e.g. Claude translation + Gemini
  // dub both log here, each under their own key, and OpenAI is shared as the
  // default for BOTH axes so it nets out correctly either way.
  const costByProvider = { openai: { all: 0, today: 0 }, claude: { all: 0, today: 0 }, gemini: { all: 0, today: 0 } };
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0); const t0 = startToday.getTime();
  for (const c of shown) {
    inTok += c.inTok || 0; outTok += c.outTok || 0; ms += c.ms || 0; lines += c.lines || 0;
    if (c.kind === "tts") ttsMs += c.durMs || 0;
    if (c.ok) ok++; else fail++;
    const p = costByProvider[c.provider] ? c.provider : "openai";
    const cost = estCost(c);
    costByProvider[p].all += cost;
    if ((c.ts || 0) >= t0) costByProvider[p].today += cost;
  }
  const avgMs = shown.length ? Math.round(ms / shown.length) : 0;
  const providersUsed = Object.keys(costByProvider).filter((p) => costByProvider[p].all > 0 || costByProvider[p].today > 0);
  const bothPresent = providersUsed.length > 1;

  const stats = el("actStats"); stats.innerHTML = "";
  stats.appendChild(statCard("Calls", String(shown.length), fail ? `· ${fail} failed` : ""));
  if (q) stats.appendChild(statCard("Filtered", shown.length + "/" + calls.length + " calls"));
  stats.appendChild(statCard("Lines translated", lines.toLocaleString()));
  if (ttsMs) stats.appendChild(statCard("Dub audio spoken", Math.round(ttsMs / 60000) + " min"));
  stats.appendChild(statCard("Tokens (in · out)", inTok.toLocaleString() + " · " + outTok.toLocaleString(), "logged calls only"));
  // Cost cards: the ring buffer forgets old rows, so summing visible rows once
  // read "$1.20 all-time" while the provider console said ~$14. The worker now
  // keeps RUNNING totals per provider (spendTotals) — use those for the
  // unfiltered view; a filtered view honestly sums just the rows it shows.
  const totals = (res && res.totals) || null;
  const filteredView = !!q || !!actBase;
  const totProvs = totals ? Object.keys(totals).filter((p) => totals[p] && totals[p].all > 0) : [];
  if (!filteredView && totProvs.length) {
    const dk = localDayKey();
    if (totProvs.length > 1) {
      for (const p of totProvs) {
        stats.appendChild(statCard(`Est. cost · ${providerLabel(p)}`, "~" + fmtCost(totals[p].all), "all-time", "cost"));
        stats.appendChild(statCard(`Est. cost · ${providerLabel(p)} today`, "~" + fmtCost((totals[p].days || {})[dk] || 0), "", "cost"));
      }
    } else {
      const p = totProvs[0];
      stats.appendChild(statCard("Est. cost · all-time", "~" + fmtCost(totals[p].all), providerLabel(p), "cost"));
      stats.appendChild(statCard("Est. cost · today", "~" + fmtCost((totals[p].days || {})[dk] || 0), "", "cost"));
    }
  } else if (bothPresent) {
    for (const p of providersUsed) {
      stats.appendChild(statCard(`Est. cost · ${providerLabel(p)}`, "~" + fmtCost(costByProvider[p].all), filteredView ? "shown calls" : "logged calls", "cost"));
      stats.appendChild(statCard(`Est. cost · ${providerLabel(p)} today`, "~" + fmtCost(costByProvider[p].today), "", "cost"));
    }
  } else {
    const costAll = costByProvider.openai.all + costByProvider.claude.all + costByProvider.gemini.all;
    const costToday = costByProvider.openai.today + costByProvider.claude.today + costByProvider.gemini.today;
    stats.appendChild(statCard("Est. cost", "~" + fmtCost(costAll), filteredView ? "shown calls" : "logged calls", "cost"));
    stats.appendChild(statCard("Est. cost · today", "~" + fmtCost(costToday), "", "cost"));
  }
  stats.appendChild(statCard("Avg response", avgMs + " ms"));

  // One call = one row. In "By video" mode rows live inside a collapsible group
  // per clip (rows are built lazily on first expand); "All calls" renders a flat
  // list that autoloads more as you scroll — the whole ring buffer is reachable.
  function rowEl(c) {
    const frag = document.createDocumentFragment();
    const row = document.createElement("div"); row.className = "callrow";
    if (c.cacheR || c.cacheW) row.title = `prompt cache: ${(c.cacheR || 0).toLocaleString()} read (~10% price) · ${(c.cacheW || 0).toLocaleString()} written`;
    const t = document.createElement("span"); t.className = "ct"; t.textContent = fmtTime(c.ts);
    const s = document.createElement("span"); s.className = "cs";
    s.textContent = rowName(c) + (c.target ? " → " + langMeta(c.target)[1] : "");
    s.title = s.textContent;
    const pv = document.createElement("span"); pv.className = "cprov"; pv.textContent = providerLabel(c.provider);
    const ln = document.createElement("span"); ln.textContent = c.kind === "tts" ? "🎙 " + Math.round((c.durMs || 0) / 1000) + "s" : (c.lines || 0) + " ln";
    const tk = document.createElement("span"); tk.className = "ctok";
    tk.textContent = c.kind === "tts" ? (c.chars || 0) + " ch" : (c.inTok || 0) + "→" + (c.outTok || 0);
    const mv = document.createElement("span"); mv.className = "cms"; mv.textContent = (c.ms || 0) + "ms";
    const cost = document.createElement("span"); cost.className = "ccost"; cost.textContent = "~" + fmtCost(estCost(c));
    const st = document.createElement("span"); st.className = "cok " + (c.ok ? "ok" : "err"); st.textContent = c.ok ? "✓" : "✗";
    [t, s, pv, ln, tk, mv, cost, st].forEach((e) => row.appendChild(e));
    frag.appendChild(row);
    if (!c.ok && c.err) { const e = document.createElement("div"); e.className = "cerrline"; e.textContent = c.err; frag.appendChild(e); }
    return frag;
  }
  function headEl() {
    const h = document.createElement("div"); h.className = "callhead";
    const cols = [["Time"], ["Video → language"], ["Engine"], ["Work"], ["Tokens in→out", "ctok"], ["Took", "cms"], ["~Cost", "ccost"], [""]];
    for (const [label, cls] of cols) { const s = document.createElement("span"); if (cls) s.className = cls; s.textContent = label; h.appendChild(s); }
    return h;
  }

  const list = el("actList"); list.innerHTML = "";
  if (actObserver) { actObserver.disconnect(); actObserver = null; }
  const newestFirst = shown.slice().reverse();

  if (actMode === "clip") {
    // key by base; legacy/title-only rows join the base group with the same name
    const nameKey = new Map();
    for (const c of newestFirst) if (c.base && !nameKey.has(rowName(c))) nameKey.set(rowName(c), c.base);
    const groups = new Map();
    for (const c of newestFirst) {
      const nm = rowName(c);
      const key = c.base || nameKey.get(nm) || ("t:" + nm);
      let g = groups.get(key);
      if (!g) { g = { name: nm, rows: [], lines: 0, ttsMs: 0, cost: 0, fails: 0, last: 0 }; groups.set(key, g); }
      if (g.name === "—" && nm !== "—") g.name = nm;
      g.rows.push(c); g.lines += c.lines || 0; if (c.kind === "tts") g.ttsMs += c.durMs || 0;
      g.cost += estCost(c); if (!c.ok) g.fails++; g.last = Math.max(g.last, c.ts || 0);
    }
    const ordered = [...groups.values()].sort((a, b) => b.last - a.last);
    for (const g of ordered) {
      const det = document.createElement("details"); det.className = "cgroup";
      const sum = document.createElement("summary");
      const gt = document.createElement("span"); gt.className = "gt"; gt.textContent = g.name; gt.title = g.name;
      sum.appendChild(gt);
      const add = (txt, cls) => { const s = document.createElement("span"); s.className = "gs" + (cls ? " " + cls : ""); s.textContent = txt; sum.appendChild(s); };
      add(g.rows.length + " call" + (g.rows.length === 1 ? "" : "s"));
      if (g.lines) add(g.lines + " ln");
      if (g.ttsMs) add("🎙 " + Math.round(g.ttsMs / 1000) + "s");
      if (g.fails) add(g.fails + " failed", "gfail");
      add("~" + fmtCost(g.cost), "gcost");
      add(fmtTime(g.last));
      const body = document.createElement("div"); body.className = "gbody";
      let filled = false;
      det.addEventListener("toggle", () => {
        if (!det.open || filled) return;
        filled = true;
        body.appendChild(headEl());
        for (const c of g.rows) body.appendChild(rowEl(c));
      });
      det.appendChild(sum); det.appendChild(body);
      list.appendChild(det);
    }
    if (ordered.length === 1) { const d = list.querySelector("details"); if (d) d.open = true; }
    el("actListTitle").textContent = `Calls · ${ordered.length} video${ordered.length === 1 ? "" : "s"} · ${shown.length} call${shown.length === 1 ? "" : "s"}`;
  } else {
    list.appendChild(headEl());
    let rendered = 0;
    const STEP = 150;
    const renderMore = () => {
      const slice = newestFirst.slice(rendered, rendered + STEP);
      for (const c of slice) list.appendChild(rowEl(c));
      rendered += slice.length;
      el("actListTitle").textContent = rendered < newestFirst.length
        ? `Calls · showing ${rendered} of ${newestFirst.length} — scroll for more`
        : `Calls · all ${newestFirst.length}`;
      if (rendered >= newestFirst.length && actObserver) { actObserver.disconnect(); actObserver = null; }
    };
    renderMore();
    if (rendered < newestFirst.length) {
      actObserver = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) renderMore(); });
      actObserver.observe(el("actMore"));
    }
  }
}
el("actByClip").addEventListener("click", () => {
  actMode = "clip"; el("actByClip").classList.add("on"); el("actAll").classList.remove("on"); loadActivity();
});
el("actAll").addEventListener("click", () => {
  actMode = "flat"; el("actAll").classList.add("on"); el("actByClip").classList.remove("on"); loadActivity();
});
el("actChipClear").addEventListener("click", () => { actBase = null; actBaseTitle = ""; loadActivity(); });
el("actFilter").addEventListener("input", () => { actQuery = el("actFilter").value.trim().toLowerCase(); loadActivity(); });
el("clearLog").addEventListener("click", async () => {
  if (!confirm("Clear the API activity log? (This does not affect cached subtitles.)")) return;
  await chrome.runtime.sendMessage({ type: "LOG_CLEAR" }).catch(() => null);
  loadActivity();
});

// ── view switch ────────────────────────────────────────────────────────────────
function setView(v) {
  const vids = v === "videos";
  el("viewVideos").hidden = !vids;
  el("viewActivity").hidden = vids;
  el("tabVideos").classList.toggle("on", vids);
  el("tabActivity").classList.toggle("on", !vids);
  el("videosNav").hidden = !vids;                       // sidebar search/platforms/group-by are library-only
  el("clearAll").style.display = vids ? "" : "none";    // "Clear library" is a library action
  if (!vids) loadActivity();
}
el("tabVideos").addEventListener("click", () => setView("videos"));
el("tabActivity").addEventListener("click", () => setView("activity"));

refresh();
