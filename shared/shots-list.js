// SubVibe — Shots gallery helpers (pure logic, node-testable). Turns a stored
// shot record into the few fields a gallery card needs, so the page never
// holds hundreds of full records (text blocks, study cards, marks) at once.
// Attached to globalThis like shared/title.js.
(function (g) {
  const isBlob = (v) => typeof Blob !== "undefined" && v instanceof Blob;
  const str = (v) => (typeof v === "string" ? v : "");
  const squeeze = (v) => str(v).replace(/\s+/g, " ").trim().slice(0, 400);

  // The picture a card shows: the shot's primary view (`variant`, what the
  // editor's History strip shows), then the per-view cache, then the legacy
  // original field. A tips sheet's raster is a generated title card (its
  // title and a line count, see buildTipsRecord in background.js), not a
  // picture of anything, so its card shows the first sentence pair instead.
  function pickBlob(rec) {
    if (!rec || typeof rec !== "object" || rec.mode === "tips") return null;
    const views = rec.views && typeof rec.views === "object" ? rec.views : {};
    for (const b of [rec.variant, views[rec.layout], views.translated, views.original, rec.original])
      if (isBlob(b) && b.size > 0) return b;
    return null;
  }

  // The first sentence and its translation, for a card with no picture.
  function firstPair(rec) {
    const blocks = rec && Array.isArray(rec.blocks) ? rec.blocks : [];
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      const p = Array.isArray(b.pairs) ? b.pairs.find((x) => x && (squeeze(x.o) || squeeze(x.t))) : null;
      const o = squeeze(p ? p.o : b.text), t = squeeze(p ? p.t : b.tr);
      if (o || t) return { o, t };
    }
    return null;
  }

  // The popup's own words for the capture modes, plus the two video kinds.
  const KINDS = { visible: "Visible", full: "Full page", area: "Area", element: "Element", snap: "Video frame", tips: "Tips sheet" };
  const kindLabel = (mode) => KINDS[mode] || "Shot";

  const code = (c) => str(c).split("-")[0].toUpperCase();
  // "DE → FA"; a source of "xx" means the language wasn't known, so only the target shows.
  function langPair(source, target) {
    const s = source && source !== "xx" ? code(source) : "", t = code(target);
    return s && t ? s + " → " + t : s || t;
  }

  function summarize(key, rec) {
    const r = rec && typeof rec === "object" ? rec : {};
    return {
      id: typeof key === "string" && key ? key : str(r.id),
      ts: typeof r.ts === "number" && Number.isFinite(r.ts) ? r.ts : 0,
      title: str(r.title), host: str(r.host), url: str(r.url),
      source: str(r.source), target: str(r.target), mode: str(r.mode),
      blob: pickBlob(r), pair: firstPair(r),
    };
  }

  // Newest first; a record without a time sorts last; ties keep the id order
  // so a re-read never shuffles cards that were taken in the same millisecond.
  const sortNewest = (list) => list.slice().sort((a, b) => (b.ts - a.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Every word of the query must appear in the title, host, URL, a language
  // (code or name) or the kind. `langName` maps a code to its English name.
  function matches(s, q, langName) {
    const words = str(q).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const name = typeof langName === "function" ? langName : () => "";
    const src = s.source && s.source !== "xx" ? s.source : "";
    const hay = [s.title, s.host, s.url, src, s.target, src && name(src), s.target && name(s.target),
      langPair(s.source, s.target), kindLabel(s.mode)].join("\n").toLowerCase();
    return words.every((w) => hay.includes(w));
  }

  // The name a site is shown by; filtering and search keep the full host.
  const siteName = (host) => str(host).replace(/^www\./, "");

  // [[host, count], …] — most shots first, alphabetical by the shown name on ties.
  function hostCounts(list, max) {
    const m = new Map();
    for (const s of list) if (s && s.host) m.set(s.host, (m.get(s.host) || 0) + 1);
    const out = [...m.entries()].sort((a, b) => b[1] - a[1] || (siteName(a[0]) < siteName(b[0]) ? -1 : 1));
    return max ? out.slice(0, max) : out;
  }

  g.SV_SHOTS_LIST = { pickBlob, firstPair, kindLabel, langPair, summarize, sortNewest, matches, siteName, hostCounts };
})(globalThis);
