import type { ComponentProps } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { setHideBotSessions } from '@/lib/hideBotSessions';
import {
  getHideBotSessions,
  getHideDefaultWorkspace,
  getHideInactiveSessions,
  resetHideDefaultWorkspace,
  resetHideInactiveSessions,
} from '@/lib/sessionListFilters';
import { WorkspaceSessionListToolbar } from './WorkspaceSessionListToolbar';
import { resetKanbanSessionListView } from '@/lib/kanbanSessionListView';
import {
  getSessionListAppearance,
  setSessionListAppearance,
} from '@/lib/sessionListAppearance';

vi.mock('@/lib/frontendPreferences', () => ({
  persistFrontendPreference: vi.fn(),
}));

const toolbarProps = {
  isArchiveView: false,
  isDeleteMode: false,
  selectedCount: 0,
  isDeletingSessions: false,
  sortSpecs: [],
  onArchiveViewChange: vi.fn(),
  onToggleDeleteMode: vi.fn(),
  onCancelDeleteMode: vi.fn(),
  onDeleteSelected: vi.fn(),
  onCreateSession: vi.fn(),
  onOpenSearch: vi.fn(),
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

function openRadixDropdown(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
}

describe('WorkspaceSessionListToolbar', () => {
  beforeEach(() => {
    resetKanbanSessionListView();
    setSessionListAppearance('compact');
    resetHideDefaultWorkspace();
    resetHideInactiveSessions();
    setHideBotSessions(false);
  });

  it('keeps search and creation visible and moves view selection into More Options', () => {
    const onOpenSearch = vi.fn();
    const onCreateSession = vi.fn();
    const { container } = renderToolbar({
      viewMode: 'workspace',
      onOpenSearch,
      onCreateSession,
    });

    const root = container.firstElementChild;
    expect(root).toHaveClass('border-b', 'border-border/60');

    expect(
      screen.queryByRole('textbox', { name: '搜索会话' })
    ).not.toBeInTheDocument();

    const searchBtn = screen.getByRole('button', { name: '搜索会话' });
    expect(searchBtn).toHaveTextContent('搜索');
    expect(searchBtn).toHaveClass(
      'text-[12px]',
      'h-7',
      'hover:bg-foreground/[0.06]'
    );
    expect(searchBtn).not.toHaveClass('bg-foreground/[0.06]');

    expect(
      screen.getByRole('button', { name: '更多选项' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '打开归档区' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '排序' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '批量删除' })
    ).not.toBeInTheDocument();

    const newSessionBtn = screen.getByRole('button', { name: '新建会话' });
    expect(
      screen.queryByRole('button', { name: '切换视图' })
    ).not.toBeInTheDocument();
    const mobileAppBtn = screen.getByRole('button', { name: '移动端APP' });

    expect(newSessionBtn).toHaveTextContent('新会话');
    expect(newSessionBtn).toHaveClass(
      'text-[12px]',
      'h-7',
      'hover:bg-foreground/[0.06]'
    );
    expect(screen.getByTestId('new-session-icon')).toHaveClass(
      'lucide-message-square-plus'
    );

    expect(mobileAppBtn).toHaveTextContent('移动端APP');
    expect(mobileAppBtn).toHaveTextContent('Beta');
    expect(mobileAppBtn).toHaveClass('text-[12px]', 'h-7');

    fireEvent.click(searchBtn);
    expect(onOpenSearch).toHaveBeenCalledTimes(1);

    fireEvent.click(newSessionBtn);
    expect(onCreateSession).toHaveBeenCalledTimes(1);
  });

  it('offers three mutually exclusive views in More Options', async () => {
    renderToolbar();
    openRadixDropdown(screen.getByRole('button', { name: '更多选项' }));
    fireEvent.keyDown(screen.getByRole('menuitem', { name: /切换视图/ }), {
      key: 'ArrowRight',
    });
    expect(
      await screen.findByRole('menuitemradio', { name: '状态分组视图' })
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByRole('menuitemradio', { name: '工作区分组视图' })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitemradio', { name: '混合视图' }));
    openRadixDropdown(screen.getByRole('button', { name: '更多选项' }));
    fireEvent.keyDown(screen.getByRole('menuitem', { name: /切换视图/ }), {
      key: 'ArrowRight',
    });
    expect(
      await screen.findByRole('menuitemradio', { name: '混合视图' })
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('selects and persists the full session component style from More Options', async () => {
    renderToolbar();
    openRadixDropdown(screen.getByRole('button', { name: '更多选项' }));
    fireEvent.keyDown(screen.getByRole('menuitem', { name: '会话组件样式' }), {
      key: 'ArrowRight',
    });
    expect(
      await screen.findByRole('menuitemradio', { name: '精简版' })
    ).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: '完整版' }));
    expect(getSessionListAppearance()).toBe('full');
    openRadixDropdown(screen.getByRole('button', { name: '更多选项' }));
    fireEvent.keyDown(screen.getByRole('menuitem', { name: '会话组件样式' }), {
      key: 'ArrowRight',
    });
    expect(
      await screen.findByRole('menuitemradio', { name: '完整版' })
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('exposes archive, sort, bulk delete, and the 3 filter switches inside More Options', async () => {
    const onArchiveViewChange = vi.fn();
    const onToggleDeleteMode = vi.fn();
    renderToolbar({
      onArchiveViewChange,
      onToggleDeleteMode,
    });

    const moreBtn = screen.getByRole('button', { name: '更多选项' });
    openRadixDropdown(moreBtn);

    const archiveItem = await screen.findByRole('menuitem', {
      name: '打开归档区',
    });
    expect(screen.getByRole('menuitem', { name: /排序/ })).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: '批量删除' })
    ).toBeInTheDocument();
    const filterSubTrigger = screen.getByRole('menuitem', { name: /筛选/ });
    expect(filterSubTrigger).toBeInTheDocument();

    fireEvent.keyDown(filterSubTrigger, { key: 'ArrowRight' });

    const hideDefaultSwitch = await screen.findByRole('switch', {
      name: '隐藏默认工作区',
    });
    const hideBotSwitch = screen.getByRole('switch', {
      name: '隐藏Bot会话',
    });
    const hideInactiveSwitch = screen.getByRole('switch', {
      name: '隐藏长期(7天)不活跃会话',
    });

    expect(hideDefaultSwitch).toHaveAttribute('aria-checked', 'false');
    expect(hideBotSwitch).toHaveAttribute('aria-checked', 'false');
    expect(hideInactiveSwitch).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(hideDefaultSwitch);
    expect(getHideDefaultWorkspace()).toBe(true);

    fireEvent.click(hideBotSwitch);
    expect(getHideBotSessions()).toBe(true);

    fireEvent.click(hideInactiveSwitch);
    expect(getHideInactiveSessions()).toBe(true);

    fireEvent.click(archiveItem);
    await waitFor(() => {
      expect(onArchiveViewChange).toHaveBeenCalledWith(true);
    });
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
      screen.queryByRole('button', { name: '搜索会话' })
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
