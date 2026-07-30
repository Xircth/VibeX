import type {
  BackendTransport,
  RemoteEvent,
  ServerCapabilities,
  SubscriptionRequest,
} from './backendTransport';

type SubscriptionBootstrap = {
  subscription_id: string;
  ready: boolean;
  snapshot?: { through_sequence: number; payload: unknown };
  replay: RemoteEvent[];
  high_water_mark: number;
};

export class TauriTransport implements BackendTransport {
  readonly environment = 'desktop' as const;

  async call(
    command: string,
    args?: Record<string, unknown>
  ): Promise<unknown> {
    const { tauriInvoke } = await import('@/lib/tauriApi');
    return tauriInvoke(command, args);
  }

  async capabilities(): Promise<ServerCapabilities> {
    return {
      server_version: 'desktop',
      protocol_version: '1.0',
      minimum_client_version: '0.1.0',
      capabilities: [
        'conversation.read',
        'conversation.attach',
        'desktop.tauri',
      ],
    };
  }

  async *subscribe(
    request: SubscriptionRequest
  ): AsyncIterable<RemoteEvent> {
    const { tauriListen } = await import('@/lib/tauriApi');
    let dirty = true;
    let wake: (() => void) | undefined;
    const unlisten = await tauriListen('conversation-events', () => {
      dirty = true;
      wake?.();
      wake = undefined;
    });
    let afterSequence = request.after_sequence;

    try {
      while (true) {
        if (!dirty) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        dirty = false;
        const bootstrap = (await this.call('conversation_attach', {
          request: { ...request, after_sequence: afterSequence },
        })) as SubscriptionBootstrap;
        if (!bootstrap.ready) {
          throw new Error('conversation subscription was not ready');
        }
        if (bootstrap.snapshot) {
          yield {
            sequence: bootstrap.snapshot.through_sequence,
            kind: 'subscription_snapshot',
            payload: bootstrap.snapshot.payload,
          };
        }
        for (const event of bootstrap.replay) {
          if (event.sequence > afterSequence) {
            afterSequence = event.sequence;
            yield event;
          }
        }
        afterSequence = Math.max(afterSequence, bootstrap.high_water_mark);
      }
    } finally {
      unlisten();
    }
  }
}

export const tauriBackendTransport: BackendTransport = new TauriTransport();
