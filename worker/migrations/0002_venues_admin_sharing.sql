-- Venues, admin accounts, sessions, and player share links.
--
-- Introduces the first authentication boundary in the system. Before this,
-- start/stop/list/download were all unauthenticated.

CREATE TABLE IF NOT EXISTS venues (
  id         TEXT PRIMARY KEY,          -- slug, e.g. 'my-club'
  name       TEXT NOT NULL,             -- 'My Club'
  created_at INTEGER NOT NULL
);

-- Courts self-register on first WebSocket connect, so a new camera arrives with
-- venue_id NULL. Unassigned courts are invisible to every venue until claimed --
-- that fails safe, and stops one club ever seeing another's cameras.
ALTER TABLE courts ADD COLUMN venue_id TEXT REFERENCES venues(id);
CREATE INDEX IF NOT EXISTS idx_courts_venue ON courts (venue_id);

CREATE TABLE IF NOT EXISTS admins (
  id            TEXT PRIMARY KEY,
  venue_id      TEXT NOT NULL REFERENCES venues(id),
  email         TEXT NOT NULL UNIQUE,
  -- pbkdf2$<iterations>$<salt-b64>$<hash-b64>
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admins_venue ON admins (venue_id);

-- Server-side sessions rather than stateless signed cookies, so logout and
-- revocation actually invalidate a session instead of waiting for expiry.
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,          -- 32 random bytes, hex
  admin_id   TEXT NOT NULL REFERENCES admins(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- What a player's QR code resolves to. Unguessable token, revocable, optionally
-- expiring -- so downloads can be locked down everywhere else.
CREATE TABLE IF NOT EXISTS share_links (
  token        TEXT PRIMARY KEY,        -- 16 random bytes, base64url
  recording_id TEXT NOT NULL REFERENCES recordings(id),
  created_by   TEXT REFERENCES admins(id),
  expires_at   INTEGER,                 -- NULL = no expiry
  revoked      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_recording ON share_links (recording_id);
