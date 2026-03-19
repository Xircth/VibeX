import type {
  Config,
  EditorType,
  CheckEditorAvailabilityResponse,
  AvailabilityInfo,
  BaseCodingAgent,
  UserSystemInfo,
  McpServerQuery,
  UpdateMcpServersBody,
  GetMcpServerResponse,
  ExecutorProfileId,
  QueueStatus,
} from 'shared/types';

import { tauriInvoke } from './base';

// Config APIs
export const configApi = {
  getConfig: async (): Promise<UserSystemInfo> => {
    return tauriInvoke<UserSystemInfo>('get_user_system_info');
  },
  saveConfig: async (config: Config): Promise<Config> => {
    return tauriInvoke<Config>('update_config', { newConfig: config });
  },
  checkEditorAvailability: async (
    editorType: EditorType
  ): Promise<CheckEditorAvailabilityResponse> => {
    return tauriInvoke<CheckEditorAvailabilityResponse>(
      'check_editor_availability',
      { editorType }
    );
  },
  checkAgentAvailability: async (
    agent: BaseCodingAgent
  ): Promise<AvailabilityInfo> => {
    return tauriInvoke<AvailabilityInfo>('check_agent_availability', {
      executor: agent,
    });
  },
};

// Claude Settings (~/.claude/settings.json) APIs
export interface ClaudeSettings {
  env: Record<string, string>;
  enabled_plugins: Record<string, boolean>;
}

export const claudeSettingsApi = {
  get: async (): Promise<ClaudeSettings> => {
    return tauriInvoke<ClaudeSettings>('get_claude_settings');
  },
  update: async (settings: ClaudeSettings): Promise<ClaudeSettings> => {
    return tauriInvoke<ClaudeSettings>('update_claude_settings', { settings });
  },
};

// MCP Servers APIs
export const mcpServersApi = {
  load: async (query: McpServerQuery): Promise<GetMcpServerResponse> => {
    return tauriInvoke<GetMcpServerResponse>('get_mcp_servers', {
      executor: query.executor,
    });
  },
  save: async (
    query: McpServerQuery,
    data: UpdateMcpServersBody
  ): Promise<void> => {
    await tauriInvoke<string>('update_mcp_servers', {
      executor: query.executor,
      servers: data.servers,
    });
  },
};

// Profiles API
export const profilesApi = {
  load: async (): Promise<{ content: string; path: string }> => {
    return tauriInvoke<{ content: string; path: string }>('get_profiles');
  },
  save: async (content: string): Promise<string> => {
    return tauriInvoke<string>('update_profiles', { body: content });
  },
};

// Agent Settings APIs
export interface AgentSettingInfo {
  id: number;
  agent_type: string;
  enabled: boolean;
  sort_order: number;
  installed_version: string | null;
  env_json: string | null;
  config_json: string | null;
}

export interface PreflightCheck {
  check_id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  fixes: PreflightFix[];
}

export interface PreflightFix {
  action: string;
  label: string;
}

export interface PreflightResult {
  checks: PreflightCheck[];
}

export const agentSettingsApi = {
  list: async (): Promise<AgentSettingInfo[]> => {
    return tauriInvoke<AgentSettingInfo[]>('list_agents');
  },
  updatePreferences: async (params: {
    agentType: string;
    enabled?: boolean;
    envJson?: string | null;
    configJson?: string | null;
  }): Promise<void> => {
    return tauriInvoke<void>('update_agent_preferences', params);
  },
  reorder: async (agentTypes: string[]): Promise<void> => {
    return tauriInvoke<void>('reorder_agents', { agentTypes });
  },
  preflight: async (agentType: string): Promise<PreflightResult> => {
    return tauriInvoke<PreflightResult>('agent_preflight', { agentType });
  },
  detectVersion: async (agentType: string): Promise<string | null> => {
    return tauriInvoke<string | null>('detect_agent_local_version', {
      agentType,
    });
  },
};

// Settings Window API
export const settingsWindowApi = {
  open: async (): Promise<void> => {
    return tauriInvoke<void>('open_settings_window');
  },
};

// Queue API for session follow-up messages
export const queueApi = {
  /**
   * Queue a follow-up message to be executed when current execution finishes
   */
  queue: async (
    sessionId: string,
    data: { message: string; executor_profile_id: ExecutorProfileId }
  ): Promise<QueueStatus> => {
    return tauriInvoke<QueueStatus>('queue_message', {
      sessionId,
      message: data.message,
      executorProfileId: data.executor_profile_id,
    });
  },

  /**
   * Cancel a queued follow-up message
   */
  cancel: async (sessionId: string): Promise<QueueStatus> => {
    if (!sessionId) throw new Error('cancel: sessionId is required');
    return tauriInvoke<QueueStatus>('cancel_queued_message', { sessionId });
  },

  /**
   * Get the current queue status for a session
   */
  getStatus: async (sessionId: string): Promise<QueueStatus> => {
    if (!sessionId) throw new Error('getStatus: sessionId is required');
    return tauriInvoke<QueueStatus>('get_queue_status', { sessionId });
  },
};
