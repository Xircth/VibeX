-- IM chat-channel delivery/audit log (P2-7): one row per outbound notification
-- attempt and per inbound command, so delivery history and failures are visible.
CREATE TABLE IF NOT EXISTS chat_channel_message_log (
    id           BLOB PRIMARY KEY NOT NULL,
    channel_id   TEXT NOT NULL,               -- chat channel id (string)
    direction    TEXT NOT NULL
                   CHECK (direction IN ('outbound','inbound')),
    event        TEXT,                          -- event key / command name
    status       TEXT NOT NULL,                 -- sent | failed | ok | rejected
    detail       TEXT,                          -- error message or short context
    created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_channel_message_log_channel
    ON chat_channel_message_log(channel_id, created_at);
