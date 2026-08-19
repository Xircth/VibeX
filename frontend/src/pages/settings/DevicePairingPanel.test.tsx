import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { BackendTransport } from '@/lib/backendTransport';
import { DevicePairingPanel } from './DevicePairingPanel';

const qrPayloads: string[] = [];

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn(async (text: string) => {
      qrPayloads.push(text);
      return `data:image/png;base64,${btoa(text)}`;
    }),
  },
}));

describe('DevicePairingPanel', () => {
  it('creates a short-lived pairing challenge without placing the secret in a URL', async () => {
    const user = userEvent.setup();
    qrPayloads.length = 0;
    const invitation =
      'vibex-pairing:{"host_id":"host-1","preset":"companion","pairing_token":"pair-once-secret","reachability":[{"origin":"http://192.168.1.20:17891","kind":"lan"}]}';
    const createDevicePairing = vi.fn(async () => ({
      pairing_id: '0195d6f4-8c37-7b28-a982-6a9e60142f55',
      pairing_token: 'K7M2NPQX',
      connection_code: 'K7M2NPQX',
      expires_at: '2026-07-31T05:05:00Z',
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
    });
    expect(screen.getByRole('heading', { name: '设备配对' })).toBeVisible();
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
  });
});
