import type {
  BackendTransport,
  RemoteEvent,
  ServerCapabilities,
  SubscriptionRequest,
} from './backendTransport';
import type { SubscriptionBootstrap } from 'shared/types';
import {
  HOST_CAPABILITY_SCOPES,
  HOST_COMMANDS,
} from 'shared/hostCommands';

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

const APPLICATION_COMMANDS = new Set<string>(HOST_COMMANDS);

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
      capabilities: [...HOST_CAPABILITY_SCOPES, 'desktop.tauri'],
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
    if (request.resource === 'patch_stream') {
      yield* this.subscribePatchStream(request);
      return;
    }
    if (request.resource === 'host_event') {
      yield* this.subscribeHostEvent(request);
      return;
    }
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

  private async *subscribePatchStream(
    request: SubscriptionRequest
  ): AsyncIterable<RemoteEvent> {
    if (request.resource !== 'patch_stream') {
      return;
    }
    const command = PATCH_STREAM_COMMAND[request.stream];
    if (!command) {
      throw new Error(`unknown patch stream \`${request.stream}\``);
    }
    const channel = patchStreamChannel(request.stream, request.args);
    yield* this.subscribeChannel(channel, async () => {
      await this.call(command, objectArgs(request.args));
    });
  }

  private async *subscribeHostEvent(
    request: SubscriptionRequest
  ): AsyncIterable<RemoteEvent> {
    if (request.resource !== 'host_event') {
      return;
    }
    yield* this.subscribeChannel(request.channel, async () => undefined);
  }

  private async *subscribeChannel(
    channel: string,
    start: () => Promise<void>
  ): AsyncIterable<RemoteEvent> {
    const queue: RemoteEvent[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let sequence = 0n;
    const unlisten = await this.listen(channel, (payload) => {
      sequence += 1n;
      queue.push({
        sequence,
        kind: channel,
        payload: payload as RemoteEvent['payload'],
      });
      wake?.();
      wake = undefined;
    });
    try {
      await start();
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
      unlisten();
    }
  }
}

const PATCH_STREAM_COMMAND: Record<string, string> = {
  projects: 'subscribe_projects_stream',
  project_workspaces: 'subscribe_project_workspaces_stream',
  execution_processes: 'subscribe_execution_processes_stream',
  diff: 'subscribe_diff_stream',
  file_tree: 'subscribe_file_tree_stream',
  scratch: 'subscribe_scratch_stream',
  slash_commands: 'subscribe_slash_commands_stream',
  log: 'subscribe_log_stream',
  conversation: 'subscribe_conversation_stream',
};

function objectArgs(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function field(
  args: Record<string, unknown>,
  camel: string,
  snake: string
): string | undefined {
  const raw = args[camel] ?? args[snake];
  if (typeof raw === 'string' && raw.length > 0) {
    return raw;
  }
  if (typeof raw === 'number') {
    return String(raw);
  }
  return undefined;
}

function patchStreamChannel(stream: string, rawArgs: unknown): string {
  const args = objectArgs(rawArgs);
  switch (stream) {
    case 'projects':
      return 'projects-stream';
    case 'file_tree':
      return 'file-tree-stream';
    case 'project_workspaces': {
      const id = field(args, 'projectId', 'project_id');
      if (!id) throw new Error('projectId is required');
      return `project-workspaces-stream:${id}`;
    }
    case 'execution_processes': {
      const id = field(args, 'sessionId', 'session_id');
      if (!id) throw new Error('sessionId is required');
      return `execution-processes-stream:${id}`;
    }
    case 'diff': {
      const id = field(args, 'workspaceId', 'workspace_id');
      if (!id) throw new Error('workspaceId is required');
      return `diff-stream:${id}`;
    }
    case 'scratch': {
      const id = field(args, 'scratchId', 'scratch_id');
      if (!id) throw new Error('scratchId is required');
      return `scratch-stream:${id}`;
    }
    case 'log': {
      const id = field(args, 'processId', 'process_id');
      if (!id) throw new Error('processId is required');
      return `log-stream:${id}`;
    }
    case 'conversation': {
      const process = field(args, 'executionProcessId', 'execution_process_id');
      if (!process) throw new Error('executionProcessId is required');
      const streamId = field(args, 'streamId', 'stream_id');
      return streamId
        ? `conversation-stream:${process}:${streamId}`
        : `conversation-stream:${process}`;
    }
    case 'slash_commands': {
      const profile = (args.executorProfileId ?? args.executor_profile_id) as
        | { executor?: string; variant?: string }
        | undefined;
      const executor = profile?.executor ?? 'none';
      const variant = profile?.variant ?? 'default';
      const workspace = field(args, 'workspaceId', 'workspace_id') ?? 'none';
      const repo = field(args, 'repoId', 'repo_id') ?? 'none';
      return `slash-commands-stream:${executor}:${variant}:${workspace}:${repo}`;
    }
    default:
      throw new Error(`unknown patch stream \`${stream}\``);
  }
}

export const tauriBackendTransport: BackendTransport = new TauriTransport();
