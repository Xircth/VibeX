import type { ContentBlock } from 'shared/types';

export const COLLABORATION_SPACE_ORIGIN_KIND = 'collaboration_space_origin';

export type CollaborationSpaceOriginView = {
  spaceId: string;
  threadKind: string;
  senderKind: string;
  senderNickname: string;
  senderConversationId?: string | null;
  senderMemberId?: string | null;
};

export function collaborationSpaceOriginFromBlocks(
  blocks: ContentBlock[]
): CollaborationSpaceOriginView | null {
  for (const block of blocks) {
    if (block.type !== 'protocol') continue;
    const content = block.content;
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      continue;
    }
    const record = content as Record<string, unknown>;
    if (record.kind !== COLLABORATION_SPACE_ORIGIN_KIND) continue;
    const senderNickname =
      typeof record.senderNickname === 'string' ? record.senderNickname.trim() : '';
    if (!senderNickname) continue;
    return {
      spaceId: typeof record.spaceId === 'string' ? record.spaceId : '',
      threadKind: typeof record.threadKind === 'string' ? record.threadKind : '',
      senderKind: typeof record.senderKind === 'string' ? record.senderKind : '',
      senderNickname,
      senderConversationId:
        typeof record.senderConversationId === 'string'
          ? record.senderConversationId
          : null,
      senderMemberId:
        typeof record.senderMemberId === 'string' ? record.senderMemberId : null,
    };
  }
  return null;
}

export function shouldShowGroupMemberSender(
  origin: CollaborationSpaceOriginView | null
): origin is CollaborationSpaceOriginView {
  return origin?.threadKind === 'group';
}
