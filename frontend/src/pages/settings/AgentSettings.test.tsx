import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSettings } from './AgentSettings';

const agentsApiMock = vi.hoisted(() => ({
  listRegistry: vi.fn(),
  listConfigSurfaces: vi.fn(),
  listMcpSurfaces: vi.fn(),
  listSkillsSurfaces: vi.fn(),
  listInstallPlans: vi.fn(),
}));

vi.mock('@/features/agents/api', () => ({
  agentsApi: agentsApiMock,
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
}

describe('AgentSettings', () => {
  beforeEach(() => {
    for (const fn of Object.values(agentsApiMock)) {
      fn.mockReset();
    }
  });

  it('renders registry driven agent rows', async () => {
    mockRegistry();

    render(<AgentSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-registry-row-codex')).toBeInTheDocument();
    });

    expect(screen.getByTestId('agent-registry-row-gemini')).toBeInTheDocument();
    expect(screen.getByText('node>=20.0.0')).toBeInTheDocument();
    expect(agentsApiMock.listRegistry).toHaveBeenCalledTimes(1);
  });
});
