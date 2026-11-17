import type {
  AgentDiscoveryProgressView,
  AgentDiagnosticView,
  AgentEnvironmentDiagnosticsView,
  AgentEnvironmentPatchRequest,
  AgentEnvironmentView,
  AgentAuthModeView,
  AgentId,
  AgentManagementView,
  AgentAccountFlowView,
  AgentManagementActionReceipt,
  AgentManagementActionsView,
  AgentModelCatalogView,
  AgentModelProviderImportPreviewView,
  AgentModelProviderImportRequest,
  AgentModelProviderImportSource,
  AgentModelProviderProbeView,
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
  DshPluginSummaryView,
  GrokPluginSummaryView,
  PiPluginSummaryView,
  DshProviderDiscoverRequest,
  DshProviderModelView,
  DshProviderSaveRequest,
  DshProvidersView,
  OpenCodePluginSummaryView,
  PiCommandValidationView,
  PiConfigurationView,
  PiCredentialsSaveRequest,
  PiProjectTrustStateView,
  PiRuntimeSaveRequest,
  PiTrustEntryView,
  PlanUsageResult,
} from 'shared/types';

import { getUsageProviderService } from '@/features/plugins/providers/hostProviderServices';
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
    getUsageProviderService().probeAgentUsage(agentId, (id) =>
      backendCall('agent_plan_usage', { agentId: id })
    ),

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

  preflight: (
    agentId: AgentId,
    scope?: 'authentication'
  ): Promise<AgentPreflightView> =>
    backendCall('agent_management_preflight', { agentId, scope }),

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

  actions: (
    agentId: AgentId,
    providerInstanceId?: string | null
  ): Promise<AgentManagementActionsView> =>
    backendCall('agent_management_actions', {
      agentId,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    }),

  runAction: (
    agentId: AgentId,
    actionId: string,
    providerInstanceId?: string | null
  ): Promise<AgentManagementActionReceipt> =>
    backendCall('agent_management_run_action', {
      agentId,
      actionId,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    }),

  accountFlow: (
    agentId: AgentId,
    providerInstanceId?: string | null
  ): Promise<AgentAccountFlowView> =>
    backendCall('agent_management_account_flow', {
      agentId,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    }),

  requestCodexDeviceCode: (): Promise<CodexDeviceCodeView> =>
    backendCall('codex_request_device_code'),

  pollCodexDeviceCode: (
    deviceAuthId: string,
    userCode: string,
    providerInstanceId?: string | null
  ): Promise<CodexDeviceCodePollView> =>
    backendCall('codex_poll_device_code', {
      deviceAuthId,
      userCode,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    }),

  codexModelCatalog: (
    forceRefresh = false,
    providerInstanceId?: string | null
  ): Promise<AgentModelCatalogView> =>
    backendCall('codex_model_catalog', {
      forceRefresh,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    }),

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

  modelProviders: (
    agentId: AgentId,
    providerInstanceId?: string | null
  ): Promise<AgentModelProvidersView> =>
    backendCall('agent_model_providers', {
      agentId,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    }),

  listModelProviders: (
    agentId: AgentId,
    providerInstanceId?: string | null
  ): Promise<AgentModelProvidersView> =>
    backendCall('agent_model_providers', {
      agentId,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    }),

  modelProviderCatalog: (
    agentId: AgentId,
    providerId: string | null,
    apiUrl: string,
    apiKey: string | null,
    providerInstanceId?: string | null
  ): Promise<AgentModelCatalogView> =>
    backendCall('agent_model_provider_catalog', {
      agentId,
      providerId,
      apiUrl,
      apiKey,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    }),

  saveModelProvider: (
    request: AgentModelProviderSaveRequest & {
      provider_instance_id?: string | null;
      providerInstanceId?: string | null;
    }
  ): Promise<AgentModelProvidersView> =>
    backendCall('agent_model_provider_save', { request }),

  bindModelProvider: (
    agentId: AgentId,
    providerId: string | null,
    providerInstanceId?: string | null
  ): Promise<AgentModelProvidersView> =>
    backendCall('agent_model_provider_bind', {
      agentId,
      providerId,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    }),

  deleteModelProvider: (
    agentId: AgentId,
    providerId: string,
    providerInstanceId?: string | null
  ): Promise<AgentModelProvidersView> =>
    backendCall('agent_model_provider_delete', {
      agentId,
      providerId,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    }),

  probeModelProvider: (
    agentId: AgentId,
    providerId: string | null,
    apiUrl?: string | null,
    apiKey?: string | null,
    providerInstanceId?: string | null
  ): Promise<AgentModelProviderProbeView> =>
    backendCall('agent_model_provider_probe', {
      agentId,
      providerId,
      apiUrl: apiUrl ?? null,
      apiKey: apiKey ?? null,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    }),

  previewModelProviderImport: (
    agentId: AgentId,
    source: AgentModelProviderImportSource,
    providerInstanceId?: string | null
  ): Promise<AgentModelProviderImportPreviewView> =>
    backendCall('agent_model_provider_import_preview', {
      agentId,
      source,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    }),

  importModelProviders: (
    request: AgentModelProviderImportRequest & {
      provider_instance_id?: string | null;
      providerInstanceId?: string | null;
    }
  ): Promise<AgentModelProvidersView> =>
    backendCall('agent_model_provider_import', { request }),

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

  piProjectTrustState: (workspace: string): Promise<PiProjectTrustStateView> =>
    backendCall('pi_project_trust_state', { workspace }),

  setPiProjectTrust: (
    workspace: string,
    trusted: boolean | null
  ): Promise<PiProjectTrustStateView> =>
    backendCall('pi_project_trust_set', { workspace, trusted }),

  acknowledgePiProjectTrust: (
    workspace: string
  ): Promise<PiProjectTrustStateView> =>
    backendCall('pi_project_trust_acknowledge', { workspace }),

  piTrustEntries: (): Promise<PiTrustEntryView[]> =>
    backendCall('pi_trust_entries'),

  authMode: (
    agentId: AgentId,
    providerInstanceId?: string | null
  ): Promise<AgentAuthModeView> =>
    backendCall('agent_auth_mode', {
      agentId,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    }),

  setAuthMode: (
    agentId: AgentId,
    mode: string,
    apiKey: string | null,
    providerInstanceId?: string | null
  ): Promise<AgentAuthModeView> =>
    backendCall('agent_auth_mode_set', {
      agentId,
      mode,
      apiKey,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    }),

  openCodePlugins: (
    agentId: AgentId = 'opencode'
  ): Promise<OpenCodePluginSummaryView> =>
    backendCall('opencode_plugin_list', { agentId }),

  installOpenCodePlugins: (
    names: string[] | null = null,
    agentId: AgentId = 'opencode'
  ): Promise<OpenCodePluginSummaryView> =>
    backendCall('opencode_plugin_install', { names, agentId }),

  addOpenCodePlugin: (
    spec: string,
    agentId: AgentId = 'opencode'
  ): Promise<OpenCodePluginSummaryView> =>
    backendCall('opencode_plugin_add', { spec, agentId }),

  uninstallOpenCodePlugin: (
    name: string,
    agentId: AgentId = 'opencode'
  ): Promise<OpenCodePluginSummaryView> =>
    backendCall('opencode_plugin_uninstall', { name, agentId }),

  openCodeProviders: (
    agentId: AgentId = 'opencode'
  ): Promise<OpenCodeProviderConnectionsView> =>
    backendCall('opencode_provider_connections', { agentId }),

  openCodeProviderCatalog: (
    forceRefresh = false
  ): Promise<OpenCodeProviderCatalogView> =>
    backendCall('opencode_provider_catalog', { forceRefresh }),

  connectOpenCodeProvider: (
    request: OpenCodeProviderConnectRequest,
    agentId: AgentId = 'opencode'
  ): Promise<OpenCodeProviderConnectionsView> =>
    backendCall('opencode_provider_connect', { agentId, request }),

  importOpenCodeProviders: (
    request: AgentModelProviderImportRequest
  ): Promise<OpenCodeProviderConnectionsView> =>
    backendCall('opencode_provider_import', { request }),

  disconnectOpenCodeProvider: (
    providerId: string,
    agentId: AgentId = 'opencode'
  ): Promise<OpenCodeProviderConnectionsView> =>
    backendCall('opencode_provider_disconnect', { agentId, providerId }),

  setOpenCodeProviderEnabled: (
    providerId: string,
    enabled: boolean,
    agentId: AgentId = 'opencode'
  ): Promise<OpenCodeProviderConnectionsView> =>
    backendCall('opencode_provider_set_enabled', {
      agentId,
      providerId,
      enabled,
    }),

  dshProviders: (): Promise<DshProvidersView> => backendCall('dsh_providers'),

  saveDshProvider: (
    request: DshProviderSaveRequest
  ): Promise<DshProvidersView> => backendCall('dsh_provider_save', { request }),

  deleteDshProvider: (providerId: string): Promise<DshProvidersView> =>
    backendCall('dsh_provider_delete', { providerId }),

  discoverDshModels: (
    request: DshProviderDiscoverRequest
  ): Promise<DshProviderModelView[]> =>
    backendCall('dsh_provider_discover_models', { request }),

  dshPlugins: (): Promise<DshPluginSummaryView> => backendCall('dsh_plugins'),

  addDshPlugin: (spec: string): Promise<DshPluginSummaryView> =>
    backendCall('dsh_plugin_add', { spec }),

  removeDshPlugin: (name: string): Promise<DshPluginSummaryView> =>
    backendCall('dsh_plugin_remove', { name }),

  grokPlugins: (): Promise<GrokPluginSummaryView> =>
    backendCall('grok_plugins'),

  addGrokPlugin: (spec: string): Promise<GrokPluginSummaryView> =>
    backendCall('grok_plugin_add', { spec }),

  removeGrokPlugin: (name: string): Promise<GrokPluginSummaryView> =>
    backendCall('grok_plugin_remove', { name }),

  piPlugins: (): Promise<PiPluginSummaryView> => backendCall('pi_plugins'),

  addPiPlugin: (spec: string): Promise<PiPluginSummaryView> =>
    backendCall('pi_plugin_add', { spec }),

  removePiPlugin: (spec: string): Promise<PiPluginSummaryView> =>
    backendCall('pi_plugin_remove', { spec }),

  repair: (agentId: AgentId): Promise<AgentOperationReceipt> =>
    backendCall('agent_management_repair', { agentId }),

  checkUpdate: (
    agentId: AgentId,
    input?: {
      runtimeVersion?: string;
      acpVersion?: string;
      force?: boolean;
    }
  ): Promise<AgentUpdateCheckView> =>
    backendCall('agent_management_check_update', {
      agentId,
      runtimeVersion: input?.runtimeVersion,
      acpVersion: input?.acpVersion,
      force: input?.force,
    }),

  applyUpdate: (agentId: AgentId): Promise<AgentOperationReceipt> =>
    backendCall('agent_management_apply_update', { agentId }),

  installVersion: (
    agentId: AgentId,
    input: {
      version?: string;
      runtimeVersion?: string;
      acpVersion?: string;
    }
  ): Promise<AgentOperationReceipt> =>
    backendCall('agent_management_install_version', {
      agentId,
      version: input.version,
      runtimeVersion: input.runtimeVersion,
      acpVersion: input.acpVersion,
    }),

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

  uninstall: (
    agentId: AgentId,
    options?: { clearData?: boolean }
  ): Promise<AgentManagementView | AgentManagementView[]> =>
    backendCall('agent_management_uninstall', {
      agentId,
      ...(options?.clearData !== undefined
        ? { clearData: options.clearData }
        : {}),
    }),

  remove: (agentId: AgentId): Promise<void> =>
    backendCall('agent_management_remove', { agentId }),

  readConfig: (
    agentId: AgentId,
    providerInstanceId?: string | null
  ): Promise<AgentNativeConfigView> =>
    backendCall('agent_management_config_read', {
      agentId,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    }),

  writeConfig: (
    request: AgentNativeConfigPatchRequest,
    providerInstanceId?: string | null
  ): Promise<AgentNativeConfigView> =>
    backendCall('agent_management_config_write', {
      request,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    }),

  writeConfigFile: (
    request: AgentNativeConfigFileWriteRequest,
    providerInstanceId?: string | null
  ): Promise<AgentNativeConfigView> =>
    backendCall('agent_management_config_file_write', {
      request,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    }),

  diagnostics: (agentId: AgentId): Promise<AgentDiagnosticView[]> =>
    backendCall('agent_management_diagnostics', { agentId }),

  markDiagnosticsRead: (agentId: AgentId): Promise<void> =>
    backendCall('agent_management_mark_diagnostics_read', { agentId }),

  clearDiagnostics: (agentId: AgentId): Promise<void> =>
    backendCall('agent_management_clear_diagnostics', { agentId }),
};
