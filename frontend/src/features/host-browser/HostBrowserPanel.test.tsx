import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { ADDRESS_HISTORY_KEY } from './addressSuggestions';
import { setBrowserTabOpenHandler } from './openBrowserTab';
import {
  elementChipLabel,
  HostBrowserPanel,
  tabStateClearsLoading,
} from './HostBrowserPanel';

const backendCall = vi.hoisted(() => vi.fn());
const backendListen = vi.hoisted(() => {
  const fn = vi.fn(
    async (_event: string, handler: (payload: unknown) => void) => {
      fn.handlers.push(handler);
      return () => {};
    }
  ) as ReturnType<typeof vi.fn> & {
    handlers: Array<(payload: unknown) => void>;
  };
  fn.handlers = [];
  return fn;
});

vi.mock('@/lib/backendTransport', () => ({
  backendCall,
  backendListen,
  backendEmit: vi.fn(async () => {}),
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  useOptionalPanelActionsContext: () => null,
}));

vi.mock('@/contexts/WorkspaceOverlayContext', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/contexts/WorkspaceOverlayContext')>();
  return {
    ...actual,
    useWorkspaceOverlay: () => ({
      setTabCreationMenuOpen: () => {},
      setHtmlOverlayOpen: () => {},
      setHtmlOverlayRect: () => {},
      subscribeNativeSurfaceOcclusion: (
        listener: (value: { hide: boolean; rects: unknown[] }) => void
      ) => {
        listener({ hide: false, rects: [] });
        return () => {};
      },
    }),
  };
});

describe('HostBrowserPanel', () => {
  beforeEach(() => {
    backendCall.mockReset();
    backendListen.handlers = [];
    window.localStorage.clear();
    setBrowserTabOpenHandler(null);
  });

  it('shows the invoke error message instead of [object Object]', async () => {
    const user = userEvent.setup();
    backendCall.mockRejectedValue({
      message:
        'failed to start MCP server: MCP error -32000: Connection closed',
    });
    render(
      <HostBrowserPanel
        pluginId="vibex.browser"
        panelVisible
        requestedUrl={null}
      />
    );

    await user.type(
      screen.getByRole('combobox'),
      'https://grok.com/imagine{enter}'
    );

    expect(
      await screen.findByText(
        'failed to start MCP server: MCP error -32000: Connection closed'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText('[object Object]')).not.toBeInTheDocument();
  });

  it('opens a tab through browser.dispatch', async () => {
    const user = userEvent.setup();
    backendCall.mockResolvedValue({
      tabId: 'tab-1',
      url: 'https://example.com/',
      title: 'Example',
      grant: { level: 'none' },
    });
    render(
      <HostBrowserPanel
        pluginId="vibex.browser"
        panelVisible
        requestedUrl={null}
      />
    );

    await user.type(screen.getByRole('combobox'), 'baidu.com{enter}');

    await waitFor(() => {
      expect(backendCall).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(backendCall).toHaveBeenCalledWith('plugin_invoke_contribution', {
        pluginId: 'vibex.browser',
        handler: 'browser.dispatch',
        input: {
          operation: 'tab.create',
          input: expect.objectContaining({
            url: 'https://baidu.com/',
            bounds: expect.objectContaining({
              width: expect.any(Number),
              height: expect.any(Number),
              visible: false,
            }),
          }),
        },
      });
    });

    backendCall.mockClear();
    backendCall.mockResolvedValue({
      tabId: 'tab-1',
      url: 'https://example.com/about',
      title: 'Example',
      grant: { level: 'control' },
    });
    await user.clear(screen.getByRole('combobox'));
    await user.type(
      screen.getByRole('combobox'),
      'https://example.com/about{enter}'
    );
    await waitFor(() => {
      expect(backendCall).toHaveBeenCalledWith('plugin_invoke_contribution', {
        pluginId: 'vibex.browser',
        handler: 'browser.dispatch',
        input: {
          operation: 'tab.navigate',
          input: { tabId: 'tab-1', url: 'https://example.com/about' },
        },
      });
    });
    await user.click(
      screen.getByRole('button', {
        name: i18n.t('browserPanel.more', { ns: 'panels' }),
      })
    );
    const copyUrl = await screen.findByRole('menuitem', {
      name: i18n.t('browserPanel.copyUrl', { ns: 'panels' }),
    });
    expect(copyUrl).toBeInTheDocument();
    expect(screen.getByTestId('host-browser-surface').contains(copyUrl)).toBe(
      false
    );
    expect(
      screen.getByRole('menuitem', {
        name: i18n.t('browserPanel.zoom', { ns: 'panels' }),
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', {
        name: i18n.t('browserPanel.device', { ns: 'panels' }),
      })
    ).toBeInTheDocument();
  });

  it('keeps the shared-access chip outside the address field', async () => {
    const user = userEvent.setup();
    backendCall.mockResolvedValue({
      tabId: 'tab-share',
      url: 'https://github.com/',
      title: 'GitHub',
      grant: { level: 'control' },
    });
    render(
      <HostBrowserPanel
        pluginId="vibex.browser"
        panelVisible
        requestedUrl={null}
      />
    );
    await user.type(screen.getByRole('combobox'), 'github.com{enter}');
    const shared = await screen.findByRole('button', {
      name: i18n.t('browserPanel.sharedControl', { ns: 'panels' }),
    });
    expect(
      screen.getByRole('combobox').closest('.relative')?.contains(shared)
    ).toBe(false);
  });

  it('pushes the latest host rect when the panel moves', async () => {
    const user = userEvent.setup();
    backendCall.mockResolvedValue({
      tabId: 'tab-1',
      url: 'https://github.com/',
      title: 'GitHub',
      grant: { level: 'none' },
    });
    render(
      <HostBrowserPanel
        pluginId="vibex.browser"
        panelVisible
        requestedUrl={null}
      />
    );
    await user.type(screen.getByRole('combobox'), 'github.com{enter}');
    await waitFor(() => {
      expect(backendCall).toHaveBeenCalledWith(
        'plugin_invoke_contribution',
        expect.objectContaining({
          input: expect.objectContaining({ operation: 'tab.create' }),
        })
      );
    });

    const surface = screen.getByTestId('host-browser-surface');
    let rect = {
      x: 400,
      y: 80,
      width: 800,
      height: 500,
      top: 80,
      left: 400,
      right: 1200,
      bottom: 580,
      toJSON() {
        return this;
      },
    };
    surface.getBoundingClientRect = () => rect as DOMRect;

    backendCall.mockClear();
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => {
      expect(backendCall).toHaveBeenCalledWith('plugin_invoke_contribution', {
        pluginId: 'vibex.browser',
        handler: 'browser.dispatch',
        input: {
          operation: 'surface.set',
          input: {
            tabId: 'tab-1',
            bounds: expect.objectContaining({
              x: 400,
              y: 80,
              width: 800,
              height: 500,
              visible: true,
            }),
          },
        },
      });
    });

    rect = {
      ...rect,
      x: 200,
      left: 200,
      width: 600,
      right: 800,
    };
    backendCall.mockClear();
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => {
      expect(backendCall).toHaveBeenCalledWith('plugin_invoke_contribution', {
        pluginId: 'vibex.browser',
        handler: 'browser.dispatch',
        input: {
          operation: 'surface.set',
          input: {
            tabId: 'tab-1',
            bounds: expect.objectContaining({
              x: 200,
              width: 600,
              visible: true,
            }),
          },
        },
      });
    });
  });

  it('shares the tab with agents from the address bar', async () => {
    const label = (key: string) =>
      i18n.t(`browserPanel.${key}`, { ns: 'panels' });
    render(
      <HostBrowserPanel
        pluginId="vibex.browser"
        panelVisible
        requestedUrl={null}
      />
    );
    expect(
      screen.getByRole('button', { name: label('back') })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: label('forward') })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: label('reload') })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: label('pick') })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: label('more') })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: label('device') })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: label('zoom') })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: label('address') })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: label('devtools') })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: label('share') })
    ).toBeInTheDocument();
    const addressField = screen.getByRole('combobox', { name: label('address') });
    const share = screen.getByRole('button', { name: label('share') });
    expect(addressField.closest('.relative')?.contains(share)).toBe(false);
  });

  it('applies load-finished events that arrive before tab.create returns', async () => {
    const user = userEvent.setup();
    let finishCreate: (value: unknown) => void = () => {};
    const created = new Promise((resolve) => {
      finishCreate = resolve;
    });
    backendCall.mockImplementation(
      (_command: string, args: { input?: { operation?: string } }) => {
        if (args?.input?.operation === 'tab.create') return created;
        return Promise.resolve({ ok: true });
      }
    );
    render(
      <HostBrowserPanel
        pluginId="vibex.browser"
        panelVisible
        requestedUrl={null}
      />
    );
    await user.type(screen.getByRole('combobox'), 'github.com{enter}');
    await waitFor(() =>
      expect(backendListen.handlers.length).toBeGreaterThan(0)
    );
    for (const handler of backendListen.handlers) {
      handler({
        kind: 'tab.state',
        tabId: 'tab-1',
        url: 'https://github.com/',
        title: 'GitHub',
        loading: false,
      });
    }
    finishCreate({
      tabId: 'tab-1',
      url: 'https://github.com/',
      title: 'GitHub',
      grant: { level: 'none' },
    });
    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: i18n.t('browserPanel.reload', { ns: 'panels' }),
        })
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText(i18n.t('browserPanel.loadFailed', { ns: 'panels' }))
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('host-browser-surface')).toBeInTheDocument();
  });

  it('updates the dock title from the page while loading', async () => {
    const user = userEvent.setup();
    const setTitle = vi.fn();
    backendCall.mockImplementation(
      (_command: string, args: { input?: { operation?: string } }) => {
        if (
          args?.input?.operation === 'tab.chrome' ||
          args?.input?.operation === 'tab.title'
        ) {
          return Promise.resolve({ title: 'GitHub', favicon: '' });
        }
        return Promise.resolve({
          tabId: 'tab-1',
          url: 'https://github.com/',
          title: '',
          grant: { level: 'none' },
        });
      }
    );
    render(
      <HostBrowserPanel
        pluginId="vibex.browser"
        panelVisible
        requestedUrl={null}
        panelApi={{ updateParameters: () => {}, setTitle }}
      />
    );
    await user.type(screen.getByRole('combobox'), 'github.com{enter}');
    await waitFor(() => {
      expect(setTitle).toHaveBeenCalledWith('GitHub');
    });
  });

  it('opens a new browser tab when the engine asks for tab.open', async () => {
    const opened: Array<{ url?: string | null; nativeTabId?: string | null }> =
      [];
    setBrowserTabOpenHandler((request) => {
      opened.push({ url: request.url, nativeTabId: request.nativeTabId });
    });
    const user = userEvent.setup();
    backendCall.mockResolvedValue({
      tabId: 'tab-1',
      url: 'https://github.com/',
      title: 'GitHub',
      grant: { level: 'none' },
    });
    render(
      <HostBrowserPanel
        pluginId="vibex.browser"
        panelVisible
        requestedUrl={null}
      />
    );
    await user.type(screen.getByRole('combobox'), 'github.com{enter}');
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveValue('https://github.com/');
    });
    for (const handler of backendListen.handlers) {
      handler({
        kind: 'tab.open',
        url: 'https://github.com/xintaofei/codeg',
        sourceTabId: 'tab-1',
        tabId: 'tab-2',
      });
    }
    await waitFor(() => {
      expect(opened).toEqual([
        {
          url: 'https://github.com/xintaofei/codeg',
          nativeTabId: 'tab-2',
        },
      ]);
    });
    setBrowserTabOpenHandler(null);
  });

  it('opens a new browser tab from a target=_blank click that has no adopted view', async () => {
    const opened: Array<{ url?: string | null; nativeTabId?: string | null }> =
      [];
    setBrowserTabOpenHandler((request) => {
      opened.push({ url: request.url, nativeTabId: request.nativeTabId });
    });
    const user = userEvent.setup();
    backendCall.mockResolvedValue({
      tabId: 'tab-1',
      url: 'https://github.com/',
      title: 'GitHub',
      grant: { level: 'none' },
    });
    render(
      <HostBrowserPanel
        pluginId="vibex.browser"
        panelVisible
        requestedUrl={null}
      />
    );
    await user.type(screen.getByRole('combobox'), 'github.com{enter}');
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveValue('https://github.com/');
    });
    for (const handler of backendListen.handlers) {
      handler({
        kind: 'tab.open',
        url: 'https://example.com/from-blank',
        sourceTabId: 'tab-1',
      });
    }
    await waitFor(() => {
      expect(opened).toEqual([
        {
          url: 'https://example.com/from-blank',
          nativeTabId: undefined,
        },
      ]);
    });
    setBrowserTabOpenHandler(null);
  });

  it('updates the address bar when the current tab navigates in place', async () => {
    const user = userEvent.setup();
    const updateParameters = vi.fn();
    backendCall.mockResolvedValue({
      tabId: 'tab-1',
      url: 'https://example.com/',
      title: 'Example Domain',
      grant: { level: 'none' },
    });
    render(
      <HostBrowserPanel
        pluginId="vibex.browser"
        panelVisible
        requestedUrl={null}
        panelApi={{ updateParameters, setTitle: () => {} }}
      />
    );
    await user.type(screen.getByRole('combobox'), 'example.com{enter}');
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveValue('https://example.com/');
    });
    for (const handler of backendListen.handlers) {
      handler({
        kind: 'tab.state',
        tabId: 'tab-1',
        url: 'https://www.iana.org/domains/example',
        loading: true,
      });
    }
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveValue(
        'https://www.iana.org/domains/example'
      );
    });
    expect(updateParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedUrl: 'https://www.iana.org/domains/example',
        nativeTabId: 'tab-1',
      })
    );
  });

  it('applies a page favicon while the document is still loading', async () => {
    const user = userEvent.setup();
    const updateParameters = vi.fn();
    backendCall.mockImplementation(
      (_command: string, args: { input?: { operation?: string } }) => {
        if (args?.input?.operation === 'tab.chrome') {
          return Promise.resolve({
            title: 'GitHub',
            favicon: 'https://github.githubassets.com/favicons/favicon.svg',
            url: 'https://github.com/',
          });
        }
        return Promise.resolve({
          tabId: 'tab-1',
          url: 'https://github.com/',
          title: '',
          grant: { level: 'none' },
        });
      }
    );
    render(
      <HostBrowserPanel
        pluginId="vibex.browser"
        panelVisible
        requestedUrl={null}
        panelApi={{ updateParameters, setTitle: vi.fn() }}
      />
    );
    await user.type(screen.getByRole('combobox'), 'github.com{enter}');
    await waitFor(() => {
      expect(updateParameters).toHaveBeenCalledWith(
        expect.objectContaining({
          faviconUrl: 'https://github.githubassets.com/favicons/favicon.svg',
        })
      );
    });
  });

  it('suggests only URLs, with visited rows last and titled', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      ADDRESS_HISTORY_KEY,
      JSON.stringify([
        {
          url: 'https://github.com/xintaofei/codeg',
          title: 'xintaofei/codeg: Collaborative multi-agent AI coding workspace',
          favicon: 'https://github.com/favicon.ico',
          visitedAt: 20,
        },
        {
          url: 'https://github.com/Xircth/VibeX',
          title: 'Xircth/VibeX: IADE',
          favicon: 'https://github.com/favicon.ico',
          visitedAt: 40,
        },
      ])
    );
    render(
      <HostBrowserPanel
        pluginId="vibex.browser"
        panelVisible
        requestedUrl={null}
      />
    );
    await user.type(screen.getByRole('combobox'), 'github');
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('xintaofei/codeg');
    expect(options[1]).toHaveTextContent('Xircth/VibeX');
    expect(options[0].querySelector('img')?.getAttribute('src')).toBe(
      'https://github.com/favicon.ico'
    );
    expect(screen.queryByText(/镜像站|releases/)).not.toBeInTheDocument();
  });

  it('updates the address bar from an in-page navigation even while focused', async () => {
    const user = userEvent.setup();
    backendCall.mockResolvedValue({
      tabId: 'tab-1',
      url: 'https://github.com/',
      title: 'GitHub',
      grant: { level: 'none' },
    });
    render(
      <HostBrowserPanel
        pluginId="vibex.browser"
        panelVisible
        requestedUrl={null}
      />
    );
    const address = screen.getByRole('combobox');
    await user.type(address, 'github.com{enter}');
    await waitFor(() => {
      expect(address).toHaveValue('https://github.com/');
      expect(
        screen.getByRole('button', {
          name: i18n.t('browserPanel.stop', { ns: 'panels' }),
        })
      ).toBeEnabled();
    });
    await user.click(screen.getByTestId('host-browser-surface'));
    for (const handler of backendListen.handlers) {
      handler({
        kind: 'tab.state',
        tabId: 'tab-1',
        url: 'https://github.com/xintaofei/codeg',
        title: 'xintaofei/codeg',
        loading: true,
      });
    }
    await waitFor(() => {
      expect(address).toHaveValue('https://github.com/xintaofei/codeg');
    });
  });

  it('hides the native page when the dock panel is no longer visible', async () => {
    const user = userEvent.setup();
    backendCall.mockResolvedValue({
      tabId: 'tab-hide',
      url: 'https://github.com/',
      title: 'GitHub',
      grant: { level: 'none' },
    });
    const { rerender } = render(
      <HostBrowserPanel
        pluginId="vibex.browser"
        panelVisible
        requestedUrl={null}
      />
    );
    await user.type(screen.getByRole('combobox'), 'github.com{enter}');
    await waitFor(() => {
      expect(backendCall).toHaveBeenCalledWith(
        'plugin_invoke_contribution',
        expect.objectContaining({
          input: expect.objectContaining({ operation: 'tab.create' }),
        })
      );
    });
    const surface = screen.getByTestId('host-browser-surface');
    surface.getBoundingClientRect = () =>
      ({
        x: 400,
        y: 80,
        width: 800,
        height: 500,
        top: 80,
        left: 400,
        right: 1200,
        bottom: 580,
        toJSON() {
          return this;
        },
      }) as DOMRect;
    backendCall.mockClear();
    rerender(
      <HostBrowserPanel
        pluginId="vibex.browser"
        panelVisible={false}
        requestedUrl={null}
      />
    );
    await waitFor(() => {
      expect(backendCall).toHaveBeenCalledWith('plugin_invoke_contribution', {
        pluginId: 'vibex.browser',
        handler: 'browser.dispatch',
        input: {
          operation: 'surface.set',
          input: {
            tabId: 'tab-hide',
            bounds: expect.objectContaining({ visible: false }),
          },
        },
      });
    });
  });

  it('hides the native page when the project layout still has the panel', async () => {
    const user = userEvent.setup();
    backendCall.mockResolvedValue({
      tabId: 'tab-keep',
      url: 'https://github.com/',
      title: 'GitHub',
      grant: { level: 'none' },
    });
    const panelId = 'plugin:vibex.browser/browser:1';
    const { unmount } = render(
      <HostBrowserPanel
        pluginId="vibex.browser"
        panelVisible
        requestedUrl={null}
        panelApi={{ id: panelId, updateParameters: () => {} }}
      />
    );
    await user.type(screen.getByRole('combobox'), 'github.com{enter}');
    await waitFor(() => {
      expect(backendCall).toHaveBeenCalledWith(
        'plugin_invoke_contribution',
        expect.objectContaining({
          input: expect.objectContaining({ operation: 'tab.create' }),
        })
      );
    });
    useLayoutStore.setState({
      serializedLayout: {
        panels: { [panelId]: { id: panelId } },
      } as never,
    });
    backendCall.mockClear();
    unmount();
    await waitFor(() => {
      expect(backendCall).toHaveBeenCalledWith('plugin_invoke_contribution', {
        pluginId: 'vibex.browser',
        handler: 'browser.dispatch',
        input: {
          operation: 'surface.set',
          input: {
            tabId: 'tab-keep',
            bounds: expect.objectContaining({ visible: false }),
          },
        },
      });
    });
    await new Promise((resolve) => {
      window.setTimeout(resolve, 80);
    });
    expect(backendCall).not.toHaveBeenCalledWith(
      'plugin_invoke_contribution',
      expect.objectContaining({
        input: expect.objectContaining({ operation: 'tab.close' }),
      })
    );
  });

  it('keeps element chips short', () => {
    expect(
      tabStateClearsLoading(
        { loading: false, url: 'https://github.com/', title: 'GitHub' },
        'https://github.com/'
      )
    ).toBe(true);
    expect(
      tabStateClearsLoading(
        { loading: false, url: '', title: 'GitHub' },
        'https://github.com/'
      )
    ).toBe(false);
    expect(
      tabStateClearsLoading(
        { loading: false, url: '', title: '' },
        'https://github.com/'
      )
    ).toBe(false);
    expect(
      elementChipLabel({
        tag: 'area',
        label: 'area#copilot-chat-textarea.ChatInput-module__input__IPYf_',
      })
    ).toBe('@area');
  });
});
