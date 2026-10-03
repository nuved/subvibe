// shared/dossier.js — the video's dossier as prompt text and as UI facts.
// Pure (node-tested). The block is CACHE-STABLE: the same dossier object gives
// the same bytes, and nothing that changes per call (times, counts) is in it.
(function (g) {
  const s = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n || 4000);
  const clip = (arr, n) => (Array.isArray(arr) ? arr : []).slice(0, n);
  function identityLine(d) {
    if (!d) return "";
    const show = s(d.show, 120), title = s(d.title, 120), ep = s(d.epTitle, 120);
    if (show) { const se = d.season && d.episode ? "S" + d.season + " E" + d.episode : d.episode ? "E" + d.episode : ""; return [show, se, ep].filter(Boolean).join(" · "); }
    return title;
  }
  function block(d) {
    if (!d) return "";
    const out = ["VIDEO DOSSIER (context only — never explain or translate it):"];
    const show = s(d.show, 120), title = s(d.title, 160), ep = s(d.epTitle, 120), year = d.year ? " (" + s(d.year, 4) + ")" : "";
    if (show) out.push("- Title: " + show + (d.season && d.episode ? " — S" + d.season + "E" + d.episode : d.episode ? " — E" + d.episode : "") + (ep ? ' "' + ep + '"' : "") + year);
    else if (title) out.push("- Title: " + title + year);
    if (d.channel) out.push("- Channel: " + s(d.channel, 80));
    if (d.description) out.push("- Description: " + s(d.description, 600));
    if (d.synopsis) out.push("- Synopsis: " + s(d.synopsis, 400));
    if (d.kind) out.push("- Kind: " + s(d.kind, 80) + (d.about ? " — " + s(d.about, 200) : "") + (d.register ? ". Register: " + s(d.register, 120) : "") + (d.speakers ? ". Speakers: " + s(d.speakers, 160) : ""));
    const people = clip(d.people, 12).filter((p) => p && (p.name || p.character));
    if (people.length) {
      const tmdb = people.some((p) => p.character);
      out.push(tmdb ? "- People (character — actor): " + people.map((p) => s(p.character || "?", 60) + " — " + s(p.name || "?", 60)).join("; ")
                    : "- People: " + people.map((p) => s(p.name, 60) + (p.role ? " (" + s(p.role, 60) + ")" : "")).join("; "));
    }
    const sample = clip(d.sample, 300).map((l) => s(l, 160)).filter(Boolean);
    if (sample.length) { out.push("SUBTITLE SAMPLE (spread over the whole video):"); sample.forEach((l, i) => out.push((i + 1) + ". " + l)); }
    return out.join("\n") + "\n";
  }
  function sampleLines(lines, max) {
    const all = (Array.isArray(lines) ? lines : []).map((l) => s(l, 160)).filter(Boolean);
    const n = Math.max(1, max | 0);
    if (all.length <= n) return all;
    const step = all.length / n, out = [];
    for (let i = 0; i < n; i++) out.push(all[Math.floor(i * step)]);
    return out;
  }
  const norm = (x) => s(x, 80).toLowerCase();
  const first = (x) => norm(x).split(/[\s,.'’-]+/).filter((w) => w.length >= 3)[0] || "";
  function whoFaces(who, people) {
    const ps = Array.isArray(people) ? people : [];
    return clip(who, 4).map((w) => s(w, 60)).filter(Boolean).map((label) => {
      const n = norm(label), f = first(label);
      const person = ps.find((p) => norm(p.character) === n || norm(p.name) === n) || (f && ps.find((p) => first(p.character) === f || first(p.name) === f)) || null;
      return { label, person };
    });
  }
  function aheadWindow(ki, n, ahead, isExplained) {
    const all = !(ahead < Infinity);
    const from = ki >= 0 ? ki : all ? 0 : -1; if (from < 0) return -1;
    const to = all ? n - 1 : Math.min(n - 1, from + ahead - 1);
    for (let k = from; k <= to; k++) if (!isExplained(k)) return k;
    return -1;
  }
  // Who is speaking: "Emily / Madeline" names both; a first name of 3+ letters is the person ("Bjorn" is Bjorn Ironside).
  const clean = (x) => s(x, 80).replace(/\s*\(.*$/, "").toLowerCase();
  function sameName(a, b) { a = clean(a); b = clean(b); if (!a || !b) return false; if (a === b) return true; const fa = a.split(/\s+/)[0], fb = b.split(/\s+/)[0]; return fa.length >= 3 && fa === fb; }
  const speakers = (spk) => String(spk || "").split(/\s*[\/&,+]\s*|\s+and\s+/i).map((x) => s(x, 60).replace(/\s*\(.*$/, "")).filter(Boolean);
  // The chunk's main speaker: the name behind most of its sentences ("A / B" counts for both); a tie goes to the first heard.
  function dominantSpeaker(spk) {
    const count = new Map();
    for (const e of Array.isArray(spk) ? spk : []) for (const n of speakers(e)) { const k = n.toLowerCase(); const c = count.get(k) || { n, c: 0 }; c.c++; count.set(k, c); }
    let best = null; for (const c of count.values()) if (!best || c.c > best.c) best = c;
    return best ? best.n : "";
  }
  function speaks(name, spk) { return speakers(spk).some((p) => sameName(name, p)); }
  const nameOf = (f) => (f && f.person && (f.person.character || f.person.name)) || (f && f.label) || "";
  // The Now box's faces: the scene's people as listed, and whoever is speaking always in view — added when the
  // list missed them, moved into the last visible slot when they sat behind "+N". Four slots: four faces, or three and +N.
  function nowFaces(faces, spk, people, max) {
    max = max || 4; const list = (Array.isArray(faces) ? faces : []).filter(Boolean).slice(); const names = speakers(spk);
    for (const sp of names) if (!list.some((f) => sameName(nameOf(f), sp))) list.push(whoFaces([sp], people)[0]);
    let shown = list, more = 0;
    if (list.length > max) {
      const vis = max - 1; shown = list.slice(0, vis); more = list.length - vis;
      const talking = (f) => names.some((n) => sameName(nameOf(f), n));
      const hidden = list.slice(vis).filter(talking); // speakers behind +N, in list order
      const slots = []; for (let i = vis - 1; i >= 0 && slots.length < hidden.length; i--) if (!talking(shown[i])) slots.unshift(i); // the last quiet slots, kept in order
      slots.forEach((i, j) => { shown[i] = hidden[j]; });
    }
    return { shown: shown.map((f) => Object.assign({}, f, { talk: names.some((n) => sameName(nameOf(f), n)) })), more };
  }
  function initials(name) {
    const w = s(name, 60).split(/\s+/).filter(Boolean);
    if (!w.length) return "?";
    return (w.length > 1 ? w[0][0] + w[w.length - 1][0] : w[0][0]).toUpperCase();
  }
  // The cache key of a chunk's tips: the same words with a ">>" speaker mark (anywhere — a chunk is its
  // sentences joined by " "), a leading dash, [Music]-style tags, other spacing, case or end punctuation
  // are the same chunk — a chorus is explained (and paid for) once.
  function tipKey(text) {
    const raw = String(text || "");
    const k = raw
      .replace(/\[[^\]]{1,30}\]|\([A-Z ]{2,30}\)/g, " ")
      .replace(/(^|\s)(>>|&gt;&gt;|»)+\s*/g, " ")
      .replace(/(^|\n)\s*[-–—]\s+/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[\s.!…,;:]+$/u, "")
      .toLocaleLowerCase();
    return k || raw.replace(/\s+/g, " ").trim().toLocaleLowerCase(); // "[Music]" or "(LAUGHS)" alone keeps its own key
  }
  // A song or a mix: nothing "happens" from chunk to chunk, so no scene line is asked for.
  function isMusic(d) { return !!(d && /^\s*(music|song|lyric|dj|mix|playlist|album|track|karaoke|concert)\b/i.test(String(d.kind || ""))); }
  // The words this video's tips have already taught, so the next call can skip them.
  function knownWords(exs, max) {
    const seen = new Map();
    for (const e of exs || []) for (const x of (e && e.words) || []) { const w = String((x && x.w) || "").trim().toLowerCase(); if (!w) continue; seen.delete(w); seen.set(w, 1); }
    const all = [...seen.keys()];
    return all.slice(Math.max(0, all.length - max));
  }
  g.SV_DOSSIER = { block, identityLine, sampleLines, whoFaces, aheadWindow, initials, sameName, speaks, nowFaces, dominantSpeaker, tipKey, isMusic, knownWords };
})(typeof globalThis !== "undefined" ? globalThis : this);
