-- Voice narration columns on reel_pieces.
-- Idempotent: D1 has no IF NOT EXISTS for ADD COLUMN, so apply once.

ALTER TABLE reel_pieces ADD COLUMN narration_voice_id TEXT;
ALTER TABLE reel_pieces ADD COLUMN narration_url TEXT;
ALTER TABLE reel_pieces ADD COLUMN narration_duration_seconds REAL;
ALTER TABLE reel_pieces ADD COLUMN narration_panel_starts TEXT;
ALTER TABLE reel_pieces ADD COLUMN narration_status TEXT;
ALTER TABLE reel_pieces ADD COLUMN narration_cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE reel_pieces ADD COLUMN narration_attempted_at TEXT;
