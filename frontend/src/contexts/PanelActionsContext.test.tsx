import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, type RenderResult } from '@testing-library/react';
import { createDockview } from 'dockview-core';
import type { DockviewApi } from 'dockview-react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTerminalShelfForTests } from '@/lib/terminalShelf';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { syncDockviewGroupRegistry } from '@/utils/dockviewHelpers';
import { isEditorGroup } from '@/utils/dockviewGroupPolicy';
import { resolveImagePreviewSource } from '@/lib/imagePreviewRegistry';
import {
  PanelActionsProvider,
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
    onDidRemoveGroup: vi.fn(() => ({ dispose: vi.fn() })),
    onDidLayoutChange: vi.fn(() => ({ dispose: vi.fn() })),
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
});
