import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openOrFocusPanel: vi.fn(),
  openDiffPreview: vi.fn(),
  openLogs: vi.fn(),
  toggleFileTree: vi.fn(),
  toggleSearchPanel: vi.fn(),
  isPanelOpen: vi.fn(() => false),
  toggleRightPanel: vi.fn(),
  openSettings: vi.fn(),
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  usePanelActionsContext: () => ({
    openOrFocusPanel: mocks.openOrFocusPanel,
    openDiffPreview: mocks.openDiffPreview,
    openLogs: mocks.openLogs,
    toggleFileTree: mocks.toggleFileTree,
    toggleSearchPanel: mocks.toggleSearchPanel,
    isPanelOpen: mocks.isPanelOpen,
  }),
}));

vi.mock('@/stores/useLayoutStore', () => ({
  PANEL_IDS: {
    PREVIEW: 'preview',
    SEARCH: 'search',
    TERMINAL: 'terminal',
  },
  useLayoutStore: (selector: (state: object) => unknown) =>
    selector({ toggleRightPanel: mocks.toggleRightPanel }),
}));

vi.mock('@/lib/api', () => ({
  settingsWindowApi: { open: mocks.openSettings },
}));

import {
  SHORTCUT_ACTION_EVENT,
  type ShortcutActionEventDetail,
} from '@/keyboard';
import { useWorkspaceShortcuts } from './useWorkspaceShortcuts';

function dispatchShortcut(actionId: string) {
  window.dispatchEvent(
    new CustomEvent<ShortcutActionEventDetail>(SHORTCUT_ACTION_EVENT, {
      detail: { actionId },
    })
  );
}

describe('useWorkspaceShortcuts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes every advertised workspace sequence through public panel actions', () => {
    renderHook(() => useWorkspaceShortcuts());

    act(() => {
      dispatchShortcut('toggle-changes-mode');
      dispatchShortcut('toggle-logs-mode');
      dispatchShortcut('toggle-preview-mode');
      dispatchShortcut('toggle-left-sidebar');
      dispatchShortcut('toggle-left-main-panel');
    });

    expect(mocks.openDiffPreview).toHaveBeenCalledOnce();
    expect(mocks.openLogs).toHaveBeenCalledOnce();
    expect(mocks.openOrFocusPanel).toHaveBeenCalledWith('preview', 'Preview');
    expect(mocks.toggleFileTree).toHaveBeenCalledOnce();
    expect(mocks.toggleRightPanel).toHaveBeenCalledOnce();
  });
});
