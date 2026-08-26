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

const APPLICATION_COMMANDS = new Set([
  'conversation_list',
  'conversation_list_recent',
  'conversation_create',
  'conversation_child_create',
  'conversation_output',
  'conversation_start_turn',
  'conversation_steer',
  'conversation_input_submit',
  'conversation_input_list',
  'conversation_relation_list',
  'conversation_input_update',
  'conversation_input_reorder',
  'conversation_input_cancel',
  'conversation_respond_permission',
  'conversation_cancel_turn',
  'workflow_publish',
  'workflow_validate',
  'workflow_start',
  'workflow_debug',
  'workflow_show',
  'workflow_version',
  'workflow_list',
  'workflow_versions',
  'workflow_steps',
  'workflow_events',
  'workflow_complete_step',
  'workflow_decide',
  'workflow_cancel',
  'workflow_resume',
  'workflow_pause',
  'workflow_resume_run',
  'workflow_accept_candidate',
  'workflow_pause_step',
  'workflow_step_input',
  'workflow_fork',
]);

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
    throw new Error('Backend returned a non-JSON-safe conversation sequence');
  }
  return BigInt(sequence);
}

export class TauriTransport implements BackendTransport {
  readonly environment = 'desktop' as const;

  async call(
    command: string,
    args?: Record<string, unknown>,
    options?: { operationId?: string }
  ): Promise<unknown> {
    const { tauriInvoke } = await import('@/lib/tauriApi');
    if (APPLICATION_COMMANDS.has(command)) {
      const response = await tauriInvoke<ApplicationCommandResponse>(
        'application_call',
        {
          command,
          operationId: options?.operationId ?? globalThis.crypto.randomUUID(),
          args: args ?? {},
        }
      );
      return response.data;
    }
    return tauriInvoke(command, args);
  }

  async stream<T>(
    command: string,
    args: Record<string, unknown>,
    onMessage: (message: unknown) => void
  ): Promise<T> {
    const [{ Channel }, { tauriInvoke }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@/lib/tauriApi'),
    ]);
    const channel = new Channel<unknown>();
    channel.onmessage = onMessage;
    return tauriInvoke<T>(command, { ...args, onEvent: channel });
  }

  async capabilities(): Promise<ServerCapabilities> {
    return {
      server_version: 'desktop',
      protocol_version: '1.0',
      minimum_client_version: '0.1.0',
      capabilities: [
        'conversation.read',
        'conversation.write',
        'conversation.attach',
        'conversation.permission',
        'conversation.question',
        'conversation.cancel',
        'conversation.steer',
        'plugin.read',
        'plugin.write',
        'plugin.surface',
        'artifact.read',
        'artifact.preview',
        'automation.read',
        'automation.write',
        'delegation.read',
        'workflow.read',
        'workflow.write',
        'workflow.run',
        'workflow.approve',
        'application.call',
        'file.read',
        'file.write',
        'git.read',
        'git.write',
        'terminal',
        'workspace.read',
        'workspace.write',
        'project.write',
        'session.write',
        'agent.read',
        'agent.write',
        'device.pair',
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
    const isWorkflowRun = request.resource === 'workflow_run';
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
          if (isWorkflowRun) {
            await Promise.race([
              new Promise<void>((resolve) => {
                wake = resolve;
              }),
              new Promise<void>((resolve) =>
                globalThis.setTimeout(resolve, 100)
              ),
            ]);
          } else {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        }
        dirty = false;
        const bootstrap = (await this.call('conversation_attach', {
          request: {
            ...request,
            after_sequence: sequenceToWire(afterSequence),
          },
        })) as WireSubscriptionBootstrap;
        if (!bootstrap.ready) {
          throw new Error('durable subscription was not ready');
        }
        if (bootstrap.snapshot) {
          yield {
            sequence: sequenceFromWire(bootstrap.snapshot.through_sequence),
            kind: 'subscription_snapshot',
            payload: bootstrap.snapshot.payload,
          };
        }
        for (const event of bootstrap.replay) {
          const sequence = sequenceFromWire(event.sequence);
          if (sequence > afterSequence) {
            afterSequence = sequence;
            yield { ...event, sequence };
          }
        }
        const highWaterMark = sequenceFromWire(bootstrap.high_water_mark);
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
