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
import { ChevronDown, Loader2 } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  BaseCodingAgent,
  ExecutionProcessStatus,
  type ExecutorAction,
  type TaskWithAttemptStatus,
} from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import DisplayConversationEntry from '@/components/NormalizedConversation/DisplayConversationEntry';
import { AggregatedThinkingCard } from '@/components/NormalizedConversation/AggregatedThinkingCard';
import { AggregatedGroupCard } from '@/components/NormalizedConversation/AggregatedGroupCard';
import { AggregatedFileEditCard } from '@/components/NormalizedConversation/AggregatedFileEditCard';
import {
  ProcessChangeSummaryCard,
  type ProcessChangeItem,
} from '@/components/NormalizedConversation/ProcessChangeSummaryCard';
import { buildDisplayEntries } from '@/components/NormalizedConversation/conversation-entry-utils';
import { useExpandable } from '@/stores/useExpandableStore';
import { useExecutionProcessesContext } from '@/contexts/ExecutionProcessesContext';
import { useEntries } from '@/contexts/EntriesContext';
import { buildAgentTranscriptEntries } from '@/features/agents/transcript';
import { useAgentWorkbench } from '@/features/agents/useAgentWorkbench';
import type {
  AgentEventEnvelope,
  AgentPermissionRequest,
} from '@/features/agents/types';
import {
  AgentPermissionPanel,
  type PendingAgentPermission,
} from '@/components/agents/AgentPermissionPanel';
import { ConversationMessageNav } from '@/components/conversation-thread/ConversationMessageNav';
import { buildConversationMessageNavEntries } from '@/components/conversation-thread/messageNavEntries';
import { TurnStats } from '@/components/conversation-thread/TurnStats';
import { LiveTurnStats } from '@/components/conversation-thread/LiveTurnStats';
import {
  buildTurnStatsByAssistantKey,
  findLatestAssistantDisplayKey,
  type TurnStatsData,
} from '@/components/conversation-thread/turnStatsModel';
import { useConversationHistory } from '@/hooks/useConversationHistory/useConversationHistory';
import { agentUsageToSnapshot } from '@/hooks/useConversationHistory/conversationTokenUsage';
import type {
  AddEntryType,
  BaseDisplayEntry,
  DisplayEntry,
  PatchTypeWithKey,
} from '@/hooks/useConversationHistory/types';
import { isCollapsedAssistantMessagesGroup } from '@/hooks/useConversationHistory/types';
import type { AgentSessionConfigOption } from '@/features/agents/types';
import { useUserSystem } from '@/components/ConfigProvider';
import { buildSessionConversationKey } from '@/lib/conversationKeys';
import { cn } from '@/lib/utils';

export type VirtualizedListScrollOptions = {
  align?: 'start' | 'center' | 'end' | 'auto';
  behavior?: ScrollBehavior;
};

export interface VirtualizedListRef {
  scrollToPreviousUserMessage: () => void;
  scrollToBottom: () => void;
  scrollToIndex: (
    index: number,
    options?: VirtualizedListScrollOptions
  ) => void;
}

interface VirtualizedListProps {
  attempt: WorkspaceWithSession;
  task: TaskWithAttemptStatus | null;
  onAtBottomChange?: (isAtBottom: boolean) => void;
}

function isUserMessageEntry(
  entry: DisplayEntry | PatchTypeWithKey
): entry is PatchTypeWithKey & { type: 'NORMALIZED_ENTRY' } {
  return (
    entry.type === 'NORMALIZED_ENTRY' &&
    entry.content.entry_type.type === 'user_message'
  );
}

function isAssistantMessageEntry(
  entry: BaseDisplayEntry
): entry is PatchTypeWithKey & { type: 'NORMALIZED_ENTRY' } {
  return (
    entry.type === 'NORMALIZED_ENTRY' &&
    entry.content.entry_type.type === 'assistant_message'
  );
}

type ConversationScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

type VirtualItemPosition = {
  index: number;
  start: number;
};

const conversationScrollPositions = new Map<string, number>();
const MAX_CONVERSATION_SCROLL_POSITIONS = 50;
const BOTTOM_SCROLL_THRESHOLD_PX = 48;
const ESTIMATED_CONVERSATION_ROW_HEIGHT = 128;
const CONVERSATION_OVERSCAN_ROWS = 10;

function rememberConversationScrollPosition(key: string, scrollTop: number) {
  conversationScrollPositions.delete(key);
  conversationScrollPositions.set(key, scrollTop);

  while (conversationScrollPositions.size > MAX_CONVERSATION_SCROLL_POSITIONS) {
    const oldestKey = conversationScrollPositions.keys().next().value;
    if (!oldestKey) break;
    conversationScrollPositions.delete(oldestKey);
  }
}

export function findViewportAnchorVirtualIndex(
  virtualItems: VirtualItemPosition[],
  scrollTop: number,
  viewportHeight: number
): number | null {
  if (virtualItems.length === 0) {
    return null;
  }

  const anchor = scrollTop + Math.max(24, viewportHeight * 0.25);
  let anchorIndex = virtualItems[0]!.index;

  for (const item of virtualItems) {
    if (item.start > anchor) {
      break;
    }
    anchorIndex = item.index;
  }

  return anchorIndex;
}

export function findPreviousUserMessageVirtualIndex(
  userMessageIndexes: number[],
  anchorIndex: number | null
): number | null {
  if (userMessageIndexes.length === 0) {
    return null;
  }

  if (anchorIndex === null) {
    return userMessageIndexes[0]!;
  }

  for (let index = userMessageIndexes.length - 1; index >= 0; index -= 1) {
    const userMessageIndex = userMessageIndexes[index]!;
    if (userMessageIndex < anchorIndex) {
      return userMessageIndex;
    }
  }

  return userMessageIndexes[0]!;
}

export function getUserMessageDisplayIndexes(
  entries: DisplayEntry[]
): number[] {
  return entries.flatMap((entry, index) =>
    isUserMessageEntry(entry) ? [index] : []
  );
}

export function getDistanceFromConversationBottom({
  scrollHeight,
  scrollTop,
  clientHeight,
}: ConversationScrollMetrics): number {
  return scrollHeight - scrollTop - clientHeight;
}

export function getVirtualRowTranslateY(
  start: number,
  scrollMargin: number
): string {
  return `translateY(${start - scrollMargin}px)`;
}

export function isConversationNearBottom(
  metrics: ConversationScrollMetrics,
  thresholdPx = BOTTOM_SCROLL_THRESHOLD_PX
): boolean {
  return getDistanceFromConversationBottom(metrics) <= thresholdPx;
}

export function buildProcessChangeItems(
  entries: PatchTypeWithKey[]
): ProcessChangeItem[] {
  return entries.flatMap((entry) => {
    if (entry.type !== 'NORMALIZED_ENTRY') {
      return [];
    }

    const entryType = entry.content.entry_type;
    if (entryType.type !== 'tool_use') {
      return [];
    }

    const actionType = entryType.action_type;
    if (actionType.action !== 'file_edit') {
      return [];
    }

    return actionType.changes.map((change, index) => ({
      key: `${entry.patchKey}:${index}`,
      path: actionType.path,
      change,
    }));
  });
}

export function pendingAgentPermissionsFromEvents(
  events: AgentEventEnvelope[]
): PendingAgentPermission[] {
  const pending = new Map<string, PendingAgentPermission>();

  for (const envelope of events) {
    if (envelope.event.kind === 'permission_requested') {
      pending.set(envelope.event.request.id, {
        connectionId: envelope.connection_id,
        request: envelope.event.request,
      });
    }

    if (envelope.event.kind === 'permission_responded') {
      pending.delete(envelope.event.permission_id);
    }
  }

  return [...pending.values()];
}

export function pendingAgentPermissionsForSession(
  events: AgentEventEnvelope[],
  permissions: Record<string, AgentPermissionRequest>,
  sessionId: string | null,
  fallbackConnectionId?: string | null
): PendingAgentPermission[] {
  const pending = new Map(
    pendingAgentPermissionsFromEvents(events).map((permission) => [
      permission.request.id,
      permission,
    ])
  );

  if (!sessionId || !fallbackConnectionId) {
    return [...pending.values()];
  }

  for (const request of Object.values(permissions)) {
    if (request.session_id !== sessionId || pending.has(request.id)) continue;
    pending.set(request.id, {
      connectionId: fallbackConnectionId,
      request,
    });
  }

  return [...pending.values()];
}

export function getExecutorActionModel(
  executorAction?: ExecutorAction | null
): string | null {
  let action = executorAction ?? null;

  while (action) {
    if ('executor_profile_id' in action.typ) {
      const model = action.typ.executor_profile_id.model?.trim();
      if (model) return model;
    }

    action = action.next_action;
  }

  return null;
}

export function getAgentSessionModel(
  options?: AgentSessionConfigOption[] | null
): string | null {
  const modelOption = options?.find((option) => option.key === 'model');
  const modelValue = modelOption?.value;

  return typeof modelValue === 'string' && modelValue.trim()
    ? modelValue.trim()
    : null;
}

function mergeLiveTurnUsage(
  stats: TurnStatsData | null | undefined,
  usage: { used: number; limit?: number | null } | undefined,
  model: string | null
): TurnStatsData | null {
  const usageSnapshot = usage ? agentUsageToSnapshot(usage) : null;
  const nextStats: TurnStatsData = { ...(stats ?? {}) };

  if (model && !nextStats.model) {
    nextStats.model = model;
  }

  if (usageSnapshot) {
    nextStats.totalTokens = usageSnapshot.totalTokens;
    nextStats.contextWindow = usageSnapshot.contextWindow;
  }

  nextStats.completedAt = null;
  nextStats.elapsedMs = null;

  return Object.keys(nextStats).length > 0 ? nextStats : null;
}

export function collapsedAssistantMessagesLabel(hiddenCount: number): string {
  return `已折叠 ${hiddenCount} 条过程消息`;
}

const VirtualizedList = forwardRef<VirtualizedListRef, VirtualizedListProps>(
  function VirtualizedList({ attempt, task, onAtBottomChange }, ref) {
    const { entries, setEntries } = useEntries();
    const { executionProcessesVisible } = useExecutionProcessesContext();
    const agentWorkbench = useAgentWorkbench();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const virtualListRef = useRef<HTMLDivElement | null>(null);
    const [isLoadingEntries, setIsLoadingEntries] = useState(false);
    const [scrollMargin, setScrollMargin] = useState(0);
    const [activeVirtualIndex, setActiveVirtualIndex] = useState<number | null>(
      null
    );
    const conversationScrollKey = buildSessionConversationKey(
      attempt.id,
      attempt.session?.id
    );
    const restoredScrollRef = useRef<string | null>(null);
    const isAtBottomRef = useRef(true);
    const stickToBottomFrameRef = useRef<number | null>(null);
    const { config } = useUserSystem();

    const updateAtBottomState = useCallback(() => {
      const container = containerRef.current;
      if (!container) return;

      const nextIsAtBottom = isConversationNearBottom(container);
      if (isAtBottomRef.current === nextIsAtBottom) return;

      isAtBottomRef.current = nextIsAtBottom;
      onAtBottomChange?.(nextIsAtBottom);
    }, [onAtBottomChange]);

    const saveScrollPosition = useCallback(() => {
      const container = containerRef.current;
      if (!container) return;
      rememberConversationScrollPosition(
        conversationScrollKey,
        container.scrollTop
      );
      updateAtBottomState();
    }, [conversationScrollKey, updateAtBottomState]);

    const handleEntriesUpdated = useCallback(
      (
        newEntries: PatchTypeWithKey[],
        _addType: AddEntryType,
        _loading: boolean
      ) => {
        setIsLoadingEntries(_loading);
        setEntries(newEntries);
      },
      [setEntries]
    );

    useConversationHistory({
      attempt,
      onEntriesUpdated: handleEntriesUpdated,
    });

    const agentSessionId = attempt.session?.id ?? null;
    const agentSession = agentSessionId
      ? agentWorkbench.sessions[agentSessionId]
      : undefined;
    const agentSessionEvents = useMemo(
      () =>
        agentSessionId
          ? (agentWorkbench.eventsByScope[agentSessionId] ?? [])
          : [],
      [agentSessionId, agentWorkbench.eventsByScope]
    );
    const agentTranscriptEntries = useMemo(
      () => buildAgentTranscriptEntries(agentSessionEvents),
      [agentSessionEvents]
    );
    const pendingPermissions = useMemo(
      () =>
        pendingAgentPermissionsForSession(
          agentSessionEvents,
          agentWorkbench.permissions,
          agentSessionId,
          agentSession?.connection_id
        ),
      [
        agentSession?.connection_id,
        agentSessionEvents,
        agentSessionId,
        agentWorkbench.permissions,
      ]
    );
    const agentModel = useMemo(
      () =>
        getAgentSessionModel(
          agentSessionId
            ? agentWorkbench.sessionConfigOptionsByScope[agentSessionId]
            : null
        ),
      [agentSessionId, agentWorkbench.sessionConfigOptionsByScope]
    );
    const [respondingPermissionId, setRespondingPermissionId] = useState<
      string | null
    >(null);
    // Render the ACP transcript whenever this session has agent events, not only
    // once its session_created snapshot has landed in the store. For a freshly
    // created session the prompt events can arrive before (or without) the
    // snapshot; keying solely on `agentSession` would fall back to the empty DB
    // history and show no output. Legacy (non-ACP) sessions have no agent events,
    // so they still use the DB history path.
    const usesAgentTranscript =
      Boolean(agentSession) || agentSessionEvents.length > 0;

    useEffect(() => {
      if (!usesAgentTranscript) return;
      setEntries(agentTranscriptEntries);
      setIsLoadingEntries(
        agentWorkbench.loadState === 'loading' &&
          agentTranscriptEntries.length === 0
      );
    }, [
      agentTranscriptEntries,
      agentWorkbench.loadState,
      setEntries,
      usesAgentTranscript,
    ]);

    const normalizedEntries = useMemo(
      () =>
        (usesAgentTranscript ? agentTranscriptEntries : entries).filter(
          (entry): entry is PatchTypeWithKey & { type: 'NORMALIZED_ENTRY' } =>
            entry.type === 'NORMALIZED_ENTRY'
        ),
      [agentTranscriptEntries, entries, usesAgentTranscript]
    );

    const displayEntries = useMemo<DisplayEntry[]>(() => {
      const completedExecutionProcessIds = usesAgentTranscript
        ? new Set<string>()
        : new Set(
            executionProcessesVisible
              .filter(
                (process) => process.status !== ExecutionProcessStatus.running
              )
              .map((process) => process.id)
          );

      return buildDisplayEntries(normalizedEntries, {
        aggregateThinking: attempt.session?.executor === BaseCodingAgent.CODEX,
        completedExecutionProcessIds,
        collapseAiMessagesByDefault:
          config?.ai_message_default_collapsed ?? false,
      });
    }, [
      attempt.session?.executor,
      usesAgentTranscript,
      config?.ai_message_default_collapsed,
      executionProcessesVisible,
      normalizedEntries,
    ]);
    const userMessageDisplayIndexes = useMemo(
      () => getUserMessageDisplayIndexes(displayEntries),
      [displayEntries]
    );
    const modelByExecutionProcessId = useMemo(() => {
      const modelById: Record<string, string> = {};

      for (const process of executionProcessesVisible) {
        const model = getExecutorActionModel(process.executor_action);
        if (model) {
          modelById[process.id] = model;
        }
      }

      if (agentModel) {
        if (agentSessionId) {
          modelById[agentSessionId] = agentModel;
        }
        if (agentSession?.connection_id) {
          modelById[agentSession.connection_id] = agentModel;
        }
      }

      return modelById;
    }, [
      agentModel,
      agentSession?.connection_id,
      agentSessionId,
      executionProcessesVisible,
    ]);
    const turnStatsByAssistantKey = useMemo(
      () =>
        buildTurnStatsByAssistantKey(normalizedEntries, {
          modelByExecutionProcessId,
        }),
      [modelByExecutionProcessId, normalizedEntries]
    );
    const hasLiveTurn = usesAgentTranscript
      ? agentSession?.status === 'running'
      : executionProcessesVisible.some(
          (process) => process.status === ExecutionProcessStatus.running
        );
    const liveAssistantKey = useMemo(
      () => (hasLiveTurn ? findLatestAssistantDisplayKey(displayEntries) : null),
      [displayEntries, hasLiveTurn]
    );
    const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
      count: displayEntries.length,
      getScrollElement: () => containerRef.current,
      estimateSize: () => ESTIMATED_CONVERSATION_ROW_HEIGHT,
      getItemKey: (index) => displayEntries[index]?.patchKey ?? index,
      overscan: CONVERSATION_OVERSCAN_ROWS,
      scrollMargin,
    });
    const virtualRows = rowVirtualizer.getVirtualItems();
    const virtualTotalSize = rowVirtualizer.getTotalSize();
    const messageNavEntries = useMemo(
      () => buildConversationMessageNavEntries(displayEntries),
      [displayEntries]
    );

    const updateActiveVirtualIndex = useCallback(() => {
      const container = containerRef.current;
      if (!container) return;

      const nextActiveIndex = findViewportAnchorVirtualIndex(
        rowVirtualizer.getVirtualItems(),
        container.scrollTop,
        container.clientHeight
      );
      setActiveVirtualIndex((current) =>
        current === nextActiveIndex ? current : nextActiveIndex
      );
    }, [rowVirtualizer]);

    const handleScroll = useCallback(() => {
      saveScrollPosition();
      updateActiveVirtualIndex();
    }, [saveScrollPosition, updateActiveVirtualIndex]);

    const cancelStickToBottomCorrection = useCallback(() => {
      if (
        typeof window !== 'undefined' &&
        stickToBottomFrameRef.current !== null
      ) {
        window.cancelAnimationFrame(stickToBottomFrameRef.current);
        stickToBottomFrameRef.current = null;
      }
    }, []);

    const detachFromBottomForNavigation = useCallback(() => {
      cancelStickToBottomCorrection();
      if (!isAtBottomRef.current) return;
      isAtBottomRef.current = false;
      onAtBottomChange?.(false);
    }, [cancelStickToBottomCorrection, onAtBottomChange]);

    const scrollToMessageNavIndex = useCallback(
      (index: number) => {
        if (index < 0 || index >= displayEntries.length) return;
        detachFromBottomForNavigation();
        rowVirtualizer.scrollToIndex(index, {
          align: 'center',
          behavior: 'smooth',
        });
        setActiveVirtualIndex(index);
      },
      [detachFromBottomForNavigation, displayEntries.length, rowVirtualizer]
    );

    const scrollContainerToBottom = useCallback(
      (behavior: ScrollBehavior) => {
        const container = containerRef.current;
        if (!container) return;

        if (displayEntries.length > 0) {
          rowVirtualizer.scrollToIndex(displayEntries.length - 1, {
            align: 'end',
            behavior,
          });
        } else {
          container.scrollTo({
            top: container.scrollHeight,
            behavior,
          });
        }

        isAtBottomRef.current = true;
        onAtBottomChange?.(true);
      },
      [displayEntries.length, onAtBottomChange, rowVirtualizer]
    );

    const scheduleStickToBottomCorrection = useCallback(() => {
      if (typeof window === 'undefined') return;

      cancelStickToBottomCorrection();

      stickToBottomFrameRef.current = window.requestAnimationFrame(() => {
        stickToBottomFrameRef.current = null;
        if (!isAtBottomRef.current) return;

        scrollContainerToBottom('auto');
        updateAtBottomState();
      });
    }, [
      cancelStickToBottomCorrection,
      scrollContainerToBottom,
      updateAtBottomState,
    ]);

    const updateVirtualScrollMargin = useCallback(() => {
      const container = containerRef.current;
      const virtualList = virtualListRef.current;
      if (!container || !virtualList) return;

      const containerRect = container.getBoundingClientRect();
      const virtualListRect = virtualList.getBoundingClientRect();
      const nextScrollMargin = Math.max(
        0,
        virtualListRect.top - containerRect.top + container.scrollTop
      );

      setScrollMargin((current) =>
        Math.abs(current - nextScrollMargin) > 1 ? nextScrollMargin : current
      );
    }, []);

    const renderBaseDisplayEntry = useCallback(
      (entry: BaseDisplayEntry, displayIndex: number | null = null) => {
        if (entry.type === 'AGGREGATED_GROUP') {
          return (
            <AggregatedGroupCard
              entries={entry.entries}
              aggregationType={entry.aggregationType}
              attempt={attempt}
              task={task ?? undefined}
            />
          );
        }

        if (entry.type === 'AGGREGATED_THINKING_GROUP') {
          const isStreamingThinking =
            hasLiveTurn &&
            displayIndex !== null &&
            displayIndex >= displayEntries.length - 2;

          return (
            <AggregatedThinkingCard
              entries={entry.entries}
              expansionKey={entry.patchKey}
              isStreaming={isStreamingThinking}
            />
          );
        }

        if (entry.type === 'AGGREGATED_FILE_EDIT_GROUP') {
          return (
            <AggregatedFileEditCard
              entries={entry.entries}
              attempt={attempt}
              task={task ?? undefined}
            />
          );
        }

        if (entry.type === 'PROCESS_CHANGE_SUMMARY') {
          return (
            <ProcessChangeSummaryCard
              executionProcessId={entry.executionProcessId}
              attempt={attempt}
              changes={buildProcessChangeItems(entry.entries)}
            />
          );
        }

        if (entry.type === 'NORMALIZED_ENTRY') {
          const renderedEntry = (
            <DisplayConversationEntry
              entry={entry.content}
              expansionKey={entry.patchKey}
              executionProcessId={entry.executionProcessId}
              taskAttempt={attempt}
              task={task ?? undefined}
            />
          );

          if (!isAssistantMessageEntry(entry)) {
            return renderedEntry;
          }

          const isLive = liveAssistantKey === entry.patchKey;
          const baseStats = turnStatsByAssistantKey.get(entry.patchKey);
          const liveUsage = usesAgentTranscript
            ? agentWorkbench.usageByScope[entry.executionProcessId]
            : undefined;
          const stats = isLive
            ? mergeLiveTurnUsage(baseStats, liveUsage, agentModel)
            : baseStats;
          const jumpTargetIndex =
            displayIndex === null
              ? null
              : findPreviousUserMessageVirtualIndex(
                  userMessageDisplayIndexes,
                  displayIndex
                );
          const onJumpBack =
            jumpTargetIndex === null
              ? null
              : () => {
                  detachFromBottomForNavigation();
                  rowVirtualizer.scrollToIndex(jumpTargetIndex, {
                    align: 'center',
                    behavior: 'smooth',
                  });
                };

          return (
            <>
              {renderedEntry}
              {isLive ? (
                <LiveTurnStats
                  stats={stats}
                  startedAt={stats?.startedAt ?? entry.content.timestamp}
                  copyText={entry.content.content}
                  onJumpBack={onJumpBack}
                />
              ) : (
                <TurnStats
                  stats={stats}
                  copyText={entry.content.content}
                  onJumpBack={onJumpBack}
                />
              )}
            </>
          );
        }

        return null;
      },
      [
        agentModel,
        agentWorkbench.usageByScope,
        attempt,
        detachFromBottomForNavigation,
        displayEntries.length,
        hasLiveTurn,
        liveAssistantKey,
        rowVirtualizer,
        task,
        turnStatsByAssistantKey,
        userMessageDisplayIndexes,
        usesAgentTranscript,
      ]
    );

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

    useLayoutEffect(() => {
      if (restoredScrollRef.current === conversationScrollKey) return;

      isAtBottomRef.current = true;
      onAtBottomChange?.(true);

      if (displayEntries.length === 0) return;

      const container = containerRef.current;
      const scrollTop = conversationScrollPositions.get(conversationScrollKey);
      if (!container || typeof scrollTop !== 'number') {
        restoredScrollRef.current = conversationScrollKey;
        return;
      }

      container.scrollTop = scrollTop;
      restoredScrollRef.current = conversationScrollKey;
      updateAtBottomState();
    }, [
      conversationScrollKey,
      displayEntries.length,
      onAtBottomChange,
      updateAtBottomState,
    ]);

    useLayoutEffect(() => {
      updateVirtualScrollMargin();
    }, [
      displayEntries.length,
      pendingPermissions.length,
      updateVirtualScrollMargin,
    ]);

    useLayoutEffect(() => {
      updateActiveVirtualIndex();
    }, [updateActiveVirtualIndex, virtualRows]);

    useLayoutEffect(() => {
      if (displayEntries.length === 0) {
        updateAtBottomState();
        return;
      }

      if (isAtBottomRef.current) {
        scrollContainerToBottom('auto');
        scheduleStickToBottomCorrection();
        return;
      }

      updateAtBottomState();
    }, [
      displayEntries.length,
      scrollContainerToBottom,
      scheduleStickToBottomCorrection,
      updateAtBottomState,
      virtualTotalSize,
    ]);

    useEffect(() => {
      return () => {
        cancelStickToBottomCorrection();
        saveScrollPosition();
      };
    }, [cancelStickToBottomCorrection, saveScrollPosition]);

    useImperativeHandle(
      ref,
      () => ({
        scrollToBottom() {
          scrollContainerToBottom('smooth');
        },
        scrollToIndex(index, options) {
          if (index < 0 || index >= displayEntries.length) return;
          if ((options?.behavior ?? 'smooth') === 'smooth') {
            detachFromBottomForNavigation();
          }
          rowVirtualizer.scrollToIndex(index, {
            align: options?.align ?? 'center',
            behavior: options?.behavior ?? 'smooth',
          });
        },
        scrollToPreviousUserMessage() {
          const container = containerRef.current;
          if (!container) return;

          const anchorIndex = findViewportAnchorVirtualIndex(
            rowVirtualizer.getVirtualItems(),
            container.scrollTop,
            container.clientHeight
          );
          const targetIndex = findPreviousUserMessageVirtualIndex(
            userMessageDisplayIndexes,
            anchorIndex
          );

          if (targetIndex === null) return;

          detachFromBottomForNavigation();
          rowVirtualizer.scrollToIndex(targetIndex, {
            align: 'center',
            behavior: 'smooth',
          });
        },
      }),
      [
        displayEntries.length,
        detachFromBottomForNavigation,
        rowVirtualizer,
        scrollContainerToBottom,
        userMessageDisplayIndexes,
      ]
    );

    return (
      <div
        ref={containerRef}
        className="h-full overflow-y-auto px-2 py-3"
        data-panel="conversation-logs"
        onScroll={handleScroll}
      >
        {isLoadingEntries && displayEntries.length === 0 ? (
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
                style={{ height: `${virtualTotalSize}px` }}
              >
                {virtualRows.map((virtualRow) => {
                  const entry = displayEntries[virtualRow.index];
                  if (!entry) return null;

                  return (
                    <div
                      key={virtualRow.key}
                      ref={rowVirtualizer.measureElement}
                      data-index={virtualRow.index}
                      className="absolute left-0 top-0 w-full pb-3"
                      style={{
                        transform: getVirtualRowTranslateY(
                          virtualRow.start,
                          scrollMargin
                        ),
                      }}
                    >
                      {isCollapsedAssistantMessagesGroup(entry) ? (
                        <CollapsedAssistantMessagesBlock
                          hiddenCount={entry.hiddenCount}
                          entries={entry.entries}
                          renderEntry={renderBaseDisplayEntry}
                        />
                      ) : null}
                      {!isCollapsedAssistantMessagesGroup(entry)
                        ? renderBaseDisplayEntry(entry, virtualRow.index)
                        : null}
                    </div>
                  );
                })}
              </div>
            </div>
            <ConversationMessageNav
              entries={messageNavEntries}
              activeIndex={activeVirtualIndex}
              onSelect={scrollToMessageNavIndex}
            />
          </div>
        )}
      </div>
    );
  }
);

function CollapsedAssistantMessagesBlock({
  hiddenCount,
  entries,
  renderEntry,
}: {
  hiddenCount: number;
  entries: BaseDisplayEntry[];
  renderEntry: (entry: BaseDisplayEntry) => JSX.Element | null;
}) {
  // Keyed store state survives row unmount/remount during virtual scrolling;
  // local useState would reset the collapse every time the row leaves the window.
  const [expanded, toggle] = useExpandable(
    `collapsed-assistant:${entries[0]?.patchKey ?? ''}`,
    false
  );

  return (
    <div className="conv-entry-item px-4 py-1">
      <button
        type="button"
        onClick={() => toggle()}
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
        aria-expanded={expanded}
      >
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 text-muted-foreground transition-transform',
            expanded ? '' : '-rotate-90'
          )}
        />
        <span>{collapsedAssistantMessagesLabel(hiddenCount)}</span>
      </button>
      {expanded
        ? entries.map((entry) => (
            <div key={entry.patchKey}>{renderEntry(entry)}</div>
          ))
        : null}
    </div>
  );
}

export default VirtualizedList;
