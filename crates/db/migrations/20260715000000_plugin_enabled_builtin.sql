-- Plugins gain an enable switch and a builtin marker. Built-in presets
-- (seeded at startup from the dev-kit example manifests) start disabled;
-- enabling one counts as configuring it. User-created plugins stay enabled
-- by default. Builtin rows cannot be deleted, only disabled.
ALTER TABLE plugins ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE plugins ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0;
