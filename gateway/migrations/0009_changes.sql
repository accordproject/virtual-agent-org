-- Changes the network makes to itself, and the deploys that put them live.

-- tasks.kind gains 'change': the task builds one change (C-n) as a pull request.
-- task | review_check | change. The column has no constraint, so it needs no change.

CREATE TABLE changes (
  id           TEXT PRIMARY KEY,                -- C-n
  seq          INTEGER NOT NULL,
  agent        TEXT NOT NULL,                   -- the agent changed, or 'network'
  decision_id  TEXT NOT NULL,
  change_type  TEXT NOT NULL,
  measure      TEXT NOT NULL,
  tool         TEXT,
  kinds        TEXT NOT NULL DEFAULT '[]',      -- decision kinds named in the evidence (JSON)
  state        TEXT NOT NULL DEFAULT 'building',-- building | pr_open | live | measured | closed
  task_id      TEXT,
  pr_url       TEXT,
  pr_opened_at TEXT,
  live_at      TEXT,
  measured_at  TEXT,
  before       REAL,
  after        REAL,
  before_cases INTEGER,
  after_cases  INTEGER,
  verdict      TEXT,                            -- better | same | worse | too_little_data
  overlaps     TEXT,
  closed_reason TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX changes_state ON changes(state);
CREATE INDEX changes_task ON changes(task_id);

-- Each commit the Worker has been deployed from.
CREATE TABLE deploys (
  commit_sha TEXT PRIMARY KEY,
  ts         TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO counters (name, value) VALUES ('change', 0);
