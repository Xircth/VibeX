import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPanel } from './BrowserPanel';
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

function tab(overrides: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id: 'browser-tab-1',
    url: 'https://example.test/',
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    zoomLevel: 0,
    profile: { kind: 'workspace', workspaceId: 'workspace-1' },
    surface: initialSurface,
    ...overrides,
  };
}

describe('BrowserPanel', () => {
  let browserEventListener: ((event: BrowserEvent) => void) | undefined;

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: initialSurface.x,
      y: initialSurface.y,
      top: initialSurface.y,
      left: initialSurface.x,
      right: initialSurface.x + initialSurface.width,
      bottom: initialSurface.y + initialSurface.height,
      width: initialSurface.width,
      height: initialSurface.height,
      toJSON: () => ({}),
    });
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
        initialUrl={null}
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

  it('opens a fresh browser on a focused empty address field', async () => {
    createBrowserTabMock.mockResolvedValue(
      tab({ url: 'about:blank', title: '', loading: false })
    );
    render(
      <BrowserPanel
        initialUrl={null}
        requestNonce={1}
        workspaceId="workspace-1"
        visible
      />
    );

    await waitFor(() =>
      expect(createBrowserTabMock).toHaveBeenCalledWith(
        expect.objectContaining({ initialUrl: 'about:blank' })
      )
    );
    const address = screen.getByRole('textbox', { name: 'Address' });
    await waitFor(() => expect(address).toHaveValue(''));
    expect(address).toHaveFocus();
    expect(screen.getByTestId('native-browser-surface')).toHaveClass(
      'bg-background'
    );
    expect(screen.getByTestId('native-browser-surface')).not.toHaveClass(
      'bg-transparent'
    );
  });

  it('resizes and repositions the native surface with its Dockview panel', async () => {
    const view = render(
      <BrowserPanel
        initialUrl={null}
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
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
      x: resizedSurface.x,
      y: resizedSurface.y,
      top: resizedSurface.y,
      left: resizedSurface.x,
      right: resizedSurface.x + resizedSurface.width,
      bottom: resizedSurface.y + resizedSurface.height,
      width: resizedSurface.width,
      height: resizedSurface.height,
      toJSON: () => ({}),
    });

    view.rerender(
      <BrowserPanel
        initialUrl={null}
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

  it('keeps popup navigation in a managed native tab strip', async () => {
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

    expect(await screen.findByRole('tab', { name: 'Popup' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(applyBrowserIntentMock).toHaveBeenCalledWith('browser-tab-1', {
      type: 'setSurface',
      surface: { ...initialSurface, visible: false },
    });
    expect(applyBrowserIntentMock).toHaveBeenCalledWith('browser-tab-2', {
      type: 'setSurface',
      surface: initialSurface,
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Example' }));
    expect(screen.getByRole('tab', { name: 'Example' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('opens an explicit blank Chromium tab from the browser tab strip', async () => {
    createBrowserTabMock.mockResolvedValueOnce(tab()).mockResolvedValueOnce(
      tab({
        id: 'browser-tab-2',
        url: 'about:blank',
        title: '',
        surface: { ...initialSurface, visible: false },
      })
    );
    render(
      <BrowserPanel
        initialUrl={null}
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
    applyBrowserIntentMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'New Tab' }));

    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledTimes(2));
    expect(createBrowserTabMock).toHaveBeenLastCalledWith({
      initialUrl: 'about:blank',
      profile: { kind: 'workspace', workspaceId: 'workspace-1' },
      surface: { ...initialSurface, visible: false },
    });
    expect(await screen.findByRole('tab', { name: 'New Tab' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(applyBrowserIntentMock).toHaveBeenCalledWith('browser-tab-1', {
      type: 'setSurface',
      surface: { ...initialSurface, visible: false },
    });
    expect(applyBrowserIntentMock).toHaveBeenCalledWith('browser-tab-2', {
      type: 'setSurface',
      surface: initialSurface,
    });
  });

  it('closes a browser-strip tab through the owned browser runtime', async () => {
    render(
      <BrowserPanel
        initialUrl="https://example.test"
        requestNonce={1}
        workspaceId="workspace-1"
        visible
      />
    );
    await waitFor(() => expect(createBrowserTabMock).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Close Example' }));

    expect(closeBrowserTabMock).toHaveBeenCalledOnce();
    expect(closeBrowserTabMock).toHaveBeenCalledWith('browser-tab-1');
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

    const zoom = screen.getByRole('combobox', {
      name: 'Zoom',
    }) as HTMLSelectElement;
    expect(Array.from(zoom.options, (option) => option.textContent)).toEqual([
      '50%',
      '80%',
      '90%',
      '100%',
      '110%',
      '125%',
      '150%',
    ]);
    expect(Array.from(zoom.options, (option) => option.value)).toEqual([
      '50',
      '80',
      '90',
      '100',
      '110',
      '125',
      '150',
    ]);
    expect(zoom).toHaveValue('100');
    const level80 = Math.log(0.8) / Math.log(1.2);
    fireEvent.change(zoom, {
      target: { value: '80' },
    });
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
    expect(zoom).toHaveValue('80');

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

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The host could not be resolved.'
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
