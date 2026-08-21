import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteClientSettings } from './RemoteClientSettings';

const hostClientApiMock = vi.hoisted(() => ({
  status: vi.fn(),
  discover: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  hostClientApi: hostClientApiMock,
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const connectedHost = {
  id: 'current',
  origin: 'http://192.168.1.9:17891',
  host_id: 'host-b',
  name: 'Beta',
  last_connected_at: '2026-08-20T00:00:00Z',
  needs_token: false,
  has_credential: true,
  connected: true,
};

const otherHost = {
  id: 'other',
  origin: 'http://192.168.1.8:17891',
  host_id: 'host-a',
  name: 'Alpha',
  last_connected_at: '2026-08-01T00:00:00Z',
  needs_token: false,
  has_credential: true,
  connected: false,
};

describe('RemoteClientSettings', () => {
  beforeEach(() => {
    for (const fn of Object.values(hostClientApiMock)) {
      fn.mockReset();
    }
    hostClientApiMock.status.mockResolvedValue({
      connected: true,
      profile: connectedHost,
      profiles: [connectedHost, otherHost],
    });
    hostClientApiMock.discover.mockResolvedValue([
      {
        origin: 'http://192.168.1.12:17891',
        host_id: 'host-c',
        name: 'Office',
        saved: false,
      },
    ]);
    hostClientApiMock.connect.mockResolvedValue({
      profile: { ...otherHost, connected: true },
      stopped_host: true,
    });
    hostClientApiMock.delete.mockResolvedValue(undefined);
  });

  it('lists a discovered Host and asks for a connection code on first connect', async () => {
    const user = userEvent.setup();
    render(<RemoteClientSettings />);

    expect(await screen.findByText('Office')).toBeVisible();
    expect(screen.getByRole('button', { name: '手动连接' })).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: '手动连接' })
    ).not.toBeInTheDocument();
    const lanRow = screen
      .getByText('Office')
      .closest('.settings-host-row') as HTMLElement;
    await user.click(within(lanRow).getByRole('button', { name: '连接' }));

    const codeField = await within(lanRow).findByPlaceholderText('8 位连接码');
    expect(codeField).toBeVisible();
    expect(hostClientApiMock.connect).not.toHaveBeenCalled();

    await user.type(codeField, 'K7M2NPQX');
    await user.click(
      within(lanRow).getAllByRole('button', { name: '连接' }).at(-1)!
    );

    await waitFor(() =>
      expect(hostClientApiMock.connect).toHaveBeenCalledWith({
        origin: 'http://192.168.1.12:17891',
        token: 'K7M2NPQX',
        profile_id: undefined,
      })
    );
  });

  it('pins the connected Host and offers switch on another saved Host', async () => {
    const user = userEvent.setup();
    render(<RemoteClientSettings />);

    const beta = await screen.findByText('Beta');
    const saved = screen
      .getByRole('heading', { name: '已保存 Host' })
      .closest('.settings-section') as HTMLElement;
    const names = within(saved)
      .getAllByRole('button')
      .map((button) => button.textContent);

    expect(names[0]).toContain('Beta');
    expect(names[0]).toContain('已连接');
    expect(
      within(beta.closest('.settings-host-row')!).queryByRole('button', {
        name: '连接',
      })
    ).toBeNull();
    await user.click(beta);
    expect(screen.getByRole('button', { name: '断开' })).toBeVisible();
    await user.click(beta);

    await user.click(screen.getByText('Alpha'));
    expect(
      await screen.findByRole('button', { name: '切换连接' })
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: '切换连接' }));
    await waitFor(() =>
      expect(hostClientApiMock.connect).toHaveBeenCalledWith({
        origin: 'http://192.168.1.8:17891',
        token: undefined,
        profile_id: 'other',
      })
    );
  });

  it('connects a saved Host without a connection code when none is currently connected', async () => {
    const user = userEvent.setup();
    hostClientApiMock.status.mockResolvedValue({
      connected: false,
      profile: null,
      profiles: [{ ...otherHost, connected: false }],
    });
    render(<RemoteClientSettings />);

    const saved = (
      await screen.findByRole('heading', { name: '已保存 Host' })
    ).closest('.settings-section') as HTMLElement;
    await user.click(await within(saved).findByText('Alpha'));
    await user.click(within(saved).getByRole('button', { name: '连接' }));
    await waitFor(() =>
      expect(hostClientApiMock.connect).toHaveBeenCalledWith({
        origin: 'http://192.168.1.8:17891',
        token: undefined,
        profile_id: 'other',
      })
    );
  });
});
