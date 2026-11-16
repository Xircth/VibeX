import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { useBackendTransport } from '@/lib/transport';
import {
  disconnectWebSession,
  WebTransportBootstrap,
} from './WebTransportBootstrap';

function ConnectedApp() {
  const transport = useBackendTransport();
  return <div>Connected via {transport.environment}</div>;
}

function jsonFetch(payload: unknown) {
  return {
    ok: true,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? 'application/json' : null,
    },
    json: async () => payload,
  };
}

describe('WebTransportBootstrap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('persists the authenticated session in tab sessionStorage without using localStorage or URL', async () => {
    const user = userEvent.setup();
    const localStorageSpy = vi.spyOn(window.localStorage, 'setItem');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/health')) {
          return jsonFetch({ status: 'ok' });
        }
        return jsonFetch({
          server_version: '1.0.0',
          protocol_version: '1.0',
          minimum_client_version: '0.1.0',
          capabilities: ['conversation.read'],
        });
      })
    );
    render(
      <WebTransportBootstrap>
        <ConnectedApp />
      </WebTransportBootstrap>
    );

    await user.type(
      screen.getByLabelText(/^(Connection code|连接码)/),
      'one-time-server-token'
    );
    await user.click(screen.getByRole('button', { name: /^(Connect|连接)$/ }));

    expect(await screen.findByText('Connected via web')).toBeInTheDocument();
    expect(localStorageSpy).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('dimo.web_session')).toBe(
      JSON.stringify({
        baseUrl: window.location.origin,
        token: 'one-time-server-token',
      })
    );
    expect(window.location.href).not.toContain('one-time-server-token');
  });

  it('redeems an 8-character connection code for a device credential', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/health')) {
          return jsonFetch({ status: 'ok' });
        }
        if (url.endsWith('/api/v1/auth/pairings/redeem')) {
          expect(init?.method).toBe('POST');
          expect(JSON.parse(String(init?.body))).toEqual({
            pairing_token: 'K7M2NPQX',
            device_name: expect.stringMatching(/Web/),
          });
          return jsonFetch({
            access_token: 'vbx_device_secret',
          });
        }
        expect(new Headers(init?.headers).get('Authorization')).toBe(
          'Bearer vbx_device_secret'
        );
        return jsonFetch({
          server_version: '1.0.0',
          protocol_version: '1.0',
          minimum_client_version: '0.1.0',
          capabilities: ['conversation.read'],
        });
      }
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <WebTransportBootstrap>
        <ConnectedApp />
      </WebTransportBootstrap>
    );

    await user.type(
      screen.getByLabelText(/^(Connection code|连接码)/),
      'k7m2-npqx'
    );
    await user.click(screen.getByRole('button', { name: /^(Connect|连接)$/ }));

    expect(await screen.findByText('Connected via web')).toBeInTheDocument();
  });

  it('prefills the Host URL from the host query', () => {
    window.history.replaceState({}, '', '?host=http://127.0.0.1:17891');
    render(
      <WebTransportBootstrap>
        <ConnectedApp />
      </WebTransportBootstrap>
    );

    expect(
      screen.getByDisplayValue('http://127.0.0.1:17891')
    ).toBeInTheDocument();
  });

  it('does not treat the Vite page origin as a Host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: {
          get: () => 'text/html',
        },
        json: async () => ({}),
      }))
    );
    render(
      <WebTransportBootstrap>
        <ConnectedApp />
      </WebTransportBootstrap>
    );

    expect(
      await screen.findByRole('textbox', { name: /Host|主机地址/ })
    ).toHaveValue('');
  });

  it('renders concise description, single field labels without duplicate required badges, and standard inputs', () => {
    const { container } = render(
      <WebTransportBootstrap>
        <ConnectedApp />
      </WebTransportBootstrap>
    );

    expect(
      screen.getByText(/^(Enter connection code|输入连接码)$/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Required/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/^(Host|主机地址)$/)).toHaveLength(1);
    expect(screen.getAllByText(/^(Connection code|连接码)$/)).toHaveLength(1);
    expect(container.querySelector('.astryx-text-input')).toBeNull();
    expect(container.querySelector('.web-connect')).not.toBeNull();
  });

  it('restores and auto-reconnects from sessionStorage on reload', async () => {
    window.sessionStorage.setItem(
      'dimo.web_session',
      JSON.stringify({
        baseUrl: 'http://127.0.0.1:17891',
        token: 'saved-device-token',
      })
    );
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe('http://127.0.0.1:17891/api/v1/capabilities');
        expect(new Headers(init?.headers).get('Authorization')).toBe(
          'Bearer saved-device-token'
        );
        return jsonFetch({
          server_version: '1.0.0',
          protocol_version: '1.0',
          minimum_client_version: '0.1.0',
          capabilities: ['conversation.read'],
        });
      }
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WebTransportBootstrap>
        <ConnectedApp />
      </WebTransportBootstrap>
    );

    expect(await screen.findByText('Connected via web')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears sessionStorage and shows an error when restored token fails with 401', async () => {
    window.sessionStorage.setItem(
      'dimo.web_session',
      JSON.stringify({
        baseUrl: 'http://127.0.0.1:17891',
        token: 'revoked-token',
      })
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        headers: { get: () => 'application/json' },
        json: async () => ({
          code: 'unauthorized',
          message: 'Session token expired',
          retryable: false,
        }),
      }))
    );

    render(
      <WebTransportBootstrap>
        <ConnectedApp />
      </WebTransportBootstrap>
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Session token expired'
    );
    expect(window.sessionStorage.getItem('dimo.web_session')).toBeNull();
  });

  it('clears sessionStorage and disconnects on explicit disconnectWebSession()', async () => {
    window.sessionStorage.setItem(
      'dimo.web_session',
      JSON.stringify({
        baseUrl: 'http://127.0.0.1:17891',
        token: 'active-token',
      })
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonFetch({
          server_version: '1.0.0',
          protocol_version: '1.0',
          minimum_client_version: '0.1.0',
          capabilities: ['conversation.read'],
        })
      )
    );

    render(
      <WebTransportBootstrap>
        <ConnectedApp />
      </WebTransportBootstrap>
    );

    expect(await screen.findByText('Connected via web')).toBeInTheDocument();

    act(() => {
      disconnectWebSession();
    });

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /^(Connect|连接)$/ })
      ).toBeInTheDocument();
    });
    expect(window.sessionStorage.getItem('dimo.web_session')).toBeNull();
  });
});
