import type {
  BackendTransport,
  CreateDevicePairingRequest,
  DevicePairingChallenge,
  RemoteEvent,
  ServerCapabilities,
  SubscriptionRequest,
} from './backendTransport';

const PROTOCOL_VERSION = '1.0';

export interface WebTransportOptions {
  baseUrl: string;
  token: string;
}

type CommandResponse = {
  operation_id: string;
  data: unknown;
};

type ErrorEnvelope = {
  code?: string;
  message?: string;
  retryable?: boolean;
  operation_id?: string;
};

export class WebTransportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly operationId?: string
  ) {
    super(message);
    this.name = 'WebTransportError';
  }
}

type WireRemoteEvent = Omit<RemoteEvent, 'sequence'> & { sequence: number };

type WireServerMessage =
  | { type: 'ready'; subscription_id: string }
  | {
      type: 'snapshot';
      subscription_id: string;
      snapshot: {
        through_sequence: number;
        payload: RemoteEvent['payload'];
      };
    }
  | {
      type: 'event';
      subscription_id: string;
      event: WireRemoteEvent;
    }
  | {
      type: 'live';
      subscription_id: string;
      high_water_mark: number;
    }
  | { type: 'detached'; subscription_id: string; reason: string }
  | { type: 'pong' }
  | { type: 'error'; error: unknown };

class AsyncEventQueue {
  private readonly values: RemoteEvent[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<RemoteEvent>) => void
  > = [];
  private ended = false;

  push(value: RemoteEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
    } else if (!this.ended) {
      this.values.push(value);
    }
  }

  next(): Promise<IteratorResult<RemoteEvent>> {
    const value = this.values.shift();
    if (value) {
      return Promise.resolve({ done: false, value });
    }
    if (this.ended) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }
}

type ActiveSubscription = {
  request: SubscriptionRequest;
  cursor: bigint;
  queue: AsyncEventQueue;
};

export class WebTransport implements BackendTransport {
  readonly environment = 'web' as const;
  private readonly baseUrl: string;
  private readonly token: string;
  private socket: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  private destroyed = false;
  private readonly subscriptions = new Map<string, ActiveSubscription>();

  constructor(options: WebTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
  }

  async call(
    command: string,
    args?: Record<string, unknown>,
    options?: { operationId?: string }
  ): Promise<unknown> {
    const response = await this.request(
      `/api/v1/call/${encodeURIComponent(command)}`,
      {
        method: 'POST',
        body: JSON.stringify({
          operation_id: options?.operationId ?? globalThis.crypto.randomUUID(),
          args: args ?? {},
        }),
      }
    );
    const envelope = (await response.json()) as CommandResponse;
    return envelope.data;
  }

  async capabilities(): Promise<ServerCapabilities> {
    const response = await this.request('/api/v1/capabilities');
    return response.json() as Promise<ServerCapabilities>;
  }

  async listen<T>(
    event: string,
    handler: (payload: T) => void
  ): Promise<() => void> {
    const prefix = 'terminal-output:';
    if (!event.startsWith(prefix)) {
      return this.listenHostEvent(event, handler);
    }
    const controller = new AbortController();
    void this.consumeTerminalOutput(
      event.slice(prefix.length),
      handler as (payload: string) => void,
      controller.signal
    );
    return () => controller.abort();
  }

  async createDevicePairing(
    request: CreateDevicePairingRequest
  ): Promise<DevicePairingChallenge> {
    const response = await this.request('/api/v1/auth/pairings', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    return response.json() as Promise<DevicePairingChallenge>;
  }

  artifactPreviewUrl(lease: {
    leaseId: string;
    capabilityToken: string;
  }): string {
    return `${this.baseUrl}/api/v1/previews/${encodeURIComponent(
      lease.leaseId
    )}/c/${encodeURIComponent(lease.capabilityToken)}/`;
  }

  async *subscribe(request: SubscriptionRequest): AsyncIterable<RemoteEvent> {
    const subscription: ActiveSubscription = {
      request,
      cursor: request.after_sequence,
      queue: new AsyncEventQueue(),
    };
    this.subscriptions.set(request.subscription_id, subscription);
    this.connectSocket();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendAttach(subscription);
    }
    try {
      while (true) {
        const next = await subscription.queue.next();
        if (next.done) {
          return;
        }
        yield next.value;
      }
    } finally {
      this.subscriptions.delete(request.subscription_id);
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(
          JSON.stringify({
            type: 'detach',
            subscription_id: request.subscription_id,
          })
        );
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.socket) {
      this.detachSocketHandlers(this.socket);
      this.socket.close();
      this.socket = undefined;
    }
    for (const subscription of this.subscriptions.values()) {
      subscription.queue.close();
    }
    this.subscriptions.clear();
  }

  private async request(
    path: string,
    init: Omit<RequestInit, 'headers'> = {}
  ): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'X-VibeX-Protocol-Version': PROTOCOL_VERSION,
      },
    });
    if (!response.ok) {
      let envelope: ErrorEnvelope = {};
      try {
        envelope = (await response.json()) as ErrorEnvelope;
      } catch {
        // Preserve a stable local error even if an intermediary returned HTML.
      }
      throw new WebTransportError(
        envelope.message ?? `VibeX Server returned HTTP ${response.status}`,
        envelope.code ?? 'remote_http_error',
        envelope.retryable ?? false,
        envelope.operation_id
      );
    }
    return response;
  }

  private connectSocket(): void {
    if (this.destroyed || this.socket || this.subscriptions.size === 0) {
      return;
    }
    const socket = new WebSocket(this.webSocketUrl(), [
      'vibex.v1',
      `vibex.token.${base64UrlEncode(this.token)}`,
    ]);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket || this.destroyed) {
        return;
      }
      this.reconnectAttempts = 0;
      for (const subscription of this.subscriptions.values()) {
        this.sendAttach(subscription);
      }
    };
    socket.onmessage = (message) => {
      if (this.socket !== socket || this.destroyed) {
        return;
      }
      try {
        this.handleServerMessage(JSON.parse(message.data) as WireServerMessage);
      } catch {
        // Unknown or malformed frames are ignored without damaging siblings.
      }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = undefined;
      if (!this.destroyed && this.subscriptions.size > 0) {
        this.scheduleReconnect();
      }
    };
  }

  private sendAttach(subscription: ActiveSubscription): void {
    this.socket?.send(
      JSON.stringify({
        type: 'attach',
        request: {
          ...subscription.request,
          after_sequence: sequenceToWire(subscription.cursor),
        },
      })
    );
  }

  private handleServerMessage(message: WireServerMessage): void {
    if (message.type === 'pong' || message.type === 'error') {
      return;
    }
    const subscription = this.subscriptions.get(message.subscription_id);
    if (!subscription || message.type === 'ready') {
      return;
    }
    if (message.type === 'detached') {
      this.subscriptions.delete(message.subscription_id);
      subscription.queue.close();
      return;
    }
    if (message.type === 'snapshot') {
      const sequence = sequenceFromWire(message.snapshot.through_sequence);
      if (sequence >= subscription.cursor) {
        subscription.cursor = sequence;
        subscription.queue.push({
          sequence,
          kind: 'subscription_snapshot',
          payload: message.snapshot.payload,
        });
      }
      return;
    }
    if (message.type === 'live') {
      const sequence = sequenceFromWire(message.high_water_mark);
      if (sequence > subscription.cursor) {
        subscription.cursor = sequence;
      }
      return;
    }
    const sequence = sequenceFromWire(message.event.sequence);
    if (sequence <= subscription.cursor) {
      return;
    }
    subscription.cursor = sequence;
    subscription.queue.push({ ...message.event, sequence });
  }

  private async listenHostEvent<T>(
    channel: string,
    handler: (payload: T) => void
  ): Promise<() => void> {
    const request = {
      subscription_id: globalThis.crypto.randomUUID(),
      resource: 'host_event',
      channel,
      after_sequence: 0n,
    } as SubscriptionRequest;
    const iterator = this.subscribe(request)[Symbol.asyncIterator]();
    let stopped = false;
    void (async () => {
      while (!stopped) {
        const next = await iterator.next();
        if (next.done || stopped) return;
        handler(next.value.payload as T);
      }
    })();
    return () => {
      stopped = true;
      void iterator.return?.();
    };
  }

  private async consumeTerminalOutput(
    sessionId: string,
    handler: (payload: string) => void,
    signal: AbortSignal
  ): Promise<void> {
    try {
      const response = await this.request(
        `/api/v1/terminals/${encodeURIComponent(sessionId)}/output`,
        { signal }
      );
      if (!response.body) {
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data.length > 0) {
            handler(data);
          }
        }
      }
    } catch {
      // Abort and disconnect are expected when the panel closes.
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    const delay = Math.min(250 * 2 ** this.reconnectAttempts, 8_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectSocket();
    }, delay);
  }

  private detachSocketHandlers(socket: WebSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  private webSocketUrl(): string {
    return `${this.baseUrl.replace(/^http/, 'ws')}/api/v1/ws`;
  }
}

function sequenceToWire(sequence: bigint): number {
  if (
    sequence < BigInt(Number.MIN_SAFE_INTEGER) ||
    sequence > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('Conversation sequence exceeds JSON-safe integer range');
  }
  return Number(sequence);
}

function sequenceFromWire(sequence: number): bigint {
  if (!Number.isSafeInteger(sequence)) {
    throw new Error('Server returned a non-JSON-safe conversation sequence');
  }
  return BigInt(sequence);
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
