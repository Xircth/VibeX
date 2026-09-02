import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from 'shared/types';

import { VersionControlSettings } from './VersionControlSettings';

const agentManagementApiMock = vi.hoisted(() => ({
  bar: vi.fn(),
}));

const agentsApiMock = vi.hoisted(() => ({
  refreshCapabilityCatalog: vi.fn(),
  capabilityCatalog: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  config: {
    workspace_dir: '/workspace',
    git_branch_prefix: 'codex',
    commit_reminder_enabled: true,
    commit_reminder_mode: 'smart',
    commit_reminder_line_threshold: 10000,
    pr_auto_description_enabled: false,
    pr_auto_description_prompt: null,
    pr_auto_description_agent_id: '',
    pr_auto_description_mode: null,
    pr_auto_description_session_config: {},
  } as Config,
  updateAndSaveConfig: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  detectGit: vi.fn(),
  testGitPath: vi.fn(),
  getGithubCliStatus: vi.fn(),
  installGithubCli: vi.fn(),
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

vi.mock('@/features/agent-management/api', () => ({
  agentManagementApi: agentManagementApiMock,
}));

vi.mock('@/features/agents/api', () => ({
  agentsApi: agentsApiMock,
}));

vi.mock('@/features/agents/sessionControlsQuery', () => ({
  loadAgentSessionControlsCatalog: () => agentsApiMock.capabilityCatalog(),
}));

vi.mock('@/lib/api', () => ({
  versionControlApi: {
    getSettings: mocks.getSettings,
    updateSettings: mocks.updateSettings,
    detectGit: mocks.detectGit,
    testGitPath: mocks.testGitPath,
    getGithubCliStatus: mocks.getGithubCliStatus,
    installGithubCli: mocks.installGithubCli,
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
    agentManagementApiMock.bar.mockReset();
    agentsApiMock.refreshCapabilityCatalog.mockReset();
    agentsApiMock.capabilityCatalog.mockReset();
    agentManagementApiMock.bar.mockResolvedValue([
      {
        agent_id: 'opencode',
        display_name: 'OpenCode',
        enabled: true,
        retired: false,
      },
    ]);
    agentsApiMock.capabilityCatalog.mockResolvedValue({
      modes: [],
      current_mode: null,
      config_options: [],
    });
    agentsApiMock.refreshCapabilityCatalog.mockResolvedValue(true);
  });

  it('loads Git/GitHub state and persists CLI settings', async () => {
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

  it('shows a concise status when GitHub CLI is not authenticated', async () => {
    const diagnostic =
      'To get started with GitHub CLI, please run: gh auth login Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.';
    mocks.getGithubCliStatus.mockResolvedValue({
      ...githubStatus,
      message: diagnostic,
    });
    render(<VersionControlSettings />);

    expect(await screen.findByText('未登录')).toBeVisible();
    expect(screen.queryByText(diagnostic)).not.toBeInTheDocument();
  });

  it('installs a missing GitHub CLI in one click and reports success', async () => {
    const user = userEvent.setup();
    mocks.getGithubCliStatus.mockResolvedValue({
      ...githubStatus,
      gh_installed: false,
      gh_path: null,
    });
    mocks.installGithubCli.mockResolvedValue(githubStatus);
    render(<VersionControlSettings />);

    await user.click(
      await screen.findByRole('button', { name: '安装 GitHub CLI' })
    );

    await waitFor(() => {
      expect(mocks.installGithubCli).toHaveBeenCalledOnce();
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        'GitHub CLI 安装成功',
        expect.objectContaining({ description: '/opt/homebrew/bin/gh' })
      );
    });
    expect(
      screen.queryByRole('button', { name: '安装 GitHub CLI' })
    ).not.toBeInTheDocument();
  });

  it('reports a one-click GitHub CLI installation failure', async () => {
    const user = userEvent.setup();
    mocks.getGithubCliStatus.mockResolvedValue({
      ...githubStatus,
      gh_installed: false,
      gh_path: null,
    });
    mocks.installGithubCli.mockRejectedValue(new Error('network failed'));
    render(<VersionControlSettings />);

    await user.click(
      await screen.findByRole('button', { name: '安装 GitHub CLI' })
    );

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('GitHub CLI 安装失败', {
        description: 'network failed',
      });
    });
    expect(
      screen.getByRole('button', { name: '安装 GitHub CLI' })
    ).toBeEnabled();
  });

  it('keeps commit reminder options visible but disabled when reminders are off', async () => {
    const user = userEvent.setup();
    render(<VersionControlSettings />);

    expect(
      screen.getByText(
        '检测未提交更改数量并通过设置-快捷指令中的 #commit_changes 发送提醒'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText('提交指令')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '提醒方式' })).toHaveValue(
      'smart'
    );

    await user.click(screen.getByRole('switch', { name: '启用提交提醒' }));

    expect(screen.getByRole('combobox', { name: '提醒方式' })).toBeDisabled();
    expect(
      screen.getByRole('spinbutton', { name: '更改行数边界' })
    ).toBeDisabled();

    await user.click(screen.getAllByRole('button', { name: '保存' }).at(-1)!);

    await waitFor(() => {
      expect(mocks.updateAndSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ commit_reminder_enabled: false })
      );
      // 版本管理页只提交本页字段，绝不带出已迁移到工作树页的全局设置。
      expect(mocks.updateAndSaveConfig).not.toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_dir: expect.anything(),
          git_branch_prefix: expect.anything(),
        })
      );
    });
  });

  it('lists enabled Agents for PR description generation', async () => {
    render(<VersionControlSettings />);

    await waitFor(() => {
      expect(agentManagementApiMock.bar).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByRole('combobox', { name: 'Agent' })).not.toBeDisabled();
  });

  it('persists the reminder mode and changed-line threshold', async () => {
    const user = userEvent.setup();
    render(<VersionControlSettings />);

    await user.selectOptions(
      screen.getByRole('combobox', { name: '提醒方式' }),
      'separate_turn'
    );
    const threshold = screen.getByRole('spinbutton', {
      name: '更改行数边界',
    });
    await user.clear(threshold);
    await user.type(threshold, '2500');
    await user.click(screen.getAllByRole('button', { name: '保存' }).at(-1)!);

    await waitFor(() => {
      expect(mocks.updateAndSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          commit_reminder_mode: 'separate_turn',
          commit_reminder_line_threshold: 2500,
        })
      );
    });
  });
});
