import type { Mock } from 'vitest';
import type { AgentNativeConfigFieldView } from 'shared/types';

export type AgentSettingsApiMocks = {
  bar: Mock;
  registry: Mock;
  refreshRegistry: Mock;
  addAndInstall: Mock;
  addUserDefinitionAndInstall: Mock;
  userDefinition: Mock;
  updateUserDefinition: Mock;
  setEnabled: Mock;
  reorder: Mock;
  preflight: Mock;
  repair: Mock;
  update: Mock;
  checkUpdate: Mock;
  applyUpdate: Mock;
  rollback: Mock;
  cancelOperation: Mock;
  uninstall: Mock;
  remove: Mock;
  readConfig: Mock;
  writeConfig: Mock;
  writeConfigFile: Mock;
  diagnostics: Mock;
  markDiagnosticsRead: Mock;
  actions: Mock;
  runAction: Mock;
  accountFlow: Mock;
  authMode: Mock;
  setAuthMode: Mock;
  environment: Mock;
  dshProviders: Mock;
  dshPlugins: Mock;
  grokPlugins: Mock;
  piPlugins: Mock;
  piConfiguration: Mock;
  piTrustEntries: Mock;
  validatePiCommand: Mock;
  modelProviders: Mock;
  saveModelProvider: Mock;
  bindModelProvider: Mock;
  connectOpenCodeProvider: Mock;
  clearDiagnostics: Mock;
};

export type AgentSettingsHarnessState = {
  api: AgentSettingsApiMocks;
  confirmShow: Mock;
  listeners: Map<string, (event: unknown) => void>;
  tauriListeners: Map<string, (event: unknown) => void>;
  tauriInvokeMock: Mock;
  redeemImportTicketMock: Mock;
  userSystem: {
    config: {
      executor_profile: { executor: string; variant: string | null };
    };
    loading: boolean;
    updateAndSaveConfig: Mock;
  };
};

export function resetAgentSettingsHarness({
  api,
  confirmShow,
  listeners,
  tauriListeners,
  tauriInvokeMock,
  redeemImportTicketMock,
  userSystem,
}: AgentSettingsHarnessState): void {
  listeners.clear();
  tauriListeners.clear();
  tauriInvokeMock.mockReset();
  tauriInvokeMock.mockResolvedValue(null);
  redeemImportTicketMock.mockReset();
  Object.values(api).forEach((mock) => mock.mockReset());
  userSystem.config = {
    executor_profile: { executor: 'codex', variant: null },
  };
  userSystem.updateAndSaveConfig.mockReset();
  userSystem.updateAndSaveConfig.mockResolvedValue(true);
  confirmShow.mockReset();
  confirmShow.mockResolvedValue('cancelled');
  api.bar.mockResolvedValue([
    {
      agent_id: 'codex',
      display_name: 'Codex',
      description: 'OpenAI Codex (official native app-server engine)',
      icon_light: null,
      icon_dark: null,
      icon_svg: null,
      source: 'built_in_profile',
      built_in: true,
      retired: false,
      enabled: true,
      position: 0,
      lifecycle: 'ready',
      authentication: 'account',
      runtime_version: '1.0.0',
      acp_version: '1.0.0',
      active_operation: null,
      rollback_available: false,
      settings_features: ['authentication_mode'],
    },
  ]);
  api.readConfig.mockResolvedValue({
    agent_id: 'codex',
    available: false,
    settings_features: ['authentication_mode'],
    path: null,
    paths: [],
    fields: [],
    files: [],
    applies_to_next_session: true,
  });
  api.preflight.mockResolvedValue({
    agent_id: 'codex',
    checked_at: '2026-08-21T00:00:00Z',
    items: [],
  });
  api.checkUpdate.mockResolvedValue({
    agent_id: 'codex',
    current_version: null,
    available_version: null,
    update_available: false,
    snapshot_id: null,
    fetched_at: null,
    fresh: false,
  });
  api.diagnostics.mockResolvedValue([]);
  api.markDiagnosticsRead.mockResolvedValue(undefined);
  api.actions.mockResolvedValue({ agent_id: 'codex', actions: [] });
  api.accountFlow.mockResolvedValue({
    agent_id: 'codex',
    action_id: null,
    status: 'idle',
    exit_code: null,
    authentication: null,
  });
  api.environment.mockResolvedValue({
    agent_id: 'codex',
    revision: '0',
    entries: [],
  });
  api.dshProviders.mockResolvedValue({
    settings_path: '/tmp/.dsh/settings.yaml',
    credentials_path: '/tmp/.dsh/.credentials.yaml',
    default_provider: 'deepseek-official',
    default_model: 'deepseek-v4-flash',
    providers: [
      {
        id: 'deepseek-official',
        display_name: 'DeepSeek',
        kind: 'official',
        notes: null,
        api: null,
        base_url: null,
        api_key_env: 'DEEPSEEK_API_KEY',
        credential_present: true,
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }],
      },
    ],
    catalog: [],
  });
  api.dshPlugins.mockResolvedValue({
    profile: 'default',
    profile_dir: '/tmp/.dsh/profiles/default',
    plugins: [
      {
        name: 'dsh-hello-plugin',
        version: '0.1.0',
        reserved: false,
        source: 'default',
        kind: 'plugin',
        path: null,
        summary: null,
      },
    ],
  });
  api.grokPlugins.mockResolvedValue({
    home: '/tmp/.grok',
    plugins: [
      {
        name: 'ponytail',
        version: null,
        status: 'installed',
        path: '/tmp/.grok/installed-plugins/ponytail',
        source: 'https://github.com/example/ponytail',
        marketplace: null,
      },
    ],
  });
  api.piPlugins.mockResolvedValue({
    home: '/tmp/.pi/agent',
    plugins: [
      {
        source: 'npm:pi-package-manager',
        name: 'pi-package-manager',
        version: null,
        kind: 'npm',
        path: null,
      },
    ],
  });
  api.piConfiguration.mockResolvedValue({
    default_provider: 'anthropic',
    default_model: 'claude-sonnet-4',
    thinking_level: 'medium',
    credential_present: true,
    auth_providers: ['anthropic'],
    custom_providers: [],
    runtime: {
      mode: 'default',
      command: '',
      config_dir: '',
      session_dir: '',
      trust_workspace: true,
    },
  });
  api.piTrustEntries.mockResolvedValue([]);
  api.validatePiCommand.mockResolvedValue({
    found: true,
    resolved_path: '/usr/bin/pi',
    version: 'pi 0.1',
  });
  api.modelProviders.mockResolvedValue({
    agent_id: 'codex',
    providers: [],
    bound_provider_id: null,
  });
  api.authMode.mockResolvedValue({
    agent_id: 'codex',
    mode: 'chatgpt_subscription',
    credential_env: 'OPENAI_API_KEY',
    credential_present: false,
    modes: ['chatgpt_subscription', 'api_key', 'model_provider'],
    options: [
      {
        value: 'api_key',
        kind: 'official_api',
        label_key: 'agents.authModeOpenAiKey',
        description_key: 'agents.authDescCodexKey',
        credential_env: 'OPENAI_API_KEY',
        native_config_field_id: 'openai_api_key',
        credential_required: true,
      },
      {
        value: 'chatgpt_subscription',
        kind: 'subscription',
        label_key: 'agents.authModeChatGpt',
        description_key: 'agents.authDescCodexSubscription',
        credential_env: null,
        native_config_field_id: null,
        credential_required: false,
      },
      {
        value: 'model_provider',
        kind: 'provider',
        label_key: 'agents.authModeProvider',
        description_key: 'agents.authDescCodexProvider',
        credential_env: null,
        native_config_field_id: null,
        credential_required: false,
      },
    ],
  });
}

export function configField(
  field: Partial<AgentNativeConfigFieldView> &
    Pick<AgentNativeConfigFieldView, 'id' | 'label'>
): AgentNativeConfigFieldView {
  return {
    description: '',
    kind: 'text',
    options: [],
    secret: false,
    path: '/tmp/config',
    present: true,
    value: null,
    masked_value: field.secret ? '••••••••' : null,
    revision: `${field.id}-revision`,
    surface: 'configuration',
    ...field,
  };
}
