import {
  type InternalPromptContributionBlock,
  promptContextRegistry,
  resolveBeforeTurnPromptContributions,
  serviceContainer,
} from '@vibex/plugin-sdk';
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
  ConversationRowOp,
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
  GoalControlReceipt,
  TimelineRow,
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
  internalPromptContributions?: InternalPromptContributionBlock[];
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

export type ConversationRowsSinceResult = {
  conversationId: string;
  afterSequence: bigint;
  lastSequence: bigint;
  reset: boolean;
  ops: ConversationRowOp[];
};

export type ConversationTimelinePageRequest = {
  conversationId: string;
  cursor?: string | null;
  beforeSortIndex?: number | null;
  start?: number | null;
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

export type RollbackSafetyReport =
  | { status: 'safe'; engineSupportsRevert: boolean }
  | { status: 'degraded'; reason: string }
  | { status: 'unsafe'; reason: string };

export type ConversationRateLimitAutoResumeRequest = {
  conversationId: string;
  autoResume: boolean;
  continuationPrompt?: string;
};

export type ConversationRateLimitCancelWaitRequest = {
  conversationId: string;
};

export type ConversationEngineHandoffRequest = {
  conversationId: string;
  targetEngine: string;
  tokenBudget?: number;
};

export type ConversationEngineHandoffPackedItem = {
  id: string;
  role: string;
  content: string;
  sortIndex?: number;
  createdAt?: string;
};

export type ConversationEngineHandoffPreview = {
  sourceEngine: string;
  targetEngine: string;
  packedMessages: ConversationEngineHandoffPackedItem[];
  omittedIds: string[];
  totalTokens: number;
  tokenBudget: number;
  handoffPromptText?: string;
};

export type ConversationMatchSource = 'title' | 'body' | 'both';

export type ConversationGlobalSearchHit = {
  conversation_id: string;
  workspace_id: string;
  title: string | null;
  snippet: string;
  matchSource?: ConversationMatchSource;
  rank?: number;
  matchedRowId?: string | null;
  matchedTurnOrdinal?: number | null;
};

export function normalizeConversationGlobalSearchHit(
  raw: unknown
): ConversationGlobalSearchHit {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const rawSource = String(
    rec.matchSource ?? rec.match_source ?? ''
  ).toLowerCase();
  const matchSource: ConversationMatchSource | undefined =
    rawSource === 'title'
      ? 'title'
      : rawSource === 'body'
        ? 'body'
        : rawSource === 'both'
          ? 'both'
          : undefined;
  const rawOrdinal = rec.matchedTurnOrdinal ?? rec.matched_turn_ordinal;
  const parsedOrdinal =
    typeof rawOrdinal === 'number' && Number.isFinite(rawOrdinal)
      ? rawOrdinal
      : null;

  return {
    conversation_id: String(rec.conversation_id ?? rec.conversationId ?? ''),
    workspace_id: String(rec.workspace_id ?? rec.workspaceId ?? ''),
    title: typeof rec.title === 'string' ? rec.title : null,
    snippet: typeof rec.snippet === 'string' ? rec.snippet : '',
    matchSource,
    rank:
      typeof rec.rank === 'number' && Number.isFinite(rec.rank)
        ? rec.rank
        : undefined,
    matchedRowId:
      typeof rec.matchedRowId === 'string'
        ? rec.matchedRowId
        : typeof rec.matched_row_id === 'string'
          ? rec.matched_row_id
          : null,
    matchedTurnOrdinal: parsedOrdinal,
  };
}

export function normalizeRollbackSafetyReport(
  raw: unknown
): RollbackSafetyReport {
  if (!raw || typeof raw !== 'object') {
    return { status: 'safe', engineSupportsRevert: true };
  }
  const record = raw as Record<string, unknown>;
  const tag = String(record.status ?? record.kind ?? '').toLowerCase();
  if (tag === 'unsafe') {
    return {
      status: 'unsafe',
      reason: typeof record.reason === 'string' ? record.reason : '',
    };
  }
  if (tag === 'degraded') {
    return {
      status: 'degraded',
      reason: typeof record.reason === 'string' ? record.reason : '',
    };
  }
  if (tag === 'safe') {
    const supports =
      typeof record.engineSupportsRevert === 'boolean'
        ? record.engineSupportsRevert
        : typeof record.engine_supports_revert === 'boolean'
          ? record.engine_supports_revert
          : true;
    return { status: 'safe', engineSupportsRevert: supports };
  }
  if ('Unsafe' in record && record.Unsafe && typeof record.Unsafe === 'object') {
    const inner = record.Unsafe as Record<string, unknown>;
    return {
      status: 'unsafe',
      reason: typeof inner.reason === 'string' ? inner.reason : '',
    };
  }
  if (
    'Degraded' in record &&
    record.Degraded &&
    typeof record.Degraded === 'object'
  ) {
    const inner = record.Degraded as Record<string, unknown>;
    return {
      status: 'degraded',
      reason: typeof inner.reason === 'string' ? inner.reason : '',
    };
  }
  if ('Safe' in record && record.Safe && typeof record.Safe === 'object') {
    const inner = record.Safe as Record<string, unknown>;
    const supports =
      typeof inner.engineSupportsRevert === 'boolean'
        ? inner.engineSupportsRevert
        : typeof inner.engine_supports_revert === 'boolean'
          ? inner.engine_supports_revert
          : true;
    return { status: 'safe', engineSupportsRevert: supports };
  }
  return { status: 'safe', engineSupportsRevert: true };
}

export function isUnimplementedConversationCommandError(
  error: unknown
): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error && typeof error === 'object' && 'message' in error
          ? String((error as { message?: unknown }).message ?? '')
          : '';
  return /404|not\s*found|unknown\s+command|unimplemented|not\s+implemented/i.test(
    message
  );
}

function parseBigIntSequence(value: unknown, fallback = 0n): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      return BigInt(value.trim());
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function normalizeConversationRowsSinceResult(
  raw: unknown,
  fallbackConversationId: string,
  fallbackAfterSequence: bigint | number
): ConversationRowsSinceResult {
  const afterSeq = parseBigIntSequence(fallbackAfterSequence, 0n);
  if (!raw || typeof raw !== 'object') {
    return {
      conversationId: fallbackConversationId,
      afterSequence: afterSeq,
      lastSequence: afterSeq,
      reset: false,
      ops: [],
    };
  }
  const rec = raw as Record<string, unknown>;
  const conversationId = String(
    rec.conversation_id ?? rec.conversationId ?? fallbackConversationId
  );
  const afterSequence = parseBigIntSequence(
    rec.after_sequence ?? rec.afterSequence,
    afterSeq
  );
  const lastSequence = parseBigIntSequence(
    rec.last_sequence ?? rec.lastSequence,
    afterSequence
  );
  const reset = rec.reset === true;
  const ops: ConversationRowOp[] = [];

  if (Array.isArray(rec.ops)) {
    for (const candidate of rec.ops) {
      if (!candidate || typeof candidate !== 'object') continue;
      const opRec = candidate as Record<string, unknown>;
      if (opRec.op === 'upsert' && opRec.row && typeof opRec.row === 'object') {
        ops.push({ op: 'upsert', row: opRec.row as TimelineRow });
      } else if (opRec.op === 'delete' && typeof opRec.row_id === 'string') {
        ops.push({
          op: 'delete',
          row_id: opRec.row_id,
          revision: parseBigIntSequence(opRec.revision, lastSequence),
        });
      }
    }
  }

  if (Array.isArray(rec.rows)) {
    for (const candidate of rec.rows) {
      if (!candidate || typeof candidate !== 'object') continue;
      const rowRec = candidate as Record<string, unknown>;
      const rowId =
        typeof rowRec.row_id === 'string'
          ? rowRec.row_id
          : typeof rowRec.rowId === 'string'
            ? rowRec.rowId
            : null;
      if (!rowId) continue;
      if (
        rowRec.deleted === true ||
        rowRec.is_deleted === true ||
        rowRec.tombstone === true
      ) {
        ops.push({
          op: 'delete',
          row_id: rowId,
          revision: parseBigIntSequence(rowRec.revision, lastSequence),
        });
      } else if (rowRec.row && typeof rowRec.row === 'object') {
        ops.push({ op: 'upsert', row: candidate as TimelineRow });
      }
    }
  }

  const tombstoneArrays = [rec.tombstones, rec.deleted_rows, rec.deletedRows];
  for (const list of tombstoneArrays) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === 'string') {
        ops.push({ op: 'delete', row_id: entry, revision: lastSequence });
      } else if (entry && typeof entry === 'object') {
        const entryRec = entry as Record<string, unknown>;
        const rowId =
          typeof entryRec.row_id === 'string'
            ? entryRec.row_id
            : typeof entryRec.rowId === 'string'
              ? entryRec.rowId
              : null;
        if (rowId) {
          ops.push({
            op: 'delete',
            row_id: rowId,
            revision: parseBigIntSequence(entryRec.revision, lastSequence),
          });
        }
      }
    }
  }

  const deletedRowIds = rec.deleted_row_ids ?? rec.deletedRowIds;
  if (Array.isArray(deletedRowIds)) {
    for (const rowId of deletedRowIds) {
      if (typeof rowId === 'string' && rowId.length > 0) {
        ops.push({ op: 'delete', row_id: rowId, revision: lastSequence });
      }
    }
  }

  return {
    conversationId,
    afterSequence,
    lastSequence,
    reset,
    ops,
  };
}

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

const conversationDetailInflight = new Map<
  string,
  Promise<DbConversationDetail | null>
>();

const PREFETCH_DETAIL_TTL_MS = 4000;
const conversationDetailPrefetchCache = new Map<
  string,
  { promise: Promise<DbConversationDetail | null>; expiresAt: number }
>();

export type ConversationDetailWindow = {
  tailTurns?: number;
  fromIndex?: number;
};

function detailInflightKey(
  conversationId: string,
  window?: ConversationDetailWindow
): string {
  if (window?.fromIndex != null) {
    return `${conversationId}:from:${window.fromIndex}`;
  }
  if (window?.tailTurns != null) {
    return `${conversationId}:tail:${window.tailTurns}`;
  }
  return conversationId;
}

function fetchConversationDetail(
  call: <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
  conversationId: string,
  window?: ConversationDetailWindow,
  isPrefetch = false
): Promise<DbConversationDetail | null> {
  const key = detailInflightKey(conversationId, window);
  if (!isPrefetch) {
    const prefetched = conversationDetailPrefetchCache.get(key);
    if (prefetched) {
      conversationDetailPrefetchCache.delete(key);
      if (prefetched.expiresAt > Date.now()) {
        return prefetched.promise;
      }
    }
  }
  const existing = conversationDetailInflight.get(key);
  if (existing) {
    if (isPrefetch) {
      conversationDetailPrefetchCache.set(key, {
        promise: existing,
        expiresAt: Date.now() + PREFETCH_DETAIL_TTL_MS,
      });
    }
    return existing;
  }
  const args: Record<string, unknown> = { conversationId };
  if (window?.fromIndex != null) args.fromIndex = window.fromIndex;
  if (window?.tailTurns != null) args.tailTurns = window.tailTurns;
  const pending = call<DbConversationDetail | null>(
    'conversation_detail',
    args
  ).finally(() => {
    if (conversationDetailInflight.get(key) === pending) {
      conversationDetailInflight.delete(key);
    }
  });
  conversationDetailInflight.set(key, pending);
  if (isPrefetch) {
    conversationDetailPrefetchCache.set(key, {
      promise: pending,
      expiresAt: Date.now() + PREFETCH_DETAIL_TTL_MS,
    });
    void pending.catch(() => {
      if (conversationDetailPrefetchCache.get(key)?.promise === pending) {
        conversationDetailPrefetchCache.delete(key);
      }
    });
  }
  return pending;
}

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
    // Windowed transcript. `fromIndex` keeps a scrolled suffix; omitted means the tail.
    detail: (
      conversationId: string,
      window?: ConversationDetailWindow
    ): Promise<DbConversationDetail | null> =>
      fetchConversationDetail(call, conversationId, window, false),
    prefetchDetail: (conversationId: string): void => {
      void fetchConversationDetail(call, conversationId, undefined, true).catch(
        () => undefined
      );
    },

    // Materialize or reconnect an Agent session and return its authoritative ACP
    // controls. This never sends a prompt.
    ensureSessionControls: (
      conversationId: string,
      options?: { reload?: boolean }
    ): Promise<AgentSessionControlsSnapshot> =>
      call('conversation_ensure_session_controls', {
        conversationId,
        reload: options?.reload ?? false,
      }),

    touch: (
      conversationId: string,
      watch?: boolean
    ): Promise<{ ok: boolean; idleTimeoutSecs: number }> =>
      call('conversation_touch', {
        conversationId,
        ...(watch === undefined ? {} : { watch }),
      }),

    rebindSession: (
      conversationId: string
    ): Promise<AgentSessionControlsSnapshot> =>
      call('conversation_rebind_session', { conversationId }),

    goalControl: (
      conversationId: string,
      action: 'pause' | 'clear'
    ): Promise<GoalControlReceipt> =>
      call('conversation_goal_control', {
        conversationId,
        action,
      }),

    stopAsyncTask: (
      conversationId: string,
      taskId: string
    ): Promise<{ stopped: boolean }> =>
      call('conversation_stop_async_task', {
        conversationId,
        taskId,
      }),

    startTurn: async (
      request: ConversationStartTurnRequest
    ): Promise<ConversationTurnSnapshot> => {
      const hasBeforeTurnHooks =
        promptContextRegistry.size > 0 ||
        serviceContainer.hasInterceptors('conversation.beforeTurn') ||
        Boolean(request.internalPromptContributions?.length);
      if (!hasBeforeTurnHooks) {
        return call('conversation_start_turn', {
          request: {
            ...request,
            images: request.images ?? [],
          },
        });
      }
      const resolved = await resolveBeforeTurnPromptContributions({
        conversationId: request.conversationId,
        workspaceId: request.workspaceId,
        agentId: request.agentId,
        text: request.text,
        internalPromptContributions: request.internalPromptContributions,
      });
      return call('conversation_start_turn', {
        request: {
          ...request,
          text: resolved.agentPromptText,
          ...(resolved.agentPromptText !== request.text && !request.displayText
            ? { displayText: request.text }
            : {}),
          ...(resolved.internalPromptContributions.length > 0
            ? {
                internalPromptContributions:
                  resolved.internalPromptContributions,
              }
            : {}),
          images: request.images ?? [],
        },
      });
    },

    submitInput: async (
      conversationId: string,
      payload: ConversationInputPayload,
      operationId?: string
    ): Promise<ConversationInputSubmission> => {
      const hasBeforeTurnHooks =
        promptContextRegistry.size > 0 ||
        serviceContainer.hasInterceptors('conversation.beforeTurn') ||
        Boolean(
          (
            payload as ConversationInputPayload & {
              internalPromptContributions?: InternalPromptContributionBlock[];
            }
          ).internalPromptContributions?.length
        );
      let effectivePayload = payload;
      if (hasBeforeTurnHooks) {
        const resolved = await resolveBeforeTurnPromptContributions({
          conversationId,
          workspaceId: payload.workspaceId,
          agentId: payload.agentId,
          text: payload.text,
          internalPromptContributions: (
            payload as ConversationInputPayload & {
              internalPromptContributions?: InternalPromptContributionBlock[];
            }
          ).internalPromptContributions,
        });
        effectivePayload = {
          ...payload,
          text: resolved.agentPromptText,
          ...(resolved.agentPromptText !== payload.text && !payload.displayText
            ? { displayText: payload.text }
            : {}),
          ...(resolved.internalPromptContributions.length > 0
            ? {
                internalPromptContributions:
                  resolved.internalPromptContributions as ConversationInputPayload['internalPromptContributions'],
              }
            : {}),
        };
      }
      return operationId
        ? callApplicationCommand(
            transport,
            'conversation_input_submit',
            { request: { conversationId, payload: effectivePayload } },
            { operationId }
          )
        : callApplicationCommand(transport, 'conversation_input_submit', {
            request: { conversationId, payload: effectivePayload },
          });
    },

    steer: (
      request: {
        conversationId: string;
        expectedTurnId: string;
        text: string;
        images?: string[];
        promotedInputId?: string;
        expectedRevision?: number;
        allowInterruptRestart?: boolean;
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
      delaySeconds?: number | null;
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

    rowsSince: async (
      request: ConversationEventsSinceRequest
    ): Promise<ConversationRowsSinceResult> => {
      const serialized = {
        ...request,
        afterSequence: serializeSequenceForIpc(request.afterSequence),
      };
      try {
        const raw = await call<unknown>('conversation_rows_since', {
          request: serialized,
        });
        return normalizeConversationRowsSinceResult(
          raw,
          request.conversationId,
          request.afterSequence
        );
      } catch (error) {
        if (!isUnimplementedConversationCommandError(error)) {
          throw error;
        }
        const fallback = await call<unknown>('conversation_events_since', {
          request: serialized,
        });
        return normalizeConversationRowsSinceResult(
          fallback,
          request.conversationId,
          request.afterSequence
        );
      }
    },

    timelinePage: (
      request: ConversationTimelinePageRequest
    ): Promise<ConversationTimelinePage> =>
      call('conversation_timeline_page', { request }),

    timelineImage: (
      hash: string
    ): Promise<{
      mime_type: string;
      data_base64: string;
      width?: number | null;
      height?: number | null;
    }> => call('conversation_timeline_image', { request: { hash } }),

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

    salvageFeedback: (request: {
      conversationId: string;
      noteId: string;
    }): Promise<ConversationLiveFeedbackNote> =>
      callApplicationCommand(transport, 'conversation_salvage_feedback', {
        request,
      }),

    dismissFeedback: (request: {
      conversationId: string;
      noteId: string;
    }): Promise<ConversationLiveFeedbackNote> =>
      callApplicationCommand(transport, 'conversation_dismiss_feedback', {
        request,
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

    checkRollbackSafety: async (
      request: ConversationCheckpointPreviewRequest
    ): Promise<RollbackSafetyReport> => {
      try {
        const raw = await call<unknown>('conversation_check_rollback_safety', {
          request,
        });
        return normalizeRollbackSafetyReport(raw);
      } catch (error) {
        if (isUnimplementedConversationCommandError(error)) {
          return { status: 'safe', engineSupportsRevert: true };
        }
        throw error;
      }
    },

    updateRateLimitAutoResume: (
      request: ConversationRateLimitAutoResumeRequest
    ): Promise<void> =>
      call('conversation_rate_limit_update_auto_resume', { request }),

    cancelRateLimitWait: (
      request: ConversationRateLimitCancelWaitRequest
    ): Promise<void> =>
      call('conversation_rate_limit_cancel_wait', { request }),

    previewEngineHandoff: (
      request: ConversationEngineHandoffRequest
    ): Promise<ConversationEngineHandoffPreview> =>
      call('conversation_preview_engine_handoff', { request }),

    confirmEngineHandoff: (
      request: ConversationEngineHandoffRequest
    ): Promise<void> =>
      call('conversation_confirm_engine_handoff', { request }),

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

    searchConversations: async (request: {
      query: string;
      workspaceId?: string | null;
      limit?: number;
      offset?: number;
    }): Promise<ConversationGlobalSearchHit[]> => {
      const rows = await call<unknown[]>('conversation_search', {
        query: request.query,
        workspaceId: request.workspaceId ?? null,
        limit: request.limit ?? 20,
        offset: request.offset ?? 0,
      });
      return Array.isArray(rows)
        ? rows.map(normalizeConversationGlobalSearchHit)
        : [];
    },

    import: (
      request: ConversationImportRequest
    ): Promise<ConversationImportResult> =>
      call('conversation_import', { request }),

    fork: (
      conversationId: string,
      atTurnId?: string
    ): Promise<ConversationForkResult> =>
      call('conversation_fork', {
        conversationId,
        atTurnId: atTurnId ?? null,
      }),
  };
}

export const conversationApi = createConversationApi(
  configuredBackendTransport
);
