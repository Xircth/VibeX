import { tauriInvoke } from '@/lib/tauriApi';
import type {
  AgentPermissionResponse,
  AgentType,
  ConversationEventsPage,
  ConversationBundlePayload,
  ConversationExportResult,
  ConversationImportResult,
  ConversationTimelinePage,
  ConversationTurnSnapshot,
  DbConversationDetail,
  DbConversationSummary,
} from 'shared/types';

export type ConversationStartTurnRequest = {
  agentType: AgentType;
  workspaceId: string;
  conversationId: string;
  text: string;
  images?: string[];
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

export type ConversationExportRequest = {
  conversationId: string;
  destinationPath?: string | null;
};

export type ConversationImportRequest = {
  workspaceId: string;
  bundle: ConversationBundlePayload;
};

export const conversationApi = {
  list: (workspaceId: string): Promise<DbConversationSummary[]> =>
    tauriInvoke('conversation_list', { workspaceId }),

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

  eventsSince: (
    request: ConversationEventsSinceRequest
  ): Promise<ConversationEventsPage> =>
    tauriInvoke('conversation_events_since', { request }),

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

  close: (request: ConversationCloseRequest): Promise<void> =>
    tauriInvoke('conversation_close', { request }),

  export: (request: ConversationExportRequest): Promise<ConversationExportResult> =>
    tauriInvoke('conversation_export', { request }),

  import: (request: ConversationImportRequest): Promise<ConversationImportResult> =>
    tauriInvoke('conversation_import', { request }),
};
