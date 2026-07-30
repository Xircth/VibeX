import type {
  BackendTransport,
  RemoteEvent,
  ServerCapabilities,
  SubscriptionRequest,
} from './backendTransport';
import type { SubscriptionBootstrap } from 'shared/types';

type ApplicationCommandResponse = {
  operation_id: string;
  data: unknown;
};

type WireRemoteEvent = Omit<RemoteEvent, 'sequence'> & {
  sequence: number;
};
type WireSubscriptionBootstrap = Omit<
  SubscriptionBootstrap,
  'snapshot' | 'replay' | 'high_water_mark'
> & {
  ready: boolean;
  snapshot?: { through_sequence: number; payload: RemoteEvent['payload'] };
  replay: WireRemoteEvent[];
  high_water_mark: number;
};

export class TauriTransport implements BackendTransport {
  readonly environment = 'desktop' as const;

  async call(
    command: string,
    args?: Record<string, unknown>
  ): Promise<unknown> {
    const { tauriInvoke } = await import('@/lib/tauriApi');
    if (command === 'conversation_list') {
      const response = await tauriInvoke<ApplicationCommandResponse>(
        'application_call',
        {
          command,
          operationId: globalThis.crypto.randomUUID(),
          args: args ?? {},
        }
      );
      return response.data;
    }
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

  async listen<T>(
    event: string,
    handler: (payload: T) => void
  ): Promise<() => void> {
    const { tauriListen } = await import('@/lib/tauriApi');
    return tauriListen(event, handler);
  }

  async emit(event: string, payload?: unknown): Promise<void> {
    const { tauriEmit } = await import('@/lib/tauriApi');
    await tauriEmit(event, payload);
  }

  async *subscribe(request: SubscriptionRequest): AsyncIterable<RemoteEvent> {
    let dirty = true;
    let wake: (() => void) | undefined;
    const unlisten = await this.listen('conversation-events', () => {
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
          request: {
            ...request,
            after_sequence: Number(afterSequence),
          },
        })) as WireSubscriptionBootstrap;
        if (!bootstrap.ready) {
          throw new Error('conversation subscription was not ready');
        }
        if (bootstrap.snapshot) {
          yield {
            sequence: BigInt(bootstrap.snapshot.through_sequence),
            kind: 'subscription_snapshot',
            payload: bootstrap.snapshot.payload,
          };
        }
        for (const event of bootstrap.replay) {
          const sequence = BigInt(event.sequence);
          if (sequence > afterSequence) {
            afterSequence = sequence;
            yield { ...event, sequence };
          }
        }
        const highWaterMark = BigInt(bootstrap.high_water_mark);
        if (highWaterMark > afterSequence) {
          afterSequence = highWaterMark;
        }
      }
    } finally {
      unlisten();
    }
  }
}

export const tauriBackendTransport: BackendTransport = new TauriTransport();
