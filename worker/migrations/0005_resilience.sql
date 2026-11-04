-- Field resilience: survive slow networks, outages and power cuts without
-- losing footage, and notice when a court dies.
--
-- One migration for the whole rollout rather than four, because the columns are
-- useless apart: the disk spool needs the lease, the lease needs the sweep to
-- respect it, and resuming after a power cut needs the session identity.

-- ---------------------------------------------------------------------------
-- Buffered uploads vs. the stale sweep
-- ---------------------------------------------------------------------------

-- The lease. findStaleRecordings aborts anything `uploading` for 30 minutes, or
-- 10 minutes past the court's last heartbeat -- which is exactly what a Pi
-- buffering through a network outage looks like. Without this, adding an
-- on-disk buffer makes things WORSE: the Pi comes back with hours of footage
-- and delivers it into a multipart upload the sweep already aborted.
--
-- The agent renews this on every heartbeat while it still holds unsent parts.
-- The sweep caps how far it will honour a lease, because R2 auto-aborts an
-- incomplete multipart upload after 7 days regardless of what we think.
ALTER TABLE recordings ADD COLUMN agent_claimed_at INTEGER;

-- The disk budget ran out mid-match: capture was sealed cleanly and the object
-- completed, so the file is valid and playable -- it just stops early. Distinct
-- from `failed`, which has no usable video at all.
ALTER TABLE recordings ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;

-- Something is off but the recording is still usable -- captured far fewer bytes
-- than its duration implies, say. Deliberately not `error`: that column means
-- "this recording is dead", and a healthy row must keep it NULL.
ALTER TABLE recordings ADD COLUMN warning TEXT;

-- ---------------------------------------------------------------------------
-- Sessions and segments (power-loss resume)
-- ---------------------------------------------------------------------------

-- A match is a session; a power cut ends one segment and starts the next. Two
-- valid MP4s rather than one file, because a second ffmpeg invocation emits its
-- own ftyp+moov init segment and most players stop dead at that boundary.
--
-- No separate `sessions` table on purpose: identity is just a shared UUID, so
-- every existing recordings query keeps working and session views are a GROUP BY.
ALTER TABLE recordings ADD COLUMN session_id TEXT;
ALTER TABLE recordings ADD COLUMN segment INTEGER NOT NULL DEFAULT 1;

-- Stamped by the stop handler BEFORE it relays the command. This is what a Pi
-- returning from a power cut reads to learn the operator already ended the
-- match, so it finalizes what it buffered and does NOT start a new segment.
ALTER TABLE recordings ADD COLUMN stop_requested_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_recordings_session ON recordings (session_id);

-- ---------------------------------------------------------------------------
-- Health and alerting
-- ---------------------------------------------------------------------------

-- Latest telemetry from the court's heartbeat: free disk, unsent backlog, SoC
-- temperature and throttling. A Pi 5 software-encoding 1080p30 in a hot court
-- throttles, and today that is invisible until the footage comes back short.
ALTER TABLE courts ADD COLUMN health_json TEXT;

-- Alert dedupe. This is the entire difference between an alerting system and one
-- that gets muted: a court offline overnight must be one email, not one per tick.
CREATE TABLE IF NOT EXISTS alerts (
  key          TEXT PRIMARY KEY,
  last_sent_at INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1,
  last_body    TEXT
);

-- Production errors routed to the fixer. Fingerprinted so one recurring fault
-- opens one investigation rather than forty.
CREATE TABLE IF NOT EXISTS incidents (
  id            TEXT PRIMARY KEY,
  fingerprint   TEXT NOT NULL,
  court_id      TEXT,
  recording_id  TEXT,
  agent_version TEXT,
  summary       TEXT NOT NULL,
  detail        TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  issue_url     TEXT,
  pr_url        TEXT,
  created_at    INTEGER NOT NULL,
  dispatched_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_incidents_fingerprint ON incidents (fingerprint, created_at);
