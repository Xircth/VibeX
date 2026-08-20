import { describe, expect, it } from 'vitest';

import {
  encodePairingInvitation,
  pairingDisplayOrigins,
  pairingLiveStatus,
  pairingVisibleOrigins,
} from './pairingInvitation';

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

describe('pairingDisplayOrigins', () => {
  it('keeps LAN first and includes loopback only in the expanded list', () => {
    const origins = pairingDisplayOrigins(
      [
        { origin: 'https://host.example.ts.net', kind: 'tailscale' },
        { origin: 'http://192.168.1.20:17891', kind: 'lan' },
      ],
      ['http://127.0.0.1:17891', 'http://192.168.1.20:17891']
    );

    expect(origins.map((item) => item.origin)).toEqual([
      'http://192.168.1.20:17891',
      'https://host.example.ts.net',
      'http://127.0.0.1:17891',
    ]);
    expect(pairingVisibleOrigins(origins, false)).toEqual([
      { origin: 'http://192.168.1.20:17891', kind: 'lan' },
    ]);
    expect(pairingVisibleOrigins(origins, true)).toEqual(origins);
  });
});

describe('pairingLiveStatus', () => {
  const expiresAt = '2026-08-20T06:10:00Z';
  const issuedAt = Date.parse('2026-08-20T06:05:00Z');

  it('stays waiting until expiry or a new device appears', () => {
    expect(
      pairingLiveStatus({
        expiresAt,
        now: issuedAt + 30_000,
        issuedAt,
        devices: [],
      })
    ).toBe('waiting');
  });

  it('marks connected when a device is created after the code is issued', () => {
    expect(
      pairingLiveStatus({
        expiresAt,
        now: issuedAt + 30_000,
        issuedAt,
        devices: [{ created_at: '2026-08-20T06:05:08Z' }],
      })
    ).toBe('connected');
  });

  it('marks failed after expiry without a new device', () => {
    expect(
      pairingLiveStatus({
        expiresAt,
        now: Date.parse(expiresAt) + 1,
        issuedAt,
        devices: [],
      })
    ).toBe('failed');
  });
});
