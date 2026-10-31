import { AtSign, MessageCircle, PanelsTopLeft } from 'lucide-react';
import { Fragment, createElement, type CSSProperties } from 'react';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import i18n from '@/i18n';
import {
  MemberBotAvatar,
  deriveMemberBotAvatar,
  type MemberBotAvatarConfig,
} from './MemberBotAvatar';

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
  avatar?: MemberBotAvatarConfig;
  copy?: MemberAvatarMenuCopy;
  onMention: () => void;
  onOpenPrivateChat: () => void;
  onOpenSession: () => void;
};

export function memberMentionMenuLabel(nickname: string): string {
  return nickname.replace(/^@+/, '').trim();
}

export function memberMentionLabelStyle(color: string): CSSProperties {
  return { color, fontWeight: 600 };
}

export function buildMemberAvatarMenuItems({
  nickname,
  color,
  avatar,
  copy = MEMBER_AVATAR_MENU_COPY,
  onMention,
  onOpenPrivateChat,
  onOpenSession,
}: BuildMemberAvatarMenuInput): ProductContextMenuItem[] {
  const name = memberMentionMenuLabel(nickname);
  const baseAvatar = avatar ?? deriveMemberBotAvatar(name);
  const resolvedAvatar: MemberBotAvatarConfig = {
    ...baseAvatar,
    color: color || baseAvatar.color,
  };
  return [
    {
      id: 'mention',
      label: name,
      labelNode: createElement(
        Fragment,
        null,
        createElement(MemberBotAvatar, {
          config: resolvedAvatar,
          animated: false,
          sessionActive: false,
          className: 'collaboration-member-mention-avatar',
        }),
        name
      ),
      icon: AtSign,
      labelStyle: memberMentionLabelStyle(resolvedAvatar.color),
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
