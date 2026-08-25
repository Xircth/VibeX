import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentManagementApi } from '@/features/agent-management';

import { DshSessionDefaults } from './DshSessionDefaults';

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

describe('DshSessionDefaults', () => {
  beforeEach(() => {
    vi.mocked(agentManagementApi.environment).mockResolvedValue({
      agent_id: 'deepseek_harness',
      revision: 'rev-1',
      entries: [
        {
          name: 'DSH_AGENT_PRESET',
          value: 'standard',
          secret: false,
          present: true,
          masked_value: null,
        },
      ],
    });
    vi.mocked(agentManagementApi.writeEnvironment).mockResolvedValue({
      agent_id: 'deepseek_harness',
      revision: 'rev-2',
      entries: [],
    });
  });

  it('saves the selected preset and permission', async () => {
    const user = userEvent.setup();
    render(<DshSessionDefaults />);

    expect(
      await screen.findByRole('radio', { name: 'Standard' })
    ).toBeChecked();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    await user.click(screen.getByRole('radio', { name: 'Minimal' }));
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(agentManagementApi.writeEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: 'deepseek_harness',
        values: expect.objectContaining({
          DSH_AGENT_PRESET: 'minimal',
        }),
      })
    );
  });
});
