import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEnvironmentView } from 'shared/types';

import { agentManagementApi } from '@/features/agent-management';

import {
  AgentEnvironmentEditor,
  buildEnvironmentPatch,
  type EnvironmentRow,
} from './AgentEnvironmentEditor';

const environment: AgentEnvironmentView = {
  agent_id: 'codex',
  revision: 'revision-1',
  entries: [
    {
      name: 'MODEL',
      value: 'gpt-5',
      secret: false,
      present: true,
      masked_value: null,
    },
    {
      name: 'OPENAI_API_KEY',
      value: null,
      secret: true,
      present: true,
      masked_value: '••••••••',
    },
  ],
};

describe('AgentEnvironmentEditor', () => {
  afterEach(() => vi.restoreAllMocks());

  it('updates plain variables without retransmitting a saved credential', async () => {
    vi.spyOn(agentManagementApi, 'environment').mockResolvedValue(environment);
    const write = vi
      .spyOn(agentManagementApi, 'writeEnvironment')
      .mockResolvedValue({
        ...environment,
        revision: 'revision-2',
        entries: [
          { ...environment.entries[0], value: 'gpt-5.2' },
          environment.entries[1],
        ],
      });
    const user = userEvent.setup();

    render(<AgentEnvironmentEditor agentId="codex" />);

    const model = await screen.findByLabelText('环境变量 MODEL 的值');
    await user.clear(model);
    await user.type(model, 'gpt-5.2');
    expect(
      screen.getByLabelText('环境变量 OPENAI_API_KEY 的值')
    ).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(write).toHaveBeenCalledWith({
        agent_id: 'codex',
        base_revision: 'revision-1',
        values: { MODEL: 'gpt-5.2' },
      })
    );
  });

  it('projects deletion and rename as an incremental patch', () => {
    const rows: EnvironmentRow[] = [
      {
        key: 1,
        originalName: 'MODEL',
        name: 'DEFAULT_MODEL',
        value: 'gpt-5',
        secret: false,
      },
    ];
    expect(buildEnvironmentPatch(environment, rows)).toEqual({
      agent_id: 'codex',
      base_revision: 'revision-1',
      values: {
        MODEL: null,
        OPENAI_API_KEY: null,
        DEFAULT_MODEL: 'gpt-5',
      },
    });
  });
});
