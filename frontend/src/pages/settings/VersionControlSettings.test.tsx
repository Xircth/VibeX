import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from 'shared/types';

import { VersionControlSettings } from './VersionControlSettings';

const mocks = vi.hoisted(() => ({
  config: {
    workspace_dir: '/workspace',
    git_branch_prefix: 'codex',
    commit_reminder_enabled: true,
    commit_reminder_prompt: null,
    pr_auto_description_enabled: false,
    pr_auto_description_prompt: null,
  } as Config,
  updateAndSaveConfig: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  detectGit: vi.fn(),
  testGitPath: vi.fn(),
  getGithubCliStatus: vi.fn(),
  openGithubCliLogin: vi.fn(),
  logoutGithubCli: vi.fn(),
  folderPicker: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({
    config: mocks.config,
    loading: false,
    updateAndSaveConfig: mocks.updateAndSaveConfig,
  }),
}));

vi.mock('@/lib/api', () => ({
  versionControlApi: {
    getSettings: mocks.getSettings,
    updateSettings: mocks.updateSettings,
    detectGit: mocks.detectGit,
    testGitPath: mocks.testGitPath,
    getGithubCliStatus: mocks.getGithubCliStatus,
    openGithubCliLogin: mocks.openGithubCliLogin,
    logoutGithubCli: mocks.logoutGithubCli,
  },
}));

vi.mock('@/components/dialogs/shared/FolderPickerDialog', () => ({
  FolderPickerDialog: { show: mocks.folderPicker },
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: mocks.toastWarning,
    info: mocks.toastInfo,
  },
}));

const gitStatus = {
  installed: true,
  version: 'git version 2.50.0',
  path: '/usr/bin/git',
  message: null,
};

const githubStatus = {
  gh_installed: true,
  gh_path: '/opt/homebrew/bin/gh',
  authenticated: false,
  username: null,
  host: 'github.com',
  message: 'not logged in',
};

describe('VersionControlSettings', () => {
  beforeEach(() => {
    for (const value of Object.values(mocks)) {
      if (typeof value === 'function' && 'mockReset' in value)
        value.mockReset();
    }
    mocks.updateAndSaveConfig.mockResolvedValue(true);
    mocks.getSettings.mockResolvedValue({ git_custom_path: null });
    mocks.updateSettings.mockImplementation(async (settings) => settings);
    mocks.detectGit.mockResolvedValue(gitStatus);
    mocks.testGitPath.mockResolvedValue(gitStatus);
    mocks.getGithubCliStatus.mockResolvedValue(githubStatus);
    mocks.openGithubCliLogin.mockResolvedValue(undefined);
  });

  it('loads Git/GitHub state and persists both CLI and worktree settings', async () => {
    const user = userEvent.setup();
    render(<VersionControlSettings />);

    expect(await screen.findByText('git version 2.50.0')).toBeVisible();
    expect(mocks.getGithubCliStatus).toHaveBeenCalledWith('github.com');
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(mocks.openGithubCliLogin).toHaveBeenCalledWith('github.com');

    const gitSection = screen.getByText('Git 版本设置').closest('section');
    expect(gitSection).not.toBeNull();
    const pathInput = within(gitSection!).getByPlaceholderText(/Program Files/);
    await user.type(pathInput, '/custom/git');
    await user.click(within(gitSection!).getByRole('button', { name: '检测' }));
    await waitFor(() => {
      expect(mocks.testGitPath).toHaveBeenCalledWith('/custom/git');
    });
    await user.click(within(gitSection!).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(mocks.updateSettings).toHaveBeenCalledWith({
        git_custom_path: '/custom/git',
      });
    });

    const prefix = screen.getByDisplayValue('codex');
    await user.clear(prefix);
    await user.type(prefix, 'feature');
    await user.click(screen.getAllByRole('button', { name: '保存' }).at(-1)!);

    await waitFor(() => {
      expect(mocks.updateAndSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ git_branch_prefix: 'feature' })
      );
    });
  });

  it('logs out the authenticated GitHub CLI identity explicitly', async () => {
    const user = userEvent.setup();
    mocks.getGithubCliStatus.mockResolvedValue({
      ...githubStatus,
      authenticated: true,
      username: 'sean',
      message: null,
    });
    mocks.logoutGithubCli.mockResolvedValue(githubStatus);
    render(<VersionControlSettings />);

    await user.click(await screen.findByRole('button', { name: '退出' }));
    await waitFor(() => {
      expect(mocks.logoutGithubCli).toHaveBeenCalledWith('github.com', 'sean');
    });
  });

  it('persists the commit reminder toggle through the application config', async () => {
    const user = userEvent.setup();
    render(<VersionControlSettings />);

    await user.click(screen.getByRole('switch', { name: '启用提交提醒' }));
    await user.click(screen.getAllByRole('button', { name: '保存' }).at(-1)!);

    await waitFor(() => {
      expect(mocks.updateAndSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ commit_reminder_enabled: false })
      );
    });
  });
});
