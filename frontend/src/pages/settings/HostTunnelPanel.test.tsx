import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';

import { HostTunnelPanel } from './HostTunnelPanel';

const hostTunnelApi = vi.hoisted(() => ({
  get: vi.fn(),
  setEnabled: vi.fn(),
  checkExisting: vi.fn(),
  selectSaved: vi.fn(),
  startCreate: vi.fn(),
  confirmCreate: vi.fn(),
  cancelCreate: vi.fn(),
  removeSaved: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  hostTunnelApi,
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/components/dialogs/shared/ConfirmDialog', () => ({
  ConfirmDialog: { show: vi.fn() },
}));

const idleStatus = {
  enabled: false,
  saved: [],
  active_id: null,
  pending: null,
  relay_state: 'idle',
  last_error: null,
};

describe('HostTunnelPanel', () => {
  beforeEach(() => {
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    for (const fn of Object.values(hostTunnelApi)) {
      fn.mockReset();
    }
    hostTunnelApi.get.mockResolvedValue(idleStatus);
    hostTunnelApi.setEnabled.mockImplementation(async (enabled: boolean) => ({
      ...idleStatus,
      enabled,
    }));
    hostTunnelApi.checkExisting.mockResolvedValue({
      origin: 'https://gate.example.ts.net',
      http: false,
    });
    hostTunnelApi.startCreate.mockResolvedValue({
      enabled: true,
      saved: [],
      active_id: null,
      pending: {
        host: '203.0.113.10',
        port: 443,
        command:
          'curl -fsSL https://vibex.xforever.xin/tunnel.sh | sudo sh -s -- -t tok -p 443',
      },
      relay_state: 'idle',
      last_error: null,
    });
  });

  it('enables the tunnel and checks an existing public origin', async () => {
    const user = userEvent.setup();
    const onReachabilityChange = vi.fn();
    render(
      <HostTunnelPanel
        serviceRunning
        onReachabilityChange={onReachabilityChange}
      />
    );

    await user.click(await screen.findByRole('switch', { name: '远程穿透' }));
    await waitFor(() =>
      expect(hostTunnelApi.setEnabled).toHaveBeenCalledWith(true)
    );

    await user.type(
      screen.getByPlaceholderText('gate.example.com'),
      'gate.example.ts.net'
    );
    await user.click(screen.getByRole('button', { name: '检查并使用' }));
    await waitFor(() =>
      expect(hostTunnelApi.checkExisting).toHaveBeenCalledWith(
        'gate.example.ts.net'
      )
    );
    expect(onReachabilityChange).toHaveBeenCalled();
  });

  it('generates a short install command for a new VPS tunnel', async () => {
    const user = userEvent.setup();
    hostTunnelApi.setEnabled.mockResolvedValue({
      ...idleStatus,
      enabled: true,
    });
    render(
      <HostTunnelPanel serviceRunning onReachabilityChange={() => undefined} />
    );

    await user.click(await screen.findByRole('switch', { name: '远程穿透' }));
    await user.click(await screen.findByRole('combobox'));
    await user.click(screen.getByRole('option', { name: '新建穿透' }));
    await user.type(
      screen.getByPlaceholderText('203.0.113.10'),
      '203.0.113.10'
    );
    await user.click(screen.getByRole('button', { name: '生成命令' }));
    await waitFor(() =>
      expect(hostTunnelApi.startCreate).toHaveBeenCalledWith('203.0.113.10')
    );
    expect(
      await screen.findByText(
        /curl -fsSL https:\/\/vibex\.xforever\.xin\/tunnel.sh/
      )
    ).toBeVisible();
    expect(screen.getByRole('button', { name: '已完成配置' })).toBeVisible();
  });

  it('lists saved tunnels like paired devices and can remove one', async () => {
    const user = userEvent.setup();
    vi.mocked(ConfirmDialog.show).mockResolvedValue('confirmed');
    hostTunnelApi.get.mockResolvedValue({
      enabled: true,
      saved: [
        {
          id: 't1',
          origin: 'https://gate.example.ts.net',
          host: 'gate.example.ts.net',
          port: 443,
          kind: 'existing',
        },
      ],
      active_id: 't1',
      pending: null,
      relay_state: 'idle',
      last_error: null,
    });
    hostTunnelApi.removeSaved.mockResolvedValue({
      ...idleStatus,
      enabled: true,
    });

    render(
      <HostTunnelPanel serviceRunning onReachabilityChange={() => undefined} />
    );

    expect(await screen.findByText('已保存穿透')).toBeVisible();
    expect(screen.getByText('https://gate.example.ts.net')).toBeVisible();
    expect(screen.getByText(/使用中/)).toBeVisible();
    expect(screen.getByRole('button', { name: '移除' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '移除' }));
    expect(ConfirmDialog.show).toHaveBeenCalled();
    await waitFor(() =>
      expect(hostTunnelApi.removeSaved).toHaveBeenCalledWith('t1')
    );
  });
});
