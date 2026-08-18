# Simplify Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right-click any selected text on any site → "Simplify with SubVibe" → floating card with a same-language simpler rewrite (+ key-point bullets for long selections).

**Architecture:** A `contextMenus`+`activeTab` flow: background creates the menu item, on click injects `content/reader.js`/`styles/reader.css` on demand and messages the tab; the card sends `SIMPLIFY_TEXT` back to background, which calls OpenAI or Anthropic using the extension's existing key/provider storage. Response shaping lives in a pure shared module so it's unit-testable.

**Tech Stack:** Chrome MV3 (vanilla JS, no build step), `node --test` for unit tests.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-18-simplify-reader-design.md`.
- No new host permissions; only `"contextMenus"` and `"activeTab"` added to `permissions`.
- Nothing injected into any page until the user clicks the context-menu item.
- Same-language rewrite only; target CEFR = stored `readerLevel` (chrome.storage.local) or `"B1"` default.
- Selection capped at 6000 chars; bullets only when input > 600 chars.
- Shared modules attach to `globalThis` via the repo's `(function (g) { g.SV_X = {...} })(globalThis)` pattern (see `shared/textslice.js`).
- Commits are authored plainly as the operator (no AI trailers), per house rules.

---

### Task 1: `shared/simplify.js` — prompt builder + response validator

**Files:**
- Create: `shared/simplify.js`
- Test: `tools/tests/simplify.test.mjs`

**Interfaces:**
- Produces: `globalThis.SV_SIMPLIFY = { MAX_CHARS: 6000, LONG_CHARS: 600, prep(text), buildMessages(text, level), parse(raw) }`
  - `prep(text)` → `{ text, truncated }` — trims, collapses >2 blank lines, cuts at 6000 chars on a word boundary.
  - `buildMessages(text, level)` → `[{role:"system",content}, {role:"user",content}]` (OpenAI chat shape; the Anthropic caller reuses `[0].content` as system and `[1].content` as the user turn).
  - `parse(raw)` → `{ simple, points }` or throws `Error("bad-response")`. `points` always an array of trimmed non-empty strings, max 4; `simple` a non-empty string. Tolerates the model wrapping JSON in ```json fences.

- [ ] **Step 1: Write the failing test**

```js
// tools/tests/simplify.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/simplify.js";

const S = globalThis.SV_SIMPLIFY;

test("prep trims and flags truncation", () => {
  const short = S.prep("  hello world \n\n\n\n again ");
  assert.equal(short.truncated, false);
  assert.equal(short.text, "hello world\n\nagain");
  const long = S.prep("word ".repeat(2000)); // 10000 chars
  assert.equal(long.truncated, true);
  assert.ok(long.text.length <= S.MAX_CHARS);
  assert.ok(!long.text.endsWith(" wor")); // word-boundary cut
});

test("buildMessages embeds level, language rule, and bullet rule by length", () => {
  const short = S.buildMessages("Ein kurzer Satz.", "B1");
  assert.equal(short[0].role, "system");
  assert.match(short[0].content, /SAME language/);
  assert.match(short[0].content, /B1/);
  assert.match(short[1].content, /Ein kurzer Satz\./);
  assert.match(short[0].content, /"points": \[\]/); // short input: empty points demanded
  const long = S.buildMessages("x".repeat(700), "A2");
  assert.match(long[0].content, /2.4 key.point/i); // long input: bullets demanded
});

test("parse accepts clean and fenced JSON, normalizes points", () => {
  const ok = S.parse('{"simple":"Easy text.","points":["  a ", "", "b", "c", "d", "e"]}');
  assert.equal(ok.simple, "Easy text.");
  assert.deepEqual(ok.points, ["a", "b", "c", "d"]); // trimmed, empties dropped, capped at 4
  const fenced = S.parse('```json\n{"simple":"S.","points":[]}\n```');
  assert.equal(fenced.simple, "S.");
  assert.deepEqual(fenced.points, []);
});

test("parse throws on garbage", () => {
  assert.throws(() => S.parse("not json"), /bad-response/);
  assert.throws(() => S.parse('{"points":[]}'), /bad-response/); // missing simple
  assert.throws(() => S.parse('{"simple":""}'), /bad-response/); // empty simple
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/tests/simplify.test.mjs`
Expected: FAIL — `shared/simplify.js` does not exist (module load error).

- [ ] **Step 3: Write the implementation**

```js
// shared/simplify.js
// Prompt building + response validation for the Simplify Reader card.
// Pure (no chrome.*) so tools/tests/simplify.test.mjs can load it in node.
(function (g) {
  const MAX_CHARS = 6000;
  const LONG_CHARS = 600;

  function prep(text) {
    let t = String(text || "").trim().replace(/\n{3,}/g, "\n\n");
    let truncated = false;
    if (t.length > MAX_CHARS) {
      t = t.slice(0, MAX_CHARS);
      const sp = t.lastIndexOf(" ");
      if (sp > MAX_CHARS - 80) t = t.slice(0, sp);
      t = t.trimEnd();
      truncated = true;
    }
    return { text: t, truncated };
  }

  function buildMessages(text, level) {
    const long = text.length > LONG_CHARS;
    const pointsRule = long
      ? 'Also give 2-4 key-point bullets in "points" (same language, one short sentence each).'
      : 'Set "points": [] (input is short).';
    const system =
      "Rewrite the user's text in the SAME language it is written in. " +
      "Make it simpler: short sentences, common words. Keep all names, numbers and facts. " +
      `Target CEFR level ${level}. ${pointsRule} ` +
      'Reply with ONLY JSON: {"simple": "...", "points": [...]}.';
    return [
      { role: "system", content: system },
      { role: "user", content: text },
    ];
  }

  function parse(raw) {
    let s = String(raw || "").trim();
    const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (fence) s = fence[1];
    let obj;
    try { obj = JSON.parse(s); } catch { throw new Error("bad-response"); }
    if (!obj || typeof obj.simple !== "string" || !obj.simple.trim()) throw new Error("bad-response");
    const points = Array.isArray(obj.points)
      ? obj.points.map((p) => String(p).trim()).filter(Boolean).slice(0, 4)
      : [];
    return { simple: obj.simple.trim(), points };
  }

  g.SV_SIMPLIFY = { MAX_CHARS, LONG_CHARS, prep, buildMessages, parse };
})(globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/tests/simplify.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/simplify.js tools/tests/simplify.test.mjs
git commit -m "Simplify Reader: shared prompt/parse module with tests"
```

---

### Task 2: background — context menu, on-demand injection, SIMPLIFY_TEXT handler

**Files:**
- Modify: `manifest.json` (permissions array, ~line 14)
- Modify: `background.js` (top-of-file importScripts if present, context-menu setup, message switch at ~line 1242)

**Interfaces:**
- Consumes: `SV_SIMPLIFY.prep/buildMessages/parse` from Task 1; existing constants `OPENAI_CHAT`, `ANTHROPIC_MESSAGES`, `ANTHROPIC_VERSION` in `background.js`; storage keys `apiKey`, `anthropicKey`, `translationProvider`, `claudeModel`, `readerLevel`.
- Produces: message contract used by Task 3:
  - tab receives `{ type: "SV_SIMPLIFY_OPEN", fallbackText: string }` after menu click
  - `chrome.runtime.sendMessage({ type: "SIMPLIFY_TEXT", text })` → `{ ok: true, simple, points, truncated }` or `{ ok: false, error }` where `error` ∈ `"no-key" | "bad-response" | "http-<status>" | "network"`.

- [ ] **Step 1: Manifest — add permissions**

In `manifest.json` `permissions`, append `"contextMenus"` and `"activeTab"`:

```json
  "permissions": [
    "storage",
    "unlimitedStorage",
    "offscreen",
    "tabCapture",
    "contextMenus",
    "activeTab"
  ],
```

- [ ] **Step 2: Load the shared module in the service worker**

`background.js` is a classic (non-module) service worker. Near the top (after the existing header comments, before first use), add:

```js
importScripts("shared/simplify.js"); // SV_SIMPLIFY: prompt build + response parse
```

(If `background.js` already has `importScripts(...)` calls, append `"shared/simplify.js"` to that list instead of adding a second call.)

- [ ] **Step 3: Context menu creation + click → inject + message**

Add near the other top-level listeners in `background.js`:

```js
// ---- Simplify Reader: right-click "Simplify with SubVibe" on any selection.
// Nothing is injected anywhere until the user clicks the menu item (activeTab).
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "svSimplify",
    title: "Simplify with SubVibe",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "svSimplify" || !tab || tab.id == null) return;
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["styles/reader.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/reader.js"] });
    await chrome.tabs.sendMessage(tab.id, {
      type: "SV_SIMPLIFY_OPEN",
      fallbackText: info.selectionText || "",
    });
  } catch (e) {
    // chrome://, Web Store, PDFs: injection is refused. Flag it on the badge.
    chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    chrome.action.setTitle({ tabId: tab.id, title: "SubVibe: can't run on this page" });
  }
});
```

Note: `chrome.scripting` needs `"scripting"` in permissions **only if not already present** — check; SubVibe currently has no `"scripting"` entry, so add it in Step 1's array too:

```json
    "scripting",
```

- [ ] **Step 4: SIMPLIFY_TEXT handler**

Add a helper function near the other API callers in `background.js`:

```js
async function simplifyText(rawText) {
  const { apiKey, anthropicKey, translationProvider, claudeModel, readerLevel } =
    await chrome.storage.local.get(["apiKey", "anthropicKey", "translationProvider", "claudeModel", "readerLevel"]);
  const provider = translationProvider === "claude" ? "claude" : "openai";
  const key = provider === "claude" ? anthropicKey : apiKey;
  if (!key) return { ok: false, error: "no-key" };

  const { text, truncated } = SV_SIMPLIFY.prep(rawText);
  if (!text) return { ok: false, error: "bad-response" };
  const messages = SV_SIMPLIFY.buildMessages(text, readerLevel || "B1");

  let raw;
  try {
    if (provider === "claude") {
      const res = await fetch(ANTHROPIC_MESSAGES, {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: claudeModel || "claude-haiku-4-5-20251001",
          max_tokens: 2048,
          system: messages[0].content,
          messages: [{ role: "user", content: messages[1].content }],
        }),
      });
      if (!res.ok) return { ok: false, error: "http-" + res.status };
      const data = await res.json();
      const blk = (data.content || []).find((b) => b && b.type === "text");
      raw = blk && blk.text;
    } else {
      const res = await fetch(OPENAI_CHAT, {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages, response_format: { type: "json_object" } }),
      });
      if (!res.ok) return { ok: false, error: "http-" + res.status };
      const data = await res.json();
      raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    }
  } catch {
    return { ok: false, error: "network" };
  }

  try {
    const { simple, points } = SV_SIMPLIFY.parse(raw);
    return { ok: true, simple, points, truncated };
  } catch {
    return { ok: false, error: "bad-response" };
  }
}
```

**Model names:** before committing, mirror whatever defaults the existing `TRANSLATE` path uses (read the code around `background.js:650`/`710`) rather than the literals above — reuse the same default-model constants if they exist.

Then add the case inside the `switch (msg && msg.type)` block (around line 1242):

```js
        case "SIMPLIFY_TEXT": {
          simplifyText(msg.text).then(sendResponse);
          return; // async sendResponse; listener already returns true below
        }
```

Match the switch's existing async convention: every other async case in this switch keeps `sendResponse` alive the same way — copy exactly what `TRANSLATE` does (whether that's `return true` from the listener or per-case).

- [ ] **Step 5: Lint-level check + existing tests still pass**

Run: `node --check background.js && node --test tools/tests/`
Expected: syntax OK; all existing tests + Task 1 tests PASS. (The handler itself is exercised manually in Task 4 — it's all chrome.* and network.)

- [ ] **Step 6: Commit**

```bash
git add manifest.json background.js
git commit -m "Simplify Reader: context menu, on-demand injection, SIMPLIFY_TEXT background handler"
```

---

### Task 3: `content/reader.js` + `styles/reader.css` — the card

**Files:**
- Create: `content/reader.js`
- Create: `styles/reader.css`

**Interfaces:**
- Consumes: `SV_SIMPLIFY_OPEN` tab message `{ fallbackText }`; `SIMPLIFY_TEXT` runtime message → `{ ok, simple, points, truncated }` / `{ ok:false, error }` (Task 2).
- Produces: nothing consumed by other tasks; end-user UI.

- [ ] **Step 1: Write `content/reader.js`**

```js
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
```

Note on the spec's `elementFromPoint` concern: that pattern exists for the video overlay's drag-retargeting; the card here is a shadow-DOM fixed element receiving direct events, so plain listeners suffice. The `mousedown` dismiss listener uses capture phase so X/Instagram can't swallow it.

- [ ] **Step 2: Write `styles/reader.css`**

Match the Daylight look used by `styles/overlay.css` (dark translucent card, system font). Since the stylesheet loads inside the shadow root, selectors are local:

```css
.sv-card {
  width: 380px; max-width: calc(100vw - 24px); max-height: 60vh; overflow-y: auto;
  background: rgba(24, 26, 32, 0.96); color: #f2f2f2;
  border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 12px;
  padding: 12px 14px; font: 14px/1.5 -apple-system, system-ui, sans-serif;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
}
.sv-head { font-size: 11px; letter-spacing: 0.4px; text-transform: uppercase; opacity: 0.65; margin-bottom: 8px; }
.sv-points { margin: 0 0 10px; padding-left: 18px; }
.sv-points li { margin: 3px 0; }
.sv-body { white-space: pre-wrap; }
.sv-note { margin-top: 8px; font-size: 12px; opacity: 0.6; }
.sv-err { color: #ffb4a9; margin-bottom: 8px; }
.sv-btn { background: #2f6fed; color: #fff; border: 0; border-radius: 8px; padding: 6px 14px; cursor: pointer; font: inherit; }
.sv-spin { width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.25); border-top-color: #fff; border-radius: 50%; animation: svspin 0.8s linear infinite; }
@keyframes svspin { to { transform: rotate(360deg); } }
```

Before committing, open `styles/overlay.css` and reuse its actual color tokens/values if they differ from the above so the card matches the shipped look.

- [ ] **Step 3: `web_accessible_resources` check**

The shadow root loads `styles/reader.css` via `chrome.runtime.getURL`. Content-script-inserted `<link>` inside a shadow root needs the file listed in `web_accessible_resources`. Add to `manifest.json` (merge with any existing block):

```json
  "web_accessible_resources": [
    { "resources": ["styles/reader.css"], "matches": ["<all_urls>"] }
  ]
```

(`matches: <all_urls>` here exposes only the CSS file, not a permission.)

- [ ] **Step 4: Syntax check**

Run: `node --check content/reader.js`
Expected: OK.

- [ ] **Step 5: Commit**

```bash
git add content/reader.js styles/reader.css manifest.json
git commit -m "Simplify Reader: on-demand card UI"
```

---

### Task 4: Manual acceptance pass

**Files:** none (verification only; fix-forward commits allowed).

- [ ] **Step 1: Load unpacked** — `chrome://extensions` → reload SubVibe. Confirm no service-worker errors in its console.
- [ ] **Step 2: Medium** — open any article, select 3+ paragraphs, right-click → Simplify. Expect: card with 2–4 bullets + rewrite, same language.
- [ ] **Step 3: X** — select a tweet's text, simplify. Expect: rewrite only, no bullets.
- [ ] **Step 4: Instagram** — select a caption, simplify. Expect: card renders and dismisses (Esc + click-outside both work).
- [ ] **Step 5: German page** — e.g. dw.com article paragraph. Expect: output in German, not English.
- [ ] **Step 6: No key** — temporarily clear the API key in the popup, simplify. Expect: "No API key set — open the SubVibe popup to add one." + Retry works after restoring the key.
- [ ] **Step 7: Restricted page** — try on `chrome://extensions`. Expect: no crash; badge shows "!" with the can't-run title.
- [ ] **Step 8: Full test suite** — `node --test tools/tests/` all green.
- [ ] **Step 9: Commit any fixes** — small fix commits per issue found; then done.
