import { useMemo } from 'react';

import { cn } from '@/lib/utils';

import {
  deriveMemberBotAvatar,
  MemberBotAvatar,
  readMemberBotAvatars,
} from './MemberBotAvatar';

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
  const avatar = useMemo(() => {
    const stored = readMemberBotAvatars();
    const convKey = conversationId?.trim() ?? '';
    const nickKey = memberName.trim();
    return (
      (convKey ? stored[convKey] : undefined) ||
      (nickKey ? stored[nickKey] : undefined) ||
      deriveMemberBotAvatar(convKey || nickKey || 'bot')
    );
  }, [conversationId, memberName]);

  return (
    <button
      type="button"
      data-testid="collaboration-session-badge"
      aria-label={`打开助手 ${memberName}`}
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
