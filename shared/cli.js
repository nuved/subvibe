// shared/cli.js — pure helpers for the "Claude Code on this Mac" provider:
// the bridge (bridge/subvibe-claude-host.mjs) returns the CLI's
// `--output-format json` envelope verbatim; these turn it into the same
// {content, usage} shape the API paths produce, and name failures in plain
// words. No chrome.*, no DOM — tools/tests/cli.test.mjs loads it in node.
(function (g) {
  const HOST = "com.subvibe.claude";
  // Popup model picker → what `claude --model` accepts. The CLI takes full ids
  // and the short aliases; full ids keep the pinned generation.
  const MODELS = { "claude-sonnet-5": "claude-sonnet-5", "claude-haiku-4-5": "claude-haiku-4-5", "claude-opus-5": "claude-opus-5" };
  const cliModel = (m) => MODELS[m] || MODELS["claude-sonnet-5"];

  // A bridge reply → { content: string (JSON text), parsed: object|null, usage }.
  // Throws with a message the popup/Activity can show.
  function parseEnvelope(reply) {
    if (!reply || typeof reply !== "object") throw new Error("Claude Code bridge returned nothing");
    if (reply.ok === false) throw new Error("Claude Code bridge: " + (reply.error || "unknown error"));
    const env = reply.envelope;
    if (!env || typeof env !== "object") throw new Error("Claude Code bridge: no result envelope");
    const text = typeof env.result === "string" ? env.result : "";
    if (env.is_error) {
      if (/not logged in|\/login/i.test(text)) throw new Error("Claude Code is not logged in on this Mac — run `claude` in a terminal and /login, then try again.");
      throw new Error("Claude Code: " + (text || env.subtype || "error").slice(0, 200));
    }
    let parsed = env.structured_output && typeof env.structured_output === "object" ? env.structured_output : null;
    if (!parsed && text) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
    const u = env.usage || {};
    return {
      content: parsed ? JSON.stringify(parsed) : text,
      parsed,
      usage: { prompt_tokens: +u.input_tokens || 0, completion_tokens: +u.output_tokens || 0, cache_r: +u.cache_read_input_tokens || 0, cache_w: +u.cache_creation_input_tokens || 0 },
      cost: +env.total_cost_usd || 0,
      model: env.modelUsage && typeof env.modelUsage === "object" ? Object.keys(env.modelUsage)[0] || "" : "",
    };
  }

  // chrome.runtime.lastError.message → what to tell the user.
  function connectError(message) {
    const m = String(message || "");
    if (/forbidden/i.test(m)) return "Claude Code bridge is installed for a different extension id — rerun the install command with this id.";
    if (/not found/i.test(m)) return "Claude Code bridge isn't installed on this Mac — open the SubVibe popup → Keys → Claude Code and run the install command once.";
    if (/exited|disconnected|Native host has exited/i.test(m)) return "Claude Code bridge stopped unexpectedly — is `claude` still on PATH? Rerun the install command.";
    return "Claude Code bridge: " + (m || "not reachable");
  }

  g.SV_CLI = { HOST, MODELS, cliModel, parseEnvelope, connectError };
})(globalThis);
