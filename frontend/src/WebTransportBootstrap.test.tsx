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
      screen.getByLabelText(/Access token|访问 Token|Server token/),
      'one-time-server-token'
    );
    await user.click(screen.getByRole('button', { name: /Connect|连接/ }));

    expect(await screen.findByText('Connected via web')).toBeInTheDocument();
    expect(storageSpy).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain('one-time-server-token');
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
