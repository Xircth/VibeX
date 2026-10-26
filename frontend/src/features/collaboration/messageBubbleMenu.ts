import { Copy, CornerUpLeft } from 'lucide-react';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import i18n from '@/i18n';

export const MESSAGE_REACTION_EMOJIS = [
  '👍',
  '👎',
  '❤️',
  '😄',
  '🎉',
] as const;

export const MESSAGE_REACTION_EXTRA_EMOJIS = [
  '👏',
  '🙏',
  '🔥',
  '✅',
  '❌',
] as const;

export type MessageBubbleMenuCopy = {
  reply: string;
  copy: string;
  copyRequestId: string;
  moreReactions: string;
};

export const MESSAGE_BUBBLE_MENU_COPY: MessageBubbleMenuCopy = {
  get reply() {
    return i18n.t('panels:collabCopy.reply');
  },
  get copy() {
    return i18n.t('panels:collabCopy.copy');
  },
  get copyRequestId() {
    return i18n.t('panels:collabCopy.copyRequestId');
  },
  get moreReactions() {
    return i18n.t('panels:collabCopy.moreReactions');
  },
};

export type BuildMessageBubbleMenuInput = {
  canCopyRequestId: boolean;
  copy?: MessageBubbleMenuCopy;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
  onCopyRequestId: () => void;
};

export function buildMessageBubbleMenuItems({
  canCopyRequestId,
  copy = MESSAGE_BUBBLE_MENU_COPY,
  onReact,
  onReply,
  onCopy,
  onCopyRequestId,
}: BuildMessageBubbleMenuInput): ProductContextMenuItem[] {
  return [
    {
      type: 'emoji-row',
      id: 'reactions',
      emojis: [...MESSAGE_REACTION_EMOJIS],
      extraEmojis: [...MESSAGE_REACTION_EXTRA_EMOJIS],
      moreLabel: copy.moreReactions,
      onPick: onReact,
    },
    { type: 'separator', id: 'reactions-sep' },
    {
      id: 'reply',
      label: copy.reply,
      icon: CornerUpLeft,
      onSelect: onReply,
    },
    {
      id: 'copy',
      label: copy.copy,
      icon: Copy,
      onSelect: onCopy,
    },
    {
      id: 'copy-request-id',
      label: copy.copyRequestId,
      icon: Copy,
      disabled: !canCopyRequestId,
      onSelect: onCopyRequestId,
    },
  ];
}
