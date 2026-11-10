import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import {
  getDefaultActivityRailPanelId,
  resetActivityRailOrder,
} from '@/lib/activityRailOrder';
import { ShellNavPanelDragHandle } from './ShellNavPanelDragHandle';
import { WorkspaceActivityRail } from './WorkspaceActivityRail';

const mocks = vi.hoisted(() => ({
  toggleFileTree: vi.fn(),
  toggleGitPanel: vi.fn(),
  toggleSearchPanel: vi.fn(),
  toggleSessionList: vi.fn(),
  toggleBotsPanel: vi.fn(),
  placeLeftDockPanel: vi.fn(),
  swapLeftDockPanels: vi.fn(),
  resolveShellNavDropTarget: vi.fn(),
  measureShellNavPanels: vi.fn(),
  persistFrontendPreference: vi.fn(),
}));

vi.mock('@/lib/frontendPreferences', () => ({
  persistFrontendPreference: mocks.persistFrontendPreference,
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  usePanelActionsContext: () => ({
    toggleFileTree: mocks.toggleFileTree,
    toggleGitPanel: mocks.toggleGitPanel,
    toggleSearchPanel: mocks.toggleSearchPanel,
    toggleSessionList: mocks.toggleSessionList,
    toggleBotsPanel: mocks.toggleBotsPanel,
    placeLeftDockPanel: mocks.placeLeftDockPanel,
    swapLeftDockPanels: mocks.swapLeftDockPanels,
    resolveShellNavDropTarget: mocks.resolveShellNavDropTarget,
    measureShellNavPanels: mocks.measureShellNavPanels,
    measureLeftDock: () => null,
    isLeftDockSplit: () => false,
    unsplitLeftDock: vi.fn(),
    isPanelOpen: (panelId: string) => panelId === PANEL_IDS.FILE_TREE,
  }),
}));

describe('WorkspaceActivityRail', () => {
  beforeEach(() => {
    resetActivityRailOrder();
    mocks.toggleFileTree.mockReset();
    mocks.toggleGitPanel.mockReset();
    mocks.toggleSearchPanel.mockReset();
    mocks.toggleSessionList.mockReset();
    mocks.toggleBotsPanel.mockReset();
    mocks.placeLeftDockPanel.mockReset();
    mocks.swapLeftDockPanels.mockReset();
    mocks.resolveShellNavDropTarget.mockReset();
    mocks.measureShellNavPanels.mockReset();
    mocks.measureShellNavPanels.mockReturnValue([]);
    mocks.resolveShellNavDropTarget.mockReturnValue(null);
    mocks.persistFrontendPreference.mockReset();
  });

  it('renders the workspace panels in default order', () => {
    render(
      <WorkspaceActivityRail isEditorAreaVisible onToggleEditorArea={vi.fn()} />
    );

    expect(screen.getByRole('navigation')).toHaveClass('workspace-chrome');
    expect(
      screen
        .getAllByRole('button')
        .filter((button) => button.getAttribute('aria-label'))
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['文件', 'Git', '会话列表', 'Bot 助手']);
    expect(
      screen.queryByRole('button', { name: '取消分割' })
    ).not.toBeInTheDocument();
  });

  it('opens a panel on click without requiring a drag', () => {
    render(
      <WorkspaceActivityRail isEditorAreaVisible onToggleEditorArea={vi.fn()} />
    );

    fireEvent.click(screen.getByRole('button', { name: '会话列表' }));
    expect(mocks.toggleSessionList).toHaveBeenCalledOnce();
  });

  it('nudges an icon with Alt+Arrow and makes it the default panel', () => {
    render(
      <WorkspaceActivityRail isEditorAreaVisible onToggleEditorArea={vi.fn()} />
    );

    fireEvent.keyDown(screen.getByRole('button', { name: '会话列表' }), {
      key: 'ArrowUp',
      altKey: true,
    });
    fireEvent.keyDown(screen.getByRole('button', { name: '会话列表' }), {
      key: 'ArrowUp',
      altKey: true,
    });
    fireEvent.keyDown(screen.getByRole('button', { name: '会话列表' }), {
      key: 'ArrowUp',
      altKey: true,
    });

    expect(
      screen
        .getAllByRole('button')
        .filter((button) => button.getAttribute('aria-label'))
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['会话列表', '文件', 'Git', 'Bot 助手']);
    expect(getDefaultActivityRailPanelId()).toBe(PANEL_IDS.SESSION_LIST);
  });

  it('renders only the usage view switcher when mode is kanban', () => {
    render(
      <WorkspaceActivityRail
        isEditorAreaVisible={false}
        onToggleEditorArea={vi.fn()}
        mode="kanban"
      />
    );

    expect(
      screen
        .getAllByRole('button')
        .filter((button) => button.getAttribute('aria-label'))
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['计量统计']);
  });

  it('drags a Zone A panel handle with floating + ghost preview and auto-swaps on >50% overlap', () => {
    const fileTreeBox = { x: 40, y: 80, width: 200, height: 600 };
    const sessionListBox = { x: 240, y: 80, width: 280, height: 600 };
    mocks.measureShellNavPanels.mockReturnValue([
      { panelId: PANEL_IDS.FILE_TREE, side: 'left', box: fileTreeBox },
      { panelId: PANEL_IDS.SESSION_LIST, side: 'left', box: sessionListBox },
    ]);
    mocks.swapLeftDockPanels.mockReturnValue(true);

    render(<ShellNavPanelDragHandle panelId={PANEL_IDS.FILE_TREE} />);

    const handle = screen.getByTestId(
      `shell-nav-drag-handle-${PANEL_IDS.FILE_TREE}`
    );
    fireEvent.pointerDown(handle, { button: 0, clientX: 220, clientY: 95 });

    // Move 60px right (30% overlap -> shows swap ghost preview, no auto-swap yet)
    fireEvent.pointerMove(window, { clientX: 280, clientY: 95 });
    expect(
      screen.getByTestId(`shell-nav-floating-preview-${PANEL_IDS.FILE_TREE}`)
    ).toBeInTheDocument();
    expect(screen.getByTestId('shell-nav-drop-ghost')).toBeInTheDocument();
    expect(mocks.swapLeftDockPanels).not.toHaveBeenCalled();

    // Move 120px right (60% width & 100% height overlap -> triggers automatic swap)
    fireEvent.pointerMove(window, { clientX: 340, clientY: 95 });
    expect(mocks.swapLeftDockPanels).toHaveBeenCalledWith(
      PANEL_IDS.FILE_TREE,
      PANEL_IDS.SESSION_LIST
    );

    fireEvent.pointerUp(window);
    expect(mocks.placeLeftDockPanel).not.toHaveBeenCalled();
  });
});

