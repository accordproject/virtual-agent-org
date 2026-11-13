-- Pull request history for Vera's community metrics (decision 76), copied from the
-- ap-stats method: one row per PR in the repos in scope created in the last 24 months, and
-- older PRs closed since then (for closure counts).
-- The cron refreshes it once a day; community_stats computes the metrics from it.

CREATE TABLE pr_history (
  repo TEXT NOT NULL,                -- owner/name
  number INTEGER NOT NULL,
  state TEXT NOT NULL,               -- OPEN, CLOSED or MERGED
  created_at TEXT NOT NULL,          -- ISO times, as GitHub gives them
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  merged_at TEXT,
  author TEXT,                       -- login; null when the account is deleted
  bot INTEGER NOT NULL DEFAULT 0,    -- 1 when the author is a bot
  first_response_at TEXT,            -- first review or comment by a human other than the author
  PRIMARY KEY (repo, number)
);
CREATE INDEX pr_history_created ON pr_history(created_at);
CREATE INDEX pr_history_closed ON pr_history(closed_at);

-- Where each repo's refresh stands. A pass reads PRs by last update, newest first, and
-- stops at the previous pass's start; a pass longer than one cron run resumes at cursor.
CREATE TABLE pr_sync (
  repo TEXT PRIMARY KEY,
  synced_from TEXT,                  -- start of the last finished pass; null until the first one finishes
  run_started TEXT,                  -- start of the pass in progress, or null
  cursor TEXT                        -- GraphQL cursor the pass in progress resumes at
);
