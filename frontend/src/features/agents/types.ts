export type AgentType =
  | 'claude_code'
  | 'codex'
  | 'open_code'
  | 'gemini'
  | 'open_claw'
  | 'cline'
  | 'hermes';

export type AgentConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'ready'
  | 'failed';

export type AgentSessionStatus =
  | 'creating'
  | 'ready'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed';

export type AgentPromptStatus =
  | { kind: 'queued' }
  | { kind: 'running' }
  | { kind: 'cancelling' }
  | { kind: 'completed'; stop_reason?: string | null }
  | { kind: 'failed'; message: string };

export type AgentDistribution =
  | {
      kind: 'npx';
      version: string;
      package: string;
      cmd: string;
      args: string[];
      node_required?: string | null;
    }
  | {
      kind: 'binary';
      version: string;
      cmd: string;
      args: string[];
      platforms: { platform: string; url: string }[];
    }
  | {
      kind: 'uvx';
      version: string;
      package: string;
      cmd: string;
      args: string[];
      uv_required?: string | null;
      python_required?: string | null;
      system_command?: { cmd: string; args: string[] } | null;
    }
  | {
      kind: 'system';
      cmd: string;
      args: string[];
    };

export type AgentConfigStrategy =
  | 'unsupported'
  | 'file_json'
  | 'file_toml'
  | 'directory'
  | 'agent_command'
  | 'acp_extension';

export type AgentMcpStrategy =
  | 'unsupported'
  | 'file_json'
  | 'file_toml'
  | 'agent_command'
  | 'acp_extension';

export type AgentSkillsStrategy =
  | 'unsupported'
  | 'directory'
  | 'agent_command'
  | 'acp_extension';

export type AgentInstallStatus =
  | 'ready'
  | 'missing_prerequisite'
  | 'missing_agent'
  | 'unsupported_platform'
  | 'auth_missing'
  | 'unknown';

export type AgentPreflightSeverity = 'info' | 'warning' | 'error';

export type AgentPathTemplate = {
  env_var?: string | null;
  unix: string;
  windows: string;
};

export type AgentConfigSurface = {
  agent_type: AgentType;
  auth_paths: AgentPathTemplate[];
  config_paths: AgentPathTemplate[];
  strategy: AgentConfigStrategy;
};

export type AgentMcpSurface = {
  agent_type: AgentType;
  strategy: AgentMcpStrategy;
  user_visible: boolean;
};

export type AgentSkillsSurface = {
  agent_type: AgentType;
  strategy: AgentSkillsStrategy;
  global_supported: boolean;
  project_supported: boolean;
};

export type AgentPreflightIssue = {
  code: string;
  severity: AgentPreflightSeverity;
  message: string;
};

export type AgentPreflight = {
  agent_type: AgentType;
  status: AgentInstallStatus;
  issues: AgentPreflightIssue[];
};

export type AgentInstallPlan = {
  agent_type: AgentType;
  distribution: AgentDistribution;
  required_tools: string[];
  user_visible_summary: string;
};

export type AgentRegistryEntry = {
  agent_type: AgentType;
  registry_id: string;
  name: string;
  description: string;
  distribution: AgentDistribution;
};

export type AgentConnectionSnapshot = {
  id: string;
  agent_type: AgentType;
  workspace_id: string;
  status: AgentConnectionStatus;
  working_dir: string;
  status_message?: string | null;
  created_at: string;
  updated_at: string;
};

export type AgentSessionSnapshot = {
  id: string;
  connection_id: string;
  acp_session_id: string;
  status: AgentSessionStatus;
  active_prompt_id?: string | null;
  queued_prompt_ids: string[];
  created_at: string;
  updated_at: string;
};

export type AgentPromptSnapshot = {
  id: string;
  session_id: string;
  status: AgentPromptStatus;
  text_preview: string;
  created_at: string;
  updated_at: string;
};

export type AgentRuntimeSnapshot = {
  sequence: number;
  registry: AgentRegistryEntry[];
  connections: AgentConnectionSnapshot[];
  sessions: AgentSessionSnapshot[];
  prompts: AgentPromptSnapshot[];
};

export type AgentContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'image'; uri: string }
  | { kind: 'resource'; uri: string; title?: string | null };

export type AgentEvent =
  | { kind: 'connection_status_changed'; snapshot: AgentConnectionSnapshot }
  | { kind: 'session_created'; snapshot: AgentSessionSnapshot }
  | { kind: 'prompt_started'; snapshot: AgentPromptSnapshot }
  | { kind: 'message_chunk'; content: AgentContentBlock }
  | { kind: 'thought_chunk'; content: AgentContentBlock }
  | { kind: 'prompt_finished'; finished: { prompt_id: string; stop_reason?: string | null } }
  | { kind: 'error'; error: { message: string; raw?: unknown } }
  | { kind: 'raw_acp_diagnostic'; raw: unknown };

export type AgentEventEnvelope = {
  sequence: number;
  workspace_id: string;
  connection_id: string;
  session_id?: string | null;
  event: AgentEvent;
  created_at: string;
};
