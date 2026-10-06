# Community translations and tips — paced, human-checked (state note)

Tier: Opus 5.5. Operator decision 2026-10-06: share the user's own AI translations too (option 1), after a
legal note (§ 3 / § 23 UrhG: publishing a translation needs the author's consent; non-commercial does not
change that). Operator accepts the risk; a takedown path and a server kill switch for translations are part of it.

## Phases
1. Server (service/community-tips): Turnstile human check → signed install token (30 d); per (token, video-hash)
   session: 3 chunks at start, +1 per 15 s; daily cap per token; tips payload gains `lines` (per-sentence translations);
   kill switch env SHARE_TRANSLATIONS; /v1/human page.
2. Extension board: opt-in opens the human page, token stored (communityToken); explainLine sends token + video hash;
   uploads lines; board shows community lines where its own are missing.
3. Extension overlay translator: ask the service per chunk before the AI; paced.
4. Takedown contact (PRIVACY.md + nimanou.com), report flow already exists.

## Status
- 1: moved to Go on the Hetzner box (operator 2026-10-06: "we already pay for Hetzner"). service/community-tips/server (Go, SQLite, pacing + cache in memory), deploy/ (compose, nginx). Running at /opt/subvibe-tips, nginx-tips.conf untracked in /opt/sprachbrucke/nginx/conf.d, self-signed cert until the operator issues a CF origin cert from /tmp/tips.csr and adds the proxied A record tips → 46.224.192.77 (my OAuth token has no DNS or origin-CA rights). Worker deleted; D1 kept until cutover works. SHARE_TRANSLATIONS=off pending the operator.
- 2 (extension: token, batched paced lookups, lines), 3 (overlay translator), 4 (takedown contact): not started.
- Separate session tunnel-random-names works on random fromnovid names in mansoor-tunnel (no deploy).
