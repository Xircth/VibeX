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
}));

vi.mock('@/lib/api', () => ({
  webServiceApi: webServiceApiMock,
  hostClientApi: hostClientApiMock,
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

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

function renderSettings() {
  const transport: BackendTransport = {
    environment: 'desktop',
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
  });

  it('puts server and client roles in top-right tabs', async () => {
    renderSettings();

    expect(await screen.findByRole('tab', { name: '服务端' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('tab', { name: '客户端' })).toHaveAttribute(
      'aria-selected',
      'false'
    );
    expect(screen.getByRole('heading', { name: '远程连接服务' })).toBeVisible();

    await userEvent.setup().click(screen.getByRole('tab', { name: '客户端' }));
    expect(
      await screen.findByRole('heading', { name: '局域网 Host' })
    ).toBeVisible();
    expect(screen.getByRole('button', { name: '手动连接' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '已保存 Host' })).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: '远程连接服务' })
    ).not.toBeInTheDocument();
  });

  it('shows host, client, and web access without collapsing them', async () => {
    renderSettings();

    expect(
      await screen.findByRole('heading', { name: '远程连接服务' })
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: '客户端访问' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Web 访问' })).toBeVisible();
    expect(screen.getByText('当前状态')).toBeVisible();
    expect(screen.getByRole('spinbutton', { name: '监听端口' })).toBeVisible();
    expect(screen.getByTestId('web-service-status-lamp')).toHaveClass(
      'settings-status-dot-neutral'
    );
    expect(
      screen.queryByRole('button', { name: /服务状态|访问配置/ })
    ).not.toBeInTheDocument();
  });

  it('keeps service status and its start-stop control in one setting row', async () => {
    renderSettings();

    const currentStatus = await screen.findByText('当前状态');
    const serviceControl = screen.getByRole('switch', { name: '启动' });
    const statusRow = currentStatus.closest('.settings-row');

    expect(statusRow).not.toBeNull();
    expect(statusRow).toContainElement(serviceControl);
  });

  it('starts and stops the service through the visible state control', async () => {
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
    expect(
      within(stopControl.closest('.settings-row')!).getByText('运行中')
    ).toBeInTheDocument();
    expect(screen.getByTestId('web-service-status-lamp')).toHaveClass(
      'settings-status-dot-success'
    );

    await user.click(stopControl);
    await waitFor(() => expect(webServiceApiMock.stop).toHaveBeenCalledOnce());
    expect(screen.getByTestId('web-service-status-lamp')).toHaveClass(
      'settings-status-dot-neutral'
    );
  });

  it('asks the user to start the service before generating a pairing code', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole('button', { name: '生成连接码' }));

    const { toast } = await import('@/components/ui/toast');
    expect(toast.error).toHaveBeenCalledWith('请先开启远程连接服务');
    expect(webServiceApiMock.createPairing).not.toHaveBeenCalled();
  });

  it('does not discard an unsaved port edit when generating a token', async () => {
    const user = userEvent.setup();
    webServiceApiMock.getStatus.mockResolvedValue(runningStatus);
    renderSettings();

    const port = await screen.findByRole('spinbutton', { name: '监听端口' });
    await user.clear(port);
    await user.type(port, '19000');
    await user.click(screen.getByRole('button', { name: /^生成$/ }));

    await waitFor(() =>
      expect(webServiceApiMock.generateToken).toHaveBeenCalledOnce()
    );
    expect(port).toHaveValue(19000);
  });

  it('lists Web UI and Host addresses separately when they use different ports', async () => {
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
      serves_web_ui: false,
    });

    renderSettings();
    expect(await screen.findByTestId('web-service-status-lamp')).toHaveClass(
      'settings-status-dot-success'
    );

    const webAccess = (
      await screen.findByRole('heading', { name: 'Web 访问' })
    ).closest('.settings-section') as HTMLElement | null;
    expect(webAccess).not.toBeNull();
    expect(
      within(webAccess!).getByText('http://127.0.0.1:17891')
    ).toBeVisible();
    expect(
      within(webAccess!).getByText('http://192.168.1.20:17891')
    ).toBeVisible();
    expect(within(webAccess!).getByText(window.location.origin)).toBeVisible();
    expect(
      within(webAccess!).getByText('Web UI', { selector: 'label' })
    ).toBeVisible();
    expect(
      within(webAccess!).getByText(/主机|Host/, { selector: 'label' })
    ).toBeVisible();
    expect(
      within(webAccess!).getByText(/局域网|LAN/, { selector: 'label' })
    ).toBeVisible();
  });

  it('lists loopback and LAN from the same Host port when it serves the Web UI', async () => {
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

    const webAccess = (
      await screen.findByRole('heading', { name: 'Web 访问' })
    ).closest('.settings-section') as HTMLElement | null;
    expect(webAccess).not.toBeNull();
    expect(
      within(webAccess!).getByText('http://127.0.0.1:17891')
    ).toBeVisible();
    expect(
      within(webAccess!).getByText('http://192.168.1.20:17891')
    ).toBeVisible();
    expect(within(webAccess!).queryByText('Web UI')).not.toBeInTheDocument();
  });

  it('opens the Host address in the system browser', async () => {
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

    const loopback = (
      await screen.findByText('http://127.0.0.1:17891')
    ).closest('.settings-row') as HTMLElement | null;
    await user.click(
      within(loopback!).getByRole('button', { name: /打开|Open/ })
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

    expect(await screen.findByText('当前状态')).toBeVisible();
    expect(screen.queryByAltText('地址二维码')).not.toBeInTheDocument();
    expect(
      screen.queryByText(/在同一网络的另一台设备上扫描/)
    ).not.toBeInTheDocument();
  });

  it('saves the edited access configuration through the action bar', async () => {
    const user = userEvent.setup();
    renderSettings();

    const port = await screen.findByRole('spinbutton', { name: '监听端口' });
    await user.clear(port);
    await user.type(port, '19000');
    await user.click(screen.getByRole('button', { name: '探测' }));
    await waitFor(() =>
      expect(webServiceApiMock.probePort).toHaveBeenCalledWith(19000)
    );
    await user.click(screen.getByRole('switch', { name: '自动启动' }));
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(webServiceApiMock.updateConfig).toHaveBeenCalledWith({
        port: 19000,
        token: null,
        auto_start: true,
        allow_lan: false,
      })
    );
  });

  it('lists paired devices under device pairing', async () => {
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

    expect(await screen.findByText('已配对设备')).toBeVisible();
    expect(screen.getByText('Pixel 9')).toBeVisible();
    expect(screen.getByRole('button', { name: '撤销' })).toBeVisible();
  });
});
