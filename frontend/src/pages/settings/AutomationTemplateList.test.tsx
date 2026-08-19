import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { AutomationTemplateList } from './AutomationTemplateList';

describe('AutomationTemplateList', () => {
  it('renders Workflow and Turn templates as a dedicated template surface', async () => {
    const user = userEvent.setup();
    const onSelectWorkflow = vi.fn();
    const onSelectTurn = vi.fn();

    render(
      <AutomationTemplateList
        templates={[
          {
            id: 'review',
            draft: {
              name: 'Code review',
              enabled: false,
              trigger: { kind: 'manual' },
              launch: {
                promptBlocks: [{ type: 'text', text: 'Review this code' }],
                displayText: 'Review this code',
                agent: { agentId: 'codex', executorProfileId: null },
                modeId: null,
                configValues: [],
                pluginActions: [],
                skills: [],
                workspace: {
                  projectId: 'project-1',
                  rootFolder: '/repo',
                  branch: 'main',
                  isolation: 'worktree_per_run',
                },
                labelSnapshot: null,
              },
            },
          },
        ]}
        onSelectTurn={onSelectTurn}
        onSelectWorkflow={onSelectWorkflow}
      />
    );

    expect(screen.getByTestId('automation-template-list')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: /调研简报|research brief/i })
    );
    await user.click(screen.getByRole('button', { name: /code review/i }));

    expect(onSelectWorkflow).toHaveBeenCalledOnce();
    expect(onSelectTurn).toHaveBeenCalledWith('review');
  });
});
