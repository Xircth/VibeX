import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DockviewWelcomePanel from './DockviewWelcomePanel';

const {
  listDirectoryChildrenMock,
  openDiffPreview,
  openFilePreview,
  openNewTerminal,
  openWebPreview,
  showFileTree,
  toggleFileTree,
  useAttemptMock,
  useAttemptRepoMock,
  useFileTreeStoreMock,
  useProjectMock,
  useProjectReposMock,
  useWorktreeMock,
} = vi.hoisted(() => ({
  listDirectoryChildrenMock: vi.fn(),
  openDiffPreview: vi.fn(),
  openFilePreview: vi.fn(),
  openNewTerminal: vi.fn(),
  openWebPreview: vi.fn(),
  showFileTree: vi.fn(),
  toggleFileTree: vi.fn(),
  useAttemptMock: vi.fn(),
  useAttemptRepoMock: vi.fn(),
  useFileTreeStoreMock: vi.fn(),
  useProjectMock: vi.fn(),
  useProjectReposMock: vi.fn(),
  useWorktreeMock: vi.fn(),
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  usePanelActionsContext: () => ({
    openDiffPreview,
    openFilePreview,
    openNewTerminal,
    openWebPreview,
    showFileTree,
    toggleFileTree,
  }),
}));

vi.mock('@/stores/useFileTreeStore', () => ({
  useFileTreeStore: (
    selector?: (state: { rootPath: string | null }) => unknown
  ) => {
    const state = useFileTreeStoreMock();
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/contexts/WorktreeContext', () => ({
  useWorktree: () => useWorktreeMock(),
}));

vi.mock('@/hooks/useAttempt', () => ({
  useAttempt: () => useAttemptMock(),
}));

vi.mock('@/hooks/useAttemptRepo', () => ({
  useAttemptRepo: () => useAttemptRepoMock(),
}));

vi.mock('@/contexts/ProjectContext', () => ({
  useProject: () => useProjectMock(),
}));

vi.mock('@/hooks/useProjectRepos', () => ({
  useProjectRepos: () => useProjectReposMock(),
}));

vi.mock('@/lib/api', () => ({
  fileTreeApi: {
    listDirectoryChildren: listDirectoryChildrenMock,
  },
}));

function renderPanel() {
  return render(<DockviewWelcomePanel {...({} as IDockviewPanelProps)} />);
}

describe('DockviewWelcomePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFileTreeStoreMock.mockReturnValue({ rootPath: '/repo' });
    useWorktreeMock.mockReturnValue({ activeWorktreeId: 'workspace-1' });
    useAttemptMock.mockReturnValue({
      data: {
        container_ref: '/repo',
        use_worktree: false,
        agent_working_dir: null,
      },
    });
    useAttemptRepoMock.mockReturnValue({ repos: [] });
    useProjectMock.mockReturnValue({ projectId: 'project-1' });
    useProjectReposMock.mockReturnValue({
      data: [{ path: '/repo' }],
    });
    listDirectoryChildrenMock.mockResolvedValue({
      files: ['README.md', 'src/index.ts', 'package.json'],
      directories: ['src'],
      gitignored_files: [],
      gitignored_directories: [],
      truncated: false,
    });
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the start-work copy and the four workspace entries', () => {
    renderPanel();

    expect(
      screen.getByRole('heading', { name: '开始你的工作' })
    ).toBeInTheDocument();
    expect(
      screen.getByText('在此打开文件编辑预览、浏览器、终端、Git Diff 面板等')
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /浏览文件/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /查看差异/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /打开终端/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /打开浏览器/ })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /搜索项目/ })
    ).not.toBeInTheDocument();
  });

  it('opens the file tree without toggling it closed and previews a root file', async () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /浏览文件/ }));

    expect(showFileTree).toHaveBeenCalledOnce();
    expect(toggleFileTree).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(listDirectoryChildrenMock).toHaveBeenCalledWith('/repo', '');
    });
    expect(openFilePreview).toHaveBeenCalledWith('/repo/README.md');
  });

  it('still opens the file tree when the project root has no previewable file', async () => {
    listDirectoryChildrenMock.mockResolvedValue({
      files: ['src/index.ts', '.gitignore'],
      directories: ['src'],
      gitignored_files: ['.gitignore'],
      gitignored_directories: [],
      truncated: false,
    });

    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /浏览文件/ }));

    await waitFor(() => {
      expect(listDirectoryChildrenMock).toHaveBeenCalled();
    });
    expect(showFileTree).toHaveBeenCalledOnce();
    expect(openFilePreview).not.toHaveBeenCalled();
  });

  it('opens diffs, terminal, and browser from the remaining entries', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /查看差异/ }));
    fireEvent.click(screen.getByRole('button', { name: /打开终端/ }));
    fireEvent.click(screen.getByRole('button', { name: /打开浏览器/ }));

    expect(openDiffPreview).toHaveBeenCalledOnce();
    expect(openNewTerminal).toHaveBeenCalledOnce();
    expect(openWebPreview).toHaveBeenCalledOnce();
  });
});
