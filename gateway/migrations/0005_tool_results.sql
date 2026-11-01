-- Tool-call idempotency, the sweeper's bookmark, and indexes for retention pruning.

-- The answer the gateway gave each custom tool call. A retry after a failed send
-- resends this instead of running the tool again.
CREATE TABLE tool_results (
  event_id    TEXT PRIMARY KEY,
  result      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX tool_results_created ON tool_results(created_at);

-- The last event of a session handled with every event before it, so processing
-- skips what is done and old event claims can be pruned safely.
ALTER TABLE sessions ADD COLUMN events_done_through TEXT;
CREATE INDEX sessions_sweep ON sessions(status, updated_at);

-- Set once the event is handled, so another pass can tell it from one still in progress.
ALTER TABLE processed_events ADD COLUMN done INTEGER NOT NULL DEFAULT 0;
CREATE INDEX processed_events_ts ON processed_events(ts);
CREATE INDEX audit_ts ON audit(ts);
