import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  DbConversationDetail,
  MessageTurn,
  SessionStats,
} from 'shared/types';
import { agentsApi } from './api';
import {
  buildStreamingTurns,
  findActivePrompt,
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
const PERSIST_REFETCH_DELAY_MS = 600;
/** Bounded retries while waiting for the finished round to land on disk. */
const MAX_PERSIST_REFETCH_ATTEMPTS = 4;
const PERSIST_REFETCH_BACKOFF_MS = 900;

/**
 * The live runtime for one conversation: composes the re-parsed persisted
 * transcript (`conversation_detail`) with the live event stream into a single
 * unified timeline (see {@link getTimelineTurns}).
 *
 * `events` is supplied by the caller's agent workbench so this hook never opens
 * a second `agent-events` subscription. The tricky part is the completion
 * hand-off: when a turn finishes, the streamed turn disappears but the re-parse
 * lags the agent's file write, so the finished round is held in a "bridge" until
 * a re-parse confirms it landed — promoted in a layout effect to avoid a blank
 * frame, and cleared atomically when the persisted copy supersedes it.
 *
 * VibeX-authored.
 */
export function useConversationRuntime({
  conversationId,
  events,
}: UseConversationRuntimeInput): ConversationRuntime {
  const [detail, setDetail] = useState<DbConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  // Completed round held on-screen until the re-parse catches up (no flicker).
  const [bridgeTurns, setBridgeTurns] = useState<MessageTurn[]>([]);
  // Bumped once per newly-finished turn to kick off the persist-refetch loop.
  const [persistSignal, setPersistSignal] = useState<string | null>(null);

  // Ignore responses from superseded fetches (conversation switch / overlap).
  const generationRef = useRef(0);
  // Persisted turn count captured when a round finished; the bridge clears once
  // the re-parse grows past it and ends on an assistant turn.
  const bridgeBaselineRef = useRef(0);
  // The last finished prompt id reacted to (detect newly-finished turns).
  const lastFinishedPromptRef = useRef<string | null>(null);
  // Latest snapshot of `detail` for use inside event-driven effects without
  // adding `detail` to their dependency arrays (which churn on every chunk).
  const detailRef = useRef<DbConversationDetail | null>(null);
  // The active round (user + assistant) captured each render, so it can be
  // promoted to the bridge the instant the turn finishes.
  const activeRoundRef = useRef<{ user: MessageTurn | null; assistant: MessageTurn[] }>(
    { user: null, assistant: [] }
  );

  const fetchDetail = useCallback(
    async (settleBridge: boolean): Promise<boolean> => {
      if (!conversationId) return false;
      generationRef.current += 1;
      const generation = generationRef.current;
      setDetailLoading(true);
      try {
        const result = await agentsApi.conversationDetail(conversationId);
        if (generation !== generationRef.current) return false; // superseded
        setDetail(result);
        setDetailError(null);
        setDetailLoading(false);
        const landed =
          !!result &&
          result.turns.length > bridgeBaselineRef.current &&
          result.turns[result.turns.length - 1]?.role === 'assistant';
        if (settleBridge && landed) {
          setBridgeTurns([]);
        }
        return settleBridge ? landed : true;
      } catch (error) {
        if (generation !== generationRef.current) return false;
        setDetailError(error instanceof Error ? error.message : String(error));
        setDetailLoading(false);
        return false;
      }
    },
    [conversationId]
  );

  // Cold open / conversation switch: reset and re-parse from scratch.
  useEffect(() => {
    setDetail(null);
    setBridgeTurns([]);
    setPersistSignal(null);
    lastFinishedPromptRef.current = null;
    bridgeBaselineRef.current = 0;
    if (conversationId) {
      void fetchDetail(false);
    }
  }, [conversationId, fetchDetail]);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  const streaming = useMemo(
    () => buildStreamingTurns(events, conversationId ?? ''),
    [events, conversationId]
  );

  const optimisticUserTurn = useMemo<MessageTurn | null>(() => {
    const active = findActivePrompt(events);
    if (!active || !conversationId) return null;
    return {
      id: `prompt-${conversationId}-${active.id}`,
      role: 'user',
      blocks: [{ type: 'text', text: active.textPreview }],
      timestamp: active.startedAt,
    };
  }, [events, conversationId]);

  // Capture the active round so it survives the moment the turn finishes (when
  // both the streaming turn and the optimistic user turn drop out of the stream).
  useEffect(() => {
    if (streaming.turns.length > 0 || optimisticUserTurn) {
      activeRoundRef.current = {
        user: optimisticUserTurn,
        assistant: streaming.turns,
      };
    }
  }, [streaming, optimisticUserTurn]);

  // Detect a newly-finished turn and promote it to the bridge before paint.
  useLayoutEffect(() => {
    let lastFinished: string | null = null;
    for (const envelope of events) {
      if (envelope.event.kind === 'prompt_finished') {
        lastFinished = String(envelope.event.finished.prompt_id);
      }
    }
    if (!lastFinished || lastFinished === lastFinishedPromptRef.current) return;
    lastFinishedPromptRef.current = lastFinished;
    if (!conversationId) return;

    const round = activeRoundRef.current;
    const promoted = [
      ...(round.user ? [round.user] : []),
      ...round.assistant,
    ];
    if (promoted.length > 0) {
      setBridgeTurns(promoted);
    }
    bridgeBaselineRef.current = detailRef.current?.turns.length ?? 0;
    setPersistSignal(lastFinished);
  }, [events, conversationId]);

  // Drive the delayed, bounded re-parse loop for a finished round.
  useEffect(() => {
    if (!persistSignal) return;
    let cancelled = false;
    const run = async () => {
      for (let attempt = 0; attempt < MAX_PERSIST_REFETCH_ATTEMPTS; attempt += 1) {
        const delay =
          attempt === 0 ? PERSIST_REFETCH_DELAY_MS : PERSIST_REFETCH_BACKOFF_MS;
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (cancelled) return;
        const landed = await fetchDetail(true);
        if (cancelled || landed) return;
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [persistSignal, fetchDetail]);

  const timeline = useMemo(
    () =>
      getTimelineTurns({
        conversationId: conversationId ?? '',
        persisted: detail?.turns ?? [],
        local: bridgeTurns,
        optimistic: optimisticUserTurn ? [optimisticUserTurn] : [],
        streaming,
        inFlightUserTurnId: detail?.in_flight_user_turn_id ?? null,
      }),
    [conversationId, detail, bridgeTurns, optimisticUserTurn, streaming]
  );

  const refetch = useCallback(() => {
    void fetchDetail(false);
  }, [fetchDetail]);

  return {
    timeline,
    sessionStats: detail?.session_stats ?? null,
    detailLoading,
    detailError,
    refetch,
  };
}
