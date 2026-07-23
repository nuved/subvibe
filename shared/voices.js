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
  ];
  const DEFAULT_VOICE = "marin";
  const PALETTE = {
    m: ["cedar", "onyx", "echo"],
    f: ["marin", "coral", "shimmer"],
    "?": ["alloy", "sage", "verse"],
  };

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
    let p = "Dub a film line naturally, matching the writing's emotion. Speak at a natural, unhurried pace with clear diction. Keep the exact same single narrator voice throughout — consistent timbre, pitch, and gender; never change speakers.";
    if ((lang || "").split("-")[0] === "fa") p += " Natural conversational Persian (Farsi) pronunciation.";
    return p;
  }

  // gpt-4o-mini-tts: audio-out dominates ≈ $0.015 per generated minute.
  function dubEstimateUSD(totalSpeechMs) {
    return (totalSpeechMs / 60000) * 0.015;
  }

  g.SV_VOICES = { VOICE_LABELS, DEFAULT_VOICE, voiceForSpeaker, isNonSpeechCaption, ttsInstructions, dubEstimateUSD };
})(globalThis);
