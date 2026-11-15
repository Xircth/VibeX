import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import {
  resetPreviewPanelDirtyForTests,
  setPreviewPanelDirty,
} from '@/components/panels/previewPanelDirty';
import * as sessionTabSlots from '@/lib/workspaceSessionTabSlots';
import { GROUP_IDS, PANEL_IDS } from '@/stores/useLayoutStore';
import { WorkspaceDockviewTab } from './WorkspaceDockviewTab';

const openSurfaceMenuMock =
  vi.fn<(event: unknown, items: ProductContextMenuItem[]) => void>();

vi.mock('@/components/context-menu', () => ({
  useAppContextMenu: () => ({
    openSurfaceMenu: openSurfaceMenuMock,
  }),
}));

vi.mock('@/components/FileIcon', () => ({
  default: () => <span data-testid="mock-file-icon" />,
}));

function buildTabProps({
  component,
  id = component,
  params = {},
  title,
  group,
}: {
  component: string;
  id?: string;
  params?: Record<string, unknown>;
  title: string;
  group?: {
    id: string;
    panels: Array<{
      id: string;
      api: { close: ReturnType<typeof vi.fn>; component?: string };
    }>;
  };
}) {
  const close = vi.fn();
  const api = {
    close,
    component,
    getParameters: vi.fn(() => params),
    group,
    id,
    onDidParametersChange: vi.fn(() => ({ dispose: vi.fn() })),
    onDidTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
    title,
  };

  return {
    close,
    props: {
      api,
      containerApi: {},
      params,
      tabLocation: 'header',
    } as unknown as IDockviewPanelHeaderProps,
  };
}

describe('WorkspaceDockviewTab', () => {
  beforeEach(() => {
    resetPreviewPanelDirtyForTests();
    openSurfaceMenuMock.mockReset();
  });

  afterEach(() => {
    act(() => {
      resetPreviewPanelDirtyForTests();
    });
    vi.restoreAllMocks();
  });

  it('renders an unsaved dot indicator only for dirty preview tabs and clears when clean', () => {
    const cleanModel = buildTabProps({
      component: PANEL_IDS.PREVIEW,
      id: 'file:/workspace/src/clean.ts',
      params: { filePath: '/workspace/src/clean.ts' },
      title: 'clean.ts',
    });
    const dirtyModel = buildTabProps({
      component: PANEL_IDS.PREVIEW,
      id: 'file:/workspace/src/dirty.ts',
      params: { filePath: '/workspace/src/dirty.ts' },
      title: 'dirty.ts',
    });

    render(
      <>
        <WorkspaceDockviewTab {...cleanModel.props} />
        <WorkspaceDockviewTab {...dirtyModel.props} />
      </>
    );

    expect(
      screen.queryByTestId('workspace-tab-dirty-indicator')
    ).not.toBeInTheDocument();

    act(() => {
      setPreviewPanelDirty(
        'file:/workspace/src/dirty.ts',
        true,
        'src/dirty.ts'
      );
    });

    const indicators = screen.getAllByTestId('workspace-tab-dirty-indicator');
    expect(indicators).toHaveLength(1);

    act(() => {
      setPreviewPanelDirty('file:/workspace/src/dirty.ts', false);
    });

    expect(
      screen.queryByTestId('workspace-tab-dirty-indicator')
    ).not.toBeInTheDocument();
  });

  it('guards close button and middle-click close when the preview tab has unsaved changes', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { close, props } = buildTabProps({
      component: PANEL_IDS.PREVIEW,
      id: 'file:/workspace/src/App.tsx',
      params: { filePath: '/workspace/src/App.tsx' },
      title: 'App.tsx',
    });

    setPreviewPanelDirty('file:/workspace/src/App.tsx', true, 'src/App.tsx');
    render(<WorkspaceDockviewTab {...props} />);

    // Close button (×) blocked when user cancels
    fireEvent.click(screen.getByRole('button', { name: /App\.tsx/i }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    // Middle-click close blocked when user cancels
    const tabSurface = screen.getByTestId('dockview-dv-default-tab');
    fireEvent.pointerDown(tabSurface, { button: 1 });
    fireEvent.pointerUp(tabSurface, { button: 1 });
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();

    // Allowed when user confirms discard
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /App\.tsx/i }));
    expect(confirmSpy).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('guards fallback surface context menu Close Other Tabs when a sibling preview tab is dirty', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const closeDirtySibling = vi.fn();
    const closeCleanSibling = vi.fn();
    const { props } = buildTabProps({
      component: PANEL_IDS.TERMINAL,
      id: PANEL_IDS.TERMINAL,
      title: 'Terminal',
      group: {
        id: GROUP_IDS.BOTTOM,
        panels: [
          {
            id: PANEL_IDS.TERMINAL,
            api: { close: vi.fn(), component: PANEL_IDS.TERMINAL },
          },
          {
            id: 'file:/workspace/dirty.ts',
            api: { close: closeDirtySibling, component: PANEL_IDS.PREVIEW },
          },
          {
            id: 'file:/workspace/clean.ts',
            api: { close: closeCleanSibling, component: PANEL_IDS.PREVIEW },
          },
        ],
      },
    });

    setPreviewPanelDirty('file:/workspace/dirty.ts', true, 'src/dirty.ts');

    render(<WorkspaceDockviewTab {...props} />);

    fireEvent.contextMenu(screen.getByTestId('dockview-dv-default-tab'), {
      clientX: 30,
      clientY: 20,
    });

    expect(openSurfaceMenuMock).toHaveBeenCalledTimes(1);
    const menuItems = openSurfaceMenuMock.mock.calls[0]?.[1] ?? [];
    const closeOthersItem = menuItems.find(
      (item) => item.id === 'close-others'
    );
    expect(closeOthersItem).toBeDefined();
    if (closeOthersItem && 'onSelect' in closeOthersItem) {
      closeOthersItem.onSelect?.();
    }

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(closeDirtySibling).not.toHaveBeenCalled();
    expect(closeCleanSibling).toHaveBeenCalledTimes(1);
  });

  it('does not subscribe non-session tabs to useWorkspaceOpenSessionIds', () => {
    const openSessionIdsSpy = vi.spyOn(
      sessionTabSlots,
      'useWorkspaceOpenSessionIds'
    );

    const fileTab = buildTabProps({
      component: PANEL_IDS.PREVIEW,
      id: 'file:/workspace/src/main.ts',
      params: { filePath: '/workspace/src/main.ts' },
      title: 'main.ts',
    });
    const notesTab = buildTabProps({
      component: PANEL_IDS.NOTES,
      id: PANEL_IDS.NOTES,
      title: 'Notes',
    });

    render(
      <>
        <WorkspaceDockviewTab {...fileTab.props} />
        <WorkspaceDockviewTab {...notesTab.props} />
      </>
    );

    expect(openSessionIdsSpy).not.toHaveBeenCalled();

    const sessionTab = buildTabProps({
      component: PANEL_IDS.AI_CHAT,
      id: 'ai-chat:session-42',
      params: { sessionId: 'session-42', workspaceId: 'ws-1' },
      title: 'Session 42',
    });
    render(<WorkspaceDockviewTab {...sessionTab.props} />);

    expect(openSessionIdsSpy).toHaveBeenCalledTimes(1);
    expect(
      screen.getByTestId('workspace-session-tab-marker')
    ).toBeInTheDocument();
  });
});
