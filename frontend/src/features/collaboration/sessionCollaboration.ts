import i18n from '@/i18n';
import { COLLABORATION_WORKSPACE_TAB } from '@/lib/hostSurfaceIds';
import { useLayoutStore } from '@/stores/useLayoutStore';

import {
  useCollaborationLayoutStore,
  type CollaborationSessionFocus,
} from './collaborationLayoutStore';

export type KanbanSessionCollaborationMember = {
  memberId: string;
  name: string;
  conversationId: string;
};

export type KanbanSessionCollaboration = {
  memberId: string;
  memberName: string;
  threadId: string;
  threadKind: string;
  threadName: string;
  /** Group members in join order (the group avatar); empty for direct chats. */
  threadMembers: KanbanSessionCollaborationMember[];
};

/** The user side of a direct chat in Bot session titles. */
export const COLLABORATION_SESSION_USER_LABEL = 'User';

export function collaborationSessionSpaceName(
  collaboration: Pick<KanbanSessionCollaboration, 'threadKind' | 'threadName'>
): string {
  return collaboration.threadKind === 'group'
    ? collaboration.threadName
    : COLLABORATION_SESSION_USER_LABEL;
}

/** `User → 小A` for a direct chat, `后端群 → 小A` inside a group. */
export function collaborationSessionTitle(
  collaboration: Pick<
    KanbanSessionCollaboration,
    'threadKind' | 'threadName' | 'memberName'
  >
): string {
  return `${collaborationSessionSpaceName(collaboration)} → ${collaboration.memberName}`;
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

/** Session-menu entry that opens a Bot session's chat in the collaboration space. */
export function collaborationSessionMenuAction(
  conversationId: string,
  collaboration: KanbanSessionCollaboration | null
): { label: string; onSelect: () => void } | undefined {
  if (!collaboration) return undefined;
  return {
    label: i18n.t('panels:ui.collab.openBotMembername', {
      memberName: collaboration.memberName,
    }),
    onSelect: () =>
      openCollaborationSessionFromList({ conversationId, collaboration }),
  };
}
