import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
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
      screen.getByRole('textbox'),
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

    await user.type(screen.getByRole('textbox'), 'baidu.com{enter}');

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
    await user.clear(screen.getByRole('textbox'));
    await user.type(
      screen.getByRole('textbox'),
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
    await user.type(screen.getByRole('textbox'), 'github.com{enter}');
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

  it('exposes navigation tools without a share control', async () => {
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
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: label('devtools') })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: label('zoom') })
    ).toBeInTheDocument();
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
    await user.type(screen.getByRole('textbox'), 'github.com{enter}');
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
    await user.type(screen.getByRole('textbox'), 'github.com{enter}');
    await waitFor(() => {
      expect(setTitle).toHaveBeenCalledWith('GitHub');
    });
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
    ).toBe(true);
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
