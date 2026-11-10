import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import {
  resetKanbanBoardStyle,
  setKanbanBoardStyle,
} from '@/lib/kanbanBoardStyle';
import { resetKanbanCanvasListVisible } from '@/lib/kanbanCanvasListVisible';
import { useLayoutStore } from '@/stores/useLayoutStore';
import {
  KanbanLayoutToggles,
  WorkspaceBranchControls,
  WorkspaceLayoutToggles,
} from './Toolbar';

const projectMocks = vi.hoisted(() => ({ isGit: true }));
const panelActionMocks = vi.hoisted(() => ({
  toggleFileTree: vi.fn(),
  openNewTerminal: vi.fn(),
  isPanelOpen: () => false,
  openWelcomeTab: vi.fn(),
  toggleLeftSidebar: vi.fn(),
  isLeftSidebarVisible: vi.fn(() => true),
  toggleRightSidebar: vi.fn(),
  isRightSidebarVisible: vi.fn(() => true),
  hasRightSidebarPanels: vi.fn(() => false),
}));

vi.mock('@/components/layout/WorktreeSelector', () => ({
  WorktreeSelector: () => <button type="button">Select workspace</button>,
}));

vi.mock('@/contexts/ProjectContext', () => ({
  useProject: () => ({
    projectId: 'project-1',
    project: { id: 'project-1', name: 'Demo', is_git: projectMocks.isGit },
  }),
}));

vi.mock('@/contexts/KanbanSessionContext', () => ({
  useKanbanSessionContext: () => ({
    rightSession: null,
    monitorSessions: [],
  }),
}));

vi.mock('@/hooks/usePanelActions', () => ({
  usePanelActions: () => panelActionMocks,
}));

vi.mock('@/hooks/useWorkspaceBranchStatus', () => ({
  useWorkspaceBranchStatus: () => ({
    data: [
      {
        target_branch_name: 'main',
        commits_ahead: 0,
        commits_behind: 0,
        is_rebase_in_progress: false,
        conflicted_files: [],
      },
    ],
  }),
}));

describe('KanbanLayoutToggles', () => {
  beforeEach(() => {
    useLayoutStore.getState().resetLayout();
    resetKanbanBoardStyle();
    resetKanbanCanvasListVisible();
  });

  it('does not mark the monitor toggle as pressed while nothing is monitored', () => {
    setKanbanBoardStyle('fixed');
    render(
      <TooltipProvider>
        <KanbanLayoutToggles />
      </TooltipProvider>
    );

    expect(
      screen.getByRole('button', { name: '显示/隐藏会话监控区' })
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('toggles session list, monitor, and execution visibility', async () => {
    setKanbanBoardStyle('fixed');
    const user = userEvent.setup();

    render(
      <TooltipProvider>
        <KanbanLayoutToggles />
      </TooltipProvider>
    );

    await user.click(screen.getByRole('button', { name: '显示/隐藏会话列表' }));
    await user.click(
      screen.getByRole('button', { name: '显示/隐藏会话监控区' })
    );
    await user.click(
      screen.getByRole('button', { name: '显示/隐藏会话执行区' })
    );

    expect(useLayoutStore.getState().isKanbanListVisible).toBe(false);
    expect(useLayoutStore.getState().isKanbanMonitorVisible).toBe(false);
    expect(useLayoutStore.getState().isKanbanSessionVisible).toBe(false);

    await user.click(screen.getByRole('button', { name: '重置看板布局' }));

    expect(useLayoutStore.getState().isKanbanListVisible).toBe(true);
    expect(useLayoutStore.getState().isKanbanMonitorVisible).toBe(true);
    expect(useLayoutStore.getState().isKanbanSessionVisible).toBe(true);
  });

  it('hides zone toggles in infinite-canvas mode', () => {
    setKanbanBoardStyle('canvas');
    render(
      <TooltipProvider>
        <KanbanLayoutToggles />
      </TooltipProvider>
    );

    expect(
      screen.queryByRole('button', { name: '显示/隐藏会话列表' })
    ).not.toBeInTheDocument();
  });
});

describe('WorkspaceLayoutToggles', () => {
  beforeEach(() => {
    useLayoutStore.getState().resetLayout();
    panelActionMocks.openWelcomeTab.mockReset();
    panelActionMocks.toggleRightSidebar.mockReset();
    panelActionMocks.hasRightSidebarPanels.mockReturnValue(false);
    panelActionMocks.isRightSidebarVisible.mockReturnValue(true);
  });

  it('removes legacy workspace toggle buttons and renders only New Tab icon button and Reset Layout by default', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <WorkspaceLayoutToggles />
      </TooltipProvider>
    );

    expect(
      screen.queryByRole('button', { name: '显示/隐藏文件树' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '隐藏编辑区和终端区' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '显示/隐藏终端' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '显示/隐藏 AI 面板' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('toolbar-toggle-right-sidebar')
    ).not.toBeInTheDocument();

    const newTabButton = screen.getByTestId('toolbar-new-tab-button');
    expect(newTabButton).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '重置布局' })
    ).toBeInTheDocument();

    await user.click(newTabButton);
    expect(panelActionMocks.openWelcomeTab).toHaveBeenCalledTimes(1);
  });

  it('renders right sidebar toggle next to New Tab button when Zone A has panels on the right side', async () => {
    const user = userEvent.setup();
    panelActionMocks.hasRightSidebarPanels.mockReturnValue(true);
    panelActionMocks.isRightSidebarVisible.mockReturnValue(true);

    render(
      <TooltipProvider>
        <WorkspaceLayoutToggles />
      </TooltipProvider>
    );

    const rightSidebarToggle = screen.getByTestId(
      'toolbar-toggle-right-sidebar'
    );
    expect(rightSidebarToggle).toHaveAttribute('aria-pressed', 'true');

    await user.click(rightSidebarToggle);
    expect(panelActionMocks.toggleRightSidebar).toHaveBeenCalledTimes(1);
  });
});

describe('WorkspaceBranchControls host selector & canvas list toggle', () => {
  beforeEach(() => {
    projectMocks.isGit = true;
    panelActionMocks.toggleLeftSidebar.mockReset();
    panelActionMocks.isLeftSidebarVisible.mockReturnValue(true);
    resetKanbanBoardStyle();
    resetKanbanCanvasListVisible();
  });

  it('renders the top-left HostSelector and places the session-list button next to it in canvas mode', async () => {
    const user = userEvent.setup();
    setKanbanBoardStyle('canvas');

    render(
      <TooltipProvider>
        <WorkspaceBranchControls isWorkspaceTab={false} />
      </TooltipProvider>
    );

    const group = screen.getByRole('group', {
      name: '工作区与目标分支',
    });
    expect(screen.getByTestId('toolbar-host-selector')).toBeInTheDocument();
    const listToggle = screen.getByRole('button', { name: '隐藏会话列表' });
    expect(group).toContainElement(listToggle);
    expect(screen.queryByText('Projects')).not.toBeInTheDocument();

    await user.click(listToggle);
    expect(
      screen.getByRole('button', { name: '显示会话列表' })
    ).toBeInTheDocument();
  });

  it('keeps kanban layout toggles out of the leading cluster', () => {
    render(
      <TooltipProvider>
        <WorkspaceBranchControls isWorkspaceTab={false} />
      </TooltipProvider>
    );

    expect(screen.queryByText('Projects')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '显示/隐藏会话列表' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('toolbar-toggle-left-sidebar')
    ).not.toBeInTheDocument();
  });

  it('renders the left sidebar toggle button to the right of HostSelector on the workspace tab', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <WorkspaceBranchControls isWorkspaceTab={true} />
      </TooltipProvider>
    );

    expect(
      screen.queryByRole('button', { name: '显示/隐藏文件树' })
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('toolbar-host-selector')).toBeInTheDocument();
    const leftSidebarToggle = screen.getByTestId(
      'toolbar-toggle-left-sidebar'
    );
    expect(leftSidebarToggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Select workspace')).not.toBeInTheDocument();

    await user.click(leftSidebarToggle);
    expect(panelActionMocks.toggleLeftSidebar).toHaveBeenCalledTimes(1);
  });

  it('does not show the canvas list toggle on the workspace tab', () => {
    setKanbanBoardStyle('canvas');
    render(
      <TooltipProvider>
        <WorkspaceBranchControls
          isWorkspaceTab={true}
          workspaceId="workspace-1"
        />
      </TooltipProvider>
    );

    expect(
      screen.queryByRole('button', { name: '隐藏会话列表' })
    ).not.toBeInTheDocument();
  });

  it('keeps HostSelector visible and hides global worktree/branch controls on any project', () => {
    projectMocks.isGit = false;

    render(
      <TooltipProvider>
        <WorkspaceBranchControls
          isWorkspaceTab={true}
          workspaceId="workspace-1"
        />
      </TooltipProvider>
    );

    expect(screen.getByTestId('toolbar-host-selector')).toBeInTheDocument();
    expect(screen.queryByText('Select workspace')).not.toBeInTheDocument();
    expect(screen.queryByText('main')).not.toBeInTheDocument();
  });
});

describe('Toolbar chrome layout', () => {
  it('centers the workspace tabs on the window and keeps layout toggles trailing', () => {
    const source = readFileSync(resolve(__dirname, './Toolbar.tsx'), 'utf8');
    expect(source).toContain(
      'absolute inset-0 z-20 flex items-center justify-center'
    );
    expect(source).toContain('WindowChromeLeadingRule');

    const trailing = source.slice(source.indexOf('ml-auto'));
    expect(trailing).toContain('<KanbanLayoutToggles');
    expect(trailing).toContain('<WorkspaceLayoutToggles');
    expect(trailing).not.toMatch(/<ProjectRailToggleButton/);
    expect(source).not.toMatch(/<ProjectRailToggleButton/);
    expect(source.slice(0, source.indexOf('ml-auto'))).not.toMatch(
      /<KanbanLayoutToggles/
    );
  });

  it('places the app logo on the leading edge on Windows and Linux, trailing on macOS', () => {
    const source = readFileSync(resolve(__dirname, './Toolbar.tsx'), 'utf8');
    expect(source).toContain('logoLeadsWindowChrome');

    const leading = source.slice(0, source.indexOf('ml-auto'));
    const trailing = source.slice(source.indexOf('ml-auto'));
    expect(leading).toContain('<HomeLogoMenu');
    expect(trailing).toContain('<HomeLogoMenu');
    expect(leading).toContain('align="start"');
    expect(trailing).toContain('align="end"');
    expect(source).not.toMatch(
      /<HomeLogoMenu align="start" \/>\s*<ToolbarDivider \/>/
    );
  });
});
