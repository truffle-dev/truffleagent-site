-- Reel tables. Live in the shared truffle-co-prod D1.
-- Idempotent: every statement guards with IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS reel_pieces (
  id                  TEXT PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  character_raw       TEXT NOT NULL,
  character_enhanced  TEXT,
  story_raw           TEXT NOT NULL,
  story_enhanced      TEXT,
  beat_sheet_json     TEXT,
  mode                TEXT NOT NULL CHECK (mode IN ('comic', 'gif')),
  frame_count         INTEGER NOT NULL CHECK (frame_count BETWEEN 8 AND 20),
  master_ref_url      TEXT,
  status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','master_in_flight','frames_in_flight','completed','failed')),
  visitor_hash        TEXT NOT NULL,
  visible             INTEGER NOT NULL DEFAULT 1,
  error_log           TEXT,
  cost_usd            REAL NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_reel_pieces_completed
  ON reel_pieces (visible, status, completed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_reel_pieces_visitor
  ON reel_pieces (visitor_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS reel_frames (
  piece_id            TEXT NOT NULL,
  frame_index         INTEGER NOT NULL,
  visual_prompt       TEXT NOT NULL,
  luma_generation_id  TEXT,
  status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','in_flight','inspecting','accepted','rejected_retrying','failed')),
  image_url           TEXT,
  inspection_log      TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL NOT NULL DEFAULT 0,
  latency_ms          INTEGER,
  dispatched_at_ms    INTEGER,
  completed_at        TEXT,
  PRIMARY KEY (piece_id, frame_index),
  FOREIGN KEY (piece_id) REFERENCES reel_pieces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reel_frames_status
  ON reel_frames (piece_id, status);

CREATE TABLE IF NOT EXISTS reel_daily_quota (
  visitor_hash        TEXT NOT NULL,
  day                 TEXT NOT NULL,
  count               INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (visitor_hash, day)
);

CREATE TABLE IF NOT EXISTS reel_prompts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  piece_id            TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('character_raw','character_enhanced','story_raw','story_enhanced','beat_sheet','frame_prompt','frame_inspection')),
  content             TEXT NOT NULL,
  meta                TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reel_prompts_piece
  ON reel_prompts (piece_id, kind, created_at);
