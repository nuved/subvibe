#!/usr/bin/env node
// SubVibe → Claude Code bridge (native messaging host). Lets the extension
// translate with the Claude Code CLI on this machine — the user's own Claude
// subscription — instead of an API key. Speaks Chrome's native messaging
// protocol on stdio (4-byte little-endian length + UTF-8 JSON, both ways).
// Installed by bridge/install.sh, which fills in __CLAUDE_BIN__.
//
// Requests (one JSON object each):
//   { type: "ping" }                                   → { ok: true, version, claude }
//   { type: "chat", system, prompt, model?, schema?, maxSeconds? }
//                                                      → { ok: true, envelope }   (the CLI's --output-format json result, verbatim)
//                                                      → { ok: false, error }
// The host never interprets the model's answer; the extension parses the
// envelope (shared/cli.js). No tools are allowed: the CLI only answers.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_BIN = "__CLAUDE_BIN__";
// One line per call in ~/.subvibe/bridge.log — the user's own proof that a
// translation went through claude -p on this machine (`tail -f` it). Rotated
// once at 1 MB; never fails a call.
const LOG_DIR = join(homedir(), ".subvibe"), LOG = join(LOG_DIR, "bridge.log");
function log(line) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    try { if (statSync(LOG).size > 1_000_000) renameSync(LOG, LOG + ".1"); } catch {}
    appendFileSync(LOG, new Date().toISOString() + " " + line + "\n");
  } catch {}
}
const VERSION = "1";
const DEFAULT_TIMEOUT_MS = 180_000;

function writeMessage(obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  process.stdout.write(Buffer.concat([header, payload]));
}

function run(args, stdin, timeoutMs) {
  return new Promise((resolve) => {
    let out = "", err = "", done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const child = spawn(CLAUDE_BIN, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish({ code: -1, out, err: "timed out after " + Math.round(timeoutMs / 1000) + "s" }); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => finish({ code, out, err }));
    child.on("error", (e) => finish({ code: -1, out, err: String(e && e.message) }));
    if (stdin != null) child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function ping() {
  const r = await run(["--version"], null, 15_000);
  log("ping " + (r.code === 0 ? "ok " + r.out.trim().split("\n")[0] : "FAIL " + (r.err || r.out).slice(0, 120)));
  if (r.code !== 0) return { ok: false, error: "claude --version failed: " + (r.err || r.out).slice(0, 200) };
  return { ok: true, version: VERSION, claude: r.out.trim().split("\n")[0], bin: CLAUDE_BIN };
}

async function chat(msg) {
  const prompt = typeof msg.prompt === "string" ? msg.prompt : "";
  if (!prompt.trim()) return { ok: false, error: "empty prompt" };
  const args = ["-p", "--output-format", "json", "--no-session-persistence", "--tools", ""];
  if (typeof msg.system === "string" && msg.system.trim()) args.push("--system-prompt", msg.system);
  if (typeof msg.model === "string" && msg.model.trim()) args.push("--model", msg.model.trim());
  if (msg.schema && typeof msg.schema === "object") args.push("--json-schema", JSON.stringify(msg.schema));
  if (typeof msg.effort === "string" && /^(low|medium|high|max)$/.test(msg.effort)) args.push("--effort", msg.effort);
  const timeoutMs = Math.min(600_000, Math.max(20_000, (+msg.maxSeconds || 0) * 1000 || DEFAULT_TIMEOUT_MS));
  const t0 = Date.now();
  let r = await run(args, prompt, timeoutMs);
  // Unknown --model on this plan/version → exit ≠ 0 with a hint; retry on the plan's default once.
  if (r.code !== 0 && msg.model && /model/i.test(r.err || r.out)) {
    r = await run(args.filter((a, i, all) => !(a === "--model" || all[i - 1] === "--model")), prompt, timeoutMs);
  }
  if (r.code !== 0 && !r.out.trim()) { log("chat FAIL exit=" + r.code + " model=" + (msg.model || "default") + " " + (r.err || "").replace(/\s+/g, " ").slice(0, 160)); return { ok: false, error: "claude exited " + r.code + ": " + (r.err || "no output").slice(0, 400) }; }
  let envelope;
  try { envelope = JSON.parse(r.out); } catch { log("chat FAIL non-JSON output"); return { ok: false, error: "claude returned non-JSON output: " + r.out.slice(0, 200) }; }
  const u = envelope.usage || {};
  const ran = envelope.modelUsage && typeof envelope.modelUsage === "object" ? Object.keys(envelope.modelUsage)[0] : "";
  log("chat " + (envelope.is_error ? "ERROR " : "ok ") + "claude -p model=" + (ran || msg.model || "default") + " in=" + (u.input_tokens || 0) + " out=" + (u.output_tokens || 0) + " cache_w=" + (u.cache_creation_input_tokens || 0) + " ms=" + (Date.now() - t0) + " prompt_chars=" + prompt.length + (envelope.is_error ? " " + String(envelope.result || "").slice(0, 120) : ""));
  return { ok: true, envelope };
}

async function handle(msg) {
  try {
    if (!msg || typeof msg !== "object") return { ok: false, error: "bad request" };
    if (msg.type === "ping") return await ping();
    if (msg.type === "chat") return await chat(msg);
    return { ok: false, error: "unknown request type" };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const len = buffer.readUInt32LE(0);
    if (buffer.length < 4 + len) return;
    const payload = buffer.subarray(4, 4 + len).toString("utf8");
    buffer = buffer.subarray(4 + len);
    let msg = null;
    try { msg = JSON.parse(payload); } catch { writeMessage({ ok: false, error: "bad request payload" }); continue; }
    handle(msg).then(writeMessage);
  }
});
process.stdin.on("end", () => process.exit(0));
