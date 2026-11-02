-- Following up blocked tasks and failed decisions (decision 50).

-- tasks.status gains 'blocked': the task's session ended with blockers in its last
-- status report. The column has no constraint, so it needs no change for that.

-- The task or decision a follow-up task was assigned for (T-12 or D-41). The gateway
-- refuses a second open follow-up for the same id, and closes a blocked task when its
-- follow-up finishes.
ALTER TABLE tasks ADD COLUMN follows_up TEXT;
CREATE INDEX tasks_follows_up ON tasks(follows_up);

-- The statuses one session reported, newest first.
CREATE INDEX statuses_session ON statuses(session_id, id);

-- Each time the gateway woke Ada about a blocked task or a failed decision: at most
-- one per id, and a daily cap counted from this table.
CREATE TABLE follow_ups (
  subject     TEXT PRIMARY KEY,                 -- T-12 or D-41
  agent       TEXT NOT NULL,                    -- whose task or decision it was
  status      TEXT NOT NULL DEFAULT 'starting', -- starting | started | failed
  session_id  TEXT,                             -- Ada's session, once started
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX follow_ups_created ON follow_ups(created_at);
