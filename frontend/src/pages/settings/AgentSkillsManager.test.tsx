import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentSkillsManager } from './AgentSkillsManager';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  skillsApi: mocks,
}));

const skill = {
  id: 'review-code',
  scope: 'global' as const,
  path: '/tmp/skills/review-code',
  description: 'Review code',
  read_only: false,
};

describe('AgentSkillsManager', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.list.mockResolvedValue({
      supported: true,
      locations: [
        {
          scope: 'global',
          path: '/tmp/skills',
          exists: true,
          read_only: false,
        },
      ],
      skills: [skill],
    });
    mocks.read.mockResolvedValue({ skill, content: '# Original' });
    mocks.save.mockResolvedValue(skill);
    mocks.delete.mockResolvedValue(undefined);
  });

  it('loads, edits, and saves a native Agent Skill', async () => {
    const user = userEvent.setup();
    render(<AgentSkillsManager agentId="codex" />);

    await user.click(
      await screen.findByRole('button', { name: 'review-code' })
    );
    const editor = await screen.findByRole('textbox', {
      name: 'Skill 内容',
    });
    await user.clear(editor);
    await user.type(editor, '# Updated');
    await user.click(screen.getByRole('button', { name: '保存 Skill' }));

    await waitFor(() => {
      expect(mocks.save).toHaveBeenCalledWith({
        agentType: 'codex',
        scope: 'global',
        skillId: 'review-code',
        content: '# Updated',
        workspacePath: null,
      });
    });
  });

  it('requires an explicit destructive confirmation before deletion', async () => {
    const user = userEvent.setup();
    render(<AgentSkillsManager agentId="codex" />);
    await user.click(
      await screen.findByRole('button', { name: 'review-code' })
    );
    await user.click(await screen.findByRole('button', { name: '删除' }));
    expect(mocks.delete).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '删除' }));
    await waitFor(() =>
      expect(mocks.delete).toHaveBeenCalledWith({
        agentType: 'codex',
        scope: 'global',
        skillId: 'review-code',
        workspacePath: null,
      })
    );
  });
});
