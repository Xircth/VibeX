import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from 'shared/types';

import { WorktreeSettings } from './WorktreeSettings';

const api = vi.hoisted(() => ({
  getAll: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  getCleanupStatus: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  config: {
    workspace_dir: '/workspace',
    git_branch_prefix: 'codex',
  } as Config | null,
  updateAndSaveConfig: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  projectsApi: { getAll: api.getAll },
  worktreeSettingsApi: {
    get: api.get,
    update: api.update,
    getCleanupStatus: api.getCleanupStatus,
  },
}));

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({
    config: configMocks.config,
    loading: false,
    updateAndSaveConfig: configMocks.updateAndSaveConfig,
  }),
}));

vi.mock('@/components/dialogs/shared/FolderPickerDialog', () => ({
  FolderPickerDialog: { show: vi.fn() },
}));

describe('WorktreeSettings', () => {
  beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
    configMocks.updateAndSaveConfig.mockReset();
    configMocks.updateAndSaveConfig.mockResolvedValue(true);
    configMocks.config = {
      workspace_dir: '/workspace',
      git_branch_prefix: 'codex',
    } as Config;
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
    expect(projectSelect.closest('.settings-content')).toBeInTheDocument();
    expect(projectSelect.closest('.max-w-3xl')).not.toBeInTheDocument();
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

  it('edits and saves the global worktree settings (workspace dir + branch prefix)', async () => {
    const user = userEvent.setup();
    render(<WorktreeSettings />);

    // 工作树设置区块预填全局 Config 的值。
    expect(await screen.findByDisplayValue('/workspace')).toBeInTheDocument();
    const prefixInput = screen.getByDisplayValue('codex');

    await user.clear(prefixInput);
    await user.type(prefixInput, 'feature');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(configMocks.updateAndSaveConfig).toHaveBeenCalledWith({
        workspace_dir: '/workspace',
        git_branch_prefix: 'feature',
      })
    );
  });

  it('syncs the global worktree settings after the config finishes loading', async () => {
    configMocks.config = null;
    const { rerender } = render(<WorktreeSettings />);

    // config 未就绪时不显示编辑值，也不会出现保存入口。
    expect(screen.queryByDisplayValue('/workspace')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '保存' })
    ).not.toBeInTheDocument();

    configMocks.config = {
      workspace_dir: '/workspace',
      git_branch_prefix: 'codex',
    } as Config;
    rerender(<WorktreeSettings />);

    expect(await screen.findByDisplayValue('/workspace')).toBeInTheDocument();
    expect(screen.getByDisplayValue('codex')).toBeInTheDocument();
    // 尚未编辑：不显示保存按钮，避免把空 draft 覆盖回全局配置。
    expect(
      screen.queryByRole('button', { name: '保存' })
    ).not.toBeInTheDocument();
  });

  it('shows the branch prefix error only after the user edits the value', async () => {
    const user = userEvent.setup();
    configMocks.config = {
      workspace_dir: null,
      git_branch_prefix: '',
    } as Config;
    render(<WorktreeSettings />);

    // 未设置过前缀、也未编辑时不报错。
    expect(screen.queryByText('分支前缀不能为空')).not.toBeInTheDocument();

    const prefixInput = await screen.findByPlaceholderText('vibex');
    await user.type(prefixInput, 'a/');
    expect(prefixInput).toHaveValue('a/');
    expect(
      screen.getByText('分支前缀不能以 / 开头或结尾。')
    ).toBeInTheDocument();
  });
});
