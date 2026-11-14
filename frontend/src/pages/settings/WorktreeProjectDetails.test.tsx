import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { WorktreeProjectDetails } from './WorktreeProjectDetails';

const api = vi.hoisted(() => ({
  repos: vi.fn(),
  workspaces: vi.fn(),
  status: vi.fn(),
  retry: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  projectsApi: { getRepositories: api.repos },
  repoApi: { update: api.update },
  attemptsApi: {
    getProjectWorkspaces: api.workspaces,
    getInitialization: api.status,
    retryInitialization: api.retry,
    delete: api.remove,
    cancelInitialization: api.cancel,
  },
}));
vi.mock('@/components/dialogs/shared/ConfirmDialog', () => ({
  ConfirmDialog: { show: api.confirm },
}));

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  api.repos.mockResolvedValue([
    {
      id: 'repo',
      name: 'web',
      display_name: 'Web',
      default_working_dir: 'app',
      copy_files: '.env',
    },
  ]);
  api.workspaces.mockResolvedValue([
    {
      id: 'workspace',
      use_worktree: true,
      name: 'Feature',
      branch: 'feature',
      container_ref: '/managed/feature',
      setup_completed_at: null,
    },
    { id: 'root', use_worktree: false, name: 'Project root' },
  ]);
  api.status.mockResolvedValue({
    phase: 'failed',
    error: 'setup exited 7',
    active: false,
    logs: 'install failed',
  });
  api.confirm.mockResolvedValue('confirmed');
});

it('shows repository cwd, source file rules, failed output and explicit recovery', async () => {
  const user = userEvent.setup();
  render(<WorktreeProjectDetails projectId="project" />);
  expect(await screen.findByText('Feature')).toBeInTheDocument();
  expect(screen.queryByText('Project root')).not.toBeInTheDocument();
  expect(screen.getByText(/web\/app/)).toBeInTheDocument();
  expect(await screen.findByText('setup exited 7')).toBeInTheDocument();
  await user.click(screen.getByText('查看初始化输出'));
  expect(screen.getByText('install failed')).toBeVisible();
  await user.clear(screen.getByDisplayValue('.env'));
  await user.type(screen.getByLabelText('Web'), '.env.local');
  await user.tab();
  await waitFor(() =>
    expect(api.update).toHaveBeenCalledWith('repo', {
      copy_files: '.env.local',
    })
  );
  api.status.mockResolvedValue({
    phase: 'ready',
    error: null,
    active: false,
    logs: 'ready',
  });
  await user.click(screen.getByRole('button', { name: '重试初始化' }));
  await waitFor(() => expect(api.retry).toHaveBeenCalledWith('workspace'));
});

it('keeps a workspace visible after deletion fails', async () => {
  const user = userEvent.setup();
  api.remove.mockRejectedValue(new Error('stop the active turn first'));
  render(<WorktreeProjectDetails projectId="project" />);
  await user.click(await screen.findByRole('button', { name: '删除工作区' }));
  expect(
    await screen.findByText(/stop the active turn first/)
  ).toBeInTheDocument();
  expect(screen.getByText('Feature')).toBeInTheDocument();
});
