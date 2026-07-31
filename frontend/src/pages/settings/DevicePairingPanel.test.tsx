import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { BackendTransport } from '@/lib/backendTransport';
import { DevicePairingPanel } from './DevicePairingPanel';

describe('DevicePairingPanel', () => {
  it('creates a short-lived pairing challenge without placing the secret in a URL', async () => {
    const user = userEvent.setup();
    const createDevicePairing = vi.fn(async () => ({
      pairing_id: '0195d6f4-8c37-7b28-a982-6a9e60142f55',
      pairing_token: 'pair-once-secret',
      expires_at: '2026-07-31T05:05:00Z',
      requested_scopes: ['conversation.read', 'conversation.question'],
    }));
    const transport: BackendTransport = {
      environment: 'web',
      call: vi.fn(),
      createDevicePairing,
    };

    render(<DevicePairingPanel transport={transport} />);
    await user.click(
      screen.getByRole('button', { name: '创建设备配对' })
    );

    expect(createDevicePairing).toHaveBeenCalledWith({
      requested_scopes: ['conversation.read', 'conversation.question'],
    });
    expect(
      await screen.findByRole('img', { name: '设备配对二维码' })
    ).toBeVisible();
    expect(screen.getByText('pair-once-secret')).toBeVisible();
    expect(screen.getByText(/仅显示一次/)).toBeVisible();
    expect(
      screen.queryByText(/pair-once-secret.*https?:/)
    ).not.toBeInTheDocument();
  });
});
