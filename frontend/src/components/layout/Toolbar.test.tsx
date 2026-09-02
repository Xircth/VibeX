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
import { KanbanLayoutToggles, WorkspaceBranchControls } from './Toolbar';

vi.mock('@/components/layout/ProjectRailToggleButton', () => ({
  ProjectRailToggleButton: () => <button type="button">Projects</button>,
}));

vi.mock('@/components/layout/WorktreeSelector', () => ({
  WorktreeSelector: () => <button type="button">Select workspace</button>,
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

describe('BranchStatusBadge', () => {
  it('matches the neighboring workspace selector geometry and spacing', () => {
    render(
      <TooltipProvider>
        <WorkspaceBranchControls
          isWorkspaceTab={true}
          workspaceId="workspace-1"
        />
      </TooltipProvider>
    );

    expect(
      screen.getByRole('group', { name: 'Workspace and target branches' })
    ).toHaveClass('gap-2');
    const badge = screen.getByText('main').closest('div');
    expect(badge).toHaveClass('raised-control', 'h-7', 'gap-1', 'rounded-lg');
    expect(badge).not.toHaveClass('ml-2');
    expect(badge).not.toHaveClass('border');
  });
});

describe('KanbanLayoutToggles', () => {
  beforeEach(() => {
    useLayoutStore.getState().resetLayout();
    resetKanbanBoardStyle();
    resetKanbanCanvasListVisible();
  });

  it('toggles session list, monitor, and execution visibility', async () => {
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

describe('WorkspaceBranchControls canvas list toggle', () => {
  beforeEach(() => {
    resetKanbanBoardStyle();
    resetKanbanCanvasListVisible();
  });

  it('places the session-list button after the project rail in canvas mode', async () => {
    const user = userEvent.setup();
    setKanbanBoardStyle('canvas');

    render(
      <TooltipProvider>
        <WorkspaceBranchControls isWorkspaceTab={false} />
      </TooltipProvider>
    );

    const group = screen.getByRole('group', {
      name: 'Workspace and target branches',
    });
    const buttons = group.querySelectorAll('button');
    expect(buttons[0]).toHaveTextContent('Projects');
    expect(buttons[1]).toHaveAttribute('aria-label', '隐藏会话列表');

    await user.click(buttons[1]);
    expect(screen.getByRole('button', { name: '显示会话列表' })).toBe(
      buttons[1]
    );
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
});
