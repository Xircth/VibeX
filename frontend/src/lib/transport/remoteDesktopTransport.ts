import type {
  BackendTransport,
  RemoteEvent,
  ServerCapabilities,
  SubscriptionRequest,
} from './backendTransport';

export type RemoteDesktopProfile = {
  profileId: string;
  baseUrl: string;
  token: string;
};

export interface RemoteDesktopBridge {
  connect(profile: RemoteDesktopProfile): Promise<void>;
  disconnect(profileId: string): Promise<void>;
  call(
    profileId: string,
    command: string,
    args?: Record<string, unknown>,
    operationId?: string
  ): Promise<unknown>;
  capabilities(profileId: string): Promise<ServerCapabilities>;
}

const tauriBridge: RemoteDesktopBridge = {
  async connect(profile) {
    const { tauriInvoke } = await import('@/lib/tauriApi');
    await tauriInvoke('remote_desktop_connect', { profile });
  },
  async disconnect(profileId) {
    const { tauriInvoke } = await import('@/lib/tauriApi');
    await tauriInvoke('remote_desktop_disconnect', { profileId });
  },
  async call(profileId, command, args, operationId) {
    const { tauriInvoke } = await import('@/lib/tauriApi');
    return tauriInvoke('remote_desktop_call', {
      profileId,
      command,
      args: args ?? {},
      operationId,
    });
  },
  async capabilities(profileId) {
    const { tauriInvoke } = await import('@/lib/tauriApi');
    return tauriInvoke('remote_desktop_capabilities', { profileId });
  },
};

function eventsFromBootstrap(value: unknown): RemoteEvent[] {
  if (typeof value !== 'object' || value === null) return [];
  const bootstrap = value as {
    snapshot?: { payload?: { events?: unknown[] } } | null;
    replay?: unknown[];
  };
  const wireEvents = [
    ...(bootstrap.snapshot?.payload?.events ?? []),
    ...(bootstrap.replay ?? []),
  ];
  return wireEvents.flatMap((event) => {
    if (
      typeof event !== 'object' ||
      event === null ||
      !('sequence' in event) ||
      typeof event.sequence !== 'number' ||
      !Number.isSafeInteger(event.sequence) ||
      !('kind' in event) ||
      typeof event.kind !== 'string' ||
      !('payload' in event)
    ) {
      return [];
    }
    return [
      {
        ...(event as unknown as Omit<RemoteEvent, 'sequence'>),
        sequence: BigInt(event.sequence),
      },
    ];
  });
}

/**
 * A window-owned remote connection. Credentials cross the WebView boundary
 * once during `connect` and live only in the Rust adapter afterwards.
 */
export class RemoteDesktopTransport implements BackendTransport {
  readonly environment = 'remote-desktop' as const;
  readonly profileId: string;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly bridge: RemoteDesktopBridge;
  private destroyed = false;

  private constructor(
    profileId: string,
    baseUrl: string,
    token: string,
    bridge: RemoteDesktopBridge
  ) {
    this.profileId = profileId;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.bridge = bridge;
  }

  static async connect(
    profile: RemoteDesktopProfile,
    bridge: RemoteDesktopBridge = tauriBridge
  ): Promise<RemoteDesktopTransport> {
    await bridge.connect(profile);
    return new RemoteDesktopTransport(
      profile.profileId,
      profile.baseUrl,
      profile.token,
      bridge
    );
  }

  call(
    command: string,
    args?: Record<string, unknown>,
    options?: { operationId?: string }
  ): Promise<unknown> {
    return this.bridge.call(
      this.profileId,
      command,
      args,
      options?.operationId
    );
  }

  capabilities(): Promise<ServerCapabilities> {
    return this.bridge.capabilities(this.profileId);
  }

  async listen<T>(
    event: string,
    handler: (payload: T) => void
  ): Promise<() => void> {
    const prefix = 'terminal-output:';
    if (!event.startsWith(prefix) || this.destroyed) {
      return () => undefined;
    }
    const controller = new AbortController();
    const sessionId = event.slice(prefix.length);
    void (async () => {
      try {
        const response = await fetch(
          `${this.baseUrl}/api/v1/terminals/${encodeURIComponent(sessionId)}/output`,
          {
            headers: {
              Authorization: `Bearer ${this.token}`,
              'X-VibeX-Protocol-Version': '1.0',
            },
            signal: controller.signal,
          }
        );
        if (!response.ok || !response.body) {
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
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
              (handler as (payload: string) => void)(data);
            }
          }
        }
      } catch {
        // Panel close and disconnect abort the stream.
      }
    })();
    return () => controller.abort();
  }

  async *subscribe(request: SubscriptionRequest): AsyncIterable<RemoteEvent> {
    let cursor = request.after_sequence;
    while (!this.destroyed) {
      if (
        cursor < BigInt(Number.MIN_SAFE_INTEGER) ||
        cursor > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        throw new Error(
          'Conversation sequence exceeds JSON-safe integer range'
        );
      }
      const bootstrap = await this.call('conversation_attach', {
        request: {
          ...request,
          after_sequence: Number(cursor),
        },
      });
      const events = eventsFromBootstrap(bootstrap);
      for (const event of events) {
        if (event.sequence > cursor) {
          cursor = event.sequence;
          yield event;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  artifactPreviewUrl(lease: {
    leaseId: string;
    capabilityToken: string;
    loopbackPort: number;
  }): string {
    return `${this.baseUrl}/api/v1/previews/${encodeURIComponent(
      lease.leaseId
    )}/c/${encodeURIComponent(lease.capabilityToken)}/`;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.bridge.disconnect(this.profileId);
  }
}
