import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toast } from '@/components/ui/toast';
import { renderWithQueryClient as render } from '@/test/QueryClientHarness';

import { AgentSettings } from './AgentSettings';
import { resetAgentSettingsHarness } from './agentSettingsTestHarness';
import { pickAuthModeTab } from './agentSettingsTestUtils';

const api = vi.hoisted(() => ({
  bar: vi.fn(),
  registry: vi.fn(),
  refreshRegistry: vi.fn(),
  addAndInstall: vi.fn(),
  addUserDefinitionAndInstall: vi.fn(),
  userDefinition: vi.fn(),
  updateUserDefinition: vi.fn(),
  setEnabled: vi.fn(),
  reorder: vi.fn(),
  preflight: vi.fn(),
  repair: vi.fn(),
  update: vi.fn(),
  checkUpdate: vi.fn(),
  applyUpdate: vi.fn(),
  rollback: vi.fn(),
  cancelOperation: vi.fn(),
  uninstall: vi.fn(),
  remove: vi.fn(),
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  writeConfigFile: vi.fn(),
  diagnostics: vi.fn(),
  markDiagnosticsRead: vi.fn(),
  actions: vi.fn(),
  runAction: vi.fn(),
  accountFlow: vi.fn(),
  authMode: vi.fn(),
  setAuthMode: vi.fn(),
  environment: vi.fn(),
  dshProviders: vi.fn(),
  dshPlugins: vi.fn(),
  grokPlugins: vi.fn(),
  piPlugins: vi.fn(),
  piConfiguration: vi.fn(),
  piTrustEntries: vi.fn(),
  validatePiCommand: vi.fn(),
  modelProviders: vi.fn(),
  saveModelProvider: vi.fn(),
  bindModelProvider: vi.fn(),
  connectOpenCodeProvider: vi.fn(),
  clearDiagnostics: vi.fn(),
}));
const confirmShow = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Map<string, (event: unknown) => void>());
const tauriListeners = vi.hoisted(
  () => new Map<string, (event: unknown) => void>()
);
const tauriInvokeMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const redeemImportTicketMock = vi.hoisted(() => vi.fn());
const userSystem = vi.hoisted(() => ({
  config: {
    executor_profile: { executor: 'codex', variant: null as string | null },
  },
  loading: false,
  updateAndSaveConfig: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => userSystem,
}));

vi.mock('@/components/dialogs/shared/ConfirmDialog', () => ({
  ConfirmDialog: { show: confirmShow },
}));

vi.mock('@/features/agent-management/api', () => ({
  agentManagementApi: api,
}));

vi.mock('@/features/model-router', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/model-router')>();
  return {
    ...actual,
    accountApi: {
      ...actual.accountApi,
      redeemImportTicket: redeemImportTicketMock,
    },
  };
});

vi.mock('./PluginsSettings', () => ({
  PluginsSettings: ({ ecosystem }: { ecosystem: string }) => (
    <section aria-label={`${ecosystem} native plugins`}>
      Native plugin manager
    </section>
  ),
}));

vi.mock('@/lib/tauriApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/tauriApi')>();
  return {
    ...original,
    tauriInvoke: tauriInvokeMock,
    tauriListen: vi.fn(
      async (event: string, listener: (event: unknown) => void) => {
        tauriListeners.set(event, listener);
        return vi.fn();
      }
    ),
  };
});

vi.mock('@/lib/backendTransport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/backendTransport')>();
  return {
    ...actual,
    backendListen: vi.fn(
      async (event: string, listener: (event: unknown) => void) => {
        listeners.set(event, listener);
        return vi.fn();
      }
    ),
  };
});

describe('AgentSettings (account flows & post-operation refreshes)', () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  beforeEach(() => {
    resetAgentSettingsHarness({
      api,
      confirmShow,
      listeners,
      tauriListeners,
      tauriInvokeMock,
      redeemImportTicketMock,
      userSystem,
    });
  });

  it('refreshes login status after a terminal account flow finishes', async () => {
    const user = userEvent.setup();
    const loggedOut = {
      agent_id: 'cursor',
      display_name: 'Cursor',
      description: 'Cursor ACP',
      icon_light: null,
      icon_dark: null,
      icon_svg: null,
      source: 'built_in_profile',
      built_in: true,
      retired: false,
      enabled: true,
      position: 0,
      lifecycle: 'needs_auth',
      authentication: 'not_logged_in',
      runtime_version: '1.0.0',
      acp_version: '1.0.0',
      active_operation: null,
      rollback_available: false,
    };
    const loggedIn = {
      ...loggedOut,
      lifecycle: 'ready',
      authentication: 'account',
    };
    api.bar.mockResolvedValue([loggedOut]);
    api.readConfig.mockResolvedValue({
      agent_id: 'cursor',
      available: false,
      settings_features: ['authentication_mode'],
      path: null,
      paths: [],
      fields: [],
      files: [],
      applies_to_next_session: true,
    });
    api.authMode.mockResolvedValue({
      agent_id: 'cursor',
      mode: 'subscription',
      credential_env: 'CURSOR_API_KEY',
      credential_present: false,
      modes: ['subscription', 'custom'],
      options: [
        {
          value: 'subscription',
          kind: 'subscription',
          label_key: 'agents.authModeSubscription',
          description_key: 'agents.authDescCursorSubscription',
          credential_env: null,
          native_config_field_id: null,
          credential_required: false,
        },
        {
          value: 'custom',
          kind: 'official_api',
          label_key: 'agents.authModeCursorKey',
          description_key: 'agents.authDescCursorKey',
          credential_env: 'CURSOR_API_KEY',
          native_config_field_id: null,
          credential_required: true,
        },
      ],
    });
    api.actions.mockResolvedValue({
      agent_id: 'cursor',
      actions: [
        {
          id: 'login',
          label: '登录 Cursor',
          description: '使用 Cursor 订阅账号登录',
          label_key: 'agents.managementAction.cursor.login.label',
          description_key: 'agents.managementAction.cursor.login.description',
          kind: 'login',
          available: true,
          unavailable_reason: null,
          url: null,
        },
      ],
    });
    api.runAction.mockImplementation(async () => {
      api.bar.mockResolvedValue([loggedIn]);
      api.accountFlow.mockResolvedValue({
        agent_id: 'cursor',
        action_id: 'login',
        status: 'succeeded',
        exit_code: 0,
        authentication: 'account',
      });
      return {
        agent_id: 'cursor',
        action_id: 'login',
        launched: true,
      };
    });

    render(<AgentSettings />);
    expect(await screen.findByText('暂未登录')).toBeVisible();
    await user.click(
      await screen.findByRole('button', { name: '登录 Cursor' })
    );
    await waitFor(() =>
      expect(api.runAction).toHaveBeenCalledWith('cursor', 'login')
    );
    await waitFor(() => expect(api.accountFlow).toHaveBeenCalledWith('cursor'));
    await waitFor(() =>
      expect(screen.getByText('已通过账号登录')).toBeVisible()
    );
    expect(api.preflight).toHaveBeenCalledWith('cursor', 'authentication');
    expect(api.accountFlow).toHaveBeenCalledWith('cursor');
  });

  it('shows browserLoginStarted toast when logging in to Antigravity', async () => {
    const user = userEvent.setup();
    const successSpy = vi.spyOn(toast, 'success');
    const loggedOut = {
      agent_id: 'antigravity',
      display_name: 'Antigravity',
      description: 'Antigravity ACP',
      icon_light: null,
      icon_dark: null,
      icon_svg: null,
      source: 'built_in_profile',
      built_in: true,
      retired: false,
      enabled: true,
      position: 0,
      lifecycle: 'needs_auth',
      authentication: 'not_logged_in',
      runtime_version: '1.0.0',
      acp_version: '1.0.0',
      active_operation: null,
      attention_reason: null,
      is_default: true,
    };
    const loggedIn = {
      ...loggedOut,
      lifecycle: 'healthy',
      authentication: 'account',
    };
    api.bar.mockResolvedValue([loggedOut]);
    api.readConfig.mockResolvedValue({
      agent_id: 'antigravity',
      available: false,
      settings_features: ['authentication_mode'],
      path: null,
      paths: [],
      fields: [],
      files: [],
      applies_to_next_session: true,
    });
    api.authMode.mockResolvedValue({
      agent_id: 'antigravity',
      mode: 'oauth-personal',
      modes: ['oauth-personal', 'oauth-business'],
      options: [
        {
          value: 'oauth-personal',
          kind: 'subscription',
          label: 'Google 账号登录',
          label_key: 'agents.authModeGoogleLogin',
          description: 'OAuth 登录',
          description_key: 'agents.authDescAntigravityOauthPersonal',
          credential_env: null,
          credential_required: false,
          native_config_field_id: null,
        },
      ],
      credential_env: 'GEMINI_API_KEY',
      credential_present: false,
      account_label: null,
    });
    api.actions.mockResolvedValue({
      agent_id: 'antigravity',
      actions: [
        {
          id: 'login',
          kind: 'login',
          label: '登录',
          label_key: 'agents.managementAction.antigravity.login.label',
          description: '在浏览器中完成 Antigravity 账号登录',
          description_key:
            'agents.managementAction.antigravity.login.description',
          available: true,
          unavailable_reason: null,
          url: null,
        },
      ],
    });
    api.runAction.mockImplementation(async () => {
      api.bar.mockResolvedValue([loggedIn]);
      api.accountFlow.mockResolvedValue({
        agent_id: 'antigravity',
        action_id: 'login',
        status: 'succeeded',
        exit_code: 0,
        authentication: 'account',
      });
      return {
        agent_id: 'antigravity',
        action_id: 'login',
        launched: true,
      };
    });

    render(<AgentSettings />);
    expect(await screen.findByText('暂未登录')).toBeVisible();
    await user.click(await screen.findByRole('button', { name: '登录' }));
    await waitFor(() =>
      expect(api.runAction).toHaveBeenCalledWith('antigravity', 'login')
    );
    expect(successSpy).toHaveBeenCalledWith(
      '已启动官方登录，请在浏览器中完成。'
    );
  });

  it('refreshes Grok official-subscription login status after the terminal flow finishes', async () => {
    const user = userEvent.setup();
    const loggedOut = {
      agent_id: 'grok',
      display_name: 'Grok',
      description: 'Grok ACP',
      icon_light: null,
      icon_dark: null,
      icon_svg: null,
      source: 'built_in_profile',
      built_in: true,
      retired: false,
      enabled: true,
      position: 0,
      lifecycle: 'needs_auth',
      authentication: 'not_logged_in',
      runtime_version: '1.0.0',
      acp_version: '1.0.0',
      active_operation: null,
      rollback_available: false,
      settings_features: ['authentication_mode'],
    };
    const loggedIn = {
      ...loggedOut,
      lifecycle: 'ready',
      authentication: 'account',
    };
    api.bar.mockResolvedValue([loggedOut]);
    api.readConfig.mockResolvedValue({
      agent_id: 'grok',
      available: true,
      settings_features: ['authentication_mode'],
      path: null,
      paths: [],
      fields: [],
      files: [],
      applies_to_next_session: true,
    });
    api.authMode.mockResolvedValue({
      agent_id: 'grok',
      mode: 'subscription',
      credential_env: 'XAI_API_KEY',
      credential_present: false,
      modes: ['subscription', 'api_key', 'custom', 'model_provider'],
      options: [
        {
          value: 'subscription',
          kind: 'subscription',
          label_key: 'agents.authModeSubscription',
          description_key: 'agents.authDescGrokSubscription',
          credential_env: null,
          native_config_field_id: null,
          credential_required: false,
        },
        {
          value: 'api_key',
          kind: 'official_api',
          label_key: 'agents.authModeXaiKey',
          description_key: 'agents.authDescGrokKey',
          credential_env: 'XAI_API_KEY',
          native_config_field_id: 'grok_api_key',
          credential_required: true,
        },
        {
          value: 'custom',
          kind: 'provider',
          label_key: 'agents.authModeCustomEndpoint',
          description_key: 'agents.authDescGrokCustom',
          credential_env: null,
          native_config_field_id: null,
          credential_required: false,
        },
        {
          value: 'model_provider',
          kind: 'provider',
          label_key: 'agents.authModeProvider',
          description_key: 'agents.authDescGrokCustom',
          credential_env: null,
          native_config_field_id: null,
          credential_required: false,
        },
      ],
    });
    api.actions.mockResolvedValue({
      agent_id: 'grok',
      actions: [
        {
          id: 'login',
          label: '登录 Grok',
          description: '使用 SuperGrok 或 X Premium+ 账号登录。',
          label_key: 'agents.managementAction.grok.login.label',
          description_key: 'agents.managementAction.grok.login.description',
          kind: 'login',
          available: true,
          unavailable_reason: null,
          url: null,
        },
        {
          id: 'logout',
          label: '退出 Grok',
          description: '移除 Grok 本地账号会话。',
          label_key: 'agents.managementAction.grok.logout.label',
          description_key: 'agents.managementAction.grok.logout.description',
          kind: 'logout',
          available: false,
          unavailable_reason: '当前没有可退出的账号会话。',
          url: null,
        },
      ],
    });
    api.runAction.mockImplementation(async () => {
      api.bar.mockResolvedValue([loggedIn]);
      api.accountFlow.mockResolvedValue({
        agent_id: 'grok',
        action_id: 'login',
        status: 'succeeded',
        exit_code: 0,
        authentication: 'account',
      });
      api.actions.mockResolvedValue({
        agent_id: 'grok',
        actions: [
          {
            id: 'login',
            label: '登录 Grok',
            description: '使用 SuperGrok 或 X Premium+ 账号登录。',
            label_key: 'agents.managementAction.grok.login.label',
            description_key: 'agents.managementAction.grok.login.description',
            kind: 'login',
            available: false,
            unavailable_reason: null,
            url: null,
          },
          {
            id: 'logout',
            label: '退出 Grok',
            description: '移除 Grok 本地账号会话。',
            label_key: 'agents.managementAction.grok.logout.label',
            description_key: 'agents.managementAction.grok.logout.description',
            kind: 'logout',
            available: true,
            unavailable_reason: null,
            url: null,
          },
        ],
      });
      return {
        agent_id: 'grok',
        action_id: 'login',
        launched: true,
      };
    });

    render(<AgentSettings />);
    expect(await screen.findByText('暂未登录')).toBeVisible();
    expect(await screen.findByText('未登录官方账号')).toBeVisible();
    await user.click(await screen.findByRole('button', { name: '登录 Grok' }));
    await waitFor(() =>
      expect(api.runAction).toHaveBeenCalledWith('grok', 'login')
    );
    await waitFor(() => expect(api.accountFlow).toHaveBeenCalledWith('grok'));
    await waitFor(() =>
      expect(screen.getByText('已通过账号登录')).toBeVisible()
    );
    expect(screen.queryByText('未登录官方账号')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退出 Grok' })).toBeVisible();
    expect(api.preflight).toHaveBeenCalledWith('grok', 'authentication');
    expect(api.actions).toHaveBeenCalledWith('grok');
  });

  it('keeps refreshing Grok login status until the account session appears', async () => {
    const user = userEvent.setup();
    const loggedOut = {
      agent_id: 'grok',
      display_name: 'Grok',
      description: 'Grok ACP',
      icon_light: null,
      icon_dark: null,
      icon_svg: null,
      source: 'built_in_profile',
      built_in: true,
      retired: false,
      enabled: true,
      position: 0,
      lifecycle: 'needs_auth',
      authentication: 'not_logged_in',
      runtime_version: '1.0.0',
      acp_version: '1.0.0',
      active_operation: null,
      rollback_available: false,
      settings_features: ['authentication_mode'],
    };
    const loggedIn = {
      ...loggedOut,
      lifecycle: 'ready',
      authentication: 'account',
    };
    const session = { current: loggedOut };
    api.bar.mockImplementation(async () => [session.current]);
    api.readConfig.mockResolvedValue({
      agent_id: 'grok',
      available: true,
      settings_features: ['authentication_mode'],
      path: null,
      paths: [],
      fields: [],
      files: [],
      applies_to_next_session: true,
    });
    api.authMode.mockResolvedValue({
      agent_id: 'grok',
      mode: 'subscription',
      credential_env: 'XAI_API_KEY',
      credential_present: false,
      modes: ['subscription', 'api_key', 'custom'],
      options: [
        {
          value: 'subscription',
          kind: 'subscription',
          label_key: 'agents.authModeSubscription',
          description_key: 'agents.authDescGrokSubscription',
          credential_env: null,
          native_config_field_id: null,
          credential_required: false,
        },
      ],
    });
    api.actions.mockResolvedValue({
      agent_id: 'grok',
      actions: [
        {
          id: 'login',
          label: '登录 Grok',
          description: '使用 SuperGrok 或 X Premium+ 账号登录。',
          label_key: 'agents.managementAction.grok.login.label',
          description_key: 'agents.managementAction.grok.login.description',
          kind: 'login',
          available: true,
          unavailable_reason: null,
          url: null,
        },
      ],
    });
    api.runAction.mockImplementation(async () => {
      api.accountFlow.mockResolvedValue({
        agent_id: 'grok',
        action_id: 'login',
        status: 'succeeded',
        exit_code: 0,
        authentication: 'account',
      });
      return {
        agent_id: 'grok',
        action_id: 'login',
        launched: true,
      };
    });

    render(<AgentSettings />);
    expect(await screen.findByText('未登录官方账号')).toBeVisible();
    await user.click(await screen.findByRole('button', { name: '登录 Grok' }));
    await waitFor(() =>
      expect(api.preflight).toHaveBeenCalledWith('grok', 'authentication')
    );
    expect(screen.getByText('未登录官方账号')).toBeVisible();
    session.current = loggedIn;
    await waitFor(
      () => expect(screen.getByText('已通过账号登录')).toBeVisible(),
      { timeout: 4000 }
    );
    expect(screen.queryByText('未登录官方账号')).not.toBeInTheDocument();
  });

  it('refreshes login status and preflight after enabling a Model Provider', async () => {
    const user = userEvent.setup();
    const loggedOut = {
      agent_id: 'claude_code',
      display_name: 'Claude Code',
      description: 'Anthropic Claude Code (official native engine)',
      icon_light: null,
      icon_dark: null,
      icon_svg: null,
      source: 'built_in_profile',
      built_in: true,
      retired: false,
      enabled: true,
      position: 0,
      lifecycle: 'needs_auth',
      authentication: 'not_logged_in',
      runtime_version: '2.1.325',
      acp_version: '2.1.325',
      active_operation: null,
      rollback_available: false,
      settings_features: ['authentication_mode', 'reusable_model_providers'],
    };
    const loggedIn = {
      ...loggedOut,
      lifecycle: 'ready',
      authentication: 'api_key',
    };
    const authFail = {
      id: 'authentication',
      label: '鉴权',
      status: 'fail',
      detail: '当前鉴权模式 `official_subscription` 尚未就绪。',
      version: 'official_subscription',
      path: null,
      source: null,
      repairable: true,
      update_available: false,
      available_version: null,
      update_group: null,
    };
    const authPass = {
      ...authFail,
      status: 'pass',
      detail: '',
      version: 'model_provider',
    };
    const nativeRuntime = {
      id: 'native_runtime',
      label: '原生引擎运行时',
      status: 'pass',
      detail: '',
      version: '2.1.325',
      path: '/usr/local/bin/claude',
      source: null,
      repairable: false,
      update_available: false,
      available_version: null,
      update_group: null,
    };
    api.bar.mockResolvedValue([loggedOut]);
    api.readConfig.mockResolvedValue({
      agent_id: 'claude_code',
      available: true,
      settings_features: ['authentication_mode', 'reusable_model_providers'],
      path: null,
      paths: [],
      fields: [],
      files: [],
      applies_to_next_session: true,
    });
    api.authMode.mockResolvedValue({
      agent_id: 'claude_code',
      mode: 'official_subscription',
      credential_env: 'ANTHROPIC_API_KEY',
      credential_present: false,
      modes: ['official_subscription', 'official_api', 'model_provider'],
      options: [
        {
          value: 'official_subscription',
          kind: 'subscription',
          label_key: 'agents.authModeOfficialSubscription',
          description_key: 'agents.authDescClaudeSubscription',
          credential_env: null,
          native_config_field_id: null,
          credential_required: false,
        },
        {
          value: 'official_api',
          kind: 'official_api',
          label_key: 'agents.authModeOfficialApi',
          description_key: 'agents.authDescClaudeOfficialApi',
          credential_env: 'ANTHROPIC_API_KEY',
          native_config_field_id: 'anthropic_api_key',
          credential_required: true,
        },
        {
          value: 'model_provider',
          kind: 'provider',
          label_key: 'agents.authModeProvider',
          description_key: 'agents.authDescClaudeProvider',
          credential_env: null,
          native_config_field_id: null,
          credential_required: false,
        },
      ],
    });
    api.modelProviders.mockResolvedValue({
      agent_id: 'claude_code',
      providers: [
        {
          id: 'provider-1',
          name: 'Gateway',
          agent_id: 'claude_code',
          api_url: 'https://gateway.example/v1',
          model: 'gateway/sonnet',
          credential_present: true,
          bound: false,
          managed: true,
        },
      ],
      bound_provider_id: null,
    });
    api.preflight.mockImplementation(async (agentId: string) => ({
      agent_id: agentId,
      checked_at: '2026-09-08T00:00:00Z',
      items: [nativeRuntime, authFail],
    }));
    api.bindModelProvider.mockImplementation(async () => {
      api.bar.mockResolvedValue([loggedIn]);
      api.preflight.mockImplementation(
        async (agentId: string, scope?: string) => ({
          agent_id: agentId,
          checked_at: '2026-09-08T00:01:00Z',
          items:
            scope === 'authentication'
              ? [authPass]
              : [nativeRuntime, authPass],
        })
      );
      api.authMode.mockResolvedValue({
        agent_id: 'claude_code',
        mode: 'model_provider',
        credential_env: 'ANTHROPIC_API_KEY',
        credential_present: true,
        modes: ['official_subscription', 'official_api', 'model_provider'],
        options: [
          {
            value: 'official_subscription',
            kind: 'subscription',
            label_key: 'agents.authModeOfficialSubscription',
            description_key: 'agents.authDescClaudeSubscription',
            credential_env: null,
            native_config_field_id: null,
            credential_required: false,
          },
          {
            value: 'official_api',
            kind: 'official_api',
            label_key: 'agents.authModeOfficialApi',
            description_key: 'agents.authDescClaudeOfficialApi',
            credential_env: 'ANTHROPIC_API_KEY',
            native_config_field_id: 'anthropic_api_key',
            credential_required: true,
          },
          {
            value: 'model_provider',
            kind: 'provider',
            label_key: 'agents.authModeProvider',
            description_key: 'agents.authDescClaudeProvider',
            credential_env: null,
            native_config_field_id: null,
            credential_required: false,
          },
        ],
      });
      return {
        agent_id: 'claude_code',
        providers: [
          {
            id: 'provider-1',
            name: 'Gateway',
            agent_id: 'claude_code',
            api_url: 'https://gateway.example/v1',
            model: 'gateway/sonnet',
            credential_present: true,
            bound: true,
            managed: true,
          },
        ],
        bound_provider_id: 'provider-1',
      };
    });

    render(<AgentSettings />);
    expect(await screen.findByText('暂未登录')).toBeVisible();
    await waitFor(() =>
      expect(api.preflight).toHaveBeenCalledWith('claude_code')
    );
    expect(await screen.findByText('需处理')).toBeVisible();

    await pickAuthModeTab(user, '供应商');
    await user.click(await screen.findByRole('button', { name: '启用' }));
    await waitFor(() =>
      expect(api.bindModelProvider).toHaveBeenCalledWith(
        'claude_code',
        'provider-1'
      )
    );
    await waitFor(() =>
      expect(api.preflight).toHaveBeenCalledWith(
        'claude_code',
        'authentication'
      )
    );
    expect(await screen.findByText('已通过 API Key 登录')).toBeVisible();
    expect(screen.queryByText('暂未登录')).not.toBeInTheDocument();
    expect(screen.queryByText('需处理')).not.toBeInTheDocument();
  });

  it('refreshes actions and preflight after install/repair finishes so stale unavailable_reason disappears', async () => {
    const unavailableReason = '未找到 `omp`；请重新安装或修复此 Agent。';
    const uninstalledOmp = {
      agent_id: 'omp',
      display_name: 'Oh My Pi',
      description: 'Oh My Pi ACP',
      icon_light: '/agents/omp.svg',
      icon_dark: '/agents/omp-dark.svg',
      icon_svg: null,
      source: 'built_in_profile',
      built_in: true,
      retired: false,
      enabled: true,
      position: 0,
      lifecycle: 'needs_auth',
      authentication: 'not_logged_in',
      runtime_version: null,
      acp_version: null,
      active_operation: null,
      rollback_available: false,
      settings_features: ['authentication_mode', 'reusable_model_providers'],
    };
    const installedOmp = {
      ...uninstalledOmp,
      lifecycle: 'needs_auth',
      runtime_version: '13.17.1',
      acp_version: '13.17.1',
    };
    api.bar.mockResolvedValue([uninstalledOmp]);
    api.readConfig.mockResolvedValue({
      agent_id: 'omp',
      available: true,
      settings_features: ['authentication_mode', 'reusable_model_providers'],
      path: '/tmp/.omp/agent/config.yml',
      paths: ['/tmp/.omp/agent/config.yml'],
      fields: [],
      files: [],
      applies_to_next_session: true,
    });
    api.authMode.mockResolvedValue({
      agent_id: 'omp',
      mode: 'subscription',
      credential_env: 'ANTHROPIC_API_KEY',
      credential_present: false,
      modes: ['subscription', 'api_key', 'model_provider'],
      options: [
        {
          value: 'subscription',
          kind: 'subscription',
          label_key: 'agents.authModeSubscription',
          description_key: 'agents.authDescOmpSubscription',
          credential_env: null,
          native_config_field_id: null,
          credential_required: false,
        },
      ],
    });
    api.preflight.mockResolvedValue({
      agent_id: 'omp',
      checked_at: '2026-11-05T00:00:00Z',
      items: [
        {
          id: 'acp',
          label: 'ACP 适配器',
          status: 'fail',
          detail: '未检测到 Oh My Pi',
          version: null,
          path: null,
          source: null,
          repairable: true,
          update_available: false,
          available_version: null,
          update_group: null,
        },
      ],
    });
    api.actions.mockResolvedValue({
      agent_id: 'omp',
      actions: [
        {
          id: 'login',
          label: '登录 Oh My Pi',
          description: '在本地终端中运行 `omp /login` 完成订阅账号授权。',
          label_key: 'agents.managementAction.omp.login.label',
          description_key: 'agents.managementAction.omp.login.description',
          kind: 'login',
          available: false,
          unavailable_reason: unavailableReason,
          url: null,
        },
      ],
    });

    render(<AgentSettings />);
    await screen.findByRole('button', { name: 'Oh My Pi' });
    await waitFor(() =>
      expect(listeners.has('agent-management-event')).toBe(true)
    );
    expect(await screen.findByText(unavailableReason)).toBeVisible();

    api.preflight.mockClear();
    api.actions.mockClear();
    api.diagnostics.mockClear();
    api.bar.mockResolvedValue([installedOmp]);
    api.preflight.mockResolvedValue({
      agent_id: 'omp',
      checked_at: '2026-11-05T00:01:00Z',
      items: [
        {
          id: 'acp',
          label: 'ACP 适配器',
          status: 'pass',
          detail: '',
          version: '13.17.1',
          path: '/Users/example/.vibex/agents/omp/current/node_modules/.bin/omp',
          source: 'managed',
          repairable: false,
          update_available: false,
          available_version: null,
          update_group: null,
        },
      ],
    });
    api.actions.mockResolvedValue({
      agent_id: 'omp',
      actions: [
        {
          id: 'login',
          label: '登录 Oh My Pi',
          description: '在本地终端中运行 `omp /login` 完成订阅账号授权。',
          label_key: 'agents.managementAction.omp.login.label',
          description_key: 'agents.managementAction.omp.login.description',
          kind: 'login',
          available: true,
          unavailable_reason: null,
          url: null,
        },
      ],
    });

    await act(async () => {
      listeners.get('agent-management-event')?.({
        sequence: 1,
        agent_id: 'omp',
        operation_id: 'install-omp-1',
        kind: 'install',
        status: 'running',
        progress_percent: 45,
        message: '正在安装 Oh My Pi ACP',
      });
    });
    await act(async () => {
      listeners.get('agent-management-event')?.({
        sequence: 2,
        agent_id: 'omp',
        operation_id: 'install-omp-1',
        kind: 'install',
        status: 'succeeded',
        progress_percent: 100,
        message: '安装与 ACP 验证完成',
      });
    });

    await waitFor(() => expect(api.actions).toHaveBeenCalledWith('omp'));
    await waitFor(() => expect(api.preflight).toHaveBeenCalledWith('omp'));
    expect(api.diagnostics).toHaveBeenCalledWith('omp');
    await waitFor(() =>
      expect(screen.queryByText(unavailableReason)).not.toBeInTheDocument()
    );
    expect(screen.getByRole('button', { name: '登录 OMP' })).not.toBeDisabled();
  });

  it('recovers from transient accountFlow polling errors and clears running state on persistent failure', async () => {
    const errorSpy = vi.spyOn(toast, 'error');
    api.actions.mockResolvedValue({
      agent_id: 'codex',
      actions: [
        {
          id: 'login',
          label: '登录 Codex',
          description: '登录',
          label_key: 'agents.managementAction.codex.login.label',
          description_key: 'agents.managementAction.codex.login.description',
          kind: 'login',
          available: true,
          unavailable_reason: null,
          url: null,
        },
      ],
    });
    api.accountFlow
      .mockResolvedValueOnce({
        agent_id: 'codex',
        action_id: 'login',
        status: 'pending',
        exit_code: null,
        authentication: null,
      })
      .mockRejectedValue(new Error('poll network error'));

    render(<AgentSettings />);
    await screen.findByRole('button', { name: 'Codex' });

    await waitFor(
      () => expect(errorSpy).toHaveBeenCalledWith('poll network error'),
      { timeout: 5000 }
    );
  });
});
