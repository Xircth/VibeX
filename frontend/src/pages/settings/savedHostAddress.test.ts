import { describe, expect, it } from 'vitest';

import {
  provisionKindLabel,
  savedHostAddress,
  savedHostOrigin,
  savedHostSource,
} from './savedHostAddress';

describe('savedHostAddress', () => {
  it('shows the remote Host IP and service port instead of the local tunnel', () => {
    expect(
      savedHostAddress({
        origin: 'http://127.0.0.1:56064',
        provision: {
          host: '203.0.113.8',
          port: 22,
          user: 'root',
          servicePort: 17891,
        },
      })
    ).toBe('203.0.113.8:17891');
  });

  it('uses a non-loopback advertised address when servicePort is missing', () => {
    expect(
      savedHostAddress({
        origin: 'http://127.0.0.1:61091',
        provision: {
          host: '203.0.113.8',
          port: 22,
          user: 'root',
          addresses: ['http://127.0.0.1:17891', 'http://203.0.113.8:17891'],
        },
      })
    ).toBe('203.0.113.8:17891');
  });

  it('keeps LAN Host origins without a provision target', () => {
    expect(
      savedHostAddress({
        origin: 'http://192.168.1.8:17891',
      })
    ).toBe('192.168.1.8:17891');
  });
});

describe('savedHostOrigin', () => {
  it('connects leftover tunnel origins through the advertised Host address', () => {
    expect(
      savedHostOrigin({
        origin: 'http://127.0.0.1:41234',
        provision: {
          host: '203.0.113.8',
          port: 22,
          user: 'root',
          servicePort: 17891,
        },
      })
    ).toBe('http://203.0.113.8:17891');
    expect(
      savedHostOrigin({
        origin: 'http://192.168.1.8:17891',
      })
    ).toBe('http://192.168.1.8:17891');
  });
});

describe('provisionKindLabel', () => {
  it('uses the matching provisioner label and does not special-case a kind', () => {
    expect(
      provisionKindLabel('wireguard', [{ kind: 'wireguard', label: 'WireGuard' }])
    ).toBe('WireGuard');
    expect(provisionKindLabel('ssh')).toBe('SSH');
    expect(provisionKindLabel('discovered')).toBeNull();
    expect(provisionKindLabel('manual')).toBeNull();
  });
});

describe('savedHostSource', () => {
  it('classifies saved Hosts into the four client sources', () => {
    expect(savedHostSource('discovered')).toBe('discovered');
    expect(savedHostSource('manual')).toBe('manual');
    expect(savedHostSource(null)).toBe('manual');
    expect(savedHostSource('ssh')).toBe('ssh');
    expect(savedHostSource('wireguard')).toBe('other');
  });
});
