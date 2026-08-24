// content/shot-capture.js — Shot capture script. Injected on demand by
// background (context menu / popup row / Alt+Shift+S) together with
// shared/shot.js — never registered in the manifest. Picks the capture rect,
// collects the page's text blocks from the DOM, asks background to translate,
// swaps the translations into the live page, drives the tile loop (background
// does the actual captureVisibleTab) and restores everything in `finally`.
// Spec: docs/superpowers/specs/2026-08-24-shot-translate-design.md
(function () {
  if (window.__svShot) return;
  window.__svShot = true;

  const S = () => window.SV_SHOT;
  const SKIP_SEL = "script,style,noscript,template,textarea,input,select,option,svg,canvas,video,audio,iframe,pre,code,kbd,samp,[contenteditable=''],[contenteditable='true']";

  let host = null, root = null, cssText = null, cssPromise = null;
  let busy = false, aborted = false;
  let pill = null, toastEl = null;
  let escHandler = null;

  // ── host / css ─────────────────────────────────────────────────────────────
  function cssReady() {
    if (cssText != null) return Promise.resolve(cssText);
    if (!cssPromise) {
      cssPromise = fetch(chrome.runtime.getURL("styles/shot-capture.css")).then((r) => r.text())
        .then((t) => { cssText = t; return t; }).catch(() => { cssText = ""; return ""; });
    }
    return cssPromise;
  }
  function ensureHost() {
    if (host) return;
    host = document.createElement("div");
    host.className = "sv-shot-host";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    root = host.attachShadow({ mode: "closed" });
    const st = document.createElement("style"); st.textContent = cssText || ""; root.appendChild(st);
    document.documentElement.appendChild(host);
  }
  function cleanupAll() {
    if (host) { host.remove(); host = null; root = null; }
    pill = null; toastEl = null;
    if (escHandler) { window.removeEventListener("keydown", escHandler, true); escHandler = null; }
  }
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  function place(node, r) { node.style.left = r.x + "px"; node.style.top = r.y + "px"; node.style.width = r.w + "px"; node.style.height = r.h + "px"; }
  function hint(text, keyed) {
    const h = el("div", "sv-shot-hint"); h.textContent = text + " · ";
    if (keyed) { const k = el("kbd"); k.textContent = "Esc"; h.appendChild(k); h.appendChild(document.createTextNode(" cancels")); }
    return h;
  }
  function setPill(text, frac) {
    if (!root) return;
    if (!text) { if (pill) { pill.remove(); pill = null; } return; }
    if (!pill) { pill = el("div", "sv-shot-pill"); const i = el("i"); i.appendChild(el("b")); pill.appendChild(i); pill.appendChild(el("span")); root.appendChild(pill); }
    pill.querySelector("span").textContent = text;
    pill.querySelector("b").style.width = Math.round((frac || 0) * 100) + "%";
  }
  function toast(text, ms) {
    if (!root) return;
    if (toastEl) toastEl.remove();
    toastEl = el("div", "sv-shot-toast"); toastEl.textContent = text; root.appendChild(toastEl);
    if (ms) setTimeout(() => { if (toastEl && toastEl.textContent === text) { toastEl.remove(); toastEl = null; } }, ms);
  }
  // Error toast with choices; resolves with the clicked action or "cancel" on Esc.
  function ask(text, buttons) {
    return new Promise((resolve) => {
      if (toastEl) toastEl.remove();
      toastEl = el("div", "sv-shot-toast err");
      const p = el("div"); p.textContent = text; toastEl.appendChild(p);
      const row = el("div", "sv-shot-btns");
      for (const [label, action, primary] of buttons) {
        const b = el("button"); if (primary) b.className = "p"; b.textContent = label;
        b.addEventListener("click", (e) => { e.stopPropagation(); done(action); });
        row.appendChild(b);
      }
      toastEl.appendChild(row); root.appendChild(toastEl);
      host.style.pointerEvents = "auto";
      const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done("cancel"); } };
      window.addEventListener("keydown", onKey, true);
      function done(a) { window.removeEventListener("keydown", onKey, true); if (toastEl) { toastEl.remove(); toastEl = null; } host.style.pointerEvents = "none"; resolve(a); }
    });
  }
  const send = (msg) => new Promise((res) => { try { chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? null : r)); } catch { res(null); } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  async function settle() { await raf2(); await sleep(150); }
  const docHeight = () => Math.max(document.documentElement.scrollHeight, (document.body && document.body.scrollHeight) || 0, innerHeight);
  const scrollTo = (x, y) => window.scrollTo({ left: x, top: y, behavior: "instant" });

  // ── pickers (viewport coords in, document coords out) ─────────────────────
  const toDoc = (r) => ({ x: r.x + scrollX, y: r.y + scrollY, w: r.w, h: r.h });
  const norm = (x0, y0, x1, y1) => ({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });

  function pickArea() {
    return new Promise((resolve, reject) => {
      host.style.pointerEvents = "auto";
      const ov = el("div", "sv-shot-ov");
      const ch = el("div", "sv-shot-cross-h"), cv = el("div", "sv-shot-cross-v");
      const sel = el("div", "sv-shot-sel"); sel.hidden = true;
      const size = el("div", "sv-shot-size"); sel.appendChild(size);
      ov.append(ch, cv, sel, hint("Select area · drag", true));
      root.appendChild(ov);
      let sx = 0, sy = 0, dragging = false;
      const onMove = (e) => {
        ch.style.top = e.clientY + "px"; cv.style.left = e.clientX + "px";
        if (dragging) { const r = norm(sx, sy, e.clientX, e.clientY); place(sel, r); size.textContent = Math.round(r.w) + " × " + Math.round(r.h); }
      };
      const onDown = (e) => { if (e.button !== 0) return; e.preventDefault(); dragging = true; sx = e.clientX; sy = e.clientY; sel.hidden = false; ov.classList.add("drag"); place(sel, { x: sx, y: sy, w: 0, h: 0 }); };
      const onUp = (e) => {
        if (!dragging) return;
        dragging = false;
        const r = norm(sx, sy, e.clientX, e.clientY);
        cleanup();
        if (r.w < 8 || r.h < 8) return reject(new Error("cancel"));
        resolve(toDoc(r));
      };
      const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cleanup(); reject(new Error("cancel")); } };
      function cleanup() { ov.remove(); window.removeEventListener("keydown", onKey, true); host.style.pointerEvents = "none"; }
      ov.addEventListener("mousemove", onMove); ov.addEventListener("mousedown", onDown); ov.addEventListener("mouseup", onUp);
      ov.addEventListener("contextmenu", (e) => e.preventDefault());
      window.addEventListener("keydown", onKey, true);
    });
  }

  function pickElement() {
    return new Promise((resolve, reject) => {
      const box = el("div", "sv-shot-elbox"); box.hidden = true;
      const tag = el("div", "sv-shot-eltag"); box.appendChild(tag);
      const h = hint("Pick element · click to capture", true);
      root.append(box, h);
      let cur = null;
      const onMove = (e) => {
        const t = document.elementFromPoint(e.clientX, e.clientY);
        if (!t || t === host || t === document.documentElement) return;
        cur = t;
        const r = t.getBoundingClientRect();
        place(box, { x: r.left, y: r.top, w: r.width, h: r.height }); box.hidden = false;
        tag.textContent = t.tagName.toLowerCase() + " · " + Math.round(r.width) + " × " + Math.round(r.height);
      };
      const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
      const onClick = (e) => {
        swallow(e);
        if (!cur) return;
        const r = cur.getBoundingClientRect();
        cleanup();
        if (r.width < 4 || r.height < 4) return reject(new Error("cancel"));
        resolve(toDoc({ x: r.left, y: r.top, w: r.width, h: r.height }));
      };
      const onKey = (e) => { if (e.key === "Escape") { swallow(e); cleanup(); reject(new Error("cancel")); } };
      function cleanup() {
        box.remove(); h.remove();
        for (const [t, f] of evs) window.removeEventListener(t, f, true);
      }
      const evs = [["mousemove", onMove], ["mousedown", swallow], ["mouseup", swallow], ["pointerdown", swallow], ["pointerup", swallow], ["click", onClick], ["keydown", onKey], ["contextmenu", swallow]];
      for (const [t, f] of evs) window.addEventListener(t, f, true);
    });
  }

  const visibleRect = () => ({ x: scrollX, y: scrollY, w: innerWidth, h: innerHeight });
  const fullRect = () => ({ x: scrollX, y: 0, w: innerWidth, h: docHeight() });

  // ── text blocks ────────────────────────────────────────────────────────────
  const normText = (t) => String(t || "").replace(/\s+/g, " ").trim();
  function makeHiddenCheck() {
    const cache = new Map();
    return function hidden(e) {
      let cur = e;
      const path = [];
      while (cur && cur !== document.documentElement) {
        if (cache.has(cur)) { const v = cache.get(cur); for (const p of path) cache.set(p, v); return v; }
        path.push(cur);
        const cs = getComputedStyle(cur);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") { for (const p of path) cache.set(p, true); return true; }
        cur = cur.parentElement;
      }
      for (const p of path) cache.set(p, false);
      return false;
    };
  }
  function blockAncestor(e) {
    let cur = e;
    while (cur && cur !== document.body && cur.parentElement) {
      const d = getComputedStyle(cur).display;
      if (!(d.startsWith("inline") || d === "contents")) return cur;
      cur = cur.parentElement;
    }
    return cur || document.body;
  }
  const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  function unionRects(list) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of list) { if (!r.width && !r.height) continue; x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); }
    if (x0 === Infinity) return null;
    return { x: x0 + scrollX, y: y0 + scrollY, w: x1 - x0, h: y1 - y0 };
  }
  const unionTwo = (a, b) => { const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y); return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 }; };

  // Every visible text node inside `rect`, grouped by its nearest block-level
  // ancestor. Returns [{ id, el, nodes, text, rect }] in document order.
  function collectBlocks(rect) {
    if (!document.body) return [];
    const hidden = makeHiddenCheck();
    const blocks = [], byEl = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.data || !/\S/.test(n.data)) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || p.closest(SKIP_SEL) || (host && host.contains(p)) || hidden(p)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      const range = document.createRange(); range.selectNodeContents(n);
      const r = unionRects(range.getClientRects());
      if (!r || !intersects(r, rect)) continue;
      const be = blockAncestor(n.parentElement);
      let b = byEl.get(be);
      if (!b) { b = { id: "b" + blocks.length, el: be, nodes: [], rect: r }; byEl.set(be, b); blocks.push(b); }
      else b.rect = unionTwo(b.rect, r);
      b.nodes.push(n);
    }
    for (const b of blocks) b.text = normText(b.nodes.map((t) => t.data).join(" "));
    return blocks;
  }

  // ── swap / restore ─────────────────────────────────────────────────────────
  const saved = [], inserted = [], attrSaved = [], fixedHidden = [];
  let scroll0 = null;

  function swap(layout, blocks, target) {
    const rtl = S().isRtl(target);
    for (const b of blocks) {
      b.check = null;
      if (!b.tr) continue;
      const nodes = b.nodes.filter((x) => x.isConnected);
      if (!nodes.length) continue;
      if (layout === "bilingual" && S().isBilingualBlock(b.text)) {
        const span = document.createElement("span");
        span.className = "sv-shot-tr"; span.dir = "auto"; span.textContent = b.tr;
        span.style.cssText = "display:block;font-size:.92em;opacity:.85;margin-top:.15em;unicode-bidi:plaintext;" + (rtl ? "text-align:right;" : "");
        const last = nodes[nodes.length - 1];
        last.parentNode.insertBefore(span, last.nextSibling);
        inserted.push(span);
        b.check = () => span.isConnected && span.textContent === b.tr;
      } else {
        const main = nodes.reduce((a, x) => (x.data.length > a.data.length ? x : a));
        for (const x of nodes) { saved.push({ node: x, data: x.data }); x.data = x === main ? b.tr : ""; }
        const e = b.el;
        attrSaved.push({ el: e, dir: e.getAttribute("dir"), align: e.style.getPropertyValue("text-align"), alignPrio: e.style.getPropertyPriority("text-align") });
        e.setAttribute("dir", "auto");
        if (rtl) { const ta = getComputedStyle(e).textAlign; if (ta === "left" || ta === "start" || ta === "-webkit-left") e.style.setProperty("text-align", "start", "important"); }
        b.check = () => main.isConnected && main.data === b.tr;
      }
    }
  }
  function verifySwap(blocks) {
    const live = blocks.filter((b) => b.tr && b.check);
    if (!live.length) return 1;
    return live.filter((b) => b.check()).length / live.length;
  }
  function unswap() {
    for (const s of saved) { try { s.node.data = s.data; } catch (e) { /* detached */ } }
    for (const sp of inserted) sp.remove();
    for (const a of attrSaved) {
      if (a.dir == null) a.el.removeAttribute("dir"); else a.el.setAttribute("dir", a.dir);
      if (a.align) a.el.style.setProperty("text-align", a.align, a.alignPrio); else a.el.style.removeProperty("text-align");
    }
    saved.length = 0; inserted.length = 0; attrSaved.length = 0;
  }
  function hideFixed() {
    if (fixedHidden.length || !document.body) return;
    let n = 0;
    for (const e of document.body.querySelectorAll("*")) {
      if (++n > 20000) break;
      const cs = getComputedStyle(e);
      if (cs.position === "fixed" || cs.position === "sticky") {
        fixedHidden.push({ el: e, val: e.style.getPropertyValue("visibility"), prio: e.style.getPropertyPriority("visibility") });
        e.style.setProperty("visibility", "hidden", "important");
      }
    }
  }
  function showFixed() {
    for (const f of fixedHidden) { if (f.val) f.el.style.setProperty("visibility", f.val, f.prio); else f.el.style.removeProperty("visibility"); }
    fixedHidden.length = 0;
  }
  function restore() {
    unswap(); showFixed();
    if (scroll0) { scrollTo(scroll0.x, scroll0.y); scroll0 = null; }
  }

  // ── tile loop ──────────────────────────────────────────────────────────────
  function planFor(rect) {
    const vh = innerHeight, docH = docHeight(), maxScroll = Math.max(0, docH - vh);
    const fits = rect.y >= scrollY && rect.y + rect.h <= scrollY + vh;
    if (fits) return { offsets: [scrollY], truncated: false, rect };
    const plan = S().planTiles(rect.y, rect.y + rect.h, vh, maxScroll);
    let r = rect;
    if (plan.truncated) r = { x: rect.x, y: rect.y, w: rect.w, h: plan.offsets[plan.offsets.length - 1] + vh - rect.y };
    return { offsets: plan.offsets, truncated: plan.truncated, rect: r };
  }
  async function shootPass(pass, offsets, done, total) {
    const multi = offsets.length > 1;
    for (let i = 0; i < offsets.length; i++) {
      if (aborted) throw new Error("cancel");
      if (multi) { if (i === 0) showFixed(); else hideFixed(); scrollTo(scroll0.x, offsets[i]); }
      if (total > 1) setPill("Shooting " + (done + i + 1) + " / " + total + "…", (done + i) / total);
      await settle();
      host.style.visibility = "hidden"; await raf2();
      let res = await send({ type: "SHOT_TILE", pass, index: i, scrollY: window.scrollY });
      if (!res || !res.ok) { await sleep(400); res = await send({ type: "SHOT_TILE", pass, index: i, scrollY: window.scrollY }); }
      host.style.visibility = "";
      if (!res || !res.ok) throw new Error("capture");
    }
  }

  async function translateLines(lines) {
    for (;;) {
      const res = await send({ type: "SHOT_TRANSLATE", lines });
      if (res && res.ok) return res;
      const err = (res && res.error) || "network";
      const text = err === "no-key" ? "No API key set — open the SubVibe popup to add one."
        : err === "no-target" ? "Pick your language in the SubVibe popup first."
        : "Translation failed" + (String(err).startsWith("http-") ? " (" + err.slice(5) + ")" : "") + ".";
      const buttons = err === "no-key" || err === "no-target"
        ? [["Shoot without translation", "plain", true]]
        : [["Retry", "retry", true], ["Shoot without translation", "plain", false]];
      const a = await ask(text, buttons);
      if (a === "retry") continue;
      return a === "plain" ? null : "cancel";
    }
  }

  const armEsc = () => { escHandler = (e) => { if (e.key === "Escape") { aborted = true; } }; window.addEventListener("keydown", escHandler, true); };

  async function capture(rect0, mode, layout, target) {
    scroll0 = { x: scrollX, y: scrollY };
    const { offsets, truncated: cut, rect } = planFor(rect0);
    let truncated = cut ? "height" : "";
    const begin = await send({ type: "SHOT_BEGIN", url: location.href, title: document.title, mode, layout, rect, dpr: devicePixelRatio, scrollX: scroll0.x, viewport: { w: innerWidth, h: innerHeight }, docH: docHeight() });
    if (!begin || !begin.ok) { toast("Capture failed — try again.", 3000); return; }
    const raw = collectBlocks(rect);
    const prep = S().prepBlocks(raw.map((b) => ({ id: b.id, text: b.text, rect: b.rect })));
    if (prep.truncated && !truncated) truncated = prep.truncated;
    const byId = new Map(raw.map((b) => [b.id, b]));
    let tr = null, passes, note = "";
    if (prep.lines.length) {
      setPill("Translating " + prep.lines.length + " blocks…", 0);
      const t = await translateLines(prep.lines);
      setPill("");
      if (t === "cancel") { await send({ type: "SHOT_ABORT" }); return; }
      if (t && t.sameLang) note = "same";
      else if (t && t.ok) { tr = t.tr; passes = ["original", "variant"]; }
    }
    const mapped = S().mapTranslations(prep.keep, prep.lineOf, tr || []);
    const blocks = mapped.blocks.map((b) => { const live = byId.get(b.id); return { id: b.id, text: b.text, tr: tr ? b.tr : "", rect: b.rect, el: live.el, nodes: live.nodes }; });
    let partial = false;
    // Two passes (original + translated) only when the shot fits one viewport —
    // then toggling Original↔Translated in the editor is instant for ~1 extra
    // capture. For multi-tile shots capture ONLY the chosen layout: it halves
    // captureVisibleTab calls (which are rate-limited and flaky in bulk), and
    // the Original view is rendered on demand via re-shoot.
    const twoPass = tr && offsets.length === 1;
    passes = tr ? (twoPass ? ["original", "variant"] : ["variant"]) : ["original"];
    const total = offsets.length * passes.length;
    armEsc();
    try {
      if (!tr) {
        await shootPass("original", offsets, 0, total);
      } else if (twoPass) {
        await shootPass("original", offsets, 0, total);
        swap(layout, blocks, target);
        if (verifySwap(blocks) < 0.9) { unswap(); swap(layout, blocks, target); }
        if (verifySwap(blocks) < 0.9) partial = true;
        await shootPass("variant", offsets, offsets.length, total);
      } else {
        swap(layout, blocks, target);
        if (verifySwap(blocks) < 0.9) { unswap(); swap(layout, blocks, target); }
        if (verifySwap(blocks) < 0.9) partial = true;
        await shootPass("variant", offsets, 0, total);
      }
    } catch (e) {
      restore(); setPill("");
      await send({ type: "SHOT_ABORT" });
      if (e && e.message !== "cancel") toast("Capture failed — try a smaller area.", 3500);
      return;
    } finally { restore(); }
    setPill("Saving…", 1);
    const res = await send({ type: "SHOT_COMPOSE", blocks: blocks.map((b) => ({ id: b.id, text: b.text, tr: b.tr, rect: b.rect })), partial, truncated, passes, sameLang: note === "same" });
    setPill("");
    if (!res || !res.ok) { toast("Couldn't save the shot. Try again.", 3500); return; }
    toast("Shot saved — opening editor…", 1800);
  }

  async function run(mode, layout, target) {
    if (busy) return;
    busy = true; aborted = false;
    try {
      await cssReady(); ensureHost();
      if (!target) { await ask("Pick your language in the SubVibe popup first.", [["OK", "cancel", true]]); return; }
      let rect;
      try {
        rect = mode === "area" ? await pickArea() : mode === "element" ? await pickElement() : mode === "full" ? fullRect() : visibleRect();
      } catch (e) { return; }
      await capture(rect, mode, layout, target);
      await sleep(1800);
    } finally { cleanupAll(); busy = false; }
  }

  // Re-render the variant with edited translations and/or the other layout.
  // Blocks are matched by text (ids shift when the page changed since the shot).
  async function reshoot(msg) {
    if (busy) return { ok: false, error: "busy" };
    busy = true; aborted = false;
    try {
      await cssReady(); ensureHost();
      scroll0 = { x: scrollX, y: scrollY };
      const sx0 = scroll0.x;
      const { offsets, rect } = planFor(msg.rect);
      const raw = collectBlocks(rect);
      const byText = new Map();
      for (const b of raw) if (!byText.has(b.text)) byText.set(b.text, []);
      for (const b of raw) byText.get(b.text).push(b);
      const used = new Set();
      let missing = 0;
      const blocks = [];
      for (const b of Array.isArray(msg.blocks) ? msg.blocks : []) {
        const cands = (byText.get(normText(b.text)) || []).filter((c) => !used.has(c));
        const live = cands.find((c) => c.id === b.id) || cands[0];
        if (!live) { missing++; continue; }
        used.add(live);
        blocks.push({ id: String(b.id), text: live.text, tr: String(b.tr || ""), rect: live.rect, el: live.el, nodes: live.nodes });
      }
      let partial = false;
      const original = msg.layout === "original"; // capture the page as-is, no swap
      armEsc();
      try {
        if (!original) {
          swap(msg.layout, blocks, msg.target);
          if (verifySwap(blocks) < 0.9) { unswap(); swap(msg.layout, blocks, msg.target); }
          if (verifySwap(blocks) < 0.9) partial = true;
        }
        await shootPass("variant", offsets, 0, offsets.length);
      } catch (e) {
        restore();
        return { ok: false, error: "capture" };
      } finally { restore(); }
      return { ok: true, partial, missing, dpr: devicePixelRatio, scrollX: sx0, viewport: { w: innerWidth, h: innerHeight } };
    } finally { cleanupAll(); busy = false; }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "SV_SHOT_START") {
      sendResponse({ ok: true });
      run(String(msg.mode || "visible"), msg.layout === "bilingual" ? "bilingual" : "translated", String(msg.target || ""));
      return;
    }
    if (msg.type === "SV_SHOT_RESHOOT") {
      reshoot(msg).then(sendResponse, () => sendResponse({ ok: false, error: "capture" }));
      return true;
    }
  });
})();
