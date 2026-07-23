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

  // Compact tone hint for the TTS "instructions" param, derived from the
  // line's own punctuation/markup. Persian gets a fixed register hint.
  function ttsInstructions(text, lang) {
    const t = String(text || "");
    const hints = ["Dub a film line naturally, matching the writing's emotion."];
    if (/[?؟]\s*$/.test(t.trim())) hints.push("It is a question.");
    if (/!\s*$/.test(t.trim()) || /\p{Lu}{4,}/u.test(t)) hints.push("Speak with energy.");
    if (/^\s*[([]/.test(t)) hints.push("Speak softly, as an aside.");
    if ((lang || "").split("-")[0] === "fa") hints.push("Natural conversational Persian (Farsi) pronunciation.");
    return hints.join(" ");
  }

  // gpt-4o-mini-tts: audio-out dominates ≈ $0.015 per generated minute.
  function dubEstimateUSD(totalSpeechMs) {
    return (totalSpeechMs / 60000) * 0.015;
  }

  g.SV_VOICES = { VOICE_LABELS, DEFAULT_VOICE, voiceForSpeaker, ttsInstructions, dubEstimateUSD };
})(globalThis);
