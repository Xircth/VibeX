import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, type RenderResult } from '@testing-library/react';
import { createDockview } from 'dockview-core';
import type { DockviewApi } from 'dockview-react';
import { StrictMode, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTerminalShelfForTests } from '@/lib/terminalShelf';
import { PANEL_IDS, useLayoutStore } from '@/stores/useLayoutStore';
import { syncDockviewGroupRegistry } from '@/utils/dockviewHelpers';
import { isEditorGroup } from '@/utils/dockviewGroupPolicy';
import { settleDockviewGroupWidths } from '@/utils/dockviewStartupSizing';
import { useDockviewPanelActionsBinding } from '@/hooks/useDockviewPanelActionsBinding';
import { resolveImagePreviewSource } from '@/lib/imagePreviewRegistry';
import {
  PanelActionsContext,
  PanelActionsProvider,
  useOptionalPanelActionsContext,
  usePanelActionsContext,
  type PanelActions,
} from './PanelActionsContext';

vi.mock('@/hooks/usePluginHostContributions', () => ({
  usePluginHostContributions: () => [
    {
      pluginId: 'example.browser',
      id: 'browser',
      label: 'Browser',
      kind: 'app_panel',
      generation: 1,
      metadata: {
        engine: 'host-browser',
        icon: 'globe',
        multiInstance: true,
      },
    },
  ],
  contributionMetadata: (item: { metadata?: Record<string, unknown> }) =>
    item.metadata ?? {},
}));

function renderWithQueryClient(ui: ReactNode): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

function createDockviewApi() {
  const panels: Array<Record<string, unknown>> = [];
  const group = {
    id: 'group-editor-1',
    panels,
    element: document.createElement('div'),
    api: { setVisible: vi.fn(), isVisible: true },
  };
  const api = {
    activeGroup: group,
    activePanel: undefined,
    groups: [group],
    panels,
    getGroup: vi.fn(() => undefined),
    getPanel: vi.fn((id: string) => panels.find((panel) => panel.id === id)),
    addPanel: vi.fn(
      (options: {
        id?: string;
        title?: string;
        component?: string;
        params?: Record<string, unknown>;
      }) => {
        const panel = {
          id: options.id,
          title: options.title,
          component: options.component,
          view: { contentComponent: options.component },
          params: options.params ?? {},
          group,
          api: {
            setActive: vi.fn(),
            updateParameters: vi.fn((params: Record<string, unknown>) => {
              panel.params = { ...panel.params, ...params };
            }),
            setTitle: vi.fn((title: string) => {
              panel.title = title;
            }),
          },
        };
        panels.push(panel);
        return panel;
      }
    ),
    height: 800,
    onDidRemovePanel: vi.fn(() => ({ dispose: vi.fn() })),
    onDidAddPanel: vi.fn(() => ({ dispose: vi.fn() })),
    onDidRemoveGroup: vi.fn(() => ({ dispose: vi.fn() })),
    onDidLayoutChange: vi.fn(() => ({ dispose: vi.fn() })),
    onDidLayoutFromJSON: vi.fn(() => ({ dispose: vi.fn() })),
    removePanel: vi.fn(),
    addGroup: vi.fn(),
  };
  api.getGroup = vi.fn((id: string) =>
    api.groups.find((entry) => entry.id === id)
  );
  api.addGroup = vi.fn(
    (options: { id?: string; direction?: string; initialHeight?: number }) => {
      const created = {
        id: options.id ?? 'group-created',
        panels: [] as Array<Record<string, unknown>>,
        element: document.createElement('div'),
        api: {
          isVisible: true,
          setVisible: vi.fn(),
          setSize: vi.fn(),
        },
      };
      created.api.setVisible.mockImplementation((visible: boolean) => {
        created.api.isVisible = visible;
      });
      api.groups.push(created);
      return created;
    }
  );
  return api as unknown as DockviewApi;
}

describe('PanelActionsContext host-browser plugin', () => {
  it('keeps file tabs usable after their directory is renamed', () => {
    let actions: PanelActions | undefined;
    function Probe() {
      actions = usePanelActionsContext();
      return null;
    }
    renderWithQueryClient(
      <PanelActionsProvider>
        <Probe />
      </PanelActionsProvider>
    );
    const dockviewApi = createDockviewApi();
    act(() => actions?.setDockviewApi(dockviewApi));
    act(() =>
      actions?.openFilePreview('/repo/src/index.ts', {
        displayPath: 'src/index.ts',
      })
    );
    act(() => actions?.renameFilePreviews('/repo/src', '/repo/source'));

    expect(dockviewApi.panels[0].params?.filePath).toBe(
      '/repo/source/index.ts'
    );
    expect(dockviewApi.panels[0].params?.displayPath).toBe('source/index.ts');
    act(() =>
      expect(actions?.openFilePreview('/repo/source/index.ts')).toBe('focused')
    );
    expect(dockviewApi.panels).toHaveLength(1);
    act(() =>
      expect(actions?.openFilePreview('/repo/src/index.ts')).toBe('opened')
    );
    expect(dockviewApi.panels).toHaveLength(2);
  });

  it('creates a fresh blank browser panel when no URL is provided', () => {
    let actions: PanelActions | undefined;
    function Probe() {
      actions = usePanelActionsContext();
      return null;
    }

    renderWithQueryClient(
      <PanelActionsProvider>
        <Probe />
      </PanelActionsProvider>
    );
    const dockviewApi = createDockviewApi();

    act(() => actions?.setDockviewApi(dockviewApi));
    act(() => actions?.openWebPreview());

    expect(dockviewApi.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'plugin:example.browser/browser:1',
        component: 'plugin-panel',
        params: {
          pluginId: 'example.browser',
          contributionId: 'browser',
          icon: 'globe',
          requestedUrl: null,
          nativeTabId: null,
        },
      })
    );
  });

  it('creates a distinct outer panel for every requested URL', () => {
    let actions: PanelActions | undefined;
    function Probe() {
      actions = usePanelActionsContext();
      return null;
    }

    renderWithQueryClient(
      <PanelActionsProvider>
        <Probe />
      </PanelActionsProvider>
    );
    const dockviewApi = createDockviewApi();

    act(() => actions?.setDockviewApi(dockviewApi));
    act(() => actions?.openWebPreview('https://one.test'));
    act(() => actions?.openWebPreview('https://two.test'));

    expect(dockviewApi.addPanel).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: 'plugin:example.browser/browser:1',
        component: 'plugin-panel',
        params: {
          pluginId: 'example.browser',
          contributionId: 'browser',
          icon: 'globe',
          requestedUrl: 'https://one.test',
          nativeTabId: null,
        },
      })
    );
    expect(dockviewApi.addPanel).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: 'plugin:example.browser/browser:2',
        component: 'plugin-panel',
        params: {
          pluginId: 'example.browser',
          contributionId: 'browser',
          icon: 'globe',
          requestedUrl: 'https://two.test',
          nativeTabId: null,
        },
      })
    );
  });
});

describe('left dock panel widths', () => {
  function setup(bindThroughEffects = false) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const api = createDockview(container, {
      createComponent: () => ({
        element: document.createElement('div'),
        init() {},
        dispose() {},
      }),
    });
    api.layout(1600, 800, true);
    const welcome = api.addPanel({
      id: PANEL_IDS.WELCOME,
      component: PANEL_IDS.WELCOME,
    });
    (welcome.group as { id: string }).id = 'group-editor-1';
    const first = api.addPanel({
      id: PANEL_IDS.FILE_TREE,
      component: PANEL_IDS.FILE_TREE,
      position: { referencePanel: welcome, direction: 'left' },
    });
    (first.group as { id: string }).id = 'group-left';
    first.group.element.setAttribute('data-left-dock', 'true');
    const second = api.addPanel({
      id: PANEL_IDS.SESSION_LIST,
      component: PANEL_IDS.SESSION_LIST,
      position: { referencePanel: first, direction: 'right' },
    });
    (second.group as { id: string }).id = 'group-left-2';
    second.group.element.setAttribute('data-left-dock', 'true');
    syncDockviewGroupRegistry(api);
    settleDockviewGroupWidths([
      { group: first.group, width: 240 },
      { group: second.group, width: 280 },
    ]);
    expect(first.group.api.width).toBeCloseTo(240, 0);
    expect(second.group.api.width).toBeCloseTo(280, 0);
    const workspaceWidth = welcome.group.api.width;
    let actions: PanelActions | undefined;
    function Probe() {
      actions = usePanelActionsContext();
      return null;
    }
    function Binding() {
      const { setDockviewApi } = usePanelActionsContext();
      useDockviewPanelActionsBinding(
        api as unknown as DockviewApi,
        setDockviewApi
      );
      return null;
    }
    const content = (
      <PanelActionsProvider>
        <Probe />
        {bindThroughEffects ? <Binding /> : null}
      </PanelActionsProvider>
    );
    const view = renderWithQueryClient(
      bindThroughEffects ? <StrictMode>{content}</StrictMode> : content
    );
    if (!bindThroughEffects)
      act(() => actions?.setDockviewApi(api as unknown as DockviewApi));
    return {
      api,
      first,
      second,
      welcome,
      workspaceWidth,
      get actions() {
        return actions!;
      },
      cleanup() {
        view.unmount();
        api.dispose();
        container.remove();
      },
    };
  }

  it.each(['close', 'toggle', 'native'])(
    'gives a removed column to Zone B through %s without resizing the remaining dock',
    (method) => {
      const { api, first, second, welcome, workspaceWidth, actions, cleanup } =
        setup();
      act(() => {
        if (method === 'close') actions?.closePanel(PANEL_IDS.SESSION_LIST);
        else if (method === 'toggle') actions?.toggleSessionList();
        else api.removePanel(second);
      });
      expect(first.group.api.width).toBeCloseTo(240, 0);
      expect(welcome.group.api.width).toBeCloseTo(workspaceWidth + 280, 0);
      cleanup();
    }
  );

  it('replaces visible slots in FIFO order, preserves their widths, and reduces the queue on close', () => {
    const { api, first, second, welcome, workspaceWidth, actions, cleanup } =
      setup();
    const firstGroup = first.group;
    const secondGroup = second.group;
    act(() => actions.toggleBotsPanel());
    expect(api.getPanel(PANEL_IDS.FILE_TREE)?.id).toBeUndefined();
    expect(api.getPanel(PANEL_IDS.BOTS)?.group).toBe(firstGroup);
    expect(actions.isPanelOpen(PANEL_IDS.FILE_TREE)).toBe(false);
    expect(actions.isPanelOpen(PANEL_IDS.BOTS)).toBe(true);
    expect(actions.isPanelOpen(PANEL_IDS.SESSION_LIST)).toBe(true);
    act(() => actions.toggleGitPanel());
    expect(api.getPanel(PANEL_IDS.SESSION_LIST)?.id).toBeUndefined();
    expect(api.getPanel(PANEL_IDS.GIT)?.group).toBe(secondGroup);
    expect(firstGroup.api.width).toBeCloseTo(240, 0);
    expect(secondGroup.api.width).toBeCloseTo(280, 0);
    act(() => actions.toggleBotsPanel());
    expect(actions.isPanelOpen(PANEL_IDS.BOTS)).toBe(false);
    expect(secondGroup.api.width).toBeCloseTo(280, 0);
    expect(welcome.group.api.width).toBeCloseTo(workspaceWidth + 240, 0);
    act(() => actions.toggleSessionList());
    expect(api.getPanel(PANEL_IDS.GIT)?.id).toBeUndefined();
    expect(api.getPanel(PANEL_IDS.SESSION_LIST)?.group).toBe(secondGroup);
    expect(secondGroup.api.width).toBeCloseTo(280, 0);
    cleanup();
  });

  it('opens a compact dock panel after every dock slot has been closed', () => {
    const { api, actions, cleanup } = setup();
    act(() => {
      actions.toggleFileTree();
      actions.toggleSessionList();
    });
    expect(actions.isPanelOpen(PANEL_IDS.FILE_TREE)).toBe(false);
    act(() => actions.toggleBotsPanel());
    expect(actions.isPanelOpen(PANEL_IDS.BOTS)).toBe(true);
    expect(api.getPanel(PANEL_IDS.BOTS)!.group.api.width).toBeGreaterThan(100);
    expect(api.getPanel(PANEL_IDS.BOTS)!.group.api.width).toBeLessThan(400);
    cleanup();
  });

  it('keeps activity rail actions bound after effect cleanup and setup replay', () => {
    const { api, first, welcome, workspaceWidth, actions, cleanup } =
      setup(true);
    act(() => actions.toggleSessionList());
    expect(first.group.api.width).toBeCloseTo(240, 0);
    expect(welcome.group.api.width).toBeCloseTo(workspaceWidth + 280, 0);
    act(() => actions.toggleBotsPanel());
    expect(actions.isPanelOpen(PANEL_IDS.BOTS)).toBe(true);
    expect(api.getPanel(PANEL_IDS.FILE_TREE)?.id).toBeUndefined();
    cleanup();
  });

  it('restores one active panel per legacy dock slot so closing it releases the slot', () => {
    const { api, first, actions, cleanup } = setup();
    act(() => {
      api.addPanel({
        id: PANEL_IDS.GIT,
        component: PANEL_IDS.GIT,
        position: { referenceGroup: first.group, direction: 'within' },
      });
      const layout = api.toJSON();
      actions.setDockviewApi(null);
      api.clear();
      actions.setDockviewApi(api as unknown as DockviewApi);
      api.fromJSON(layout);
    });
    expect(api.getPanel(PANEL_IDS.FILE_TREE)?.id).toBeUndefined();
    expect(actions.isPanelOpen(PANEL_IDS.GIT)).toBe(true);
    expect(actions.isPanelOpen(PANEL_IDS.FILE_TREE)).toBe(false);
    const remainingGroup = api.getPanel(PANEL_IDS.SESSION_LIST)!.group;
    const remainingWidth = remainingGroup.api.width;
    const editor = api.getPanel(PANEL_IDS.WELCOME)!.group;
    const editorWidth = editor.api.width;
    const closedWidth = api.getPanel(PANEL_IDS.GIT)!.group.api.width;
    act(() => actions.toggleGitPanel());
    expect(api.getPanel(PANEL_IDS.GIT)?.id).toBeUndefined();
    expect(remainingGroup.api.width).toBeCloseTo(remainingWidth, 0);
    expect(editor.api.width).toBeCloseTo(editorWidth + closedWidth, 0);
    cleanup();
  });
});

describe('PanelActionsContext image preview', () => {
  it('keeps data URLs out of dockview panel parameters', () => {
    let actions: PanelActions | undefined;
    function Probe() {
      actions = usePanelActionsContext();
      return null;
    }

    renderWithQueryClient(
      <PanelActionsProvider>
        <Probe />
      </PanelActionsProvider>
    );
    const dockviewApi = createDockviewApi();

    act(() => actions?.setDockviewApi(dockviewApi));
    act(() =>
      actions?.openImagePreview('data:image/png;base64,AAAA', {
        title: 'generated.png',
      })
    );

    expect(dockviewApi.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^image:/),
        component: PANEL_IDS.PREVIEW,
        title: 'generated.png',
        params: expect.objectContaining({
          imagePreviewId: expect.stringMatching(/^image:/),
        }),
      })
    );
    const call = vi.mocked(dockviewApi.addPanel).mock.calls[0]?.[0] as {
      params: { imagePreviewId: string; imageUrl?: string };
    };
    expect(call.params.imageUrl).toBeUndefined();
    expect(resolveImagePreviewSource(call.params.imagePreviewId)).toBe(
      'data:image/png;base64,AAAA'
    );
  });
});

describe('PanelActionsContext terminal visibility', () => {
  beforeEach(() => {
    resetTerminalShelfForTests();
  });

  it('opens a reusable shelf under the editor groups', () => {
    let actions: PanelActions | undefined;
    function Probe() {
      actions = usePanelActionsContext();
      return null;
    }

    renderWithQueryClient(
      <PanelActionsProvider>
        <Probe />
      </PanelActionsProvider>
    );

    const dockviewApi = createDockviewApi();
    dockviewApi.groups[0]?.panels.push({ id: 'file:a.ts' } as never);

    act(() => actions?.setDockviewApi(dockviewApi));
    act(() => actions?.showTerminal());

    expect(dockviewApi.addGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'below',
        initialHeight: 320,
      })
    );
    expect(dockviewApi.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        component: PANEL_IDS.TERMINAL,
        params: expect.objectContaining({
          surface: 'editor',
          terminalShelf: true,
        }),
      })
    );
    expect(actions?.isPanelOpen(PANEL_IDS.TERMINAL)).toBe(true);

    act(() => actions?.openNewTerminal());

    const shelf = vi.mocked(dockviewApi.addGroup).mock.results[0]?.value as {
      api: { setVisible: ReturnType<typeof vi.fn> };
    };
    expect(shelf.api.setVisible).toHaveBeenCalledWith(false);
    expect(dockviewApi.addGroup).toHaveBeenCalledTimes(1);
    expect(actions?.isPanelOpen(PANEL_IDS.TERMINAL)).toBe(false);
  });
});

describe('PanelActionsContext terminal editor tab', () => {
  it('opens a terminal as an editor-group tab instead of the bottom zone', () => {
    let actions: PanelActions | undefined;
    function Probe() {
      actions = usePanelActionsContext();
      return null;
    }

    renderWithQueryClient(
      <PanelActionsProvider>
        <Probe />
      </PanelActionsProvider>
    );
    const dockviewApi = createDockviewApi();

    act(() => actions?.setDockviewApi(dockviewApi));
    act(() => actions?.openTerminalEditorTab());

    expect(dockviewApi.addPanel).toHaveBeenCalledTimes(1);
    expect(dockviewApi.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^terminal:term-/),
        component: PANEL_IDS.TERMINAL,
        title: 'Terminal',
        params: {
          surface: 'editor',
          tabId: expect.stringMatching(/^term-/),
        },
        position: expect.objectContaining({
          direction: 'within',
        }),
      })
    );
  });
});

describe('PanelActionsContext editor placement', () => {
  function setup() {
    let actions: PanelActions | undefined;
    function Probe() {
      actions = usePanelActionsContext();
      return null;
    }
    renderWithQueryClient(
      <PanelActionsProvider>
        <Probe />
      </PanelActionsProvider>
    );
    const dockviewApi = createDockviewApi();
    const busy = dockviewApi.groups[0];
    busy.panels.push(
      {
        id: 'file:a.ts',
        view: { contentComponent: 'other' },
        params: {},
        group: busy,
      } as never,
      {
        id: 'file:b.ts',
        view: { contentComponent: 'other' },
        params: {},
        group: busy,
      } as never
    );
    const quiet = {
      id: 'group-editor-2',
      panels: [{ id: 'file:c.ts' }],
      element: document.createElement('div'),
      api: { setVisible: vi.fn(), isVisible: true },
    };
    dockviewApi.groups.push(quiet as never);
    act(() => actions?.setDockviewApi(dockviewApi));
    return { actions, dockviewApi, quiet };
  }

  it('opens a file in the editor group with the fewest tabs', () => {
    const { actions, dockviewApi, quiet } = setup();

    act(() => actions?.openFilePreview('/repo/d.ts'));

    const call = vi.mocked(dockviewApi.addPanel).mock.calls.at(-1)?.[0] as {
      position?: { referenceGroup?: string };
    };
    expect(call.position?.referenceGroup).toBe(quiet.id);
  });

  it('pins a terminal tab to the requested editor group', () => {
    const { actions, dockviewApi } = setup();

    act(() =>
      actions?.runInEditorGroup('group-editor-1', () => {
        actions?.openTerminalEditorTab('powershell.exe');
      })
    );

    const call = vi.mocked(dockviewApi.addPanel).mock.calls.at(-1)?.[0] as {
      params?: { shell?: string };
      position?: { referenceGroup?: string };
    };
    expect(call.position?.referenceGroup).toBe('group-editor-1');
    expect(call.params?.shell).toBe('powershell.exe');
  });

  it('moves a tab into a new group when splitting down', () => {
    const { actions, dockviewApi } = setup();
    const panel = dockviewApi.groups[0].panels[0] as unknown as {
      id: string;
      api: {
        moveTo: ReturnType<typeof vi.fn>;
        setActive: ReturnType<typeof vi.fn>;
      };
      toJSON?: () => { contentComponent: string };
    };
    panel.toJSON = () => ({ contentComponent: 'preview' });
    panel.api = { moveTo: vi.fn(), setActive: vi.fn() };
    vi.mocked(dockviewApi.getPanel).mockReturnValue(panel as never);

    act(() => actions?.splitEditorPanel(panel.id, 'below'));

    expect(dockviewApi.addGroup).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'below' })
    );
    expect(panel.api.moveTo).toHaveBeenCalledOnce();
  });

  it('sorts the tabs in one group by title', () => {
    const { actions, dockviewApi } = setup();
    const group = dockviewApi.groups[0];
    const first = {
      id: 'file:b.ts',
      title: 'b.ts',
      api: { moveTo: vi.fn() },
    };
    const second = {
      id: 'file:a.ts',
      title: 'a.ts',
      api: { moveTo: vi.fn() },
    };
    group.panels.splice(
      0,
      group.panels.length,
      first as never,
      second as never
    );

    act(() => actions?.sortEditorGroupByName(group.id));

    expect(second.api.moveTo).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0, group })
    );
    expect(first.api.moveTo).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1, group })
    );
  });

  it('keeps the source group when its only tab is split down', () => {
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
    api.layout(900, 600, true);
    const panel = api.addPanel({
      id: 'file:a.ts',
      component: 'preview',
      title: 'a.ts',
    });
    (panel.group as { id: string }).id = 'group-editor-1';
    syncDockviewGroupRegistry(api);

    let actions: PanelActions | undefined;
    function Probe() {
      actions = usePanelActionsContext();
      return null;
    }
    renderWithQueryClient(
      <PanelActionsProvider>
        <Probe />
      </PanelActionsProvider>
    );
    act(() => actions?.setDockviewApi(api as unknown as DockviewApi));
    let split = false;
    act(() => {
      split = actions?.splitEditorPanel('file:a.ts', 'below') ?? false;
    });

    expect(split).toBe(true);
    const source = api.getGroup('group-editor-1');
    expect(source).toBeDefined();
    expect(source!.panels).toHaveLength(0);
    const destination = api.groups.find(
      (group) => isEditorGroup(group) && group.id !== 'group-editor-1'
    );
    expect(destination?.panels.map((item) => item.id)).toEqual(['file:a.ts']);
    expect(destination!.api.height).toBeGreaterThan(80);
    expect(source!.api.height).toBeGreaterThan(80);
    expect(Math.abs(destination!.api.width - source!.api.width)).toBeLessThan(
      8
    );

    api.dispose();
    container.remove();
  });

  it('returns safe no-op actions outside PanelActionsProvider while keeping optional context null', () => {
    let requiredActions: PanelActions | undefined;
    let optionalActions: PanelActions | null | undefined;
    function StandaloneProbe() {
      requiredActions = usePanelActionsContext();
      optionalActions = useOptionalPanelActionsContext();
      return null;
    }

    expect(() => render(<StandaloneProbe />)).not.toThrow();
    expect(optionalActions).toBeNull();
    expect(requiredActions?.openFilePreview('/repo/a.ts')).toBe('opened');
    expect(requiredActions?.isPanelOpen(PANEL_IDS.TERMINAL)).toBe(false);
  });

  it('registers PanelActionsContext on globalThis to survive HMR module re-evaluation', () => {
    const globalScope = globalThis as typeof globalThis & {
      __VIBEX_PANEL_ACTIONS_CONTEXT__?: typeof PanelActionsContext;
    };
    expect(globalScope.__VIBEX_PANEL_ACTIONS_CONTEXT__).toBe(
      PanelActionsContext
    );
  });

  it('replaces the single dock slot and closes it when its icon is clicked again', () => {
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
    api.layout(900, 600, true);
    const welcome = api.addPanel({
      id: PANEL_IDS.WELCOME,
      component: PANEL_IDS.WELCOME,
      title: 'Welcome',
    });
    (welcome.group as { id: string }).id = 'group-editor-1';
    const leftGroup = api.addGroup({
      id: 'group-left',
      referencePanel: welcome,
      direction: 'left',
    });
    api.addPanel({
      id: PANEL_IDS.FILE_TREE,
      component: PANEL_IDS.FILE_TREE,
      title: 'Files',
      position: { referenceGroup: leftGroup, direction: 'within' },
    });
    syncDockviewGroupRegistry(api);

    let actions: PanelActions | undefined;
    function Probe() {
      actions = usePanelActionsContext();
      return null;
    }
    renderWithQueryClient(
      <PanelActionsProvider>
        <Probe />
      </PanelActionsProvider>
    );
    act(() => actions?.setDockviewApi(api as unknown as DockviewApi));

    act(() => {
      actions?.toggleGitPanel();
    });

    expect(leftGroup.panels.map((p) => p.id)).toEqual([PANEL_IDS.GIT]);
    expect(actions?.isPanelOpen(PANEL_IDS.GIT)).toBe(true);
    expect(actions?.isPanelOpen(PANEL_IDS.FILE_TREE)).toBe(false);

    act(() => {
      actions?.toggleGitPanel();
    });

    expect(actions?.isPanelOpen(PANEL_IDS.GIT)).toBe(false);
    expect(actions?.isPanelOpen(PANEL_IDS.FILE_TREE)).toBe(false);

    act(() => {
      actions?.toggleGitPanel();
    });

    act(() => {
      actions?.placeLeftDockPanel(PANEL_IDS.FILE_TREE, 'bottom');
    });

    expect(actions?.isLeftDockSplit()).toBe(true);
    expect(api.getPanel(PANEL_IDS.GIT)?.group.panels.map((p) => p.id)).toEqual([
      PANEL_IDS.GIT,
    ]);
    expect(actions?.isPanelOpen(PANEL_IDS.GIT)).toBe(true);
    expect(actions?.isPanelOpen(PANEL_IDS.FILE_TREE)).toBe(true);
    const totalDockWidth = api.groups
      .filter(
        (group) =>
          group.api.isVisible &&
          group.element?.getAttribute('data-left-dock') === 'true' &&
          group.element.getAttribute('data-shell-nav-side') !== 'right'
      )
      .reduce((total, group) => total + group.api.width, 0);
    expect(totalDockWidth).toBeLessThanOrEqual(api.width * 0.34 + 2);

    api.dispose();
    container.remove();
  });

  it('opens session tabs in Zone C by default and allocates across split Zone C tab bars', () => {
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
    api.layout(1200, 600, true);
    const welcome = api.addPanel({
      id: PANEL_IDS.WELCOME,
      component: PANEL_IDS.WELCOME,
      title: 'Welcome',
    });
    (welcome.group as { id: string }).id = 'group-editor-1';
    const rightGroup = api.addGroup({
      id: 'group-right',
      referencePanel: welcome,
      direction: 'right',
    });
    api.addPanel({
      id: PANEL_IDS.AI_CHAT,
      component: PANEL_IDS.AI_CHAT,
      title: 'Sessions',
      position: { referenceGroup: rightGroup, direction: 'within' },
    });
    syncDockviewGroupRegistry(api);

    let actions: PanelActions | undefined;
    function Probe() {
      actions = usePanelActionsContext();
      return null;
    }
    renderWithQueryClient(
      <PanelActionsProvider>
        <Probe />
      </PanelActionsProvider>
    );
    act(() => actions?.setDockviewApi(api as unknown as DockviewApi));

    act(() => {
      actions?.openSessionTab({
        sessionId: 'session-1',
        workspaceId: 'ws-1',
        title: 'First Session',
      });
    });

    expect(rightGroup.panels.map((p) => p.id)).toEqual(['ai-chat:session-1']);
    expect(api.getPanel(PANEL_IDS.AI_CHAT)).toBeUndefined();

    act(() => {
      actions?.openSessionTab({
        sessionId: 'session-2',
        workspaceId: 'ws-1',
        title: 'Second Session',
      });
    });

    expect(rightGroup.panels.map((p) => p.id)).toEqual([
      'ai-chat:session-1',
      'ai-chat:session-2',
    ]);

    let split = false;
    act(() => {
      split = actions?.splitEditorPanel('ai-chat:session-2', 'below') ?? false;
    });
    expect(split).toBe(true);

    const splitRightGroup = api.getGroup('group-right-1') as
      | (ReturnType<typeof api.getGroup> & { element: HTMLElement })
      | undefined;
    expect(splitRightGroup).toBeDefined();
    expect(splitRightGroup?.element.getAttribute('data-session-dock')).toBe(
      'true'
    );
    expect(
      splitRightGroup?.element.classList.contains('dv-header-hidden')
    ).toBe(false);
    expect(rightGroup.panels.map((p) => p.id)).toEqual(['ai-chat:session-1']);
    expect(splitRightGroup?.panels.map((p) => p.id)).toEqual([
      'ai-chat:session-2',
    ]);

    act(() => {
      actions?.openSessionTab({
        sessionId: 'session-3',
        workspaceId: 'ws-1',
        title: 'Third Session',
      });
    });

    // Active group is group-right-1 (1 tab vs 1 tab tie-breaker favors active group),
    // then next session-4 goes to group-right (which now has 1 tab vs 2 tabs).
    expect(splitRightGroup?.panels.map((p) => p.id)).toEqual([
      'ai-chat:session-2',
      'ai-chat:session-3',
    ]);

    act(() => {
      actions?.openSessionTab({
        sessionId: 'session-4',
        workspaceId: 'ws-1',
        title: 'Fourth Session',
      });
    });

    expect(rightGroup.panels.map((p) => p.id)).toEqual([
      'ai-chat:session-1',
      'ai-chat:session-4',
    ]);

    api.dispose();
    container.remove();
  });

  it('opens session tabs directly in Zone B editor group without spawning a right session dock on 2-column A/B layouts', () => {
    useLayoutStore.getState().resetLayout();
    const container = document.createElement('div');
    container.style.width = '1200px';
    container.style.height = '600px';
    document.body.appendChild(container);
    const api = createDockview(container, {
      createComponent: () => ({
        element: document.createElement('div'),
        init: () => {},
        dispose: () => {},
      }),
    });
    api.layout(1200, 600, true);
    const welcome = api.addPanel({
      id: PANEL_IDS.WELCOME,
      component: PANEL_IDS.WELCOME,
      title: 'Welcome',
    });
    const editorGroup = welcome.group;
    (editorGroup as { id: string }).id = 'group-editor-1';
    syncDockviewGroupRegistry(api);

    let actions: PanelActions | undefined;
    function Probe() {
      actions = usePanelActionsContext();
      return null;
    }
    renderWithQueryClient(
      <PanelActionsProvider>
        <Probe />
      </PanelActionsProvider>
    );
    act(() => actions?.setDockviewApi(api as unknown as DockviewApi));

    act(() => {
      actions?.openSessionTab({
        sessionId: 'session-ab-1',
        workspaceId: 'ws-1',
        title: 'Stage Session',
      });
    });

    expect(editorGroup.panels.map((p) => p.id)).toEqual([
      'ai-chat:session-ab-1',
    ]);
    expect(api.getGroup('group-right')).toBeUndefined();
    expect(useLayoutStore.getState().isRightPanelVisible).toBe(false);

    api.dispose();
    container.remove();
  });
});
