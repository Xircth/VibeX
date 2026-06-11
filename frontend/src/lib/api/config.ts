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
  SoundFile,
} from 'shared/types';

import { tauriInvoke } from './base';

export interface PromptEnhancementContextMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: string | null;
}

export interface PromptEnhancementRequest {
  draftPrompt: string;
  sessionId?: string | null;
  workspaceId?: string | null;
  contextMessages: PromptEnhancementContextMessage[];
}

export interface PromptEnhancementResponse {
  enhancedPrompt: string;
  model: string;
}

export interface OpencodeModelsResponse {
  models: string[];
}

export interface ClearLocalDataResponse {
  cleared: boolean;
  requires_reload: boolean;
}

export interface AppReleaseStatus {
  current_version: string;
  latest_version: string | null;
  update_available: boolean;
  release_url: string | null;
  repository: string | null;
  checked: boolean;
  error: string | null;
}

export interface RuntimeStatus {
  name: string;
  available: boolean;
  path: string | null;
  message: string;
}

export interface LocalToolStatus {
  id: string;
  label: string;
  kind: string;
  group_id: string;
  user_visible: boolean;
  executable: string;
  npm_package: string;
  installed: boolean;
  executable_path: string | null;
  installed_version: string | null;
  latest_version: string | null;
  minimum_supported_version: string | null;
  supported: boolean;
  update_available: boolean;
  error: string | null;
}

export interface SystemMaintenanceStatus {
  app: AppReleaseStatus;
  npm: RuntimeStatus;
  tools: LocalToolStatus[];
}

export interface InstallSystemDependenciesResult {
  installed_or_updated: string[];
  skipped: string[];
  status: SystemMaintenanceStatus;
}

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
  playNotificationSound: async (soundFile: SoundFile): Promise<void> => {
    return tauriInvoke<void>('play_notification_sound', {
      soundFile,
    });
  },
  enhancePrompt: async (
    payload: PromptEnhancementRequest
  ): Promise<PromptEnhancementResponse> => {
    return tauriInvoke<PromptEnhancementResponse>('enhance_prompt', {
      payload,
    });
  },
  listOpencodeModels: async (): Promise<OpencodeModelsResponse> => {
    return tauriInvoke<OpencodeModelsResponse>('list_opencode_models');
  },
  clearLocalData: async (): Promise<ClearLocalDataResponse> => {
    return tauriInvoke<ClearLocalDataResponse>('clear_local_app_data');
  },
  getSystemMaintenanceStatus: async (): Promise<SystemMaintenanceStatus> => {
    return tauriInvoke<SystemMaintenanceStatus>(
      'get_system_maintenance_status'
    );
  },
  checkAppRelease: async (): Promise<AppReleaseStatus> => {
    return tauriInvoke<AppReleaseStatus>('check_app_release');
  },
  installSystemDependencies: async (
    forceUpdate = false,
    toolIds?: string[]
  ): Promise<InstallSystemDependenciesResult> => {
    return tauriInvoke<InstallSystemDependenciesResult>(
      'install_system_dependencies',
      { forceUpdate, toolIds: toolIds ?? null }
    );
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

export interface RunAgentFixRequest {
  agentType: string;
  action: string;
}

export interface AgentNativeConfigs {
  codex_config_toml: string | null;
  codex_auth_json: string | null;
  codex_home_path: string | null;
  opencode_config_json: string | null;
  opencode_auth_json: string | null;
  opencode_config_path: string | null;
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
  }): Promise<AgentSettingInfo> => {
    return tauriInvoke<AgentSettingInfo>('update_agent_preferences', {
      payload: {
        agent_type: params.agentType,
        enabled: params.enabled,
        env_json: params.envJson,
        config_json: params.configJson,
      },
    });
  },
  reorder: async (agentTypes: string[]): Promise<AgentSettingInfo[]> => {
    return tauriInvoke<AgentSettingInfo[]>('reorder_agents', {
      payload: { order: agentTypes },
    });
  },
  preflight: async (agentType: string): Promise<PreflightResult> => {
    return tauriInvoke<PreflightResult>('agent_preflight', { agentType });
  },
  runFix: async (payload: RunAgentFixRequest): Promise<void> => {
    return tauriInvoke<void>('run_agent_fix', {
      agentType: payload.agentType,
      action: payload.action,
    });
  },
  detectVersion: async (agentType: string): Promise<string | null> => {
    return tauriInvoke<string | null>('detect_agent_local_version', {
      agentType,
    });
  },
  readNativeConfigs: async (
    agentType: BaseCodingAgent
  ): Promise<AgentNativeConfigs> => {
    return tauriInvoke<AgentNativeConfigs>('read_agent_native_configs', {
      agentType,
    });
  },
  writeNativeConfig: async (params: {
    agentType: BaseCodingAgent;
    codexConfigToml?: string | null;
    codexAuthJson?: string | null;
    opencodeConfigJson?: string | null;
    opencodeAuthJson?: string | null;
  }): Promise<void> => {
    return tauriInvoke<void>('write_agent_native_config', {
      agentType: params.agentType,
      codexConfigToml: params.codexConfigToml ?? null,
      codexAuthJson: params.codexAuthJson ?? null,
      opencodeConfigJson: params.opencodeConfigJson ?? null,
      opencodeAuthJson: params.opencodeAuthJson ?? null,
    });
  },
};

// Settings Window API
export const settingsWindowApi = {
  open: async (): Promise<void> => {
    return tauriInvoke<void>('open_settings_window');
  },
};
