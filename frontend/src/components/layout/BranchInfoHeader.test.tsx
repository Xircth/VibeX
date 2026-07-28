import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { BranchInfoHeader } from './BranchInfoHeader';

const legacyStyles = readFileSync(
  resolve(process.cwd(), 'src/styles/legacy/index.css'),
  'utf8'
);

vi.mock('liquid-glass-react', () => ({
  default: ({
    children,
    cornerRadius,
    mode,
  }: {
    children: ReactNode;
    cornerRadius?: number;
    mode?: string;
  }) => (
    <div
      data-testid="liquid-glass"
      data-corner-radius={cornerRadius}
      data-mode={mode}
    >
      {children}
    </div>
  ),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock('@/contexts/WorktreeContext', () => ({
  useWorktree: () => ({ activeWorktreeId: 'workspace-1' }),
}));

vi.mock('@/contexts/KanbanSessionContext', () => ({
  useKanbanSessionContext: () => ({ visibleRightSession: null }),
}));

vi.mock('@/hooks/useWorkspaceBranchStatus', () => ({
  useWorkspaceBranchStatus: () => ({
    data: [
      {
        repo_id: 'repo-1',
        repo_name: 'VibeX',
        target_branch_name: 'main',
        commits_ahead: 2,
        commits_behind: 0,
        is_rebase_in_progress: false,
      },
    ],
  }),
}));

vi.mock('@/hooks/useTaskAttempt', () => ({
  useTaskAttempt: () => ({
    data: {
      task_id: 'task-1',
      use_worktree: true,
      branch: 'feature/liquid-toolbar',
    },
  }),
}));

vi.mock('@/hooks/useTask', () => ({
  useTask: () => ({
    data: {
      id: 'task-1',
      status: 'inprogress',
    },
  }),
}));

vi.mock('@/hooks/useRepoBranches', () => ({
  useRepoBranches: () => ({ data: [] }),
}));

vi.mock('@/hooks/useChangeTargetBranch', () => ({
  useChangeTargetBranch: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
}));

describe('BranchInfoHeader', () => {
  it('keeps the Git workspace controls in a rounded liquid-glass toolbar', () => {
    render(<BranchInfoHeader />);

    const toolbar = screen.getByRole('toolbar', {
      name: 'Git workspace controls',
    });
    const glass = screen.getByTestId('liquid-glass');

    expect(glass).toHaveAttribute('data-corner-radius', '12');
    expect(glass).toHaveAttribute('data-mode', 'prominent');
    expect(glass).toContainElement(toolbar);
    expect(screen.getByRole('button', { name: 'Git Actions' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Rebase' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Rebase Back' })).toBeVisible();
    expect(screen.getByText('目标')).toBeVisible();
    expect(screen.getByText('main')).toBeVisible();
    expect(screen.getByText('当前')).toBeVisible();
    expect(screen.getByText('feature/liquid-toolbar')).toBeVisible();
  });

  it('uses compact typography for the context labels only', () => {
    const contextLabelRule =
      legacyStyles.match(/\.branch-info-context-label\s*\{[^}]+\}/u)?.[0] ?? '';

    expect(contextLabelRule).not.toBe('');

    render(
      <>
        <style>{contextLabelRule}</style>
        <span className="branch-info-context-label" data-testid="context-label">
          目标
        </span>
      </>
    );

    expect(getComputedStyle(screen.getByTestId('context-label')).fontSize).toBe(
      '0.6875rem'
    );
  });

  it('reserves scrollable clearance below the floating toolbar', () => {
    const clearanceRule =
      legacyStyles.match(
        /\.branch-info-header-host\s*\+\s*\.right-panel-conversation-region\s*\[data-panel='conversation-logs'\]\s*\{[^}]+\}/u
      )?.[0] ?? '';

    expect(clearanceRule).not.toBe('');

    render(
      <div className="legacy-design">
        <style>{clearanceRule}</style>
        <div className="branch-info-header-host" />
        <div className="right-panel-conversation-region">
          <div
            data-testid="conversation-viewport"
            data-panel="conversation-logs"
            className="h-full overflow-y-auto px-2 py-3"
            style={{ overflowY: 'auto' }}
          >
            First user message
          </div>
        </div>
      </div>
    );

    const viewport = screen.getByTestId('conversation-viewport');

    expect(getComputedStyle(viewport).overflowY).toBe('auto');
    expect(getComputedStyle(viewport).paddingTop).toBe('44px');
  });
});
