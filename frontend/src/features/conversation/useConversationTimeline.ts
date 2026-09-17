import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { getInvokeErrorMessage, isCanceledError } from '@/lib/errors';
import type {
  AgentElicitationResponse,
  AgentPermissionResponse,
  AgentSessionConfigOption,
  ConversationRowOpBatch,
  MessageTurn,
  TimelineRow,
} from 'shared/types';
import { listenToAgentEvents } from '@/features/agents/events';
import { conversationApi } from './conversationApi';
import { AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID } from './sessionNoticeNeedsRebind';
import { canSkipInFlightHistoryWait } from './canSkipInFlightHistoryWait';
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

function conversationLoadError(error: unknown): string | null {
  if (isCanceledError(error)) {
    return null;
  }
  return getInvokeErrorMessage(error);
}

function isStaleAgentConnectionError(error: unknown): boolean {
  const message = getInvokeErrorMessage(error) ?? '';
  return /agent connection `.+` was not found/i.test(message);
}

export type UseConversationTimelineResult = {
  timeline: ConversationTimelineTurn[];
  items: ConversationTimelineItem[];
  sideRows: TimelineRow[];
  agentId: string | null;
  currentTurnId: string | null;
  steeringSupported: boolean;
  forkSessionSupported: boolean;
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
  /** ACP bind finished. Composer send stays disabled until this is true. */
  sessionBindReady: boolean;
  /** Bind is in flight for a loaded conversation. */
  connecting: boolean;
};

export function useConversationTimeline(
  conversationId: string | null,
  options?: { active?: boolean }
): UseConversationTimelineResult {
  const isActive = options?.active ?? true;
  const [state, dispatch] = useReducer(
    conversationStoreReducer,
    emptyConversationStoreState
  );
  const stateRef = useRef(state);
  const pendingBatchesRef = useRef<ConversationRowOpBatch[]>([]);
  const flushFrameRef = useRef<number | null>(null);
  const loadingOlderRef = useRef(false);
  const disposedRef = useRef(false);
  const loadEpochRef = useRef(0);
  stateRef.current = state;

  const reportLoadError = useCallback(
    (error: unknown, targetConversationId = conversationId) => {
      if (!targetConversationId || disposedRef.current) {
        return;
      }
      dispatch({
        type: 'load_error',
        conversationId: targetConversationId,
        error: conversationLoadError(error),
      });
    },
    [conversationId]
  );

  const loadDetail = useCallback((): Promise<void> => {
    if (!conversationId) return Promise.resolve();
    const epoch = ++loadEpochRef.current;
    dispatch({ type: 'load_start', conversationId });
    return conversationApi
      .detail(conversationId)
      .then((detail) => {
        if (disposedRef.current || loadEpochRef.current !== epoch) return;
        if (!detail) {
          dispatch({
            type: 'load_error',
            conversationId,
            error: 'Conversation not found',
          });
          return;
        }
        dispatch({ type: 'load_success', conversationId, detail });
      })
      .catch((error: unknown) => {
        if (loadEpochRef.current !== epoch) return;
        reportLoadError(error);
      });
  }, [conversationId, reportLoadError]);

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

  const [sessionBindReady, setSessionBindReady] = useState(false);

  const reconnectAndReload = useCallback(async (): Promise<void> => {
    if (!conversationId) return;
    setSessionBindReady(false);
    try {
      const controls = await conversationApi.ensureSessionControls(
        conversationId,
        { reload: true }
      );
      dispatch({
        type: 'session_controls_hydrated',
        conversationId,
        controls,
      });
      setSessionBindReady(true);
      await loadDetail();
    } catch (error: unknown) {
      setSessionBindReady(false);
      reportLoadError(error);
    }
  }, [conversationId, loadDetail, reportLoadError]);

  const previousConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousConversationIdRef.current;
    previousConversationIdRef.current = conversationId;
    if (previous && previous !== conversationId) {
      dispatch({ type: 'reset', conversationId: previous });
    }
  }, [conversationId]);

  useEffect(() => {
    disposedRef.current = false;
    loadDetail();
    return () => {
      disposedRef.current = true;
      loadEpochRef.current += 1;
    };
  }, [loadDetail]);

  const hasDetail = conversationId
    ? Boolean(state.byConversationId[conversationId]?.detail)
    : false;

  useEffect(() => {
    setSessionBindReady(false);
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenToAgentEvents((envelope) => {
      if (!active || envelope.session_id !== conversationId) return;
      if (envelope.event.kind !== 'session_bind_ready') return;
      setSessionBindReady(true);
    }).then((unsubscribe) => {
      if (!active) {
        unsubscribe();
        return;
      }
      unlisten = unsubscribe;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [conversationId]);

  useEffect(() => {
    if (!isActive || !conversationId) return;
    const entry = stateRef.current.byConversationId[conversationId];
    const skipInFlightWait = canSkipInFlightHistoryWait(
      entry?.detail?.active_binding?.capabilities
    );
    if (!hasDetail && !skipInFlightWait) return;
    const detail = entry?.detail;
    if (!detail || entry?.error) return;
    if (!detail.summary.workspace_id || !detail.summary.agent_id) return;
    const hasUnclearedLoadFailure = (entry.rows ?? []).some(
      (row) => row.row_id === AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID
    );
    if (hasUnclearedLoadFailure) return;

    const requestedConversationId = conversationId;
    void conversationApi
      .ensureSessionControls(requestedConversationId, { reload: false })
      .then((controls) => {
        if (
          disposedRef.current ||
          previousConversationIdRef.current !== requestedConversationId
        ) {
          return;
        }
        dispatch({
          type: 'session_controls_hydrated',
          conversationId: requestedConversationId,
          controls,
        });
        setSessionBindReady(true);
      })
      .catch((error: unknown) => {
        if (
          disposedRef.current ||
          previousConversationIdRef.current !== requestedConversationId
        ) {
          return;
        }
        if (isStaleAgentConnectionError(error)) {
          return;
        }
        setSessionBindReady(false);
        reportLoadError(error, requestedConversationId);
      });
  }, [conversationId, hasDetail, isActive, reportLoadError]);

  useEffect(() => {
    if (!isActive || !conversationId || !hasDetail) return;
    let intervalMs = 30_000;
    let timer: ReturnType<typeof setInterval> | null = null;
    const touch = () => {
      void conversationApi
        .touch(conversationId)
        .then((result) => {
          const idleSecs = result?.idleTimeoutSecs ?? 0;
          if (idleSecs > 0) {
            const next = Math.min(30_000, (idleSecs * 1000) / 2);
            if (next !== intervalMs && next > 0) {
              intervalMs = next;
              if (timer) clearInterval(timer);
              timer = setInterval(touch, intervalMs);
            }
          }
        })
        .catch(() => {
          /* keepalive is best-effort */
        });
    };
    touch();
    timer = setInterval(touch, intervalMs);
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [conversationId, hasDetail, isActive]);

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
          .catch((error: unknown) => {
            if (!active) return;
            reportLoadError(error, conversationId);
          });
      })
      .catch((error: unknown) => {
        if (!active) return;
        reportLoadError(error, conversationId);
      });

    return () => {
      active = false;
      cancelFlush();
      pendingBatchesRef.current = [];
      unlisten?.();
    };
  }, [conversationId, hasDetail, loadDetail, reportLoadError]);

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
      .catch((error: unknown) => {
        if (cancelled) return;
        reportLoadError(error, conversationId);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, gap, reportLoadError]);

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
      currentTurnId: entry?.currentTurnId ?? null,
      steeringSupported: Boolean(
        entry?.detail?.active_binding?.capabilities.steering
      ),
      forkSessionSupported: Boolean(
        entry?.detail?.active_binding?.capabilities.fork_session
      ),
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
      sessionBindReady,
      connecting:
        Boolean(hasDetail) &&
        !sessionBindReady &&
        !entry?.error &&
        !(entry?.rows ?? []).some(
          (row) => row.row_id === AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID
        ),
    }),
    [
      entry,
      hasDetail,
      sendOptimisticTurn,
      removeOptimisticTurn,
      loadDetail,
      resetAndReload,
      reconnectAndReload,
      cancel,
      respondPermission,
      respondQuestion,
      loadOlder,
      sessionBindReady,
    ]
  );
}

function toBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}
