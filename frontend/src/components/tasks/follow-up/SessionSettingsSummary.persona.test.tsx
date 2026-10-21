import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SessionSettingsSummary } from './SessionSettingsSummary';

describe('SessionSettingsSummary persona', () => {
  it('uses the role name and keeps session config in a submenu', async () => {
    const user = userEvent.setup();
    const onSelectConfigOption = vi.fn();
    render(
      <SessionSettingsSummary
        persona={{
          name: '评审员',
          teamName: '评审组',
          summary: '只评论 diff',
          agentName: 'codex',
        }}
        options={[
          {
            key: 'model',
            label: 'Model',
            category: 'model',
            value: 'terra',
            choices: [
              { value: 'terra', label: 'Terra' },
              { value: 'sol', label: 'Sol' },
            ],
          },
        ]}
        pending={{}}
        onSelectConfigOption={onSelectConfigOption}
      />
    );

    await user.click(screen.getByRole('button', { name: '评审员' }));
    expect(screen.getByText('名称')).toBeInTheDocument();
    expect(screen.getByText('评审组')).toBeInTheDocument();
    expect(screen.getByText('只评论 diff')).toBeInTheDocument();
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.queryByText('Model')).not.toBeInTheDocument();

    await user.click(screen.getByText('会话配置'));
    expect(screen.getByText('Model')).toBeInTheDocument();
  });

  it('still renders a role when the conversation has no session options', () => {
    render(
      <SessionSettingsSummary
        persona={{ name: '评审员', agentName: 'codex' }}
        options={[]}
        pending={{}}
      />
    );
    expect(screen.getByRole('button', { name: '评审员' })).toBeInTheDocument();
  });
});
