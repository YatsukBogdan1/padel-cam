-- D1 schema for padel smart-cam metadata.

CREATE TABLE IF NOT EXISTS courts (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  online     INTEGER NOT NULL DEFAULT 0,
  last_seen  INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recordings (
  id         TEXT PRIMARY KEY,
  court_id   TEXT NOT NULL,
  status     TEXT NOT NULL,            -- recording | uploading | ready | expired | failed
  upload_id  TEXT,                     -- R2 multipart uploadId
  object_key TEXT,                     -- recordings/{id}.mp4
  bytes      INTEGER NOT NULL DEFAULT 0,
  purchased  INTEGER NOT NULL DEFAULT 0, -- forward-compat: retention keeps purchased rows
  started_at INTEGER NOT NULL,
  stopped_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Drives the retention sweep: unpurchased + ready + old.
CREATE INDEX IF NOT EXISTS idx_recordings_status_created
  ON recordings (status, created_at);

CREATE INDEX IF NOT EXISTS idx_recordings_court
  ON recordings (court_id, created_at);
