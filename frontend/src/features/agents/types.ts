import type { AgentId } from 'shared/types';

/**
 * Canonical agent-identity union. Backend batch D2 unified the agent-identity
 * enums into a single `AgentKind`; this local alias is retained so the many
 * existing `AgentType` references keep compiling.
 */
export type AgentType = AgentId;

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
  connections: AgentConnectionSnapshot[];
  sessions: AgentSessionSnapshot[];
  prompts: AgentPromptSnapshot[];
  permissions?: AgentPermissionRequest[];
  events: AgentEventEnvelope[];
};

export type AgentPermissionOption = {
  id: string;
  label: string;
  // Backend always sends `kind` (defaults to 'unknown'); typed optional here so
  // existing fixtures/consumers stay tolerant. Values mirror
  // AgentPermissionOptionKind.
  kind?:
    | 'allow_once'
    | 'allow_always'
    | 'reject_once'
    | 'reject_always'
    | 'unknown';
  description?: string | null;
};

export type AgentPermissionRequest = {
  id: string;
  session_id: string;
  title: string;
  details?: unknown;
  options: AgentPermissionOption[];
};

export type AgentPermissionResponse =
  | { kind: 'selected'; option_id: string }
  | { kind: 'cancelled' };

export type AgentSessionMode = {
  id: string;
  label: string;
  description?: string | null;
};

export type AgentSessionConfigChoice = {
  value: unknown;
  label: string;
  description?: string | null;
};

/**
 * Catalog-only dependency metadata for controls such as OpenCode's
 * model-specific work intensity choices.
 */
export type AgentSessionConfigDependency = {
  parent_key: string;
  choices_by_parent_value: Record<string, AgentSessionConfigChoice[]>;
};

export type AgentSessionConfigOption = {
  key: string;
  label: string;
  description?: string | null;
  category?: string | null;
  value?: unknown;
  choices: AgentSessionConfigChoice[];
  dependency?: AgentSessionConfigDependency | null;
};

export type AgentAvailableCommand = {
  name: string;
  description?: string | null;
  input_schema?: unknown;
};

export type AgentContentBlock =
  | { kind: 'text'; text: string }
  | {
      kind: 'image';
      data: string;
      mime_type: string;
      uri?: string | null;
    }
  | { kind: 'resource'; uri: string; title?: string | null };

export type AgentEvent =
  | { kind: 'connection_status_changed'; snapshot: AgentConnectionSnapshot }
  | { kind: 'session_created'; snapshot: AgentSessionSnapshot }
  // Emitted once when the ACP session id is assigned; consumed by the backend
  // persistence sink to bind external_session_id onto the conversation row.
  | { kind: 'session_linked'; acp_session_id: string; agent_type: AgentType }
  | { kind: 'prompt_started'; snapshot: AgentPromptSnapshot }
  | { kind: 'message_chunk'; content: AgentContentBlock }
  | { kind: 'thought_chunk'; content: AgentContentBlock }
  | {
      kind: 'tool_call';
      tool_call: {
        id: string;
        title: string;
        kind?: string | null;
        input_preview?: string | null;
      };
    }
  | {
      kind: 'tool_call_update';
      update: { id: string; status?: string | null; content?: string | null };
    }
  | { kind: 'plan'; plan: { entries: string[] } }
  | { kind: 'usage'; usage: { used: number; limit?: number | null } }
  | {
      kind: 'session_modes';
      modes: AgentSessionMode[];
      current?: string | null;
    }
  | { kind: 'mode_changed'; mode_id: string }
  | {
      kind: 'session_config_options';
      options: AgentSessionConfigOption[];
    }
  | { kind: 'config_changed'; key: string; value: unknown }
  | { kind: 'available_commands'; commands: AgentAvailableCommand[] }
  | { kind: 'session_load_failed'; reason: string }
  | { kind: 'turn_completed'; stop_reason?: string | null }
  | { kind: 'session_config_stale'; reason?: string | null }
  | { kind: 'permission_requested'; request: AgentPermissionRequest }
  | {
      kind: 'permission_responded';
      permission_id: string;
      response: AgentPermissionResponse;
      auto?: boolean;
    }
  | {
      kind: 'terminal_created';
      terminal: {
        id: string;
        command: string;
        args: string[];
        cwd?: string | null;
      };
    }
  | {
      kind: 'terminal_output';
      output: {
        terminal_id: string;
        output: string;
        truncated: boolean;
        exit_status?: number | null;
      };
    }
  | {
      kind: 'prompt_finished';
      finished: { prompt_id: string; stop_reason?: string | null };
    }
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

export type AgentTerminalSnapshot = Extract<
  AgentEvent,
  { kind: 'terminal_created' }
>['terminal'];

export type AgentTerminalOutputSnapshot = {
  terminal_id: string;
  output: string;
  truncated: boolean;
  exit?:
    | { kind: 'code'; code: number }
    | { kind: 'signal'; signal: string }
    | { kind: 'unknown' }
    | null;
};

export type AgentHistorySource = {
  agent_type: AgentType;
  path: string;
};

export type ImportedAgentMessageRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'tool'
  | 'unknown';

export type ImportedAgentMessage = {
  role: ImportedAgentMessageRole;
  content: string;
  created_at?: string | null;
};

export type ImportedAgentSession = {
  source_agent: AgentType;
  external_session_id: string;
  title?: string | null;
  workspace_path?: string | null;
  messages: ImportedAgentMessage[];
  raw_source_path?: string | null;
};
