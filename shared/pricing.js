// SubVibe — per-provider pricing constants + cost estimator (pure logic, node-testable).
// Attached to globalThis so plain <script src> includes AND node:test share it.
// Extension-page-only (Library/popup) — NOT loaded as a content script.
(function (g) {
  const PRICE_IN = 0.15 / 1e6, PRICE_OUT = 0.60 / 1e6; // gpt-4o-mini, USD per token
  // Claude Sonnet 4.6 — verified via WebFetch against
  // https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-07-23):
  // $3 / MTok input, $15 / MTok output.
  const CLAUDE_PRICE_IN = 3 / 1e6, CLAUDE_PRICE_OUT = 15 / 1e6;
  // gemini-2.5-flash-preview-tts — verified via WebFetch/curl against
  // https://ai.google.dev/gemini-api/docs/pricing (checked 2026-07-24, Standard
  // tier): $10.00 / 1M output (audio) tokens, 25 audio tokens/sec →
  // (25*60/1e6)*10.00 = $0.015/min, same shape as SV_VOICES.dubEstimateUSDGemini
  // in shared/voices.js (kept in sync there; duplicated here since library.js
  // doesn't load shared/voices.js).
  const GEMINI_TTS_USD_PER_MIN = 0.015;
  const estCost = (c) => {
    if (c && c.kind === "tts") {
      const perMin = c.provider === "gemini" ? GEMINI_TTS_USD_PER_MIN : 0.015; // gpt-4o-mini-tts ≈ $0.015/min too
      return ((c.durMs || 0) / 60000) * perMin;
    }
    const isClaude = c && c.provider === "claude";
    const pin = isClaude ? CLAUDE_PRICE_IN : PRICE_IN, pout = isClaude ? CLAUDE_PRICE_OUT : PRICE_OUT;
    return ((c && c.inTok) || 0) * pin + ((c && c.outTok) || 0) * pout;
  };

  g.SV_PRICING = {
    PRICE_IN, PRICE_OUT, CLAUDE_PRICE_IN, CLAUDE_PRICE_OUT, GEMINI_TTS_USD_PER_MIN, estCost,
  };
})(globalThis);
