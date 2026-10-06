# Community tips service

Cloudflare Worker + D1 behind `https://tips.nimanou.com`. Stores explanations learners chose to
share, keyed by a SHA-256 fingerprint the extension makes (`communityKey` in background.js), and
serves them back to other learners. No video ids, subtitle text, accounts or IP addresses are stored.

- `POST /v1/lookup {keys:[…≤50]}` → `{hits:{key: tips}}`
- `POST /v1/tips {k, tl, tips}` → `{stored}`; the first valid entry wins, a hidden one is replaced
- `POST /v1/report {k}` → hidden after 2 reports from different people (salted daily address hash)
- `GET /v1/health` → `{ok, tips}`

Deploy: `wrangler d1 execute subvibe-community-tips --remote --file schema.sql` (once), `wrangler deploy`.
Secret: `SALT` (`openssl rand -hex 32 | wrangler secret put SALT`). Check: `wrangler dev --local --port 8799` then `node test.mjs`.
Undo: `wrangler delete` and `wrangler d1 delete subvibe-community-tips`.
