-- Community tips: one explanation per fingerprint. k = SHA-256 of "v1|<video id>|<chunk words>|<tips language>",
-- made in the extension, so this database never holds a video id, a subtitle line or anything about a person.
CREATE TABLE IF NOT EXISTS tips (
  k          TEXT PRIMARY KEY,
  tl         TEXT NOT NULL,              -- the tips' language ("fa", "de", "same")
  src        TEXT NOT NULL DEFAULT '',   -- the video's language, when known
  body       TEXT NOT NULL,              -- the explanation, validated JSON
  created_at INTEGER NOT NULL,
  reports    INTEGER NOT NULL DEFAULT 0,
  hidden     INTEGER NOT NULL DEFAULT 0  -- 1 after two reports; the next valid upload replaces it
);
-- One report per person per entry: "who" is a salted hash of the address that rotates daily, never the address.
CREATE TABLE IF NOT EXISTS reports (
  k   TEXT NOT NULL,
  who TEXT NOT NULL,
  at  INTEGER NOT NULL,
  PRIMARY KEY (k, who)
);

-- v2 (2026-10-06): a human-checked install token paces what each video gives out.
-- One session per (token, video fingerprint): 3 chunks at once, then one more every 15 s of real time.
CREATE TABLE IF NOT EXISTS sessions (
  tid        TEXT NOT NULL,              -- the token's random id
  v          TEXT NOT NULL,              -- SHA-256 of the video id, made in the extension
  started_at INTEGER NOT NULL,
  PRIMARY KEY (tid, v)
);
CREATE TABLE IF NOT EXISTS session_keys (
  tid TEXT NOT NULL,
  v   TEXT NOT NULL,
  k   TEXT NOT NULL,
  PRIMARY KEY (tid, v, k)
);
CREATE TABLE IF NOT EXISTS token_days (   -- new chunks a token unlocked per UTC day (daily cap)
  tid TEXT NOT NULL,
  day TEXT NOT NULL,
  n   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tid, day)
);
CREATE TABLE IF NOT EXISTS revoked (tid TEXT PRIMARY KEY, at INTEGER NOT NULL);
