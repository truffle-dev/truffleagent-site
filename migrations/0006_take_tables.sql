-- Take tables. Live in the shared truffle-co-prod D1.
-- Idempotent: every statement guards with IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS take_pieces (
  id                  TEXT PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  prompt_raw          TEXT NOT NULL,
  prompt_enhanced     TEXT,
  aspect_ratio        TEXT NOT NULL DEFAULT '16:9',
  resolution          TEXT NOT NULL DEFAULT '540p'
                        CHECK (resolution IN ('540p','720p','1080p')),
  duration            TEXT NOT NULL DEFAULT '5s'
                        CHECK (duration IN ('5s','10s')),
  status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','composing','generating','ingesting',
                                          'evaluating','judging','retaking','completed','failed')),
  current_attempt     INTEGER NOT NULL DEFAULT 1,
  max_attempts        INTEGER NOT NULL DEFAULT 3,
  accepted_attempt    INTEGER,
  video_key           TEXT,            -- R2 key of the accepted clip
  sheet_key           TEXT,            -- R2 key of the accepted contact sheet
  visitor_hash        TEXT NOT NULL,
  visible             INTEGER NOT NULL DEFAULT 1,
  error_log           TEXT,
  cost_usd            REAL NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_take_pieces_completed
  ON take_pieces (visible, status, completed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_take_pieces_visitor
  ON take_pieces (visitor_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS take_attempts (
  piece_id            TEXT NOT NULL,
  attempt_index       INTEGER NOT NULL,
  compose_json        TEXT,            -- agent-composed Ray3.2 request + reasoning
  luma_generation_id  TEXT,
  status              TEXT NOT NULL DEFAULT 'composing'
                        CHECK (status IN ('composing','submitted','generating','downloading',
                                          'evaluating','judging','accepted','retake','failed')),
  video_key           TEXT,            -- R2 key of this attempt's clip
  sheet_key           TEXT,            -- R2 key of this attempt's contact sheet
  frame_keys_json     TEXT,            -- R2 keys of sampled frames (ordered)
  eval_json           TEXT,            -- gates + metric series summaries from take-engine
  judge_json          TEXT,            -- axis verdicts + rationale from the judge
  decision            TEXT CHECK (decision IN ('accept','retake','abort')),
  retake_prompt       TEXT,            -- rewritten prompt if decision = retake
  failure_reason      TEXT,
  cost_usd            REAL NOT NULL DEFAULT 0,
  gen_latency_ms      INTEGER,
  eval_latency_ms     INTEGER,
  dispatched_at_ms    INTEGER,
  completed_at        TEXT,
  PRIMARY KEY (piece_id, attempt_index),
  FOREIGN KEY (piece_id) REFERENCES take_pieces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_take_attempts_status
  ON take_attempts (piece_id, status);

-- Append-only event log: SSE replay buffer + the permanent eval trace
-- rendered on the final piece page.
CREATE TABLE IF NOT EXISTS take_events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  piece_id            TEXT NOT NULL,
  attempt_index       INTEGER NOT NULL DEFAULT 1,
  event               TEXT NOT NULL,   -- stage_start | stage_done | stage_fail | gate | frame | metric | judge_token | decision
  stage               TEXT NOT NULL,
  data_json           TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_take_events_piece
  ON take_events (piece_id, id);

CREATE TABLE IF NOT EXISTS take_daily_quota (
  visitor_hash        TEXT NOT NULL,
  day                 TEXT NOT NULL,
  count               INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (visitor_hash, day)
);
