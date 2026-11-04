-- The player funnel, step by step, and one-tap feedback.
--
-- recording_events (0006) answers "was the video downloaded". It cannot say where
-- a player gave up -- at the sticker, at the form, before sharing, before coming
-- back -- and those call for different fixes. This table records each step.
--
-- Anonymous by construction: no IP, no user agent, no cookie. Two ids tie steps
-- together without identifying anyone:
--
-- visit_id    One scan of the court page, carried through the start form as a
--             hidden field. Joins "scanned" to "pressed Start" for one phone.
-- session_id  The match, once one exists. Joins everything after Start.
--
-- step / detail are an allowlist enforced in analytics.ts; anything the browser
-- sends that is not on it is dropped, so this cannot fill with junk.
CREATE TABLE IF NOT EXISTS funnel_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  court_id   TEXT NOT NULL,
  visit_id   TEXT,
  session_id TEXT,
  step       TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_funnel_court_time ON funnel_events (court_id, created_at);
CREATE INDEX IF NOT EXISTS idx_funnel_session ON funnel_events (session_id);

-- One answer per match, whoever gives it: the primary key is the match, so the
-- question is asked once and never again on any phone. The comment is optional and
-- only offered after the tap.
CREATE TABLE IF NOT EXISTS feedback (
  session_id TEXT PRIMARY KEY,
  court_id   TEXT NOT NULL,
  rating     INTEGER NOT NULL,  -- 1 thumbs up, -1 thumbs down
  comment    TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_court_time ON feedback (court_id, created_at);
