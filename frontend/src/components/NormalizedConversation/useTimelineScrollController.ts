import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
  type RefObject,
  type UIEvent,
} from 'react';
import { elementScroll, useVirtualizer } from '@tanstack/react-virtual';
import type { ContextCompactPresentation } from '@/components/NormalizedConversation/MessageTurnView';
import { isGoalToolUse } from '@/components/NormalizedConversation/tools/GoalToolCall';
import type {
  ConversationTimelineItem,
  ConversationTimelineTurn,
} from '@/features/conversation/conversationStore';
import { computeAnchoredTimelineStartIndex } from '@/features/conversation/timelinePaging';
import { findInConversationTimeline } from '@/lib/conversationFind';
import {
  CONVERSATION_SCROLL_TO_GOAL_EVENT,
  CONVERSATION_SCROLL_TO_QUOTE_EVENT,
  CONVERSATION_SCROLL_TO_TURN_EVENT,
  consumePendingConversationJump,
  pulseQuoteTargetElement,
  type ConversationScrollToGoalDetail,
  type ConversationScrollToQuoteDetail,
  type ConversationScrollToTurnDetail,
} from '@/lib/conversationScroll';
import { bindConversationSummaryMarquee } from '@/components/logs/conversationSummaryMarquee';
import { buildTimelineVirtualEntries } from '@/components/logs/assistantVirtualSlices';
import {
  CONVERSATION_OPEN_SETTLE_PASSES,
  ESTIMATED_CONVERSATION_ROW_HEIGHT,
  cancelVirtualizerFollowScroll,
  conversationFollowIntent,
  conversationTailFollowAction,
  findPreviousUserMessageVirtualIndex,
  findViewportAnchorVirtualIndex,
  isConversationNearBottom,
  measureScrollMargin,
  measureUnscaledBlockHeight,
  observeUnscaledElementRect,
  scheduleMeasuredScrollToIndex,
  scrollTopAfterPrepend,
  startAlignedVirtualOffset,
  type VirtualizedListRef,
} from '@/components/logs/VirtualizedList';
import {
  getExpandableRevision,
  isExpandableOpen,
  useProcessExpandableRevision,
} from '@/stores/useExpandableStore';
import {
  findActiveConversationMessageNavEntry,
  type ConversationMessageNavEntry,
} from './thread/messageNavEntries';
import {
  shouldLoadOlderTimelinePage,
  timelineItemAsMessage,
  turnCopyText,
  vibexTurnIdFromTimelineRowId,
} from './timelineMemoHelpers';

const OVERSCAN = 10;

export function useTimelineScrollController({
  ref,
  panelRef,
  sessionId,
  timeline,
  timelineItems,
  navEntries,
  sideRowsLength,
  hasEarlier,
  loadOlder,
  olderTurnsPrependEpoch,
  collapseProcess,
  hideThinking,
  contextCompactByRowKey,
  scrollBehavior,
  onAtBottomChange,
}: {
  ref: ForwardedRef<VirtualizedListRef>;
  panelRef: RefObject<HTMLDivElement | null>;
  sessionId: string | null;
  timeline: ConversationTimelineTurn[];
  timelineItems: ConversationTimelineItem[];
  navEntries: ConversationMessageNavEntry[];
  sideRowsLength: number;
  hasEarlier: boolean;
  loadOlder: () => Promise<void>;
  olderTurnsPrependEpoch: number;
  collapseProcess: boolean;
  hideThinking: boolean;
  contextCompactByRowKey: Map<string, ContextCompactPresentation | null>;
  scrollBehavior: ScrollBehavior;
  onAtBottomChange?: (isAtBottom: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const virtualListRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const isAtBottomRef = useRef(true);
  const openSettlePassesRef = useRef(CONVERSATION_OPEN_SETTLE_PASSES);
  const [, setIsFollowingTail] = useState(true);
  const followTailRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const programmaticScrollDepthRef = useRef(0);
  const smoothFollowRef = useRef(false);
  const seenExpansionRef = useRef<number | null>(null);
  const expansionInViewRef = useRef(false);

  const sessionPinRef = useRef<string | null>(null);
  const pinnedSessionReadyRef = useRef<string | null>(null);
  const anchoredTimelineStartRef = useRef<{
    sessionId: string | null;
    index: number | null;
  }>({ sessionId: null, index: null });
  const previousPrependEpochRef = useRef(0);
  const previousTotalSizeRef = useRef(0);
  const pendingJumpTimelineIndexRef = useRef<{
    index: number;
    align: 'start' | 'center' | 'end' | 'auto';
  } | null>(null);
  const [visibleTailSession, setVisibleTailSession] = useState<{
    sessionId: string | null;
    count: number;
    revealEpoch: number;
  }>(() => ({
    sessionId,
    count: 24,
    revealEpoch: 0,
  }));

  const effectiveVisibleTailCount =
    visibleTailSession.sessionId === sessionId ? visibleTailSession.count : 24;
  const effectiveRevealEpoch =
    visibleTailSession.sessionId === sessionId
      ? visibleTailSession.revealEpoch
      : 0;
  const effectiveFollowTail =
    anchoredTimelineStartRef.current.sessionId !== sessionId
      ? true
      : followTailRef.current;
  const priorAnchoredStartIndex =
    anchoredTimelineStartRef.current.sessionId === sessionId
      ? anchoredTimelineStartRef.current.index
      : null;
  const visibleTimelineStartIndex = computeAnchoredTimelineStartIndex({
    totalItems: timelineItems.length,
    visibleTailCount: effectiveVisibleTailCount,
    followTail: effectiveFollowTail,
    anchoredStartIndex: priorAnchoredStartIndex,
  });
  anchoredTimelineStartRef.current = {
    sessionId,
    index: visibleTimelineStartIndex,
  };
  const hasHiddenEarlierItems = visibleTimelineStartIndex > 0;
  const visibleTimelineItems = useMemo(
    () =>
      visibleTimelineStartIndex > 0
        ? timelineItems.slice(visibleTimelineStartIndex)
        : timelineItems,
    [timelineItems, visibleTimelineStartIndex]
  );

  // Only `process:*` fold keys alter virtual row slicing; non-process card
  // expansions are measured by TanStack Virtual and checked via getExpandableRevision().
  const processExpandableRevision = useProcessExpandableRevision();
  const virtualEntries = useMemo(() => {
    void processExpandableRevision;
    return buildTimelineVirtualEntries({
      items: visibleTimelineItems,
      collapseProcess,
      hideThinking,
      processExpanded: (turnId, foldStartIndex) =>
        isExpandableOpen(`process:${turnId}:${foldStartIndex}`),
      isContextCompact: (rowKey) => contextCompactByRowKey.has(rowKey),
    });
  }, [
    collapseProcess,
    contextCompactByRowKey,
    hideThinking,
    processExpandableRevision,
    visibleTimelineItems,
  ]);

  const userMessageIndexes = useMemo(
    () =>
      virtualEntries.flatMap((entry, index) => {
        const item = visibleTimelineItems[entry.timelineIndex];
        return timelineItemAsMessage(item)?.turn.role === 'user' ? [index] : [];
      }),
    [visibleTimelineItems, virtualEntries]
  );
  const activeNavEntry = useMemo(
    () => findActiveConversationMessageNavEntry(navEntries, activeIndex),
    [activeIndex, navEntries]
  );

  const runProgrammaticScroll = useCallback((action: () => void) => {
    programmaticScrollDepthRef.current += 1;
    try {
      action();
    } finally {
      const release = () => {
        programmaticScrollDepthRef.current = Math.max(
          0,
          programmaticScrollDepthRef.current - 1
        );
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          queueMicrotask(release);
        });
      } else {
        queueMicrotask(release);
      }
    }
  }, []);

  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: virtualEntries.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ESTIMATED_CONVERSATION_ROW_HEIGHT,
    getItemKey: (index) => virtualEntries[index]?.key ?? index,
    overscan: OVERSCAN,
    scrollMargin,
    observeElementRect: observeUnscaledElementRect,
    measureElement: measureUnscaledBlockHeight,
    scrollToFn: (offset, options, instance) => {
      runProgrammaticScroll(() => {
        elementScroll(offset, options, instance);
      });
    },
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  const jumpToVirtualIndex = useCallback(
    (index: number, align: 'start' | 'center' | 'end' | 'auto' = 'start') => {
      if (index < 0 || index >= virtualEntries.length) return;
      const jump = () => {
        if (align === 'start') {
          const start = rowVirtualizer.measurementsCache[index]?.start;
          if (typeof start === 'number') {
            rowVirtualizer.scrollToOffset(startAlignedVirtualOffset(start), {
              align: 'start',
              behavior: 'auto',
            });
            return;
          }
        }
        rowVirtualizer.scrollToIndex(index, {
          align,
          behavior: 'auto',
        });
      };
      scheduleMeasuredScrollToIndex(jump, index);
    },
    [rowVirtualizer, virtualEntries.length]
  );

  const hasEarlierTimeline = hasHiddenEarlierItems || hasEarlier;
  const loadEarlierTimeline = useCallback(() => {
    if (hasHiddenEarlierItems) {
      setVisibleTailSession((current) => {
        const baseCount = current.sessionId === sessionId ? current.count : 24;
        const currentlyVisibleCount = Math.max(
          baseCount,
          timelineItems.length - visibleTimelineStartIndex
        );
        const baseEpoch =
          current.sessionId === sessionId ? current.revealEpoch : 0;
        return {
          sessionId,
          count: Math.min(timelineItems.length, currentlyVisibleCount + 24),
          revealEpoch: baseEpoch + 1,
        };
      });
      return;
    }
    setVisibleTailSession((current) => {
      const baseEpoch =
        current.sessionId === sessionId ? current.revealEpoch : 0;
      return {
        sessionId,
        count: timelineItems.length + 24,
        revealEpoch: baseEpoch,
      };
    });
    void loadOlder();
  }, [
    hasHiddenEarlierItems,
    loadOlder,
    sessionId,
    timelineItems.length,
    visibleTimelineStartIndex,
  ]);

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatchIndex, setFindMatchIndex] = useState(0);
  const findMatches = useMemo(
    () => (findOpen ? findInConversationTimeline(timeline, findQuery) : []),
    [findOpen, findQuery, timeline]
  );
  const currentFindMatch = findMatches[findMatchIndex] ?? null;

  const detachFromBottom = useCallback(() => {
    cancelVirtualizerFollowScroll(rowVirtualizer);
    const container = containerRef.current;
    if (container && smoothFollowRef.current) {
      smoothFollowRef.current = false;
      runProgrammaticScroll(() => {
        container.scrollTo({ top: container.scrollTop, behavior: 'auto' });
      });
    }
    followTailRef.current = false;
    setIsFollowingTail(false);
    openSettlePassesRef.current = 0;
    if (!isAtBottomRef.current) return;
    isAtBottomRef.current = false;
    onAtBottomChange?.(false);
  }, [onAtBottomChange, rowVirtualizer, runProgrammaticScroll]);

  const handleJumpToVirtualIndex = useCallback(
    (targetIndex: number) => {
      detachFromBottom();
      jumpToVirtualIndex(targetIndex, 'center');
    },
    [detachFromBottom, jumpToVirtualIndex]
  );

  const scrollToTimelineIndexWithAlign = useCallback(
    (
      index: number,
      align: 'start' | 'center' | 'end' | 'auto' = 'start',
      shouldDetach = true
    ) => {
      if (index < 0 || index >= timelineItems.length) return;
      if (shouldDetach) {
        detachFromBottom();
      }
      if (index < visibleTimelineStartIndex) {
        pendingJumpTimelineIndexRef.current = { index, align };
        setVisibleTailSession((current) => {
          const baseEpoch =
            current.sessionId === sessionId ? current.revealEpoch : 0;
          return {
            sessionId,
            count: Math.min(
              timelineItems.length,
              timelineItems.length - index + 24
            ),
            revealEpoch: baseEpoch + 1,
          };
        });
        return;
      }
      const localIndex = index - visibleTimelineStartIndex;
      const virtualIndex = virtualEntries.findIndex(
        (entry) => entry.timelineIndex === localIndex
      );
      if (virtualIndex < 0) return;
      jumpToVirtualIndex(virtualIndex, align);
    },
    [
      detachFromBottom,
      jumpToVirtualIndex,
      sessionId,
      timelineItems.length,
      virtualEntries,
      visibleTimelineStartIndex,
    ]
  );

  const scrollToFindMatch = useCallback(
    (matchIndex: number) => {
      const match = findMatches[matchIndex];
      if (!match) return;
      const key = timeline[match.rowIndex]?.key;
      if (!key) return;
      const targetTimelineIndex = timelineItems.findIndex(
        (item) => item.kind === 'message' && item.item.key === key
      );
      if (targetTimelineIndex < 0) return;
      scrollToTimelineIndexWithAlign(targetTimelineIndex, 'center', true);
    },
    [findMatches, scrollToTimelineIndexWithAlign, timeline, timelineItems]
  );

  const goToFindMatch = useCallback(
    (direction: 1 | -1) => {
      if (findMatches.length === 0) return;
      setFindMatchIndex((current) => {
        const next =
          (current + direction + findMatches.length) % findMatches.length;
        queueMicrotask(() => scrollToFindMatch(next));
        return next;
      });
    },
    [findMatches.length, scrollToFindMatch]
  );

  useEffect(() => {
    setFindMatchIndex(0);
  }, [findQuery]);

  useEffect(() => {
    setFindOpen(false);
    setFindQuery('');
    setFindMatchIndex(0);
    followTailRef.current = true;
    setIsFollowingTail(true);
    pendingJumpTimelineIndexRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isFind =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f';
      if (!isFind) return;
      const panel = panelRef.current;
      if (!panel?.contains(document.activeElement)) return;
      event.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [panelRef]);

  const updateAtBottomState = useCallback(() => {
    if (!followTailRef.current) return;
    if (openSettlePassesRef.current > 0) return;
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
    const anchor = findViewportAnchorVirtualIndex(
      rowVirtualizer.getVirtualItems(),
      container.scrollTop,
      container.clientHeight
    );
    const localTimelineIndex =
      anchor == null ? null : (virtualEntries[anchor]?.timelineIndex ?? null);
    const next =
      localTimelineIndex == null
        ? null
        : localTimelineIndex + visibleTimelineStartIndex;
    setActiveIndex((current) => (current === next ? current : next));
  }, [rowVirtualizer, virtualEntries, visibleTimelineStartIndex]);

  const pinToBottom = useCallback(
    (behavior: ScrollBehavior) => {
      const container = containerRef.current;
      if (!container) return;
      smoothFollowRef.current = behavior === 'smooth';
      cancelVirtualizerFollowScroll(rowVirtualizer);
      runProgrammaticScroll(() => {
        if (behavior === 'smooth') {
          container.scrollTo({ top: container.scrollHeight, behavior });
        } else {
          if (virtualEntries.length > 0) {
            rowVirtualizer.scrollToIndex(virtualEntries.length - 1, {
              align: 'end',
              behavior: 'auto',
            });
          }
          container.scrollTop = container.scrollHeight;
        }
      });
      lastScrollTopRef.current = container.scrollTop;
      if (
        behavior !== 'smooth' &&
        typeof requestAnimationFrame === 'function'
      ) {
        requestAnimationFrame(() => {
          const currentContainer = containerRef.current;
          if (!currentContainer || !followTailRef.current) return;
          runProgrammaticScroll(() => {
            currentContainer.scrollTop = currentContainer.scrollHeight;
          });
          lastScrollTopRef.current = currentContainer.scrollTop;
        });
      }
    },
    [rowVirtualizer, runProgrammaticScroll, virtualEntries.length]
  );

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior) => {
      followTailRef.current = true;
      setIsFollowingTail(true);
      openSettlePassesRef.current = 0;
      isAtBottomRef.current = true;
      onAtBottomChange?.(true);
      pinToBottom(behavior);
    },
    [onAtBottomChange, pinToBottom]
  );

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;
      const previous = lastScrollTopRef.current;
      const scrollTop = container.scrollTop;
      lastScrollTopRef.current = scrollTop;
      const intent = conversationFollowIntent({
        trustedUserScroll:
          event.nativeEvent.isTrusted &&
          programmaticScrollDepthRef.current === 0,
        previousScrollTop: previous,
        scrollTop,
        nearBottom: isConversationNearBottom(container),
        attached: followTailRef.current,
      });
      if (intent === 'detach') {
        detachFromBottom();
      } else if (intent === 'attach') {
        followTailRef.current = true;
        setIsFollowingTail(true);
        isAtBottomRef.current = true;
        onAtBottomChange?.(true);
      }
      if (
        event.nativeEvent.isTrusted &&
        programmaticScrollDepthRef.current === 0 &&
        shouldLoadOlderTimelinePage({
          hasEarlier: hasEarlierTimeline,
          isAtBottom: isAtBottomRef.current,
          scrollTop,
          previousScrollTop: previous,
        })
      ) {
        loadEarlierTimeline();
      }
      updateAtBottomState();
      updateActiveIndex();
    },
    [
      detachFromBottom,
      hasEarlierTimeline,
      loadEarlierTimeline,
      onAtBottomChange,
      updateActiveIndex,
      updateAtBottomState,
    ]
  );

  const scrollToIndex = useCallback(
    (index: number) => {
      scrollToTimelineIndexWithAlign(index, 'start', true);
      setActiveIndex(index);
    },
    [scrollToTimelineIndexWithAlign]
  );

  useEffect(() => {
    const onJump = (event: Event) => {
      const detail = (event as CustomEvent<ConversationScrollToTurnDetail>)
        .detail;
      if (!detail || detail.conversationId !== sessionId) return;
      const index = timelineItems.findIndex((item) => {
        if (item.kind !== 'message' || item.item.turn.role !== 'user') {
          return false;
        }
        const turnId = item.item.turn.id;
        return (
          turnId === detail.turnId ||
          vibexTurnIdFromTimelineRowId(turnId) === detail.turnId
        );
      });
      if (index < 0) return;
      scrollToIndex(index);
    };
    window.addEventListener(CONVERSATION_SCROLL_TO_TURN_EVENT, onJump);
    return () => {
      window.removeEventListener(CONVERSATION_SCROLL_TO_TURN_EVENT, onJump);
    };
  }, [scrollToIndex, sessionId, timelineItems]);

  useEffect(() => {
    const onJumpToGoal = (event: Event) => {
      const detail = (event as CustomEvent<ConversationScrollToGoalDetail>)
        .detail;
      if (!detail || detail.conversationId !== sessionId) return;
      for (let i = timelineItems.length - 1; i >= 0; i -= 1) {
        const item = timelineItems[i];
        if (item?.kind !== 'message') continue;
        const hasGoalTool = item.item.turn.blocks.some(
          (block) => block.type === 'tool_use' && isGoalToolUse(block)
        );
        if (hasGoalTool) {
          scrollToIndex(i);
          return;
        }
      }
    };
    window.addEventListener(CONVERSATION_SCROLL_TO_GOAL_EVENT, onJumpToGoal);
    return () => {
      window.removeEventListener(
        CONVERSATION_SCROLL_TO_GOAL_EVENT,
        onJumpToGoal
      );
    };
  }, [scrollToIndex, sessionId, timelineItems]);

  useEffect(() => {
    const applyJumpDetail = (detail: ConversationScrollToQuoteDetail) => {
      if (
        detail.conversationId &&
        sessionId &&
        detail.conversationId !== sessionId
      ) {
        return;
      }
      const needle = detail.snippet?.trim();
      let index = -1;
      if (detail.messageId) {
        const targetTurnPrefix = vibexTurnIdFromTimelineRowId(detail.messageId);
        index = timelineItems.findIndex(
          (item) =>
            (item.kind === 'message' &&
              (item.item.turn.id === detail.messageId ||
                item.item.key === detail.messageId ||
                (Boolean(targetTurnPrefix) &&
                  vibexTurnIdFromTimelineRowId(item.item.turn.id) ===
                    targetTurnPrefix))) ||
            (item.kind === 'side' && item.row.row_id === detail.messageId)
        );
      }
      if (index < 0 && detail.turnId) {
        index = timelineItems.findIndex(
          (item) =>
            item.kind === 'message' &&
            (item.item.turn.id === detail.turnId ||
              vibexTurnIdFromTimelineRowId(item.item.turn.id) === detail.turnId)
        );
      }
      if (index < 0 && detail.turnOrdinal != null) {
        let userOrdinal = 0;
        index = timelineItems.findIndex((item) => {
          if (item.kind !== 'message') return false;
          if (item.item.turn.role === 'user') {
            userOrdinal += 1;
          }
          return userOrdinal === detail.turnOrdinal;
        });
      }
      if (index < 0 && needle) {
        index = timelineItems.findIndex(
          (item) =>
            item.kind === 'message' &&
            turnCopyText(item.item.turn).includes(needle)
        );
      }
      if (index >= 0) {
        scrollToTimelineIndexWithAlign(index, 'center', true);
      }
      const runPulse = () => {
        if (containerRef.current) {
          pulseQuoteTargetElement(containerRef.current, detail);
        }
      };
      runPulse();
      window.setTimeout(runPulse, 140);
    };

    if (timelineItems.length > 0) {
      const pending = consumePendingConversationJump(sessionId);
      if (pending) {
        applyJumpDetail(pending);
      }
    }

    const onJumpToQuote = (event: Event) => {
      const detail = (event as CustomEvent<ConversationScrollToQuoteDetail>)
        .detail;
      if (!detail) return;
      applyJumpDetail(detail);
    };
    window.addEventListener(CONVERSATION_SCROLL_TO_QUOTE_EVENT, onJumpToQuote);
    return () => {
      window.removeEventListener(
        CONVERSATION_SCROLL_TO_QUOTE_EVENT,
        onJumpToQuote
      );
    };
  }, [scrollToTimelineIndexWithAlign, sessionId, timelineItems]);

  const updateScrollMargin = useCallback(() => {
    const container = containerRef.current;
    const list = virtualListRef.current;
    if (!container || !list) return;
    const next = measureScrollMargin(list, container);
    setScrollMargin((current) =>
      Math.abs(current - next) > 1 ? next : current
    );
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const list = virtualListRef.current;
    if (!container || !list) return;
    updateScrollMargin();
    let viewportHeight = container.clientHeight;
    const observer = new ResizeObserver(() => {
      updateScrollMargin();
      const nextHeight = container.clientHeight;
      if (nextHeight === viewportHeight) return;
      viewportHeight = nextHeight;
      if (nextHeight > 0 && followTailRef.current) pinToBottom('auto');
    });
    observer.observe(container);
    observer.observe(list);
    return () => observer.disconnect();
  }, [pinToBottom, sideRowsLength, updateScrollMargin]);

  useLayoutEffect(() => {
    updateActiveIndex();
  }, [updateActiveIndex, virtualRows]);

  useLayoutEffect(() => {
    const pendingJump = pendingJumpTimelineIndexRef.current;
    if (!pendingJump || pendingJump.index < visibleTimelineStartIndex) return;
    const localIndex = pendingJump.index - visibleTimelineStartIndex;
    const virtualIndex = virtualEntries.findIndex(
      (entry) => entry.timelineIndex === localIndex
    );
    if (virtualIndex < 0) return;
    pendingJumpTimelineIndexRef.current = null;
    jumpToVirtualIndex(virtualIndex, pendingJump.align);
  }, [jumpToVirtualIndex, virtualEntries, visibleTimelineStartIndex]);

  useLayoutEffect(() => {
    const rawSessionChanged = sessionPinRef.current !== sessionId;
    if (rawSessionChanged) {
      pinnedSessionReadyRef.current = null;
    }
    const firstNonEmptyForSession =
      virtualEntries.length > 0 && pinnedSessionReadyRef.current !== sessionId;
    if (firstNonEmptyForSession) {
      pinnedSessionReadyRef.current = sessionId;
    }
    const sessionChanged = rawSessionChanged || firstNonEmptyForSession;
    const combinedPrependEpoch = olderTurnsPrependEpoch + effectiveRevealEpoch;
    const prepended = combinedPrependEpoch > previousPrependEpochRef.current;
    const container = containerRef.current;
    if (container) {
      const nextTop = scrollTopAfterPrepend({
        followTail: followTailRef.current,
        sessionChanged,
        prepended,
        previousTotalSize: previousTotalSizeRef.current,
        nextTotalSize: totalSize,
        scrollTop: container.scrollTop,
      });
      if (nextTop !== container.scrollTop) {
        runProgrammaticScroll(() => {
          container.scrollTop = nextTop;
        });
      }
    }
    previousPrependEpochRef.current = combinedPrependEpoch;
    previousTotalSizeRef.current = totalSize;
    sessionPinRef.current = sessionId;
    const currentExpandableRevision = getExpandableRevision();
    const expansionChanged =
      expansionInViewRef.current &&
      seenExpansionRef.current !== null &&
      seenExpansionRef.current !== currentExpandableRevision;
    expansionInViewRef.current = false;
    seenExpansionRef.current = currentExpandableRevision;
    const decision = conversationTailFollowAction({
      attached: followTailRef.current,
      sessionChanged,
      expansionChanged,
      settlePassesRemaining: openSettlePassesRef.current,
      itemCount: virtualEntries.length,
      nearBottom: isAtBottomRef.current,
    });
    followTailRef.current = decision.attached;
    setIsFollowingTail((current) =>
      current === decision.attached ? current : decision.attached
    );
    openSettlePassesRef.current = decision.settlePassesRemaining;
    if (decision.action === 'release') {
      if (expansionChanged) {
        detachFromBottom();
      } else {
        cancelVirtualizerFollowScroll(rowVirtualizer);
        if (isAtBottomRef.current && !decision.attached) {
          isAtBottomRef.current = false;
          onAtBottomChange?.(false);
        }
      }
      return;
    }
    if (virtualEntries.length === 0) {
      if (!isAtBottomRef.current) {
        isAtBottomRef.current = true;
        onAtBottomChange?.(true);
      }
      return;
    }
    isAtBottomRef.current = true;
    onAtBottomChange?.(true);
    pinToBottom('auto');
  }, [
    detachFromBottom,
    effectiveRevealEpoch,
    olderTurnsPrependEpoch,
    onAtBottomChange,
    pinToBottom,
    processExpandableRevision,
    rowVirtualizer,
    runProgrammaticScroll,
    sessionId,
    totalSize,
    virtualEntries.length,
  ]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom() {
        scrollToBottom(scrollBehavior);
      },
      scrollToIndex(index, options) {
        const shouldDetach = (options?.behavior ?? scrollBehavior) === 'smooth';
        scrollToTimelineIndexWithAlign(
          index,
          options?.align ?? 'center',
          shouldDetach
        );
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
        jumpToVirtualIndex(target, 'center');
      },
    }),
    [
      detachFromBottom,
      jumpToVirtualIndex,
      rowVirtualizer,
      scrollBehavior,
      scrollToBottom,
      scrollToTimelineIndexWithAlign,
      userMessageIndexes,
    ]
  );

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    return bindConversationSummaryMarquee(root);
  }, []);

  const scrollTailOverlayIntoView = useCallback(() => {
    const container = containerRef.current;
    if (!container || !isAtBottomRef.current) return;
    runProgrammaticScroll(() => {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'auto',
      });
    });
  }, [runProgrammaticScroll]);

  const markExpansionInView = useCallback(() => {
    expansionInViewRef.current = true;
  }, []);

  return {
    containerRef,
    virtualListRef,
    scrollMargin,
    rowVirtualizer,
    virtualEntries,
    virtualRows,
    totalSize,
    visibleTimelineStartIndex,
    visibleTimelineItems,
    hasEarlierTimeline,
    loadEarlierTimeline,
    activeIndex,
    activeNavEntry,
    userMessageIndexes,
    findOpen,
    setFindOpen,
    findQuery,
    setFindQuery,
    findMatchIndex,
    setFindMatchIndex,
    findMatches,
    currentFindMatch,
    goToFindMatch,
    detachFromBottom,
    handleJumpToVirtualIndex,
    handleScroll,
    scrollToIndex,
    scrollTailOverlayIntoView,
    markExpansionInView,
  };
}
