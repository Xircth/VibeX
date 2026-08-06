import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { UserAgentDefinitionEditor } from './UserAgentDefinitionEditor';

describe('UserAgentDefinitionEditor', () => {
  it('submits an explicit native Skills storage declaration', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <UserAgentDefinitionEditor
        currentPlatform="darwin-aarch64"
        loading={false}
        submitLabel="Save"
        onSubmit={onSubmit}
      />
    );

    await user.type(screen.getByLabelText('Agent ID'), 'local-reviewer');
    await user.type(screen.getByPlaceholderText('Local Reviewer'), 'Reviewer');
    await user.type(screen.getByPlaceholderText('1.2.3'), '1.0.0');
    await user.type(
      screen.getByPlaceholderText('local-reviewer@1.2.3'),
      'local-reviewer@1.0.0'
    );
    await user.click(
      screen.getByRole('switch', { name: '读取共享 Skills 存储' })
    );
    await user.type(
      screen.getByLabelText('独立 Skills 目录（可选）'),
      '~/.local-reviewer/skills'
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: 'local-reviewer',
        skills_shared_store: true,
        skills_directory: '~/.local-reviewer/skills',
      })
    );
  });
});
