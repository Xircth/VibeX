import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebTransport } from './webTransport';

vi.mock('@tauri-apps/api/core', () => {
  throw new Error('WebTransport must not import Tauri');
});

class MockWebSocket {
  static readonly OPEN = 1;
  static instances: MockWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[]
  ) {
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  message(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe('WebTransport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    MockWebSocket.instances = [];
  });

  it('performs an authenticated application call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        operation_id: '0195d6f4-8c37-7b28-a982-6a9e60142f55',
        data: [{ title: 'Remote conversation' }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:3080',
      token: 'remote-secret',
    });

    await expect(
      transport.call('conversation_list', { workspaceId: 'workspace-1' })
    ).resolves.toEqual([{ title: 'Remote conversation' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3080/api/v1/call/conversation_list',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer remote-secret',
          'Content-Type': 'application/json',
          'X-VibeX-Protocol-Version': '1.0',
        }),
      })
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.operation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(body.args).toEqual({ workspaceId: 'workspace-1' });
  });

  it('preserves the stable remote error envelope as an actionable Error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          code: 'conflict',
          message: 'Automation Engine is owned by another host',
          retryable: true,
          operation_id: '0195d6f4-8c37-7b28-a982-6a9e60142f55',
        }),
      })
    );
    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:3080',
      token: 'remote-secret',
    });

    await expect(transport.call('automation_run_now')).rejects.toMatchObject({
      name: 'WebTransportError',
      code: 'conflict',
      message: 'Automation Engine is owned by another host',
      retryable: true,
      operationId: '0195d6f4-8c37-7b28-a982-6a9e60142f55',
    });
  });

  it('creates a device pairing challenge without putting either token in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        pairing_id: '0195d6f4-8c37-7b28-a982-6a9e60142f55',
        pairing_token: 'pair-once-secret',
        expires_at: '2026-07-31T05:05:00Z',
        requested_scopes: ['conversation.read', 'conversation.question'],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:3080',
      token: 'remote-secret',
    });

    await expect(
      transport.createDevicePairing({
        requested_scopes: ['conversation.read', 'conversation.question'],
      })
    ).resolves.toMatchObject({ pairing_token: 'pair-once-secret' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3080/api/v1/auth/pairings');
    expect(url).not.toContain('remote-secret');
    expect(url).not.toContain('pair-once-secret');
    expect(init.headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer remote-secret' })
    );
    expect(JSON.parse(init.body as string)).toEqual({
      requested_scopes: ['conversation.read', 'conversation.question'],
    });
  });

  it('multiplexes subscriptions and reconnects from each durable cursor', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:3080',
      token: 'remote-secret',
    });
    const first = transport
      .subscribe({
        subscription_id: '0195d6f4-8c37-7b28-a982-6a9e60142f51',
        resource: 'conversation',
        conversation_id: '0195d6f4-8c37-7b28-a982-6a9e60142f52',
        after_sequence: 0n,
      })
      [Symbol.asyncIterator]();
    const second = transport
      .subscribe({
        subscription_id: '0195d6f4-8c37-7b28-a982-6a9e60142f53',
        resource: 'conversation',
        conversation_id: '0195d6f4-8c37-7b28-a982-6a9e60142f54',
        after_sequence: 5n,
      })
      [Symbol.asyncIterator]();
    const firstEvent = first.next();
    const secondEvent = second.next();

    expect(MockWebSocket.instances).toHaveLength(1);
    const socket = MockWebSocket.instances[0]!;
    expect(socket.url).toBe('ws://127.0.0.1:3080/api/v1/ws');
    expect(socket.url).not.toContain('remote-secret');
    expect(socket.protocols).toEqual([
      'vibex.v1',
      expect.stringMatching(/^vibex\.token\./),
    ]);
    socket.open();
    const attaches = socket.sent.map((frame) => JSON.parse(frame));
    expect(attaches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'attach',
          request: expect.objectContaining({
            subscription_id: '0195d6f4-8c37-7b28-a982-6a9e60142f51',
            after_sequence: 0,
          }),
        }),
        expect.objectContaining({
          type: 'attach',
          request: expect.objectContaining({
            subscription_id: '0195d6f4-8c37-7b28-a982-6a9e60142f53',
            after_sequence: 5,
          }),
        }),
      ])
    );

    socket.message({
      type: 'event',
      subscription_id: '0195d6f4-8c37-7b28-a982-6a9e60142f53',
      event: { sequence: 6, kind: 'second', payload: {} },
    });
    socket.message({
      type: 'event',
      subscription_id: '0195d6f4-8c37-7b28-a982-6a9e60142f51',
      event: { sequence: 1, kind: 'first', payload: {} },
    });
    await expect(firstEvent).resolves.toEqual({
      done: false,
      value: { sequence: 1n, kind: 'first', payload: {} },
    });
    await expect(secondEvent).resolves.toEqual({
      done: false,
      value: { sequence: 6n, kind: 'second', payload: {} },
    });

    socket.drop();
    await vi.advanceTimersByTimeAsync(250);
    expect(MockWebSocket.instances).toHaveLength(2);
    const reconnected = MockWebSocket.instances[1]!;
    reconnected.open();
    const reattaches = reconnected.sent.map((frame) => JSON.parse(frame));
    expect(reattaches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          request: expect.objectContaining({ after_sequence: 1 }),
        }),
        expect.objectContaining({
          request: expect.objectContaining({ after_sequence: 6 }),
        }),
      ])
    );

    await first.return?.();
    await second.return?.();
    transport.destroy();
  });
});
