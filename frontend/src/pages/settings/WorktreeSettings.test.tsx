import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorktreeSettings } from './WorktreeSettings';

const api = vi.hoisted(() => ({
  getAll: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  getCleanupStatus: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  projectsApi: { getAll: api.getAll },
  worktreeSettingsApi: {
    get: api.get,
    update: api.update,
    getCleanupStatus: api.getCleanupStatus,
  },
}));

describe('WorktreeSettings', () => {
  beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
    api.getAll.mockResolvedValue([
      { id: 'project-1', name: 'MySite' },
      { id: 'project-2', name: 'ApiServer' },
    ]);
    api.get.mockResolvedValue({
      create_command: 'pnpm install',
      delete_command: 'pnpm run clean',
      cleanup_prompt_enabled: true,
      cleanup_prompt_threshold: 4,
    });
    api.getCleanupStatus.mockResolvedValue({
      current_count: 5,
      threshold: 4,
      should_prompt: true,
    });
    api.update.mockImplementation(async (_projectId, settings) => settings);
  });

  it('loads and saves worktree behavior for the selected project', async () => {
    const user = userEvent.setup();
    render(<WorktreeSettings />);

    const projectSelect = await screen.findByRole('combobox', {
      name: /项目|project/i,
    });
    expect(projectSelect).toHaveValue('project-1');
    expect(await screen.findByDisplayValue('pnpm install')).toBeInTheDocument();
    expect(screen.getByDisplayValue('pnpm run clean')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton')).toHaveValue(4);
    expect(screen.getByText(/5.*4|4.*5/)).toBeInTheDocument();
    expect(
      screen.queryByText(/JSON 设置源|JSON source/i)
    ).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText(/创建.*命令|create.*command/i));
    await user.type(
      screen.getByLabelText(/创建.*命令|create.*command/i),
      'pnpm bootstrap'
    );
    await user.click(screen.getByRole('button', { name: /保存|save/i }));

    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith('project-1', {
        create_command: 'pnpm bootstrap',
        delete_command: 'pnpm run clean',
        cleanup_prompt_enabled: true,
        cleanup_prompt_threshold: 4,
      })
    );
  });
});
