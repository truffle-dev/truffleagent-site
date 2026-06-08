-- 0004: track per-frame dispatch time so terminal transitions can
-- compute latency_ms = (Date.now() - dispatched_at_ms).
--
-- One-shot ADD COLUMN. SQLite has no IF NOT EXISTS for columns, so this
-- file is only safe to apply once per database. The CREATE TABLE in
-- 0003 already includes this column for fresh deploys; this migration
-- exists to bring prod up to the same shape.

ALTER TABLE reel_frames ADD COLUMN dispatched_at_ms INTEGER;
