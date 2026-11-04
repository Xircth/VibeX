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
        port: 17891,
        command:
          'curl -fsSL https://vibex.xforever.xin/tunnel.sh | sh -s -- -t tok -p 17891 -h 203.0.113.10',
      },
      relay_state: 'idle',
      last_error: null,
    });
  });

  it('shows the saved tunnel list expanded by default when enabled and opens the create modal with blurred settings content', async () => {
    const user = userEvent.setup();
    render(
      <div className="settings-page">
        <aside className="settings-sidebar" />
        <div data-settings-content>
          <HostTunnelPanel
            serviceRunning
            onReachabilityChange={() => undefined}
          />
        </div>
      </div>
    );

    await user.click(await screen.findByRole('switch', { name: '远程穿透' }));
    await waitFor(() =>
      expect(hostTunnelApi.setEnabled).toHaveBeenCalledWith(true)
    );

    const toggle = await screen.findByRole('button', {
      name: /已保存穿透列表/,
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('还没有已保存穿透')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '新建穿透' }));
    expect(screen.getByTestId('host-tunnel-modal-overlay')).toBeInTheDocument();
    expect(document.querySelector('.settings-page')).toHaveClass(
      'collaboration-settings-window-blurred'
    );
    expect(
      screen.getByText(
        '请输入穿透地址IP/域名，点击‘生成命令’后，在对应云服务器上运行命令即可，若已运行命令或自建穿透，则点击“测试连通”进行检查'
      )
    ).toBeVisible();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(
      screen.queryByTestId('host-tunnel-modal-overlay')
    ).not.toBeInTheDocument();
    expect(document.querySelector('.settings-page')).not.toHaveClass(
      'collaboration-settings-window-blurred'
    );
  });

  it('tests connectivity, displays status and latency, and enables save only after connectivity succeeds', async () => {
    const user = userEvent.setup();
    const onReachabilityChange = vi.fn();
    render(
      <HostTunnelPanel
        serviceRunning
        onReachabilityChange={onReachabilityChange}
      />
    );

    await user.click(await screen.findByRole('switch', { name: '远程穿透' }));
    await user.click(await screen.findByRole('button', { name: '新建穿透' }));

    const saveButton = screen.getByRole('button', { name: '保存' });
    expect(saveButton).toBeDisabled();

    await user.type(
      screen.getByPlaceholderText('203.0.113.10'),
      'gate.example.ts.net'
    );
    await user.click(screen.getByRole('button', { name: '测试连通' }));

    await waitFor(() =>
      expect(hostTunnelApi.checkExisting).toHaveBeenCalledWith(
        'gate.example.ts.net'
      )
    );

    const statusBadge = await screen.findByTestId('tunnel-connectivity-status');
    expect(statusBadge).toHaveAttribute('data-connected', 'true');
    expect(statusBadge).toHaveTextContent('已连通');
    expect(statusBadge).toHaveTextContent(/延迟 \d+ ms/);
    expect(saveButton).toBeEnabled();

    await user.click(saveButton);
    expect(
      screen.queryByTestId('host-tunnel-modal-overlay')
    ).not.toBeInTheDocument();
    expect(onReachabilityChange).toHaveBeenCalled();

    const { toast } = await import('@/components/ui/toast');
    expect(toast.success).toHaveBeenCalledWith('已保存远程穿透地址');
  });

  it('generates a short install command in the modal and keeps save disabled when connectivity fails', async () => {
    const user = userEvent.setup();
    hostTunnelApi.setEnabled.mockResolvedValue({
      ...idleStatus,
      enabled: true,
    });
    hostTunnelApi.checkExisting.mockRejectedValue(
      new Error('Bad request: Could not reach a VibeX Host')
    );
    hostTunnelApi.confirmCreate.mockRejectedValue(
      new Error('Bad request: Generate a setup command first')
    );

    render(
      <HostTunnelPanel serviceRunning onReachabilityChange={() => undefined} />
    );

    await user.click(await screen.findByRole('switch', { name: '远程穿透' }));
    await user.click(await screen.findByRole('button', { name: '新建穿透' }));
    await user.type(
      screen.getByPlaceholderText('203.0.113.10'),
      '203.0.113.10'
    );
    await user.click(screen.getByRole('button', { name: '生成命令' }));
    await waitFor(() =>
      expect(hostTunnelApi.startCreate).toHaveBeenCalledWith('203.0.113.10')
    );
    expect(
      await screen.findByDisplayValue(
        /curl -fsSL https:\/\/vibex\.xforever\.xin\/tunnel.sh/
      )
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: '测试连通' }));
    const statusBadge = await screen.findByTestId('tunnel-connectivity-status');
    expect(statusBadge).toHaveAttribute('data-connected', 'false');
    expect(statusBadge).toHaveTextContent('未连通');
    expect(statusBadge).toHaveTextContent(/延迟 \d+ ms/);
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();

    const { toast } = await import('@/components/ui/toast');
    expect(toast.error).toHaveBeenCalledWith(
      '请先生成命令，并在云服务器运行后再点测试连通。'
    );
  });

  it('lists saved tunnels with aligned origin, IP, created time, usage badge, enable/disable toggle, and remove button', async () => {
    const user = userEvent.setup();
    vi.mocked(ConfirmDialog.show).mockResolvedValue('confirmed');
    const savedTunnels = [
      {
        id: 't1',
        origin: 'https://gate.example.ts.net',
        host: '203.0.113.10',
        port: 443,
        kind: 'existing',
        created_at: '2026-11-04T03:00:00Z',
      },
      {
        id: 't2',
        origin: 'http://198.51.100.8:17891',
        host: '198.51.100.8',
        port: 17891,
        kind: 'relay',
        created_at: '2026-11-04T04:15:00Z',
      },
    ];
    hostTunnelApi.get.mockResolvedValue({
      enabled: true,
      saved: savedTunnels,
      active_id: 't1',
      pending: null,
      relay_state: 'idle',
      last_error: null,
    });
    hostTunnelApi.selectSaved.mockImplementation(async (id: string | null) => ({
      enabled: true,
      saved: savedTunnels,
      active_id: id,
      pending: null,
      relay_state: 'idle',
      last_error: null,
    }));
    hostTunnelApi.removeSaved.mockResolvedValue({
      ...idleStatus,
      enabled: true,
    });

    render(
      <HostTunnelPanel serviceRunning onReachabilityChange={() => undefined} />
    );

    const toggle = await screen.findByRole('button', {
      name: /已保存穿透列表/,
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('https://gate.example.ts.net')).toBeVisible();
    expect(screen.getByText('203.0.113.10:443')).toBeVisible();
    expect(screen.queryByText('已建穿透')).not.toBeInTheDocument();

    const badges = screen.getAllByTestId('tunnel-usage-badge');
    expect(badges[0]).toHaveAttribute('data-state', 'in-use');
    expect(badges[0]).toHaveTextContent('使用中');
    expect(badges[1]).toHaveAttribute('data-state', 'unused');
    expect(badges[1]).toHaveTextContent('未使用');

    const disableButton = screen.getByRole('button', { name: '停用' });
    expect(disableButton).toBeVisible();
    expect(screen.getByRole('button', { name: '启用' })).toBeVisible();

    await user.click(disableButton);
    await waitFor(() =>
      expect(hostTunnelApi.selectSaved).toHaveBeenCalledWith(null)
    );

    const removeButtons = screen.getAllByRole('button', { name: '移除' });
    expect(removeButtons[0]).toHaveClass('!bg-destructive/10');
    await user.click(removeButtons[0]);
    expect(ConfirmDialog.show).toHaveBeenCalled();
    await waitFor(() =>
      expect(hostTunnelApi.removeSaved).toHaveBeenCalledWith('t1')
    );
  });
});
