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
  listen(
    profileId: string,
    event: string,
    handler: (payload: unknown) => void
  ): Promise<() => void>;
  subscribe(
    profileId: string,
    request: SubscriptionRequest
  ): AsyncIterable<RemoteEvent>;
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
  async listen(profileId, event, handler) {
    const { tauriInvoke, tauriListen } = await import('@/lib/tauriApi');
    await tauriInvoke('remote_desktop_listen', { profileId, event });
    return tauriListen(`remote-desktop:${profileId}:${event}`, handler);
  },
  subscribe(profileId, request) {
    return subscribeRemoteDesktop(profileId, request);
  },
};

async function* subscribeRemoteDesktop(
  profileId: string,
  request: SubscriptionRequest
): AsyncIterable<RemoteEvent> {
  const [{ Channel }, { tauriInvoke }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@/lib/tauriApi'),
  ]);
  const queue: RemoteEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const channel = new Channel<RemoteEvent>();
  channel.onmessage = (event) => {
    queue.push(event);
    wake?.();
    wake = undefined;
  };
  await tauriInvoke('remote_desktop_subscribe', {
    profileId,
    request: {
      ...request,
      after_sequence: Number(request.after_sequence),
    },
    onEvent: channel,
  });
  try {
    while (!closed) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const next = queue.shift();
      if (next) {
        yield next;
      }
    }
  } finally {
    closed = true;
  }
}

/**
 * A window-owned remote connection. Credentials cross the WebView boundary
 * once during `connect` and live only in the Rust adapter afterwards.
 */
export class RemoteDesktopTransport implements BackendTransport {
  readonly environment = 'remote-desktop' as const;
  readonly profileId: string;
  private readonly baseUrl: string;
  private readonly bridge: RemoteDesktopBridge;
  private destroyed = false;

  private constructor(
    profileId: string,
    baseUrl: string,
    bridge: RemoteDesktopBridge
  ) {
    this.profileId = profileId;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
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

  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
    if (this.destroyed) {
      return Promise.resolve(() => undefined);
    }
    return this.bridge.listen(this.profileId, event, (payload) =>
      handler(payload as T)
    );
  }

  subscribe(request: SubscriptionRequest): AsyncIterable<RemoteEvent> {
    return this.bridge.subscribe(this.profileId, request);
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

  toJSON(): { environment: string; profileId: string; baseUrl: string } {
    return {
      environment: this.environment,
      profileId: this.profileId,
      baseUrl: this.baseUrl,
    };
  }
}
