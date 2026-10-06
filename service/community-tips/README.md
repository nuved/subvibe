# Community tips service

Go service at `https://tips.nimanou.com` (Hetzner box 46.224.192.77, `/opt/subvibe-tips`, container
`subvibe-tips` on `edge-shared`, nginx vhost `nginx-tips.conf` in `/opt/sprachbrucke/nginx/conf.d`).
Stores explanations learners chose to share, keyed by a SHA-256 fingerprint the extension makes
(`communityKey` in background.js), and serves them back to other learners. No video ids, subtitle
text, accounts or IP addresses are stored. Search engines are kept out (`robots.txt`, `X-Robots-Tag`).

- `GET /v1/human?ext=<extension id>` → Cloudflare Turnstile page; a pass hands a token to the extension
- `POST /v1/token {ts}` → `{token}` (30 days, HMAC-signed)
- `POST /v1/lookup {t, v, keys:[…≤10]}` → `{hits, later, nextInMs}`; per (token, video): 3 chunks at once,
  then one more every 15 s, at most 3000 new chunks a token per day (memory only)
- `POST /v1/tips {t, k, tl, tips}` → `{stored}`; first valid entry wins, a hidden one is replaced
- `POST /v1/report {t, k}` → hidden after 2 reports from different people (salted daily address hash)
- `GET /v1/health` → `{ok, tips}`

`SHARE_TRANSLATIONS` (compose, default `off`): off keeps the passage translation, the retelling and the
sentence lines out of what is stored and served.

DNS and the origin certificate: `~/infra/nimanou` (Terraform, own state; `terraform apply` there).
Secrets: `/opt/subvibe-tips/.env` on the box only (TOKEN_KEY, SALT, TURNSTILE_SECRET).

Deploy: `rsync -a --exclude tips.db server deploy/compose.yml deploy@46.224.192.77:/opt/subvibe-tips/`
(compose.yml → compose.yaml), then `docker compose up -d --build` there. nginx file: copy
`deploy/nginx-tips.conf`, `docker exec sprachbrucke-nginx nginx -t && … nginx -s reload`.
Check locally: `go build` in server/, run with `TURNSTILE_SECRET=1x0000000000000000000000000000000AA
SHARE_TRANSLATIONS=on ADDR=:8798`, then `node test.mjs http://localhost:8798`.
