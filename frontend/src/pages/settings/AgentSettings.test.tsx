import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSettings } from './AgentSettings';

const agentsApiMock = vi.hoisted(() => ({
  listRegistry: vi.fn(),
  listConfigSurfaces: vi.fn(),
  listMcpSurfaces: vi.fn(),
  listSkillsSurfaces: vi.fn(),
  listInstallPlans: vi.fn(),
  refreshCapabilityCatalog: vi.fn(),
}));

const agentSettingsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  updatePreferences: vi.fn(),
  reorder: vi.fn(),
  preflight: vi.fn(),
  runFix: vi.fn(),
  detectVersion: vi.fn(),
  readNativeFiles: vi.fn(),
  writeNativeFiles: vi.fn(),
}));

vi.mock('@/features/agents/api', () => ({
  agentsApi: agentsApiMock,
}));

vi.mock('@/lib/api', () => ({
  agentSettingsApi: agentSettingsApiMock,
}));

function renderAgentSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');

  render(
    <QueryClientProvider client={queryClient}>
      <AgentSettings />
    </QueryClientProvider>
  );

  return { queryClient, invalidateQueries };
}

function mockRegistry() {
  agentsApiMock.listRegistry.mockResolvedValue([
    {
      agent_type: 'codex' as const,
      registry_id: 'codex-acp',
      name: 'Codex',
      description: 'Codex ACP',
      distribution: {
        kind: 'binary',
        version: '1.0.0',
        cmd: 'codex' as const,
        args: ['acp'],
        platforms: [],
      },
    },
    {
      agent_type: 'gemini' as const,
      registry_id: 'gemini-acp',
      name: 'Gemini',
      description: 'Gemini ACP',
      distribution: {
        kind: 'npx',
        version: '1.0.0',
        package: '@google/gemini-cli',
        cmd: 'gemini' as const,
        args: [],
        node_required: '20.0.0',
      },
    },
  ]);
  agentsApiMock.listConfigSurfaces.mockResolvedValue([
    {
      agent_type: 'codex' as const,
      strategy: 'file_toml',
      auth_paths: [],
      config_paths: [
        {
          env_var: 'CODEX_HOME',
          unix: '~/.codex/config.toml',
          windows: '%USERPROFILE%\\.codex\\config.toml',
        },
      ],
    },
    {
      agent_type: 'gemini' as const,
      strategy: 'directory',
      auth_paths: [],
      config_paths: [],
    },
  ]);
  agentsApiMock.listMcpSurfaces.mockResolvedValue([
    { agent_type: 'codex' as const, strategy: 'file_toml', user_visible: true },
    {
      agent_type: 'gemini' as const,
      strategy: 'agent_command',
      user_visible: true,
    },
  ]);
  agentsApiMock.listSkillsSurfaces.mockResolvedValue([
    {
      agent_type: 'codex' as const,
      strategy: 'directory',
      global_supported: true,
      project_supported: true,
    },
    {
      agent_type: 'gemini' as const,
      strategy: 'agent_command',
      global_supported: true,
      project_supported: false,
    },
  ]);
  agentsApiMock.listInstallPlans.mockResolvedValue([
    {
      agent_type: 'codex' as const,
      required_tools: [],
      user_visible_summary: 'Install Codex',
      distribution: {
        kind: 'binary',
        version: '1.0.0',
        cmd: 'codex' as const,
        args: ['acp'],
        platforms: [],
      },
    },
    {
      agent_type: 'gemini' as const,
      required_tools: ['node>=20.0.0'],
      user_visible_summary: 'Install Gemini',
      distribution: {
        kind: 'npx',
        version: '1.0.0',
        package: '@google/gemini-cli',
        cmd: 'gemini' as const,
        args: [],
        node_required: '20.0.0',
      },
    },
  ]);
  agentsApiMock.refreshCapabilityCatalog.mockResolvedValue(false);
  agentSettingsApiMock.list.mockResolvedValue([
    {
      id: 1,
      agent_type: 'codex' as const,
      enabled: true,
      sort_order: 0,
      installed_version: '0.9.0',
      env_json: '{"OPENAI_API_KEY":"sk-test"}',
      config_json: '{"model":"gpt-5"}',
      auto_approve_mode: 'off',
    },
  ]);
  agentSettingsApiMock.detectVersion.mockResolvedValue('0.9.0');
  agentSettingsApiMock.readNativeFiles.mockResolvedValue([
    {
      id: 'config',
      label: 'config.toml',
      path: '~/.codex/config.toml',
      format: 'toml',
      exists: true,
      content: 'model = "gpt-5"\n',
    },
    {
      id: 'auth',
      label: 'auth.json',
      path: '~/.codex/auth.json',
      format: 'json',
      exists: false,
      content: null,
    },
  ]);
  agentSettingsApiMock.writeNativeFiles.mockResolvedValue([]);
}

describe('AgentSettings', () => {
  beforeEach(() => {
    for (const fn of Object.values(agentsApiMock)) {
      fn.mockReset();
    }
    for (const fn of Object.values(agentSettingsApiMock)) {
      fn.mockReset();
    }
  });

  it('renders registry rows with persisted agent preferences', async () => {
    mockRegistry();
    agentSettingsApiMock.list.mockResolvedValue([
      {
        id: 1,
        agent_type: 'codex' as const,
        enabled: true,
        sort_order: 0,
        installed_version: '0.9.0',
        env_json: '{"OPENAI_API_KEY":"sk-test"}',
        config_json: '{"model":"gpt-5"}',
        auto_approve_mode: 'off',
        local_runtime: {
          cli: {
            path: '/usr/local/bin/codex',
            version: '0.144.4',
            minimum_supported_version: '0.130.0',
            supported: true,
          },
          acp: {
            path: '/usr/local/bin/codex-acp',
            version: '0.9.0',
            minimum_supported_version: '0.9.0',
            supported: true,
          },
        },
      },
    ]);

    renderAgentSettings();

    await waitFor(() => {
      expect(
        screen.getByTestId('agent-registry-row-codex')
      ).toBeInTheDocument();
    });

    expect(screen.getByTestId('agent-registry-row-gemini')).toBeInTheDocument();
    expect(screen.getAllByText(/版本 0\.9\.0/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('runtime-detail-cli')).toHaveTextContent(
      '/usr/local/bin/codex'
    );
    expect(screen.getByTestId('runtime-detail-cli')).toHaveTextContent(
      '版本 0.144.4'
    );
    expect(screen.getByTestId('runtime-detail-acp')).toHaveTextContent(
      '/usr/local/bin/codex-acp'
    );
    expect(await screen.findByDisplayValue('gpt-5')).toBeInTheDocument();
    expect(agentSettingsApiMock.list).toHaveBeenCalledTimes(1);
  });

  it('toggles enablement through the agent settings API', async () => {
    const user = userEvent.setup();
    mockRegistry();
    agentSettingsApiMock.updatePreferences.mockResolvedValue({
      id: 1,
      agent_type: 'codex' as const,
      enabled: false,
      sort_order: 0,
      installed_version: '0.9.0',
      env_json: '{"OPENAI_API_KEY":"sk-test"}',
      config_json: null,
      auto_approve_mode: 'off',
    });

    renderAgentSettings();

    await screen.findByTestId('agent-registry-row-codex');
    await user.click(screen.getByRole('switch', { name: '启用 Agent' }));

    await waitFor(() => {
      expect(agentSettingsApiMock.updatePreferences).toHaveBeenCalledWith({
        agentType: 'codex' as const,
        enabled: false,
      });
    });
  });

  it('runs setup preflight checks for the selected agent', async () => {
    const user = userEvent.setup();
    mockRegistry();
    agentSettingsApiMock.preflight.mockResolvedValue({
      checks: [
        {
          check_id: 'runtime_launcher',
          label: 'codex runtime launcher',
          status: 'pass',
          message: 'Found at codex',
          fixes: [],
        },
        {
          check_id: 'auth',
          label: 'Authentication',
          status: 'warn',
          message:
            'Authentication marker was not found at C:/Users/test/.codex/auth.json.',
          fixes: [],
        },
      ],
    });

    renderAgentSettings();

    await screen.findByTestId('agent-registry-row-codex');
    await user.click(screen.getByRole('button', { name: '立即检查' }));

    await waitFor(() => {
      expect(agentSettingsApiMock.preflight).toHaveBeenCalledWith(
        'codex' as const
      );
    });
    expect(screen.getByText('运行入口可用。')).toBeInTheDocument();
    expect(screen.getByText('可用')).toBeInTheDocument();
    expect(screen.getByText('Authentication')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Authentication marker was not found at C:/Users/test/.codex/auth.json.'
      )
    ).toBeInTheDocument();
  });

  it('offers an in-app update when the Agent CLI is outdated', async () => {
    const user = userEvent.setup();
    mockRegistry();
    const outdatedPreflight = {
      checks: [
        {
          check_id: 'cli_version',
          label: 'Agent CLI runtime',
          status: 'warn',
          message: '@openai/codex 0.139.0 is outdated (latest: 0.144.4).',
          fixes: [{ action: 'upgrade_cli', label: 'Update CLI' }],
        },
      ],
    };
    agentSettingsApiMock.preflight.mockResolvedValue(outdatedPreflight);
    agentSettingsApiMock.runFix.mockResolvedValue(undefined);

    renderAgentSettings();

    await screen.findByTestId('agent-registry-row-codex');
    await user.click(screen.getByRole('button', { name: '立即检查' }));
    expect(await screen.findByText('Agent CLI runtime')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '更新' }));

    await waitFor(() => {
      expect(agentSettingsApiMock.runFix).toHaveBeenCalledWith({
        agentType: 'codex',
        action: 'upgrade_cli',
      });
    });
  });

  it('offers an in-app install when the local Agent CLI is missing', async () => {
    const user = userEvent.setup();
    mockRegistry();
    agentSettingsApiMock.preflight
      .mockResolvedValueOnce({
        checks: [
          {
            check_id: 'cli_version',
            label: 'Agent CLI runtime',
            status: 'fail',
            message: '@openai/codex CLI was not found on PATH.',
            fixes: [{ action: 'install_cli', label: 'Install CLI' }],
          },
        ],
      })
      .mockResolvedValueOnce({ checks: [] });
    agentSettingsApiMock.runFix.mockResolvedValue(undefined);

    const { invalidateQueries } = renderAgentSettings();

    await screen.findByTestId('agent-registry-row-codex');
    await user.click(screen.getByRole('button', { name: '立即检查' }));
    expect(await screen.findByText('Agent CLI runtime')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '安装' }));

    await waitFor(() => {
      expect(agentSettingsApiMock.runFix).toHaveBeenCalledWith({
        agentType: 'codex',
        action: 'install_cli',
      });
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['agent-settings'],
        refetchType: 'active',
      });
      // Installing the runtime only refreshes runtime availability. Session
      // controls come from the concrete Prepared ACP Session, so Settings
      // must not start another discovery process here.
      expect(agentsApiMock.refreshCapabilityCatalog).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: '立即检查' })).toBeEnabled();
    });
  });

  it('auto-fix lets a CLI install perform its matching ACP repair', async () => {
    const user = userEvent.setup();
    mockRegistry();
    const missingRuntimePreflight = {
      checks: [
        {
          check_id: 'runtime_launcher',
          label: 'Runtime launcher',
          status: 'fail',
          message: '`codex-acp` was not found in PATH.',
          fixes: [{ action: 'install_npm', label: 'Install ACP adapter' }],
        },
        {
          check_id: 'cli_version',
          label: 'Agent CLI runtime',
          status: 'fail',
          message: '@openai/codex CLI was not found on PATH.',
          fixes: [{ action: 'install_cli', label: 'Install CLI' }],
        },
      ],
    };
    agentSettingsApiMock.preflight.mockResolvedValue(missingRuntimePreflight);
    agentSettingsApiMock.runFix.mockResolvedValue(undefined);

    renderAgentSettings();

    await screen.findByTestId('agent-registry-row-codex');
    await user.click(screen.getByRole('button', { name: '立即检查' }));
    await user.click(await screen.findByRole('button', { name: '自动补全' }));

    await waitFor(() => {
      expect(agentSettingsApiMock.runFix).toHaveBeenCalledTimes(1);
      expect(agentSettingsApiMock.runFix).toHaveBeenCalledWith({
        agentType: 'codex',
        action: 'install_cli',
      });
    });
  });

  it('uses the shared settings surface for agent config sections', async () => {
    mockRegistry();

    renderAgentSettings();

    const configSection = (await screen.findByText('配置管理')).closest(
      'section'
    );
    const envSection = screen.getByText('环境变量').closest('section');
    const preflightSection = screen.getByText('预检查').closest('section');

    for (const section of [configSection, envSection, preflightSection]) {
      expect(section).toHaveClass('settings-surface');
      expect(section).toHaveClass('overflow-hidden');
      expect(section).toHaveClass('rounded-xl');
      expect(section).not.toHaveClass('border');
      expect(section).not.toHaveClass('bg-card');
    }
  });
});
