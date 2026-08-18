// Simplify Reader card. Injected on demand by the context-menu click —
// never registered in the manifest. Guard so repeat clicks reuse one listener.
(function () {
  if (window.__svReader) return;
  window.__svReader = true;

  let host = null;

  function close() {
    if (host) { host.remove(); host = null; }
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onDown, true);
  }
  function onKey(e) { if (e.key === "Escape") close(); }
  function onDown(e) { if (host && !host.contains(e.target)) close(); }

  const ERRORS = {
    "no-key": "No API key set — open the SubVibe popup to add one.",
    "bad-response": "The AI answer couldn't be read. Try again.",
    network: "Network error. Check your connection and try again.",
  };
  const errText = (code) => ERRORS[code] || (String(code).startsWith("http-") ? "API error (" + code.slice(5) + "). Try again." : "Something went wrong.");

  function anchorRect() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r.width || r.height) return r;
    }
    return { top: 80, bottom: 100, left: innerWidth / 2 - 190, width: 0 };
  }

  function render(state, payload, text) {
    close();
    host = document.createElement("div");
    host.className = "sv-reader-host";
    const root = host.attachShadow({ mode: "closed" });
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("styles/reader.css");
    root.appendChild(link);

    const card = document.createElement("div");
    card.className = "sv-card";
    if (state === "loading") {
      card.innerHTML = '<div class="sv-head">SubVibe · simplifying…</div><div class="sv-spin"></div>';
    } else if (state === "error") {
      const p = document.createElement("div"); p.className = "sv-err"; p.textContent = payload;
      const btn = document.createElement("button"); btn.className = "sv-btn"; btn.textContent = "Retry";
      btn.addEventListener("click", () => run(text));
      card.innerHTML = '<div class="sv-head">SubVibe</div>';
      card.append(p, btn);
    } else {
      card.innerHTML = '<div class="sv-head">SubVibe · simple version</div>';
      if (payload.points.length) {
        const ul = document.createElement("ul"); ul.className = "sv-points";
        for (const pt of payload.points) { const li = document.createElement("li"); li.textContent = pt; ul.appendChild(li); }
        card.appendChild(ul);
      }
      const body = document.createElement("div"); body.className = "sv-body"; body.textContent = payload.simple;
      card.appendChild(body);
      if (payload.truncated) {
        const n = document.createElement("div"); n.className = "sv-note"; n.textContent = "Selection was long — simplified the first part.";
        card.appendChild(n);
      }
    }
    root.appendChild(card);

    const r = anchorRect();
    host.style.cssText = "position:fixed;z-index:2147483647;";
    host.style.left = Math.max(8, Math.min(innerWidth - 396, r.left)) + "px";
    host.style.top = Math.min(innerHeight - 120, r.bottom + 8) + "px";
    document.documentElement.appendChild(host);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
  }

  function run(text) {
    render("loading", null, text);
    chrome.runtime.sendMessage({ type: "SIMPLIFY_TEXT", text }, (res) => {
      if (chrome.runtime.lastError || !res) return render("error", errText("network"), text);
      if (!res.ok) return render("error", errText(res.error), text);
      render("done", res, text);
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "SV_SIMPLIFY_OPEN") {
      const live = String(window.getSelection() || "");
      run(live.trim() || msg.fallbackText || "");
    }
  });
})();
