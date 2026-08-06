import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkspaceBranchControls } from './Toolbar';

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
