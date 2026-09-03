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
  const SKIP_SEL = "script,style,noscript,template,textarea,input,select,option,svg,canvas,video,audio,iframe,pre,code,kbd,samp,[contenteditable]:not([contenteditable='false'])";

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
  // A strict page CSP (e.g. x.com) blocks <style> elements even inside a shadow
  // root — the overlay would render unstyled (invisible). A constructable
  // stylesheet is a CSSOM API, not subject to style-src, so it applies where an
  // inline <style> is refused; fall back to <style> on engines without it.
  function applyShadowStyle(css) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
      return;
    } catch (e) { /* older engine */ }
    const st = document.createElement("style"); st.textContent = css; root.appendChild(st);
  }
  function ensureHost() {
    if (host) return;
    host = document.createElement("div");
    host.className = "sv-shot-host";
    // !important defeats Brave Shields' cosmetic filtering, which hides a
    // full-viewport max-z-index overlay (our host looks like an ad/anti-adblock
    // wall) by applying display:none via a stylesheet — an inline !important
    // wins the cascade. NOT on visibility/pointer-events: the capture loop and
    // pickers toggle those at runtime.
    host.style.cssText = "display:block !important;position:fixed !important;inset:0 !important;z-index:2147483647 !important;pointer-events:none;";
    root = host.attachShadow({ mode: "closed" });
    applyShadowStyle(cssText || "");
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
  // Two animation frames, but never hang: a backgrounded/occluded tab throttles
  // requestAnimationFrame to zero, so fall back to a timer after 500ms. In a
  // foreground tab (the real case — the user just clicked) rAF fires in ~32ms.
  const raf2 = () => new Promise((r) => {
    let done = false;
    const go = () => { if (!done) { done = true; r(); } };
    requestAnimationFrame(() => requestAnimationFrame(go));
    setTimeout(go, 500);
  });
  async function settle() { await raf2(); await sleep(150); }
  // Bundled fonts the user can apply to the translated text. Loaded via the
  // FontFace API from the woff2 BYTES (not a url()/<style>) so a strict page CSP
  // (x.com) can't block them, then set on the swapped text before capture.
  const SHOT_FONTS = {
    vazirmatn: { family: "SubVibe Vazirmatn", files: [["fonts/Vazirmatn-Regular.woff2", "400"], ["fonts/Vazirmatn-Bold.woff2", "700"]] },
  };
  const fontLoaded = {};
  async function ensureShotFont(key) {
    const def = SHOT_FONTS[key]; if (!def) return null;
    if (fontLoaded[key]) return def.family;
    try {
      for (const [file, weight] of def.files) {
        const buf = await (await fetch(chrome.runtime.getURL(file))).arrayBuffer();
        const ff = new FontFace(def.family, buf, { weight });
        await ff.load(); document.fonts.add(ff);
      }
      fontLoaded[key] = true; return def.family;
    } catch (e) { return null; }
  }
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

  const contentW = () => (document.documentElement && document.documentElement.clientWidth) || innerWidth;
  const visibleRect = () => ({ x: scrollX, y: scrollY, w: contentW(), h: innerHeight });
  const fullRect = () => ({ x: scrollX, y: 0, w: contentW(), h: docHeight() });

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
    for (const b of blocks) { b.text = normText(b.nodes.map((t) => t.data).join(" ")); b.segs = b.nodes.map((t) => normText(t.data)); }
    return blocks;
  }

  // ── swap / restore ─────────────────────────────────────────────────────────
  const saved = [], inserted = [], attrSaved = [], fixedHidden = [];
  let scroll0 = null;
  let maxReachedY = 0; // furthest window.scrollY a pass actually reached (inner-scroll guard)

  function swap(layout, blocks, target, fontFamily) {
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
        if (fontFamily) span.style.setProperty("font-family", fontFamily, "important");
        const last = nodes[nodes.length - 1];
        last.parentNode.insertBefore(span, last.nextSibling);
        inserted.push(span); b.trEl = span; // measured to grow area shots past the added line
        b.check = () => span.isConnected && span.textContent === b.tr;
      } else {
        // Sentence pairs (when they agree with the block's translation) let each
        // paragraph / formatted run keep its own text, so a four-paragraph
        // tweet stays four paragraphs. Otherwise the longest node takes it all.
        const pairsOk = nodes.length > 1 && Array.isArray(b.pairs) && b.pairs.length
          && normText(b.pairs.map((p) => (p && p.t) || "").filter(Boolean).join(" ")) === normText(b.tr);
        const dist = pairsOk ? S().distributeTranslation(nodes.map((x) => x.data), b.pairs) : null;
        let main = null;
        if (dist) {
          nodes.forEach((x, i) => { saved.push({ node: x, data: x.data }); x.data = dist[i]; if (!main && dist[i]) main = x; });
        } else {
          main = nodes.reduce((a, x) => (x.data.length > a.data.length ? x : a));
          for (const x of nodes) { saved.push({ node: x, data: x.data }); x.data = x === main ? b.tr : ""; }
        }
        const mainText = main ? main.data : "";
        const e = b.el;
        attrSaved.push({ el: e, dir: e.getAttribute("dir"), align: e.style.getPropertyValue("text-align"), alignPrio: e.style.getPropertyPriority("text-align"), font: e.style.getPropertyValue("font-family"), fontPrio: e.style.getPropertyPriority("font-family") });
        e.setAttribute("dir", "auto");
        if (rtl) { const ta = getComputedStyle(e).textAlign; if (ta === "left" || ta === "start" || ta === "-webkit-left") e.style.setProperty("text-align", "start", "important"); }
        if (fontFamily) e.style.setProperty("font-family", fontFamily, "important");
        b.check = () => !!main && main.isConnected && main.data === mainText;
      }
    }
  }
  function verifySwap(blocks) {
    const want = blocks.filter((b) => b.tr); // a disconnected block (check never set) counts as failed
    if (!want.length) return 1;
    return want.filter((b) => typeof b.check === "function" && b.check()).length / want.length;
  }
  function unswap() {
    for (const s of saved) { try { s.node.data = s.data; } catch (e) { /* detached */ } }
    for (const sp of inserted) sp.remove();
    for (const a of attrSaved) {
      if (a.dir == null) a.el.removeAttribute("dir"); else a.el.setAttribute("dir", a.dir);
      if (a.align) a.el.style.setProperty("text-align", a.align, a.alignPrio); else a.el.style.removeProperty("text-align");
      if (a.font) a.el.style.setProperty("font-family", a.font, a.fontPrio); else a.el.style.removeProperty("font-family");
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
  // Plan tiles from the CURRENT layout. For "full" the height is re-read live,
  // so a pass planned AFTER the translation swap covers any reflow growth
  // (bilingual adds a line under each block; longer languages grow paragraphs).
  // Area shots have a fixed dragged height. A swap that reflows taller (bilingual
  // adds a translated line under each block; a longer translation wraps to more
  // lines) pushes text past the box and clips it. Grow the rect's bottom to the
  // swapped content — measured from the live text nodes plus the inserted
  // second-language span — capped at the document end. Only ever grows, never
  // shrinks; full-page shots re-read docHeight already, so they're left alone.
  function grownAreaRect(baseRect, blocks, mode) {
    if (mode === "full") return baseRect;
    let bottom = -Infinity;
    for (const b of blocks || []) {
      if (!b || !b.tr) continue;
      for (const n of b.nodes || []) {
        if (!n.isConnected || !n.data) continue;
        const range = document.createRange(); range.selectNodeContents(n);
        const u = unionRects(range.getClientRects());
        if (u) bottom = Math.max(bottom, u.y + u.h);
      }
      if (b.trEl && b.trEl.isConnected) { const r = b.trEl.getBoundingClientRect(); if (r.height) bottom = Math.max(bottom, r.bottom + scrollY); }
    }
    if (bottom === -Infinity) return baseRect;
    const want = Math.min(bottom + 8, docHeight());
    return { x: baseRect.x, y: baseRect.y, w: baseRect.w, h: Math.max(baseRect.h, want - baseRect.y) };
  }
  function planPass(baseRect, mode) {
    const vh = innerHeight, docH = docHeight(), maxScroll = Math.max(0, docH - vh);
    const rect = mode === "full" ? { x: baseRect.x, y: 0, w: baseRect.w, h: docH } : baseRect;
    const fits = rect.y >= scrollY && rect.y + rect.h <= scrollY + vh;
    if (fits) return { offsets: [scrollY], truncated: false, rect };
    const plan = S().planTiles(rect.y, rect.y + rect.h, vh, maxScroll);
    let r = rect;
    if (plan.truncated) r = { x: rect.x, y: rect.y, w: rect.w, h: plan.offsets[plan.offsets.length - 1] + vh - rect.y };
    return { offsets: plan.offsets, truncated: plan.truncated, rect: r };
  }
  // Returns the number of tiles actually captured (< offsets.length if the page
  // stopped scrolling — an inner-scroll container the window can't move).
  async function shootPass(pass, offsets, done, total) {
    const multi = offsets.length > 1;
    let prev = null, i = 0;
    for (; i < offsets.length; i++) {
      if (aborted) throw new Error("cancel");
      if (multi) { if (i === 0) showFixed(); else hideFixed(); }
      scrollTo(scroll0.x, offsets[i]); // ALWAYS — a single tile below the fold must scroll too
      if (total > 1) setPill("Shooting " + (done + i + 1) + " / " + total + "…", (done + i) / total);
      await settle();
      const actualY = window.scrollY;
      if (multi && i > 0 && prev !== null && actualY === prev) break; // page won't scroll further
      prev = actualY;
      if (actualY > maxReachedY) maxReachedY = actualY;
      host.style.visibility = "hidden"; await raf2();
      let res = await send({ type: "SHOT_TILE", pass, index: i, scrollY: actualY });
      if (!res || !res.ok) { await sleep(400); res = await send({ type: "SHOT_TILE", pass, index: i, scrollY: window.scrollY }); }
      host.style.visibility = "";
      if (!res || !res.ok) throw new Error("capture");
    }
    return i;
  }

  const armEsc = () => { escHandler = (e) => { if (e.key === "Escape") { aborted = true; } }; window.addEventListener("keydown", escHandler, true); };

  // Height a pass actually covered, so an inner-scroll page that wouldn't move
  // stores a rect matching the pixels captured instead of a tall blank canvas.
  function coveredRect(effRect, shotN, planned) {
    if (shotN >= planned) return { rect: effRect, cut: false };
    const h = Math.min(effRect.h, (maxReachedY - effRect.y) + innerHeight);
    return { rect: { x: effRect.x, y: effRect.y, w: effRect.w, h: Math.max(1, h) }, cut: true };
  }

  async function capture(rect0, mode, layout, target, font) {
    scroll0 = { x: scrollX, y: scrollY };
    maxReachedY = scroll0.y;
    // Provisional rect for BEGIN + block collection (full = whole doc, pre-swap).
    const baseRect = mode === "full" ? { x: rect0.x, y: 0, w: rect0.w, h: docHeight() } : rect0;
    const begin = await send({ type: "SHOT_BEGIN", url: location.href, title: document.title, mode, layout: "original", rect: baseRect, dpr: devicePixelRatio, scrollX: scroll0.x, viewport: { w: innerWidth, h: innerHeight }, docH: docHeight() });
    if (!begin || !begin.ok) { toast("Capture failed — try again.", 3000); return; }
    // Capture the ORIGINAL page only — no translation, no API call at capture.
    // The editor translates on demand (Translated / Bilingual / a language pick),
    // so every shot is free and instant and the user sees the real page first.
    // Blocks (original text + rects) ride along so the editor can translate later.
    const raw = collectBlocks(baseRect);
    const prep = S().prepBlocks(raw.map((b) => ({ id: b.id, text: b.text, rect: b.rect })));
    const byId = new Map(raw.map((b) => [b.id, b]));
    const mapped = S().mapTranslations(prep.keep, prep.lineOf, []); // tr = "" for every block
    const blocks = mapped.blocks.map((b) => { const live = byId.get(b.id); return { id: b.id, text: b.text, tr: "", rect: b.rect, segs: live.segs, el: live.el, nodes: live.nodes }; });
    armEsc();
    let effRect = baseRect, effCut = false;
    try {
      const pl = planPass(baseRect, mode); effRect = pl.rect;
      const n = await shootPass("original", pl.offsets, 0, pl.offsets.length);
      const c = coveredRect(pl.rect, n, pl.offsets.length); effRect = c.rect; effCut = pl.truncated || c.cut;
    } catch (e) {
      restore(); setPill("");
      await send({ type: "SHOT_ABORT" });
      if (e && e.message !== "cancel") toast("Capture failed — try a smaller area.", 3500);
      return;
    } finally { restore(); }
    const truncated = prep.truncated || (effCut ? "height" : "");
    setPill("Saving…", 1);
    // A line explained on the video overlay (common.js leaves it on the window,
    // same isolated world) rides along: the editor gets its translation, grammar
    // and words as a ready-made Study card and a text block at the line's spot.
    const tip = window.__svOverlayLine && window.__svOverlayLine.s ? window.__svOverlayLine : null;
    const res = await send({ type: "SHOT_COMPOSE", rect: effRect, blocks: blocks.map((b) => ({ id: b.id, text: b.text, tr: b.tr, rect: b.rect, segs: b.segs })), partial: false, truncated, passes: ["original"], sameLang: false, noKey: false, font: font || "", tip });
    setPill("");
    if (!res || !res.ok) { toast("Couldn't save the shot. Try again.", 3500); return; }
    toast("Shot saved — opening editor…", 1800);
  }

  // A countdown before the capture (the popup's "Wait 3 s / 5 s / 10 s"): the page is
  // free meanwhile — open a menu, hold a hover — and Esc cancels. Nothing of ours is on
  // the page when the capture runs.
  async function countdown(seconds) {
    const Z = 2147483647, FONT = "system-ui,-apple-system,sans-serif";
    const wrap = document.createElement("div"); wrap.style.cssText = "position:fixed;inset:0;z-index:" + Z + ";display:flex;align-items:center;justify-content:center;pointer-events:none;";
    const n = document.createElement("div"); n.style.cssText = "min-width:130px;height:130px;border-radius:50%;background:rgba(20,16,12,.82);color:#fff;font:800 72px/130px " + FONT + ";text-align:center;box-shadow:0 0 0 6px rgba(201,63,43,.7),0 12px 40px rgba(0,0,0,.5);padding:0 18px;"; wrap.appendChild(n);
    const c = document.createElement("div"); c.style.cssText = "position:absolute;bottom:18%;left:50%;transform:translateX(-50%);color:#fff;font:600 13px/1.3 " + FONT + ";background:rgba(20,16,12,.8);padding:6px 12px;border-radius:8px;"; c.textContent = "Shot in a moment — Esc cancels"; wrap.appendChild(c);
    if (host) host.style.display = "none"; // the picker's chrome must not sit under the pointer while the page is being arranged
    document.documentElement.appendChild(wrap);
    let cancelled = false; const onKey = (e) => { if (e.key === "Escape") cancelled = true; };
    window.addEventListener("keydown", onKey, true);
    for (let s = seconds; s > 0 && !cancelled; s--) { n.textContent = String(s); await sleep(1000); }
    window.removeEventListener("keydown", onKey, true);
    wrap.remove(); if (host) host.style.display = "";
    return !cancelled;
  }
  async function run(mode, layout, target, font, delay) {
    if (busy) return;
    busy = true; aborted = false;
    try {
      await cssReady(); ensureHost();
      if (!target) { await ask("Pick your language in the SubVibe popup first.", [["OK", "cancel", true]]); return; }
      let rect;
      try {
        rect = mode === "area" ? await pickArea() : mode === "element" ? await pickElement() : mode === "full" ? fullRect() : visibleRect();
      } catch (e) { cleanupAll(); return; }
      if (delay > 0 && !(await countdown(delay))) { cleanupAll(); return; }
      await capture(rect, mode, layout, target, font);
      // Release busy NOW so a quick re-shoot / language change from the editor
      // isn't rejected; keep the "Shot saved" toast up briefly, then remove the
      // host — unless a new run/reshoot already reused it (busy true again).
      busy = false;
      const mine = host;
      setTimeout(() => { if (host === mine && !busy) cleanupAll(); }, 1800);
      return;
    } finally { if (busy) { cleanupAll(); busy = false; } }
  }

  // Re-render the variant with edited translations and/or the other layout.
  // Blocks are matched by text (ids shift when the page changed since the shot).
  async function reshoot(msg) {
    if (busy) return { ok: false, error: "busy" };
    busy = true; aborted = false;
    try {
      await cssReady(); ensureHost();
      scroll0 = { x: scrollX, y: scrollY };
      maxReachedY = scroll0.y;
      const sx0 = scroll0.x;
      const mode = msg.mode === "full" ? "full" : "area";
      const raw = collectBlocks(mode === "full" ? { x: msg.rect.x, y: 0, w: msg.rect.w, h: docHeight() } : msg.rect);
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
        blocks.push({ id: String(b.id), text: live.text, tr: String(b.tr || ""), rect: live.rect, pairs: Array.isArray(b.pairs) ? b.pairs : null, el: live.el, nodes: live.nodes });
      }
      let partial = false;
      const original = msg.layout === "original"; // capture the page as-is, no swap
      const fontFamily = original ? null : await ensureShotFont(msg.font);
      armEsc();
      let effRect = msg.rect, effCut = false;
      try {
        if (!original) {
          swap(msg.layout, blocks, msg.target, fontFamily);
          if (verifySwap(blocks) < 0.9) { unswap(); swap(msg.layout, blocks, msg.target, fontFamily); }
          if (verifySwap(blocks) < 0.9) partial = true;
        }
        // Grow an area shot past a taller re-render (e.g. bilingual adds a line
        // per block) so the added second language isn't clipped.
        const pl = planPass(original ? msg.rect : grownAreaRect(msg.rect, blocks, mode), mode); effRect = pl.rect;
        const n = await shootPass("variant", pl.offsets, 0, pl.offsets.length);
        const c = coveredRect(pl.rect, n, pl.offsets.length); effRect = c.rect; effCut = pl.truncated || c.cut;
      } catch (e) {
        restore();
        return { ok: false, error: "capture" };
      } finally { restore(); }
      return { ok: true, partial, missing, rect: effRect, truncated: effCut ? "height" : "", dpr: devicePixelRatio, scrollX: sx0, viewport: { w: innerWidth, h: innerHeight } };
    } finally { cleanupAll(); busy = false; }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "SV_SHOT_START") {
      sendResponse({ ok: true });
      run(String(msg.mode || "visible"), msg.layout === "bilingual" ? "bilingual" : "translated", String(msg.target || ""), String(msg.font || ""), Math.min(30, Math.max(0, +msg.delay || 0)));
      return;
    }
    if (msg.type === "SV_SHOT_RESHOOT") {
      reshoot(msg).then(sendResponse, () => sendResponse({ ok: false, error: "capture" }));
      return true;
    }
  });
})();
