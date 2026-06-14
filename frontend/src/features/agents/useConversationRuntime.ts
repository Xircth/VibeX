import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DbConversationDetail, SessionStats } from 'shared/types';
import { agentsApi } from './api';
import {
  buildTurnsFromEvents,
  getTimelineTurns,
  type ConversationTimelineTurn,
} from './timeline';
import type { AgentEventEnvelope } from './types';

export interface UseConversationRuntimeInput {
  /** VibeX session/conversation row id; `null` disables the runtime. */
  conversationId: string | null;
  /** Live event envelopes for this conversation's scope (from the workbench). */
  events: AgentEventEnvelope[];
}

export interface ConversationRuntime {
  timeline: ConversationTimelineTurn[];
  sessionStats: SessionStats | null;
  detailLoading: boolean;
  detailError: string | null;
  /** Force a re-parse of the persisted transcript. */
  refetch: () => void;
}

/** Delay before re-parsing after a turn finishes, letting the agent flush its file. */
const PERSIST_REFETCH_DELAY_MS = 800;

/**
 * The live runtime for one conversation. The rendered timeline is reconstructed
 * directly from the ACP event stream (`buildTurnsFromEvents`) — events are the
 * source of truth for a live session, so replies render reliably whether the turn
 * is in-flight or already finished. The re-parsed persisted transcript
 * (`conversation_detail`) is fetched only as the cold-open history fallback (and
 * refreshed after a turn finishes so future cold opens are complete).
 *
 * `events` is supplied by the caller's agent workbench so this hook never opens a
 * second `agent-events` subscription. VibeX-authored.
 */
export function useConversationRuntime({
  conversationId,
  events,
}: UseConversationRuntimeInput): ConversationRuntime {
  const [detail, setDetail] = useState<DbConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Ignore responses from superseded fetches (conversation switch / overlap).
  const generationRef = useRef(0);
  // The last finished prompt id reacted to (to refresh persisted once per turn).
  const lastFinishedPromptRef = useRef<string | null>(null);

  const fetchDetail = useCallback(async (): Promise<void> => {
    if (!conversationId) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    setDetailLoading(true);
    try {
      const result = await agentsApi.conversationDetail(conversationId);
      if (generation !== generationRef.current) return; // superseded
      setDetail(result);
      setDetailError(null);
      setDetailLoading(false);
    } catch (error) {
      if (generation !== generationRef.current) return;
      setDetailError(error instanceof Error ? error.message : String(error));
      setDetailLoading(false);
    }
  }, [conversationId]);

  // Cold open / conversation switch: reset and re-parse the history.
  useEffect(() => {
    setDetail(null);
    lastFinishedPromptRef.current = null;
    if (conversationId) {
      void fetchDetail();
    }
  }, [conversationId, fetchDetail]);

  // After each turn finishes, refresh the persisted transcript so the next cold
  // open is complete. The live display itself comes from events, so this never
  // affects what's currently on screen.
  useEffect(() => {
    let lastFinished: string | null = null;
    for (const envelope of events) {
      if (envelope.event.kind === 'prompt_finished') {
        lastFinished = String(envelope.event.finished.prompt_id);
      }
    }
    if (!lastFinished || lastFinished === lastFinishedPromptRef.current) return;
    lastFinishedPromptRef.current = lastFinished;
    const timer = setTimeout(() => void fetchDetail(), PERSIST_REFETCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [events, fetchDetail]);

  const live = useMemo(
    () => buildTurnsFromEvents(events, conversationId ?? ''),
    [events, conversationId]
  );

  const timeline = useMemo(
    () =>
      getTimelineTurns({
        conversationId: conversationId ?? '',
        persisted: detail?.turns ?? [],
        live: live.turns,
        inProgressToolCallIds: live.inProgressToolCallIds,
      }),
    [conversationId, detail, live]
  );

  const refetch = useCallback(() => {
    void fetchDetail();
  }, [fetchDetail]);

  return {
    timeline,
    sessionStats: detail?.session_stats ?? null,
    detailLoading,
    detailError,
    refetch,
  };
}
