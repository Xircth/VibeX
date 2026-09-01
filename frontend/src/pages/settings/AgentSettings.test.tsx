import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentNativeConfigFieldView } from 'shared/types';

import { toast } from '@/components/ui/toast';

import { pickAuthModeTab } from './agentSettingsTestUtils';
import { AgentSettings } from './AgentSettings';

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
  clearDiagnostics: vi.fn(),
}));
const confirmShow = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Map<string, (event: unknown) => void>());

vi.mock('@/components/dialogs/shared/ConfirmDialog', () => ({
  ConfirmDialog: { show: confirmShow },
}));

vi.mock('@/features/agent-management/api', () => ({
  agentManagementApi: api,
}));

vi.mock('./PluginsSettings', () => ({
  PluginsSettings: ({ ecosystem }: { ecosystem: string }) => (
    <section aria-label={`${ecosystem} native plugins`}>
      Native plugin manager
    </section>
  ),
}));

vi.mock('@/lib/tauriApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/tauriApi')>();
  return { ...original, tauriListen: vi.fn().mockResolvedValue(vi.fn()) };
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
    listeners.clear();
    Object.values(api).forEach((mock) => mock.mockReset());
    confirmShow.mockReset();
    confirmShow.mockResolvedValue('cancelled');
    api.bar.mockResolvedValue([
      {
        agent_id: 'codex',
        display_name: 'Codex',
        description: 'Codex ACP',
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
    ).toHaveLength(7);
    expect(
      status.querySelectorAll('.agent-settings-loading-rows li')
    ).toHaveLength(5);
    expect(
      screen.queryByRole('button', { name: 'Codex' })
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

    expect(api.preflight.mock.calls).toHaveLength(callsAfterLoad);
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
        description: 'Claude Code ACP',
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

  it('requires destructive confirmation before uninstalling an Agent', async () => {
    const user = userEvent.setup();
    api.uninstall.mockResolvedValue({
      agent_id: 'codex',
      display_name: 'Codex',
      description: 'Codex ACP',
      icon_light: null,
      icon_dark: null,
      icon_svg: null,
      source: 'built_in_profile',
      built_in: true,
      retired: false,
      enabled: true,
      position: 0,
      lifecycle: 'uninstalled',
      authentication: 'account',
      runtime_version: null,
      acp_version: null,
      active_operation: null,
      rollback_available: false,
    });
    render(<AgentSettings />);
    const uninstall = await screen.findByRole('button', { name: '卸载' });

    await user.click(uninstall);
    expect(confirmShow).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'destructive' })
    );
    expect(api.uninstall).not.toHaveBeenCalled();

    confirmShow.mockResolvedValueOnce('confirmed');
    await user.click(uninstall);
    await waitFor(() => expect(api.uninstall).toHaveBeenCalledWith('codex'));
  });

  it('lets the user install an added Agent when preflight finds no valid installation', async () => {
    const user = userEvent.setup();
    api.bar.mockResolvedValue([
      {
        agent_id: 'kimi',
        display_name: 'Kimi CLI',
        description: "Moonshot AI's coding assistant",
        icon_light: null,
        icon_dark: null,
        icon_svg: null,
        source: 'official_registry',
        built_in: false,
        retired: false,
        enabled: true,
        position: 0,
        lifecycle: 'uninstalled',
        authentication: 'not_required',
        runtime_version: null,
        acp_version: null,
        active_operation: null,
        rollback_available: false,
      },
    ]);
    api.readConfig.mockResolvedValue({
      agent_id: 'kimi',
      available: false,
      settings_features: [],
      path: null,
      paths: [],
      fields: [],
      files: [],
      applies_to_next_session: true,
    });
    api.preflight.mockResolvedValue({
      agent_id: 'kimi',
      checked_at: '2026-08-04T00:00:00Z',
      items: [
        {
          id: 'membership',
          label: '运行入口',
          status: 'pass',
          detail: 'Agent 已加入本地列表。',
          version: null,
          path: null,
          source: null,
          repairable: false,
          update_available: false,
          available_version: null,
          update_group: null,
        },
        {
          id: 'runtime',
          label: '本地 Runtime',
          status: 'fail',
          detail: '未发现有效的当前安装锁。',
          version: null,
          path: null,
          source: null,
          repairable: true,
          update_available: false,
          available_version: null,
          update_group: null,
        },
        {
          id: 'acp',
          label: 'ACP 适配器',
          status: 'fail',
          detail: '未通过 ACP 探测。',
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
    api.addAndInstall.mockResolvedValue({
      operation_id: 'install-kimi',
      agent_id: 'kimi',
      kind: 'install',
      status: 'queued',
    });

    render(<AgentSettings />);
    await screen.findByRole('button', { name: 'Kimi CLI' });
    await user.click(screen.getByRole('button', { name: '立即检查' }));

    await user.click(
      await screen.findByRole('button', { name: '安装 Runtime 与 ACP' })
    );
    expect(api.addAndInstall).toHaveBeenCalledWith('kimi');
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
    expect(screen.getByLabelText('Agent ID')).toBeDisabled();
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

    // 已读记录不进入列表,未读记录正常显示。
    await waitFor(() =>
      expect(screen.getByText('启动前完整性验证失败')).toBeInTheDocument()
    );
    expect(screen.queryByText('已读记录不显示')).not.toBeInTheDocument();

    // 一键已读 = 全部标记已读并清空列表。
    await user.click(screen.getByRole('button', { name: '全部已读' }));
    await waitFor(() =>
      expect(api.markDiagnosticsRead).toHaveBeenCalledWith('codex')
    );
    await waitFor(() =>
      expect(screen.queryByText('启动前完整性验证失败')).not.toBeInTheDocument()
    );
  });

  it('runs a local preflight for the selected Agent immediately', async () => {
    const loggedOut = {
      agent_id: 'codex',
      display_name: 'Codex',
      description: 'Codex ACP',
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
    let authenticated = false;
    api.bar.mockImplementation(async () => [
      authenticated ? loggedIn : loggedOut,
    ]);
    const item = {
      source: null,
      repairable: false,
      update_available: false,
      available_version: null,
      update_group: null,
    };
    api.preflight.mockImplementation(async (agentId: string) => {
      authenticated = true;
      return {
        agent_id: agentId,
        checked_at: '2026-08-22T00:00:00Z',
        items: [
          {
            ...item,
            id: 'runtime',
            label: '本地 Runtime',
            status: 'pass',
            detail: '',
            version: '1.0.0',
            path: '/usr/local/bin/codex',
          },
          {
            ...item,
            id: 'auth.mode',
            label: '鉴权模式',
            status: 'pass',
            detail: 'ChatGPT 订阅模式已检测到有效账号会话。',
            version: 'chatgpt_subscription',
            path: '/tmp/.codex/auth.json',
          },
        ],
      };
    });

    render(<AgentSettings />);

    expect(await screen.findByText('暂未登录')).toBeVisible();
    await waitFor(() => expect(api.preflight).toHaveBeenCalledWith('codex'));
    expect(await screen.findByText('已通过账号登录')).toBeVisible();
    expect(await screen.findByText('未获得有效用户信息')).toBeVisible();
    expect(api.preflight.mock.calls[0]).toEqual(['codex']);
  });

  it('applies a background update check after local preflight without blocking the list', async () => {
    api.preflight.mockResolvedValue({
      agent_id: 'codex',
      checked_at: '2026-08-22T00:00:00Z',
      items: [
        {
          id: 'runtime',
          label: '本地 Runtime',
          status: 'pass',
          detail: '',
          version: '1.0.0',
          path: '/usr/local/bin/codex',
          source: null,
          repairable: false,
          update_available: false,
          available_version: null,
          update_group: null,
        },
        {
          id: 'acp',
          label: 'ACP 适配器',
          status: 'pass',
          detail: '',
          version: '1.1.0',
          path: '/usr/local/bin/codex-acp',
          source: null,
          repairable: false,
          update_available: false,
          available_version: null,
          update_group: null,
        },
      ],
    });
    let finishUpdate: (value: unknown) => void = () => undefined;
    api.checkUpdate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpdate = resolve;
        })
    );

    render(<AgentSettings />);
    await waitFor(() => expect(api.preflight).toHaveBeenCalledWith('codex'));
    expect(await screen.findByTitle('1.0.0')).toBeInTheDocument();
    expect(screen.queryByText('可更新')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '立即检查' })
    ).not.toHaveAttribute('disabled');
    await waitFor(() => expect(api.checkUpdate).toHaveBeenCalledWith('codex'));

    await act(async () => {
      finishUpdate({
        agent_id: 'codex',
        current_version: '1.1.0',
        available_version: '1.7.0',
        update_available: true,
        runtime_current: '1.0.0',
        runtime_available: '0.148.0',
        acp_current: '1.1.0',
        acp_available: '1.7.0',
        snapshot_id: null,
        fetched_at: null,
        fresh: true,
      });
    });

    await waitFor(() =>
      expect(screen.getAllByText('可更新')).toHaveLength(2)
    );
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

  it('updates Runtime and ACP preflight items and toasts when an update finishes', async () => {
    api.preflight.mockResolvedValue({
      agent_id: 'codex',
      checked_at: '2026-08-21T00:00:00Z',
      items: [
        {
          id: 'runtime',
          label: '本地 Runtime',
          status: 'pass',
          detail: '',
          version: '1.0.0',
          path: '/opt/codex',
          source: null,
          repairable: false,
          update_available: true,
          available_version: '0.148.0',
          update_group: 'runtime-acp',
        },
        {
          id: 'acp',
          label: 'ACP 适配器',
          status: 'pass',
          detail: '',
          version: '1.1.0',
          path: '/opt/codex-acp',
          source: null,
          repairable: true,
          update_available: true,
          available_version: '1.7.0',
          update_group: 'runtime-acp',
        },
      ],
    });
    const success = vi.spyOn(toast, 'success');
    render(<AgentSettings />);
    await screen.findByRole('button', { name: 'Codex' });
    await waitFor(() =>
      expect(listeners.has('agent-management-event')).toBe(true)
    );
    expect(await screen.findByTitle('1.0.0')).toBeInTheDocument();
    expect(screen.getByTitle('1.1.0')).toBeInTheDocument();
    api.preflight.mockClear();
    api.bar.mockResolvedValue([
      {
        agent_id: 'codex',
        display_name: 'Codex',
        description: 'Codex ACP',
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
        runtime_version: '0.148.0',
        acp_version: '1.7.0',
        active_operation: null,
        rollback_available: true,
        settings_features: ['authentication_mode'],
      },
    ]);

    await act(async () => {
      listeners.get('agent-management-event')?.({
        sequence: 1,
        agent_id: 'codex',
        operation_id: 'update-1',
        kind: 'update',
        status: 'running',
        progress_percent: 20,
        message: '正在安装本地 Runtime 与 ACP',
      });
    });
    await act(async () => {
      listeners.get('agent-management-event')?.({
        sequence: 2,
        agent_id: 'codex',
        operation_id: 'update-1',
        kind: 'update',
        status: 'succeeded',
        progress_percent: 100,
        message: '安装与 ACP 验证完成',
      });
    });

    await waitFor(() =>
      expect(success).toHaveBeenCalledWith('已完成 Runtime 与 ACP 更新')
    );
    expect(api.preflight).not.toHaveBeenCalledWith('codex');
    await waitFor(() =>
      expect(screen.getByTitle('0.148.0')).toBeInTheDocument()
    );
    expect(screen.getByTitle('1.7.0')).toBeInTheDocument();
    expect(screen.queryByText('可更新')).not.toBeInTheDocument();
  });
});

function configField(
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
