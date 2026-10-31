-- Discord as a second front door (decision 15B).

-- Agent replies for sessions started from Discord go to this user's DMs.
ALTER TABLE sessions ADD COLUMN discord_user TEXT;

-- The Discord DM copy of a decision card, kept in step with the Telegram card.
ALTER TABLE decisions ADD COLUMN discord_channel_id TEXT;
ALTER TABLE decisions ADD COLUMN discord_message_id TEXT;
