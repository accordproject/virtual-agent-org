-- Who set work going, kept as data rather than read from display text.

-- A review check (decision 2A) is a kind of task the gateway alone creates, for one
-- PR at one commit. Its title is only a label: assign_task can't make a review check.
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task';   -- task | review_check
ALTER TABLE tasks ADD COLUMN review_target TEXT;                  -- owner/repo#123
ALTER TABLE tasks ADD COLUMN review_sha TEXT;                     -- the head commit checked, 7 or more characters

-- Checks started before this migration, recognised by the brief only the gateway writes.
UPDATE tasks
SET kind = 'review_check',
    review_target = substr(title, 15, instr(title, '@') - 15),
    review_sha = substr(title, instr(title, '@') + 1)
WHERE agent = 'mira' AND title LIKE 'Review check: %@%' AND brief LIKE 'You are checking a review of %';

-- Who a session acts for: owner, schedule, or member:<platform>:<name>. Tasks inherit
-- it from the session that assigned them, so a member's request stays marked as theirs.
ALTER TABLE sessions ADD COLUMN started_by TEXT NOT NULL DEFAULT 'schedule';
-- Conversations from before this migration: who spoke wasn't recorded.
UPDATE sessions SET started_by = 'unknown' WHERE origin IN ('telegram', 'discord');

-- Messages each member sent to agents per day, for member_daily_messages.
CREATE TABLE member_messages (
  person  TEXT NOT NULL,                  -- name from people.yaml, or "telegram user <id>"
  day     TEXT NOT NULL,                  -- YYYY-MM-DD, UTC
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (person, day)
);
