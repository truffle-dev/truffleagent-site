-- Easel: agent-operated creative canvas
-- Boards are single-doc JSON; version counter guards concurrent writes.

CREATE TABLE IF NOT EXISTS easel_boards (
  id TEXT PRIMARY KEY,              -- el_<base36>
  title TEXT NOT NULL DEFAULT 'Untitled board',
  doc TEXT NOT NULL,                -- JSON: { elements: [...], background }
  version INTEGER NOT NULL DEFAULT 1,
  visitor_hash TEXT,
  is_public INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_easel_boards_visitor
  ON easel_boards (visitor_hash, updated_at DESC);

CREATE TABLE IF NOT EXISTS easel_sessions (
  id TEXT PRIMARY KEY,              -- es_<base36>
  board_id TEXT NOT NULL REFERENCES easel_boards(id),
  prompt TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',  -- queued|running|done|failed
  result_summary TEXT,
  cost_usd REAL,
  visitor_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_easel_sessions_board
  ON easel_sessions (board_id, created_at DESC);

-- Append-only event log: SSE replay buffer + session receipt trace.
CREATE TABLE IF NOT EXISTS easel_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event TEXT NOT NULL,              -- thought|tool|board_update|done|error
  data_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_easel_events_session
  ON easel_events (session_id, id);

CREATE TABLE IF NOT EXISTS easel_daily_quota (
  visitor_hash TEXT NOT NULL,
  day TEXT NOT NULL,                -- YYYY-MM-DD UTC
  sessions INTEGER NOT NULL DEFAULT 0,
  generations INTEGER NOT NULL DEFAULT 0,
  uploads INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (visitor_hash, day)
);
