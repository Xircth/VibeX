import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkspaceSessionListToolbar } from './WorkspaceSessionListToolbar';

const toolbarProps = {
  isArchiveView: false,
  isDeleteMode: false,
  selectedCount: 0,
  isDeletingSessions: false,
  searchQuery: '',
  sortSpecs: [],
  onArchiveViewChange: vi.fn(),
  onToggleDeleteMode: vi.fn(),
  onCancelDeleteMode: vi.fn(),
  onDeleteSelected: vi.fn(),
  onCreateSession: vi.fn(),
  onSearchQueryChange: vi.fn(),
  onToggleSortKey: vi.fn(),
  onClearSort: vi.fn(),
};

function renderToolbar(
  props: Partial<ComponentProps<typeof WorkspaceSessionListToolbar>> = {}
) {
  return render(
    <TooltipProvider>
      <WorkspaceSessionListToolbar {...toolbarProps} {...props} />
    </TooltipProvider>
  );
}

describe('WorkspaceSessionListToolbar', () => {
  it('renders action buttons without a session list title', () => {
    renderToolbar();

    expect(screen.queryByText('会话列表')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '新建会话' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '打开归档区' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '批量删除' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '排序' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '搜索会话' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: '搜索会话' })
    ).not.toBeInTheDocument();
    expect(
      screen
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['搜索会话', '新建会话', '打开归档区', '排序', '批量删除']);
  });

  it('expands the search button into a field and hides other actions', () => {
    renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '搜索会话' }));
    const search = screen.getByRole('textbox', { name: '搜索会话' });
    expect(search).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.queryByRole('button', { name: '搜索会话' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '新建会话' })
    ).not.toBeInTheDocument();

    fireEvent.blur(search);
    expect(
      screen.getByRole('button', { name: '搜索会话' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '新建会话' })
    ).toBeInTheDocument();
  });

  it('asks for confirmation by exposing selected delete once sessions are chosen', () => {
    const onDeleteSelected = vi.fn();
    renderToolbar({
      isDeleteMode: true,
      selectedCount: 2,
      onDeleteSelected,
    });

    fireEvent.click(screen.getByRole('button', { name: '删除选中' }));
    expect(onDeleteSelected).toHaveBeenCalledTimes(1);
  });
});
