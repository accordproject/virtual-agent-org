-- Each submit_change for a change (C-10): the first opens the change's PR, a follow-up
-- task adds a commit to that PR while it is open, or opens a fix-up PR once the change
-- is live. One row per submitting task; every row is recorded against the same C-n.

CREATE TABLE change_submissions (
  change_id  TEXT NOT NULL,          -- C-n
  task_id    TEXT NOT NULL,          -- the task that submitted; at most one submission each
  mode       TEXT NOT NULL,          -- open | push | fix_up | dry_run
  pr_url     TEXT,                   -- the PR opened or added to; null for a dry run
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id)
);
CREATE INDEX change_submissions_change ON change_submissions(change_id);

-- Changes submitted before this table: their PR was their one submission.
INSERT OR IGNORE INTO change_submissions (change_id, task_id, mode, pr_url, created_at)
  SELECT id, task_id, 'open', pr_url, COALESCE(pr_opened_at, updated_at) FROM changes WHERE pr_url IS NOT NULL AND task_id IS NOT NULL;
