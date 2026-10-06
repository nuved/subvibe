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
