ALTER TABLE conversation_turns
ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';

ALTER TABLE conversation_turns
ADD COLUMN completion_effects_claimed_at TEXT;
