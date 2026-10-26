import { AtSign, MessageCircle, PanelsTopLeft } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import i18n from '@/i18n';

export type MemberAvatarMenuCopy = {
  openPrivateChat: string;
  openSession: string;
};

export const MEMBER_AVATAR_MENU_COPY: MemberAvatarMenuCopy = {
  get openPrivateChat() {
    return i18n.t('panels:collabCopy.openPrivateChat');
  },
  get openSession() {
    return i18n.t('panels:collabCopy.openSession');
  },
};

export type BuildMemberAvatarMenuInput = {
  nickname: string;
  color: string;
  copy?: MemberAvatarMenuCopy;
  onMention: () => void;
  onOpenPrivateChat: () => void;
  onOpenSession: () => void;
};

export function memberMentionMenuLabel(nickname: string): string {
  return `@${nickname}`;
}

export function memberMentionLabelStyle(color: string): CSSProperties {
  return { color, fontWeight: 600 };
}

export function buildMemberAvatarMenuItems({
  nickname,
  color,
  copy = MEMBER_AVATAR_MENU_COPY,
  onMention,
  onOpenPrivateChat,
  onOpenSession,
}: BuildMemberAvatarMenuInput): ProductContextMenuItem[] {
  const name = nickname.trim();
  return [
    {
      id: 'mention',
      label: memberMentionMenuLabel(name),
      icon: AtSign,
      labelStyle: memberMentionLabelStyle(color),
      onSelect: onMention,
    },
    { type: 'separator', id: 'mention-sep' },
    {
      id: 'open-private-chat',
      label: copy.openPrivateChat,
      icon: MessageCircle,
      onSelect: onOpenPrivateChat,
    },
    {
      id: 'open-session',
      label: copy.openSession,
      icon: PanelsTopLeft,
      onSelect: onOpenSession,
    },
  ];
}
