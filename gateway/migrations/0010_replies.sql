-- Messages agents send to people, so a reply can reach the session that wrote them.
-- A Discord "Reply" button carries the row id; Telegram replies and Discord's
-- "Reply to agent" message command look the message up by its id.

CREATE TABLE sent_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  platform    TEXT NOT NULL,            -- telegram | discord
  recipient   TEXT NOT NULL,            -- Telegram chat id or Discord user id
  message_id  TEXT,                     -- the platform's id for the (last) message sent
  agent       TEXT NOT NULL,
  session_id  TEXT,                     -- null when the sender isn't known (an older message)
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX sent_messages_lookup ON sent_messages (platform, recipient, message_id);
