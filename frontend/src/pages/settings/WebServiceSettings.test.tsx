import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackendTransport } from '@/lib/backendTransport';
import { BackendTransportProvider } from '@/lib/transport';
import { WebServiceSettings } from './WebServiceSettings';

const webServiceApiMock = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getStatus: vi.fn(),
  updateConfig: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  probePort: vi.fn(),
  generateToken: vi.fn(),
  createPairing: vi.fn(),
  listDevices: vi.fn(),
  revokeDevice: vi.fn(),
}));

const hostClientApiMock = vi.hoisted(() => ({
  status: vi.fn(),
  discover: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  delete: vi.fn(),
  hostUpdates: vi.fn(),
  applyHostUpdate: vi.fn(),
}));

const hostTunnelApiMock = vi.hoisted(() => ({
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
  webServiceApi: webServiceApiMock,
  hostClientApi: hostClientApiMock,
  hostTunnelApi: hostTunnelApiMock,
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const vibexAccountMock = vi.hoisted(() => ({
  isSignedIn: true,
  overview: {
    relayPermission: true,
    assignedRelayServer: {
      id: 'relay-default-1',
      name: '默认云中继',
      region: '香港',
      publicOrigin: 'https://vibex.xforever.xin',
    },
  } as {
    relayPermission?: boolean;
    assignedRelayServer?: {
      id: string;
      name: string;
      region: string;
      publicOrigin: string;
    } | null;
  } | null,
  user: {
    displayName: 'Test User',
    username: 'testuser',
    email: 'test@vibex.dev',
  },
}));

vi.mock('@/features/model-router', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/model-router')>();
  return {
    ...actual,
    useVibeXAccount: () => vibexAccountMock,
    syncCurrentHostRelayLease: vi.fn(async () => true),
  };
});

const shellOpenMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: vi.fn(),
  },
  open: shellOpenMock,
}));

const stoppedStatus = {
  running: false,
  port: 17891,
  address: null,
  token_configured: false,
  started_at: null,
  message: null,
};

const runningStatus = {
  ...stoppedStatus,
  running: true,
  address: 'http://127.0.0.1:17891',
  addresses: ['http://127.0.0.1:17891'],
  started_at: '2026-08-03T12:00:00Z',
};

function renderSettings(
  environment: BackendTransport['environment'] = 'desktop'
) {
  const transport: BackendTransport = {
    environment,
    call: vi.fn(),
    createDevicePairing: vi.fn(async () => ({
      pairing_id: 'pair-1',
      pairing_token: 'pair-once-secret',
      expires_at: '2026-08-17T00:00:00Z',
      requested_scopes: ['conversation.read'],
      invitation:
        'vibex-pairing:{"pairing_token":"pair-once-secret","reachability":[{"origin":"http://192.168.1.20:17891","kind":"lan"}]}',
      reachability: [{ origin: 'http://192.168.1.20:17891', kind: 'lan' }],
    })),
  };

  return render(
    <BackendTransportProvider transport={transport}>
      <WebServiceSettings />
    </BackendTransportProvider>
  );
}

describe('WebServiceSettings', () => {
  beforeEach(() => {
    vibexAccountMock.isSignedIn = true;
    vibexAccountMock.overview = {
      relayPermission: true,
      assignedRelayServer: {
        id: 'relay-default-1',
        name: '默认云中继',
        region: '香港',
        publicOrigin: 'https://vibex.xforever.xin',
      },
    };
    shellOpenMock.mockReset();
    shellOpenMock.mockResolvedValue(undefined);
    for (const fn of Object.values(webServiceApiMock)) {
      fn.mockReset();
    }
    webServiceApiMock.getConfig.mockResolvedValue({
      port: 17891,
      token: null,
      auto_start: false,
      allow_lan: false,
    });
    webServiceApiMock.getStatus.mockResolvedValue(stoppedStatus);
    webServiceApiMock.updateConfig.mockImplementation(async (config) => config);
    webServiceApiMock.start.mockResolvedValue(runningStatus);
    webServiceApiMock.stop.mockResolvedValue(stoppedStatus);
    webServiceApiMock.probePort.mockResolvedValue({
      port: 17891,
      available: true,
      message: null,
    });
    webServiceApiMock.generateToken.mockResolvedValue({
      port: 17891,
      token: 'generated-token',
      auto_start: false,
    });
    webServiceApiMock.createPairing.mockResolvedValue({
      pairing_id: 'pair-1',
      pairing_token: 'pair-once-secret',
      expires_at: '2026-08-17T00:00:00Z',
      requested_scopes: ['conversation.read'],
    });
    webServiceApiMock.listDevices.mockResolvedValue([]);
    webServiceApiMock.revokeDevice.mockResolvedValue(undefined);
    hostTunnelApiMock.get.mockResolvedValue({
      enabled: false,
      saved: [],
      active_id: null,
      pending: null,
      relay_state: 'idle',
      last_error: null,
    });
    hostClientApiMock.status.mockResolvedValue({
      connected: false,
      profile: null,
      profiles: [],
    });
    hostClientApiMock.discover.mockResolvedValue([]);
    hostClientApiMock.connect.mockResolvedValue({
      profile: {
        id: 'p1',
        origin: 'http://192.168.1.8:17891',
        host_id: 'host-1',
        name: 'Studio',
        last_connected_at: '2026-08-20T00:00:00Z',
        needs_token: false,
        has_credential: true,
        connected: true,
      },
      stopped_host: false,
    });
    hostClientApiMock.disconnect.mockResolvedValue(undefined);
    hostClientApiMock.delete.mockResolvedValue(undefined);
    hostClientApiMock.hostUpdates.mockResolvedValue([]);
    hostClientApiMock.applyHostUpdate.mockResolvedValue({
      fromVersion: '0.2.0',
      toVersion: '0.2.1',
    });
  });

  it('locks remote connection to the client role while bound to a Host', async () => {
    hostClientApiMock.status.mockResolvedValue({
      connected: true,
      profile: {
        id: 'ssh-1',
        origin: 'http://127.0.0.1:61091',
        host_id: 'host-ssh',
        name: 'root@lab',
        last_connected_at: '2026-09-06T00:00:00Z',
        needs_token: false,
        has_credential: true,
        connected: true,
        provision_kind: 'ssh',
      },
      profiles: [
        {
          id: 'ssh-1',
          origin: 'http://127.0.0.1:61091',
          host_id: 'host-ssh',
          name: 'root@lab',
          last_connected_at: '2026-09-06T00:00:00Z',
          needs_token: false,
          has_credential: true,
          connected: true,
          provision_kind: 'ssh',
        },
      ],
    });
    renderSettings('remote-desktop');

    expect(
      await screen.findByRole('heading', { name: '已保存 Host' })
    ).toBeVisible();
    expect(screen.getByText('root@lab')).toBeVisible();
    expect(screen.getByText('已连接')).toBeVisible();
    expect(
      screen.queryByRole('radio', { name: '服务端' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('radio', { name: '客户端' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('spinbutton', { name: '监听端口' })
    ).not.toBeInTheDocument();
    expect(webServiceApiMock.start).not.toHaveBeenCalled();
  });

  it('lists a saved Host on the local client tab without enabling it', async () => {
    hostClientApiMock.status.mockResolvedValue({
      connected: false,
      profile: null,
      profiles: [
        {
          id: 'ssh-1',
          origin: 'http://127.0.0.1:61091',
          host_id: 'host-ssh',
          name: 'root@lab',
          last_connected_at: '2026-09-06T00:00:00Z',
          needs_token: false,
          has_credential: true,
          connected: false,
          provision_kind: 'ssh',
        },
      ],
    });
    renderSettings('desktop');

    await userEvent
      .setup()
      .click(await screen.findByRole('radio', { name: '客户端' }));
    expect(
      await screen.findByRole('heading', { name: '已保存 Host' })
    ).toBeVisible();
    expect(screen.getByText('root@lab')).toBeVisible();
    expect(screen.queryByText('已连接')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '服务端' })).toBeInTheDocument();
  });

  it('puts server and client roles in top-right segmented control with icons', async () => {
    renderSettings();

    const serverRadio = await screen.findByRole('radio', { name: '服务端' });
    const clientRadio = screen.getByRole('radio', { name: '客户端' });
    expect(serverRadio).toHaveAttribute('aria-checked', 'true');
    expect(clientRadio).toHaveAttribute('aria-checked', 'false');
    expect(serverRadio.querySelector('svg')).not.toBeNull();
    expect(clientRadio.querySelector('svg')).not.toBeNull();
    expect(
      screen.getByRole('radiogroup', { name: '远程连接角色' })
    ).toHaveClass('dsh-plugin-mode-segmented');
    expect(screen.getByRole('heading', { name: '远程连接服务' })).toBeVisible();

    await userEvent.setup().click(clientRadio);
    expect(
      await screen.findByRole('heading', { name: '局域网 Host' })
    ).toBeVisible();
    expect(screen.getByRole('button', { name: '手动连接' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '已保存 Host' })).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: '远程连接服务' })
    ).not.toBeInTheDocument();
  });

  it('shows host and external access without a separate Web Access section, hiding port and LAN options while stopped', async () => {
    renderSettings();

    expect(
      await screen.findByRole('heading', { name: '远程连接服务' })
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: '外部访问' })).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Web 访问' })
    ).not.toBeInTheDocument();
    expect(screen.getByText('远程服务状态')).toBeVisible();
    expect(
      screen.queryByRole('spinbutton', { name: '监听端口' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: '自动启动' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: '允许局域网' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /服务状态|访问配置/ })
    ).not.toBeInTheDocument();
  });

  it('keeps service status and its start-stop control in one setting row', async () => {
    renderSettings();

    const currentStatus = await screen.findByText('远程服务状态');
    const serviceControl = screen.getByRole('switch', { name: '启动' });
    const statusRow = currentStatus.closest('.settings-row');

    expect(statusRow).not.toBeNull();
    expect(statusRow).toContainElement(serviceControl);
  });

  it('starts and stops the service through the visible state control, revealing port, health capsule, and LAN toggles when running', async () => {
    const user = userEvent.setup();
    renderSettings();

    const configReads = webServiceApiMock.getConfig.mock.calls.length;
    await user.click(await screen.findByRole('switch', { name: '启动' }));
    await waitFor(() => expect(webServiceApiMock.start).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(webServiceApiMock.getConfig.mock.calls.length).toBeGreaterThan(
        configReads
      )
    );

    const stopControl = await screen.findByRole('switch', { name: '停止' });
    expect(screen.getByRole('spinbutton', { name: '监听端口' })).toBeVisible();
    expect(screen.getByRole('switch', { name: '自动启动' })).toBeVisible();
    expect(screen.getByRole('switch', { name: '允许局域网' })).toBeVisible();
    const lamp = screen.getByTestId('web-service-status-lamp');
    expect(lamp).toHaveClass('text-[hsl(var(--success))]');
    expect(lamp).toHaveAttribute('data-status', 'healthy');
    expect(lamp.querySelector('.vu-toast-status-icon')).not.toBeNull();

    await user.click(stopControl);
    await waitFor(() => expect(webServiceApiMock.stop).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole('spinbutton', { name: '监听端口' })
    ).not.toBeInTheDocument();
  });

  it('shows why the service failed to start instead of a generic message', async () => {
    const user = userEvent.setup();
    const { toast } = await import('@/components/ui/toast');
    webServiceApiMock.start.mockRejectedValueOnce(
      'Conflict: Failed to bind web service on 0.0.0.0:17891: (os error 10048)'
    );

    renderSettings();

    await user.click(await screen.findByRole('switch', { name: '启动' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Conflict: Failed to bind web service on 0.0.0.0:17891: (os error 10048)'
      )
    );
    expect(toast.error).not.toHaveBeenCalledWith('远程连接启动失败');
  });

  it('asks the user to start the service before generating a pairing code', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: '生成连接码' }));

    const { toast } = await import('@/components/ui/toast');
    expect(toast.error).toHaveBeenCalledWith('请先开启远程连接服务');
    expect(webServiceApiMock.createPairing).not.toHaveBeenCalled();
  });

  it('lists loopback and LAN addresses under External Access when the Host is running', async () => {
    webServiceApiMock.getConfig.mockResolvedValue({
      port: 17891,
      token: null,
      auto_start: false,
      allow_lan: true,
    });
    webServiceApiMock.getStatus.mockResolvedValue({
      ...runningStatus,
      port: 17891,
      address: 'http://127.0.0.1:17891',
      addresses: ['http://127.0.0.1:17891', 'http://192.168.1.20:17891'],
      serves_web_ui: true,
    });

    renderSettings();
    expect(
      await screen.findByTestId('web-service-status-lamp')
    ).toHaveAttribute('data-status', 'healthy');

    const externalAccess = (
      await screen.findByRole('heading', { name: '外部访问' })
    ).closest('.settings-section') as HTMLElement | null;
    expect(externalAccess).not.toBeNull();
    expect(
      within(externalAccess!).getByText('http://127.0.0.1:17891')
    ).toBeVisible();
    expect(
      within(externalAccess!).getByText('http://192.168.1.20:17891')
    ).toBeVisible();
    expect(
      within(externalAccess!).getByRole('switch', { name: '云服务' })
    ).toBeVisible();
  });

  it('opens the Host address in the system browser from External Access', async () => {
    const user = userEvent.setup();
    webServiceApiMock.getConfig.mockResolvedValue({
      port: 17891,
      token: null,
      auto_start: false,
      allow_lan: false,
    });
    webServiceApiMock.getStatus.mockResolvedValue({
      ...runningStatus,
      port: 17891,
      address: 'http://127.0.0.1:17891',
      addresses: ['http://127.0.0.1:17891'],
      serves_web_ui: true,
    });

    renderSettings();

    await user.click(
      await screen.findByRole('button', {
        name: '打开 http://127.0.0.1:17891',
      })
    );

    await waitFor(() =>
      expect(shellOpenMock).toHaveBeenCalledWith('http://127.0.0.1:17891')
    );
  });

  it('does not show a raw address QR that a phone would reject as an invitation', async () => {
    webServiceApiMock.getConfig.mockResolvedValue({
      port: 17891,
      token: null,
      auto_start: false,
      allow_lan: true,
    });
    webServiceApiMock.getStatus.mockResolvedValue({
      ...runningStatus,
      address: 'http://127.0.0.1:17891',
      addresses: ['http://127.0.0.1:17891', 'http://192.168.1.20:17891'],
    });

    renderSettings();

    expect(await screen.findByText('远程服务状态')).toBeVisible();
    expect(screen.queryByAltText('地址二维码')).not.toBeInTheDocument();
    expect(
      screen.queryByText(/在同一网络的另一台设备上扫描/)
    ).not.toBeInTheDocument();
  });

  it('saves the edited access configuration and probes port via health capsule when running', async () => {
    const user = userEvent.setup();
    webServiceApiMock.getStatus.mockResolvedValue(runningStatus);
    renderSettings();

    const port = await screen.findByRole('spinbutton', { name: '监听端口' });
    await user.clear(port);
    await user.type(port, '19000');
    await user.click(screen.getByTestId('web-service-status-lamp'));
    await waitFor(() =>
      expect(webServiceApiMock.probePort).toHaveBeenCalledWith(19000)
    );
    await user.click(screen.getByRole('switch', { name: '自动启动' }));

    await waitFor(() =>
      expect(webServiceApiMock.updateConfig).toHaveBeenCalledWith({
        port: 19000,
        token: null,
        auto_start: true,
        allow_lan: false,
      })
    );
  });

  it('rolls back local switch state and shows toast error when updateConfig fails', async () => {
    const user = userEvent.setup();
    const { toast } = await import('@/components/ui/toast');
    webServiceApiMock.getStatus.mockResolvedValue(runningStatus);
    webServiceApiMock.updateConfig.mockRejectedValueOnce(
      new Error('Failed to bind 0.0.0.0:17891')
    );

    renderSettings();

    const allowLanSwitch = await screen.findByRole('switch', {
      name: '允许局域网',
    });
    expect(allowLanSwitch).toHaveAttribute('aria-checked', 'false');

    await user.click(allowLanSwitch);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to bind 0.0.0.0:17891')
    );
    await waitFor(() =>
      expect(allowLanSwitch).toHaveAttribute('aria-checked', 'false')
    );
  });

  it('lists connected devices under External Access', async () => {
    webServiceApiMock.listDevices.mockResolvedValue([
      {
        device_id: 'dev-1',
        device_name: 'Pixel 9',
        scopes: ['conversation.read'],
        created_at: '2026-08-18T12:00:00Z',
        preset: 'companion',
      },
    ]);

    renderSettings();

    expect(await screen.findByText('已连接列表')).toBeVisible();
    expect(await screen.findByText('Pixel 9')).toBeVisible();
    expect(screen.getByRole('button', { name: '撤销' })).toBeVisible();
  });

  it('keeps the remote tunnel panel mounted when settings change', async () => {
    webServiceApiMock.getStatus.mockResolvedValue(runningStatus);
    renderSettings();

    const tunnel = await screen.findByRole('switch', { name: '云服务' });
    expect(tunnel).toBeVisible();
    webServiceApiMock.getConfig.mockClear();
    window.dispatchEvent(new Event('vibex://settings-file-changed'));
    await waitFor(() => expect(webServiceApiMock.getConfig).toHaveBeenCalled());
    expect(screen.getByRole('switch', { name: '云服务' })).toBe(tunnel);
  });

  it('syncs the displayed port when starting the service falls back from 17891 to 17892', async () => {
    const user = userEvent.setup();
    webServiceApiMock.start.mockResolvedValueOnce({
      ...runningStatus,
      port: 17892,
      address: 'http://127.0.0.1:17892',
      addresses: ['http://127.0.0.1:17892'],
    });

    renderSettings();

    await user.click(await screen.findByRole('switch', { name: '启动' }));

    const portInput = await screen.findByRole('spinbutton', {
      name: '监听端口',
    });
    expect(portInput).toHaveValue(17892);
    expect(screen.getByText('http://127.0.0.1:17892')).toBeVisible();
  });

  it('hides the Cloud Relay Service (Beta) section when the account does not have relay permission', async () => {
    vibexAccountMock.overview = {
      relayPermission: false,
      assignedRelayServer: null,
    };
    webServiceApiMock.getStatus.mockResolvedValue(runningStatus);

    renderSettings();

    expect(await screen.findByText('远程服务状态')).toBeVisible();
    expect(
      screen.queryByRole('switch', { name: '云服务' })
    ).not.toBeInTheDocument();
  });
});

