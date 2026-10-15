import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DockviewNotesPanel from './DockviewNotesPanel';

vi.mock('@/contexts/WorktreeContext', () => ({
  useWorktree: () => ({ activeWorktreeId: 'wt-1' }),
}));

vi.mock('@/hooks/useWorkspaceNotes', () => ({
  useWorkspaceNotes: () => ({
    content: '已有笔记',
    setContent: vi.fn(),
    isLoading: false,
  }),
}));

vi.mock('@/components/context-menu', () => ({
  useAppContextMenu: () => ({ openSurfaceMenu: vi.fn() }),
}));

describe('DockviewNotesPanel', () => {
  it('uses the project language for the empty-note placeholder', () => {
    render(<DockviewNotesPanel {...({} as never)} />);
    expect(
      screen.getByPlaceholderText('在这里记录工作区笔记')
    ).toBeInTheDocument();
  });
});
