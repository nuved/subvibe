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
    for (const b of blocks) b.text = normText(b.nodes.map((t) => t.data).join(" "));
    return blocks;
  }

  // ── swap / restore ─────────────────────────────────────────────────────────
  const saved = [], inserted = [], attrSaved = [], fixedHidden = [];
  let scroll0 = null;
  let maxReachedY = 0; // furthest window.scrollY a pass actually reached (inner-scroll guard)

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

  async function translateLines(lines) {
    for (;;) {
      const res = await send({ type: "SHOT_TRANSLATE", lines });
      if (res && res.ok) return res;
      const err = (res && res.error) || "network";
      // No key / no language is NOT an error for a screenshot tool — just shoot
      // the page as-is (original), and tell the user in the editor how to enable
      // translation. Only a real API failure is worth interrupting for.
      if (err === "no-key" || err === "no-target") return { noKey: true, reason: err };
      const a = await ask("Translation failed" + (String(err).startsWith("http-") ? " (" + err.slice(5) + ")" : "") + ".",
        [["Retry", "retry", true], ["Shoot without translation", "plain", false]]);
      if (a === "retry") continue;
      return a === "plain" ? null : "cancel";
    }
  }

  const armEsc = () => { escHandler = (e) => { if (e.key === "Escape") { aborted = true; } }; window.addEventListener("keydown", escHandler, true); };

  // Height a pass actually covered, so an inner-scroll page that wouldn't move
  // stores a rect matching the pixels captured instead of a tall blank canvas.
  function coveredRect(effRect, shotN, planned) {
    if (shotN >= planned) return { rect: effRect, cut: false };
    const h = Math.min(effRect.h, (maxReachedY - effRect.y) + innerHeight);
    return { rect: { x: effRect.x, y: effRect.y, w: effRect.w, h: Math.max(1, h) }, cut: true };
  }

  async function capture(rect0, mode, layout, target) {
    scroll0 = { x: scrollX, y: scrollY };
    maxReachedY = scroll0.y;
    // Provisional rect for BEGIN + block collection (full = whole doc, pre-swap).
    const baseRect = mode === "full" ? { x: rect0.x, y: 0, w: rect0.w, h: docHeight() } : rect0;
    const begin = await send({ type: "SHOT_BEGIN", url: location.href, title: document.title, mode, layout, rect: baseRect, dpr: devicePixelRatio, scrollX: scroll0.x, viewport: { w: innerWidth, h: innerHeight }, docH: docHeight() });
    if (!begin || !begin.ok) { toast("Capture failed — try again.", 3000); return; }
    const raw = collectBlocks(baseRect);
    const prep = S().prepBlocks(raw.map((b) => ({ id: b.id, text: b.text, rect: b.rect })));
    const byId = new Map(raw.map((b) => [b.id, b]));
    armEsc(); // catch Esc during the translate wait too, not only during tiles
    let tr = null, note = "", partial = false;
    if (prep.lines.length) {
      setPill("Translating " + prep.lines.length + " blocks…", 0);
      const t = await translateLines(prep.lines);
      setPill("");
      if (t === "cancel" || aborted) { await send({ type: "SHOT_ABORT" }); return; }
      if (t && t.sameLang) note = "same";
      else if (t && t.noKey) note = "no-key"; // shoot the original; translation needs a key/language
      else if (t && t.ok) { tr = t.tr; partial = !!t.partial; }
    }
    const mapped = S().mapTranslations(prep.keep, prep.lineOf, tr || []);
    const blocks = mapped.blocks.map((b) => { const live = byId.get(b.id); return { id: b.id, text: b.text, tr: tr ? b.tr : "", rect: b.rect, el: live.el, nodes: live.nodes }; });
    // Two passes (original + translated) only when the shot fits one viewport;
    // multi-tile shots capture ONLY the chosen layout (Original via re-shoot) to
    // halve the rate-limited captures. The variant pass is planned AFTER the swap
    // so bilingual/longer-text reflow can't push content past the last tile.
    // Two passes (instant Original↔Translated toggle) only for a single-viewport
    // TRANSLATED shot: bilingual reliably reflows taller, so it's always
    // single-pass (planned after the swap). `passes` may still drop to
    // variant-only below if a translated swap grows the page past its plan.
    const twoPass = tr && layout === "translated" && planPass(baseRect, mode).offsets.length === 1;
    let passes = tr ? (twoPass ? ["original", "variant"] : ["variant"]) : ["original"];
    let effRect = baseRect, effCut = false;
    try {
      if (!tr) {
        const pl = planPass(baseRect, mode); effRect = pl.rect;
        const n = await shootPass("original", pl.offsets, 0, pl.offsets.length);
        const c = coveredRect(pl.rect, n, pl.offsets.length); effRect = c.rect; effCut = pl.truncated || c.cut;
      } else if (twoPass) {
        const plPre = planPass(baseRect, mode); effRect = plPre.rect;
        await shootPass("original", plPre.offsets, 0, plPre.offsets.length * 2);
        swap(layout, blocks, target);
        if (verifySwap(blocks) < 0.9) { unswap(); swap(layout, blocks, target); }
        if (verifySwap(blocks) < 0.9) partial = true;
        const plVar = planPass(baseRect, mode); // re-plan from the swapped layout
        if (plVar.offsets.length > plPre.offsets.length) {
          // The translation reflowed the page past its one-tile plan: the two
          // views now differ in height. Keep only the (correct) translated
          // layout; the Original view renders on demand via re-shoot.
          passes = ["variant"];
          const n = await shootPass("variant", plVar.offsets, 0, plVar.offsets.length);
          const c = coveredRect(plVar.rect, n, plVar.offsets.length); effRect = c.rect; effCut = plVar.truncated || c.cut;
        } else {
          await shootPass("variant", plPre.offsets, plPre.offsets.length, plPre.offsets.length * 2);
        }
      } else {
        swap(layout, blocks, target);
        if (verifySwap(blocks) < 0.9) { unswap(); swap(layout, blocks, target); }
        if (verifySwap(blocks) < 0.9) partial = true;
        const pl = planPass(baseRect, mode); // post-swap layout
        const n = await shootPass("variant", pl.offsets, 0, pl.offsets.length);
        const c = coveredRect(pl.rect, n, pl.offsets.length); effRect = c.rect; effCut = pl.truncated || c.cut;
      }
    } catch (e) {
      restore(); setPill("");
      await send({ type: "SHOT_ABORT" });
      if (e && e.message !== "cancel") toast("Capture failed — try a smaller area.", 3500);
      return;
    } finally { restore(); }
    const truncated = prep.truncated || (effCut ? "height" : "");
    setPill("Saving…", 1);
    const res = await send({ type: "SHOT_COMPOSE", rect: effRect, blocks: blocks.map((b) => ({ id: b.id, text: b.text, tr: b.tr, rect: b.rect })), partial, truncated, passes, sameLang: note === "same", noKey: note === "no-key" });
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
      } catch (e) { cleanupAll(); return; }
      await capture(rect, mode, layout, target);
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
        blocks.push({ id: String(b.id), text: live.text, tr: String(b.tr || ""), rect: live.rect, el: live.el, nodes: live.nodes });
      }
      let partial = false;
      const original = msg.layout === "original"; // capture the page as-is, no swap
      armEsc();
      let effRect = msg.rect, effCut = false;
      try {
        if (!original) {
          swap(msg.layout, blocks, msg.target);
          if (verifySwap(blocks) < 0.9) { unswap(); swap(msg.layout, blocks, msg.target); }
          if (verifySwap(blocks) < 0.9) partial = true;
        }
        const pl = planPass(msg.rect, mode); effRect = pl.rect;
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
      run(String(msg.mode || "visible"), msg.layout === "bilingual" ? "bilingual" : "translated", String(msg.target || ""));
      return;
    }
    if (msg.type === "SV_SHOT_RESHOOT") {
      reshoot(msg).then(sendResponse, () => sendResponse({ ok: false, error: "capture" }));
      return true;
    }
  });
})();
