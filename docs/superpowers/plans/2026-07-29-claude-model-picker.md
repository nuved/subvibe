# Claude Model Picker (Sonnet 5 / Haiku 4.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manual Claude-model picker (Sonnet 5 default, Haiku 4.5 alternative) in the popup's Translate tab, honored per-call by the background translator and by the spend estimator.

**Architecture:** One new global storage key `claudeModel` flows popup → storage → `translateAll` (resolved once per batch against an allowlist, threaded to the chunk function and the Activity log). The popup row is always visible and dims+inerts when the engine isn't Claude (no layout shift). Pricing keys Claude rates off the row's `model`, not just `provider`.

**Tech Stack:** Vanilla JS MV3 extension (no build step), `node --test` for shared modules, direct `fetch` to `api.anthropic.com/v1/messages`.

**Spec:** `docs/superpowers/specs/2026-07-29-claude-model-picker-design.md`

## Global Constraints

- Model IDs exactly `"claude-sonnet-5"` and `"claude-haiku-4-5"`; default `"claude-sonnet-5"`; unknown stored values resolve to the default (fail closed).
- Sonnet 4.6 is removed as an option (silent upgrade).
- `claudeModel` is global-only: NOT in popup `CLIP_FIELDS`, NOT in content-script `LIVE_KEYS` (both already exclude it by default — do not add it to either).
- `thinking: {type:"disabled"}` is sent for Sonnet 5 only; the field is OMITTED for Haiku 4.5.
- The picker row never appears/disappears — it dims and gets the `inert` attribute when the engine isn't Claude.
- Commits: author as the repo's configured user, no AI/co-author trailers (house rule).
- Rates: Sonnet 5 $3/$15 per 1M in/out (list), Haiku 4.5 $1/$5. Anthropic cache read = 10% and cache write = 125% of the model's own input rate.

---

### Task 1: Per-model Claude pricing (`shared/pricing.js`) — TDD

**Files:**
- Modify: `shared/pricing.js` (the `estCost` closure and exports)
- Test: `tools/tests/pricing.test.mjs` (create)

**Interfaces:**
- Consumes: existing `globalThis.SV_PRICING.estCost(c)` where `c = {provider, model, inTok, outTok, cacheR, cacheW, kind, durMs}`.
- Produces: `estCost` honors `c.model` when `c.provider === "claude"` (`/haiku/` → $1/$5, else $3/$15); new exports `HAIKU_PRICE_IN`, `HAIKU_PRICE_OUT`. Existing exports unchanged.

- [ ] **Step 1: Write the failing test**

Create `tools/tests/pricing.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/pricing.js";

const P = globalThis.SV_PRICING;
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("openai rows use gpt-4o-mini rates", () => {
  close(P.estCost({ provider: "openai", inTok: 1e6, outTok: 1e6 }), 0.15 + 0.60);
});

test("claude sonnet rows (any non-haiku model) use $3/$15", () => {
  close(P.estCost({ provider: "claude", model: "claude-sonnet-5", inTok: 1e6, outTok: 1e6 }), 3 + 15);
  // Legacy rows without a model field keep the sonnet rates (no undercount).
  close(P.estCost({ provider: "claude", inTok: 1e6, outTok: 1e6 }), 3 + 15);
});

test("claude haiku rows use $1/$5", () => {
  close(P.estCost({ provider: "claude", model: "claude-haiku-4-5", inTok: 1e6, outTok: 1e6 }), 1 + 5);
});

test("cache read/write bill at 10%/125% of the MODEL's input rate", () => {
  close(P.estCost({ provider: "claude", model: "claude-haiku-4-5", cacheR: 1e6, cacheW: 1e6 }), 1 * 0.1 + 1 * 1.25);
  close(P.estCost({ provider: "claude", model: "claude-sonnet-5", cacheR: 1e6, cacheW: 1e6 }), 3 * 0.1 + 3 * 1.25);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/tests/pricing.test.mjs`
Expected: the haiku test FAILS (haiku rows currently bill at $3/$15).

- [ ] **Step 3: Implement per-model rates**

In `shared/pricing.js`, below the `CLAUDE_PRICE_IN/OUT` consts, add:

```js
  // Claude Haiku 4.5 — $1 / MTok input, $5 / MTok output (list price).
  const HAIKU_PRICE_IN = 1 / 1e6, HAIKU_PRICE_OUT = 5 / 1e6;
```

Replace the `isClaude` block inside `estCost` (the `const isClaude = ...` line through the `if (isClaude) usd += ...` line) with:

```js
    const isClaude = c && c.provider === "claude";
    // Two Claude tiers since the model became selectable; rows without a model
    // field predate the picker and were all Sonnet — keep Sonnet rates for them.
    const isHaiku = isClaude && /haiku/.test((c && c.model) || "");
    const pin = isHaiku ? HAIKU_PRICE_IN : isClaude ? CLAUDE_PRICE_IN : PRICE_IN;
    const pout = isHaiku ? HAIKU_PRICE_OUT : isClaude ? CLAUDE_PRICE_OUT : PRICE_OUT;
    let usd = ((c && c.inTok) || 0) * pin + ((c && c.outTok) || 0) * pout;
    // Anthropic bills cached prompt reads at 10% and cache writes at 125% of the
    // model's own input price; those token counts arrive SEPARATE from
    // input_tokens. (OpenAI folds cached tokens into prompt_tokens — its
    // automatic 50% discount isn't modeled here, so OpenAI estimates read
    // slightly high, never low.)
    if (isClaude) usd += ((c && c.cacheR) || 0) * pin * 0.1 + ((c && c.cacheW) || 0) * pin * 1.25;
    return usd;
```

Add the two new names to the exports object:

```js
  g.SV_PRICING = {
    PRICE_IN, PRICE_OUT, CLAUDE_PRICE_IN, CLAUDE_PRICE_OUT, HAIKU_PRICE_IN, HAIKU_PRICE_OUT, GEMINI_TTS_USD_PER_MIN, estCost,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tools/tests/*.test.mjs`
Expected: all PASS (23 existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add shared/pricing.js tools/tests/pricing.test.mjs
git commit -m "Pricing learns the Claude tiers apart: haiku rows bill at \$1/\$5, sonnet at \$3/\$15, and the cache multipliers follow each model's own input rate"
```

---

### Task 2: Background resolves the model per call (`background.js`)

**Files:**
- Modify: `background.js` — the `CLAUDE_MODEL` const (line ~19), `translateChunkClaude` (~390), `translateAll` (~450), and the catch-path `logCall` in the `TRANSLATE` message handler (~763).

**Interfaces:**
- Consumes: storage key `claudeModel` (written by Task 3's popup; absent for existing users).
- Produces: `resolveClaudeModel(v) → "claude-sonnet-5" | "claude-haiku-4-5"`; `translateChunkClaude(lines, source, target, apiKey, context, keepTerms, keepNames, model)` (new trailing `model` param; `translateChunk` — the OpenAI path — receives and ignores the same 8th argument).

- [ ] **Step 1: Replace the constant with an allowlist resolver**

Replace `const CLAUDE_MODEL = "claude-sonnet-4-6";` (line ~19) with:

```js
// The Claude model is user-selectable (popup → storage key `claudeModel`).
// Resolve through an allowlist so corrupted/stale storage can never put an
// unknown model id on the wire — unknown values fall back to Sonnet 5.
const CLAUDE_MODELS = ["claude-sonnet-5", "claude-haiku-4-5"];
const resolveClaudeModel = (v) => (CLAUDE_MODELS.includes(v) ? v : CLAUDE_MODELS[0]);
```

- [ ] **Step 2: Thread the model through `translateAll`**

In `translateAll` (~line 451), add `claudeModel` to the storage read and resolve once:

```js
  const { apiKey, anthropicKey, keepTerms, keepNames, translationProvider, claudeModel } =
    await chrome.storage.local.get(["apiKey", "anthropicKey", "keepTerms", "keepNames", "translationProvider", "claudeModel"]);
```

Replace `const model = provider === "claude" ? CLAUDE_MODEL : TRANSLATE_MODEL;` with:

```js
  const model = provider === "claude" ? resolveClaudeModel(claudeModel) : TRANSLATE_MODEL;
```

In `chunkSplit`, pass the model as the 8th argument:

```js
      return await chunkFn(chunk, source, target, key, ctx, keepTerms, keepN, model);
```

(`translateChunk`, the OpenAI path, ignores the extra argument — do not change its signature.)

- [ ] **Step 3: `translateChunkClaude` uses the threaded model + thinking guard**

Change its signature (~line 390):

```js
async function translateChunkClaude(lines, source, target, apiKey, context, keepTerms, keepNames, model) {
```

Replace the `body` construction (`model: CLAUDE_MODEL, ... thinking: { type: "disabled" },`) with:

```js
  const body = {
    model,
    max_tokens: CLAUDE_MAX_TOKENS,
    // cache_control: the system prompt is cache-stable (see systemPrompt) — on
    // cache hits its tokens bill at ~10% instead of full price. Engages only
    // once the prefix clears Anthropic's ~1024-token minimum (the Persian
    // prompt with examples does; a shorter one is silently uncached, no harm).
    system: [{ type: "text", text: systemPrompt(source, target, keepTerms, keepNames), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: JSON.stringify(userPayload) }],
    output_config: { format: { type: "json_schema", schema: TRANSLATE_SCHEMA.schema } },
  };
  // Sonnet 5: omitting `thinking` silently turns ADAPTIVE thinking ON — seconds
  // and output tokens per batch for zero gain on mechanical structured
  // translation. Haiku 4.5 (older generation): no-thinking is already the
  // default and the explicit `disabled` type is not accepted there — omit it.
  if (!/haiku/.test(model)) body.thinking = { type: "disabled" };
```

- [ ] **Step 4: Haiku structured-output fallback (schema-in-prompt)**

Inside `translateChunkClaude`'s retry loop, the non-ok branch currently ends with `if (!TRANSIENT_HTTP.has(res.status)) break;`. Insert BEFORE that line:

```js
    // Haiku + structured outputs: if this model generation rejects
    // output_config (400 naming it), drop to schema-in-prompt once — the
    // system prompt already dictates the {t,s,g,d} JSON shape and the parser
    // tolerates plain JSON text. Logged so the Activity mystery is solvable.
    if (res.status === 400 && body.output_config && /output_config|output_format/i.test(txt || "")) {
      console.info("[SubVibe] " + model + " rejected output_config — retrying schema-in-prompt");
      delete body.output_config;
      continue;
    }
```

(Note: `continue` re-enters the loop; the `attempt` counter still bounds total tries at 3.)

- [ ] **Step 5: Fix the catch-path Activity row**

In the `TRANSLATE` message handler's catch block (~line 761), the storage read and model:

```js
            const { translationProvider, claudeModel } = await chrome.storage.local.get(["translationProvider", "claudeModel"]);
            const provider = translationProvider === "claude" ? "claude" : "openai";
            await logCall({ ...meta, ms: Date.now() - started, inTok: 0, outTok: 0, ok: false, err: String((e && e.message) || e), provider, model: provider === "claude" ? resolveClaudeModel(claudeModel) : TRANSLATE_MODEL });
```

- [ ] **Step 6: Verify no stale references, syntax-check**

Run: `grep -n "CLAUDE_MODEL\b" background.js`
Expected: no matches (only `CLAUDE_MODELS`/`resolveClaudeModel`/`CLAUDE_MAX_TOKENS` remain).
Run: `node --check background.js`
Expected: silent success.

- [ ] **Step 7: Commit**

```bash
git add background.js
git commit -m "The Claude translator takes its model from the picker: allowlist-resolved per batch, threaded into the Activity log, thinking pinned off on Sonnet 5 and omitted on Haiku, with a one-shot schema-in-prompt retry if Haiku rejects output_config"
```

---

### Task 3: Popup picker row (`popup.html`, `popup.js`)

**Files:**
- Modify: `popup.html` — the Translation-engine `<section>` (~line 279) and the `<style>` block (near `.rowlbl`, ~line 113).
- Modify: `popup.js` — `DEFAULTS` (line 10), `TRANSLATION_OPTIONS` (line 289), the `translationProvider` change handler (~321), `load()` (~784).

**Interfaces:**
- Consumes: `persist(obj)` (global write + "Saved" flash), `state`, `el(id)`.
- Produces: storage key `claudeModel`; DOM ids `claudeModelRow`; CSS classes `.seg2`, `.segopt`, `.segopt.on`, `#claudeModelRow.dim`; function `updateClaudeModelUI()`.

- [ ] **Step 1: Markup — the always-present row**

In `popup.html`, inside the Translation-engine `<section>`, after the `<div id="translationProviderWarn" ...>` line, add:

```html
    <div class="row" id="claudeModelRow">
      <span class="rowlbl">Claude model</span>
      <div class="seg2" role="radiogroup" aria-label="Claude model">
        <button type="button" class="segopt" data-model="claude-sonnet-5"><b>Sonnet 5</b><small>best quality</small></button>
        <button type="button" class="segopt" data-model="claude-haiku-4-5"><b>Haiku 4.5</b><small>fastest, ~3× cheaper</small></button>
      </div>
    </div>
```

- [ ] **Step 2: Styles — segmented control + dim state**

In the `<style>` block, after the `.rowlbl` rule, add:

```css
    .seg2 { flex: 1; display: flex; gap: 6px; }
    .segopt { flex: 1; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); color: var(--text); cursor: pointer; text-align: center; font-weight: 400; font-size: 12.5px; }
    .segopt b { display: block; font-weight: 600; }
    .segopt small { display: block; margin-top: 1px; font-size: 10.5px; color: var(--muted); }
    .segopt.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--panel)); }
    #claudeModelRow.dim { opacity: .45; }
```

(Tokens verified against this popup's `:root` — `--panel` is the input/select surface, `--border`/`--accent`/`--muted`/`--radius` as used by the adjacent rules. The base `button` rule sets `border: 0` + bold — `.segopt` overrides both, which is why the border and font-weight are restated here.)

- [ ] **Step 3: Wire it in `popup.js`**

Line 10, add to `DEFAULTS` (after `translationProvider: "openai",`):

```js
claudeModel: "claude-sonnet-5",
```

Line 289, the engine label no longer names one model:

```js
const TRANSLATION_OPTIONS = [["openai", "OpenAI GPT-4o-mini"], ["claude", "Claude (model below)"]];
```

After the `translationProvider` change-handler block (~line 324), add:

```js
// ── Claude model picker: always visible; dim+inert unless the engine is Claude ──
function updateClaudeModelUI() {
  const isClaude = el("translationProvider").value === "claude";
  const row = el("claudeModelRow");
  row.classList.toggle("dim", !isClaude);
  // `inert` (not pointer-events): keyboard focus must not reach a dimmed
  // control — a prior review caught Tab+Enter activating a pointer-blocked one.
  if (isClaude) row.removeAttribute("inert"); else row.setAttribute("inert", "");
  for (const b of row.querySelectorAll(".segopt")) b.classList.toggle("on", b.dataset.model === (state.claudeModel || "claude-sonnet-5"));
}
for (const b of document.querySelectorAll("#claudeModelRow .segopt")) {
  b.addEventListener("click", () => { state.claudeModel = b.dataset.model; persist({ claudeModel: state.claudeModel }); updateClaudeModelUI(); });
}
```

In the existing `translationProvider` change handler (line ~321), add a call after `updateProviderAvailability();`:

```js
  updateClaudeModelUI();
```

In `load()`, after `el("translationProvider").value = ...` (line ~784), add:

```js
  updateClaudeModelUI();
```

(`claudeModel` is loaded automatically — `load()` reads `Object.keys(DEFAULTS)`. It must NOT be added to `CLIP_FIELDS`.)

- [ ] **Step 4: Syntax check + eye check**

Run: `node --check popup.js`
Expected: silent success.
Open the popup (extension reload → toolbar icon): with OpenAI selected the row is visible but dimmed and Tab skips it; switching to Claude un-dims it; clicking Haiku persists (reopen popup → still Haiku, "Saved" flashed); no layout shift when switching engines.

- [ ] **Step 5: Commit**

```bash
git add popup.html popup.js
git commit -m "Translate tab grows a Claude model row that never jumps the layout: Sonnet 5 and Haiku 4.5 as a two-tier segmented pair, dimmed and inert while another engine drives"
```

---

### Task 4: Verification sweep

**Files:** none created — checks only.

- [ ] **Step 1: Full test + syntax pass**

Run: `node --test tools/tests/*.test.mjs && node --check background.js && node --check popup.js && node --check shared/pricing.js`
Expected: all tests PASS, all checks silent.

- [ ] **Step 2: Optional live Haiku structured-output probe (only if `ant` credentials exist on this machine)**

Run: `ant auth status`
If it reports an active credential source:

```bash
TOKEN=$(ant auth print-credentials --access-token)
curl -s https://api.anthropic.com/v1/messages \
  -H "Authorization: Bearer $TOKEN" -H "anthropic-beta: oauth-2025-04-20" \
  -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":64,"output_config":{"format":{"type":"json_schema","schema":{"type":"object","properties":{"t":{"type":"array","items":{"type":"string"}}},"required":["t"],"additionalProperties":false}}},"messages":[{"role":"user","content":"Translate to German, reply as {\"t\":[...]}: [\"hello\"]"}]}' | head -c 400
```

Expected either: a JSON response with `"content"` (→ Haiku supports `output_config`; the Task 2 fallback simply never fires) or a 400 naming `output_config` (→ the fallback carries it; no code change needed either way). If no credentials: skip — the defensive fallback ships regardless.

- [ ] **Step 3: Operator acceptance (hand off)**

Reload the extension, open a YouTube video with the Claude engine + a valid Anthropic key: flip Sonnet 5 ↔ Haiku 4.5 mid-video, confirm the engine restarts, the Activity log's model column shows the flip, and compare latency + Today cost between models. Ear test translation quality per model.
