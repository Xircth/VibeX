import { AtSign, MessageCircle, PanelsTopLeft, Zap } from 'lucide-react';
import { Fragment, createElement, type CSSProperties } from 'react';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import i18n from '@/i18n';
import {
  MemberBotAvatar,
  deriveMemberBotAvatar,
  type MemberBotAvatarConfig,
} from './MemberBotAvatar';
import { requestCollaborationPulseProposal } from './collaborationPulseEvents';

export type MemberAvatarMenuCopy = {
  openPrivateChat: string;
  openSession: string;
  bindPulseTrigger?: string;
};

export const MEMBER_AVATAR_MENU_COPY: MemberAvatarMenuCopy = {
  get openPrivateChat() {
    return i18n.t('panels:collabCopy.openPrivateChat');
  },
  get openSession() {
    return i18n.t('panels:collabCopy.openSession');
  },
  get bindPulseTrigger() {
    return i18n.t(
      'panels:collabCopy.bindPulseTrigger',
      'Bind Event Trigger to Seat…'
    );
  },
};

export type BuildMemberAvatarMenuInput = {
  nickname: string;
  color: string;
  avatar?: MemberBotAvatarConfig;
  memberId?: string;
  spaceId?: string;
  spaceName?: string;
  copy?: MemberAvatarMenuCopy;
  onMention: () => void;
  onOpenPrivateChat: () => void;
  onOpenSession: () => void;
  onBindPulseTrigger?: () => void;
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
  memberId,
  spaceId,
  spaceName,
  copy = MEMBER_AVATAR_MENU_COPY,
  onMention,
  onOpenPrivateChat,
  onOpenSession,
  onBindPulseTrigger,
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
    { type: 'separator', id: 'pulse-seat-sep' },
    {
      id: 'bind-member-pulse-trigger',
      label: copy.bindPulseTrigger ?? 'Bind Event Trigger to Seat…',
      icon: Zap,
      onSelect:
        onBindPulseTrigger ??
        (() => {
          requestCollaborationPulseProposal({
            kind: 'group-seat',
            spaceId: spaceId ?? null,
            spaceName: spaceName ?? null,
            memberId: memberId ?? null,
            nickname: name,
          });
        }),
    },
  ];
}
