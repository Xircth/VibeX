import type {
  AgentDiscoveryProgressView,
  AgentDiagnosticView,
  AgentEnvironmentDiagnosticsView,
  AgentEnvironmentPatchRequest,
  AgentEnvironmentView,
  AgentAuthModeView,
  AgentId,
  AgentManagementView,
  AgentManagementActionReceipt,
  AgentManagementActionsView,
  AgentModelCatalogView,
  AgentModelProviderSaveRequest,
  AgentModelProvidersView,
  AgentNativeConfigPatchRequest,
  AgentNativeConfigFileWriteRequest,
  AgentNativeConfigView,
  AgentOperationReceipt,
  AgentPreflightView,
  AgentRegistryView,
  AgentUpdateCheckView,
  CodexDeviceCodePollView,
  CodexDeviceCodeView,
  CodexModelCatalogConfigRequest,
  CodexModelCatalogConfigView,
  UserAgentDefinitionRequest,
  UserAgentDefinitionView,
  OpenCodeProviderConnectRequest,
  OpenCodeProviderCatalogView,
  OpenCodeProviderConnectionsView,
  OpenCodePluginSummaryView,
  PiCommandValidationView,
  PiConfigurationView,
  PiCredentialsSaveRequest,
  PiRuntimeSaveRequest,
  PlanUsageResult,
} from 'shared/types';

import { backendCall } from '@/lib/backendTransport';

export const agentManagementApi = {
  bar: (): Promise<AgentManagementView[]> =>
    backendCall('agent_management_bar'),

  discoveryProgress: (): Promise<AgentDiscoveryProgressView> =>
    backendCall('agent_management_discovery_progress'),

  refreshBar: (): Promise<AgentManagementView[]> =>
    backendCall('agent_management_refresh'),

  detail: (agentId: AgentId): Promise<AgentManagementView> =>
    backendCall('agent_management_detail', { agentId }),

  planUsage: (agentId: AgentId): Promise<PlanUsageResult> =>
    backendCall('agent_plan_usage', { agentId }),

  registry: (): Promise<AgentRegistryView> =>
    backendCall('agent_registry_view'),

  refreshRegistry: (): Promise<AgentRegistryView> =>
    backendCall('agent_registry_refresh'),

  addAndInstall: (agentId: AgentId): Promise<AgentOperationReceipt> =>
    backendCall('agent_registry_add_and_install', { agentId }),

  addUserDefinitionAndInstall: (
    request: UserAgentDefinitionRequest
  ): Promise<AgentOperationReceipt> =>
    backendCall('agent_user_definition_add_and_install', { request }),

  userDefinition: (agentId: AgentId): Promise<UserAgentDefinitionView> =>
    backendCall('agent_user_definition_detail', { agentId }),

  updateUserDefinition: (
    request: UserAgentDefinitionRequest
  ): Promise<UserAgentDefinitionView> =>
    backendCall('agent_user_definition_update', { request }),

  setEnabled: (
    agentId: AgentId,
    enabled: boolean
  ): Promise<AgentManagementView> =>
    backendCall('agent_management_set_enabled', { agentId, enabled }),

  reorder: (agentIds: AgentId[]): Promise<AgentManagementView[]> =>
    backendCall('agent_management_reorder', { agentIds }),

  preflight: (agentId: AgentId): Promise<AgentPreflightView> =>
    backendCall('agent_management_preflight', { agentId }),

  environment: (agentId: AgentId): Promise<AgentEnvironmentView> =>
    backendCall('agent_management_environment', { agentId }),

  environmentDiagnostics: (
    agentId: AgentId
  ): Promise<AgentEnvironmentDiagnosticsView> =>
    backendCall('agent_management_environment_diagnostics', { agentId }),

  writeEnvironment: (
    request: AgentEnvironmentPatchRequest
  ): Promise<AgentEnvironmentView> =>
    backendCall('agent_management_environment_write', { request }),

  actions: (agentId: AgentId): Promise<AgentManagementActionsView> =>
    backendCall('agent_management_actions', { agentId }),

  runAction: (
    agentId: AgentId,
    actionId: string
  ): Promise<AgentManagementActionReceipt> =>
    backendCall('agent_management_run_action', { agentId, actionId }),

  requestCodexDeviceCode: (): Promise<CodexDeviceCodeView> =>
    backendCall('codex_request_device_code'),

  pollCodexDeviceCode: (
    deviceAuthId: string,
    userCode: string
  ): Promise<CodexDeviceCodePollView> =>
    backendCall('codex_poll_device_code', { deviceAuthId, userCode }),

  codexModelCatalog: (forceRefresh = false): Promise<AgentModelCatalogView> =>
    backendCall('codex_model_catalog', { forceRefresh }),

  codexModelCatalogConfig: (): Promise<CodexModelCatalogConfigView> =>
    backendCall('codex_model_catalog_config'),

  applyCodexModelCatalog: (
    request: CodexModelCatalogConfigRequest
  ): Promise<CodexModelCatalogConfigView> =>
    backendCall('codex_model_catalog_apply', { request }),

  cursorModelCatalog: (): Promise<AgentModelCatalogView> =>
    backendCall('cursor_model_catalog'),

  kimiModelCatalog: (
    baseUrl: string,
    apiKey: string
  ): Promise<AgentModelCatalogView> =>
    backendCall('kimi_model_catalog', { baseUrl, apiKey }),

  modelProviders: (agentId: AgentId): Promise<AgentModelProvidersView> =>
    backendCall('agent_model_providers', { agentId }),

  modelProviderCatalog: (
    agentId: AgentId,
    providerId: string | null,
    apiUrl: string,
    apiKey: string | null
  ): Promise<AgentModelCatalogView> =>
    backendCall('agent_model_provider_catalog', {
      agentId,
      providerId,
      apiUrl,
      apiKey,
    }),

  saveModelProvider: (
    request: AgentModelProviderSaveRequest
  ): Promise<AgentModelProvidersView> =>
    backendCall('agent_model_provider_save', { request }),

  bindModelProvider: (
    agentId: AgentId,
    providerId: string | null
  ): Promise<AgentModelProvidersView> =>
    backendCall('agent_model_provider_bind', { agentId, providerId }),

  deleteModelProvider: (
    agentId: AgentId,
    providerId: string
  ): Promise<AgentModelProvidersView> =>
    backendCall('agent_model_provider_delete', { agentId, providerId }),

  piConfiguration: (): Promise<PiConfigurationView> =>
    backendCall('pi_configuration'),

  savePiCredentials: (
    request: PiCredentialsSaveRequest
  ): Promise<PiConfigurationView> =>
    backendCall('pi_credentials_save', { request }),

  savePiRuntime: (request: PiRuntimeSaveRequest): Promise<void> =>
    backendCall('pi_runtime_save', { request }),

  validatePiCommand: (command: string): Promise<PiCommandValidationView> =>
    backendCall('pi_command_validate', { command }),

  authMode: (agentId: AgentId): Promise<AgentAuthModeView> =>
    backendCall('agent_auth_mode', { agentId }),

  setAuthMode: (
    agentId: AgentId,
    mode: string,
    apiKey: string | null
  ): Promise<AgentAuthModeView> =>
    backendCall('agent_auth_mode_set', { agentId, mode, apiKey }),

  openCodePlugins: (): Promise<OpenCodePluginSummaryView> =>
    backendCall('opencode_plugin_list'),

  installOpenCodePlugins: (
    names: string[] | null = null
  ): Promise<OpenCodePluginSummaryView> =>
    backendCall('opencode_plugin_install', { names }),

  uninstallOpenCodePlugin: (name: string): Promise<OpenCodePluginSummaryView> =>
    backendCall('opencode_plugin_uninstall', { name }),

  openCodeProviders: (): Promise<OpenCodeProviderConnectionsView> =>
    backendCall('opencode_provider_connections'),

  openCodeProviderCatalog: (
    forceRefresh = false
  ): Promise<OpenCodeProviderCatalogView> =>
    backendCall('opencode_provider_catalog', { forceRefresh }),

  connectOpenCodeProvider: (
    request: OpenCodeProviderConnectRequest
  ): Promise<OpenCodeProviderConnectionsView> =>
    backendCall('opencode_provider_connect', { request }),

  disconnectOpenCodeProvider: (
    providerId: string
  ): Promise<OpenCodeProviderConnectionsView> =>
    backendCall('opencode_provider_disconnect', { providerId }),

  setOpenCodeProviderEnabled: (
    providerId: string,
    enabled: boolean
  ): Promise<OpenCodeProviderConnectionsView> =>
    backendCall('opencode_provider_set_enabled', { providerId, enabled }),

  repair: (agentId: AgentId): Promise<AgentOperationReceipt> =>
    backendCall('agent_management_repair', { agentId }),

  checkUpdate: (agentId: AgentId): Promise<AgentUpdateCheckView> =>
    backendCall('agent_management_check_update', { agentId }),

  applyUpdate: (agentId: AgentId): Promise<AgentOperationReceipt> =>
    backendCall('agent_management_apply_update', { agentId }),

  installVersion: (
    agentId: AgentId,
    version: string
  ): Promise<AgentOperationReceipt> =>
    backendCall('agent_management_install_version', { agentId, version }),

  rollback: (agentId: AgentId): Promise<AgentManagementView> =>
    backendCall('agent_management_rollback', { agentId }),

  cancelOperation: (
    agentId: AgentId,
    operationId: string
  ): Promise<AgentOperationReceipt> =>
    backendCall('agent_management_cancel_operation', {
      agentId,
      operationId,
    }),

  uninstall: (agentId: AgentId): Promise<AgentManagementView> =>
    backendCall('agent_management_uninstall', { agentId }),

  remove: (agentId: AgentId): Promise<void> =>
    backendCall('agent_management_remove', { agentId }),

  readConfig: (agentId: AgentId): Promise<AgentNativeConfigView> =>
    backendCall('agent_management_config_read', { agentId }),

  writeConfig: (
    request: AgentNativeConfigPatchRequest
  ): Promise<AgentNativeConfigView> =>
    backendCall('agent_management_config_write', { request }),

  writeConfigFile: (
    request: AgentNativeConfigFileWriteRequest
  ): Promise<AgentNativeConfigView> =>
    backendCall('agent_management_config_file_write', { request }),

  diagnostics: (agentId: AgentId): Promise<AgentDiagnosticView[]> =>
    backendCall('agent_management_diagnostics', { agentId }),

  markDiagnosticsRead: (agentId: AgentId): Promise<void> =>
    backendCall('agent_management_mark_diagnostics_read', { agentId }),

  clearDiagnostics: (agentId: AgentId): Promise<void> =>
    backendCall('agent_management_clear_diagnostics', { agentId }),
};
