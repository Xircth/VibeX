import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiConfigurationView } from 'shared/types';

import { agentManagementApi } from '@/features/agent-management';

import { PiConfigurationPanel } from './PiConfigurationPanel';

vi.mock('@/features/agent-management', () => ({
  agentManagementApi: {
    piConfiguration: vi.fn(),
    savePiCredentials: vi.fn(),
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

  it('saves a custom provider with reasoning chips', async () => {
    vi.mocked(agentManagementApi.savePiCredentials).mockResolvedValue({
      ...configuration,
      default_provider: 'private',
      default_model: 'private-model',
      thinking_level: 'high',
    });
    render(<PiConfigurationPanel disabled={false} />);
    expect(await screen.findByText('Provider 与模型')).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: '声明推理能力' })
    ).toBeChecked();
    await userEvent.click(
      screen.getByRole('button', { name: 'xhigh', pressed: false })
    );
    await userEvent.click(
      screen.getByRole('button', { name: '保存 Provider' })
    );
    expect(agentManagementApi.savePiCredentials).toHaveBeenCalledWith({
      provider: 'private',
      model: 'private-model',
      thinking_level: 'high',
      api_key: null,
      custom_base_url: 'https://private.example/v1',
      custom_api: 'openai-responses',
      model_reasoning: {
        reasoning: true,
        thinking_level_map: {
          off: 'none',
          high: 'HIGH',
          xhigh: 'xhigh',
        },
      },
    });
  });
});
