import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useWorkspaceOverlay,
  WorkspaceOverlayProvider,
} from '@/contexts/WorkspaceOverlayContext';
import { BrowserPanel } from './BrowserPanel';
import { discardRetainedBrowserTabs } from './browserTabRetention';
import type { BrowserEvent, BrowserTab } from './browserTypes';

const {
  applyBrowserIntentMock,
  closeBrowserTabMock,
  createBrowserTabMock,
  listenToBrowserEventsMock,
} = vi.hoisted(() => ({
  applyBrowserIntentMock: vi.fn(),
  closeBrowserTabMock: vi.fn(),
  createBrowserTabMock: vi.fn(),
  listenToBrowserEventsMock: vi.fn(),
}));

vi.mock('./browserApi', () => ({
  browserApi: {
    applyIntent: applyBrowserIntentMock,
    closeTab: closeBrowserTabMock,
    createTab: createBrowserTabMock,
    listen: listenToBrowserEventsMock,
  },
}));

const initialSurface = {
  x: 12,
  y: 48,
  width: 800,
  height: 600,
  scaleFactor: 2,
  visible: true,
};

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    width,
    height,
    toJSON: () => ({}),
  };
}

function tab(overrides: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id: 'browser-tab-1',
    url: 'https://example.test/',
    title: 'Example',
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    zoomLevel: 0,
    profile: { kind: 'workspace', workspaceId: 'workspace-1' },
    surface: initialSurface,
    ...overrides,
  };
}

function WorkspaceMenuTrigger() {
  const { setTabCreationMenuOpen } = useWorkspaceOverlay();
  return (
    <button type="button" onClick={() => setTabCreationMenuOpen(true)}>
      Open workspace menu
    </button>
  );
}

describe('BrowserPanel', () => {
  let browserEventListener: ((event: BrowserEvent) => void) | undefined;

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.testid === 'browser-panel-root') {
          return rect(12, 12, 800, 636);
        }
        if (this.getAttribute('role') === 'toolbar') {
          return rect(12, 12, 800, 36);
        }
        return rect(
          initialSurface.x,
          initialSurface.y,
          initialSurface.width,
          initialSurface.height
        );
      }
    );
    vi.stubGlobal('devicePixelRatio', initialSurface.scaleFactor);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    browserEventListener = undefined;
    applyBrowserIntentMock.mockReset().mockResolvedValue(undefined);
    closeBrowserTabMock.mockReset().mockResolvedValue(undefined);
    createBrowserTabMock.mockReset().mockResolvedValue(tab());
    listenToBrowserEventsMock
      .mockReset()
      .mockImplementation(async (listener: (event: BrowserEvent) => void) => {
        browserEventListener = listener;
        return () => {};
      });
  });

  afterEach(() => {
    discardRetainedBrowserTabs();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function startElementInspection() {
    const selectElement = await screen.findByRole('button', {
      name: 'Select Element',
    });
    await waitFor(() => expect(selectElement).toBeEnabled());
    fireEvent.click(selectElement);

    for (const [requestId, method] of [
      [1, 'DOM.enable'],
      [2, 'Overlay.enable'],
      [3, 'Overlay.setInspectMode'],
    ] as const) {
      await waitFor(() =>
        expect(applyBrowserIntentMock).toHaveBeenCalledWith(
          'browser-tab-1',
          expect.objectContaining({
            type: 'executeDevTools',
            requestId,
            method,
          })
        )
      );
      act(() => {
        browserEventListener?.({
          type: 'devToolsResult',
          tabId: 'browser-tab-1',
          requestId,
          success: true,
          result: {},
        });
      });
    }
    await waitFor(() =>
      expect(selectElement).toHaveAttribute('aria-pressed', 'true')
    );
    return selectElement;
  }

  it('creates a workspace-scoped native browser and follows CEF navigation state', async () => {
    render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
      />
    );

    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());
    expect(listenToBrowserEventsMock.mock.invocationCallOrder[0]).toBeLessThan(
      createBrowserTabMock.mock.invocationCallOrder[0]
    );
    expect(createBrowserTabMock).toHaveBeenCalledWith({
      initialUrl: 'https://example.test',
      profile: { kind: 'workspace', workspaceId: 'workspace-1' },
      surface: { ...initialSurface, visible: false },
    });
    await waitFor(() =>
      expect(applyBrowserIntentMock).toHaveBeenCalledWith('browser-tab-1', {
        type: 'setSurface',
        surface: initialSurface,
      })
    );
    applyBrowserIntentMock.mockClear();

    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    act(() => {
      browserEventListener?.({
        type: 'tabUpdated',
        tab: tab({
          url: 'https://example.test/docs',
          canGoBack: true,
          loading: true,
        }),
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(applyBrowserIntentMock).toHaveBeenNthCalledWith(1, 'browser-tab-1', {
      type: 'back',
    });
    expect(applyBrowserIntentMock).toHaveBeenNthCalledWith(2, 'browser-tab-1', {
      type: 'stop',
    });
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue(
      'https://example.test/docs'
    );
  });

  it('reports CEF favicon changes to the outer workspace tab', async () => {
    const onFaviconChange = vi.fn();
    render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
        onFaviconChange={onFaviconChange}
      />
    );
    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());

    act(() => {
      browserEventListener?.({
        type: 'tabUpdated',
        tab: tab({ faviconUrl: 'https://example.test/favicon.ico' }),
      });
    });

    expect(onFaviconChange).toHaveBeenLastCalledWith(
      'https://example.test/favicon.ico'
    );
  });

  it('replays CEF events emitted before createTab returns to the frontend', async () => {
    let resolveCreate: ((createdTab: BrowserTab) => void) | undefined;
    createBrowserTabMock.mockImplementation(
      () =>
        new Promise<BrowserTab>((resolve) => {
          resolveCreate = resolve;
        })
    );
    render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
      />
    );

    await waitFor(() => expect(browserEventListener).toBeDefined());
    act(() => {
      browserEventListener?.({
        type: 'tabUpdated',
        tab: tab({
          url: 'https://example.test/ready',
          title: 'Ready',
          loading: false,
        }),
      });
      resolveCreate?.(tab());
    });

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue(
        'https://example.test/ready'
      )
    );
  });

  it('reconciles the native child surface after Chromium creates the tab', async () => {
    render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
      />
    );

    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(applyBrowserIntentMock).toHaveBeenCalledWith('browser-tab-1', {
        type: 'setSurface',
        surface: initialSurface,
      })
    );
  });

  it('clips the native surface below the toolbar and inside its outer panel', async () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.testid === 'browser-panel-root') {
          return rect(12, 12, 800, 636);
        }
        if (this.getAttribute('role') === 'toolbar') {
          return rect(12, 12, 800, 36);
        }
        return rect(-20, 20, 1030, 700);
      }
    );

    render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
      />
    );

    await waitFor(() =>
      expect(createBrowserTabMock).toHaveBeenCalledWith({
        initialUrl: 'https://example.test',
        profile: { kind: 'workspace', workspaceId: 'workspace-1' },
        surface: {
          x: 12,
          y: 48,
          width: 800,
          height: 600,
          scaleFactor: 2,
          visible: false,
        },
      })
    );
  });

  it('keeps the initial Web Preview as a launcher without creating an about:blank tab', async () => {
    const onOpenExternalTab = vi.fn();
    render(
      <BrowserPanel
        initialUrl={null}
        requestNonce={1}
        workspaceId="workspace-1"
        visible
        onOpenExternalTab={onOpenExternalTab}
      />
    );

    const address = screen.getByRole('textbox', { name: 'Address' });
    await waitFor(() => expect(address).toHaveValue(''));
    expect(address).toHaveFocus();
    expect(createBrowserTabMock).not.toHaveBeenCalled();
    expect(listenToBrowserEventsMock).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('tablist', { name: 'Browser Tabs' })
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('native-browser-surface')).toHaveClass(
      'bg-background'
    );
    expect(screen.getByTestId('native-browser-surface')).not.toHaveClass(
      'bg-transparent'
    );
    expect(
      screen.getByRole('heading', { name: /Start browsing|开始浏览/ })
    ).toBeVisible();
    expect(
      screen.getByText(/Enter a URL to open a page|输入 URL 以打开页面/)
    ).toBeVisible();
    expect(screen.getByTestId('native-browser-surface')).toHaveAttribute(
      'aria-hidden',
      'true'
    );

    fireEvent.change(address, { target: { value: 'localhost:5173' } });
    fireEvent.submit(address.closest('form')!);

    expect(onOpenExternalTab).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(createBrowserTabMock).toHaveBeenCalledWith(
        expect.objectContaining({
          initialUrl: 'http://localhost:5173',
        })
      )
    );
  });

  it('lazily creates the browser tab when a dev-server URL is detected', async () => {
    const view = render(
      <BrowserPanel
        initialUrl={null}
        requestNonce={0}
        workspaceId="workspace-1"
        visible
      />
    );

    expect(createBrowserTabMock).not.toHaveBeenCalled();

    view.rerender(
      <BrowserPanel
        initialUrl="http://localhost:5173"
        requestNonce={0}
        workspaceId="workspace-1"
        visible
      />
    );

    await waitFor(() =>
      expect(createBrowserTabMock).toHaveBeenCalledWith(
        expect.objectContaining({ initialUrl: 'http://localhost:5173' })
      )
    );
  });

  it('uses a fixed browser controls toolbar without glass spacing', async () => {
    render(
      <BrowserPanel
        initialUrl={null}
        requestNonce={1}
        workspaceId="workspace-1"
        visible
      />
    );

    const toolbar = screen.getByRole('toolbar', {
      name: 'Browser controls',
    });
    expect(toolbar).toHaveClass(
      'h-9',
      'border-b',
      'border-border',
      'bg-muted/40'
    );
    expect(toolbar).not.toHaveClass('web-preview-toolbar');
  });

  it('resizes and repositions the native surface with its Dockview panel', async () => {
    const view = render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
        layoutVersion={0}
      />
    );
    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());
    applyBrowserIntentMock.mockClear();

    const resizedSurface = {
      x: 36,
      y: 84,
      width: 520,
      height: 340,
      scaleFactor: initialSurface.scaleFactor,
      visible: true,
    };
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.testid === 'browser-panel-root') {
          return rect(36, 48, 520, 376);
        }
        if (this.getAttribute('role') === 'toolbar') {
          return rect(36, 48, 520, 36);
        }
        return rect(
          resizedSurface.x,
          resizedSurface.y,
          resizedSurface.width,
          resizedSurface.height
        );
      }
    );

    view.rerender(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
        layoutVersion={1}
      />
    );

    await waitFor(() =>
      expect(applyBrowserIntentMock).toHaveBeenCalledWith('browser-tab-1', {
        type: 'setSurface',
        surface: resizedSurface,
      })
    );
  });

  it('hides the native surface immediately when its workspace becomes hidden', async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    let nextFrameId = 1;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return nextFrameId++;
    });

    const view = render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
      />
    );

    act(() => {
      frameCallbacks.shift()?.(0);
      frameCallbacks.shift()?.(16);
    });
    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(applyBrowserIntentMock).toHaveBeenCalledWith(
        'browser-tab-1',
        expect.objectContaining({
          type: 'setSurface',
          surface: expect.objectContaining({ visible: true }),
        })
      )
    );
    applyBrowserIntentMock.mockClear();

    view.rerender(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible={false}
      />
    );

    expect(applyBrowserIntentMock).toHaveBeenCalledWith('browser-tab-1', {
      type: 'setSurface',
      surface: { ...initialSurface, visible: false },
    });
  });

  it('hides the native surface through the overlay bridge without changing panel visibility', async () => {
    render(
      <WorkspaceOverlayProvider>
        <BrowserPanel
          initialUrl="https://example.test"
          requestNonce={1}
          workspaceId="workspace-1"
          visible
        />
        <WorkspaceMenuTrigger />
      </WorkspaceOverlayProvider>
    );

    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(applyBrowserIntentMock).toHaveBeenCalledWith(
        'browser-tab-1',
        expect.objectContaining({
          type: 'setSurface',
          surface: expect.objectContaining({ visible: true }),
        })
      )
    );
    applyBrowserIntentMock.mockClear();

    fireEvent.click(
      screen.getByRole('button', { name: 'Open workspace menu' })
    );

    expect(applyBrowserIntentMock).toHaveBeenCalledWith('browser-tab-1', {
      type: 'setSurface',
      surface: { ...initialSurface, visible: false },
    });
  });

  it('hides the native surface while a toolbar select is open', async () => {
    render(
      <WorkspaceOverlayProvider>
        <BrowserPanel
          initialUrl="https://example.test"
          requestNonce={1}
          workspaceId="workspace-1"
          visible
        />
      </WorkspaceOverlayProvider>
    );

    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(applyBrowserIntentMock).toHaveBeenCalledWith(
        'browser-tab-1',
        expect.objectContaining({
          type: 'setSurface',
          surface: expect.objectContaining({ visible: true }),
        })
      )
    );
    applyBrowserIntentMock.mockClear();

    fireEvent.click(screen.getByRole('combobox', { name: 'Zoom' }));

    expect(screen.getByRole('listbox', { name: 'Zoom' })).toBeInTheDocument();
    expect(applyBrowserIntentMock).toHaveBeenCalledWith('browser-tab-1', {
      type: 'setSurface',
      surface: { ...initialSurface, visible: false },
    });
  });

  it('keeps the native Chromium tab when the preview host remounts', async () => {
    const view = render(
      <BrowserPanel
        initialUrl="https://www.baidu.com"
        requestNonce={1}
        panelId="web-preview:1"
        workspaceId="workspace-1"
        visible
      />
    );

    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(applyBrowserIntentMock).toHaveBeenCalledWith(
        'browser-tab-1',
        expect.objectContaining({
          type: 'setSurface',
          surface: expect.objectContaining({ visible: true }),
        })
      )
    );
    applyBrowserIntentMock.mockClear();

    view.unmount();
    expect(closeBrowserTabMock).not.toHaveBeenCalled();
    expect(applyBrowserIntentMock).toHaveBeenCalledWith('browser-tab-1', {
      type: 'setSurface',
      surface: { ...initialSurface, visible: false },
    });

    render(
      <BrowserPanel
        initialUrl="https://www.baidu.com"
        requestNonce={1}
        panelId="web-preview:1"
        workspaceId="workspace-1"
        visible
      />
    );

    await waitFor(() =>
      expect(applyBrowserIntentMock).toHaveBeenCalledWith(
        'browser-tab-1',
        expect.objectContaining({
          type: 'setSurface',
          surface: expect.objectContaining({ visible: true }),
        })
      )
    );
    expect(createBrowserTabMock).toHaveBeenCalledOnce();
    expect(closeBrowserTabMock).not.toHaveBeenCalled();
  });

  it('does not reveal a reclaimed tab while the workspace is hidden', async () => {
    const view = render(
      <BrowserPanel
        initialUrl="https://www.baidu.com"
        requestNonce={1}
        panelId="web-preview:hidden"
        workspaceId="workspace-1"
        visible
      />
    );

    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(applyBrowserIntentMock).toHaveBeenCalledWith(
        'browser-tab-1',
        expect.objectContaining({
          type: 'setSurface',
          surface: expect.objectContaining({ visible: true }),
        })
      )
    );

    view.unmount();
    applyBrowserIntentMock.mockClear();

    render(
      <BrowserPanel
        initialUrl="https://www.baidu.com"
        requestNonce={1}
        panelId="web-preview:hidden"
        workspaceId="workspace-1"
        visible={false}
      />
    );

    await waitFor(() =>
      expect(applyBrowserIntentMock).toHaveBeenCalledWith(
        'browser-tab-1',
        expect.objectContaining({
          type: 'setSurface',
          surface: expect.objectContaining({ visible: false }),
        })
      )
    );
    expect(applyBrowserIntentMock).not.toHaveBeenCalledWith(
      'browser-tab-1',
      expect.objectContaining({
        type: 'setSurface',
        surface: expect.objectContaining({ visible: true }),
      })
    );
  });

  it('creates a restored tab hidden when the workspace panel is not visible', async () => {
    render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible={false}
      />
    );

    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(applyBrowserIntentMock).toHaveBeenCalledWith(
        'browser-tab-1',
        expect.objectContaining({
          type: 'setSurface',
          surface: expect.objectContaining({ visible: false }),
        })
      )
    );
    expect(applyBrowserIntentMock).not.toHaveBeenCalledWith(
      'browser-tab-1',
      expect.objectContaining({
        type: 'setSurface',
        surface: expect.objectContaining({ visible: true }),
      })
    );
  });

  it('shows a horizontal page scrollbar when Chromium content exceeds the viewport', async () => {
    render(
      <BrowserPanel
        initialUrl="https://example.test/wide"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
      />
    );
    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());

    act(() => {
      browserEventListener?.({
        type: 'tabUpdated',
        tab: tab({ url: 'https://example.test/wide', loading: false }),
      });
    });

    let metricsRequestId = 0;
    await waitFor(() => {
      const metricsCall = applyBrowserIntentMock.mock.calls.find(
        ([, intent]) =>
          intent.type === 'executeDevTools' &&
          intent.method === 'Page.getLayoutMetrics'
      );
      expect(metricsCall).toBeDefined();
      metricsRequestId = metricsCall?.[1].requestId ?? 0;
    });
    act(() => {
      browserEventListener?.({
        type: 'devToolsResult',
        tabId: 'browser-tab-1',
        requestId: metricsRequestId,
        success: true,
        result: {
          cssContentSize: { width: 1600, height: 900 },
          cssLayoutViewport: {
            clientWidth: 800,
            clientHeight: 600,
            pageX: 0,
            pageY: 0,
          },
        },
      });
    });

    const scrollbar = await screen.findByRole('scrollbar', {
      name: 'Horizontal page scroll',
    });
    expect(scrollbar).toHaveAttribute('aria-valuemax', '800');

    scrollbar.scrollLeft = 320;
    fireEvent.scroll(scrollbar);

    await waitFor(() =>
      expect(applyBrowserIntentMock).toHaveBeenCalledWith(
        'browser-tab-1',
        expect.objectContaining({
          type: 'executeDevTools',
          method: 'Runtime.evaluate',
          params: expect.objectContaining({
            expression: 'window.scrollTo(320, window.scrollY)',
          }),
        })
      )
    );
  });

  it('forwards popup navigation to an outer preview tab', async () => {
    const onOpenExternalTab = vi.fn();
    render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
        onOpenExternalTab={onOpenExternalTab}
      />
    );
    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());

    act(() => {
      browserEventListener?.({
        type: 'popupCreated',
        openerTabId: 'browser-tab-1',
        tab: tab({
          id: 'browser-tab-2',
          url: 'https://example.test/popup',
          title: 'Popup',
          surface: { ...initialSurface, visible: false },
        }),
      });
    });

    expect(onOpenExternalTab).toHaveBeenCalledWith(
      'https://example.test/popup'
    );
    expect(closeBrowserTabMock).toHaveBeenCalledWith('browser-tab-2');
    expect(
      screen.queryByRole('tablist', { name: 'Browser Tabs' })
    ).not.toBeInTheDocument();
  });

  it('waits for a blank popup to receive its destination before opening an outer tab', async () => {
    const onOpenExternalTab = vi.fn();
    render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
        onOpenExternalTab={onOpenExternalTab}
      />
    );
    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());

    act(() => {
      browserEventListener?.({
        type: 'popupCreated',
        openerTabId: 'browser-tab-1',
        tab: tab({ id: 'browser-tab-2', url: 'about:blank', title: '' }),
      });
    });
    expect(onOpenExternalTab).not.toHaveBeenCalled();

    act(() => {
      browserEventListener?.({
        type: 'tabUpdated',
        tab: tab({
          id: 'browser-tab-2',
          url: 'https://example.test/redirected-popup',
          title: 'Redirected popup',
        }),
      });
    });

    expect(onOpenExternalTab).toHaveBeenCalledWith(
      'https://example.test/redirected-popup'
    );
    expect(closeBrowserTabMock).toHaveBeenCalledWith('browser-tab-2');
  });

  it('navigates the current preview tab from the address bar', async () => {
    const onOpenExternalTab = vi.fn();
    render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
        onOpenExternalTab={onOpenExternalTab}
      />
    );
    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());
    const address = screen.getByRole('textbox', { name: 'Address' });
    fireEvent.change(address, { target: { value: 'example.org/docs' } });
    fireEvent.submit(address.closest('form')!);

    expect(onOpenExternalTab).not.toHaveBeenCalled();
    expect(applyBrowserIntentMock).toHaveBeenCalledWith(
      'browser-tab-1',
      expect.objectContaining({
        type: 'navigate',
        url: 'https://example.org/docs',
      })
    );
    expect(createBrowserTabMock).toHaveBeenCalledOnce();
  });

  it('selects the current address when the URL field is focused', async () => {
    render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
      />
    );
    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());
    const select = vi.spyOn(HTMLInputElement.prototype, 'select');
    fireEvent.focus(screen.getByRole('textbox', { name: 'Address' }));
    expect(select).toHaveBeenCalled();
  });

  it('keeps a submitted address while the previous page is still reporting', async () => {
    const onLocationChange = vi.fn();
    const view = render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
        onLocationChange={onLocationChange}
      />
    );
    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());
    const address = screen.getByRole('textbox', { name: 'Address' });
    fireEvent.change(address, { target: { value: 'gmail.com' } });
    fireEvent.submit(address.closest('form')!);

    expect(address).toHaveValue('https://gmail.com');
    expect(onLocationChange).toHaveBeenCalledWith('https://gmail.com');
    expect(applyBrowserIntentMock).toHaveBeenCalledWith(
      'browser-tab-1',
      expect.objectContaining({
        type: 'navigate',
        url: 'https://gmail.com',
      })
    );
    applyBrowserIntentMock.mockClear();

    act(() => {
      browserEventListener?.({
        type: 'tabUpdated',
        tab: tab({ url: 'https://example.test/', loading: true }),
      });
    });
    expect(address).toHaveValue('https://gmail.com');

    view.rerender(
      <BrowserPanel
        initialUrl="https://gmail.com"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
        onLocationChange={onLocationChange}
      />
    );
    expect(applyBrowserIntentMock).not.toHaveBeenCalledWith(
      'browser-tab-1',
      expect.objectContaining({ type: 'navigate' })
    );
  });

  it('ignores aborted load errors from a superseded navigation', async () => {
    render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
      />
    );
    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());

    act(() => {
      browserEventListener?.({
        type: 'tabFailed',
        tab: tab({ loading: false }),
        code: 'ERR_ABORTED',
        message: 'net::ERR_ABORTED',
      });
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('requires an explicit user decision for Chromium permissions', async () => {
    render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
      />
    );
    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());

    act(() => {
      browserEventListener?.({
        type: 'permissionRequested',
        tabId: 'browser-tab-1',
        requestId: 9,
        origin: 'https://example.test',
        kind: 'media',
        requestedPermissions: 3,
      });
    });

    expect(screen.getByText(/example\.test wants media access/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Allow Permission' }));
    expect(applyBrowserIntentMock).toHaveBeenCalledWith('browser-tab-1', {
      type: 'resolvePermission',
      requestId: 9,
      allow: true,
    });
  });

  it('shows Chromium download progress and allows cancellation', async () => {
    render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
      />
    );
    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());

    act(() => {
      browserEventListener?.({
        type: 'downloadUpdated',
        tabId: 'browser-tab-1',
        downloadId: 11,
        url: 'https://example.test/archive.zip',
        fileName: 'archive.zip',
        receivedBytes: 512,
        totalBytes: 1024,
        percentComplete: 50,
        state: 'inProgress',
      });
    });

    expect(screen.getByText(/archive\.zip/)).toHaveTextContent('50%');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Download' }));
    expect(applyBrowserIntentMock).toHaveBeenCalledWith('browser-tab-1', {
      type: 'cancelDownload',
      downloadId: 11,
    });
  });

  it('navigates from the address bar and closes the native tab on unmount', async () => {
    const view = render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId={undefined}
        visible
      />
    );

    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Developer Tools' })
      ).toBeEnabled()
    );
    const address = screen.getByRole('textbox', { name: 'Address' });
    fireEvent.change(address, { target: { value: 'localhost:5173' } });
    fireEvent.submit(address.closest('form')!);

    expect(applyBrowserIntentMock).toHaveBeenCalledWith('browser-tab-1', {
      type: 'navigate',
      url: 'http://localhost:5173',
    });

    view.unmount();
    await waitFor(() =>
      expect(closeBrowserTabMock).toHaveBeenCalledWith('browser-tab-1')
    );
  });

  it('exposes native zoom and find controls without touching page code', async () => {
    render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
      />
    );
    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());

    const zoom = screen.getByRole('combobox', { name: 'Zoom' });
    expect(zoom).toHaveTextContent('80%');

    fireEvent.click(zoom);
    expect(
      screen.getAllByRole('option').map((option) => option.textContent)
    ).toEqual(['50%', '80%', '90%', '100%', '110%', '125%', '150%']);

    const level80 = Math.log(0.8) / Math.log(1.2);
    fireEvent.click(screen.getByRole('option', { name: '80%' }));
    expect(applyBrowserIntentMock).toHaveBeenCalledWith('browser-tab-1', {
      type: 'setZoom',
      level: level80,
    });

    act(() => {
      browserEventListener?.({
        type: 'tabUpdated',
        tab: tab({ zoomLevel: -1 }),
      });
    });
    expect(zoom).toHaveTextContent('80%');

    fireEvent.click(screen.getByRole('button', { name: 'Find in Page' }));
    const findInput = screen.getByRole('textbox', { name: 'Find in Page' });
    fireEvent.change(findInput, { target: { value: 'runtime' } });
    fireEvent.submit(findInput.closest('form')!);
    expect(applyBrowserIntentMock).toHaveBeenCalledWith('browser-tab-1', {
      type: 'find',
      query: 'runtime',
      forward: true,
      matchCase: false,
      findNext: false,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close Find' }));
    expect(applyBrowserIntentMock).toHaveBeenCalledWith('browser-tab-1', {
      type: 'stopFinding',
    });
  });

  it('hides the native surface so a load error remains visible', async () => {
    render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
      />
    );
    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());

    act(() => {
      browserEventListener?.({
        type: 'tabFailed',
        tab: tab({ loading: false }),
        code: 'ERR_NAME_NOT_RESOLVED',
        message: 'The host could not be resolved.',
      });
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('ERR_NAME_NOT_RESOLVED');
    expect(alert).not.toHaveTextContent('The host could not be resolved.');
    fireEvent.click(screen.getByRole('button', { name: /try again|重试/i }));
    expect(applyBrowserIntentMock).toHaveBeenCalledWith(
      'browser-tab-1',
      expect.objectContaining({
        type: 'navigate',
        url: 'https://example.test/',
      })
    );
    await waitFor(() =>
      expect(applyBrowserIntentMock).toHaveBeenCalledWith('browser-tab-1', {
        type: 'setSurface',
        surface: { ...initialSurface, visible: false },
      })
    );
  });

  it('always supplies Chromium highlight configuration when inspection stops', async () => {
    render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
        onInspectElement={vi.fn()}
      />
    );
    const selectElement = await startElementInspection();

    fireEvent.click(selectElement);

    await waitFor(() =>
      expect(applyBrowserIntentMock).toHaveBeenLastCalledWith(
        'browser-tab-1',
        expect.objectContaining({
          type: 'executeDevTools',
          requestId: 4,
          method: 'Overlay.setInspectMode',
          params: expect.objectContaining({
            mode: 'none',
            highlightConfig: expect.objectContaining({ showInfo: true }),
          }),
        })
      )
    );
  });

  it('stops element inspection before reloading the page', async () => {
    render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
        onInspectElement={vi.fn()}
      />
    );
    await startElementInspection();

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

    await waitFor(() =>
      expect(applyBrowserIntentMock).toHaveBeenLastCalledWith(
        'browser-tab-1',
        expect.objectContaining({
          type: 'executeDevTools',
          requestId: 4,
          method: 'Overlay.setInspectMode',
          params: expect.objectContaining({
            mode: 'none',
            highlightConfig: expect.any(Object),
          }),
        })
      )
    );
    expect(applyBrowserIntentMock).not.toHaveBeenCalledWith('browser-tab-1', {
      type: 'reload',
    });
    act(() => {
      browserEventListener?.({
        type: 'devToolsResult',
        tabId: 'browser-tab-1',
        requestId: 4,
        success: true,
        result: {},
      });
    });
    await waitFor(() =>
      expect(applyBrowserIntentMock).toHaveBeenCalledWith('browser-tab-1', {
        type: 'reload',
      })
    );
  });

  it('selects a page element through CDP without injecting application code', async () => {
    const onInspectElement = vi.fn();
    render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
        onInspectElement={onInspectElement}
      />
    );
    await startElementInspection();
    act(() => {
      browserEventListener?.({
        type: 'devToolsEvent',
        tabId: 'browser-tab-1',
        method: 'Overlay.inspectNodeRequested',
        params: { backendNodeId: 77 },
      });
    });
    await waitFor(() =>
      expect(applyBrowserIntentMock).toHaveBeenLastCalledWith('browser-tab-1', {
        type: 'executeDevTools',
        requestId: 4,
        method: 'DOM.describeNode',
        params: { backendNodeId: 77 },
      })
    );
    act(() => {
      browserEventListener?.({
        type: 'devToolsResult',
        tabId: 'browser-tab-1',
        requestId: 4,
        success: true,
        result: {
          node: {
            backendNodeId: 77,
            localName: 'button',
            nodeName: 'BUTTON',
            attributes: ['id', 'save', 'class', 'primary', 'role', 'button'],
          },
        },
      });
    });
    await waitFor(() =>
      expect(applyBrowserIntentMock).toHaveBeenLastCalledWith('browser-tab-1', {
        type: 'executeDevTools',
        requestId: 5,
        method: 'DOM.getOuterHTML',
        params: { backendNodeId: 77 },
      })
    );
    act(() => {
      browserEventListener?.({
        type: 'devToolsResult',
        tabId: 'browser-tab-1',
        requestId: 5,
        success: true,
        result: { outerHTML: '<button id="save">Save</button>' },
      });
    });

    await waitFor(() =>
      expect(onInspectElement).toHaveBeenCalledWith(
        expect.objectContaining({
          selected: expect.objectContaining({ name: 'button' }),
          clickedElement: {
            tag: 'button',
            id: 'save',
            className: 'primary',
            role: 'button',
            dataset: { preview: '<button id="save">Save</button>' },
          },
        })
      )
    );
  });
});
