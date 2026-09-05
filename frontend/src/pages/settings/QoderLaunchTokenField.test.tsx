import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentManagementApi } from '@/features/agent-management';

import {
  QODER_PERSONAL_ACCESS_TOKEN,
  QoderLaunchTokenField,
} from './QoderLaunchTokenField';

vi.mock('@/features/agent-management', async () => {
  const actual = await vi.importActual<
    typeof import('@/features/agent-management')
  >('@/features/agent-management');
  return {
    ...actual,
    agentManagementApi: {
      ...actual.agentManagementApi,
      environment: vi.fn(),
      writeEnvironment: vi.fn(),
    },
  };
});

describe('QoderLaunchTokenField', () => {
  beforeEach(() => {
    vi.mocked(agentManagementApi.environment).mockResolvedValue({
      agent_id: 'qoder',
      revision: 'rev-1',
      entries: [],
    });
    vi.mocked(agentManagementApi.writeEnvironment).mockResolvedValue({
      agent_id: 'qoder',
      revision: 'rev-2',
      entries: [
        {
          name: QODER_PERSONAL_ACCESS_TOKEN,
          value: null,
          secret: true,
          present: true,
          masked_value: '••••••••',
        },
      ],
    });
  });

  it('saves the personal access token as launch environment', async () => {
    const user = userEvent.setup();
    render(<QoderLaunchTokenField />);

    const field = await screen.findByLabelText('QODER_PERSONAL_ACCESS_TOKEN');
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    await user.type(field, 'pt-keep');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(agentManagementApi.writeEnvironment).toHaveBeenCalledWith({
        agent_id: 'qoder',
        base_revision: 'rev-1',
        values: { [QODER_PERSONAL_ACCESS_TOKEN]: 'pt-keep' },
      })
    );
  });

  it('clears a saved token without treating a blank field as delete', async () => {
    vi.mocked(agentManagementApi.environment).mockResolvedValue({
      agent_id: 'qoder',
      revision: 'rev-1',
      entries: [
        {
          name: QODER_PERSONAL_ACCESS_TOKEN,
          value: null,
          secret: true,
          present: true,
          masked_value: '••••••••',
        },
      ],
    });
    vi.mocked(agentManagementApi.writeEnvironment).mockResolvedValue({
      agent_id: 'qoder',
      revision: 'rev-2',
      entries: [],
    });
    const user = userEvent.setup();
    render(<QoderLaunchTokenField />);

    expect(
      await screen.findByPlaceholderText('已保存；留空则保持不变')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '清除' }));

    await waitFor(() =>
      expect(agentManagementApi.writeEnvironment).toHaveBeenCalledWith({
        agent_id: 'qoder',
        base_revision: 'rev-1',
        values: { [QODER_PERSONAL_ACCESS_TOKEN]: null },
      })
    );
  });
});
