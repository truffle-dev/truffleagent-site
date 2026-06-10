-- Cut tables. Live in the shared truffle-co-prod D1.
-- Idempotent: every statement guards with IF NOT EXISTS.
--
-- Cut = multi-shot pieces. The composition JSON (cut_compositions.doc) is the
-- source of truth; renders are pure functions of it. Shots are content-
-- addressed (content_hash) so revisions only regenerate touched shots.

CREATE TABLE IF NOT EXISTS cut_pieces (
  id                  TEXT PRIMARY KEY,          -- cu_...
  slug                TEXT NOT NULL UNIQUE,
  prompt_raw          TEXT NOT NULL,
  title               TEXT,
  aspect_ratio        TEXT NOT NULL DEFAULT '16:9',
  resolution          TEXT NOT NULL DEFAULT '540p'
                        CHECK (resolution IN ('540p','720p','1080p')),
  target_seconds      INTEGER NOT NULL DEFAULT 15,
  status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','planning','shooting','stitching',
                                          'judging','revising','completed','failed')),
  current_version     INTEGER NOT NULL DEFAULT 1,
  accepted_version    INTEGER,
  revision_round      INTEGER NOT NULL DEFAULT 0,   -- 0 = original, cap 5
  repair_used         INTEGER NOT NULL DEFAULT 0,   -- one bounded repair per version
  final_key           TEXT,            -- R2 key of the accepted assembled cut
  final_sheet_key     TEXT,            -- R2 key of the final contact sheet
  seam_sheet_key      TEXT,            -- R2 key of the seam boundary sheet
  final_score         INTEGER,         -- 0..28 (7 axes)
  judge_json          TEXT,            -- final-cut verdict
  state_json          TEXT,            -- transient per-stage state (job ids, retries, revision note)
  visitor_hash        TEXT NOT NULL,
  visible             INTEGER NOT NULL DEFAULT 1,
  error_log           TEXT,
  cost_usd            REAL NOT NULL DEFAULT 0,
  dispatched_at_ms    INTEGER,         -- piece-level step marker (plan/stitch/judge)
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_cut_pieces_completed
  ON cut_pieces (visible, status, completed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_cut_pieces_visitor
  ON cut_pieces (visitor_hash, created_at DESC);

-- One row per composition version. doc is the full timeline JSON: shots
-- (prompt, conditioning, content_hash, artifact refs), transitions, style
-- block, assembly results (seam cosines, final duration). Append-only:
-- every revision writes a new version; rollback is free.
CREATE TABLE IF NOT EXISTS cut_compositions (
  piece_id            TEXT NOT NULL,
  version             INTEGER NOT NULL,
  doc                 TEXT NOT NULL,
  revision_note       TEXT,            -- user note that produced this version (NULL for v1)
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (piece_id, version),
  FOREIGN KEY (piece_id) REFERENCES cut_pieces(id) ON DELETE CASCADE
);

-- Per-shot render attempts. The Take attempt machine, namespaced by
-- (version, shot_id). Cache hits are written as already-accepted rows that
-- copy artifact keys from the matching prior render (cached_from notes it).
CREATE TABLE IF NOT EXISTS cut_shots (
  piece_id            TEXT NOT NULL,
  version             INTEGER NOT NULL,
  shot_id             TEXT NOT NULL,   -- s1..s6, stable across versions
  attempt             INTEGER NOT NULL DEFAULT 1,
  shot_order          INTEGER NOT NULL,
  prompt              TEXT,            -- final composed prompt for this attempt
  conditioning_json   TEXT,            -- {mode, source_shot, image_url?}
  content_hash        TEXT,            -- sha256 over (model|prompt|conditioning|spec)
  cached_from         TEXT,            -- 'v<version>/a<attempt>' when artifact reused
  luma_generation_id  TEXT,
  status              TEXT NOT NULL DEFAULT 'composing'
                        CHECK (status IN ('composing','generating','ingesting','evaluating',
                                          'judging','accepted','retake','failed')),
  video_key           TEXT,
  sheet_key           TEXT,
  frame_keys_json     TEXT,
  last_frame_url      TEXT,            -- public URL of the final sampled frame (chain conditioning)
  eval_json           TEXT,
  judge_json          TEXT,
  score               INTEGER,         -- 0..24 per-shot
  decision            TEXT CHECK (decision IN ('accept','retake','abort')),
  failure_reason      TEXT,
  cost_usd            REAL NOT NULL DEFAULT 0,
  gen_latency_ms      INTEGER,
  dispatched_at_ms    INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT,
  PRIMARY KEY (piece_id, version, shot_id, attempt),
  FOREIGN KEY (piece_id) REFERENCES cut_pieces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cut_shots_active
  ON cut_shots (piece_id, version, shot_order, attempt);

CREATE INDEX IF NOT EXISTS idx_cut_shots_hash
  ON cut_shots (piece_id, content_hash, status);

-- Append-only event log: the DAG view's data source + SSE replay buffer.
CREATE TABLE IF NOT EXISTS cut_events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  piece_id            TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1,
  shot_id             TEXT,            -- NULL for piece-level events (plan, stitch, judge)
  event               TEXT NOT NULL,   -- stage_start | stage_done | stage_fail | gate | decision | route
  stage               TEXT NOT NULL,
  data_json           TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cut_events_piece
  ON cut_events (piece_id, id);

CREATE TABLE IF NOT EXISTS cut_daily_quota (
  visitor_hash        TEXT NOT NULL,
  day                 TEXT NOT NULL,
  count               INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (visitor_hash, day)
);
