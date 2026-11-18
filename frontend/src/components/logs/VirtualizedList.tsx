import { forwardRef } from 'react';
import type { TaskWithAttemptStatus } from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import type {
  AgentEventEnvelope,
  AgentPermissionRequest,
} from '@/features/agents/types';
import { type PendingAgentPermission } from '@/components/agents/AgentPermissionPanel';
// Conversations always render through the ACP-native timeline. This module keeps
// the shared viewport/scroll/permission helpers (consumed by
// AgentTimelineConversation and unit tests) and re-exports the timeline as the
// default `VirtualizedList`. The legacy execution-process renderer was removed.
import AgentTimelineConversation from './AgentTimelineConversation';

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
  widthMode?: 'bounded' | 'workspace';
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

const BOTTOM_SCROLL_THRESHOLD_PX = 48;
export const CONVERSATION_OPEN_SETTLE_PASSES = 12;
export const ESTIMATED_CONVERSATION_ROW_HEIGHT = 128;

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

/**
 * Offset of the in-flow virtual window.
 *
 * Visible rows stack in document order inside one translated box. A stale
 * height estimate can leave a gap or a short scroll range, but it cannot
 * paint a later turn on top of an earlier one.
 */
export function getVirtualWindowTranslateY(
  firstStart: number | undefined,
  scrollMargin: number
): string {
  return getVirtualRowTranslateY(firstStart ?? scrollMargin, scrollMargin);
}

/**
 * Write real layout heights for rows that are mounted.
 *
 * `virtualizer.measure()` drops the whole size cache back to the estimate.
 * During a live turn that estimate is shorter than the painted row, so every
 * following turn is placed too high until the observer fills the cache again.
 */
export function remeasureMountedVirtualRows(
  list: ParentNode,
  resizeItem: (index: number, size: number) => void
): void {
  // One level only. A nested transcript inside a turn has its own data-index
  // values, and feeding those to this list's virtualizer would resize the
  // wrong rows.
  const nodes = list.querySelectorAll<HTMLElement>(
    ':scope > [data-index], :scope > * > [data-index]'
  );
  nodes.forEach((node) => {
    const index = Number(node.getAttribute('data-index'));
    const height = node.offsetHeight;
    if (!Number.isFinite(index) || height <= 1) return;
    resizeItem(index, height);
  });
}

type OffsetNode = {
  offsetTop: number;
  offsetParent: unknown;
};

function isOffsetNode(value: unknown): value is OffsetNode {
  return !!value && typeof value === 'object' && 'offsetTop' in value;
}

function accumulatedOffsetTop(element: OffsetNode): number {
  let top = 0;
  let node: OffsetNode | null = element;
  while (node) {
    top += node.offsetTop;
    node = isOffsetNode(node.offsetParent) ? node.offsetParent : null;
  }
  return top;
}

/**
 * Offset of the virtual list from the scroll container, in layout pixels.
 *
 * Must not use `getBoundingClientRect` or `scrollTop`. Canvas zoom scales
 * bounding rects, and adding `scrollTop` makes the margin track the scroll
 * position — both empty the stream and send piano-key jumps to the wrong row.
 */
export function measureScrollMargin(
  list: OffsetNode,
  container: OffsetNode
): number {
  return Math.max(
    0,
    accumulatedOffsetTop(list) - accumulatedOffsetTop(container)
  );
}

/**
 * Space left above a user message when a piano-key or turn jump aligns it
 * to the start. Start alignment otherwise scrolls the row onto the scrollport
 * edge and carries the stream's top padding away with it.
 */
export const USER_MESSAGE_SCROLL_INSET_PX = 12;

export function startAlignedVirtualOffset(
  itemStart: number,
  insetPx = USER_MESSAGE_SCROLL_INSET_PX
): number {
  if (!Number.isFinite(itemStart)) return 0;
  const inset = Number.isFinite(insetPx) ? Math.max(0, insetPx) : 0;
  return Math.max(0, itemStart - inset);
}

export function unscaledElementRect(element: {
  clientWidth: number;
  clientHeight: number;
}): { width: number; height: number } {
  return { width: element.clientWidth, height: element.clientHeight };
}

export function observeUnscaledElementRect(
  instance: { scrollElement: Element | null },
  cb: (rect: { width: number; height: number }) => void
): () => void {
  const element = instance.scrollElement;
  if (!(element instanceof HTMLElement)) return () => undefined;
  const fire = () => cb(unscaledElementRect(element));
  fire();
  const observer = new ResizeObserver(fire);
  observer.observe(element);
  return () => observer.disconnect();
}

export function measureUnscaledBlockHeight(
  element: HTMLElement,
  _entry?: ResizeObserverEntry,
  instance?: { measurementsCache?: Array<{ size: number } | undefined> }
): number {
  const height = element.offsetHeight;
  // Hidden or just-mounted rows can report 0 or 1px. Keeping that sample
  // pins the virtualizer until the row is recycled and hides the live turn.
  if (height > 1) return height;
  const index = Number(element.getAttribute('data-index'));
  const previous = Number.isFinite(index)
    ? instance?.measurementsCache?.[index]?.size
    : undefined;
  return previous && previous > 0
    ? previous
    : ESTIMATED_CONVERSATION_ROW_HEIGHT;
}

export function scheduleMeasuredScrollToIndex(
  scrollToIndex: (index: number) => void,
  index: number,
  schedule: (callback: () => void) => void = (callback) =>
    requestAnimationFrame(callback)
): void {
  scrollToIndex(index);
  schedule(() => scrollToIndex(index));
}

export function isConversationNearBottom(
  metrics: ConversationScrollMetrics,
  thresholdPx = BOTTOM_SCROLL_THRESHOLD_PX
): boolean {
  return getDistanceFromConversationBottom(metrics) <= thresholdPx;
}

export function conversationOpenPinState(input: {
  settlePassesRemaining: number;
  itemCount: number;
  nearBottom: boolean;
  viewportHeight?: number;
}): { pinned: boolean; settlePassesRemaining: number } {
  if ((input.viewportHeight ?? -1) === 0) {
    return {
      pinned: true,
      settlePassesRemaining: input.settlePassesRemaining,
    };
  }
  if (input.settlePassesRemaining > 0) {
    return {
      pinned: true,
      settlePassesRemaining:
        input.itemCount === 0
          ? input.settlePassesRemaining
          : input.settlePassesRemaining - 1,
    };
  }
  return {
    pinned: input.nearBottom,
    settlePassesRemaining: 0,
  };
}

export type ConversationFollowIntent = 'attach' | 'detach' | 'keep';

/**
 * Manual scrolling wins over stick-to-bottom. An upward user scroll detaches
 * immediately, including inside the near-bottom band. Re-attach only when the
 * user's own downward scroll lands in that band.
 */
export function conversationFollowIntent(input: {
  trustedUserScroll: boolean;
  previousScrollTop: number;
  scrollTop: number;
  nearBottom: boolean;
  attached: boolean;
  viewportHeight?: number;
  previousScrollHeight?: number;
  scrollHeight?: number;
}): ConversationFollowIntent {
  if ((input.viewportHeight ?? 1) <= 0) return 'keep';
  if (!input.trustedUserScroll) return 'keep';
  const heightDrop =
    input.previousScrollHeight != null && input.scrollHeight != null
      ? input.previousScrollHeight - input.scrollHeight
      : 0;
  const topDrop = input.previousScrollTop - input.scrollTop;
  // The browser clamps scrollTop when scrollHeight shrinks. That event is
  // trusted, but it is not the user leaving the tail.
  if (topDrop > 1 && heightDrop > 0 && topDrop <= heightDrop + 1) {
    return 'keep';
  }
  if (input.scrollTop < input.previousScrollTop - 1) return 'detach';
  if (
    !input.attached &&
    input.nearBottom &&
    input.scrollTop > input.previousScrollTop + 1
  ) {
    return 'attach';
  }
  return 'keep';
}

export function wheelDetachesConversationFollow(deltaY: number): boolean {
  return deltaY < 0;
}

/**
 * When older rows are prepended, grow scrollTop by the extra content so the
 * rows already on screen stay put. Following the tail, or switching sessions,
 * leaves scrollTop alone — those paths pin or reset the viewport themselves.
 */
export function scrollTopAfterPrepend(input: {
  followTail: boolean;
  sessionChanged: boolean;
  prepended: boolean;
  previousTotalSize: number;
  nextTotalSize: number;
  scrollTop: number;
}): number {
  if (input.followTail || input.sessionChanged || !input.prepended) {
    return input.scrollTop;
  }
  const delta = input.nextTotalSize - input.previousTotalSize;
  if (delta <= 0) return input.scrollTop;
  return input.scrollTop + delta;
}

export function isConversationExpansionToggle(
  target: EventTarget | null
): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest('button, [role="button"]');
  return control?.hasAttribute('aria-expanded') ?? false;
}

export function conversationTailFollowAction(input: {
  attached: boolean;
  sessionChanged: boolean;
  expansionChanged: boolean;
  settlePassesRemaining: number;
  itemCount: number;
  nearBottom: boolean;
  viewportHeight?: number;
}): {
  action: 'pin' | 'release';
  attached: boolean;
  settlePassesRemaining: number;
} {
  // A hidden canvas node reports a 0-height viewport. Treating that frame as
  // a session open burns the settle window and can detach before paint.
  if ((input.viewportHeight ?? -1) === 0) {
    const attached = input.attached || input.sessionChanged;
    return {
      action: attached ? 'pin' : 'release',
      attached,
      settlePassesRemaining: input.settlePassesRemaining,
    };
  }
  if (input.sessionChanged) {
    const pin = conversationOpenPinState({
      settlePassesRemaining: CONVERSATION_OPEN_SETTLE_PASSES,
      itemCount: input.itemCount,
      nearBottom: true,
      viewportHeight: input.viewportHeight,
    });
    return {
      action: pin.pinned ? 'pin' : 'release',
      attached: true,
      settlePassesRemaining: pin.settlePassesRemaining,
    };
  }
  if (input.expansionChanged || !input.attached) {
    return {
      action: 'release',
      attached: false,
      settlePassesRemaining: 0,
    };
  }
  const pin = conversationOpenPinState({
    settlePassesRemaining: input.settlePassesRemaining,
    itemCount: input.itemCount,
    nearBottom: input.nearBottom,
    viewportHeight: input.viewportHeight,
  });
  return {
    action: pin.pinned ? 'pin' : 'release',
    attached: pin.pinned,
    settlePassesRemaining: pin.settlePassesRemaining,
  };
}

/** Follow is on, the viewport is real, and the last row is outside the window. */
export function conversationTailNeedsRescue(input: {
  attached: boolean;
  viewportHeight: number;
  itemCount: number;
  visibleIndexes: readonly number[];
}): boolean {
  if (!input.attached || input.viewportHeight <= 0 || input.itemCount <= 0) {
    return false;
  }
  return !input.visibleIndexes.includes(input.itemCount - 1);
}

type CancelableVirtualizerScroll = {
  scrollState?: unknown;
  rafId?: number | null;
  targetWindow?: { cancelAnimationFrame: (handle: number) => void } | null;
};

/** Stop TanStack's scroll reconcile. It otherwise re-scrolls while a row grows. */
export function cancelVirtualizerFollowScroll(
  virtualizer: object | null | undefined
): void {
  if (!virtualizer) return;
  const pending = virtualizer as CancelableVirtualizerScroll;
  if (pending.rafId != null) {
    pending.targetWindow?.cancelAnimationFrame(pending.rafId);
  }
  pending.rafId = null;
  pending.scrollState = null;
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

/**
 * Conversation view. Every conversation is an ACP session, so this is a thin
 * forwarder to {@link AgentTimelineConversation} (the unified, event-sourced
 * timeline). Kept as `VirtualizedList` so existing call sites are unchanged.
 */
const VirtualizedList = forwardRef<VirtualizedListRef, VirtualizedListProps>(
  function VirtualizedList(
    { attempt, task, onAtBottomChange, widthMode },
    ref
  ) {
    return (
      <AgentTimelineConversation
        ref={ref}
        attempt={attempt}
        task={task}
        onAtBottomChange={onAtBottomChange}
        widthMode={widthMode}
      />
    );
  }
);

export default VirtualizedList;
