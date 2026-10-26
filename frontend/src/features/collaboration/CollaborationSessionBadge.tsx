import { useMemo } from 'react';

import { cn } from '@/lib/utils';

import { MemberBotAvatar, resolveMemberBotAvatar } from './MemberBotAvatar';
import i18n from '@/i18n';

export function CollaborationSessionBadge({
  memberName,
  conversationId,
  onOpen,
  className,
}: {
  memberName: string;
  conversationId?: string;
  onOpen: () => void;
  className?: string;
}) {
  const avatar = useMemo(
    () =>
      resolveMemberBotAvatar({
        conversationId,
        nickname: memberName,
      }),
    [conversationId, memberName]
  );

  return (
    <button
      type="button"
      data-testid="collaboration-session-badge"
      aria-label={i18n.t('panels:ui.collab.openBotMembername', { memberName: memberName })}
      className={cn(
        'inline-flex min-w-0 max-w-[7rem] shrink-0 items-center gap-1',
        className
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }}
    >
      <MemberBotAvatar
        config={avatar}
        animated={false}
        className="h-3.5 w-3.5 shrink-0"
      />
      <span
        className="min-w-0 truncate text-[10px] font-semibold"
        style={{ color: avatar.color }}
      >
        {memberName}
      </span>
    </button>
  );
}
