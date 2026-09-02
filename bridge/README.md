# SubVibe → Claude Code bridge

Translate subtitles and Shots with the **Claude Code CLI on your own machine**, on your existing Claude subscription, instead of an API key. The extension talks to a tiny local program (a Chrome *native messaging host*) that runs `claude -p` and returns the answer. Nothing else changes: prompts, batching, caching and the Activity log are the same as with an API key.

## Install (macOS, Linux)

Needs [Claude Code](https://claude.com/claude-code) installed and logged in (`claude`, then `/login`), and `node` on PATH.

```bash
git clone https://github.com/nuved/subvibe   # or download the zip
bash subvibe/bridge/install.sh <extension-id>
```

The extension id is shown in the SubVibe popup under **Keys → Claude Code on this Mac**, and at `chrome://extensions`. The installer copies the host to `~/.subvibe/subvibe-claude-host.mjs` and registers `com.subvibe.claude` for Chrome, Brave, Chromium and Edge. Rerun it if you move the folder or the extension id changes (an unpacked extension and the store build have different ids).

Then in the popup: **Keys → Claude Code on this Mac → Test**, and set **Translation engine** to *Claude Code on this Mac*.

Windows: the host manifest lives in the registry; not automated yet.

## What the host does

- `{type:"ping"}` → `claude --version`.
- `{type:"chat", system, prompt, model, schema}` → `claude -p --output-format json --no-session-persistence --system-prompt … --model … --json-schema …`, stdin = the prompt. The CLI's JSON envelope is returned verbatim; `shared/cli.js` in the extension parses it (`structured_output`, token usage, errors such as *not logged in*).
- No tools: the CLI only answers. No files are read or written. Each call is a fresh, unsaved session.

## Cost

Calls run on your Claude subscription's usage, not on a metered key. The envelope still reports a nominal `total_cost_usd`; the Activity view shows it as *included* rather than adding it to the estimated spend.

## Uninstall

```bash
rm -f ~/.subvibe/subvibe-claude-host.mjs
rm -f "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.subvibe.claude.json"   # and the Brave / Chromium / Edge twins
```
