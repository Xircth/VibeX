import {
  callApplicationCommand,
  configuredBackendTransport,
  type BackendTransport,
} from '@/lib/backendTransport';
import type {
  AgentElicitationResponse,
  AgentPermissionResponse,
  AgentSessionConfigOverride,
  AgentSessionControlsSnapshot,
  AgentId,
  ConversationRowPage,
  ConversationBundlePayload,
  ConversationExportResult,
  ConversationFileChangeSummary,
  ConversationForkResult,
  ConversationImportResult,
  ConversationSearchHit,
  ConversationTimelinePage,
  ConversationTurnSnapshot,
  ConversationInputPayload,
  ConversationInputSubmission,
  ConversationInputView,
  ConversationOutputView,
  ConversationSteeringReceipt,
  ConversationWorkflowRef,
  DbConversationDetail,
  DbConversationSummary,
  ExecutorProfileId,
} from 'shared/types';

export type { ConversationWorkflowRef };

export type ConversationStartTurnRequest = {
  agentId: AgentId;
  workspaceId: string;
  conversationId: string;
  executorProfileId?: ExecutorProfileId | null;
  text: string;
  displayText?: string;
  images?: string[];
  modeOverride?: string | null;
  configOverrides?: AgentSessionConfigOverride[];
  workflowRefs?: ConversationWorkflowRef[];
};

export type ConversationLiveFeedbackNote = {
  id: string;
  text: string;
  createdAt: string;
  status: string;
  deliveredAt?: string | null;
};

export type ConversationCreateRequest = {
  workspaceId: string;
  agentId: AgentId;
  title?: string | null;
  initialPrompt?: string | null;
};

export type ConversationEventsSinceRequest = {
  conversationId: string;
  afterSequence: bigint | number;
  limit?: number;
};

export type ConversationTimelinePageRequest = {
  conversationId: string;
  cursor?: string | null;
  limit?: number;
};

export type ConversationPermissionResponseRequest = {
  conversationId: string;
  permissionId: string;
  response: AgentPermissionResponse;
};

export type ConversationQuestionResponseRequest = {
  conversationId: string;
  questionId: string;
  response: AgentElicitationResponse;
};

export type ConversationCancelTurnRequest = {
  conversationId: string;
  reason?: string | null;
};

export type ConversationSetSessionModeRequest = {
  conversationId: string;
  modeId: string;
};

export type ConversationSetSessionConfigOptionRequest = {
  conversationId: string;
  key: string;
  value: unknown;
};

export type ConversationCloseRequest = {
  conversationId: string;
  reason?: string | null;
};

export type ConversationTruncateToTurnRequest = {
  conversationId: string;
  /** User-turn ordinal to reset to; this turn and everything after it is removed. */
  ordinal: number;
};

export type ConversationCheckpointPreviewRequest = {
  conversationId: string;
  ordinal: number;
};

export type ConversationExportRequest = {
  conversationId: string;
  destinationPath?: string | null;
};

export type ConversationImportRequest = {
  workspaceId: string;
  bundle: ConversationBundlePayload;
};

const serializeSequenceForIpc = (sequence: bigint | number): number => {
  if (typeof sequence === 'number') {
    if (!Number.isSafeInteger(sequence)) {
      throw new Error('Conversation sequence must be a JSON-safe integer');
    }
    return sequence;
  }

  if (
    sequence < BigInt(Number.MIN_SAFE_INTEGER) ||
    sequence > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('Conversation sequence exceeds JSON-safe integer range');
  }

  return Number(sequence);
};

export function createConversationApi(transport: BackendTransport) {
  const call = <T>(
    command: string,
    args?: Record<string, unknown>
  ): Promise<T> => transport.call(command, args) as Promise<T>;

  return {
    list: (workspaceId: string): Promise<DbConversationSummary[]> =>
      callApplicationCommand(transport, 'conversation_list', { workspaceId }),
    listRecent: (args?: {
      sinceDays?: number | null;
      limit?: number | null;
      projectId?: string | null;
    }): Promise<DbConversationSummary[]> =>
      callApplicationCommand(transport, 'conversation_list_recent', {
        sinceDays: args?.sinceDays,
        limit: args?.limit,
        projectId: args?.projectId,
      }),
    create: (
      request: ConversationCreateRequest
    ): Promise<DbConversationSummary> =>
      callApplicationCommand(transport, 'conversation_create', request),
    output: (conversationId: string): Promise<ConversationOutputView> =>
      callApplicationCommand(transport, 'conversation_output', {
        conversationId,
      }),
    // Conversation detail (metadata + projected timeline) from the durable event log.
    detail: (conversationId: string): Promise<DbConversationDetail | null> =>
      call('conversation_detail', { conversationId }),

    // Materialize or reconnect an Agent session and return its authoritative ACP
    // controls. This never sends a prompt.
    ensureSessionControls: (
      conversationId: string
    ): Promise<AgentSessionControlsSnapshot> =>
      call('conversation_ensure_session_controls', { conversationId }),

    rebindSession: (
      conversationId: string
    ): Promise<AgentSessionControlsSnapshot> =>
      call('conversation_rebind_session', { conversationId }),

    startTurn: (
      request: ConversationStartTurnRequest
    ): Promise<ConversationTurnSnapshot> =>
      call('conversation_start_turn', {
        request: {
          ...request,
          images: request.images ?? [],
        },
      }),

    submitInput: (
      conversationId: string,
      payload: ConversationInputPayload,
      operationId?: string
    ): Promise<ConversationInputSubmission> =>
      operationId
        ? callApplicationCommand(
            transport,
            'conversation_input_submit',
            { request: { conversationId, payload } },
            { operationId }
          )
        : callApplicationCommand(transport, 'conversation_input_submit', {
            request: { conversationId, payload },
          }),

    steer: (
      request: {
        conversationId: string;
        expectedTurnId: string;
        text: string;
        images?: string[];
      },
      operationId?: string
    ): Promise<ConversationSteeringReceipt> =>
      operationId
        ? callApplicationCommand(
            transport,
            'conversation_steer',
            { request },
            { operationId }
          )
        : callApplicationCommand(transport, 'conversation_steer', { request }),

    listInputs: (conversationId: string): Promise<ConversationInputView[]> =>
      callApplicationCommand(transport, 'conversation_input_list', {
        request: { conversationId },
      }),

    listRelations: (conversationId: string) =>
      callApplicationCommand(transport, 'conversation_relation_list', {
        request: { conversationId },
      }),

    updateInput: (request: {
      conversationId: string;
      inputId: string;
      expectedRevision: number;
      payload: ConversationInputPayload;
    }): Promise<ConversationInputView> =>
      callApplicationCommand(transport, 'conversation_input_update', {
        request,
      }),

    reorderInput: (request: {
      conversationId: string;
      inputId: string;
      expectedRevision: number;
      sortKey: number;
    }): Promise<ConversationInputView> =>
      callApplicationCommand(transport, 'conversation_input_reorder', {
        request,
      }),

    cancelInput: (request: {
      conversationId: string;
      inputId: string;
      expectedRevision: number;
    }): Promise<ConversationInputView> =>
      callApplicationCommand(transport, 'conversation_input_cancel', {
        request,
      }),

    // Gap backfill: the timeline rows that changed since `afterSequence` (消灭双投影) —
    // the frontend upserts them by `row_id`, not folds raw events.
    eventsSince: (
      request: ConversationEventsSinceRequest
    ): Promise<ConversationRowPage> =>
      call('conversation_events_since', {
        request: {
          ...request,
          afterSequence: serializeSequenceForIpc(request.afterSequence),
        },
      }),

    timelinePage: (
      request: ConversationTimelinePageRequest
    ): Promise<ConversationTimelinePage> =>
      call('conversation_timeline_page', { request }),

    respondPermission: (
      request: ConversationPermissionResponseRequest
    ): Promise<void> => call('conversation_respond_permission', { request }),

    respondQuestion: (
      request: ConversationQuestionResponseRequest
    ): Promise<void> => call('conversation_respond_question', { request }),

    submitFeedback: (request: {
      conversationId: string;
      text: string;
    }): Promise<ConversationLiveFeedbackNote> =>
      callApplicationCommand(transport, 'conversation_submit_feedback', {
        request,
      }),

    listFeedback: (
      conversationId: string
    ): Promise<ConversationLiveFeedbackNote[]> =>
      callApplicationCommand(transport, 'conversation_list_feedback', {
        request: { conversationId },
      }),

    cancel: (request: ConversationCancelTurnRequest): Promise<void> =>
      call('conversation_cancel_turn', { request }),

    // Immediate ACP `session/set_mode`; fails while a turn is in flight or before
    // the session exists — callers then keep the choice as a next-turn override.
    setSessionMode: (
      request: ConversationSetSessionModeRequest
    ): Promise<void> => call('conversation_set_session_mode', { request }),

    // Immediate ACP `session/set_config_option` (model / permission mode / …).
    setSessionConfigOption: (
      request: ConversationSetSessionConfigOptionRequest
    ): Promise<void> =>
      call('conversation_set_session_config_option', { request }),

    // Reset-to-here: truncate the conversation to before the user turn at `ordinal`.
    truncateToTurn: (
      request: ConversationTruncateToTurnRequest
    ): Promise<void> => call('conversation_truncate_to_turn', { request }),

    previewCheckpointFileChanges: (
      request: ConversationCheckpointPreviewRequest
    ): Promise<ConversationFileChangeSummary> =>
      call('conversation_checkpoint_file_changes_preview', { request }),

    close: (request: ConversationCloseRequest): Promise<void> =>
      call('conversation_close', { request }),

    export: (
      request: ConversationExportRequest
    ): Promise<ConversationExportResult> =>
      call('conversation_export', { request }),

    exportMarkdown: (conversationId: string): Promise<string> =>
      call('conversation_export_markdown', { conversationId }),

    exportHtml: (conversationId: string): Promise<string> =>
      call('conversation_export_html', { conversationId }),

    search: (
      query: string,
      workspaceId?: string | null,
      limit?: number
    ): Promise<ConversationSearchHit[]> =>
      call('conversation_search', {
        query,
        workspaceId: workspaceId ?? null,
        limit: limit ?? null,
      }),

    import: (
      request: ConversationImportRequest
    ): Promise<ConversationImportResult> =>
      call('conversation_import', { request }),

    fork: (conversationId: string): Promise<ConversationForkResult> =>
      call('conversation_fork', { conversationId }),
  };
}

export const conversationApi = createConversationApi(
  configuredBackendTransport
);
