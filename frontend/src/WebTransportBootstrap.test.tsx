import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useBackendTransport } from '@/lib/transport';
import { WebTransportBootstrap } from './WebTransportBootstrap';

function ConnectedApp() {
  const transport = useBackendTransport();
  return <div>Connected via {transport.environment}</div>;
}

describe('WebTransportBootstrap', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('authenticates without persisting the Server token in browser storage', async () => {
    const user = userEvent.setup();
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          server_version: '1.0.0',
          protocol_version: '1.0',
          minimum_client_version: '0.1.0',
          capabilities: ['conversation.read'],
        }),
      })
    );
    render(
      <WebTransportBootstrap>
        <ConnectedApp />
      </WebTransportBootstrap>
    );

    await user.type(
      screen.getByLabelText('Server token'),
      'one-time-server-token'
    );
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Connected via web')).toBeInTheDocument();
    expect(storageSpy).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain('one-time-server-token');
  });
});
