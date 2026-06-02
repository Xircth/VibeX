import { render, screen, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentSettingInfo,
  LocalToolStatus,
  SystemMaintenanceStatus,
} from '@/lib/api';
import { AgentSettings } from './AgentSettings';

const listAgentsMock = vi.fn();
const getSystemMaintenanceStatusMock = vi.fn();
const reloadSystemMock = vi.fn();

vi.mock('@/lib/api', () => ({
  agentSettingsApi: {
    list: (...args: unknown[]) => listAgentsMock(...args),
  },
  configApi: {
    getSystemMaintenanceStatus: (...args: unknown[]) =>
      getSystemMaintenanceStatusMock(...args),
    installSystemDependencies: vi.fn(),
  },
}));

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({
    reloadSystem: reloadSystemMock,
  }),
}));

vi.mock('@/components/settings/AgentCard', () => ({
  AgentCard: ({
    agent,
    dependencyStatus,
  }: {
    agent: AgentSettingInfo;
    dependencyStatus: LocalToolStatus | null;
  }) => (
    <article data-testid={`agent-card-${agent.agent_type}`}>
      <span>{agent.agent_type}</span>
      <span>{dependencyStatus ? dependencyStatus.id : 'dependency-pending'}</span>
    </article>
  ),
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function createAgent(agentType: string): AgentSettingInfo {
  return {
    id: agentType.length,
    agent_type: agentType,
    enabled: true,
    sort_order: 0,
    installed_version: '2.1.146',
    env_json: null,
    config_json: null,
  };
}

function createMaintenanceStatus(): SystemMaintenanceStatus {
  return {
    app: {
      current_version: '0.1.8',
      latest_version: null,
      update_available: false,
      release_url: null,
      repository: null,
      checked: true,
      error: null,
    },
    npm: {
      name: 'npm',
      available: true,
      path: 'C:/Program Files/nodejs/npm.cmd',
      message: 'ok',
    },
    tools: [
      {
        id: 'claude_cli',
        label: 'Claude Code CLI',
        kind: 'cli',
        group_id: 'claude',
        user_visible: true,
        executable: 'claude',
        npm_package: '@anthropic-ai/claude-code',
        installed: true,
        executable_path: 'C:/tools/claude.cmd',
        installed_version: '2.1.146',
        latest_version: '2.1.159',
        minimum_supported_version: '2.1.143',
        supported: true,
        update_available: true,
        error: null,
      },
    ],
  };
}

describe('AgentSettings', () => {
  beforeEach(() => {
    listAgentsMock.mockReset();
    getSystemMaintenanceStatusMock.mockReset();
    reloadSystemMock.mockReset();
  });

  it('shows agent cards before dependency maintenance completes', async () => {
    const maintenanceDeferred = createDeferred<SystemMaintenanceStatus>();

    listAgentsMock.mockResolvedValue([
      createAgent('claude_code'),
      createAgent('codex'),
      createAgent('open_code'),
    ]);
    getSystemMaintenanceStatusMock.mockReturnValue(maintenanceDeferred.promise);

    render(<AgentSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-card-claude_code')).toBeInTheDocument();
    });

    expect(screen.getByTestId('agent-card-codex')).toBeInTheDocument();
    expect(screen.getByTestId('agent-card-open_code')).toBeInTheDocument();
    expect(screen.getAllByText('dependency-pending')).toHaveLength(3);

    await act(async () => {
      maintenanceDeferred.resolve(createMaintenanceStatus());
      await maintenanceDeferred.promise;
    });

    expect(screen.getByText('claude_cli')).toBeInTheDocument();
  });
});
