-- First-frame thumbnails, so a recording can be identified without downloading
-- it. Generated on the Pi from the first few MiB of the capture stream (the
-- agent never holds the whole file) and stored in R2 next to the video.
--
-- Nullable: every recording made before this migration has none, and a capture
-- that dies before its first keyframe never produces one. The UI must always
-- handle its absence.
ALTER TABLE recordings ADD COLUMN thumbnail_key TEXT;
