import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toast } from '@/components/ui/toast';
import { AGENT_SETTINGS_FOCUS_KEY } from '@/features/agent-management/agentSettingsFocus';
import { clearLocalStorageCache } from '@/lib/safeStorage';
import { renderWithQueryClient as render } from '@/test/QueryClientHarness';

import { AGENT_MODEL_MARKET_INTRO_KEY } from './AgentModelMarketIntroDialog';
import { AgentSettings } from './AgentSettings';
import {
  configField,
  resetAgentSettingsHarness,
} from './agentSettingsTestHarness';
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

describe('AgentSettings', () => {
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

  it('shows the Agent page skeleton while the management bar is loading', () => {
    api.bar.mockReturnValue(new Promise(() => undefined));

    render(<AgentSettings />);

    const status = screen.getByRole('status', {
      name: /正在读取 Agent|Loading Agent/,
    });
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(
      status.querySelectorAll('.agent-settings-loading-mark')
    ).toHaveLength(6);
    expect(
      status.querySelectorAll('.agent-settings-loading-rows li')
    ).toHaveLength(5);
    expect(
      screen.queryByRole('button', { name: 'Codex' })
    ).not.toBeInTheDocument();
  });

  it('makes the first Agent icon the default Agent after reorder', async () => {
    api.bar.mockResolvedValue([
      {
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
        lifecycle: 'ready',
        authentication: 'account',
        runtime_version: '2.1.325',
        acp_version: '2.1.325',
        active_operation: null,
        rollback_available: false,
        settings_features: [],
      },
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
        position: 1,
        lifecycle: 'ready',
        authentication: 'account',
        runtime_version: '0.169.0',
        acp_version: '0.169.0',
        active_operation: null,
        rollback_available: false,
        settings_features: ['authentication_mode'],
      },
    ]);
    userSystem.config = {
      executor_profile: { executor: 'claude_code', variant: null },
    };
    api.reorder.mockResolvedValue([]);

    render(<AgentSettings />);
    const claudeButton = await screen.findByRole('button', {
      name: 'Claude Code',
    });
    expect(claudeButton).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Codex' }), {
      key: 'ArrowLeft',
      altKey: true,
    });

    await waitFor(() => {
      expect(api.reorder).toHaveBeenCalledWith(['codex', 'claude_code']);
      expect(userSystem.updateAndSaveConfig).toHaveBeenCalledWith({
        executor_profile: { executor: 'codex', variant: null },
      });
    });
  });

  it('does not blank a cached Agent config when switching back', async () => {
    const agents = [
      {
        agent_id: 'codex',
        display_name: 'Codex',
        description: 'OpenAI Codex (official native app-server engine)',
        icon_light: null,
        icon_dark: null,
        icon_svg: null,
        source: 'built_in_profile' as const,
        built_in: true,
        retired: false,
        enabled: true,
        position: 0,
        lifecycle: 'ready' as const,
        authentication: 'account' as const,
        runtime_version: '0.169.0',
        acp_version: '0.169.0',
        active_operation: null,
        rollback_available: false,
        settings_features: ['authentication_mode'],
      },
      {
        agent_id: 'claude_code',
        display_name: 'Claude Code',
        description: 'Anthropic Claude Code (official native engine)',
        icon_light: null,
        icon_dark: null,
        icon_svg: null,
        source: 'built_in_profile' as const,
        built_in: true,
        retired: false,
        enabled: true,
        position: 1,
        lifecycle: 'ready' as const,
        authentication: 'account' as const,
        runtime_version: '2.1.325',
        acp_version: '2.1.325',
        active_operation: null,
        rollback_available: false,
        settings_features: ['authentication_mode'],
      },
    ];
    api.bar.mockResolvedValue(agents);
    api.readConfig.mockImplementation(async (agentId: string) => ({
      agent_id: agentId,
      available: false,
      settings_features: ['authentication_mode'],
      path: null,
      paths: [],
      fields: [],
      files: [],
      applies_to_next_session: true,
    }));
    api.preflight.mockImplementation(async (agentId: string) => ({
      agent_id: agentId,
      checked_at: '2026-08-21T00:00:00Z',
      items: [],
    }));

    confirmShow.mockResolvedValue('confirmed');
    render(<AgentSettings />);
    await screen.findByRole('button', { name: 'Codex' });
    await userEvent.click(screen.getByRole('button', { name: 'Codex' }));
    await waitFor(() => expect(api.readConfig).toHaveBeenCalledWith('codex'));
    await userEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    await waitFor(() =>
      expect(api.readConfig).toHaveBeenCalledWith('claude_code')
    );

    api.readConfig.mockImplementation(
      (agentId: string) =>
        new Promise(() => {
          void agentId;
        })
    );
    await userEvent.click(screen.getByRole('button', { name: 'Codex' }));

    expect(await screen.findByRole('heading', { name: 'Codex' })).toBeVisible();
    expect(screen.queryByText('正在读取配置…')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Loading configuration…')
    ).not.toBeInTheDocument();
  });

  it('shows Codex auth management before native config finishes', async () => {
    api.readConfig.mockReturnValue(new Promise(() => undefined));

    render(<AgentSettings />);

    expect(
      await screen.findByRole('region', { name: '鉴权管理' })
    ).toBeVisible();
  });

  it('shows greyed authentication, configuration, and environment when an Agent is uninstalled', async () => {
    api.bar.mockResolvedValue([
      {
        agent_id: 'antigravity',
        display_name: 'Google Antigravity',
        description: "Google's AI coding agent",
        icon_light: null,
        icon_dark: null,
        icon_svg: null,
        source: 'built_in_profile',
        built_in: true,
        retired: false,
        enabled: true,
        position: 0,
        lifecycle: 'uninstalled',
        authentication: 'none',
        runtime_version: null,
        acp_version: null,
        active_operation: null,
        rollback_available: false,
        settings_features: ['authentication_mode', 'reusable_model_providers'],
      },
    ]);
    api.readConfig.mockResolvedValue({
      agent_id: 'antigravity',
      available: true,
      settings_features: ['authentication_mode', 'reusable_model_providers'],
      path: null,
      paths: [],
      fields: [],
      files: [],
      applies_to_next_session: true,
    });
    api.authMode.mockResolvedValue({
      agent_id: 'antigravity',
      mode: 'subscription',
      modes: ['subscription'],
      options: [],
      credential_env: null,
      credential_present: false,
    });

    const warn = vi.spyOn(toast, 'warning');
    const user = userEvent.setup();
    render(<AgentSettings />);

    expect(
      await screen.findByRole('button', { name: 'Google Antigravity' })
    ).toBeVisible();
    expect(screen.getByRole('region', { name: '鉴权管理' })).toBeVisible();
    expect(screen.getByRole('region', { name: '配置管理' })).toBeVisible();
    expect(screen.getByRole('region', { name: '环境变量' })).toBeVisible();
    expect(document.querySelector('.agent-settings-locked')).not.toBeNull();
    await user.click(screen.getByRole('region', { name: '鉴权管理' }));
    expect(warn).toHaveBeenCalledWith('请先安装Agent');
    warn.mockRestore();
  });

  it('renders the management projection as the only Agent settings source', async () => {
    render(<AgentSettings />);
    expect(await screen.findByRole('button', { name: 'Codex' })).toBeVisible();
    await waitFor(() => expect(api.readConfig).toHaveBeenCalledWith('codex'));
    expect(screen.getByText('已通过账号登录')).toBeInTheDocument();
    expect(
      await screen.findByRole('region', { name: '鉴权管理' })
    ).toBeVisible();
    expect(screen.queryByText('Agent Skills')).not.toBeInTheDocument();
  });

  it('keeps runtime configuration visible for every Codex auth mode', async () => {
    api.readConfig.mockResolvedValue({
      agent_id: 'codex',
      available: true,
      settings_features: ['authentication_mode'],
      path: '/Users/example/.codex/config.toml',
      paths: [
        '/Users/example/.codex/auth.json',
        '/Users/example/.codex/config.toml',
      ],
      files: [],
      applies_to_next_session: true,
      fields: [
        configField({
          id: 'openai_api_key',
          label: 'OpenAI API Key',
          kind: 'secret',
          secret: true,
          path: '/Users/example/.codex/auth.json',
          surface: 'authentication',
        }),
        configField({
          id: 'codex_reasoning_effort',
          label: '推理强度',
          kind: 'select',
          options: [
            { value: 'medium', label: '中' },
            { value: 'high', label: '高' },
          ],
          value: 'medium',
          path: '/Users/example/.codex/config.toml',
          surface: 'configuration',
        }),
      ],
    });
    const user = userEvent.setup();

    render(<AgentSettings />);

    const auth = await screen.findByRole('region', { name: '鉴权管理' });
    const configuration = await screen.findByRole('region', {
      name: '配置管理',
    });
    const environment = await screen.findByRole('region', {
      name: '环境变量',
    });
    expect(auth).toBeVisible();
    expect(configuration).toBeVisible();
    expect(
      auth.compareDocumentPosition(configuration) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      configuration.compareDocumentPosition(environment) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.getByLabelText('推理强度')).toBeVisible();
    expect(
      screen.queryByLabelText('OpenAI API Key', { selector: 'input' })
    ).not.toBeVisible();

    await waitFor(() => expect(api.preflight).toHaveBeenCalledWith('codex'));
    const callsAfterLoad = api.preflight.mock.calls.length;

    api.setAuthMode.mockResolvedValue({
      agent_id: 'codex',
      mode: 'api_key',
      credential_env: 'OPENAI_API_KEY',
      credential_present: true,
      modes: ['chatgpt_subscription', 'api_key', 'model_provider'],
      options: (await api.authMode()).options,
    });

    await pickAuthModeTab(user, '官方 API');

    await waitFor(() =>
      expect(api.preflight).toHaveBeenCalledWith('codex', 'authentication')
    );
    expect(
      api.preflight.mock.calls.filter((call) => call.length === 1)
    ).toHaveLength(callsAfterLoad);
    expect(screen.getByLabelText('推理强度')).toBeVisible();
    expect(
      screen.getByLabelText('OpenAI API Key', { selector: 'input' })
    ).toBeVisible();
  });

  it('places DeepSeek Harness auth above the rest of the agent settings', async () => {
    api.bar.mockResolvedValue([
      {
        agent_id: 'deepseek_harness',
        display_name: 'DeepSeek Harness',
        description: 'DeepSeek Harness ACP',
        icon_light: null,
        icon_dark: null,
        icon_svg: null,
        source: 'built_in_profile',
        built_in: true,
        retired: false,
        enabled: true,
        position: 0,
        lifecycle: 'ready',
        authentication: 'api_key',
        runtime_version: '1.0.0',
        acp_version: '1.0.0',
        active_operation: null,
        rollback_available: false,
      },
    ]);
    api.readConfig.mockResolvedValue({
      agent_id: 'deepseek_harness',
      available: false,
      settings_features: ['authentication_mode', 'dsh_plugins'],
      path: null,
      paths: [],
      fields: [],
      files: [],
      applies_to_next_session: true,
    });
    api.authMode.mockResolvedValue({
      agent_id: 'deepseek_harness',
      mode: 'deepseek',
      modes: ['deepseek', 'custom'],
      options: [],
      credential_env: 'DEEPSEEK_API_KEY',
      credential_present: true,
    });
    api.environment.mockResolvedValue({
      agent_id: 'deepseek_harness',
      revision: '0',
      entries: [],
    });

    const user = userEvent.setup();
    render(<AgentSettings />);

    const auth = await screen.findByRole('region', { name: '鉴权管理' });
    const session = await screen.findByRole('region', { name: '配置管理' });
    const preflight = screen.getByRole('region', { name: '预检查' });
    expect(auth).toBeVisible();
    expect(
      auth.compareDocumentPosition(preflight) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      preflight.compareDocumentPosition(session) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    const environment = screen.getByRole('region', { name: '环境变量' });
    expect(
      session.compareDocumentPosition(environment) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    const pluginsRegion = screen.getByRole('region', { name: '插件' });
    for (const section of [preflight, session, environment, pluginsRegion]) {
      expect(
        section.querySelector('.agent-section-heading-toggle')
      ).not.toBeInTheDocument();
      expect(
        section.querySelector('.agent-section-heading-actions button')
      ).toBeInTheDocument();
    }

    const plugins = screen.getByRole('button', { name: '插件' });
    expect(plugins).toHaveAttribute('aria-expanded', 'false');
    await user.click(plugins);
    expect(
      await screen.findByRole('button', { name: 'dsh-hello-plugin' })
    ).toBeVisible();
  });

  it('places Grok plugins in a collapsed section below configuration', async () => {
    api.bar.mockResolvedValue([
      {
        agent_id: 'grok',
        display_name: 'Grok',
        description: 'Grok Build',
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
      },
    ]);
    api.readConfig.mockResolvedValue({
      agent_id: 'grok',
      available: false,
      settings_features: ['authentication_mode', 'grok_plugins'],
      path: null,
      paths: [],
      fields: [],
      files: [],
      applies_to_next_session: true,
    });
    api.authMode.mockResolvedValue({
      agent_id: 'grok',
      mode: 'subscription',
      modes: ['subscription', 'api_key', 'custom'],
      options: [],
      credential_env: 'XAI_API_KEY',
      credential_present: false,
    });
    const user = userEvent.setup();
    render(<AgentSettings />);
    const plugins = await screen.findByRole('button', { name: '插件' });
    await user.click(plugins);
    expect(
      await screen.findByRole('button', { name: 'ponytail' })
    ).toBeVisible();
  });

  it('places Pi plugins in a collapsed section and Provider form in authentication', async () => {
    api.bar.mockResolvedValue([
      {
        agent_id: 'pi',
        display_name: 'Pi',
        description: 'Pi coding agent',
        icon_light: null,
        icon_dark: null,
        icon_svg: null,
        source: 'built_in_profile',
        built_in: true,
        retired: false,
        enabled: true,
        position: 0,
        lifecycle: 'ready',
        authentication: 'api_key',
        runtime_version: null,
        acp_version: '0.0.33',
        active_operation: null,
        rollback_available: false,
        settings_features: [
          'authentication_mode',
          'reusable_model_providers',
          'pi_configuration',
          'pi_plugins',
        ],
      },
    ]);
    api.readConfig.mockResolvedValue({
      agent_id: 'pi',
      available: true,
      settings_features: [
        'authentication_mode',
        'reusable_model_providers',
        'pi_configuration',
        'pi_plugins',
      ],
      path: '/tmp/.pi/agent/settings.json',
      paths: ['/tmp/.pi/agent/settings.json'],
      fields: [
        {
          id: 'pi_custom_providers',
          label: '自定义 Provider',
          description: 'Pi models.json 的 providers 对象',
          kind: 'json',
          options: [],
          secret: false,
          path: '/tmp/.pi/agent/models.json',
          present: true,
          value: '{}',
          masked_value: null,
          revision: 'rev',
          surface: 'configuration',
        },
        {
          id: 'pi_theme',
          label: '终端主题',
          description: 'Pi 内置终端主题',
          kind: 'select',
          options: [
            { value: 'dark', label: '深色' },
            { value: 'light', label: '浅色' },
          ],
          secret: false,
          path: '/tmp/.pi/agent/settings.json',
          present: true,
          value: 'dark',
          masked_value: null,
          revision: 'rev',
          surface: 'configuration',
        },
      ],
      files: [],
      applies_to_next_session: true,
    });
    api.modelProviders.mockResolvedValue({
      agent_id: 'pi',
      providers: [],
      bound_provider_id: null,
    });
    api.authMode.mockResolvedValue({
      agent_id: 'pi',
      mode: 'model_provider',
      modes: ['model_provider'],
      options: [
        {
          value: 'model_provider',
          kind: 'provider',
          label_key: 'agents.authModeProvider',
          description_key: 'agents.authDescPiProvider',
          credential_env: null,
          credential_required: false,
          native_config_field_id: null,
          official_api_url: null,
        },
      ],
      credential_env: 'PI_API_KEY',
      credential_present: true,
    });
    const user = userEvent.setup();
    render(<AgentSettings />);

    const auth = await screen.findByRole('region', { name: '鉴权管理' });
    const providerHeading = await screen.findByRole('heading', {
      name: '模型供应商',
    });
    expect(providerHeading).toBeVisible();
    expect(await screen.findByText('暂未识别到供应商')).toBeVisible();
    expect(
      (await screen.findAllByRole('button', { name: '新建供应商' }))[0]
    ).toBeVisible();
    expect(screen.getByRole('button', { name: '从外部导入' })).toBeVisible();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(auth).toContainElement(providerHeading);

    const configuration = screen.getByRole('region', { name: '配置管理' });
    expect(configuration).toHaveTextContent('Pi Runtime');
    expect(configuration).toHaveTextContent('项目信任');
    expect(configuration).not.toHaveTextContent('Provider 与模型');
    expect(configuration).not.toHaveTextContent('保存 Provider');
    expect(configuration).not.toHaveTextContent('自定义 Provider');
    expect(
      screen.queryByRole('button', { name: '添加 Provider' })
    ).not.toBeInTheDocument();

    const plugins = screen.getByRole('button', { name: '插件' });
    expect(plugins).toHaveAttribute('aria-expanded', 'false');
    await user.click(plugins);
    expect(
      await screen.findByRole('button', { name: 'pi-package-manager' })
    ).toBeVisible();
  });

  it('places Codex native plugins in a collapsed section below configuration', async () => {
    const user = userEvent.setup();
    render(<AgentSettings />);

    const configuration = await screen.findByRole('region', {
      name: '配置管理',
    });
    const plugins = screen.getByRole('button', { name: '插件' });
    expect(plugins).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByRole('region', { name: 'codex native plugins' })
    ).not.toBeInTheDocument();
    expect(
      configuration.compareDocumentPosition(plugins) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    await user.click(plugins);

    expect(plugins).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByRole('region', { name: 'codex native plugins' })
    ).toBeVisible();
    expect(configuration).toBeVisible();
  });

  it('binds the Claude Code collapsed plugin section to its ecosystem', async () => {
    const user = userEvent.setup();
    api.bar.mockResolvedValue([
      {
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
        lifecycle: 'ready',
        authentication: 'account',
        runtime_version: '2.1.325',
        acp_version: '2.1.325',
        active_operation: null,
        rollback_available: false,
      },
    ]);
    api.readConfig.mockResolvedValue({
      agent_id: 'claude_code',
      available: false,
      settings_features: [],
      path: null,
      paths: [],
      fields: [],
      files: [],
      applies_to_next_session: true,
    });
    api.actions.mockResolvedValue({ agent_id: 'claude_code', actions: [] });

    render(<AgentSettings />);
    const plugins = await screen.findByRole('button', { name: '插件' });
    expect(plugins).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByRole('region', { name: 'claude_code native plugins' })
    ).not.toBeInTheDocument();

    await user.click(plugins);

    expect(plugins).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByRole('region', { name: 'claude_code native plugins' })
    ).toBeVisible();
  });

  it('opens the disable modal when turning off the enable switch and supports disable-only, uninstall, and uninstall-and-clear-data', async () => {
    const user = userEvent.setup();
    api.uninstall.mockResolvedValue({
      agent_id: 'codex',
      display_name: 'Codex',
      description: 'OpenAI Codex (official native app-server engine)',
      icon_light: null,
      icon_dark: null,
      icon_svg: null,
      source: 'built_in_profile',
      built_in: true,
      retired: false,
      enabled: false,
      position: 0,
      lifecycle: 'uninstalled',
      authentication: 'account',
      runtime_version: null,
      acp_version: null,
      active_operation: null,
      rollback_available: false,
    });
    render(<AgentSettings />);
    const enableSwitch = await screen.findByRole('switch', {
      name: '启用 Agent',
    });
    expect(
      screen.queryByRole('button', { name: '检查更新' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '卸载' })
    ).not.toBeInTheDocument();

    await user.click(enableSwitch);
    expect(
      screen.getByText(
        '关闭启用该 Agent 后，将无法使用该 Agent 创建会话。您可以选择是否卸载或清除该 Agent 的数据；卸载时仅移除 Dimo 托管的运行时副本，不会影响您自行安装的本地 CLI 与登录态。'
      )
    ).toBeVisible();
    expect(screen.getByRole('button', { name: '仅关闭' })).toBeVisible();
    expect(screen.getByRole('button', { name: '卸载' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: '卸载并清除数据' })
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(api.setEnabled).not.toHaveBeenCalled();
    expect(api.uninstall).not.toHaveBeenCalled();

    await user.click(enableSwitch);
    await user.click(screen.getByRole('button', { name: '卸载' }));
    await waitFor(() =>
      expect(api.uninstall).toHaveBeenCalledWith('codex', { clearData: false })
    );

    api.uninstall.mockClear();
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
        runtime_version: '0.169.0',
        acp_version: '0.169.0',
        active_operation: null,
        rollback_available: false,
      },
    ]);
    await user.click(screen.getByRole('button', { name: '立即检查' }));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: '启用 Agent' })).toBeChecked()
    );
    await user.click(screen.getByRole('switch', { name: '启用 Agent' }));
    await user.click(screen.getByRole('button', { name: '卸载并清除数据' }));
    await waitFor(() =>
      expect(api.uninstall).toHaveBeenCalledWith('codex', { clearData: true })
    );
  });

  it('shows complete launch evidence for a manually registered Agent', async () => {
    const user = userEvent.setup();
    api.bar.mockResolvedValue([
      {
        agent_id: 'local-reviewer',
        display_name: 'Local Reviewer',
        description: 'Reviews the workspace',
        icon_light: null,
        icon_dark: null,
        icon_svg: null,
        source: 'user_definition',
        built_in: false,
        retired: false,
        enabled: true,
        position: 0,
        lifecycle: 'ready',
        authentication: 'not_required',
        runtime_version: '1.2.3',
        acp_version: '1.2.3',
        active_operation: null,
        rollback_available: false,
      },
    ]);
    api.readConfig.mockResolvedValue({
      agent_id: 'local-reviewer',
      available: false,
      settings_features: [],
      path: null,
      paths: [],
      fields: [],
      files: [],
      applies_to_next_session: true,
    });
    api.userDefinition.mockResolvedValue({
      agent_id: 'local-reviewer',
      display_name: 'Local Reviewer',
      description: 'Reviews the workspace',
      version: '1.2.3',
      distribution_json: '{}',
      distribution: {
        kind: 'npx',
        platform: 'darwin-aarch64',
        platform_supported: true,
        package: 'local-reviewer@1.2.3',
        archive_url: null,
        command: 'npx',
        args: ['--acp'],
        environment: [{ name: 'ACP_MODE', value: 'review' }],
        sha256: null,
        integrity: 'ecosystem_lock',
      },
      definition_sha256: 'a'.repeat(64),
      installed_definition_sha256: 'a'.repeat(64),
      reinstall_required: false,
      created_at: '2026-08-05T00:00:00Z',
      updated_at: '2026-08-05T00:00:00Z',
    });

    render(<AgentSettings />);

    expect(await screen.findByText('手动 Agent 定义')).toBeVisible();
    expect(screen.getByText('local-reviewer@1.2.3')).toBeVisible();
    expect(screen.getByText('生态锁文件')).toBeVisible();
    expect(screen.getByText('ACP_MODE=••••••')).toBeVisible();
    expect(screen.getByText('定义已同步')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '编辑定义' }));
    expect(screen.getByRole('textbox', { name: /^Agent ID/ })).toBeDisabled();
  });

  it('hides read diagnostics and clears the list on mark-all-read', async () => {
    const user = userEvent.setup();
    api.diagnostics.mockResolvedValue([
      {
        id: 'd1',
        agent_id: 'codex',
        operation_kind: 'launch_gate',
        severity: 'error',
        message: '启动前完整性验证失败',
        redacted_output: null,
        created_at: '2026-08-05T16:47:30Z',
        read: false,
      },
      {
        id: 'd2',
        agent_id: 'codex',
        operation_kind: 'install',
        severity: 'info',
        message: '已读记录不显示',
        redacted_output: null,
        created_at: '2026-08-05T13:00:00Z',
        read: true,
      },
    ]);
    render(<AgentSettings />);
    await screen.findByRole('button', { name: 'Codex' });

    await waitFor(() =>
      expect(screen.getByText('启动前完整性验证失败')).toBeInTheDocument()
    );
    expect(screen.queryByText('已读记录不显示')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '全部已读' }));
    await waitFor(() =>
      expect(api.markDiagnosticsRead).toHaveBeenCalledWith('codex')
    );
    await waitFor(() =>
      expect(screen.queryByText('启动前完整性验证失败')).not.toBeInTheDocument()
    );
  });

  it('selects the Agent requested from a session-creation diagnostic jump', async () => {
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
        runtime_version: '0.169.0',
        acp_version: '0.169.0',
        active_operation: null,
        rollback_available: false,
        settings_features: ['authentication_mode'],
      },
      {
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
        position: 1,
        lifecycle: 'needs_repair',
        authentication: 'not_logged_in',
        runtime_version: null,
        acp_version: null,
        active_operation: null,
        rollback_available: false,
        settings_features: [],
      },
    ]);
    api.diagnostics.mockResolvedValue([
      {
        id: 'd1',
        agent_id: 'claude_code',
        operation_kind: 'install',
        severity: 'error',
        message: 'Agent 安装或验证失败',
        redacted_output: 'npm error code ECONNREFUSED',
        created_at: '2026-09-02T03:11:46Z',
        read: false,
      },
    ]);
    localStorage.setItem(
      AGENT_SETTINGS_FOCUS_KEY,
      JSON.stringify({ agentId: 'claude_code', focusDiagnostics: true })
    );

    render(<AgentSettings />);

    expect(
      await screen.findByText('Anthropic Claude Code (official native engine)')
    ).toBeVisible();
    await waitFor(() =>
      expect(api.diagnostics).toHaveBeenCalledWith('claude_code')
    );
    expect(screen.getByText('npm error code ECONNREFUSED')).toBeVisible();
  });

  it('guards settings sidebar navigation when agent configuration has unsaved changes', async () => {
    const user = userEvent.setup();
    api.readConfig.mockResolvedValue({
      agent_id: 'codex',
      available: true,
      settings_features: ['authentication_mode'],
      path: '/Users/example/.codex/config.toml',
      paths: ['/Users/example/.codex/config.toml'],
      files: [],
      applies_to_next_session: true,
      fields: [
        configField({
          id: 'codex_model',
          label: '默认模型',
          kind: 'text',
          value: 'gpt-5',
          path: '/Users/example/.codex/config.toml',
          surface: 'configuration',
        }),
      ],
    });

    render(
      <div className="settings-page">
        <aside className="settings-sidebar">
          <a href="/settings/general">常规</a>
        </aside>
        <AgentSettings />
      </div>
    );

    api.writeConfig.mockResolvedValue({
      agent_id: 'codex',
      available: true,
      settings_features: ['authentication_mode'],
      path: '/Users/example/.codex/config.toml',
      paths: ['/Users/example/.codex/config.toml'],
      files: [],
      applies_to_next_session: true,
      fields: [
        configField({
          id: 'codex_model',
          label: '默认模型',
          kind: 'text',
          value: 'gpt-5-mini',
          path: '/Users/example/.codex/config.toml',
          surface: 'configuration',
        }),
      ],
    });
    const input = await screen.findByLabelText('默认模型');
    await user.type(input, '-mini');
    await user.click(screen.getByRole('link', { name: '常规' }));

    await waitFor(() =>
      expect(api.writeConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'codex',
          fields: { codex_model: 'gpt-5-mini' },
        })
      )
    );
    expect(confirmShow).not.toHaveBeenCalled();
  });

  it('redeems a ModelRouter import ticket, saves the provider without binding, and binds only when the toast Enable action is clicked', async () => {
    const toastSuccessSpy = vi.spyOn(toast, 'success');
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
        authentication: 'none',
        runtime_version: '0.169.0',
        acp_version: '0.169.0',
        active_operation: null,
        rollback_available: false,
        settings_features: ['authentication_mode', 'reusable_model_providers'],
      },
    ]);
    api.authMode.mockResolvedValue({
      agent_id: 'codex',
      mode: 'subscription',
      options: [
        {
          value: 'subscription',
          label: 'Subscription',
          kind: 'subscription',
          credential_required: false,
          credential_env: null,
          credential_present: false,
          native_config_field_id: null,
        },
        {
          value: 'model_provider',
          label: 'Model Provider',
          kind: 'provider',
          credential_required: false,
          credential_env: null,
          credential_present: false,
          native_config_field_id: null,
        },
      ],
      headless_account_env: null,
    });
    api.modelProviders.mockResolvedValue({
      agent_id: 'codex',
      bound_provider_id: null,
      providers: [],
    });
    api.saveModelProvider.mockResolvedValue({
      agent_id: 'codex',
      bound_provider_id: null,
      providers: [
        {
          id: 'prov-router-1',
          name: 'Dimo ModelRouter',
          agent_id: 'codex',
          api_url: 'https://site.test/api/router/v1',
          api_key_masked: 'vxr-••••',
          has_api_key: true,
          model: 'gpt-5',
          created_at: '2026-11-11T00:00:00Z',
          updated_at: '2026-11-11T00:00:00Z',
        },
      ],
    });
    api.bindModelProvider.mockResolvedValue({
      agent_id: 'codex',
      bound_provider_id: 'prov-router-1',
      providers: [],
    });
    redeemImportTicketMock.mockResolvedValue({
      apiKey: 'vxr-secret',
      agentId: 'codex',
      protocol: 'openai',
      baseUrl: 'https://site.test/api/router/v1',
      model: { id: 'gpt-5', name: 'GPT-5' },
      models: [{ id: 'gpt-5', name: 'GPT-5' }],
    });

    render(<AgentSettings />);
    await screen.findAllByText('Codex');

    const listener = tauriListeners.get('dimo://modelrouter-import');
    expect(listener).toBeDefined();

    await act(async () => {
      listener?.({ ticket: 'tkt_import_1', agentId: 'codex' });
    });

    await waitFor(() =>
      expect(redeemImportTicketMock).toHaveBeenCalledWith('tkt_import_1')
    );
    await waitFor(() =>
      expect(api.saveModelProvider).toHaveBeenCalledWith({
        id: null,
        name: 'Dimo ModelRouter',
        agent_id: 'codex',
        api_url: 'https://site.test/api/router/v1',
        api_key: 'vxr-secret',
        model: 'gpt-5',
      })
    );
    expect(api.bindModelProvider).not.toHaveBeenCalled();

    const confirmCall = toastSuccessSpy.mock.calls.find(
      (call) => call[0] === '模型导入成功，是否立即启用？'
    );
    expect(confirmCall).toBeDefined();
    const toastOptions = confirmCall?.[1] as {
      duration?: number;
      cancel?: { label: string; onClick: () => void };
      action?: { label: string; onClick: () => void };
    };
    expect(toastOptions.duration).toBe(15000);
    expect(toastOptions.cancel?.label).toBe('取消');
    expect(toastOptions.action?.label).toBe('启用');

    await act(async () => {
      toastOptions.action?.onClick();
    });

    await waitFor(() =>
      expect(api.bindModelProvider).toHaveBeenCalledWith(
        'codex',
        'prov-router-1'
      )
    );
  });

  it('pops up the Model Market intro card once on first visit to Agent Settings', async () => {
    localStorage.removeItem(AGENT_MODEL_MARKET_INTRO_KEY);
    clearLocalStorageCache(AGENT_MODEL_MARKET_INTRO_KEY);

    const { unmount } = render(<AgentSettings />);

    expect(
      await screen.findByTestId('agent-model-market-intro-card')
    ).toBeInTheDocument();
    expect(screen.getByText('试试 Dimo 官方模型市场？')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '暂不需要' }));
    expect(
      screen.queryByTestId('agent-model-market-intro-card')
    ).not.toBeInTheDocument();
    unmount();

    render(<AgentSettings />);
    await screen.findByRole('button', { name: 'Codex' });
    expect(
      screen.queryByTestId('agent-model-market-intro-card')
    ).not.toBeInTheDocument();
  });
});
