import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackendTransport } from '@/lib/backendTransport';
import { DevicePairingPanel } from './DevicePairingPanel';

const webServiceApiMock = vi.hoisted(() => ({
  createPairing: vi.fn(),
  listDevices: vi.fn(),
  revokeDevice: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  webServiceApi: webServiceApiMock,
}));

const qrPayloads: string[] = [];

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn(async (text: string) => {
      qrPayloads.push(text);
      return `data:image/png;base64,${btoa(text)}`;
    }),
  },
}));

describe('DevicePairingPanel', () => {
  beforeEach(() => {
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    webServiceApiMock.listDevices.mockResolvedValue([]);
    webServiceApiMock.revokeDevice.mockResolvedValue(undefined);
  });

  it('creates a short-lived pairing challenge without placing the secret in a URL', async () => {
    const user = userEvent.setup();
    qrPayloads.length = 0;
    const invitation =
      'vibex-pairing:{"host_id":"host-1","preset":"companion","pairing_token":"pair-once-secret","reachability":[{"origin":"http://192.168.1.20:17891","kind":"lan"}]}';
    const createDevicePairing = vi.fn(async () => ({
      pairing_id: '0195d6f4-8c37-7b28-a982-6a9e60142f55',
      pairing_token: 'K7M2NPQX',
      connection_code: 'K7M2NPQX',
      expires_at: '2026-08-31T05:05:00Z',
      requested_scopes: ['conversation.read', 'conversation.question'],
      host_id: 'host-1',
      invitation,
      reachability: [{ origin: 'http://192.168.1.20:17891', kind: 'lan' }],
    }));
    const transport: BackendTransport = {
      environment: 'web',
      call: vi.fn(),
      createDevicePairing,
    };

    render(
      <DevicePairingPanel
        transport={transport}
        hostUrls={['http://127.0.0.1:17891', 'http://192.168.1.20:17891']}
      />
    );
    await user.click(screen.getByRole('button', { name: '生成连接码' }));

    expect(createDevicePairing).toHaveBeenCalledWith({
      preset: 'companion',
      ttl_seconds: 300,
    });
    expect(screen.getByRole('heading', { name: '客户端访问' })).toBeVisible();
    expect(
      await screen.findByRole('img', { name: '设备配对二维码' })
    ).toBeVisible();
    expect(screen.getByText('K7M2NPQX')).toBeVisible();
    expect(screen.getByText(/仅显示一次/)).toBeVisible();
    expect(qrPayloads.at(-1)).toBe(invitation);
    expect(qrPayloads.at(-1)).not.toContain('127.0.0.1');
    expect(qrPayloads.at(-1)).not.toContain('vbx_device_');
    expect(
      screen.queryByText(/pair-once-secret.*https?:/)
    ).not.toBeInTheDocument();
    const devicesToggle = screen.getByRole('button', { name: /已配对设备/ });
    expect(devicesToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('还没有已配对设备')).toBeVisible();
    const qr = await screen.findByRole('img', { name: '设备配对二维码' });
    expect(qr).toHaveAttribute('width', '144');
    expect(qr).toHaveAttribute('height', '144');
    expect(screen.getByText('http://192.168.1.20:17891')).toBeVisible();
    expect(
      screen.queryByText('http://127.0.0.1:17891')
    ).not.toBeInTheDocument();
    const copy = screen.getByRole('button', { name: '复制连接码' });
    const code = screen.getByText('K7M2NPQX');
    const label = screen.getByText('连接码');
    const row = label.closest('.settings-pairing-code-row');
    const invite = qr.closest('.settings-pairing-invite');
    const addresses = screen
      .getByText('http://192.168.1.20:17891')
      .closest('.settings-pairing-addresses');
    const meta = screen.getByText('有效期').closest('.settings-pairing-meta');
    expect(copy).toHaveTextContent('');
    expect(code.closest('.settings-pairing-code')).toContainElement(copy);
    expect(row).toContainElement(label);
    expect(row).toContainElement(code);
    expect(row).toHaveClass('settings-pairing-code-row');
    expect(row?.parentElement).toHaveClass('settings-pairing-fields');
    expect(invite).toContainElement(row);
    expect(invite).not.toContainElement(addresses as HTMLElement);
    expect(addresses).toBeTruthy();
    expect(screen.getByText('等待连接')).toBeVisible();
    expect(meta).toContainElement(
      screen.getByRole('combobox', { name: '有效期' })
    );
    expect(meta).toContainElement(screen.getByText('等待连接'));
    expect(screen.queryByText('状态')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '有效期' })).toHaveTextContent(
      '5 分钟'
    );
  });

  it('expands every connection address with a copy control', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const createDevicePairing = vi.fn(async () => ({
      pairing_id: 'pair-2',
      pairing_token: 'K7M2NPQX',
      connection_code: 'K7M2NPQX',
      expires_at: '2026-08-31T05:05:00Z',
      requested_scopes: ['conversation.read'],
      invitation: 'vibex-pairing:{"pairing_token":"K7M2NPQX"}',
      reachability: [
        { origin: 'http://192.168.1.20:17891', kind: 'lan' },
        { origin: 'https://host.example.ts.net', kind: 'tailscale' },
      ],
    }));

    render(
      <DevicePairingPanel
        transport={{
          environment: 'desktop',
          call: vi.fn(),
          createDevicePairing,
        }}
        hostUrls={['http://127.0.0.1:17891', 'http://192.168.1.20:17891']}
      />
    );
    await user.click(screen.getByRole('button', { name: '生成连接码' }));

    expect(screen.getByText('http://192.168.1.20:17891')).toBeVisible();
    expect(
      screen.queryByText('https://host.example.ts.net')
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '显示全部地址' }));
    expect(screen.getByText('https://host.example.ts.net')).toBeVisible();
    expect(screen.getByText('http://127.0.0.1:17891')).toBeVisible();

    await user.click(
      screen.getByRole('button', {
        name: '复制地址 http://192.168.1.20:17891',
      })
    );
    expect(writeText).toHaveBeenCalledWith('http://192.168.1.20:17891');
  });

  it('sends the selected pairing lifetime and reports a successful device join', async () => {
    const user = userEvent.setup();
    webServiceApiMock.listDevices.mockImplementation(async () => [
      {
        device_id: 'dev-1',
        device_name: 'Pixel 9',
        scopes: ['conversation.read'],
        created_at: new Date().toISOString(),
        preset: 'companion',
      },
    ]);
    const createDevicePairing = vi.fn(async () => ({
      pairing_id: 'pair-3',
      pairing_token: 'K7M2NPQX',
      connection_code: 'K7M2NPQX',
      expires_at: new Date(Date.now() + 900_000).toISOString(),
      requested_scopes: ['conversation.read'],
      invitation: 'vibex-pairing:{"pairing_token":"K7M2NPQX"}',
      reachability: [{ origin: 'http://192.168.1.20:17891', kind: 'lan' }],
    }));

    render(
      <DevicePairingPanel
        transport={{
          environment: 'desktop',
          call: vi.fn(),
          createDevicePairing,
        }}
        hostUrls={['http://192.168.1.20:17891']}
      />
    );
    await user.click(screen.getByRole('button', { name: '生成连接码' }));
    await user.click(screen.getByRole('combobox', { name: '有效期' }));
    await user.click(screen.getByRole('option', { name: '15 分钟' }));

    expect(createDevicePairing).toHaveBeenLastCalledWith({
      preset: 'companion',
      ttl_seconds: 900,
    });
    expect(await screen.findByText('连接成功')).toBeVisible();
  });

  it('asks the user to start the service before generating a code', async () => {
    const user = userEvent.setup();
    const { toast } = await import('@/components/ui/toast');
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(),
      createDevicePairing: vi.fn(),
    };

    render(
      <DevicePairingPanel
        transport={transport}
        serviceRunning={false}
        hostUrls={['http://192.168.1.20:17891']}
      />
    );
    await user.click(screen.getByRole('button', { name: '生成连接码' }));

    expect(toast.error).toHaveBeenCalledWith('请先开启远程连接服务');
    expect(transport.createDevicePairing).not.toHaveBeenCalled();
  });

  it('collapses the paired-device list from its default expanded state', async () => {
    const user = userEvent.setup();
    webServiceApiMock.listDevices.mockResolvedValue([
      {
        device_id: 'dev-1',
        device_name: 'Pixel 9',
        scopes: ['conversation.read'],
        created_at: '2026-08-18T12:00:00Z',
        preset: 'companion',
      },
    ]);

    render(
      <DevicePairingPanel
        transport={{ environment: 'desktop', call: vi.fn() }}
        hostUrls={['http://192.168.1.20:17891']}
      />
    );

    expect(await screen.findByText('Pixel 9')).toBeVisible();
    const toggle = screen.getByRole('button', { name: /已配对设备/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Pixel 9')).not.toBeInTheDocument();

    await user.click(toggle);
    expect(screen.getByText('Pixel 9')).toBeVisible();
  });

  it('stretches the paired-device list across the client-access card', async () => {
    webServiceApiMock.listDevices.mockResolvedValue([
      {
        device_id: 'dev-1',
        device_name: 'Pixel 9',
        scopes: ['conversation.read'],
        created_at: '2026-08-18T12:00:00Z',
        preset: 'companion',
      },
    ]);

    render(
      <DevicePairingPanel
        transport={{ environment: 'desktop', call: vi.fn() }}
        hostUrls={['http://192.168.1.20:17891']}
      />
    );

    expect(await screen.findByText('Pixel 9')).toBeVisible();
    const deviceClassRow = screen
      .getByText('设备类型')
      .closest('.settings-row');
    const pairedList = screen
      .getByRole('button', { name: /已配对设备/ })
      .closest('.settings-pairing-devices');

    expect(deviceClassRow).not.toBeNull();
    expect(pairedList).not.toBeNull();
    expect(pairedList).not.toBe(deviceClassRow);
    expect(within(pairedList!).getByText('伴随端')).toHaveClass(
      'settings-pairing-devices__preset'
    );
  });
});
