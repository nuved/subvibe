# SubVibe — Security notes

Run the local audit before every release: **`node tools/audit.mjs`** (no deps, no
network; exits non-zero on any failure).

## API key storage — how it's protected
SubVibe is BYOK: you paste your own OpenAI key. It is handled with the standard,
recommended pattern for an MV3 extension:

- **Stored in `chrome.storage.local`.** Chrome isolates this store — **web pages and
  other extensions cannot read it.** It is the same mechanism extensions use for
  secrets.
- **Never enters a content script.** The key lives only in the **background service
  worker**, the **popup**, and the **offscreen** document (all extension contexts).
  Content scripts run in the page's world and could be observed by the page, so they
  are **never** given the key — they only ask the background worker to translate, and
  the worker attaches the key. (The audit enforces this.)
- **Read on demand, not held in a global.** The worker calls
  `chrome.storage.local.get("apiKey")` per request rather than keeping the key in a
  long-lived variable, so it sits in memory only for the moment of the API call —
  which is unavoidable (you need the key to make the call) and safe, because worker
  memory is isolated from pages and other extensions.
- **Never logged**, and sent only to `api.openai.com` over HTTPS as a standard
  `Authorization: Bearer` header. The optional audio feature passes it to OpenAI's
  Realtime WebSocket via OpenAI's documented `openai-insecure-api-key.<key>`
  subprotocol (browsers can't set WS headers) — still an extension context, still TLS.

**Honest limit:** like all browser storage (including saved passwords), the key sits
on disk in your own user profile. Malware that already has read access to your OS
profile could read it — no in-browser scheme truly defends against an already-
compromised machine (any encryption key would have to live somewhere reachable too).
Defense there is OS-level (disk encryption, anti-malware). What SubVibe *does*
guarantee is isolation from **web pages, other extensions, and the network.**

*Optional future hardening:* a "don't persist my key" toggle that uses
`chrome.storage.session` (memory only, wiped when the browser closes) for users who
prefer re-entering the key each session.

## Content Security Policy
Extension pages run under an explicit strict CSP (declared in `manifest.json`):

```
script-src 'self'; object-src 'self'; base-uri 'none'
```

No inline scripts, no `eval`, no remotely-loaded code — MV3 enforces this and we
comply (verified by the audit). We deliberately do **not** restrict `connect-src`,
because the worker legitimately fetches subtitle files from each supported site's
hosts; those hosts are gated by `host_permissions` instead.

## Supply chain & code
- **Zero third-party runtime libraries.** SubVibe is vanilla JS; the only vendored
  assets are two Vazirmatn font files. So there is no dependency to go vulnerable or
  deprecated in what ships.
- **No remote or dynamic code** (`eval`, `new Function`, remote `<script>`): none.

## Permissions (least privilege)
`storage`, `unlimitedStorage` (local subtitle cache), `tabCapture` + `offscreen`
(only the opt-in audio-transcription feature). `host_permissions` are scoped to the
five supported hosts — **no `<all_urls>`**. (`scripting` and `activeTab` were removed
as unused.) `web_accessible_resources` exposes only `fonts/*`.

## Network egress
Only: (1) `api.openai.com` with the user's key, and (2) the supported sites' own
subtitle files (read through the worker). The audit flags any literal network call to
a host outside `host_permissions`.

## What the audit checks
Remote/dynamic code · hardcoded secrets · key-in-content-script · key logging ·
shipped third-party code · strict CSP · over-broad permissions · `web_accessible_resources`
leakage · `innerHTML` on untrusted data · undeclared network egress.
