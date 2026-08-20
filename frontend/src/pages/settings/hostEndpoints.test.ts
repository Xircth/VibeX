import { describe, expect, it, vi } from 'vitest';

import {
  defaultHostUrl,
  explicitHostUrl,
  hostEndpointsFromStatus,
  looksLikeVibexHost,
  presentRemoteAccess,
} from './hostEndpoints';

describe('hostEndpointsFromStatus', () => {
  it('keeps loopback, LAN, and published origins as distinct rows', () => {
    expect(
      hostEndpointsFromStatus({
        address: 'http://127.0.0.1:17891',
        addresses: ['http://127.0.0.1:17891', 'http://192.168.1.20:17891'],
        reachability: [
          { origin: 'http://192.168.1.20:17891', kind: 'lan' },
          { origin: 'https://host.example.ts.net', kind: 'tailscale' },
        ],
      })
    ).toEqual([
      { origin: 'http://127.0.0.1:17891', kind: 'thisComputer' },
      { origin: 'http://192.168.1.20:17891', kind: 'lan' },
      { origin: 'https://host.example.ts.net', kind: 'published' },
    ]);
  });
});

describe('presentRemoteAccess', () => {
  it('hides endpoints while the Host is stopped', () => {
    expect(
      presentRemoteAccess({
        running: false,
        address: 'http://127.0.0.1:17891',
      })
    ).toEqual([]);
  });

  it('uses the Host loopback as the browser address when this port serves the Web UI', () => {
    expect(
      presentRemoteAccess({
        running: true,
        servesWebUi: true,
        address: 'http://127.0.0.1:17891',
        addresses: ['http://127.0.0.1:17891', 'http://192.168.1.20:17891'],
        windowOrigin: 'http://127.0.0.1:3000',
      })
    ).toEqual([
      {
        kind: 'thisComputer',
        origin: 'http://127.0.0.1:17891',
        openHref: 'http://127.0.0.1:17891',
      },
      {
        kind: 'lan',
        origin: 'http://192.168.1.20:17891',
        openHref: 'http://192.168.1.20:17891',
      },
    ]);
  });

  it('shows the local Web UI and Host listen addresses when they are different ports', () => {
    expect(
      presentRemoteAccess({
        running: true,
        servesWebUi: false,
        address: 'http://127.0.0.1:17891',
        addresses: ['http://127.0.0.1:17891', 'http://192.168.1.20:17891'],
        windowOrigin: 'http://127.0.0.1:3000',
      })
    ).toEqual([
      {
        kind: 'browser',
        origin: 'http://127.0.0.1:3000',
        openHref: 'http://127.0.0.1:3000/?host=http%3A%2F%2F127.0.0.1%3A17891',
      },
      {
        kind: 'thisComputer',
        origin: 'http://127.0.0.1:17891',
        openHref: 'http://127.0.0.1:17891',
      },
      {
        kind: 'lan',
        origin: 'http://192.168.1.20:17891',
        openHref: 'http://192.168.1.20:17891',
      },
    ]);
  });
});

describe('defaultHostUrl', () => {
  it('prefers an explicit host query over the page origin', () => {
    expect(
      defaultHostUrl('http://127.0.0.1:3000', '?host=http://127.0.0.1:17891')
    ).toBe('http://127.0.0.1:17891');
  });

  it('falls back to the page origin when no host is supplied', () => {
    expect(defaultHostUrl('http://127.0.0.1:17891', '')).toBe(
      'http://127.0.0.1:17891'
    );
  });
});

describe('explicitHostUrl', () => {
  it('returns null when the page did not name a Host', () => {
    expect(explicitHostUrl('')).toBeNull();
  });
});

describe('looksLikeVibexHost', () => {
  it('accepts the Host health JSON and rejects HTML shells', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:17891/')) {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('<!doctype html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    expect(await looksLikeVibexHost('http://127.0.0.1:17891', fetchImpl)).toBe(
      true
    );
    expect(await looksLikeVibexHost('http://127.0.0.1:3001', fetchImpl)).toBe(
      false
    );
  });
});
