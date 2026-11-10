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
  it('renders an always-visible search input, utility buttons, and 3 vertical quick-action rows', () => {
    const onCreateSession = vi.fn();
    const onToggleViewMode = vi.fn();
    const { container } = renderToolbar({
      viewMode: 'workspace',
      onCreateSession,
      onToggleViewMode,
    });

    expect(screen.queryByText('会话列表')).not.toBeInTheDocument();
    expect(screen.queryByText('归档区')).not.toBeInTheDocument();
    const root = container.firstElementChild;
    expect(root).toHaveClass('border-b', 'border-border/60');

    expect(
      screen.getByRole('textbox', { name: '搜索会话' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '打开归档区' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '排序' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '批量删除' })
    ).toBeInTheDocument();

    const newSessionBtn = screen.getByRole('button', { name: '新建会话' });
    const switchViewBtn = screen.getByRole('button', {
      name: '切换视图（工作区/状态视图）',
    });
    const mobileAppBtn = screen.getByRole('button', { name: '移动端APP' });

    expect(newSessionBtn).toHaveTextContent('新会话');
    expect(switchViewBtn).toHaveTextContent('切换视图');
    expect(switchViewBtn).toHaveTextContent('工作区');
    expect(mobileAppBtn).toHaveTextContent('移动端APP');
    expect(mobileAppBtn).toHaveTextContent('Beta');

    fireEvent.click(newSessionBtn);
    expect(onCreateSession).toHaveBeenCalledTimes(1);

    fireEvent.click(switchViewBtn);
    expect(onToggleViewMode).toHaveBeenCalledTimes(1);
  });

  it('updates the search query and reveals the clear button when text is entered', () => {
    const onSearchQueryChange = vi.fn();
    renderToolbar({
      searchQuery: 'login',
      onSearchQueryChange,
    });

    const search = screen.getByRole('textbox', { name: '搜索会话' });
    expect(search).toHaveValue('login');

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onSearchQueryChange).toHaveBeenCalledWith('');
  });

  it('replaces the search and quick-action area with the delete confirmation bar in delete mode', () => {
    const onDeleteSelected = vi.fn();
    const onCancelDeleteMode = vi.fn();
    renderToolbar({
      isDeleteMode: true,
      selectedCount: 0,
      onDeleteSelected,
      onCancelDeleteMode,
    });

    expect(screen.getByText('选择会话')).toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: '搜索会话' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('session-list-quick-actions')
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancelDeleteMode).toHaveBeenCalledTimes(1);
  });

  it('asks for confirmation by exposing selected delete once sessions are chosen', () => {
    const onDeleteSelected = vi.fn();
    renderToolbar({
      isDeleteMode: true,
      selectedCount: 2,
      onDeleteSelected,
    });

    expect(screen.queryByText('选择会话')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除选中' }));
    expect(onDeleteSelected).toHaveBeenCalledTimes(1);
  });
});

