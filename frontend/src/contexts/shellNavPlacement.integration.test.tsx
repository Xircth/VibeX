import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { createDockview } from 'dockview-core';
import type { DockviewApi } from 'dockview-react';
import { describe, expect, it, vi } from 'vitest';
import {
  normalizeGroupIds,
  scheduleCloseEmptyTabBarGroups,
} from '@/components/layout/ideLayoutGroupNormalization';
import {
  PanelActionsProvider,
  usePanelActionsContext,
  type PanelActions,
} from '@/contexts/PanelActionsContext';
import { swapLeftDockPanels } from '@/lib/leftDockPlacement';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { installEditorColumnWidthRebalance } from '@/utils/dockviewColumnWidthRebalance';
import { syncDockviewGroupRegistry } from '@/utils/dockviewHelpers';

vi.mock('@/hooks/usePluginHostContributions', () => ({
  usePluginHostContributions: () => [],
  contributionMetadata: (item: { metadata?: Record<string, unknown> }) =>
    item.metadata ?? {},
}));

function renderActions() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let actions: PanelActions | undefined;
  function Probe() {
    actions = usePanelActionsContext();
    return null;
  }
  render(
    <QueryClientProvider client={queryClient}>
      <PanelActionsProvider>
        <Probe />
      </PanelActionsProvider>
    </QueryClientProvider>
  );
  return () => actions;
}

function shellSnapshot(api: DockviewApi) {
  return api.panels
    .filter((panel) =>
      [
        PANEL_IDS.FILE_TREE,
        PANEL_IDS.GIT,
        PANEL_IDS.SEARCH,
        PANEL_IDS.SESSION_LIST,
        PANEL_IDS.BOTS,
      ].includes(panel.id as never)
    )
    .map((panel) => ({
      id: panel.id,
      group: panel.group.id,
      side: panel.group.element?.getAttribute('data-shell-nav-side') ?? 'left',
      visible: panel.group.api.isVisible,
      width: Math.round(panel.group.api.width),
      height: Math.round(panel.group.api.height),
    }));
}

function attachWorkspaceListeners(api: ReturnType<typeof createDockview>) {
  const dockview = api as unknown as DockviewApi;
  const rebalance = installEditorColumnWidthRebalance(dockview);
  const onPanelGone = () => {
    normalizeGroupIds(dockview);
    scheduleCloseEmptyTabBarGroups(dockview);
  };
  const move = api.onDidMovePanel(onPanelGone);
  const remove = api.onDidRemovePanel(onPanelGone);
  const removeGroup = api.onDidRemoveGroup(() => {
    normalizeGroupIds(dockview);
  });
  const add = api.onDidAddGroup(() => {
    normalizeGroupIds(dockview);
  });
  return () => {
    rebalance.dispose();
    move.dispose();
    remove.dispose();
    removeGroup.dispose();
    add.dispose();
  };
}

function setupDock() {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
    ResizeObserverStub;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const api = createDockview(container, {
    createComponent: () => ({
      element: document.createElement('div'),
      init: () => {},
      dispose: () => {},
    }),
  });
  api.layout(1200, 800, true);
  const welcome = api.addPanel({
    id: PANEL_IDS.WELCOME,
    component: PANEL_IDS.WELCOME,
    title: 'Welcome',
  });
  (welcome.group as { id: string }).id = 'group-editor-1';
  syncDockviewGroupRegistry(api);
  return { api, container };
}

describe('shell nav placement regressions', () => {
  it('swaps two open panels without dropping either', () => {
    const { api, container } = setupDock();
    const detach = attachWorkspaceListeners(api);
    const getActions = renderActions();
    act(() => getActions()?.setDockviewApi(api as unknown as DockviewApi));

    act(() => {
      getActions()?.toggleFileTree();
      getActions()?.placeLeftDockPanel(PANEL_IDS.GIT, 'bottom', {
        side: 'left',
        targetPanelId: PANEL_IDS.FILE_TREE,
      });
    });

    const before = shellSnapshot(api as unknown as DockviewApi);
    act(() => {
      swapLeftDockPanels(
        api as unknown as DockviewApi,
        PANEL_IDS.FILE_TREE,
        PANEL_IDS.GIT
      );
    });
    const after = shellSnapshot(api as unknown as DockviewApi);
    expect({ before, after }).toEqual({
      before,
      after: expect.arrayContaining([
        expect.objectContaining({ id: PANEL_IDS.FILE_TREE, visible: true }),
        expect.objectContaining({ id: PANEL_IDS.GIT, visible: true }),
      ]),
    });
    expect(after).toHaveLength(2);
    expect(after.every((panel) => panel.width > 40 && panel.height > 40)).toBe(
      true
    );

    detach();
    api.dispose();
    container.remove();
  });

  it('opens a clicked panel on the left when only the right side is occupied', () => {
    const { api, container } = setupDock();
    const detach = attachWorkspaceListeners(api);
    const getActions = renderActions();
    act(() => getActions()?.setDockviewApi(api as unknown as DockviewApi));

    act(() => {
      getActions()?.placeLeftDockPanel(PANEL_IDS.FILE_TREE, 'right', {
        side: 'right',
      });
    });
    const before = shellSnapshot(api as unknown as DockviewApi);

    act(() => {
      getActions()?.toggleGitPanel();
    });
    const after = shellSnapshot(api as unknown as DockviewApi);
    expect({ before, after }).toEqual({
      before,
      after: expect.arrayContaining([
        expect.objectContaining({
          id: PANEL_IDS.FILE_TREE,
          side: 'right',
          visible: true,
        }),
        expect.objectContaining({
          id: PANEL_IDS.GIT,
          side: 'left',
          visible: true,
        }),
      ]),
    });
    expect(after.every((panel) => panel.width > 40)).toBe(true);

    detach();
    api.dispose();
    container.remove();
  });

  it('moves the only right panel to the empty left side', () => {
    const { api, container } = setupDock();
    const detach = attachWorkspaceListeners(api);
    const getActions = renderActions();
    act(() => getActions()?.setDockviewApi(api as unknown as DockviewApi));

    act(() => {
      getActions()?.placeLeftDockPanel(PANEL_IDS.FILE_TREE, 'right', {
        side: 'right',
      });
    });
    act(() => {
      getActions()?.placeLeftDockPanel(PANEL_IDS.FILE_TREE, 'left', {
        side: 'left',
      });
    });
    const after = shellSnapshot(api as unknown as DockviewApi);
    expect(after).toEqual([
      expect.objectContaining({
        id: PANEL_IDS.FILE_TREE,
        side: 'left',
        visible: true,
      }),
    ]);
    expect(after[0]?.width).toBeGreaterThan(40);

    detach();
    api.dispose();
    container.remove();
  });

  it('keeps neighboring left panels when one is moved to the right', () => {
    const { api, container } = setupDock();
    const detach = attachWorkspaceListeners(api);
    const getActions = renderActions();
    act(() => getActions()?.setDockviewApi(api as unknown as DockviewApi));

    act(() => {
      getActions()?.toggleFileTree();
      getActions()?.placeLeftDockPanel(PANEL_IDS.GIT, 'bottom', {
        side: 'left',
        targetPanelId: PANEL_IDS.FILE_TREE,
      });
      getActions()?.placeLeftDockPanel(PANEL_IDS.SEARCH, 'bottom', {
        side: 'left',
        targetPanelId: PANEL_IDS.GIT,
      });
    });
    const before = shellSnapshot(api as unknown as DockviewApi);

    act(() => {
      getActions()?.placeLeftDockPanel(PANEL_IDS.GIT, 'right', {
        side: 'right',
      });
    });
    const after = shellSnapshot(api as unknown as DockviewApi);
    expect({ before, after }).toEqual({
      before,
      after: expect.arrayContaining([
        expect.objectContaining({
          id: PANEL_IDS.FILE_TREE,
          side: 'left',
          visible: true,
        }),
        expect.objectContaining({
          id: PANEL_IDS.SEARCH,
          side: 'left',
          visible: true,
        }),
        expect.objectContaining({
          id: PANEL_IDS.GIT,
          side: 'right',
          visible: true,
        }),
      ]),
    });
    expect(after).toHaveLength(3);
    expect(after.every((panel) => panel.width > 40 && panel.height > 40)).toBe(
      true
    );

    detach();
    api.dispose();
    container.remove();
  });

  it('keeps the target when an open panel is dropped onto it', () => {
    const { api, container } = setupDock();
    const detach = attachWorkspaceListeners(api);
    const getActions = renderActions();
    act(() => getActions()?.setDockviewApi(api as unknown as DockviewApi));

    act(() => {
      getActions()?.toggleFileTree();
      getActions()?.placeLeftDockPanel(PANEL_IDS.GIT, 'bottom', {
        side: 'left',
        targetPanelId: PANEL_IDS.FILE_TREE,
      });
    });

    act(() => {
      getActions()?.placeLeftDockPanel(PANEL_IDS.FILE_TREE, 'right', {
        side: 'left',
        targetPanelId: PANEL_IDS.GIT,
      });
    });
    const after = shellSnapshot(api as unknown as DockviewApi);
    expect(after.map((panel) => panel.id).sort()).toEqual(
      [PANEL_IDS.FILE_TREE, PANEL_IDS.GIT].sort()
    );
    expect(after.every((panel) => panel.visible && panel.width > 40)).toBe(
      true
    );

    detach();
    api.dispose();
    container.remove();
  });

  it('keeps neighbors when the primary left panel moves to the right', () => {
    const { api, container } = setupDock();
    const detach = attachWorkspaceListeners(api);
    const getActions = renderActions();
    act(() => getActions()?.setDockviewApi(api as unknown as DockviewApi));

    act(() => {
      getActions()?.toggleFileTree();
      getActions()?.placeLeftDockPanel(PANEL_IDS.GIT, 'bottom', {
        side: 'left',
        targetPanelId: PANEL_IDS.FILE_TREE,
      });
      getActions()?.placeLeftDockPanel(PANEL_IDS.SEARCH, 'bottom', {
        side: 'left',
        targetPanelId: PANEL_IDS.GIT,
      });
    });

    act(() => {
      getActions()?.placeLeftDockPanel(PANEL_IDS.FILE_TREE, 'right', {
        side: 'right',
      });
    });
    const after = shellSnapshot(api as unknown as DockviewApi);
    expect(
      after.map(
        (panel) => `${panel.id}:${panel.side}:${panel.visible}:${panel.width}`
      )
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^file-tree:right:true:/),
        expect.stringMatching(/^git:left:true:/),
        expect.stringMatching(/^search:left:true:/),
      ])
    );
    expect(after).toHaveLength(3);
    expect(after.every((panel) => panel.width > 40)).toBe(true);

    detach();
    api.dispose();
    container.remove();
  });
});
