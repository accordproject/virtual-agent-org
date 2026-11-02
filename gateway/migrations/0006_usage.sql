-- What each session used, for Vera's agent audit (read_audit).

-- The model the session ran on, as the gateway asked for it: an override, or the
-- agent's default tier from models.yaml. Sessions from before this migration have none.
ALTER TABLE sessions ADD COLUMN model TEXT;
-- Cumulative token totals from the session's usage.
ALTER TABLE sessions ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
CREATE INDEX sessions_created ON sessions(created_at);
