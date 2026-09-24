import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, type RenderResult } from '@testing-library/react';
import type { DockviewApi } from 'dockview-react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PANEL_IDS } from '@/stores/useLayoutStore';
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
    addPanel: vi.fn((options: Record<string, unknown>) => {
      const panel = {
        id: options.id,
        title: options.title,
        group,
        api: { setActive: vi.fn() },
      };
      panels.push(panel);
      return panel;
    }),
    onDidRemovePanel: vi.fn(() => ({ dispose: vi.fn() })),
    onDidLayoutChange: vi.fn(() => ({ dispose: vi.fn() })),
    removePanel: vi.fn(),
  };
  return api as unknown as DockviewApi;
}

describe('PanelActionsContext host-browser plugin', () => {
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
  it('keeps an existing terminal visible when explicitly opened', () => {
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
    const terminalGroup = {
      id: 'group-bottom',
      panels: [] as Array<Record<string, unknown>>,
      api: { setVisible: vi.fn(), isVisible: true },
    };
    const terminalPanel = {
      id: PANEL_IDS.TERMINAL,
      group: terminalGroup,
      api: { setActive: vi.fn() },
    };
    terminalGroup.panels.push(terminalPanel);
    dockviewApi.groups.push(terminalGroup as never);
    dockviewApi.panels.push(terminalPanel as never);
    vi.mocked(dockviewApi.getGroup).mockImplementation((id) =>
      id === 'group-bottom' ? (terminalGroup as never) : undefined
    );

    act(() => actions?.setDockviewApi(dockviewApi));
    act(() => actions?.showTerminal());

    expect(terminalGroup.api.setVisible).toHaveBeenCalledWith(true);
    expect(terminalPanel.api.setActive).toHaveBeenCalledOnce();
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
