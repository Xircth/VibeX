import { fireEvent, render, screen } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from 'shared/types';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import DockviewWelcomePanel from './DockviewWelcomePanel';

const {
  activateExecutionSession,
  listDirectoryChildrenMock,
  navigateWithSearch,
  openDiffPreview,
  openFilePreview,
  openLocalAppWindow,
  openNewTerminal,
  openSettingsSurface,
  openWebPreview,
  requestCreateSession,
  setActiveWorktree,
  setRailVisible,
  showFileTree,
  switchProject,
  toggleFileTree,
  useAttemptMock,
  useAttemptRepoMock,
  useFileTreeStoreMock,
  useKanbanProjectSessionsMock,
  useProjectMock,
  useProjectReposMock,
  useProjectsMock,
  useTauriClient,
  useWorktreeMock,
} = vi.hoisted(() => ({
  activateExecutionSession: vi.fn(),
  listDirectoryChildrenMock: vi.fn(),
  navigateWithSearch: vi.fn(),
  openDiffPreview: vi.fn(),
  openFilePreview: vi.fn(),
  openLocalAppWindow: vi.fn(),
  openNewTerminal: vi.fn(),
  openSettingsSurface: vi.fn(),
  openWebPreview: vi.fn(),
  requestCreateSession: vi.fn(),
  setActiveWorktree: vi.fn(),
  setRailVisible: vi.fn(),
  showFileTree: vi.fn(),
  switchProject: vi.fn(),
  toggleFileTree: vi.fn(),
  useAttemptMock: vi.fn(),
  useAttemptRepoMock: vi.fn(),
  useFileTreeStoreMock: vi.fn(),
  useKanbanProjectSessionsMock: vi.fn(),
  useProjectMock: vi.fn(),
  useProjectReposMock: vi.fn(),
  useProjectsMock: vi.fn(),
  useTauriClient: vi.fn(() => true),
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

vi.mock('@/contexts/KanbanSessionContext', () => ({
  useKanbanSessionContext: () => ({
    activateExecutionSession,
  }),
  useOptionalKanbanSessionContext: () => null,
}));

vi.mock('@/stores/useFileTreeStore', () => ({
  useFileTreeStore: (
    selector?: (state: { rootPath: string | null }) => unknown
  ) => {
    const state = useFileTreeStoreMock();
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/stores/useWindowProjectsStore', () => ({
  useWindowProjectsStore: (
    selector: (state: { setRailVisible: (visible: boolean) => void }) => unknown
  ) => selector({ setRailVisible }),
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
  useOptionalProject: () => null,
}));

vi.mock('@/hooks/useProjectRepos', () => ({
  useProjectRepos: () => useProjectReposMock(),
}));

vi.mock('@/hooks', () => ({
  useProjectRepos: () => useProjectReposMock(),
}));

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => useProjectsMock(),
}));

vi.mock('@/hooks/useKanbanProjectSessions', () => ({
  useKanbanProjectSessions: () => useKanbanProjectSessionsMock(),
}));

vi.mock('@/hooks/useProjectSwitcher', () => ({
  useProjectSwitcher: () => switchProject,
}));

vi.mock('@/hooks/useNavigateWithSearch', () => ({
  useNavigateWithSearch: () => navigateWithSearch,
}));

vi.mock('@/lib/api', () => ({
  fileTreeApi: {
    listDirectoryChildren: listDirectoryChildrenMock,
  },
  projectsApi: { create: vi.fn(), delete: vi.fn() },
  openSettingsSurface: (...args: unknown[]) => openSettingsSurface(...args),
}));

vi.mock('@/lib/api/appWindow', () => ({
  openLocalAppWindow,
}));

vi.mock('@/lib/desktopShell', () => ({
  useTauriClient,
}));

vi.mock('@/lib/requestCreateSession', () => ({
  requestCreateSessionInExecutionArea: (...args: unknown[]) =>
    requestCreateSession(...args),
}));

vi.mock('@/components/dialogs/projects/ProjectFormDialog', () => ({
  ProjectFormDialog: { show: vi.fn() },
}));

vi.mock('@/components/dialogs/projects/CloneRepoDialog', () => ({
  CloneRepoDialog: { show: vi.fn() },
}));

vi.mock('@/components/dialogs/shared/ConfirmDialog', () => ({
  ConfirmDialog: { show: vi.fn() },
}));

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'workspace-1',
    project_id: 'project-1',
    task_id: 'task-1',
    parent_workspace_id: null,
    container_ref: '/repo',
    branch: 'main',
    use_worktree: false,
    agent_working_dir: null,
    setup_completed_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    archived: false,
    pinned: false,
    name: 'VibeX',
    ...overrides,
  };
}

function session(
  overrides: Partial<KanbanProjectSessionRecord> = {}
): KanbanProjectSessionRecord {
  const currentWorkspace = overrides.workspace ?? workspace();
  const id = overrides.id ?? 'session-1';
  return {
    id,
    placement: {
      sessionId: id,
      workspaceId: currentWorkspace.id,
    },
    workspace: currentWorkspace,
    task: null,
    taskId: currentWorkspace.task_id,
    name: '修复窗口选择器缩略图',
    status: 'todo',
    branch: currentWorkspace.branch,
    workspaceName: currentWorkspace.name ?? currentWorkspace.branch,
    workspaceDisplayLabel: `${currentWorkspace.name ?? currentWorkspace.branch} · ${currentWorkspace.branch}`,
    executor: 'grok',
    agentId: null,
    updatedAt: '2026-08-17T12:00:00Z',
    createdAt: '2026-08-17T10:00:00Z',
    firstPrompt: '修复窗口选择器缩略图',
    model: null,
    fullName: '修复窗口选择器缩略图',
    shortName: '修复窗口选择器缩略图',
    taskTitle: null,
    isCompleted: false,
    isRunning: false,
    isErrored: false,
    pinnedAt: null,
    ...overrides,
  };
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <DockviewWelcomePanel {...({} as IDockviewPanelProps)} />
    </MemoryRouter>
  );
}

describe('DockviewWelcomePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFileTreeStoreMock.mockReturnValue({ rootPath: '/repo' });
    useWorktreeMock.mockReturnValue({
      activeWorktreeId: 'workspace-1',
      setActiveWorktree,
    });
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
    useKanbanProjectSessionsMock.mockReturnValue({
      sessions: [
        session({ id: 'session-1', name: '修复窗口选择器缩略图' }),
        session({ id: 'session-2', name: '整理电脑控制设置文案' }),
        session({ id: 'session-3', name: '审阅 native capture 路径' }),
        session({ id: 'session-4', name: '把停止快捷键写进引导' }),
        session({ id: 'session-5', name: '不应出现的第五个会话' }),
      ],
      isLoading: false,
    });
    useProjectsMock.mockReturnValue({
      projects: [
        { id: 'p1', name: 'vibex-plugin-computer-use', is_git: true },
        { id: 'p2', name: 'VibeX', is_git: true },
        { id: 'p3', name: 'codeg', is_git: true },
        { id: 'p4', name: 'open-connector', is_git: false },
        { id: 'p5', name: '全局', is_home: true },
        { id: 'p6', name: '第六个项目' },
      ],
      isLoading: false,
    });
    useTauriClient.mockReturnValue(true);
    listDirectoryChildrenMock.mockResolvedValue({
      files: ['README.md', 'src/index.ts', 'package.json'],
      directories: ['src'],
      gitignored_files: [],
      gitignored_directories: [],
      truncated: false,
    });
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
  });

  it('renders continue sessions, start actions, projects, and recommended cards', () => {
    renderPanel();

    expect(
      screen.getByRole('heading', { name: '继续会话' })
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '开始' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '打开项目' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '推荐操作' })
    ).toBeInTheDocument();

    expect(
      screen.getByRole('button', { name: '新建会话' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '创建新项目' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '选择文件夹' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '克隆仓库' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '新建窗口' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '打开设置' })
    ).toBeInTheDocument();

    expect(screen.getByText('修复窗口选择器缩略图')).toBeInTheDocument();
    expect(screen.getByText('整理电脑控制设置文案')).toBeInTheDocument();
    expect(screen.queryByText('不应出现的第五个会话')).not.toBeInTheDocument();

    expect(screen.getByText('vibex-plugin-computer-use')).toBeInTheDocument();
    expect(screen.getByText('VibeX')).toBeInTheDocument();
    expect(screen.queryByText('第六个项目')).not.toBeInTheDocument();
    expect(screen.queryByText('/repo')).not.toBeInTheDocument();

    expect(
      screen.getByRole('button', { name: /打开终端/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /预览 Git Diffs/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /打开项目栏/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /打开 Agent 设置/ })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '去官网查看' })).toHaveAttribute(
      'href',
      'https://vibex.com/docs'
    );

    expect(
      screen.queryByRole('button', { name: /搜索项目/ })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('超级 Agent Coding 平台')
    ).not.toBeInTheDocument();
  });

  it('creates a session in the execution area from Start', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));

    expect(requestCreateSession).toHaveBeenCalledOnce();
  });

  it('opens a session from the continue list', () => {
    renderPanel();

    fireEvent.click(screen.getByText('修复窗口选择器缩略图'));

    expect(activateExecutionSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
    });
    expect(setActiveWorktree).toHaveBeenCalledWith('workspace-1', 'task-1');
    expect(navigateWithSearch).toHaveBeenCalledWith(
      '/local-projects/project-1/workspaces/workspace-1/sessions/session-1'
    );
  });

  it('opens settings, the project rail, terminal, diffs, and agent settings', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: '打开设置' }));
    fireEvent.click(screen.getByRole('button', { name: /打开项目栏/ }));
    fireEvent.click(screen.getByRole('button', { name: /打开终端/ }));
    fireEvent.click(screen.getByRole('button', { name: /预览 Git Diffs/ }));
    fireEvent.click(screen.getByRole('button', { name: /打开 Agent 设置/ }));

    expect(openSettingsSurface).toHaveBeenCalledTimes(2);
    expect(openSettingsSurface.mock.calls[0]?.[1]).toBeUndefined();
    expect(openSettingsSurface.mock.calls[1]?.[1]).toBe('/settings/agents');
    expect(setRailVisible).toHaveBeenCalledWith(true);
    expect(openNewTerminal).toHaveBeenCalledOnce();
    expect(openDiffPreview).toHaveBeenCalledOnce();
  });

  it('switches project from the imported project list', () => {
    renderPanel();

    fireEvent.click(screen.getByText('VibeX'));

    expect(switchProject).toHaveBeenCalledWith(
      'p2',
      '/local-projects/p2/sessions'
    );
  });

  it('shows the empty session copy when the project has no sessions', () => {
    useKanbanProjectSessionsMock.mockReturnValue({
      sessions: [],
      isLoading: false,
    });

    renderPanel();

    expect(
      screen.getByText('还没有会话。在「开始」里新建一个。')
    ).toBeInTheDocument();
  });

  it('hides new window on Web', () => {
    useTauriClient.mockReturnValue(false);

    renderPanel();

    expect(
      screen.queryByRole('button', { name: '新建窗口' })
    ).not.toBeInTheDocument();
  });
});
