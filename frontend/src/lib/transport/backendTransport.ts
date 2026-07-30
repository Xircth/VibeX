export type BackendEnvironment = 'desktop' | 'web' | 'remote-desktop';
import type {
  AgentId,
  AgentPermissionResponse,
  AgentSessionConfigOverride,
  CapabilityId,
  DbConversationSummary,
  ExecutorProfileId,
  RemoteEvent,
  ServerCapabilities,
  SubscriptionRequest,
  ConversationTurnSnapshot,
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
  conversation_create: {
    args: {
      workspaceId: string;
      agentId: AgentId;
      title?: string | null;
      initialPrompt?: string | null;
    };
    result: DbConversationSummary;
  };
  conversation_start_turn: {
    args: {
      request: {
        agentId: AgentId;
        workspaceId: string;
        conversationId: string;
        executorProfileId?: ExecutorProfileId | null;
        text: string;
        images: string[];
        modeOverride?: string | null;
        configOverrides?: AgentSessionConfigOverride[];
      };
    };
    result: ConversationTurnSnapshot;
  };
  conversation_respond_permission: {
    args: {
      request: {
        conversationId: string;
        permissionId: string;
        response: AgentPermissionResponse;
      };
    };
    result: void;
  };
  conversation_cancel_turn: {
    args: {
      request: { conversationId: string; reason?: string | null };
    };
    result: void;
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
