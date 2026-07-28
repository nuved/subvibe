// SubVibe — dub voice palette + tone instructions (pure logic, node-testable).
// Attached to globalThis so plain <script src> includes AND node:test share it.
(function (g) {
  // Shown in the popup's voice <select>, in this order.
  const VOICE_LABELS = [
    ["marin", "Marin — female (recommended)"],
    ["cedar", "Cedar — male (recommended)"],
    ["alloy", "Alloy — neutral"],
    ["coral", "Coral — female, warm"],
    ["shimmer", "Shimmer — female, bright"],
    ["onyx", "Onyx — male, deep"],
    ["echo", "Echo — male"],
    ["sage", "Sage — calm"],
    ["verse", "Verse — expressive"],
    ["ash", "Ash — male, calm"],
    ["ballad", "Ballad — male, soft"],
    ["fable", "Fable — expressive"],
    ["nova", "Nova — female, clear"],
  ];
  const DEFAULT_VOICE = "marin";
  const PALETTE = {
    m: ["cedar", "onyx", "echo"],
    f: ["marin", "coral", "shimmer"],
    "?": ["alloy", "sage", "verse"],
  };

  // Gemini TTS (gemini-2.5-flash-preview-tts) prebuilt voices — verified via
  // WebFetch/curl against https://ai.google.dev/gemini-api/docs/generate-content/speech-generation
  // (checked 2026-07-24; the model supports 30 voices total, language-agnostic —
  // the docs give no per-language recommendations, just a one-word style tag
  // per voice). Curated 9 of the 30 for the popup's <select>, covering a spread
  // of styles; all 30 remain valid `voiceName` values for anyone editing storage
  // directly. Persian (fa) is on Gemini's auto-detected supported-language list.
  const GEMINI_VOICE_LABELS = [
    ["Kore", "Kore — firm (recommended)"],
    ["Puck", "Puck — upbeat"],
    ["Zephyr", "Zephyr — bright"],
    ["Autonoe", "Autonoe — bright"],
    ["Charon", "Charon — informative"],
    ["Fenrir", "Fenrir — excitable"],
    ["Achird", "Achird — friendly"],
    ["Sulafat", "Sulafat — warm"],
    ["Umbriel", "Umbriel — easy-going"],
  ];
  const GEMINI_DEFAULT_VOICE = "Kore";

  // Stable speaker→voice: the first/untagged speaker keeps the user's chosen
  // voice; each further speaker id maps to a fixed slot in the gender-matched
  // palette, with the user's voice excluded so two speakers never collide.
  function voiceForSpeaker(spk, userVoice, multiVoice) {
    const chosen = userVoice || DEFAULT_VOICE;
    if (!multiVoice || !spk || !(spk.id > 1)) return chosen;
    const pool = (PALETTE[spk.g] || PALETTE["?"]).filter((v) => v !== chosen);
    return pool[(spk.id - 2) % pool.length];
  }

  // Sound-effect/music captions must be SKIPPED by the dub, not spoken.
  function isNonSpeechCaption(t) {
    t = String(t || "").trim();
    if (!t) return true;
    if (/[♪♫]/.test(t)) return true;
    if (/^\*[^*]*\*$/.test(t)) return true;
    if (/^\([^)]*\)$/.test(t) || /^\[[^\]]*\]$/.test(t)) return true;
    return false;
  }

  // TTS "instructions" param — CONSTANT per language. Per-line hints (question?
  // shouting? aside?) made consecutive dub lines sound disjoint in live listening;
  // a fixed register per language keeps prosody continuous across cuts. The
  // `text` param stays in the signature (call sites pass it) but is not inspected.
  function ttsInstructions(text, lang) {
    let p = "Dub a film line naturally, matching the writing's emotion. Speak at a natural, unhurried pace with clear diction. You are ONE consistent narrator with a fixed identity: keep exactly the same voice, timbre, pitch range, and speaking style in every line — never sound like a different person.";
    if ((lang || "").split("-")[0] === "fa") p += " Native Persian (Farsi) narrator with a natural Tehrani accent; contemporary conversational pronunciation.";
    return p;
  }

  // gpt-4o-mini-tts: audio-out dominates ≈ $0.015 per generated minute.
  function dubEstimateUSD(totalSpeechMs) {
    return (totalSpeechMs / 60000) * 0.015;
  }

  // gemini-2.5-flash-preview-tts pricing — verified via WebFetch/curl against
  // https://ai.google.dev/gemini-api/docs/pricing (checked 2026-07-24, Standard
  // tier): $0.50 / 1M input tokens (text), $10.00 / 1M output tokens (audio).
  // Audio tokens are a fixed 25 tokens/sec of audio (documented footnote, same
  // rate used for the Live API's own audio pricing) → output alone is
  // (25 * 60 / 1e6) * $10.00 = $0.015 per minute. Input text tokens are tiny
  // per dub line (a short sentence), so the estimate uses output-only, same as
  // the OpenAI estimate above — both land at $0.015/min by coincidence of
  // current pricing, not by construction.
  const GEMINI_TTS_AUDIO_TOK_PER_SEC = 25;
  const GEMINI_TTS_PRICE_PER_1M_OUTPUT = 10.00;
  function dubEstimateUSDGemini(totalSpeechMs) {
    const minutes = totalSpeechMs / 60000;
    const tokens = minutes * 60 * GEMINI_TTS_AUDIO_TOK_PER_SEC;
    return (tokens / 1e6) * GEMINI_TTS_PRICE_PER_1M_OUTPUT;
  }

  g.SV_VOICES = {
    VOICE_LABELS, DEFAULT_VOICE, voiceForSpeaker, isNonSpeechCaption, ttsInstructions, dubEstimateUSD,
    GEMINI_VOICE_LABELS, GEMINI_DEFAULT_VOICE, dubEstimateUSDGemini,
  };
})(globalThis);
