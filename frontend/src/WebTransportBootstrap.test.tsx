import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { useBackendTransport } from '@/lib/transport';
import { WebTransportBootstrap } from './WebTransportBootstrap';

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
    vi.unstubAllGlobals();
    window.history.replaceState({}, '', '/');
  });

  it('authenticates without persisting the Server token in browser storage', async () => {
    const user = userEvent.setup();
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem');
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
    expect(storageSpy).not.toHaveBeenCalled();
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
});
