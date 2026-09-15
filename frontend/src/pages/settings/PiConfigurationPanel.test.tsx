import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiConfigurationView } from 'shared/types';

import { agentManagementApi } from '@/features/agent-management';

import { PiConfigurationPanel } from './PiConfigurationPanel';

vi.mock('@/features/agent-management', () => ({
  agentManagementApi: {
    piConfiguration: vi.fn(),
    savePiRuntime: vi.fn(),
    validatePiCommand: vi.fn(),
    piTrustEntries: vi.fn(),
    setPiProjectTrust: vi.fn(),
  },
}));

const configuration: PiConfigurationView = {
  default_provider: 'private',
  default_model: 'private-model',
  thinking_level: 'high',
  credential_present: true,
  auth_providers: ['private'],
  custom_providers: [
    {
      id: 'private',
      base_url: 'https://private.example/v1',
      api: 'openai-responses',
      models: [
        {
          id: 'private-model',
          reasoning: true,
          thinking_level_map: {
            off: 'none',
            high: 'HIGH',
          },
        },
      ],
    },
  ],
  runtime: {
    mode: 'default',
    command: '',
    config_dir: '',
    session_dir: '',
    trust_workspace: true,
  },
};

describe('PiConfigurationPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentManagementApi.piConfiguration).mockResolvedValue(
      configuration
    );
    vi.mocked(agentManagementApi.savePiRuntime).mockResolvedValue(undefined);
    vi.mocked(agentManagementApi.piTrustEntries).mockResolvedValue([]);
    vi.mocked(agentManagementApi.validatePiCommand).mockImplementation(
      async (command) => ({
        found: true,
        resolved_path: `/resolved/${command}`,
        version: 'pi 1.0',
      })
    );
  });

  it('validates and saves a bring-your-own Pi runtime', async () => {
    render(<PiConfigurationPanel disabled={false} />);
    expect(await screen.findByText('Pi Runtime')).toBeInTheDocument();
    await userEvent.click(screen.getByText('自定义 pi'));
    await userEvent.type(
      screen.getByLabelText('可执行文件'),
      '/opt/pi-preview'
    );
    await userEvent.click(screen.getByRole('button', { name: '验证' }));
    expect(await screen.findByText(/resolved.*pi-preview/)).toBeInTheDocument();
    await userEvent.clear(
      screen.getByLabelText('配置目录（PI_CODING_AGENT_DIR）')
    );
    await userEvent.type(
      screen.getByLabelText('配置目录（PI_CODING_AGENT_DIR）'),
      '/tmp/pi-config'
    );
    await userEvent.click(screen.getByRole('button', { name: '保存 Runtime' }));

    expect(agentManagementApi.savePiRuntime).toHaveBeenCalledWith({
      mode: 'custom',
      command: '/opt/pi-preview',
      config_dir: '/tmp/pi-config',
      session_dir: '',
      trust_workspace: true,
    });
  });

  it('does not duplicate Provider configuration already owned by auth', async () => {
    render(<PiConfigurationPanel disabled={false} />);
    expect(await screen.findByText('Pi Runtime')).toBeInTheDocument();
    expect(screen.queryByText('Provider 与模型')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '保存 Provider' })
    ).not.toBeInTheDocument();
  });

  it('lists trusted projects in a bounded container without a redundant trusted label', async () => {
    vi.mocked(agentManagementApi.piTrustEntries).mockResolvedValue([
      { path: '/Users/mac/Projects/VibeX', trusted: true },
      { path: '/tmp/denied-project', trusted: false },
    ]);
    render(<PiConfigurationPanel disabled={false} />);
    expect(await screen.findByText('项目信任')).toBeInTheDocument();
    const list = screen.getByRole('list');
    expect(list).toHaveClass('agent-model-provider-list', 'pi-trust-entries');
    expect(list).toHaveTextContent('/Users/mac/Projects/VibeX');
    expect(list).not.toHaveTextContent('已信任');
    expect(list).toHaveTextContent('未信任');
    expect(screen.getAllByRole('button', { name: '撤销' })).toHaveLength(2);
  });
});
