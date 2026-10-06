// SubVibe community tips: explanations learners chose to share, served to other learners so the same
// chunk is never paid for twice. Users' own data, shown to users only — no accounts, no ads, no resale.
// The extension sends a fingerprint (SHA-256 of video id + chunk words + tips language), never the video
// id or the subtitle text. Runs on the Hetzner box behind Cloudflare's proxy (tips.nimanou.com); nginx
// admits Cloudflare's addresses only, so CF-Connecting-IP is the caller. No address is stored.
package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	lru "github.com/hashicorp/golang-lru/v2"
	"golang.org/x/time/rate"
	_ "modernc.org/sqlite"
)

const (
	siteKey    = "0x4AAAAAAFPIR_es7wYO8tyt" // Turnstile widget for tips.nimanou.com (public; its secret is TURNSTILE_SECRET)
	maxBody    = 24 << 10
	hideAt     = 2                    // reports from different people before an entry is retired
	tokenDays  = 30
	paceStart  = 3                    // a video gives out 3 chunks at once…
	paceEvery  = 15 * time.Second     // …then one more every 15 s of real time
	sessionTTL = 6 * time.Hour        // an older session starts over (a second viewing)
	dayCap     = 3000                 // new chunks one token may unlock per UTC day
	lookupMax  = 10                   // keys per lookup
)

type server struct {
	db        *sql.DB
	cache     *lru.Cache[string, []byte] // k → stored tips JSON (hidden entries are never cached)
	tokenKey  []byte
	salt      string
	turnstile string
	shareTr   bool
	verifyURL string

	mu       sync.Mutex
	sessions map[string]*session   // tid|v → pacing state, memory only
	days     map[string]int        // tid|day → new chunks unlocked today
	limits   map[string]*rate.Limiter
}

type session struct {
	start   time.Time
	granted map[string]bool
	seen    time.Time
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	db, err := openDB(env("DB_PATH", "tips.db"))
	if err != nil {
		log.Fatal(err)
	}
	cache, _ := lru.New[string, []byte](50000)
	s := &server{db: db, cache: cache, tokenKey: []byte(env("TOKEN_KEY", "dev-token-key")), salt: env("SALT", "dev"),
		turnstile: os.Getenv("TURNSTILE_SECRET"), shareTr: env("SHARE_TRANSLATIONS", "off") != "off",
		verifyURL: env("TURNSTILE_VERIFY_URL", "https://challenges.cloudflare.com/turnstile/v0/siteverify"),
		sessions: map[string]*session{}, days: map[string]int{}, limits: map[string]*rate.Limiter{}}
	go s.sweep()
	srv := &http.Server{Addr: env("ADDR", ":8080"), Handler: s, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second}
	go func() {
		log.Printf("community tips on %s (translations shared: %v)", srv.Addr, s.shareTr)
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	_ = db.Close()
}

func openDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // one writer; SQLite serialises anyway
	_, err = db.Exec(`
CREATE TABLE IF NOT EXISTS tips (k TEXT PRIMARY KEY, tl TEXT NOT NULL, src TEXT NOT NULL DEFAULT '', body TEXT NOT NULL,
  created_at INTEGER NOT NULL, reports INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS reports (k TEXT NOT NULL, who TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (k, who));
CREATE TABLE IF NOT EXISTS revoked (tid TEXT PRIMARY KEY, at INTEGER NOT NULL);`)
	return db, err
}

// sweep drops pacing state and limiters nobody used for a while — they live in memory only.
func (s *server) sweep() {
	for range time.Tick(10 * time.Minute) {
		now := time.Now()
		today := now.UTC().Format("2006-01-02")
		s.mu.Lock()
		for k, ses := range s.sessions {
			if now.Sub(ses.seen) > sessionTTL {
				delete(s.sessions, k)
			}
		}
		for k := range s.days {
			if !strings.HasSuffix(k, "|"+today) {
				delete(s.days, k)
			}
		}
		if len(s.limits) > 200000 {
			s.limits = map[string]*rate.Limiter{}
		}
		s.mu.Unlock()
	}
}

// allow: a token bucket per key — perMin requests a minute, bursting to burst.
func (s *server) allow(key string, perMin float64, burst int) bool {
	s.mu.Lock()
	l, ok := s.limits[key]
	if !ok {
		l = rate.NewLimiter(rate.Limit(perMin/60), burst)
		s.limits[key] = l
	}
	s.mu.Unlock()
	return l.Allow()
}

// caller: the address as a salted hash that changes every day — for limits and one report per person.
func (s *server) caller(r *http.Request) string {
	ip := r.Header.Get("CF-Connecting-IP")
	if ip == "" { // only without Cloudflare in front (local runs): the peer address, without its port
		ip = r.RemoteAddr
		if h, _, err := net.SplitHostPort(ip); err == nil {
			ip = h
		}
	}
	h := sha256.Sum256([]byte(s.salt + "|" + time.Now().UTC().Format("2006-01-02") + "|" + ip))
	return hex.EncodeToString(h[:])
}

// ── Install tokens: base64url(JSON {i, e}) "." base64url(HMAC-SHA256) ──
type claims struct {
	I string `json:"i"`
	E int64  `json:"e"`
}

func (s *server) sign(body string) string {
	m := hmac.New(sha256.New, s.tokenKey)
	m.Write([]byte(body))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (s *server) makeToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	c, _ := json.Marshal(claims{I: hex.EncodeToString(b), E: time.Now().Add(tokenDays * 24 * time.Hour).UnixMilli()})
	body := base64.RawURLEncoding.EncodeToString(c)
	return body + "." + s.sign(body)
}

func (s *server) readToken(t string) *claims {
	if len(t) > 400 {
		return nil
	}
	body, sig, ok := strings.Cut(t, ".")
	if !ok || !hmac.Equal([]byte(sig), []byte(s.sign(body))) {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return nil
	}
	var c claims
	if json.Unmarshal(raw, &c) != nil || c.I == "" || c.E <= time.Now().UnixMilli() {
		return nil
	}
	var one int
	if s.db.QueryRow("SELECT 1 FROM revoked WHERE tid = ?", c.I).Scan(&one) == nil {
		return nil
	}
	return &c
}

// ── HTTP ──
func cors(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "content-type")
	h.Set("Access-Control-Max-Age", "86400")
	h.Set("X-Robots-Tag", "noindex, nofollow, noarchive")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

type msg = map[string]any

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	cors(w)
	switch {
	case r.Method == http.MethodOptions:
		w.WriteHeader(http.StatusNoContent)
		return
	case r.Method == http.MethodGet && r.URL.Path == "/robots.txt":
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, "User-agent: *\nDisallow: /\n")
		return
	case r.Method == http.MethodGet && r.URL.Path == "/v1/health":
		var n int
		_ = s.db.QueryRow("SELECT COUNT(*) FROM tips WHERE hidden = 0").Scan(&n)
		writeJSON(w, 200, msg{"ok": true, "tips": n})
		return
	case r.Method == http.MethodGet && r.URL.Path == "/v1/human":
		ext := r.URL.Query().Get("ext")
		if !extRe(ext) {
			http.Error(w, "Open this page from SubVibe.", 400)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = io.WriteString(w, humanPage(ext))
		return
	case r.Method != http.MethodPost:
		writeJSON(w, 404, msg{"error": "not found"})
		return
	}
	who := s.caller(r)
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	var body map[string]any
	if err != nil || len(raw) > maxBody || json.Unmarshal(raw, &body) != nil {
		body = nil
	}
	if r.URL.Path == "/v1/token" {
		s.token(w, r, who, body)
		return
	}
	// Everything below needs a token from the human check.
	tstr, _ := body["t"].(string)
	tok := s.readToken(tstr)
	if tok == nil {
		writeJSON(w, 401, msg{"error": "token"})
		return
	}
	switch r.URL.Path {
	case "/v1/lookup":
		s.lookup(w, tok, body)
	case "/v1/tips":
		s.upload(w, tok, body)
	case "/v1/report":
		s.report(w, tok, who, body)
	default:
		writeJSON(w, 404, msg{"error": "not found"})
	}
}

func extRe(s string) bool {
	if len(s) != 32 {
		return false
	}
	for _, c := range s {
		if c < 'a' || c > 'p' {
			return false
		}
	}
	return true
}

func (s *server) token(w http.ResponseWriter, r *http.Request, who string, body map[string]any) {
	if !s.allow("w|"+who, 30, 10) {
		writeJSON(w, 429, msg{"error": "slow down"})
		return
	}
	ts, _ := body["ts"].(string)
	if ts == "" || len(ts) > 4096 {
		writeJSON(w, 400, msg{"error": "no check"})
		return
	}
	form := url.Values{"secret": {s.turnstile}, "response": {ts}}
	if ip := r.Header.Get("CF-Connecting-IP"); ip != "" {
		form.Set("remoteip", ip)
	}
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.PostForm(s.verifyURL, form)
	var v struct {
		Success bool `json:"success"`
	}
	if err == nil {
		_ = json.NewDecoder(resp.Body).Decode(&v)
		resp.Body.Close()
	}
	if !v.Success {
		writeJSON(w, 403, msg{"error": "the check did not pass"})
		return
	}
	writeJSON(w, 200, msg{"token": s.makeToken()})
}

func (s *server) lookup(w http.ResponseWriter, tok *claims, body map[string]any) {
	if !s.allow("r|"+tok.I, 120, 20) {
		writeJSON(w, 429, msg{"error": "slow down"})
		return
	}
	v, _ := body["v"].(string)
	if !keyRe.MatchString(v) {
		writeJSON(w, 400, msg{"error": "bad video"})
		return
	}
	var keys []string
	seen := map[string]bool{}
	if arr, ok := body["keys"].([]any); ok {
		for _, x := range arr {
			if k, ok := x.(string); ok && keyRe.MatchString(k) && !seen[k] && len(keys) < lookupMax {
				seen[k] = true
				keys = append(keys, k)
			}
		}
	}
	// Pace: this token may have this video's chunks only as fast as it plays (memory only, no writes).
	now := time.Now()
	sk, dk := tok.I+"|"+v, tok.I+"|"+now.UTC().Format("2006-01-02")
	s.mu.Lock()
	ses := s.sessions[sk]
	if ses == nil || now.Sub(ses.start) > sessionTTL {
		ses = &session{start: now, granted: map[string]bool{}}
		s.sessions[sk] = ses
	}
	ses.seen = now
	elapsed := now.Sub(ses.start)
	room := min(paceStart+int(elapsed/paceEvery)-len(ses.granted), dayCap-s.days[dk])
	ok, later := []string{}, []string{}
	for _, k := range keys {
		switch {
		case ses.granted[k]:
			ok = append(ok, k)
		case room > 0:
			ses.granted[k] = true
			s.days[dk]++
			room--
			ok = append(ok, k)
		default:
			later = append(later, k)
		}
	}
	s.mu.Unlock()
	hits := msg{}
	for _, k := range ok {
		if b := s.get(k); b != nil {
			var t Tips
			if json.Unmarshal(b, &t) == nil {
				if !s.shareTr { // the switch also stops translations already stored from going out
					t.stripTranslations()
				}
				hits[k] = t
			}
		}
	}
	next := int64(0)
	if len(later) > 0 {
		next = (paceEvery - elapsed%paceEvery).Milliseconds()
	}
	writeJSON(w, 200, msg{"hits": hits, "later": later, "nextInMs": next})
}

// get: one entry's JSON, from the cache or the database (hidden entries are not served).
func (s *server) get(k string) []byte {
	if b, ok := s.cache.Get(k); ok {
		return b
	}
	var body string
	if s.db.QueryRow("SELECT body FROM tips WHERE k = ? AND hidden = 0", k).Scan(&body) != nil {
		return nil
	}
	s.cache.Add(k, []byte(body))
	return []byte(body)
}

func (s *server) upload(w http.ResponseWriter, tok *claims, body map[string]any) {
	if !s.allow("w|"+tok.I, 30, 10) {
		writeJSON(w, 429, msg{"error": "slow down"})
		return
	}
	k, _ := body["k"].(string)
	if !keyRe.MatchString(k) {
		writeJSON(w, 400, msg{"error": "bad key"})
		return
	}
	tl, _ := body["tl"].(string)
	if !langRe.MatchString(tl) {
		writeJSON(w, 400, msg{"error": "bad language"})
		return
	}
	t, ok := cleanTips(body["tips"], s.shareTr)
	if !ok {
		writeJSON(w, 400, msg{"error": "these tips do not have the expected shape"})
		return
	}
	j, _ := json.Marshal(t)
	// First valid entry wins; a retired (reported) one is replaced and its reports cleared.
	res, err := s.db.Exec(`INSERT INTO tips (k, tl, src, body, created_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(k) DO UPDATE SET body = excluded.body, src = excluded.src, created_at = excluded.created_at, reports = 0, hidden = 0 WHERE tips.hidden = 1`,
		k, strings.ToLower(tl), t.Lang, string(j), time.Now().UnixMilli())
	if err != nil {
		writeJSON(w, 500, msg{"error": "store"})
		return
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		_, _ = s.db.Exec("DELETE FROM reports WHERE k = ?", k)
		s.cache.Remove(k)
	}
	writeJSON(w, 200, msg{"ok": true, "stored": n > 0})
}

func (s *server) report(w http.ResponseWriter, tok *claims, who string, body map[string]any) {
	if !s.allow("w|"+tok.I, 30, 10) {
		writeJSON(w, 429, msg{"error": "slow down"})
		return
	}
	k, _ := body["k"].(string)
	if !keyRe.MatchString(k) {
		writeJSON(w, 400, msg{"error": "bad key"})
		return
	}
	res, err := s.db.Exec("INSERT OR IGNORE INTO reports (k, who, at) VALUES (?, ?, ?)", k, who, time.Now().UnixMilli())
	if err == nil {
		if n, _ := res.RowsAffected(); n > 0 {
			_, _ = s.db.Exec("UPDATE tips SET reports = reports + 1, hidden = CASE WHEN reports + 1 >= ? THEN 1 ELSE hidden END WHERE k = ?", hideAt, k)
			s.cache.Remove(k)
		}
	}
	writeJSON(w, 200, msg{"ok": true})
}

// The human check: Turnstile on a page of this site. A pass gives the install its token, handed to the
// extension that opened the page (externally_connectable) — the page never shows it.
func humanPage(ext string) string {
	e, _ := json.Marshal(ext)
	return fmt.Sprintf(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>SubVibe · Community tips</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><!-- no SRI: Cloudflare updates api.js in place and requires it be loaded live -->
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#17140F;color:#F4EEE6;font:15px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif}main{max-width:380px;padding:24px;text-align:center}h1{font-size:18px;margin:0 0 8px}p{color:#D3C9BC;margin:0 0 16px}#st{margin-top:14px;color:#4FD1BF;min-height:1.5em}</style></head>
<body><main><h1>One quick check</h1><p>Community tips are for people, not robots. This check runs once; your tips then arrive as you watch.</p>
<div class="cf-turnstile" data-sitekey="%s" data-callback="done" data-theme="dark"></div><div id="st"></div></main>
<script>
const EXT = %s;
async function done(ts) {
  const st = document.getElementById("st"); st.textContent = "Checking…";
  const r = await fetch("/v1/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ts }) }).then((x) => x.json()).catch(() => ({}));
  if (!r.token) { st.textContent = "That didn't work — reload the page to try again."; return; }
  try { chrome.runtime.sendMessage(EXT, { type: "SV_COMMUNITY_TOKEN", token: r.token }, () => { st.textContent = "Done — you can close this window."; setTimeout(() => window.close(), 1200); }); }
  catch (e) { st.textContent = "Open this page from SubVibe's story board to finish."; }
}
</script></body></html>`, siteKey, e)
}
