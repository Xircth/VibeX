import { useMemo } from 'react';

import { cn } from '@/lib/utils';

import { GroupAvatar } from './GroupAvatar';
import {
  MemberBotAvatar,
  readMemberBotAvatars,
  resolveMemberBotAvatar,
} from './MemberBotAvatar';
import {
  COLLABORATION_SESSION_USER_LABEL,
  type KanbanSessionCollaboration,
} from './sessionCollaboration';
import { readSpaceTags, SPACE_TAG_PRESETS } from './spaceModel';

/**
 * Bot session title: `User → Bot` for a direct chat, `Group → Bot` for a
 * group seat. Group and Bot carry their avatars; User is accent-colored text.
 */
export function CollaborationSessionTitle({
  conversationId,
  collaboration,
  className,
}: {
  conversationId: string;
  collaboration: KanbanSessionCollaboration;
  className?: string;
}) {
  const isGroup = collaboration.threadKind === 'group';
  const { botAvatar, groupAvatars, tagHue } = useMemo(() => {
    const stored = readMemberBotAvatars();
    const tagColorId = isGroup
      ? readSpaceTags()[collaboration.threadId]?.colorId
      : undefined;
    return {
      botAvatar: resolveMemberBotAvatar({
        conversationId,
        nickname: collaboration.memberName,
        identityMemberId: collaboration.memberId,
        stored,
      }),
      groupAvatars: isGroup
        ? collaboration.threadMembers.map((member) =>
            resolveMemberBotAvatar({
              conversationId: member.conversationId,
              nickname: member.name,
              identityMemberId: member.memberId,
              stored,
            })
          )
        : [],
      tagHue: tagColorId
        ? SPACE_TAG_PRESETS.find((preset) => preset.id === tagColorId)?.hue
        : undefined,
    };
  }, [collaboration, conversationId, isGroup]);

  return (
    <span
      data-testid="collaboration-session-title"
      className={cn('flex min-w-0 items-center gap-1', className)}
    >
      {isGroup ? (
        <>
          {groupAvatars.length > 0 ? (
            <GroupAvatar
              avatars={groupAvatars}
              tagHue={tagHue}
              size={14}
              className="shrink-0"
            />
          ) : null}
          <span className="min-w-0 truncate">{collaboration.threadName}</span>
        </>
      ) : (
        <span className="shrink-0 text-primary">
          {COLLABORATION_SESSION_USER_LABEL}
        </span>
      )}
      <span className="shrink-0 text-muted-foreground">→</span>
      <MemberBotAvatar
        config={botAvatar}
        animated={false}
        className="h-3.5 w-3.5 shrink-0"
      />
      <span className="min-w-0 truncate">{collaboration.memberName}</span>
    </span>
  );
}
