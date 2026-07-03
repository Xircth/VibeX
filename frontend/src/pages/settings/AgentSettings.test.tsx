import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSettings } from './AgentSettings';

const agentsApiMock = vi.hoisted(() => ({
  listRegistry: vi.fn(),
  listConfigSurfaces: vi.fn(),
  listMcpSurfaces: vi.fn(),
  listSkillsSurfaces: vi.fn(),
  listInstallPlans: vi.fn(),
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

function mockRegistry() {
  agentsApiMock.listRegistry.mockResolvedValue([
    {
      agent_type: 'codex',
      registry_id: 'codex-acp',
      name: 'Codex',
      description: 'Codex ACP',
      distribution: {
        kind: 'binary',
        version: '1.0.0',
        cmd: 'codex',
        args: ['acp'],
        platforms: [],
      },
    },
    {
      agent_type: 'gemini',
      registry_id: 'gemini-acp',
      name: 'Gemini',
      description: 'Gemini ACP',
      distribution: {
        kind: 'npx',
        version: '1.0.0',
        package: '@google/gemini-cli',
        cmd: 'gemini',
        args: [],
        node_required: '20.0.0',
      },
    },
  ]);
  agentsApiMock.listConfigSurfaces.mockResolvedValue([
    {
      agent_type: 'codex',
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
      agent_type: 'gemini',
      strategy: 'directory',
      auth_paths: [],
      config_paths: [],
    },
  ]);
  agentsApiMock.listMcpSurfaces.mockResolvedValue([
    { agent_type: 'codex', strategy: 'file_toml', user_visible: true },
    { agent_type: 'gemini', strategy: 'agent_command', user_visible: true },
  ]);
  agentsApiMock.listSkillsSurfaces.mockResolvedValue([
    {
      agent_type: 'codex',
      strategy: 'directory',
      global_supported: true,
      project_supported: true,
    },
    {
      agent_type: 'gemini',
      strategy: 'agent_command',
      global_supported: true,
      project_supported: false,
    },
  ]);
  agentsApiMock.listInstallPlans.mockResolvedValue([
    {
      agent_type: 'codex',
      required_tools: [],
      user_visible_summary: 'Install Codex',
      distribution: {
        kind: 'binary',
        version: '1.0.0',
        cmd: 'codex',
        args: ['acp'],
        platforms: [],
      },
    },
    {
      agent_type: 'gemini',
      required_tools: ['node>=20.0.0'],
      user_visible_summary: 'Install Gemini',
      distribution: {
        kind: 'npx',
        version: '1.0.0',
        package: '@google/gemini-cli',
        cmd: 'gemini',
        args: [],
        node_required: '20.0.0',
      },
    },
  ]);
  agentSettingsApiMock.list.mockResolvedValue([
    {
      id: 1,
      agent_type: 'codex',
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

    render(<AgentSettings />);

    await waitFor(() => {
      expect(
        screen.getByTestId('agent-registry-row-codex')
      ).toBeInTheDocument();
    });

    expect(screen.getByTestId('agent-registry-row-gemini')).toBeInTheDocument();
    expect(screen.getAllByText(/版本 0\.9\.0/).length).toBeGreaterThan(0);
    expect(await screen.findByDisplayValue('gpt-5')).toBeInTheDocument();
    expect(agentSettingsApiMock.list).toHaveBeenCalledTimes(1);
  });

  it('toggles enablement through the agent settings API', async () => {
    const user = userEvent.setup();
    mockRegistry();
    agentSettingsApiMock.updatePreferences.mockResolvedValue({
      id: 1,
      agent_type: 'codex',
      enabled: false,
      sort_order: 0,
      installed_version: '0.9.0',
      env_json: '{"OPENAI_API_KEY":"sk-test"}',
      config_json: null,
      auto_approve_mode: 'off',
    });

    render(<AgentSettings />);

    await screen.findByTestId('agent-registry-row-codex');
    await user.click(screen.getByRole('switch', { name: '启用 Agent' }));

    await waitFor(() => {
      expect(agentSettingsApiMock.updatePreferences).toHaveBeenCalledWith({
        agentType: 'codex',
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

    render(<AgentSettings />);

    await screen.findByTestId('agent-registry-row-codex');
    await user.click(screen.getByRole('button', { name: '立即检查' }));

    await waitFor(() => {
      expect(agentSettingsApiMock.preflight).toHaveBeenCalledWith('codex');
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

  it('uses the shared settings surface for agent config sections', async () => {
    mockRegistry();

    render(<AgentSettings />);

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
