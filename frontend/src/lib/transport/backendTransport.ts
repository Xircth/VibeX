export type BackendEnvironment = 'desktop' | 'web' | 'remote-desktop';
import type {
  CapabilityId,
  DbConversationSummary,
  RemoteEvent,
  ServerCapabilities,
  SubscriptionRequest,
} from 'shared/types';

export type {
  CapabilityId,
  RemoteEvent,
  ServerCapabilities,
  SubscriptionRequest,
};

export interface ApplicationCommandMap {
  conversation_list: {
    args: { workspaceId: string };
    result: DbConversationSummary[];
  };
}

export type ApplicationCommandName = keyof ApplicationCommandMap;
export type ApplicationCommandArgs<C extends ApplicationCommandName> =
  ApplicationCommandMap[C]['args'];
export type ApplicationCommandResult<C extends ApplicationCommandName> =
  ApplicationCommandMap[C]['result'];

export interface BackendTransport {
  readonly environment: BackendEnvironment;
  call(command: string, args?: Record<string, unknown>): Promise<unknown>;
  subscribe?(request: SubscriptionRequest): AsyncIterable<RemoteEvent>;
  capabilities?(): Promise<ServerCapabilities>;
  listen?<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
  emit?(event: string, payload?: unknown): Promise<void>;
}

export function callApplicationCommand<C extends ApplicationCommandName>(
  transport: BackendTransport,
  command: C,
  args: ApplicationCommandArgs<C>
): Promise<ApplicationCommandResult<C>> {
  return transport.call(command, args) as Promise<ApplicationCommandResult<C>>;
}
