// share.html — one page with a video's chunks, translations and the tips already
// explained. Built from the cache only; "Download" saves it as a single file.
(() => {
  const $ = (id) => document.getElementById(id);
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const POS = { noun: "n", verb: "v", "phrasal verb": "v", adjective: "adj", adverb: "adv", idiom: "x", expression: "x", preposition: "prep" };
  const fmtT = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); };
  const id = new URLSearchParams(location.search).get("id") || "";
  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r)));
  const RTL = new Set(["fa", "ar", "he", "ur", "ps", "ug", "sd", "yi", "dv"]);
  const dirOf = (code) => (code ? (RTL.has(String(code).split("-")[0]) ? "rtl" : "ltr") : "auto");
  const render = (rec) => {
    const wrap = $("wrap"); wrap.textContent = "";
    const tDir = dirOf(rec.explain === "same" ? rec.lang : rec.target), srcDir = dirOf(rec.lang);
    document.title = "SubVibe · " + rec.title;
    const head = mk("header"); head.appendChild(mk("div", "logo", "S"));
    const hbox = mk("div"); hbox.appendChild(mk("h1", null, rec.title));
    const ident = SV_DOSSIER.identityLine(rec.dossier);
    if (ident && ident !== rec.title) { const idn = mk("div", "ident", ident); idn.dir = "auto"; hbox.appendChild(idn); }
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
        if (x.tr) { const tr = mk("div", "tr", x.tr); tr.dir = dirOf(rec.target); box.appendChild(tr); }
      });
      const tp = ch.tips;
      if (tp) {
        if (tp.scene) { box.appendChild(mk("div", "lbl", "What's happening")); const sc = mk("div", "scene", tp.scene); sc.dir = tDir; box.appendChild(sc); }
        if (tp.who && tp.who.length) { const w = mk("div", "who", "Who: " + tp.who.join(" · ")); w.dir = "auto"; box.appendChild(w); }
        if (tp.simple) { box.appendChild(mk("div", "lbl", "Simpler words, same meaning")); const s = mk("div", "simple", tp.simple); s.dir = srcDir; box.appendChild(s); }
        if (tp.g) { box.appendChild(mk("div", "lbl", "Grammar")); const g = mk("div", "gram"); g.dir = tDir; const parts = String(tp.g).split(/\s*•\s*/).map((q) => q.trim()).filter(Boolean);
          const gpt = (text) => { const d = mk("div", "gpt"); const re = /«([^»]+)»|“([^”]+)”|"([^"]{2,60})"/g; let last = 0, m; while ((m = re.exec(text))) { if (m.index > last) d.appendChild(document.createTextNode(text.slice(last, m.index))); const q = mk("b", "q", m[1] || m[2] || m[3]); q.dir = "auto"; d.appendChild(q); last = m.index + m[0].length; } if (last < text.length) d.appendChild(document.createTextNode(text.slice(last))); return d; };
          for (const q of parts.length ? parts : [String(tp.g)]) g.appendChild(gpt(q)); box.appendChild(g); }
        if (tp.words && tp.words.length) {
          box.appendChild(mk("div", "lbl", "Words")); const list = mk("div", "words");
          for (const w of tp.words) { const b = mk("b", "pos-" + (POS[String(w.pos || "").toLowerCase()] || "o"), w.w); b.dir = "auto"; if (w.tone === "positive" || w.tone === "negative") b.appendChild(mk("i", "tone " + w.tone, w.tone === "positive" ? "+" : "−")); const tag = [w.pos, w.level, w.register && w.register !== "neutral" ? w.register : ""].filter(Boolean).join(" · "); if (tag) b.appendChild(mk("i", "tag", tag)); const m = mk("span", null, w.m); m.dir = tDir; if (w.care) { const c = mk("i", "care", "⚠ " + w.care); c.dir = tDir; m.appendChild(c); } if (w.forms) m.appendChild(mk("i", "forms", w.forms)); list.append(b, m); }
          box.appendChild(list);
        }
      } else box.appendChild(mk("div", "none", "Not explained yet — press ﹖ on this chunk in the video to add its tips."));
      wrap.appendChild(box);
    }
    const foot = mk("footer"); foot.appendChild(document.createTextNode("Made with SubVibe — subtitles, tips and study cards for language learners. "));
    const get = mk("a", "get", "Get SubVibe free →"); get.href = SV_SHARE.STORE_URL; get.target = "_blank"; get.rel = "noopener"; foot.appendChild(get);
    if (rec.dossier && (rec.dossier.people || []).some((p) => p && p.src === "tmdb")) foot.appendChild(mk("div", "attr", "Cast & episode data · TMDB"));
    wrap.appendChild(foot);
  };
  send({ type: "SHARE_GET", id }).then((rec) => { if (!rec || rec.error || !rec.chunks) { $("wrap").textContent = "Nothing to show — open Share from the story board on a video."; return; } render(rec); });
})();
