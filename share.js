// share.html — one page with a video's chunks, translations and the tips already
// explained. Built from the cache only; "Download" saves it as a single file.
(() => {
  const $ = (id) => document.getElementById(id);
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const POS = { noun: "n", verb: "v", "phrasal verb": "v", adjective: "adj", adverb: "adv", idiom: "x", expression: "x", preposition: "prep" };
  const fmtT = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); };
  const id = new URLSearchParams(location.search).get("id") || "";
  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r)));
  const render = (rec) => {
    const wrap = $("wrap"); wrap.textContent = "";
    document.title = "SubVibe · " + rec.title;
    const head = mk("header"); head.appendChild(mk("div", "logo", "S"));
    const hbox = mk("div"); hbox.appendChild(mk("h1", null, rec.title));
    const meta = mk("div", "meta"); meta.append(rec.chunks.length + (rec.chunks.length === 1 ? " chunk" : " chunks") + " · " + rec.explained + " explained · tips in " + (rec.explain === "same" ? "the video's language" : rec.target.toUpperCase()) + " · ");
    if (rec.url) { const a = mk("a", null, "open the video"); a.href = rec.url; a.target = "_blank"; a.rel = "noopener"; meta.appendChild(a); }
    hbox.appendChild(meta);
    if (rec.ctx && rec.ctx.kind) hbox.appendChild(mk("div", "ctx", [rec.ctx.kind, rec.ctx.about].filter(Boolean).join(" · ")));
    head.appendChild(hbox); wrap.appendChild(head);
    const tools = mk("div", "tools");
    const dl = mk("button", "btn primary", "Download this page"); dl.type = "button"; dl.title = "One HTML file — opens in any browser, nothing else needed";
    dl.addEventListener("click", () => {
      const clone = document.documentElement.cloneNode(true);
      for (const s of clone.querySelectorAll("script, .tools")) s.remove();
      const html = "<!DOCTYPE html>\n" + clone.outerHTML;
      const blob = new Blob([html], { type: "text/html" }); const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = ("subvibe-tips-" + rec.title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60) + ".html").replace(/-+\.html$/, ".html"); a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
    const pr = mk("button", "btn", "Print / PDF"); pr.type = "button"; pr.addEventListener("click", () => window.print());
    tools.append(dl, pr); wrap.appendChild(tools);
    for (const ch of rec.chunks) {
      const box = mk("section", "chunk"); box.appendChild(mk("div", "time", fmtT(ch.startMs)));
      ch.sentences.forEach((x, i) => {
        const r = mk("div", "sent"); r.appendChild(mk("i", "sn", String(i + 1))); const t = mk("span", null, x.s); t.dir = "auto"; r.appendChild(t); box.appendChild(r);
        if (x.tr) { const tr = mk("div", "tr", x.tr); tr.dir = "auto"; box.appendChild(tr); }
      });
      const tp = ch.tips;
      if (tp) {
        if (tp.scene) { const sc = mk("div", "scene", tp.scene); sc.dir = "auto"; box.appendChild(sc); }
        if (tp.simple) { box.appendChild(mk("div", "lbl", "Put simply")); const s = mk("div", "simple", tp.simple); s.dir = "auto"; box.appendChild(s); }
        if (tp.g) { box.appendChild(mk("div", "lbl", "Grammar")); const g = mk("div", "gram"); g.dir = "auto"; const parts = String(tp.g).split(/\s*•\s*/).map((q) => q.trim()).filter(Boolean); if (parts.length > 1) for (const q of parts) g.appendChild(mk("div", "gpt", q)); else g.textContent = tp.g; box.appendChild(g); }
        if (tp.words && tp.words.length) {
          box.appendChild(mk("div", "lbl", "Words")); const list = mk("div", "words");
          for (const w of tp.words) { const b = mk("b", "pos-" + (POS[String(w.pos || "").toLowerCase()] || "o"), w.w); b.dir = "auto"; if (w.tone === "positive" || w.tone === "negative") b.appendChild(mk("i", "tone " + w.tone, w.tone === "positive" ? "+" : "−")); const tag = [w.pos, w.level, w.register && w.register !== "neutral" ? w.register : ""].filter(Boolean).join(" · "); if (tag) b.appendChild(mk("i", "tag", tag)); const m = mk("span", null, w.m); m.dir = "auto"; if (w.care) { const c = mk("i", "care", "⚠ " + w.care); c.dir = "auto"; m.appendChild(c); } if (w.forms) m.appendChild(mk("i", "forms", w.forms)); list.append(b, m); }
          box.appendChild(list);
        }
      } else box.appendChild(mk("div", "none", "Not explained yet — press ﹖ on this chunk in the video to add its tips."));
      wrap.appendChild(box);
    }
    wrap.appendChild(mk("footer", null, "Made with SubVibe — subtitles, tips and study cards for language learners."));
  };
  send({ type: "SHARE_GET", id }).then((rec) => { if (!rec || rec.error || !rec.chunks) { $("wrap").textContent = "Nothing to show — open Share from the story board on a video."; return; } render(rec); });
})();
