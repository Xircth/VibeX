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

export function isConversationNearBottom(
  metrics: ConversationScrollMetrics,
  thresholdPx = BOTTOM_SCROLL_THRESHOLD_PX
): boolean {
  return getDistanceFromConversationBottom(metrics) <= thresholdPx;
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
