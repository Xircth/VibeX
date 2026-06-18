import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type {
  AgentPermissionResponse,
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
  type ConversationTimelineTurn,
} from './conversationStore';

const CONVERSATION_EVENT_FLUSH_MS = 16;

export type UseConversationTimelineResult = {
  timeline: ConversationTimelineTurn[];
  sideRows: ConversationTimelineRow[];
  loading: boolean;
  error: string | null;
  lastSequence: bigint;
  sendOptimisticTurn: (turn: MessageTurn) => void;
  removeOptimisticTurn: (turnId: string) => void;
  refresh: () => void;
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
  const flushTimerRef = useRef<number | null>(null);
  const queuedLastSequenceRef = useRef<bigint | null>(null);
  stateRef.current = state;

  const loadDetail = useCallback(() => {
    if (!conversationId) return;
    dispatch({ type: 'load_start', conversationId });
    conversationApi
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

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    if (!conversationId) return;
    let active = true;
    let unlisten: (() => void) | undefined;

    const clearFlushTimer = () => {
      if (flushTimerRef.current == null) return;
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    };

    const flushPendingEvents = () => {
      if (!active) return;
      const events = pendingEventsRef.current;
      if (events.length === 0) {
        clearFlushTimer();
        queuedLastSequenceRef.current = null;
        return;
      }

      pendingEventsRef.current = [];
      clearFlushTimer();
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
      if (flushTimerRef.current != null) return;
      flushTimerRef.current = window.setTimeout(
        flushPendingEvents,
        CONVERSATION_EVENT_FLUSH_MS
      );
    };

    listenToConversationEvents((event) => {
      if (!active || event.conversation_id !== conversationId) return;
      const entry = stateRef.current.byConversationId[conversationId];
      const current = entry?.lastSequence ?? 0n;
      const sequence = toBigInt(event.sequence);
      const queuedLast = queuedLastSequenceRef.current;
      const effectiveLast =
        queuedLast != null && queuedLast > current ? queuedLast : current;

      if (sequence > effectiveLast + 1n) {
        conversationApi
          .eventsSince({
            conversationId,
            afterSequence: current,
            limit: 200,
          })
          .then((page) => {
            if (!active) return;
            if (page.events.length === 0) {
              pendingEventsRef.current = [];
              clearFlushTimer();
              queuedLastSequenceRef.current = null;
              loadDetail();
              return;
            }
            pendingEventsRef.current = [];
            clearFlushTimer();
            queuedLastSequenceRef.current = toBigInt(page.last_sequence);
            dispatch({ type: 'events', conversationId, events: page.events });
          })
          .catch(() => {
            pendingEventsRef.current = [];
            clearFlushTimer();
            queuedLastSequenceRef.current = null;
            loadDetail();
          });
        return;
      }

      if (
        sequence <= current ||
        (queuedLastSequenceRef.current != null &&
          sequence <= queuedLastSequenceRef.current)
      ) {
        return;
      }
      pendingEventsRef.current.push(event);
      queuedLastSequenceRef.current =
        sequence > effectiveLast ? sequence : effectiveLast;
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
      clearFlushTimer();
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
      sendOptimisticTurn,
      removeOptimisticTurn,
      refresh: loadDetail,
      cancel,
      respondPermission,
    }),
    [
      entry,
      sendOptimisticTurn,
      removeOptimisticTurn,
      loadDetail,
      cancel,
      respondPermission,
    ]
  );
}

function toBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}
