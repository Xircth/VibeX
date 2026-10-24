import { COLLABORATION_WORKSPACE_TAB } from '@/lib/hostSurfaceIds';
import { useLayoutStore } from '@/stores/useLayoutStore';

import {
  useCollaborationLayoutStore,
  type CollaborationSessionFocus,
} from './collaborationLayoutStore';

export type KanbanSessionCollaboration = {
  memberId: string;
  memberName: string;
  threadId: string;
  threadKind: string;
  threadName: string;
};

export function collaborationStoredSessionName(
  storedName: string | null | undefined,
  memberName: string | null | undefined
): string | null {
  const name = storedName?.trim() ?? '';
  if (!name) return null;
  if (memberName?.trim() && name === memberName.trim()) return null;
  return name;
}

export function openCollaborationSessionFromList(input: {
  conversationId: string;
  collaboration: KanbanSessionCollaboration;
}): void {
  const focus: CollaborationSessionFocus = {
    conversationId: input.conversationId,
    memberId: input.collaboration.memberId,
    memberName: input.collaboration.memberName,
    threadId: input.collaboration.threadId,
    threadKind: input.collaboration.threadKind,
    threadName: input.collaboration.threadName,
  };
  useCollaborationLayoutStore.getState().requestSessionFocus(focus);
  useLayoutStore.getState().setActiveTab(COLLABORATION_WORKSPACE_TAB);
}
