-- The free period: the experiment that decides whether players care at all.
--
-- Each court carries the moment its recordings stop being free. A recording is
-- judged by when it STARTED, not by when someone opens it: a match recorded
-- during the free period stays free for good, so the switch never takes away a
-- video a player was already handed. NULL means no paywall has been set -- the
-- court is free indefinitely, which is the only safe default while payments do
-- not exist yet.
ALTER TABLE courts ADD COLUMN free_until INTEGER;

-- What players actually do with the footage. Without this the free period
-- proves nothing: "nobody complained" and "nobody looked" are the same silence.
--
-- Deliberately anonymous -- no IP, no user agent, no cookie. A count per
-- recording answers the question; anything that identifies a player would be
-- personal data collected for no reason. Not cascaded on purge either: deleting
-- footage should not erase the evidence of whether anyone wanted it.
--
-- kind: 'view'          share page opened
--       'download'      player saved the file from a share link
--       'locked_view'   share page opened for a recording past the free period
--       'admin_download' club staff downloaded it from the dashboard
CREATE TABLE IF NOT EXISTS recording_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  recording_id TEXT NOT NULL,
  court_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recording_events_court ON recording_events (court_id, kind);
CREATE INDEX IF NOT EXISTS idx_recording_events_recording ON recording_events (recording_id);
