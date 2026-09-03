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
  function initials(name) {
    const w = s(name, 60).split(/\s+/).filter(Boolean);
    if (!w.length) return "?";
    return (w.length > 1 ? w[0][0] + w[w.length - 1][0] : w[0][0]).toUpperCase();
  }
  g.SV_DOSSIER = { block, identityLine, sampleLines, whoFaces, aheadWindow, initials };
})(typeof globalThis !== "undefined" ? globalThis : this);
