// tools/tests/cli.test.mjs — the Claude Code bridge envelope parser (shared/cli.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/cli.js";

const C = globalThis.SV_CLI;

test("parseEnvelope: a structured result carries parsed JSON, usage and the model that ran", () => {
  // shape captured from `claude -p --output-format json --json-schema …` (2.1.258, 2026-09-02)
  const r = C.parseEnvelope({ ok: true, envelope: { type: "result", subtype: "success", is_error: false, result: '{"t":["Hello World.","How are you?"]}',
    structured_output: { t: ["Hello World.", "How are you?"] }, total_cost_usd: 0.05024, stop_reason: "tool_use",
    usage: { input_tokens: 9, output_tokens: 201, cache_read_input_tokens: 0, cache_creation_input_tokens: 24613 }, modelUsage: { "claude-haiku-4-5-20251001": {} } } });
  assert.deepEqual(r.parsed, { t: ["Hello World.", "How are you?"] });
  assert.equal(r.content, '{"t":["Hello World.","How are you?"]}');
  assert.deepEqual(r.usage, { prompt_tokens: 9, completion_tokens: 201, cache_r: 0, cache_w: 24613 });
  assert.equal(r.cost, 0.05024);
  assert.equal(r.model, "claude-haiku-4-5-20251001");
});

test("parseEnvelope: a plain-text result that is JSON still parses; non-JSON text is returned as content", () => {
  assert.deepEqual(C.parseEnvelope({ ok: true, envelope: { is_error: false, result: '{"t":["x"]}' } }).parsed, { t: ["x"] });
  const r = C.parseEnvelope({ ok: true, envelope: { is_error: false, result: "OK" } });
  assert.equal(r.parsed, null); assert.equal(r.content, "OK"); assert.equal(r.cost, 0);
});

test("parseEnvelope: errors name the cause in plain words", () => {
  // the exact not-logged-in envelope seen when the keychain is unreachable
  assert.throws(() => C.parseEnvelope({ ok: true, envelope: { is_error: true, subtype: "success", result: "Not logged in · Please run /login", terminal_reason: "api_error" } }), /not logged in .*\/login/i);
  assert.throws(() => C.parseEnvelope({ ok: false, error: "claude exited 1: boom" }), /bridge: claude exited 1/);
  assert.throws(() => C.parseEnvelope(null), /returned nothing/);
  assert.throws(() => C.parseEnvelope({ ok: true }), /no result envelope/);
  assert.throws(() => C.parseEnvelope({ ok: true, envelope: { is_error: true, result: "Rate limited" } }), /Claude Code: Rate limited/);
});

test("connectError maps Chrome's native-messaging failures to the install hint", () => {
  assert.match(C.connectError("Specified native messaging host not found."), /isn't installed/);
  assert.match(C.connectError("Access to the specified native messaging host is forbidden."), /different extension id/);
  assert.match(C.connectError("Native host has exited."), /stopped unexpectedly/);
  assert.match(C.connectError(""), /not reachable/);
});

test("cliModel maps the picker to CLI model ids and falls back to Sonnet", () => {
  assert.equal(C.cliModel("claude-haiku-4-5"), "claude-haiku-4-5");
  assert.equal(C.cliModel("claude-opus-5"), "claude-opus-5");
  assert.equal(C.cliModel("gpt-4o-mini"), "claude-sonnet-5");
  assert.equal(C.HOST, "com.subvibe.claude");
});
