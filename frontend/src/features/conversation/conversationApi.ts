import { tauriInvoke } from '@/lib/tauriApi';
import type {
  AgentPermissionResponse,
  AgentSessionConfigOverride,
  AgentKind,
  ConversationRowPage,
  ConversationBundlePayload,
  ConversationExportResult,
  ConversationImportResult,
  ConversationSearchHit,
  ConversationTimelinePage,
  ConversationTurnSnapshot,
  DbConversationDetail,
  ExecutorProfileId,
} from 'shared/types';

export type ConversationStartTurnRequest = {
  agentType: AgentKind;
  workspaceId: string;
  conversationId: string;
  executorProfileId?: ExecutorProfileId | null;
  text: string;
  images?: string[];
  modeOverride?: string | null;
  configOverrides?: AgentSessionConfigOverride[];
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

export type ConversationCancelTurnRequest = {
  conversationId: string;
  reason?: string | null;
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

export const conversationApi = {
  // Conversation detail (metadata + projected timeline) from the durable event log.
  detail: (sessionId: string): Promise<DbConversationDetail | null> =>
    tauriInvoke('conversation_detail', { sessionId }),

  startTurn: (
    request: ConversationStartTurnRequest
  ): Promise<ConversationTurnSnapshot> =>
    tauriInvoke('conversation_start_turn', {
      request: {
        ...request,
        images: request.images ?? [],
      },
    }),

  // Gap backfill: the timeline rows that changed since `afterSequence` (消灭双投影) —
  // the frontend upserts them by `row_id`, not folds raw events.
  eventsSince: (
    request: ConversationEventsSinceRequest
  ): Promise<ConversationRowPage> =>
    tauriInvoke('conversation_events_since', {
      request: {
        ...request,
        afterSequence: serializeSequenceForIpc(request.afterSequence),
      },
    }),

  timelinePage: (
    request: ConversationTimelinePageRequest
  ): Promise<ConversationTimelinePage> =>
    tauriInvoke('conversation_timeline_page', { request }),

  respondPermission: (
    request: ConversationPermissionResponseRequest
  ): Promise<void> =>
    tauriInvoke('conversation_respond_permission', { request }),

  cancel: (request: ConversationCancelTurnRequest): Promise<void> =>
    tauriInvoke('conversation_cancel_turn', { request }),

  // Reset-to-here: truncate the conversation to before the user turn at `ordinal`.
  truncateToTurn: (
    request: ConversationTruncateToTurnRequest
  ): Promise<void> =>
    tauriInvoke('conversation_truncate_to_turn', { request }),

  close: (request: ConversationCloseRequest): Promise<void> =>
    tauriInvoke('conversation_close', { request }),

  export: (request: ConversationExportRequest): Promise<ConversationExportResult> =>
    tauriInvoke('conversation_export', { request }),

  exportMarkdown: (conversationId: string): Promise<string> =>
    tauriInvoke('conversation_export_markdown', { conversationId }),

  exportHtml: (conversationId: string): Promise<string> =>
    tauriInvoke('conversation_export_html', { conversationId }),

  search: (
    query: string,
    workspaceId?: string | null,
    limit?: number
  ): Promise<ConversationSearchHit[]> =>
    tauriInvoke('conversation_search', {
      query,
      workspaceId: workspaceId ?? null,
      limit: limit ?? null,
    }),

  import: (request: ConversationImportRequest): Promise<ConversationImportResult> =>
    tauriInvoke('conversation_import', { request }),

  fork: (conversationId: string): Promise<ConversationImportResult> =>
    tauriInvoke('conversation_fork', { conversationId }),
};
