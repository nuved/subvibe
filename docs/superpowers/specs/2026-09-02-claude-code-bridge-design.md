# Claude Code on this Mac — translate on your own subscription

Date: 2026-09-02 · Status: built (branch `claude-bridge`), operator decided
("both": model switching and the `claude -p` route, with the `nativeMessaging`
permission, as in their Bidsmith extension).

## Goal

People who already pay for Claude shouldn't need a metered API key to use
SubVibe. A third translation engine, **Claude Code on this Mac**, sends the
same prompts through the Claude Code CLI installed on the user's machine
(`claude -p`), so subtitles, Shots, Simplify and word cards run on the user's
subscription. Alongside it, the Claude model picker gains Opus 5 so people can
trade speed for quality per provider.

## Shape

- **Popup → Translation engine**: OpenAI GPT-4o-mini · Claude (API key) ·
  Claude Code on this Mac (your subscription). The Claude model row (Sonnet 5 ·
  Haiku 4.5 · Opus 5) applies to both Claude engines.
- **Popup → Keys → Claude Code on this Mac**: the install command with this
  extension's id filled in (`bash bridge/install.sh <id>`) with Copy, a
  **Test** button (pings the bridge, shows the CLI version), a status line,
  and a dot like the key rows. A connected bridge counts as "a key" for the
  setup hero and the engine availability.
- **Activity**: rows carry provider `claude-cli`, labelled *Claude Code*;
  their estimated cost is 0 (subscription), so they never inflate the spend
  cards; token counts still show.

## Architecture

```
extension (background)                      user's machine
  cliChat(system, user, schema, model)
    → chrome.runtime.sendNativeMessage("com.subvibe.claude", {type:"chat", …})
                                            ~/.subvibe/subvibe-claude-host.mjs (node)
                                              spawn claude -p --output-format json
                                                --no-session-persistence --tools ""
                                                --system-prompt … --model … --json-schema … --effort low
                                              stdin = the user payload
                                            ← { ok:true, envelope }  (the CLI's JSON result, verbatim)
    ← SV_CLI.parseEnvelope → { content, parsed (structured_output), usage, cost, model }
```

- `bridge/subvibe-claude-host.mjs` — the host. Two requests: `ping` (runs
  `claude --version`) and `chat`. Never interprets the answer; never allows
  tools; every call is a fresh, unsaved session; 180 s timeout; an unknown
  `--model` is retried once on the plan default. `bridge/install.sh <ext-id>`
  copies it to `~/.subvibe/` with the resolved `claude` and `node` paths and
  registers `com.subvibe.claude` for Chrome, Brave, Chromium and Edge (macOS
  paths; Linux paths too). Windows: manual (registry), documented as not
  automated.
- `shared/cli.js` (pure, node-tested): `parseEnvelope` (structured_output
  first, then the result text as JSON; `is_error` → plain-word errors,
  including *not logged in*), `connectError` (Chrome's native-messaging
  failure strings → the install hint), `cliModel` (picker → CLI model id).
- `background.js`: `providerOf` / `keyFor` / `modelFor` replace the eight
  copies of the two-way ternary; `translateChunkCli`, an `llmJSON` branch and a
  `simplifyText` branch route through `cliChat`; `CLI_PING` serves the popup's
  Test. `manifest.json` adds `nativeMessaging`.

## Facts verified by execution (2026-09-02, Claude Code 2.1.258)

- `--bare` skips keychain reads → "Not logged in" even when logged in. The
  host must NOT pass it.
- `--json-schema` returns `structured_output` (parsed) beside `result` (the
  same JSON as text); `usage` has `input_tokens`, `output_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`; `modelUsage` is
  keyed by the model that ran; `total_cost_usd` is a nominal figure.
- `--tools ""` and `--effort low` are accepted. A two-line translation with
  Haiku takes ~6 s end to end (the CLI's own startup and system prompt
  dominate); a 60-line subtitle batch should be expected at 10–20 s, slower
  than the API path but free of per-token billing.
- The host driven over the real wire (4-byte framing, ping + chat) returned a
  correct German → Persian pair through `claude -p`.

## Not verified

- The extension side inside Chrome (the `nativeMessaging` permission prompt,
  `sendNativeMessage` against the installed host, the popup Test button). The
  operator's playtest: reload, run the install command with the id shown in
  the popup, Test, switch the engine, translate one video and one Shot.

## Risks, stated

- **Terms.** Whether a Claude subscription may power a third-party extension
  through the CLI is the operator's call; the code doesn't change that
  either way. The engine is opt-in and off by default.
- **Latency.** Live-ish subtitle translation feels slower; the UI already
  shows per-batch progress.
- **Store review.** `nativeMessaging` triggers a permission warning on update
  and a justification in the dashboard (text: "optional: lets users translate
  with the Claude Code app already installed on their computer; nothing is
  sent anywhere but that local program").

## Not doing

- Windows installer; a downloadable installer from the popup (users clone or
  download the repo); routing TTS / Live audio through the bridge (audio needs
  the audio providers); streaming partial results.
