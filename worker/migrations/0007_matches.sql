-- Players start their own recording from a QR code on the court.
--
-- Until now only club staff could start a camera, from a browser, and nobody
-- did: the people who want the footage never touched the product. The QR code
-- hands the remote control to the players.

-- ---------------------------------------------------------------------------
-- The booking grid
-- ---------------------------------------------------------------------------

-- A player picks when the recording ends, not how long it runs. Offering the
-- club's own slot boundaries ("until 20:30") means a group that starts ten
-- minutes late still stops at the end of its booking -- instead of recording
-- ten minutes of the next group, who never agreed to be filmed. Boundaries are
-- local time, so the venue needs its timezone; Workers run in UTC.
--
-- Europe/Lisbon because every venue so far is there. Set it per venue on /super.
ALTER TABLE venues ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Europe/Lisbon';
ALTER TABLE venues ADD COLUMN slot_minutes INTEGER NOT NULL DEFAULT 30;

-- ---------------------------------------------------------------------------
-- The court's QR code
-- ---------------------------------------------------------------------------

-- What the sticker on the court points at: /c/<qr_token>. Random rather than the
-- court id, because court ids are guessable ("padel-club-court-1") and a
-- sticker that is being abused has to be replaceable without renaming the Pi.
-- Generated on first use by the printable card on /super.
ALTER TABLE courts ADD COLUMN qr_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_courts_qr_token ON courts (qr_token);

-- ---------------------------------------------------------------------------
-- Matches
-- ---------------------------------------------------------------------------

-- 0005 deliberately had no sessions table: a session was only an identity, a
-- shared UUID across segments. A match started from the court now carries state
-- of its own that belongs to no single segment -- when it ends, and the private
-- link that is the ONLY way to reach its footage -- so it gets a row.
--
-- token        128-bit secret. Whoever holds the link has the video; scanning the
--              court QR never grants access to footage, past or present.
-- booked_until The end time chosen at start. Never moves.
-- ends_at      When auto-stop fires. Equal to booked_until until Extend exists;
--              kept apart so an extension can be preempted by the next group.
-- started_by   'player' | 'staff' -- the experiment only counts the former.
CREATE TABLE IF NOT EXISTS matches (
  session_id   TEXT PRIMARY KEY,
  court_id     TEXT NOT NULL,
  token        TEXT NOT NULL UNIQUE,
  booked_until INTEGER NOT NULL,
  ends_at      INTEGER NOT NULL,
  started_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_matches_court ON matches (court_id, created_at);
CREATE INDEX IF NOT EXISTS idx_matches_ends_at ON matches (ends_at);
