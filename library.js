// SubVibe Library — a full-tab view of every cached video, grouped by site or by
// date. Each card links to the original URL so the user can reopen it and replay
// the cached translation for free. Reads the same IndexedDB cache the overlay
// writes, via the background worker (CACHE_LIST / CACHE_DELETE / CACHE_CLEAR).

const el = (id) => document.getElementById(id);
const langMeta = window.svLangMeta;

// ── dub audio: read the worker's IndexedDB directly (same extension origin;
// bulk audio through base64 messaging would be silly). Writes stay in the worker.
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("copilot-subs");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function audioRows(prefix) {
  const d = await openDb();
  if (!d.objectStoreNames.contains("audio")) { d.close(); return []; }
  return new Promise((resolve) => {
    const out = [];
    d.transaction("audio").objectStore("audio").openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c) { d.close(); return resolve(out); }
      if (typeof c.key === "string" && c.key.startsWith(prefix)) out.push({ key: c.key, ...c.value });
      c.continue();
    };
  });
}
async function trackCues(key) {
  const d = await openDb();
  return new Promise((resolve) => {
    const r = d.transaction("tracks").objectStore("tracks").get(key);
    r.onsuccess = () => { d.close(); resolve((r.result && r.result.cues) || []); };
    r.onerror = () => { d.close(); resolve([]); };
  });
}
function download(name, blobParts, mime) {
  const url = URL.createObjectURL(new Blob(blobParts, { type: mime }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
const safeName = (s) => (s || "subvibe").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80);

async function exportSrt(g, target) {
  const cues = await trackCues(`${g.base}:auto:${target}`);
  if (!cues.length) return alert("Nothing cached for this language yet.");
  download(`${safeName(g.title)} — ${target}.srt`, [window.SV_SRT.cuesToSrt(cues)], "text/plain;charset=utf-8");
}

// Stitch every cached clip at its timestamp into ONE audio file.
// Ogg/Opus via WebCodecs where available, else WAV (audit forbids an MP3 lib).
async function exportAudio(g, target) {
  const rows = await audioRows(`${g.base}:auto:${target}:dub:`);
  if (!rows.length) return alert("No dub audio cached for this language yet.");
  // Several voice configs may exist — export the one with the most clips.
  const byCfg = new Map();
  for (const r of rows) {
    const cfg = r.key.slice(0, r.key.lastIndexOf("#"));
    if (!byCfg.has(cfg)) byCfg.set(cfg, []);
    byCfg.get(cfg).push(r);
  }
  const clips = [...byCfg.values()].sort((a, b) => b.length - a.length)[0];
  const cues = await trackCues(`${g.base}:auto:${target}`);
  // Spec: warn on gaps — an incomplete dub exports with silent holes.
  const speechMs = clips.reduce((a, r) => a + (r.ms || 0), 0);
  const trackMs = cues.length ? (cues[cues.length - 1].endMs || cues[cues.length - 1].startMs) : 0;
  const pct = trackMs ? Math.min(100, Math.round((speechMs / trackMs) * 100)) : 100;
  if (pct < 60 && !confirm(`Only ~${pct}% of this video has dub audio cached — the export will have silent gaps. ` +
    `Tip: open the video and click "Generate full dub" in the popup first. Export anyway?`)) return;
  const lastMs = Math.max(...clips.map((r) => +r.key.slice(r.key.lastIndexOf("#") + 1) + (r.ms || 3000)),
    cues.length ? (cues[cues.length - 1].endMs || 0) : 0);
  const haveEncoder = typeof AudioEncoder !== "undefined";
  const rate = haveEncoder ? 48000 : 24000;
  const decodeCtx = new AudioContext();
  const off = new OfflineAudioContext(1, Math.ceil(((lastMs + 1000) / 1000) * rate), rate);
  for (const r of clips) {
    const startMs = +r.key.slice(r.key.lastIndexOf("#") + 1);
    const bin = atob(r.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    try {
      const buf = await decodeCtx.decodeAudioData(bytes.buffer);
      const src = off.createBufferSource();
      src.buffer = buf;
      src.connect(off.destination);
      src.start(startMs / 1000);
    } catch {} // one undecodable clip must not sink the export
  }
  decodeCtx.close();
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0);
  const base = `${safeName(g.title)} — ${target} dub`;
  if (!haveEncoder) return download(`${base}.wav`, [window.SV_AUDIO_EXPORT.wavFromPcm(pcm, rate)], "audio/wav");
  const packets = [];
  const enc = new AudioEncoder({
    output: (chunk) => { const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); packets.push({ data: d, samples: chunk.duration ? Math.round((chunk.duration / 1e6) * 48000) : 960 }); },
    error: (e) => console.warn("[SubVibe] opus encode:", e),
  });
  enc.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1, bitrate: 48000 });
  const FRAME = 48000; // 1s of samples per AudioData; the encoder splits into 20ms packets
  for (let i = 0; i < pcm.length; i += FRAME) {
    const slice = pcm.subarray(i, Math.min(i + FRAME, pcm.length));
    enc.encode(new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: slice.length, numberOfChannels: 1, timestamp: Math.round((i / 48000) * 1e6), data: slice }));
  }
  await enc.flush();
  enc.close();
  download(`${base}.ogg`, window.SV_AUDIO_EXPORT.oggFromOpusPackets(packets, { preSkip: 312 }), "audio/ogg");
}

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
let query = "";
let allGroups = [];

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
    if (!g.title) g.title = t.title || t.videoId || prettyBase(base);
    if (!g.url && t.url) g.url = t.url;
    if (t.createdAt && String(t.createdAt) > String(g.createdAt)) g.createdAt = t.createdAt;
    g.langs.set(target, { cueCount: t.cueCount || 0, totalCues: t.totalCues || 0 });
  }
  // newest first within any grouping
  return [...groups.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
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

// ── rendering ───────────────────────────────────────────────────────────────────
function flag(target) {
  const fl = document.createElement("span");
  fl.className = "fl";
  fl.innerHTML = langMeta(target)[2]; // emoji or trusted inline SVG (constant)
  return fl;
}

function card(g) {
  const c = document.createElement("div");
  c.className = "card";

  const top = document.createElement("div");
  top.className = "top";
  const sdot = document.createElement("span");
  sdot.className = "sdot";
  sdot.style.background = siteMeta(g.site).color;
  top.appendChild(sdot);
  const wrap = document.createElement("div");
  wrap.style.minWidth = "0";
  wrap.style.flex = "1";
  const ttl = document.createElement("div");
  ttl.className = "ttl";
  ttl.textContent = g.title;       // XSS-safe: titles come from arbitrary pages
  ttl.title = g.title;
  if (g.url) ttl.onclick = () => chrome.tabs.create({ url: g.url });
  else ttl.style.cursor = "default";
  wrap.appendChild(ttl);
  if (g.url) {
    const url = document.createElement("div");
    url.className = "url";
    url.textContent = g.url;        // XSS-safe
    url.title = g.url;
    url.onclick = () => chrome.tabs.create({ url: g.url });
    wrap.appendChild(url);
  }
  top.appendChild(wrap);
  c.appendChild(top);

  const langs = document.createElement("div");
  langs.className = "langs";
  for (const [target, stat] of g.langs) {
    const meta = langMeta(target);
    const chip = document.createElement("span");
    chip.className = "clang";
    chip.appendChild(flag(target));
    const nm = document.createElement("span");
    nm.textContent = meta[1];       // XSS-safe language name
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

  const foot = document.createElement("div");
  foot.className = "foot";
  const when = document.createElement("span");
  when.className = "when";
  when.textContent = fmtWhen(g.createdAt);
  foot.appendChild(when);
  if (g.url) {
    const open = document.createElement("button");
    open.className = "mini open";
    open.textContent = "Open ▶";
    open.title = "Reopen this video — subtitles replay from cache, free";
    open.onclick = () => chrome.tabs.create({ url: g.url });
    foot.appendChild(open);
  }
  const del = document.createElement("button");
  del.className = "mini del";
  del.textContent = "Delete";
  del.title = "Remove this video's cached subtitles";
  del.onclick = async () => {
    await chrome.runtime.sendMessage({ type: "CACHE_DELETE", prefix: g.base }).catch(() => null);
    refresh();
  };
  foot.appendChild(del);
  c.appendChild(foot);

  // Per-language export row: subtitles always; audio when dub clips exist.
  const exp = document.createElement("div");
  exp.className = "foot";
  for (const [target] of g.langs) {
    const srtBtn = document.createElement("button");
    srtBtn.className = "mini";
    srtBtn.textContent = "⬇ srt · " + target;
    srtBtn.title = "Download the translated subtitles (.srt)";
    srtBtn.onclick = () => exportSrt(g, target);
    exp.appendChild(srtBtn);
    audioRows(`${g.base}:auto:${target}:dub:`).then((rows) => {
      if (!rows.length) return;
      const ms = rows.reduce((a, r) => a + (r.ms || 0), 0);
      const audBtn = document.createElement("button");
      audBtn.className = "mini";
      audBtn.textContent = "⬇ audio · " + target;
      audBtn.title = `Download the dub as one audio file (~${Math.round(ms / 60000)} min of speech cached)`;
      audBtn.onclick = () => exportAudio(g, target);
      exp.appendChild(audBtn);
      const rmBtn = document.createElement("button");
      rmBtn.className = "mini del";
      rmBtn.textContent = "✕ audio";
      rmBtn.title = "Delete this language's dub audio (keeps the subtitles)";
      rmBtn.onclick = async () => {
        await chrome.runtime.sendMessage({ type: "AUDIO_DELETE", prefix: `${g.base}:auto:${target}:dub:` }).catch(() => null);
        refresh();
      };
      exp.appendChild(rmBtn);
    });
  }
  c.appendChild(exp);
  return c;
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

function render() {
  const content = el("content");
  content.innerHTML = "";
  const visible = allGroups.filter((g) => matches(g, query));

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
    p.textContent = "No videos match “" + query + "”.";
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
  const res = await chrome.runtime.sendMessage({ type: "CACHE_LIST" }).catch(() => null);
  allGroups = groupTracks((res && res.tracks) || []);
  const n = allGroups.length;
  el("note").textContent = n
    ? `${n} video${n === 1 ? "" : "s"} cached · stored only on this device. Reopening any of them costs nothing.`
    : "";
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

// ── Activity tab: a local, on-device log of every OpenAI call ──────────────────
const PRICE_IN = 0.15 / 1e6, PRICE_OUT = 0.60 / 1e6; // gpt-4o-mini, USD per token
let actQuery = "";
const estCost = (c) => c && c.kind === "tts"
  ? ((c.durMs || 0) / 60000) * 0.015
  : ((c && c.inTok) || 0) * PRICE_IN + ((c && c.outTok) || 0) * PRICE_OUT;
const fmtCost = (c) => (c >= 1 ? "$" + c.toFixed(2) : "$" + c.toFixed(4));
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
  const shown = !q ? calls : calls.filter((c) =>
    ((c.title || "") + " " + (c.site || "") + " " + (c.target || "")).toLowerCase().includes(q) ||
    (langMeta(c.target || "")[1] || "").toLowerCase().includes(q));
  let inTok = 0, outTok = 0, ms = 0, ok = 0, fail = 0, lines = 0, costToday = 0, costAll = 0;
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0); const t0 = startToday.getTime();
  for (const c of shown) {
    inTok += c.inTok || 0; outTok += c.outTok || 0; ms += c.ms || 0; lines += c.lines || 0;
    if (c.ok) ok++; else fail++;
    costAll += estCost(c);
    if ((c.ts || 0) >= t0) costToday += estCost(c);
  }
  const avgMs = shown.length ? Math.round(ms / shown.length) : 0;

  const stats = el("actStats"); stats.innerHTML = "";
  stats.appendChild(statCard("Calls", String(shown.length), fail ? `· ${fail} failed` : ""));
  if (q) stats.appendChild(statCard("Filtered", shown.length + "/" + calls.length + " calls"));
  stats.appendChild(statCard("Lines translated", lines.toLocaleString()));
  stats.appendChild(statCard("Tokens (in · out)", inTok.toLocaleString() + " · " + outTok.toLocaleString()));
  stats.appendChild(statCard("Est. cost · all-time", "~" + fmtCost(costAll), "", "cost"));
  stats.appendChild(statCard("Est. cost · today", "~" + fmtCost(costToday), "", "cost"));
  stats.appendChild(statCard("Avg response", avgMs + " ms"));

  const list = el("actList"); list.innerHTML = "";
  for (const c of shown.slice().reverse().slice(0, 200)) {
    const row = document.createElement("div"); row.className = "callrow";
    row.title = "≈ " + fmtCost(estCost(c)) + (c.err ? " · " + c.err : "");
    const t = document.createElement("span"); t.className = "ct"; t.textContent = fmtTime(c.ts);
    const s = document.createElement("span"); s.className = "cs";
    s.textContent = (c.title || (c.site ? siteMeta(c.site).label : "—")) + (c.target ? " → " + langMeta(c.target)[1] : "");
    s.title = s.textContent;
    const ln = document.createElement("span"); ln.textContent = c.kind === "tts" ? "🎙 " + Math.round((c.durMs || 0) / 1000) + "s" : (c.lines || 0) + " ln";
    const tk = document.createElement("span"); tk.className = "ctok"; tk.textContent = (c.inTok || 0) + "→" + (c.outTok || 0);
    const mv = document.createElement("span"); mv.className = "cms"; mv.textContent = (c.ms || 0) + "ms";
    const st = document.createElement("span"); st.className = "cok " + (c.ok ? "ok" : "err"); st.textContent = c.ok ? "✓" : "✗";
    [t, s, ln, tk, mv, st].forEach((e) => row.appendChild(e));
    list.appendChild(row);
  }
}
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
  el("clearAll").style.visibility = vids ? "" : "hidden"; // "Clear all" is a videos action
  if (!vids) loadActivity();
}
el("tabVideos").addEventListener("click", () => setView("videos"));
el("tabActivity").addEventListener("click", () => setView("activity"));

refresh();
