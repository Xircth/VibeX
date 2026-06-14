import type {
  Config,
  EditorType,
  CheckEditorAvailabilityResponse,
  BaseCodingAgent,
  McpServerQuery,
  UpdateMcpServersBody,
  SoundFile,
  Environment,
  ExecutorConfig,
  JsonValue,
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

export type AgentCapability = 'SESSION_FORK' | 'SETUP_HELPER' | 'CONTEXT_USAGE';

export const AgentCapability = {
  SESSION_FORK: 'SESSION_FORK',
  SETUP_HELPER: 'SETUP_HELPER',
  CONTEXT_USAGE: 'CONTEXT_USAGE',
} as const satisfies Record<AgentCapability, AgentCapability>;

export type AgentAvailabilityInfo =
  | { type: 'LOGIN_DETECTED'; last_auth_timestamp: bigint }
  | { type: 'INSTALLATION_FOUND' }
  | { type: 'NOT_FOUND' };

export type AgentMcpConfig = {
  servers: Record<string, JsonValue>;
  servers_path: string[];
  template: JsonValue;
  preconfigured: JsonValue;
  is_toml_config: boolean;
};

export type GetMcpServerResponse = {
  mcp_config: AgentMcpConfig;
  config_path: string;
};

export type UserSystemInfo = {
  config: Config;
  environment: Environment;
  capabilities: Record<string, AgentCapability[]>;
  executors: Record<string, ExecutorConfig>;
};

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
  ): Promise<AgentAvailabilityInfo> => {
    return tauriInvoke<AgentAvailabilityInfo>('check_agent_availability', {
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

export interface VersionControlCliSettings {
  git_custom_path: string | null;
}

export interface GitVersionStatus {
  installed: boolean;
  version: string | null;
  path: string | null;
  message: string | null;
}

export interface GitHubCliStatus {
  gh_installed: boolean;
  gh_path: string | null;
  authenticated: boolean;
  username: string | null;
  host: string;
  message: string | null;
}

export const versionControlApi = {
  getSettings: async (): Promise<VersionControlCliSettings> => {
    return tauriInvoke<VersionControlCliSettings>(
      'get_version_control_settings'
    );
  },
  updateSettings: async (
    settings: VersionControlCliSettings
  ): Promise<VersionControlCliSettings> => {
    return tauriInvoke<VersionControlCliSettings>(
      'update_version_control_settings',
      { settings }
    );
  },
  detectGit: async (): Promise<GitVersionStatus> => {
    return tauriInvoke<GitVersionStatus>('detect_git_version');
  },
  testGitPath: async (path: string): Promise<GitVersionStatus> => {
    return tauriInvoke<GitVersionStatus>('test_git_path', { path });
  },
  getGithubCliStatus: async (
    host?: string | null
  ): Promise<GitHubCliStatus> => {
    return tauriInvoke<GitHubCliStatus>('get_github_cli_status', {
      host: host ?? null,
    });
  },
  openGithubCliLogin: async (host?: string | null): Promise<void> => {
    return tauriInvoke<void>('open_github_cli_login', { host: host ?? null });
  },
  logoutGithubCli: async (
    host?: string | null,
    username?: string | null
  ): Promise<GitHubCliStatus> => {
    return tauriInvoke<GitHubCliStatus>('logout_github_cli', {
      host: host ?? null,
      username: username ?? null,
    });
  },
};

export interface SystemProxySettings {
  enabled: boolean;
  proxy_url: string | null;
}

export interface SystemRenderingSettings {
  acceleration_mode: 'auto' | 'force_gpu' | 'disable_gpu';
}

export interface BackupCreateOptions {
  path: string;
}

export interface BackupInspectOptions {
  path: string;
  passphrase?: string | null;
}

export interface BackupRestoreStagePayload {
  path: string;
  passphrase?: string | null;
  confirmed: boolean;
}

export interface BackupManifest {
  format: string;
  version: number;
  created_at: string;
  app_version: string;
  entry_count: number;
  total_bytes: number;
}

export interface BackupPreviewEntry {
  path: string;
  size_bytes: number;
  modified_at: string | null;
}

export interface BackupPreview {
  manifest: BackupManifest;
  entries: BackupPreviewEntry[];
}

export interface BackupRestoreResult {
  preview: BackupPreview;
  restored_entries: number;
  requires_reload: boolean;
}

export const systemSettingsApi = {
  getProxy: async (): Promise<SystemProxySettings> => {
    return tauriInvoke<SystemProxySettings>('get_system_proxy_settings');
  },
  updateProxy: async (
    settings: SystemProxySettings
  ): Promise<SystemProxySettings> => {
    return tauriInvoke<SystemProxySettings>('update_system_proxy_settings', {
      settings,
    });
  },
  getRendering: async (): Promise<SystemRenderingSettings> => {
    return tauriInvoke<SystemRenderingSettings>(
      'get_system_rendering_settings'
    );
  },
  updateRendering: async (
    settings: SystemRenderingSettings
  ): Promise<SystemRenderingSettings> => {
    return tauriInvoke<SystemRenderingSettings>(
      'update_system_rendering_settings',
      { settings }
    );
  },
};

export const backupApi = {
  create: async (options: BackupCreateOptions): Promise<BackupPreview> => {
    return tauriInvoke<BackupPreview>('backup_create', { options });
  },
  inspect: async (options: BackupInspectOptions): Promise<BackupPreview> => {
    return tauriInvoke<BackupPreview>('backup_inspect', { options });
  },
  restoreStage: async (
    payload: BackupRestoreStagePayload
  ): Promise<BackupRestoreResult> => {
    return tauriInvoke<BackupRestoreResult>('backup_restore_stage', {
      payload,
    });
  },
  cancel: async (opId?: string | null): Promise<void> => {
    return tauriInvoke<void>('backup_cancel', { opId: opId ?? null });
  },
};

export interface WebServiceConfig {
  port: number;
  token: string | null;
  auto_start: boolean;
}

export interface WebServerStatus {
  running: boolean;
  port: number;
  address: string | null;
  token_configured: boolean;
  started_at: string | null;
  message: string | null;
}

export interface PortProbeResult {
  port: number;
  available: boolean;
  message: string | null;
}

export const webServiceApi = {
  getConfig: async (): Promise<WebServiceConfig> => {
    return tauriInvoke<WebServiceConfig>('get_web_service_config');
  },
  updateConfig: async (
    config: WebServiceConfig
  ): Promise<WebServiceConfig> => {
    return tauriInvoke<WebServiceConfig>('update_web_service_config', {
      config,
    });
  },
  getStatus: async (): Promise<WebServerStatus> => {
    return tauriInvoke<WebServerStatus>('get_web_server_status');
  },
  start: async (): Promise<WebServerStatus> => {
    return tauriInvoke<WebServerStatus>('start_web_server');
  },
  stop: async (): Promise<WebServerStatus> => {
    return tauriInvoke<WebServerStatus>('stop_web_server');
  },
  probePort: async (port: number): Promise<PortProbeResult> => {
    return tauriInvoke<PortProbeResult>('probe_web_service_port', { port });
  },
  generateToken: async (): Promise<WebServiceConfig> => {
    return tauriInvoke<WebServiceConfig>('generate_web_service_token');
  },
};

export interface ModelProvider {
  id: string;
  name: string;
  agent_types: string[];
  api_url: string;
  auth_type: string;
  default_model: string | null;
  config_json: string | null;
  active_agents: string[];
  has_api_key: boolean;
  created_at: string;
  updated_at: string;
}

export interface ModelProviderPayload {
  name: string;
  agent_types: string[];
  api_url: string;
  auth_type: string;
  default_model?: string | null;
  config_json?: string | null;
}

export interface ProviderModelsResult {
  provider_id: string;
  models: string[];
  fetched_at: string;
}

export const modelProviderApi = {
  list: async (): Promise<ModelProvider[]> => {
    return tauriInvoke<ModelProvider[]>('list_model_providers');
  },
  create: async (payload: ModelProviderPayload): Promise<ModelProvider> => {
    return tauriInvoke<ModelProvider>('create_model_provider', { payload });
  },
  update: async (
    providerId: string,
    payload: ModelProviderPayload
  ): Promise<ModelProvider> => {
    return tauriInvoke<ModelProvider>('update_model_provider', {
      providerId,
      payload,
    });
  },
  delete: async (providerId: string): Promise<void> => {
    return tauriInvoke<void>('delete_model_provider', { providerId });
  },
  activate: async (
    providerId: string,
    agentType: string
  ): Promise<ModelProvider> => {
    return tauriInvoke<ModelProvider>('activate_model_provider', {
      providerId,
      agentType,
    });
  },
  deactivate: async (agentType: string): Promise<void> => {
    return tauriInvoke<void>('deactivate_model_provider', { agentType });
  },
  saveApiKey: async (
    providerId: string,
    apiKey: string
  ): Promise<ModelProvider> => {
    return tauriInvoke<ModelProvider>('save_model_provider_api_key', {
      providerId,
      apiKey,
    });
  },
  hasApiKey: async (providerId: string): Promise<boolean> => {
    return tauriInvoke<boolean>('get_model_provider_has_api_key', {
      providerId,
    });
  },
  deleteApiKey: async (providerId: string): Promise<void> => {
    return tauriInvoke<void>('delete_model_provider_api_key', { providerId });
  },
  fetchModels: async (providerId: string): Promise<ProviderModelsResult> => {
    return tauriInvoke<ProviderModelsResult>('fetch_provider_models', {
      providerId,
    });
  },
};

export interface ChatChannel {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  webhook_url: string;
  has_token: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChatChannelPayload {
  name: string;
  kind: string;
  enabled: boolean;
  webhook_url: string;
}

export interface ChatEventFilter {
  enabled_events: string[];
}

export interface ChatCommandPrefix {
  prefix: string;
}

export interface ChatChannelTestResult {
  ok: boolean;
  status: number | null;
  message: string;
}

export const chatChannelApi = {
  list: async (): Promise<ChatChannel[]> => {
    return tauriInvoke<ChatChannel[]>('list_chat_channels');
  },
  create: async (payload: ChatChannelPayload): Promise<ChatChannel> => {
    return tauriInvoke<ChatChannel>('create_chat_channel', { payload });
  },
  update: async (
    channelId: string,
    payload: ChatChannelPayload
  ): Promise<ChatChannel> => {
    return tauriInvoke<ChatChannel>('update_chat_channel', {
      channelId,
      payload,
    });
  },
  delete: async (channelId: string): Promise<void> => {
    return tauriInvoke<void>('delete_chat_channel', { channelId });
  },
  saveToken: async (
    channelId: string,
    token: string
  ): Promise<ChatChannel> => {
    return tauriInvoke<ChatChannel>('save_chat_channel_token', {
      channelId,
      token,
    });
  },
  hasToken: async (channelId: string): Promise<boolean> => {
    return tauriInvoke<boolean>('get_chat_channel_has_token', { channelId });
  },
  deleteToken: async (channelId: string): Promise<void> => {
    return tauriInvoke<void>('delete_chat_channel_token', { channelId });
  },
  test: async (channelId: string): Promise<ChatChannelTestResult> => {
    return tauriInvoke<ChatChannelTestResult>('test_chat_channel', {
      channelId,
    });
  },
  getEventFilter: async (): Promise<ChatEventFilter> => {
    return tauriInvoke<ChatEventFilter>('get_chat_event_filter');
  },
  setEventFilter: async (
    filter: ChatEventFilter
  ): Promise<ChatEventFilter> => {
    return tauriInvoke<ChatEventFilter>('set_chat_event_filter', { filter });
  },
  getCommandPrefix: async (): Promise<ChatCommandPrefix> => {
    return tauriInvoke<ChatCommandPrefix>('get_chat_command_prefix');
  },
  setCommandPrefix: async (
    prefix: ChatCommandPrefix
  ): Promise<ChatCommandPrefix> => {
    return tauriInvoke<ChatCommandPrefix>('set_chat_command_prefix', {
      prefix,
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

// MCP marketplace (Smithery) + global hosting + per-agent sync.
// `McpAppType` mirrors the ACP `AgentType` snake_case identifiers.
export type McpAppType =
  | 'claude_code'
  | 'codex'
  | 'gemini'
  | 'open_claw'
  | 'open_code'
  | 'cline'
  | 'hermes';

export interface LocalMcpServer {
  id: string;
  spec: Record<string, JsonValue>;
  /** Recorded in the global registry (~/.vibex/mcp.json). */
  global: boolean;
  /** Agent config files currently carrying this server. */
  apps: McpAppType[];
}

export interface McpMarketplaceProvider {
  id: string;
  name: string;
  description: string;
}

export interface McpMarketplaceItem {
  provider_id: string;
  server_id: string;
  name: string;
  description: string;
  homepage: string | null;
  remote: boolean;
  verified: boolean;
  icon_url: string | null;
  latest_version: string | null;
  protocols: string[];
  owner: string | null;
  namespace: string | null;
  downloads: number | null;
  score: number | null;
  is_deployed: boolean | null;
}

export interface McpMarketplaceInstallParameter {
  key: string;
  label: string;
  description: string | null;
  required: boolean;
  secret: boolean;
  kind: string;
  default_value: JsonValue | null;
  placeholder: string | null;
  enum_values: string[];
  location: string | null;
}

export interface McpMarketplaceInstallOption {
  id: string;
  protocol: string;
  label: string;
  description: string | null;
  spec: Record<string, JsonValue>;
  parameters: McpMarketplaceInstallParameter[];
}

export interface McpMarketplaceServerDetail {
  provider_id: string;
  server_id: string;
  name: string;
  description: string;
  homepage: string | null;
  remote: boolean;
  verified: boolean;
  icon_url: string | null;
  latest_version: string | null;
  protocols: string[];
  owner: string | null;
  namespace: string | null;
  downloads: number | null;
  score: number | null;
  is_deployed: boolean | null;
  default_option_id: string | null;
  install_options: McpMarketplaceInstallOption[];
  spec: Record<string, JsonValue>;
}

export const mcpMarketApi = {
  scanLocal: async (): Promise<LocalMcpServer[]> => {
    return tauriInvoke<LocalMcpServer[]>('mcp_scan_local');
  },
  listMarketplaces: async (): Promise<McpMarketplaceProvider[]> => {
    return tauriInvoke<McpMarketplaceProvider[]>('mcp_list_marketplaces');
  },
  search: async (params: {
    providerId: string;
    query?: string | null;
    limit?: number | null;
  }): Promise<McpMarketplaceItem[]> => {
    return tauriInvoke<McpMarketplaceItem[]>('mcp_search_marketplace', {
      providerId: params.providerId,
      query: params.query ?? null,
      limit: params.limit ?? null,
    });
  },
  detail: async (params: {
    providerId: string;
    serverId: string;
  }): Promise<McpMarketplaceServerDetail> => {
    return tauriInvoke<McpMarketplaceServerDetail>(
      'mcp_get_marketplace_server_detail',
      { providerId: params.providerId, serverId: params.serverId }
    );
  },
  install: async (params: {
    providerId: string;
    serverId: string;
    global: boolean;
    apps: McpAppType[];
    optionId?: string | null;
    parameterValues?: Record<string, JsonValue> | null;
    specOverride?: Record<string, JsonValue> | null;
  }): Promise<LocalMcpServer[]> => {
    return tauriInvoke<LocalMcpServer[]>('mcp_install_marketplace_server', {
      providerId: params.providerId,
      serverId: params.serverId,
      global: params.global,
      apps: params.apps,
      optionId: params.optionId ?? null,
      parameterValues: params.parameterValues ?? null,
      specOverride: params.specOverride ?? null,
    });
  },
  upsertLocal: async (params: {
    serverId: string;
    spec: Record<string, JsonValue>;
    global: boolean;
    apps: McpAppType[];
  }): Promise<LocalMcpServer[]> => {
    return tauriInvoke<LocalMcpServer[]>('mcp_upsert_local_server', {
      serverId: params.serverId,
      spec: params.spec,
      global: params.global,
      apps: params.apps,
    });
  },
  uninstall: async (serverId: string): Promise<LocalMcpServer[]> => {
    return tauriInvoke<LocalMcpServer[]>('mcp_uninstall_server', { serverId });
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
  auto_approve_mode: 'off' | 'allow_always' | 'yolo';
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

/** One editable native config file the agent reads directly. */
export interface AgentNativeFile {
  id: string;
  label: string;
  path: string;
  /** Editor language hint: 'json' | 'toml' | 'yaml' | 'env' | 'text'. */
  format: string;
  exists: boolean;
  content: string | null;
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
    autoApproveMode?: AgentSettingInfo['auto_approve_mode'];
  }): Promise<AgentSettingInfo> => {
    return tauriInvoke<AgentSettingInfo>('update_agent_preferences', {
      payload: {
        agent_type: params.agentType,
        enabled: params.enabled,
        env_json: params.envJson,
        config_json: params.configJson,
        auto_approve_mode: params.autoApproveMode,
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
  // Generic native-config-file access for any ACP agent (by agent_type key).
  // Reads each agent's own config file(s); writes back up to ~/.vibex first.
  readNativeFiles: async (agentType: string): Promise<AgentNativeFile[]> => {
    return tauriInvoke<AgentNativeFile[]>('read_agent_native_files', {
      agentType,
    });
  },
  writeNativeFiles: async (
    agentType: string,
    files: { id: string; content: string }[]
  ): Promise<AgentNativeFile[]> => {
    return tauriInvoke<AgentNativeFile[]>('write_agent_native_files', {
      agentType,
      files,
    });
  },
  // Open the agent CLI's interactive login (e.g. `codex login`) in a terminal.
  openLoginTerminal: async (agentType: string): Promise<void> => {
    return tauriInvoke<void>('open_agent_login_terminal', { agentType });
  },
};

// Settings Window API
export const settingsWindowApi = {
  open: async (): Promise<void> => {
    return tauriInvoke<void>('open_settings_window');
  },
};
