import { describe, expect, it, vi } from 'vitest';

import {
  RemoteDesktopTransport,
  type RemoteDesktopBridge,
} from './remoteDesktopTransport';

describe('RemoteDesktopTransport', () => {
  it('keeps two windows connected to different Rust-owned profiles isolated', async () => {
    const calls: Array<[string, string]> = [];
    const bridge: RemoteDesktopBridge = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      capabilities: vi.fn().mockResolvedValue({
        server_version: '1',
        protocol_version: '1.0',
        minimum_client_version: '0.1',
        capabilities: [],
      }),
      call: vi.fn(async (profileId, command) => {
        calls.push([profileId, command]);
        if (command === 'conversation_list') return profileId;
        return {
          ready: true,
          snapshot: null,
          replay: [
            {
              sequence: 1,
              kind: `from-${profileId}`,
              payload: {},
            },
          ],
          high_water_mark: 1,
        };
      }),
    };
    const windowA = await RemoteDesktopTransport.connect(
      {
        profileId: 'profile-a',
        baseUrl: 'https://server-a.example',
        token: 'token-a',
      },
      bridge
    );
    const windowB = await RemoteDesktopTransport.connect(
      {
        profileId: 'profile-b',
        baseUrl: 'https://server-b.example',
        token: 'token-b',
      },
      bridge
    );

    await expect(windowA.call('conversation_list')).resolves.toBe('profile-a');
    await expect(windowB.call('conversation_list')).resolves.toBe('profile-b');
    const eventA = await windowA
      .subscribe({
        subscription_id: '00000000-0000-4000-8000-000000000001',
        resource: 'conversation',
        conversation_id: '00000000-0000-4000-8000-000000000011',
        after_sequence: 0n,
      })
      [Symbol.asyncIterator]()
      .next();
    const eventB = await windowB
      .subscribe({
        subscription_id: '00000000-0000-4000-8000-000000000002',
        resource: 'conversation',
        conversation_id: '00000000-0000-4000-8000-000000000022',
        after_sequence: 0n,
      })
      [Symbol.asyncIterator]()
      .next();

    expect(eventA.value?.kind).toBe('from-profile-a');
    expect(eventB.value?.kind).toBe('from-profile-b');
    expect(calls).toEqual(
      expect.arrayContaining([
        ['profile-a', 'conversation_list'],
        ['profile-b', 'conversation_list'],
        ['profile-a', 'conversation_attach'],
        ['profile-b', 'conversation_attach'],
      ])
    );
    expect(JSON.stringify(windowA)).not.toContain('token-a');
    expect(JSON.stringify(windowB)).not.toContain('token-b');
    await windowA.destroy();
    await windowB.destroy();
  });
});
