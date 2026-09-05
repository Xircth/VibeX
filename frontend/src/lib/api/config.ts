import type {
  Config,
  EditorType,
  CheckEditorAvailabilityResponse,
  SoundFile,
  Environment,
  ExecutorConfig,
  JsonValue,
  ChatChannelMessageLog,
} from 'shared/types';

import { backendCall } from './base';
import { getBackendTransport } from '@/lib/transport';

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

export interface PromptEnhancementModelsResponse {
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
  body?: string | null;
  published_at?: string | null;
  checked_at?: string;
}

export type AgentCapability =
  | 'RESET_TO_HERE'
  | 'SETUP_HELPER'
  | 'CONTEXT_USAGE';

export const AgentCapability = {
  RESET_TO_HERE: 'RESET_TO_HERE',
  SETUP_HELPER: 'SETUP_HELPER',
  CONTEXT_USAGE: 'CONTEXT_USAGE',
} as const satisfies Record<AgentCapability, AgentCapability>;

export type UserSystemInfo = {
  config: Config;
  environment: Environment;
  capabilities: Record<string, AgentCapability[]>;
  executors: Record<string, ExecutorConfig>;
};

// Config APIs
export const configApi = {
  getConfig: async (): Promise<UserSystemInfo> => {
    return backendCall<UserSystemInfo>('get_user_system_info');
  },
  getSettingsPath: async (): Promise<string> => {
    return backendCall<string>('get_settings_file_path');
  },
  saveConfig: async (config: Config): Promise<Config> => {
    return backendCall<Config>('update_config', { newConfig: config });
  },
  checkEditorAvailability: async (
    editorType: EditorType
  ): Promise<CheckEditorAvailabilityResponse> => {
    const transport = getBackendTransport();
    const capabilities = transport.capabilities
      ? await transport.capabilities()
      : { capabilities: [] as string[] };
    if (!capabilities.capabilities.includes('desktop.tauri')) {
      return { available: false };
    }
    return backendCall<CheckEditorAvailabilityResponse>(
      'check_editor_availability',
      { editorType }
    );
  },
  playNotificationSound: async (soundFile: SoundFile): Promise<void> => {
    const transport = getBackendTransport();
    const capabilities = transport.capabilities
      ? await transport.capabilities()
      : { capabilities: [] as string[] };
    if (!capabilities.capabilities.includes('desktop.tauri')) {
      return;
    }
    return backendCall<void>('play_notification_sound', {
      soundFile,
    });
  },
  enhancePrompt: async (
    payload: PromptEnhancementRequest
  ): Promise<PromptEnhancementResponse> => {
    return backendCall<PromptEnhancementResponse>('enhance_prompt', {
      payload,
    });
  },
  listPromptEnhancementModels:
    async (): Promise<PromptEnhancementModelsResponse> => {
      return backendCall<PromptEnhancementModelsResponse>(
        'list_prompt_enhancement_models'
      );
    },
  refreshPromptEnhancementModels:
    async (): Promise<PromptEnhancementModelsResponse> => {
      return backendCall<PromptEnhancementModelsResponse>(
        'refresh_prompt_enhancement_catalogs'
      );
    },
  clearLocalData: async (): Promise<ClearLocalDataResponse> => {
    return backendCall<ClearLocalDataResponse>('clear_local_app_data');
  },
  checkAppRelease: async (): Promise<AppReleaseStatus> => {
    return backendCall<AppReleaseStatus>('check_app_release');
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

export interface VersionControlInstallResult {
  git: GitVersionStatus;
  github: GitHubCliStatus;
  identity_configured: boolean;
  error: string | null;
}

export const versionControlApi = {
  getSettings: async (): Promise<VersionControlCliSettings> => {
    return backendCall<VersionControlCliSettings>(
      'get_version_control_settings'
    );
  },
  updateSettings: async (
    settings: VersionControlCliSettings
  ): Promise<VersionControlCliSettings> => {
    return backendCall<VersionControlCliSettings>(
      'update_version_control_settings',
      { settings }
    );
  },
  detectGit: async (): Promise<GitVersionStatus> => {
    return backendCall<GitVersionStatus>('detect_git_version');
  },
  testGitPath: async (path: string): Promise<GitVersionStatus> => {
    return backendCall<GitVersionStatus>('test_git_path', { path });
  },
  getGithubCliStatus: async (
    host?: string | null
  ): Promise<GitHubCliStatus> => {
    return backendCall<GitHubCliStatus>('get_github_cli_status', {
      host: host ?? null,
    });
  },
  installGithubCli: async (host?: string | null): Promise<GitHubCliStatus> => {
    return backendCall<GitHubCliStatus>('install_github_cli', {
      host: host ?? null,
    });
  },
  installTools: async (data: {
    user_name: string;
    user_email: string;
  }): Promise<VersionControlInstallResult> => {
    return backendCall<VersionControlInstallResult>(
      'install_version_control_tools',
      {
        userName: data.user_name,
        userEmail: data.user_email,
      }
    );
  },
  openGithubCliLogin: async (host?: string | null): Promise<void> => {
    return backendCall<void>('open_github_cli_login', { host: host ?? null });
  },
  logoutGithubCli: async (
    host?: string | null,
    username?: string | null
  ): Promise<GitHubCliStatus> => {
    return backendCall<GitHubCliStatus>('logout_github_cli', {
      host: host ?? null,
      username: username ?? null,
    });
  },
};

export interface ProjectWorktreeSettings {
  create_command: string | null;
  delete_command: string | null;
  cleanup_prompt_enabled: boolean;
  cleanup_prompt_threshold: number;
}

export interface WorktreeCleanupStatus {
  current_count: number;
  threshold: number;
  should_prompt: boolean;
}

export const worktreeSettingsApi = {
  get: async (projectId: string): Promise<ProjectWorktreeSettings> => {
    return backendCall<ProjectWorktreeSettings>(
      'get_project_worktree_settings',
      { projectId }
    );
  },
  update: async (
    projectId: string,
    settings: ProjectWorktreeSettings
  ): Promise<ProjectWorktreeSettings> => {
    return backendCall<ProjectWorktreeSettings>(
      'update_project_worktree_settings',
      { projectId, settings }
    );
  },
  getCleanupStatus: async (
    projectId: string
  ): Promise<WorktreeCleanupStatus> => {
    return backendCall<WorktreeCleanupStatus>('get_worktree_cleanup_status', {
      projectId,
    });
  },
};

export type FrontendPreferences = Record<string, JsonValue>;

export const frontendPreferencesApi = {
  get: async (): Promise<FrontendPreferences> => {
    return backendCall<FrontendPreferences>('get_frontend_preferences');
  },
  update: async (
    preferences: FrontendPreferences
  ): Promise<FrontendPreferences> => {
    return backendCall<FrontendPreferences>('update_frontend_preferences', {
      preferences,
    });
  },
};

export type ProxyMode = 'auto' | 'manual';

export interface SystemProxySettings {
  mode: ProxyMode;
  proxy_url: string | null;
  detected_url?: string | null;
  detected_source?: 'system' | 'env' | 'pac' | string | null;
}

export interface SystemRenderingSettings {
  acceleration_mode: 'auto' | 'force_gpu' | 'disable_gpu';
}

export interface BackupCreateOptions {
  path: string;
  /** When set (non-empty), the backup is encrypted with this passphrase (P3-4). */
  passphrase?: string | null;
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
  /** Whether a live file already exists at this entry's restore target (P3-4). */
  already_exists: boolean;
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
    return backendCall<SystemProxySettings>('get_system_proxy_settings');
  },
  updateProxy: async (
    settings: SystemProxySettings
  ): Promise<SystemProxySettings> => {
    return backendCall<SystemProxySettings>('update_system_proxy_settings', {
      settings,
    });
  },
  getRendering: async (): Promise<SystemRenderingSettings> => {
    return backendCall<SystemRenderingSettings>(
      'get_system_rendering_settings'
    );
  },
  updateRendering: async (
    settings: SystemRenderingSettings
  ): Promise<SystemRenderingSettings> => {
    return backendCall<SystemRenderingSettings>(
      'update_system_rendering_settings',
      { settings }
    );
  },
};

export const backupApi = {
  create: async (options: BackupCreateOptions): Promise<BackupPreview> => {
    return backendCall<BackupPreview>('backup_create', { options });
  },
  inspect: async (options: BackupInspectOptions): Promise<BackupPreview> => {
    return backendCall<BackupPreview>('backup_inspect', { options });
  },
  restoreStage: async (
    payload: BackupRestoreStagePayload
  ): Promise<BackupRestoreResult> => {
    return backendCall<BackupRestoreResult>('backup_restore_stage', {
      payload,
    });
  },
  cancel: async (opId?: string | null): Promise<void> => {
    return backendCall<void>('backup_cancel', { opId: opId ?? null });
  },
};

export interface WebServiceConfig {
  port: number;
  token: string | null;
  auto_start: boolean;
  allow_lan?: boolean;
}

export interface AdvertisedListenAddress {
  origin: string;
  interface: string;
  ip: string;
  family: string;
}

export interface WebServerStatus {
  running: boolean;
  port: number;
  address: string | null;
  addresses?: string[];
  listen_addresses?: AdvertisedListenAddress[];
  token_configured: boolean;
  started_at: string | null;
  message: string | null;
  host_id?: string | null;
  reachability?: Array<{ origin: string; kind: string }>;
  serves_web_ui?: boolean;
}

export interface HostPairingChallenge {
  pairing_id: string;
  pairing_token: string;
  expires_at: string;
  requested_scopes: string[];
  host_id?: string;
  invitation?: string;
  connection_code?: string;
  preset?: string;
  reachability?: Array<{ origin: string; kind: string }>;
}

export interface HostPairedDevice {
  device_id: string;
  device_name: string;
  scopes: string[];
  created_at: string;
  preset: 'companion' | 'workstation' | null;
}

export interface PortProbeResult {
  port: number;
  available: boolean;
  message: string | null;
}

export interface HostClientProfile {
  id: string;
  origin: string;
  host_id: string | null;
  name: string;
  last_connected_at: string | null;
  needs_token: boolean;
  has_credential: boolean;
  connected: boolean;
}

export interface DiscoveredHost {
  origin: string;
  host_id: string | null;
  name: string | null;
  saved: boolean;
}

export interface HostClientStatus {
  connected: boolean;
  profile: HostClientProfile | null;
  profiles: HostClientProfile[];
}

export interface ConnectHostResult {
  profile: HostClientProfile;
  stopped_host: boolean;
}

export const hostClientApi = {
  status: async (): Promise<HostClientStatus> => {
    return backendCall<HostClientStatus>('host_client_status');
  },
  discover: async (): Promise<DiscoveredHost[]> => {
    return backendCall<DiscoveredHost[]>('host_client_discover');
  },
  connect: async (request: {
    origin?: string;
    token?: string;
    profile_id?: string;
  }): Promise<ConnectHostResult> => {
    return backendCall<ConnectHostResult>('host_client_connect', { request });
  },
  disconnect: async (): Promise<void> => {
    await backendCall('host_client_disconnect');
  },
  delete: async (profileId: string): Promise<void> => {
    await backendCall('host_client_delete', {
      request: { profile_id: profileId },
    });
  },
};

export type SavedHostTunnel = {
  id: string;
  origin: string;
  host: string;
  port: number;
  kind: string;
};

export type HostTunnelStatus = {
  enabled: boolean;
  saved: SavedHostTunnel[];
  active_id: string | null;
  pending: { host: string; port: number; command: string } | null;
  relay_state: string;
  last_error: string | null;
};

export type TunnelCheckResult = {
  origin: string;
  http: boolean;
};

export const hostTunnelApi = {
  get: async (): Promise<HostTunnelStatus> => {
    return backendCall<HostTunnelStatus>('get_host_tunnel');
  },
  setEnabled: async (enabled: boolean): Promise<HostTunnelStatus> => {
    return backendCall<HostTunnelStatus>('set_host_tunnel_enabled', {
      enabled,
    });
  },
  checkExisting: async (address: string): Promise<TunnelCheckResult> => {
    return backendCall<TunnelCheckResult>('check_existing_host_tunnel', {
      address,
    });
  },
  selectSaved: async (id: string): Promise<HostTunnelStatus> => {
    return backendCall<HostTunnelStatus>('select_saved_host_tunnel', { id });
  },
  startCreate: async (address: string): Promise<HostTunnelStatus> => {
    return backendCall<HostTunnelStatus>('start_create_host_tunnel', {
      address,
    });
  },
  confirmCreate: async (): Promise<HostTunnelStatus> => {
    return backendCall<HostTunnelStatus>('confirm_create_host_tunnel');
  },
  cancelCreate: async (): Promise<HostTunnelStatus> => {
    return backendCall<HostTunnelStatus>('cancel_create_host_tunnel');
  },
  removeSaved: async (id: string): Promise<HostTunnelStatus> => {
    return backendCall<HostTunnelStatus>('remove_saved_host_tunnel', { id });
  },
};

export const webServiceApi = {
  getConfig: async (): Promise<WebServiceConfig> => {
    return backendCall<WebServiceConfig>('get_web_service_config');
  },
  updateConfig: async (config: WebServiceConfig): Promise<WebServiceConfig> => {
    return backendCall<WebServiceConfig>('update_web_service_config', {
      config,
    });
  },
  getStatus: async (): Promise<WebServerStatus> => {
    return backendCall<WebServerStatus>('get_web_server_status');
  },
  start: async (): Promise<WebServerStatus> => {
    return backendCall<WebServerStatus>('start_web_server');
  },
  stop: async (): Promise<WebServerStatus> => {
    return backendCall<WebServerStatus>('stop_web_server');
  },
  probePort: async (port: number): Promise<PortProbeResult> => {
    return backendCall<PortProbeResult>('probe_web_service_port', { port });
  },
  generateToken: async (): Promise<WebServiceConfig> => {
    return backendCall<WebServiceConfig>('generate_web_service_token');
  },
  createPairing: async (
    preset: 'companion' | 'workstation' = 'companion',
    ttlSeconds?: number
  ): Promise<HostPairingChallenge> => {
    return backendCall<HostPairingChallenge>('create_host_device_pairing', {
      request: { preset, ttl_seconds: ttlSeconds },
    });
  },
  listDevices: async (): Promise<HostPairedDevice[]> => {
    return backendCall<HostPairedDevice[]>('list_host_devices');
  },
  revokeDevice: async (deviceId: string): Promise<void> => {
    await backendCall('revoke_host_device', {
      request: { device_id: deviceId },
    });
  },
};

export interface ChatChannelStatus {
  channel_id: string;
  status: string;
}

export interface ChatChannel {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  /** Type-specific non-secret fields (e.g. chat_id, app_id, webhook_url). */
  config: Record<string, unknown>;
  has_token: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChatChannelPayload {
  name: string;
  kind: string;
  enabled: boolean;
  config: Record<string, unknown>;
  /** Optional secret; empty/absent leaves a stored token unchanged on update. */
  token?: string | null;
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
    return backendCall<ChatChannel[]>('list_chat_channels');
  },
  statuses: async (): Promise<ChatChannelStatus[]> => {
    return backendCall<ChatChannelStatus[]>('list_chat_channel_statuses');
  },
  messageLogs: async (
    channelId: string,
    limit?: number
  ): Promise<ChatChannelMessageLog[]> => {
    return backendCall<ChatChannelMessageLog[]>(
      'list_chat_channel_message_logs',
      { channelId, limit: limit ?? null }
    );
  },
  create: async (payload: ChatChannelPayload): Promise<ChatChannel> => {
    return backendCall<ChatChannel>('create_chat_channel', { payload });
  },
  update: async (
    channelId: string,
    payload: ChatChannelPayload
  ): Promise<ChatChannel> => {
    return backendCall<ChatChannel>('update_chat_channel', {
      channelId,
      payload,
    });
  },
  delete: async (channelId: string): Promise<void> => {
    return backendCall<void>('delete_chat_channel', { channelId });
  },
  saveToken: async (channelId: string, token: string): Promise<ChatChannel> => {
    return backendCall<ChatChannel>('save_chat_channel_token', {
      channelId,
      token,
    });
  },
  hasToken: async (channelId: string): Promise<boolean> => {
    return backendCall<boolean>('get_chat_channel_has_token', { channelId });
  },
  deleteToken: async (channelId: string): Promise<void> => {
    return backendCall<void>('delete_chat_channel_token', { channelId });
  },
  test: async (channelId: string): Promise<ChatChannelTestResult> => {
    return backendCall<ChatChannelTestResult>('test_chat_channel', {
      channelId,
    });
  },
  connect: async (channelId: string): Promise<void> => {
    return backendCall<void>('connect_chat_channel', { channelId });
  },
  disconnect: async (channelId: string): Promise<void> => {
    return backendCall<void>('disconnect_chat_channel', { channelId });
  },
  getEventFilter: async (): Promise<ChatEventFilter> => {
    return backendCall<ChatEventFilter>('get_chat_event_filter');
  },
  setEventFilter: async (filter: ChatEventFilter): Promise<ChatEventFilter> => {
    return backendCall<ChatEventFilter>('set_chat_event_filter', { filter });
  },
  getCommandPrefix: async (): Promise<ChatCommandPrefix> => {
    return backendCall<ChatCommandPrefix>('get_chat_command_prefix');
  },
  setCommandPrefix: async (
    prefix: ChatCommandPrefix
  ): Promise<ChatCommandPrefix> => {
    return backendCall<ChatCommandPrefix>('set_chat_command_prefix', {
      prefix,
    });
  },
  getWebhooks: async (): Promise<Array<{ url: string; enabled: boolean }>> => {
    return backendCall('get_chat_event_webhooks');
  },
  setWebhooks: async (
    webhooks: Array<{ url: string; enabled: boolean }>
  ): Promise<Array<{ url: string; enabled: boolean }>> => {
    return backendCall('set_chat_event_webhooks', { webhooks });
  },
  getLanguage: async (): Promise<string> => {
    return backendCall('get_chat_message_language');
  },
  setLanguage: async (language: string): Promise<string> => {
    return backendCall('set_chat_message_language', { language });
  },
  weixinGetQrcode: async (): Promise<{
    qrcode_id: string;
    qrcode_url: string;
    qrcode_img_content: string;
  }> => {
    return backendCall('weixin_get_qrcode');
  },
  weixinCheckQrcode: async (
    channelId: string,
    qrcode: string
  ): Promise<{ status: string }> => {
    return backendCall('weixin_check_qrcode', {
      request: { channel_id: channelId, qrcode },
    });
  },
  getIncludePromptText: async (): Promise<boolean> => {
    return backendCall<boolean>('get_chat_include_prompt_text');
  },
  setIncludePromptText: async (enabled: boolean): Promise<boolean> => {
    return backendCall<boolean>('set_chat_include_prompt_text', { enabled });
  },
};

// Claude Settings (~/.claude/settings.json) APIs
export interface ClaudeSettings {
  env: Record<string, string>;
  enabled_plugins: Record<string, boolean>;
}

export const claudeSettingsApi = {
  get: async (): Promise<ClaudeSettings> => {
    return backendCall<ClaudeSettings>('get_claude_settings');
  },
  update: async (settings: ClaudeSettings): Promise<ClaudeSettings> => {
    return backendCall<ClaudeSettings>('update_claude_settings', { settings });
  },
};

// MCP marketplace (Smithery) + global hosting + per-agent sync.
// One agent identity for MCP surfaces: the shared selectable-agent union
// (canonical AgentKind keys), not a per-file copy.
export type McpAppType = string;

export interface LocalMcpServer {
  id: string;
  spec: Record<string, JsonValue>;
  /** Present in every compatible Agent's native configuration. */
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
    return backendCall<LocalMcpServer[]>('mcp_scan_local');
  },
  listMarketplaces: async (): Promise<McpMarketplaceProvider[]> => {
    return backendCall<McpMarketplaceProvider[]>('mcp_list_marketplaces');
  },
  search: async (params: {
    providerId: string;
    query?: string | null;
    limit?: number | null;
  }): Promise<McpMarketplaceItem[]> => {
    return backendCall<McpMarketplaceItem[]>('mcp_search_marketplace', {
      providerId: params.providerId,
      query: params.query ?? null,
      limit: params.limit ?? null,
    });
  },
  detail: async (params: {
    providerId: string;
    serverId: string;
  }): Promise<McpMarketplaceServerDetail> => {
    return backendCall<McpMarketplaceServerDetail>(
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
    return backendCall<LocalMcpServer[]>('mcp_install_marketplace_server', {
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
    return backendCall<LocalMcpServer[]>('mcp_upsert_local_server', {
      serverId: params.serverId,
      spec: params.spec,
      global: params.global,
      apps: params.apps,
    });
  },
  uninstall: async (serverId: string): Promise<LocalMcpServer[]> => {
    return backendCall<LocalMcpServer[]>('mcp_uninstall_server', { serverId });
  },
};

// Profiles API
export const profilesApi = {
  load: async (): Promise<{ content: string; path: string }> => {
    return backendCall<{ content: string; path: string }>('get_profiles');
  },
  save: async (content: string): Promise<string> => {
    return backendCall<string>('update_profiles', { body: content });
  },
};
