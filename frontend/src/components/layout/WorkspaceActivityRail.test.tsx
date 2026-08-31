import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import {
  getDefaultActivityRailPanelId,
  resetActivityRailOrder,
} from '@/lib/activityRailOrder';
import { WorkspaceActivityRail } from './WorkspaceActivityRail';

const mocks = vi.hoisted(() => ({
  toggleFileTree: vi.fn(),
  toggleGitPanel: vi.fn(),
  toggleSearchPanel: vi.fn(),
  toggleSessionList: vi.fn(),
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
    mocks.persistFrontendPreference.mockReset();
  });

  it('renders the four workspace panels in default order', () => {
    render(
      <WorkspaceActivityRail isEditorAreaVisible onToggleEditorArea={vi.fn()} />
    );

    expect(
      screen
        .getAllByRole('button')
        .filter((button) => button.getAttribute('aria-label'))
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['文件', 'Git', '搜索 (Ctrl+Shift+F)', '会话列表']);
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
    ).toEqual(['会话列表', '文件', 'Git', '搜索 (Ctrl+Shift+F)']);
    expect(getDefaultActivityRailPanelId()).toBe(PANEL_IDS.SESSION_LIST);
  });
});
