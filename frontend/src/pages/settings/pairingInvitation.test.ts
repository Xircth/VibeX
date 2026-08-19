import { describe, expect, it } from 'vitest';

import { encodePairingInvitation } from './pairingInvitation';

describe('encodePairingInvitation', () => {
  it('encodes a scannable invitation without loopback or long-lived secrets', () => {
    const invitation = encodePairingInvitation({
      hostId: 'host-stable-1',
      preset: 'companion',
      pairingId: 'pair-1',
      pairingToken: 'vbx_pair_once',
      expiresAt: '2026-08-18T06:00:00Z',
      hostUrls: ['http://127.0.0.1:17891', 'http://192.168.1.20:17891'],
    });

    expect(invitation.startsWith('vibex-pairing:')).toBe(true);
    expect(invitation).toContain('host-stable-1');
    expect(invitation).toContain('http://192.168.1.20:17891');
    expect(invitation).not.toContain('127.0.0.1');
    expect(invitation).not.toContain('vbx_device_');
  });
});
