export type BackendEnvironment = 'desktop' | 'web' | 'remote-desktop';
import type {
  AgentId,
  AgentPermissionResponse,
  AgentElicitationResponse,
  AgentSessionConfigOverride,
  CapabilityId,
  DbConversationSummary,
  ExecutorProfileId,
  RemoteEvent,
  ServerCapabilities,
  SubscriptionRequest,
  ConversationTurnSnapshot,
  ConversationInputPayload,
  ConversationInputSubmission,
  ConversationInputView,
  ConversationRelationView,
  ConversationOutputView,
  ConversationSteeringReceipt,
  WorkflowDefinition,
  WorkflowPolicy,
  WorkflowVersionView,
  WorkflowRunView,
  WorkflowStepView,
  WorkflowEventRecord,
  WorkflowReviewDecision,
  WorkflowValidationView,
} from 'shared/types';

export type {
  CapabilityId,
  RemoteEvent,
  ServerCapabilities,
  SubscriptionRequest,
};

export type CreateDevicePairingRequest = {
  preset?: 'workstation' | 'companion';
  requested_scopes?: string[];
};

export type DevicePairingChallenge = {
  pairing_id: string;
  pairing_token: string;
  expires_at: string;
  requested_scopes: string[];
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
  conversation_output: {
    args: { conversationId: string };
    result: ConversationOutputView;
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
        pluginActions?: Array<{ pluginId: string; actionId: string }>;
      };
    };
    result: ConversationTurnSnapshot;
  };
  conversation_steer: {
    args: {
      request: {
        conversationId: string;
        expectedTurnId: string;
        text: string;
        images?: string[];
      };
    };
    result: ConversationSteeringReceipt;
  };
  conversation_input_submit: {
    args: {
      request: { conversationId: string; payload: ConversationInputPayload };
    };
    result: ConversationInputSubmission;
  };
  conversation_input_list: {
    args: { request: { conversationId: string } };
    result: ConversationInputView[];
  };
  conversation_relation_list: {
    args: { request: { conversationId: string } };
    result: ConversationRelationView[];
  };
  conversation_input_update: {
    args: {
      request: {
        conversationId: string;
        inputId: string;
        expectedRevision: number;
        payload: ConversationInputPayload;
      };
    };
    result: ConversationInputView;
  };
  conversation_input_reorder: {
    args: {
      request: {
        conversationId: string;
        inputId: string;
        expectedRevision: number;
        sortKey: number;
      };
    };
    result: ConversationInputView;
  };
  conversation_input_cancel: {
    args: {
      request: {
        conversationId: string;
        inputId: string;
        expectedRevision: number;
      };
    };
    result: ConversationInputView;
  };
  workflow_publish: {
    args: {
      request: {
        definitionId?: string | null;
        definition: WorkflowDefinition;
      };
    };
    result: WorkflowVersionView;
  };
  workflow_validate: {
    args: { request: { definition: WorkflowDefinition } };
    result: WorkflowValidationView;
  };
  workflow_start: {
    args: {
      request: {
        definitionVersionId: string;
        workspaceId: string;
        input: unknown;
        policyOverride?: WorkflowPolicy | null;
      };
    };
    result: WorkflowRunView;
  };
  workflow_show: {
    args: { runId: string };
    result: WorkflowRunView;
  };
  workflow_version: {
    args: { versionId: string };
    result: WorkflowVersionView;
  };
  workflow_steps: {
    args: { runId: string };
    result: WorkflowStepView[];
  };
  workflow_events: {
    args: { runId: string; afterSequence?: number; limit?: number };
    result: WorkflowEventRecord[];
  };
  workflow_complete_step: {
    args: {
      request: { runId: string; stepId: string; output?: unknown | null };
    };
    result: WorkflowRunView;
  };
  workflow_decide: {
    args: {
      request: { runId: string; stepId: string; decision: unknown };
    };
    result: WorkflowRunView;
  };
  workflow_cancel: {
    args: { request: { runId: string; reason?: string | null } };
    result: WorkflowRunView;
  };
  workflow_resume: {
    args: { request: { runId: string; decision: WorkflowReviewDecision } };
    result: WorkflowRunView;
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
  conversation_respond_question: {
    args: {
      request: {
        conversationId: string;
        questionId: string;
        response: AgentElicitationResponse;
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
  call(
    command: string,
    args?: Record<string, unknown>,
    options?: { operationId?: string }
  ): Promise<unknown>;
  stream?<T>(
    command: string,
    args: Record<string, unknown>,
    onMessage: (message: unknown) => void
  ): Promise<T>;
  subscribe?(request: SubscriptionRequest): AsyncIterable<RemoteEvent>;
  capabilities?(): Promise<ServerCapabilities>;
  createDevicePairing?(
    request: CreateDevicePairingRequest
  ): Promise<DevicePairingChallenge>;
  listen?<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
  emit?(event: string, payload?: unknown): Promise<void>;
  artifactPreviewUrl?(lease: {
    leaseId: string;
    capabilityToken: string;
    loopbackPort: number;
  }): string;
}

export function callApplicationCommand<C extends ApplicationCommandName>(
  transport: BackendTransport,
  command: C,
  args: ApplicationCommandArgs<C>,
  options?: { operationId?: string }
): Promise<ApplicationCommandResult<C>> {
  return (
    options
      ? transport.call(command, args, options)
      : transport.call(command, args)
  ) as Promise<ApplicationCommandResult<C>>;
}
