CREATE TABLE collaboration_teams (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE collaboration_roles (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  team_id TEXT REFERENCES collaboration_teams(id) ON DELETE SET NULL,
  summary TEXT NOT NULL DEFAULT '',
  persona_prompt TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL,
  mode_id TEXT,
  config_values_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE conversation_personas (
  conversation_id TEXT PRIMARY KEY NOT NULL,
  role_id TEXT,
  name TEXT NOT NULL,
  team_name TEXT,
  summary TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL,
  snapshotted_at TEXT NOT NULL
);

CREATE INDEX collaboration_roles_team_id ON collaboration_roles(team_id);
