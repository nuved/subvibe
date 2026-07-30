# Claude Model Picker — Sonnet 5 / Haiku 4.5

**Date:** 2026-07-29 · **Branch:** popup-ui (or its successor) · **Status:** approved design, awaiting spec review

## Purpose

Let the user choose which Claude model translates: quality-first (Sonnet 5) or
speed/cost-first (Haiku 4.5). Manual picker only — the user decides, SubVibe
never switches models on its own. Replaces the hardcoded `CLAUDE_MODEL =
"claude-sonnet-4-6"` constant; Sonnet 4.6 is not kept as an option.

## Decisions (made with the operator)

- **Shape:** manual picker. No automatic speed/quality split, no fallback chain.
- **Default:** `claude-sonnet-5` (same list price as Sonnet 4.6, intro-priced
  ~1/3 lower until 2026-08-31; existing users are silently upgraded).
- **Scope:** global setting (like the engine choice), not per-clip.
- **UI stability:** the model row never appears/disappears with the engine
  choice — it is always present and dims when not applicable (no layout shift).

## Storage

New global key `claudeModel`: `"claude-sonnet-5" | "claude-haiku-4-5"`.
Default `"claude-sonnet-5"` in both popup DEFAULTS and the background reader.
Not in `CLIP_FIELDS` (never per-clip). Not in the content script's `LIVE_KEYS`
(a change restarts the engine via the normal storage watcher, same as an
engine change).

## Popup (Translate tab)

- A `Claude model` row renders permanently under the engine row.
- Control: two-option segmented control (not a native `<select>` — it can't
  style two-tier labels). Each option: model name at normal weight plus a
  sub-label in the existing hint style (smaller, softer tint):
  - `Sonnet 5` — "best quality"
  - `Haiku 4.5` — "fastest, ~3× cheaper"
- When the selected engine is not Claude: the row keeps its place, dims, and
  gets the `inert` attribute — the same treatment as the Dub config block.
  `inert` (not pointer-events alone) so keyboard focus cannot reach it: a prior
  review caught a Tab+Enter path activating a pointer-blocked control.
- Saves via the normal global persist path: `persist({ claudeModel })`.

## Background (`background.js`)

- `translateChunkClaude` resolves the model per call from storage.
- Allowlist validation: anything other than the two known IDs falls back to
  `claude-sonnet-5` (corrupted storage cannot produce a garbage model ID on
  the wire).
- `logCall` records the resolved model, so Activity rows show what billed.
- `CLAUDE_MAX_TOKENS` and the batching/runway constants stay shared (Haiku is
  faster; the existing runway is more than sufficient).

### Per-model request-shape guards (verified against the current API reference)

- **Thinking:** keep `thinking: {type: "disabled"}` for Sonnet 5 (omitting it
  would silently enable adaptive thinking and slow every batch). For Haiku 4.5
  **omit the `thinking` field entirely** — no-thinking is its default and the
  explicit `disabled` type may be rejected on that model generation.
- **Structured outputs:** `output_config.format` must be verified on Haiku 4.5
  at implementation (one live call). If Haiku rejects it, the Haiku path falls
  back to schema-in-prompt JSON; the response parser already tolerates the
  `{t: [...]}` shape either way.

## Pricing (`shared/pricing.js`)

Add rates: Sonnet 5 $3/$15 per 1M in/out, Haiku 4.5 $1/$5. Use list prices —
the "Today" figure will slightly overstate Sonnet 5 spend until the intro
pricing ends 2026-08-31 (accepted; no dated switch).

## Out of scope

Auto-switching, fallback chains, per-clip model override, keeping Sonnet 4.6,
Dub/TTS provider changes (Claude is translation-only today).

## Testing

- `node --check` on touched files; existing `tools/tests/*.test.mjs` stay green.
- Manual: flip the picker mid-video → engine restarts, Activity log's model
  column flips, latency/cost columns compared between the two models.
- Operator acceptance: eye test (popup row dims correctly, no layout shift) +
  ear/eye test on translation quality per model.
