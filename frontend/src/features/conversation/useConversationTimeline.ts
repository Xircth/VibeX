import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type {
  AgentPermissionResponse,
  AgentSessionConfigOption,
  ConversationEventEnvelope,
  ConversationTimelineRow,
  MessageTurn,
} from 'shared/types';
import { conversationApi } from './conversationApi';
import { listenToConversationEvents } from './events';
import {
  conversationStoreReducer,
  emptyConversationStoreState,
  sideRowsForEntry,
  timelineTurnsForEntry,
  type ConversationSessionModesState,
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
  sideRows: ConversationTimelineRow[];
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
  cancel: (reason?: string) => Promise<void>;
  respondPermission: (
    permissionId: string,
    response: AgentPermissionResponse
  ) => Promise<void>;
};

export function useConversationTimeline(
  conversationId: string | null
): UseConversationTimelineResult {
  const [state, dispatch] = useReducer(
    conversationStoreReducer,
    emptyConversationStoreState
  );
  const stateRef = useRef(state);
  const pendingEventsRef = useRef<ConversationEventEnvelope[]>([]);
  const flushFrameRef = useRef<number | null>(null);
  const queuedLastSequenceRef = useRef<bigint | null>(null);
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
    pendingEventsRef.current = [];
    queuedLastSequenceRef.current = null;
    dispatch({ type: 'reset', conversationId });
    return loadDetail();
  }, [conversationId, loadDetail]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    if (!conversationId) return;
    let active = true;
    let unlisten: (() => void) | undefined;

    const cancelFlush = () => {
      if (flushFrameRef.current == null) return;
      cancelAnimationFrame(flushFrameRef.current);
      flushFrameRef.current = null;
    };

    // Apply everything buffered since the last paint in ONE dispatch. Coalescing
    // per animation frame (instead of per event) keeps the streamed text smooth
    // and frame-aligned while capping React commits at the display refresh rate —
    // dispatching every delta individually feeds the virtualizer/stick-to-bottom
    // layout effects fast enough to trip "Maximum update depth exceeded".
    const flushPendingEvents = () => {
      flushFrameRef.current = null;
      if (!active) return;
      const events = pendingEventsRef.current;
      if (events.length === 0) return;

      pendingEventsRef.current = [];
      const orderedEvents = [...events].sort((left, right) => {
        const leftSequence = toBigInt(left.sequence);
        const rightSequence = toBigInt(right.sequence);
        return leftSequence < rightSequence
          ? -1
          : leftSequence > rightSequence
            ? 1
            : 0;
      });
      const lastEvent = orderedEvents[orderedEvents.length - 1];
      queuedLastSequenceRef.current = lastEvent
        ? toBigInt(lastEvent.sequence)
        : null;
      dispatch({ type: 'events', conversationId, events: orderedEvents });
    };

    const scheduleFlush = () => {
      if (flushFrameRef.current != null) return;
      flushFrameRef.current = requestAnimationFrame(flushPendingEvents);
    };

    listenToConversationEvents((event) => {
      if (!active || event.conversation_id !== conversationId) return;
      const entry = stateRef.current.byConversationId[conversationId];
      const current = entry?.lastSequence ?? 0n;
      const sequence = toBigInt(event.sequence);
      const queuedLast = queuedLastSequenceRef.current;
      const effectiveLast =
        queuedLast != null && queuedLast > current ? queuedLast : current;

      // A sequence jumped past what we have — backfill the hole over REST, then
      // resume the live stream from there.
      if (sequence > effectiveLast + 1n) {
        cancelFlush();
        pendingEventsRef.current = [];
        conversationApi
          .eventsSince({
            conversationId,
            afterSequence: current,
            limit: 200,
          })
          .then((page) => {
            if (!active) return;
            if (page.events.length === 0) {
              queuedLastSequenceRef.current = null;
              loadDetail();
              return;
            }
            queuedLastSequenceRef.current = toBigInt(page.last_sequence);
            dispatch({ type: 'events', conversationId, events: page.events });
          })
          .catch(() => {
            queuedLastSequenceRef.current = null;
            loadDetail();
          });
        return;
      }

      // Drop replays/duplicates of events already applied (or queued for apply).
      if (sequence <= effectiveLast) return;

      // Buffer and flush on the next frame. `queuedLastSequenceRef` advances now
      // so a same-frame burst keeps gap detection sound before the dispatch lands.
      pendingEventsRef.current.push(event);
      queuedLastSequenceRef.current = sequence;
      scheduleFlush();
    })
      .then((unsubscribe) => {
        if (!active) {
          unsubscribe();
          return;
        }
        unlisten = unsubscribe;
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
      pendingEventsRef.current = [];
      queuedLastSequenceRef.current = null;
      unlisten?.();
    };
  }, [conversationId, loadDetail]);

  const entry = conversationId
    ? (state.byConversationId[conversationId] ?? null)
    : null;

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

  return useMemo(
    () => ({
      timeline: timelineTurnsForEntry(entry),
      sideRows: sideRowsForEntry(entry),
      loading: entry?.loading ?? false,
      error: entry?.error ?? null,
      lastSequence: entry?.lastSequence ?? 0n,
      sessionModes: entry?.sessionModes ?? EMPTY_SESSION_MODES,
      sessionConfigOptions: entry?.sessionConfigOptions ?? EMPTY_CONFIG_OPTIONS,
      sendOptimisticTurn,
      removeOptimisticTurn,
      refresh: loadDetail,
      resetAndReload,
      cancel,
      respondPermission,
    }),
    [
      entry,
      sendOptimisticTurn,
      removeOptimisticTurn,
      loadDetail,
      resetAndReload,
      cancel,
      respondPermission,
    ]
  );
}

function toBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}
