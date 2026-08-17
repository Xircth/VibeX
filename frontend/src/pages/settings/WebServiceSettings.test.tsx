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
}));

vi.mock('@/lib/api', () => ({
  webServiceApi: webServiceApiMock,
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const stoppedStatus = {
  running: false,
  port: 3080,
  address: null,
  token_configured: false,
  started_at: null,
  message: null,
};

const runningStatus = {
  ...stoppedStatus,
  running: true,
  address: 'http://127.0.0.1:3080',
  addresses: ['http://127.0.0.1:3080'],
  started_at: '2026-08-03T12:00:00Z',
};

function renderSettings() {
  const transport: BackendTransport = {
    environment: 'desktop',
    call: vi.fn(),
    createDevicePairing: vi.fn(),
  };

  return render(
    <BackendTransportProvider transport={transport}>
      <WebServiceSettings />
    </BackendTransportProvider>
  );
}

describe('WebServiceSettings', () => {
  beforeEach(() => {
    for (const fn of Object.values(webServiceApiMock)) {
      fn.mockReset();
    }
    webServiceApiMock.getConfig.mockResolvedValue({
      port: 3080,
      token: null,
      auto_start: false,
      allow_lan: false,
    });
    webServiceApiMock.getStatus.mockResolvedValue(stoppedStatus);
    webServiceApiMock.updateConfig.mockImplementation(async (config) => config);
    webServiceApiMock.start.mockResolvedValue(runningStatus);
    webServiceApiMock.stop.mockResolvedValue(stoppedStatus);
    webServiceApiMock.probePort.mockResolvedValue({
      port: 3080,
      available: true,
      message: null,
    });
    webServiceApiMock.generateToken.mockResolvedValue({
      port: 3080,
      token: 'generated-token',
      auto_start: false,
    });
    webServiceApiMock.createPairing.mockResolvedValue({
      pairing_id: 'pair-1',
      pairing_token: 'pair-once-secret',
      expires_at: '2026-08-17T00:00:00Z',
      requested_scopes: ['conversation.read'],
    });
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

    await user.click(await screen.findByRole('switch', { name: '启动' }));
    await waitFor(() => expect(webServiceApiMock.start).toHaveBeenCalledOnce());

    const stopControl = await screen.findByRole('switch', { name: '停止' });
    expect(
      within(stopControl.closest('.settings-row')!).getByText('运行中')
    ).toBeInTheDocument();

    await user.click(stopControl);
    await waitFor(() => expect(webServiceApiMock.stop).toHaveBeenCalledOnce());
  });

  it('does not discard an unsaved port edit when generating a token', async () => {
    const user = userEvent.setup();
    renderSettings();

    const port = await screen.findByRole('spinbutton', { name: '监听端口' });
    await user.clear(port);
    await user.type(port, '19000');
    await user.click(screen.getByRole('button', { name: '生成' }));

    await waitFor(() =>
      expect(webServiceApiMock.generateToken).toHaveBeenCalledOnce()
    );
    expect(port).toHaveValue(19000);
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
});
