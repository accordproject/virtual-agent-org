-- Indexes for the five-minute cron's queries, so they read the rows they need rather
-- than whole tables. D1's free tier counts every row a query scans.

-- The sweeper's unfinished sessions. Its WHERE clause must match this one exactly for
-- SQLite to use the partial index (sweepableSessions in db.ts).
CREATE INDEX sessions_unfinished ON sessions(updated_at)
  WHERE status NOT IN ('terminated', 'done', 'stale', 'idle:end_turn', 'idle:budget_reached');

-- Open and running tasks, for blockAbandonedTasks.
CREATE INDEX tasks_status ON tasks(status);

-- Pruning by age.
CREATE INDEX sent_messages_created ON sent_messages(created_at);
CREATE INDEX github_events_received ON github_events(received_at);
CREATE INDEX github_wakes_created ON github_wakes(created_at);
