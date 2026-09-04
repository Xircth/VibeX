import type {
  BackendTransport,
  RemoteEvent,
  ServerCapabilities,
  SubscriptionRequest,
} from './backendTransport';
import { WebTransport } from './webTransport';

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
  private readonly live: WebTransport;
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
    this.live = new WebTransport({ baseUrl: this.baseUrl, token });
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

  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
    if (this.destroyed) {
      return Promise.resolve(() => undefined);
    }
    return this.live.listen(event, handler);
  }

  subscribe(request: SubscriptionRequest): AsyncIterable<RemoteEvent> {
    return this.live.subscribe(request);
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
    this.live.destroy();
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
