import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Loader2 } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { BaseCodingAgent } from 'shared/types';
import type {
  MessageTurn,
  SessionStats,
  TaskWithAttemptStatus,
} from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import { MessageTurnView } from '@/components/NormalizedConversation/MessageTurnView';
import { agentsApi } from '@/features/agents/api';
import { sendAgentRuntimeTurn } from '@/features/agents/sendAgentRuntimeTurn';
import { TurnStats } from '@/components/conversation-thread/TurnStats';
import { LiveTurnStats } from '@/components/conversation-thread/LiveTurnStats';
import type { TurnStatsData } from '@/components/conversation-thread/turnStatsModel';
import { agentUsageToSnapshot } from '@/hooks/useConversationHistory/conversationTokenUsage';
import { useUserSystem } from '@/components/ConfigProvider';
import { ConversationMessageNav } from '@/components/conversation-thread/ConversationMessageNav';
import {
  findActiveConversationMessageNavEntry,
  type ConversationMessageNavEntry,
} from '@/components/conversation-thread/messageNavEntries';
import {
  AgentPermissionPanel,
  type PendingAgentPermission,
} from '@/components/agents/AgentPermissionPanel';
import { useAgentWorkbench } from '@/features/agents/useAgentWorkbench';
import { useConversationRuntime } from '@/features/agents/useConversationRuntime';
import type { ConversationTimelineTurn } from '@/features/agents/timeline';
import { cn } from '@/lib/utils';
import {
  findPreviousUserMessageVirtualIndex,
  findViewportAnchorVirtualIndex,
  getAgentSessionModel,
  getVirtualRowTranslateY,
  isConversationNearBottom,
  pendingAgentPermissionsForSession,
  type VirtualizedListRef,
} from './VirtualizedList';

const ESTIMATED_ROW_HEIGHT = 128;
const OVERSCAN = 10;

interface AgentTimelineConversationProps {
  attempt: WorkspaceWithSession;
  task: TaskWithAttemptStatus | null;
  onAtBottomChange?: (isAtBottom: boolean) => void;
}

/** Nav dots derived from the timeline's user turns (one dot per user message). */
export function buildTimelineNavEntries(
  timeline: ConversationTimelineTurn[]
): ConversationMessageNavEntry[] {
  const entries: ConversationMessageNavEntry[] = [];
  let ordinal = 0;
  timeline.forEach((row, index) => {
    if (row.turn.role !== 'user') return;
    ordinal += 1;
    const preview =
      row.turn.blocks
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join(' ')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 80) || `User message ${ordinal}`;
    entries.push({ key: row.key, index, ordinal, preview, additions: 0, deletions: 0 });
  });
  return entries;
}

function assistantCopyText(turn: MessageTurn): string {
  return turn.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n\n');
}

function contextWindowFrom(sessionStats: SessionStats | null): number | null {
  return sessionStats?.context_window_max_tokens != null
    ? Number(sessionStats.context_window_max_tokens)
    : null;
}

/** Turn stats for a settled assistant turn, sourced from the parsed MessageTurn. */
function buildSettledTurnStats(
  turn: MessageTurn,
  sessionStats: SessionStats | null
): TurnStatsData {
  const usage = turn.usage ?? null;
  return {
    model: turn.model ?? null,
    startedAt: turn.timestamp,
    totalTokens: usage
      ? Number(usage.input_tokens) +
        Number(usage.output_tokens) +
        Number(usage.cache_creation_input_tokens) +
        Number(usage.cache_read_input_tokens)
      : null,
    contextWindow: contextWindowFrom(sessionStats),
    cacheReadTokens: usage ? Number(usage.cache_read_input_tokens) : null,
    cacheWriteTokens: usage ? Number(usage.cache_creation_input_tokens) : null,
    elapsedMs: turn.duration_ms != null ? Number(turn.duration_ms) : null,
    completedAt: turn.completed_at ?? null,
    stopReason: null,
  };
}

/**
 * Conversation view backed by the unified, codeg-aligned timeline: persisted
 * transcript (re-parsed from the agent's session file) merged with the live
 * event stream, rendered turn-by-turn via {@link MessageTurnView}. This replaces
 * the legacy events -> NormalizedEntry transcript path for ACP agent sessions.
 *
 * Inline turn stats are intentionally absent — token/usage surfaces move out of
 * the timeline in the relocation phase. VibeX-authored.
 */
const AgentTimelineConversation = forwardRef<
  VirtualizedListRef,
  AgentTimelineConversationProps
>(function AgentTimelineConversation({ attempt, task, onAtBottomChange }, ref) {
  const agentWorkbench = useAgentWorkbench();
  const { config } = useUserSystem();
  const collapseProcess = config?.ai_message_default_collapsed ?? false;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const virtualListRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const isAtBottomRef = useRef(true);

  const sessionId = attempt.session?.id ?? null;
  const session = sessionId ? agentWorkbench.sessions[sessionId] : undefined;
  const events = useMemo(
    () => (sessionId ? (agentWorkbench.eventsByScope[sessionId] ?? []) : []),
    [sessionId, agentWorkbench.eventsByScope]
  );

  const { timeline, detailLoading, sessionStats } = useConversationRuntime({
    conversationId: sessionId,
    events,
  });

  // Model + live token usage for the streaming turn's inline stats.
  const agentModel = useMemo(
    () =>
      getAgentSessionModel(
        sessionId ? agentWorkbench.sessionConfigOptionsByScope[sessionId] : null
      ),
    [agentWorkbench.sessionConfigOptionsByScope, sessionId]
  );
  const liveStats = useMemo<TurnStatsData>(() => {
    const usage = sessionId ? agentWorkbench.usageByScope[sessionId] : undefined;
    const snapshot = usage ? agentUsageToSnapshot(usage) : null;
    return {
      model: agentModel ?? null,
      totalTokens: snapshot?.totalTokens ?? null,
      contextWindow: snapshot?.contextWindow ?? contextWindowFrom(sessionStats),
    };
  }, [agentModel, agentWorkbench.usageByScope, sessionId, sessionStats]);

  const pendingPermissions = useMemo(
    () =>
      pendingAgentPermissionsForSession(
        events,
        agentWorkbench.permissions,
        sessionId,
        session?.connection_id
      ),
    [agentWorkbench.permissions, events, session?.connection_id, sessionId]
  );
  const [respondingPermissionId, setRespondingPermissionId] = useState<
    string | null
  >(null);

  const navEntries = useMemo(() => buildTimelineNavEntries(timeline), [timeline]);
  const userMessageIndexes = useMemo(
    () =>
      timeline.flatMap((row, index) =>
        row.turn.role === 'user' ? [index] : []
      ),
    [timeline]
  );
  const activeNavEntry = useMemo(
    () => findActiveConversationMessageNavEntry(navEntries, activeIndex),
    [activeIndex, navEntries]
  );

  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: timeline.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    getItemKey: (index) => timeline[index]?.key ?? index,
    overscan: OVERSCAN,
    scrollMargin,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  const updateAtBottomState = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const next = isConversationNearBottom(container);
    if (isAtBottomRef.current === next) return;
    isAtBottomRef.current = next;
    onAtBottomChange?.(next);
  }, [onAtBottomChange]);

  const updateActiveIndex = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const next = findViewportAnchorVirtualIndex(
      rowVirtualizer.getVirtualItems(),
      container.scrollTop,
      container.clientHeight
    );
    setActiveIndex((current) => (current === next ? current : next));
  }, [rowVirtualizer]);

  const handleScroll = useCallback(() => {
    updateAtBottomState();
    updateActiveIndex();
  }, [updateActiveIndex, updateAtBottomState]);

  const detachFromBottom = useCallback(() => {
    if (!isAtBottomRef.current) return;
    isAtBottomRef.current = false;
    onAtBottomChange?.(false);
  }, [onAtBottomChange]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior) => {
      const container = containerRef.current;
      if (!container) return;
      if (timeline.length > 0) {
        rowVirtualizer.scrollToIndex(timeline.length - 1, {
          align: 'end',
          behavior,
        });
      } else {
        container.scrollTo({ top: container.scrollHeight, behavior });
      }
      isAtBottomRef.current = true;
      onAtBottomChange?.(true);
    },
    [onAtBottomChange, rowVirtualizer, timeline.length]
  );

  const scrollToIndex = useCallback(
    (index: number) => {
      if (index < 0 || index >= timeline.length) return;
      detachFromBottom();
      rowVirtualizer.scrollToIndex(index, { align: 'center', behavior: 'smooth' });
      setActiveIndex(index);
    },
    [detachFromBottom, rowVirtualizer, timeline.length]
  );

  const updateScrollMargin = useCallback(() => {
    const container = containerRef.current;
    const list = virtualListRef.current;
    if (!container || !list) return;
    const next = Math.max(
      0,
      list.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop
    );
    setScrollMargin((current) => (Math.abs(current - next) > 1 ? next : current));
  }, []);

  useLayoutEffect(() => {
    updateScrollMargin();
  }, [pendingPermissions.length, timeline.length, updateScrollMargin]);

  useLayoutEffect(() => {
    updateActiveIndex();
  }, [updateActiveIndex, virtualRows]);

  // Stick to the bottom as the conversation grows, unless the user scrolled up.
  useLayoutEffect(() => {
    if (timeline.length === 0) {
      updateAtBottomState();
      return;
    }
    if (isAtBottomRef.current) {
      scrollToBottom('auto');
    }
  }, [scrollToBottom, timeline.length, totalSize, updateAtBottomState]);

  const respondToPermission = useCallback(
    async (permission: PendingAgentPermission, optionId: string | null) => {
      setRespondingPermissionId(permission.request.id);
      try {
        await agentWorkbench.respondPermission({
          connectionId: permission.connectionId,
          permissionId: permission.request.id,
          response: optionId
            ? { kind: 'selected', option_id: optionId }
            : { kind: 'cancelled' },
        });
      } finally {
        setRespondingPermissionId((current) =>
          current === permission.request.id ? null : current
        );
      }
    },
    [agentWorkbench]
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom() {
        scrollToBottom('smooth');
      },
      scrollToIndex(index, options) {
        if (index < 0 || index >= timeline.length) return;
        if ((options?.behavior ?? 'smooth') === 'smooth') detachFromBottom();
        rowVirtualizer.scrollToIndex(index, {
          align: options?.align ?? 'center',
          behavior: options?.behavior ?? 'smooth',
        });
      },
      scrollToPreviousUserMessage() {
        const container = containerRef.current;
        if (!container) return;
        const anchor = findViewportAnchorVirtualIndex(
          rowVirtualizer.getVirtualItems(),
          container.scrollTop,
          container.clientHeight
        );
        const target = findPreviousUserMessageVirtualIndex(
          userMessageIndexes,
          anchor
        );
        if (target === null) return;
        detachFromBottom();
        rowVirtualizer.scrollToIndex(target, {
          align: 'center',
          behavior: 'smooth',
        });
      },
    }),
    [detachFromBottom, rowVirtualizer, scrollToBottom, timeline.length, userMessageIndexes]
  );

  useEffect(() => {
    isAtBottomRef.current = true;
    onAtBottomChange?.(true);
  }, [onAtBottomChange, sessionId]);

  // Inline turn stats after each assistant turn, in the same position as the
  // legacy path — re-sourced from the parsed MessageTurn / live usage.
  const renderTurnStats = useCallback(
    (row: ConversationTimelineTurn, index: number) => {
      if (row.turn.role !== 'assistant') return null;
      const jumpTarget = findPreviousUserMessageVirtualIndex(
        userMessageIndexes,
        index
      );
      const onJumpBack =
        jumpTarget === null
          ? null
          : () => {
              detachFromBottom();
              rowVirtualizer.scrollToIndex(jumpTarget, {
                align: 'center',
                behavior: 'smooth',
              });
            };
      const copyText = assistantCopyText(row.turn);
      return row.phase === 'streaming' ? (
        <LiveTurnStats
          stats={liveStats}
          startedAt={row.turn.timestamp}
          copyText={copyText}
          onJumpBack={onJumpBack}
        />
      ) : (
        <TurnStats
          stats={buildSettledTurnStats(row.turn, sessionStats)}
          copyText={copyText}
          onJumpBack={onJumpBack}
        />
      );
    },
    [
      detachFromBottom,
      liveStats,
      rowVirtualizer,
      sessionStats,
      userMessageIndexes,
    ]
  );

  // The Nth user turn maps to the Nth checkpoint ordinal (see G-R1).
  const userOrdinalByKey = useMemo(() => {
    const map = new Map<string, number>();
    let ordinal = 0;
    for (const row of timeline) {
      if (row.turn.role === 'user') {
        map.set(row.key, ordinal);
        ordinal += 1;
      }
    }
    return map;
  }, [timeline]);

  const handleRetry = useCallback(
    async (turn: MessageTurn, ordinal: number) => {
      const session = attempt.session;
      if (!session?.executor) return;
      const text = turn.blocks
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n\n');
      if (!text) return;
      const restoreFiles = window.confirm(
        '恢复工作区文件到本条消息发送前?\n\n确定 = 恢复文件并重发\n取消 = 仅重发(不改动文件)'
      );
      if (restoreFiles) {
        try {
          await agentsApi.resetToCheckpoint(session.id, ordinal, true, false);
        } catch (error) {
          // No checkpoint at this ordinal (e.g. a pre-feature turn) -> resend only.
          console.warn('checkpoint restore skipped', error);
        }
      }
      await sendAgentRuntimeTurn({
        workspaceId: attempt.id,
        sessionId: session.id,
        executorProfileId: {
          executor: session.executor as BaseCodingAgent,
          variant: null,
        },
        text,
      });
    },
    [attempt.id, attempt.session]
  );

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto px-2 py-3"
      data-panel="conversation-logs"
      onScroll={handleScroll}
    >
      {detailLoading && timeline.length === 0 ? (
        <div className="flex h-full min-h-[160px] items-center justify-center text-muted-foreground">
          <div className="flex items-center gap-2 rounded-full border bg-background/90 px-3 py-1.5 text-xs shadow-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading session...</span>
          </div>
        </div>
      ) : (
        <div className="mx-auto flex w-full max-w-6xl items-start gap-3">
          <div className="min-w-0 flex-1">
            <AgentPermissionPanel
              permissions={pendingPermissions}
              respondingPermissionId={respondingPermissionId}
              onRespond={respondToPermission}
            />
            <div
              ref={virtualListRef}
              className="relative w-full"
              style={{ height: `${totalSize}px` }}
            >
              {virtualRows.map((virtualRow) => {
                const row = timeline[virtualRow.index];
                if (!row) return null;
                return (
                  <div
                    key={virtualRow.key}
                    ref={rowVirtualizer.measureElement}
                    data-index={virtualRow.index}
                    className={cn(
                      'absolute left-0 top-0 w-full pb-3',
                      activeNavEntry?.index === virtualRow.index &&
                        'conv-message-nav-target-active'
                    )}
                    style={{
                      transform: getVirtualRowTranslateY(
                        virtualRow.start,
                        scrollMargin
                      ),
                    }}
                  >
                    <MessageTurnView
                      turn={row.turn}
                      attempt={attempt}
                      task={task}
                      onRetry={
                        row.turn.role === 'user'
                          ? () =>
                              void handleRetry(
                                row.turn,
                                userOrdinalByKey.get(row.key) ?? 0
                              )
                          : undefined
                      }
                      collapseProcess={collapseProcess}
                    />
                    {renderTurnStats(row, virtualRow.index)}
                  </div>
                );
              })}
            </div>
          </div>
          <ConversationMessageNav
            entries={navEntries}
            activeIndex={activeIndex}
            onSelect={scrollToIndex}
          />
        </div>
      )}
    </div>
  );
});

export default AgentTimelineConversation;
