-- Why the gateway left a task blocked when its session stopped without finishing:
-- out of budget, ended in error, or no activity (decision 53). Null when the task's
-- own status report gave the blockers.
ALTER TABLE tasks ADD COLUMN blocked_reason TEXT;
