-- Gateway state. D1 (SQLite).

CREATE TABLE agents (
  name        TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'active',   -- active | paused | stopped | revoked
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,                 -- sesn_...
  agent       TEXT NOT NULL,
  origin      TEXT NOT NULL,                    -- telegram | task | deployment
  chat_id     INTEGER,                          -- forward agent messages here (telegram origin)
  task_id     TEXT,
  status      TEXT NOT NULL DEFAULT 'running',
  cost_cents  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX sessions_agent ON sessions(agent, status);

CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,                 -- T-12
  seq         INTEGER NOT NULL,
  agent       TEXT NOT NULL,
  title       TEXT NOT NULL,
  brief       TEXT NOT NULL,
  priority    TEXT NOT NULL DEFAULT 'normal',
  due         TEXT,
  status      TEXT NOT NULL DEFAULT 'open',     -- open | running | done | failed | cancelled
  session_id  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE decisions (
  id            TEXT PRIMARY KEY,               -- D-41
  seq           INTEGER NOT NULL,
  agent         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  target        TEXT NOT NULL,
  summary       TEXT NOT NULL,
  rationale     TEXT NOT NULL,
  risk          TEXT NOT NULL,
  payload       TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'open',   -- open | approved | rejected | executed | failed
  note          TEXT,
  result        TEXT,
  session_id    TEXT,
  tool_use_id   TEXT,                           -- set for tool confirmations (kind = tool.confirm)
  tg_message_id INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at    TEXT,
  executed_at   TEXT
);
CREATE INDEX decisions_status ON decisions(status, agent);

CREATE TABLE statuses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT NOT NULL,
  session_id  TEXT,
  done        TEXT NOT NULL,
  doing       TEXT NOT NULL,
  blocked     TEXT NOT NULL,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX statuses_agent ON statuses(agent, created_at);

CREATE TABLE scorecards (
  period      TEXT PRIMARY KEY,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE evaluations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT NOT NULL,
  week        TEXT NOT NULL,
  scores      TEXT NOT NULL,
  evidence    TEXT NOT NULL,
  proposal    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent, week)
);

-- Append-only audit log of everything agents do.
CREATE TABLE audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL DEFAULT (datetime('now')),
  agent       TEXT,
  session_id  TEXT,
  event_id    TEXT,
  event_type  TEXT NOT NULL,
  tool        TEXT,
  permission  TEXT,
  detail      TEXT
);
CREATE INDEX audit_agent ON audit(agent, ts);

-- Idempotency: each session event is handled once.
CREATE TABLE processed_events (
  event_id    TEXT PRIMARY KEY,
  ts          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Telegram force-reply prompts awaiting Matt's text (e.g. a rejection note).
CREATE TABLE pending_replies (
  message_id  INTEGER PRIMARY KEY,
  chat_id     INTEGER NOT NULL,
  kind        TEXT NOT NULL,                    -- reject_note
  ref         TEXT NOT NULL,                    -- decision id
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO counters (name, value) VALUES ('decision', 0), ('task', 0);
