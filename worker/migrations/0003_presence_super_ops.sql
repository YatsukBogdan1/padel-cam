-- Operational hardening: super-admin role, capture failure reasons, presence.
--
-- Three unrelated-looking changes that all serve the same goal: making a camera
-- that misbehaves in the field visible and fixable from the browser instead of
-- from an SSH session at the venue.

-- Court assignment stops being self-service. Only a super-admin maps a camera to
-- a venue, so a club can never adopt a Pi installed at someone else's site.
-- Granted exclusively by worker/scripts/grant-super.mjs -- there is deliberately
-- no endpoint that can promote an account.
ALTER TABLE admins ADD COLUMN is_superadmin INTEGER NOT NULL DEFAULT 0;

-- Why a recording failed. Previously a capture that never acquired the camera
-- left the row in a terminal state with no explanation anywhere but the Pi's
-- journal, which is exactly the case that is hardest to reach.
ALTER TABLE recordings ADD COLUMN error TEXT;

-- What the Pi is running. Without this you cannot tell which cameras have picked
-- up a fix, and the rsync deploy silently skips any Pi that was powered off.
ALTER TABLE courts ADD COLUMN agent_version TEXT;

-- Presence is now derived from last_seen at read time rather than trusted from
-- the stored flag, so this index carries the fleet-wide court listing.
CREATE INDEX IF NOT EXISTS idx_courts_last_seen ON courts (last_seen);
