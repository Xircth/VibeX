import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type {
  AgentElicitationResponse,
  AgentPermissionResponse,
  AgentSessionConfigOption,
  ConversationRowOpBatch,
  MessageTurn,
  TimelineRow,
} from 'shared/types';
import { conversationApi } from './conversationApi';
import { listenToConversationEvents } from './events';
import { subscribeToOptimisticConversationTurns } from './optimisticTurnEvents';
import {
  conversationStoreReducer,
  emptyConversationStoreState,
  sideRowsForEntry,
  timelineItemsForEntry,
  timelineTurnsForEntry,
  type ConversationSessionModesState,
  type ConversationTimelineItem,
  type ConversationTimelineTurn,
} from './conversationStore';

// Stable empty references so consumers don't re-render on identity churn.
const EMPTY_SESSION_MODES: ConversationSessionModesState = {
  current: null,
  modes: [],
};
const EMPTY_CONFIG_OPTIONS: AgentSessionConfigOption[] = [];

export type UseConversationTimelineResult = {
  timeline: ConversationTimelineTurn[];
  items: ConversationTimelineItem[];
  sideRows: TimelineRow[];
  agentId: string | null;
  loading: boolean;
  error: string | null;
  lastSequence: bigint;
  /** Agent-advertised session modes (+ current) for the composer's mode picker. */
  sessionModes: ConversationSessionModesState;
  /** Agent-advertised session config options for the composer. */
  sessionConfigOptions: AgentSessionConfigOption[];
  sendOptimisticTurn: (turn: MessageTurn) => void;
  removeOptimisticTurn: (turnId: string) => void;
  refresh: () => void;
  /** Hard-reset: drop in-memory rows + buffered live state, then re-project from the
   *  (possibly truncated) durable log. Used by reset-to-here, where the server
   *  rewrites history and live events restart from a lower sequence. */
  resetAndReload: () => Promise<void>;
  /** Restore the concrete ACP session, then refresh its durable projection without
   *  clearing rows or buffered stream content. */
  reconnectAndReload: () => Promise<void>;
  cancel: (reason?: string) => Promise<void>;
  respondPermission: (
    permissionId: string,
    response: AgentPermissionResponse
  ) => Promise<void>;
  respondQuestion: (
    questionId: string,
    response: AgentElicitationResponse
  ) => Promise<void>;
  hasEarlier: boolean;
  loadOlder: () => Promise<void>;
};

export function useConversationTimeline(
  conversationId: string | null
): UseConversationTimelineResult {
  const [state, dispatch] = useReducer(
    conversationStoreReducer,
    emptyConversationStoreState
  );
  const stateRef = useRef(state);
  const pendingBatchesRef = useRef<ConversationRowOpBatch[]>([]);
  const flushFrameRef = useRef<number | null>(null);
  const loadingOlderRef = useRef(false);
  stateRef.current = state;

  const loadDetail = useCallback((): Promise<void> => {
    if (!conversationId) return Promise.resolve();
    dispatch({ type: 'load_start', conversationId });
    return conversationApi
      .detail(conversationId)
      .then((detail) => {
        if (!detail) {
          dispatch({
            type: 'load_error',
            conversationId,
            error: 'Conversation not found',
          });
          return;
        }
        dispatch({ type: 'load_success', conversationId, detail });
        const needsAuthoritativeZeroTurnControls =
          detail.summary.message_count === 0n;
        if (detail.summary.agent_id && needsAuthoritativeZeroTurnControls) {
          return conversationApi
            .ensureSessionControls(conversationId)
            .then((controls) => {
              dispatch({
                type: 'session_controls_hydrated',
                conversationId,
                controls,
              });
            });
        }
      })
      .catch((error: unknown) => {
        dispatch({
          type: 'load_error',
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [conversationId]);

  const resetAndReload = useCallback((): Promise<void> => {
    if (!conversationId) return Promise.resolve();
    // Drop buffered/queued live state so post-truncation events (which restart from a
    // lower sequence) aren't filtered as "already seen", then clear rows and re-project.
    // Returns the load promise so callers can await the truncated timeline before
    // re-sending (otherwise a load_success arriving after the resend's live events
    // would be discarded by `keepRealtimeRows`, dropping the surviving turns).
    if (flushFrameRef.current != null) {
      cancelAnimationFrame(flushFrameRef.current);
      flushFrameRef.current = null;
    }
    pendingBatchesRef.current = [];
    dispatch({ type: 'reset', conversationId });
    return loadDetail();
  }, [conversationId, loadDetail]);

  const reconnectAndReload = useCallback(async (): Promise<void> => {
    if (!conversationId) return;
    try {
      const controls =
        await conversationApi.ensureSessionControls(conversationId);
      dispatch({
        type: 'session_controls_hydrated',
        conversationId,
        controls,
      });
      await loadDetail();
    } catch (error: unknown) {
      dispatch({
        type: 'load_error',
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [conversationId, loadDetail]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  const hasDetail = conversationId
    ? Boolean(state.byConversationId[conversationId]?.detail)
    : false;

  useEffect(() => {
    if (!conversationId || !hasDetail) return;
    let active = true;
    let unlisten: (() => void) | undefined;

    const cancelFlush = () => {
      if (flushFrameRef.current == null) return;
      cancelAnimationFrame(flushFrameRef.current);
      flushFrameRef.current = null;
    };

    // Apply every row-op batch buffered since the last paint in ONE pass. Coalescing
    // per animation frame keeps streamed text smooth and frame-aligned while capping
    // React commits at the display refresh rate (dispatching each batch individually
    // feeds the virtualizer/stick-to-bottom layout effects fast enough to trip
    // "Maximum update depth exceeded"). Row ops are idempotent, so ordering within a
    // frame is not load-bearing.
    const flushPendingBatches = () => {
      flushFrameRef.current = null;
      if (!active) return;
      const batches = pendingBatchesRef.current;
      if (batches.length === 0) return;
      pendingBatchesRef.current = [];
      for (const batch of batches) {
        dispatch({ type: 'row_ops', batch });
      }
    };

    const scheduleFlush = () => {
      if (flushFrameRef.current != null) return;
      flushFrameRef.current = requestAnimationFrame(flushPendingBatches);
    };

    listenToConversationEvents((batch) => {
      if (!active || batch.conversation_id !== conversationId) return;
      pendingBatchesRef.current.push(batch);
      scheduleFlush();
    }, conversationId)
      .then((unsubscribe) => {
        if (!active) {
          unsubscribe();
          return;
        }
        unlisten = unsubscribe;
        // Catch any batches emitted between the initial load and this subscription
        // by backfilling the rows that changed since our cursor. Idempotent upserts,
        // so this is safe even when nothing was missed.
        const current =
          stateRef.current.byConversationId[conversationId]?.lastSequence ?? 0n;
        void conversationApi
          .eventsSince({
            conversationId,
            afterSequence: Number(current),
            limit: 500,
          })
          .then((page) => {
            if (!active || page.rows.length === 0) return;
            dispatch({
              type: 'upsert_rows',
              conversationId,
              rows: page.rows,
              lastSequence: toBigInt(page.last_sequence),
            });
          })
          .catch(() => {});
      })
      .catch((error: unknown) => {
        dispatch({
          type: 'load_error',
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      active = false;
      cancelFlush();
      pendingBatchesRef.current = [];
      unlisten?.();
    };
  }, [conversationId, hasDetail, loadDetail]);

  const entry = conversationId
    ? (state.byConversationId[conversationId] ?? null)
    : null;

  const gap = entry?.gap;
  useEffect(() => {
    if (!conversationId || !gap || gap.kind !== 'gap') return;
    let cancelled = false;
    const afterSequence = gap.expectedSequence - 1n;
    void conversationApi
      .eventsSince({
        conversationId,
        afterSequence: Number(afterSequence),
        limit: 500,
      })
      .then((page) => {
        if (cancelled || page.rows.length === 0) return;
        dispatch({
          type: 'upsert_rows',
          conversationId,
          rows: page.rows,
          lastSequence: toBigInt(page.last_sequence),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId, gap]);

  const sendOptimisticTurn = useCallback(
    (turn: MessageTurn) => {
      if (!conversationId) return;
      dispatch({ type: 'optimistic_turn', conversationId, turn });
    },
    [conversationId]
  );

  const removeOptimisticTurn = useCallback(
    (turnId: string) => {
      if (!conversationId) return;
      dispatch({ type: 'remove_optimistic_turn', conversationId, turnId });
    },
    [conversationId]
  );

  useEffect(
    () =>
      subscribeToOptimisticConversationTurns((event) => {
        if (event.conversationId !== conversationId) return;
        if (event.type === 'add') {
          dispatch({
            type: 'optimistic_turn',
            conversationId: event.conversationId,
            turn: event.turn,
          });
          return;
        }
        dispatch({
          type: 'remove_optimistic_turn',
          conversationId: event.conversationId,
          turnId: event.turnId,
        });
      }),
    [conversationId]
  );

  const cancel = useCallback(
    (reason?: string) => {
      if (!conversationId) return Promise.resolve();
      return conversationApi.cancel({ conversationId, reason });
    },
    [conversationId]
  );

  const respondPermission = useCallback(
    (permissionId: string, response: AgentPermissionResponse) => {
      if (!conversationId) return Promise.resolve();
      return conversationApi.respondPermission({
        conversationId,
        permissionId,
        response,
      });
    },
    [conversationId]
  );

  const loadOlder = useCallback(async () => {
    if (!conversationId || loadingOlderRef.current) return;
    const cursor =
      stateRef.current.byConversationId[conversationId]?.olderCursor;
    if (!cursor) return;
    const end = Number(cursor);
    if (!Number.isFinite(end) || end <= 0) return;
    const start = Math.max(0, end - 80);
    loadingOlderRef.current = true;
    try {
      const page = await conversationApi.timelinePage({
        conversationId,
        cursor: String(start),
        limit: end - start,
      });
      dispatch({
        type: 'upsert_rows',
        conversationId,
        rows: page.rows,
        lastSequence: toBigInt(
          stateRef.current.byConversationId[conversationId]?.lastSequence ?? 0n
        ),
        olderCursor: start > 0 ? String(start) : null,
      });
    } finally {
      loadingOlderRef.current = false;
    }
  }, [conversationId]);

  const respondQuestion = useCallback(
    (questionId: string, response: AgentElicitationResponse) => {
      if (!conversationId) return Promise.resolve();
      return conversationApi.respondQuestion({
        conversationId,
        questionId,
        response,
      });
    },
    [conversationId]
  );

  return useMemo(
    () => ({
      timeline: timelineTurnsForEntry(entry),
      items: timelineItemsForEntry(entry),
      sideRows: sideRowsForEntry(entry),
      agentId: entry?.detail?.summary.agent_id ?? null,
      loading: entry?.loading ?? false,
      error: entry?.error ?? null,
      lastSequence: entry?.lastSequence ?? 0n,
      sessionModes: entry?.sessionModes ?? EMPTY_SESSION_MODES,
      sessionConfigOptions: entry?.sessionConfigOptions ?? EMPTY_CONFIG_OPTIONS,
      sendOptimisticTurn,
      removeOptimisticTurn,
      refresh: loadDetail,
      resetAndReload,
      reconnectAndReload,
      cancel,
      respondPermission,
      respondQuestion,
      hasEarlier: Boolean(entry?.olderCursor),
      loadOlder,
    }),
    [
      entry,
      sendOptimisticTurn,
      removeOptimisticTurn,
      loadDetail,
      resetAndReload,
      reconnectAndReload,
      cancel,
      respondPermission,
      respondQuestion,
      loadOlder,
    ]
  );
}

function toBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}
