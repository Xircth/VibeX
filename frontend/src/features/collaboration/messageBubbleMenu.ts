import { BookmarkPlus, Brain, Copy, CornerUpLeft } from 'lucide-react';
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
  saveToCollection?: string;
  distillMemory?: string;
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
  get saveToCollection() {
    return i18n.t('panels:collabCopy.saveToCollection', {
      defaultValue: '收藏到本空间',
    });
  },
  get distillMemory() {
    return i18n.t('panels:collabCopy.distillMemory', {
      defaultValue: '提炼为记忆',
    });
  },
};

export type BuildMessageBubbleMenuInput = {
  canCopyRequestId: boolean;
  copy?: MessageBubbleMenuCopy;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
  onCopyRequestId: () => void;
  onSaveToCollection?: () => void;
  onDistillMemory?: () => void;
};

export function buildMessageBubbleMenuItems({
  canCopyRequestId,
  copy = MESSAGE_BUBBLE_MENU_COPY,
  onReact,
  onReply,
  onCopy,
  onCopyRequestId,
  onSaveToCollection,
  onDistillMemory,
}: BuildMessageBubbleMenuInput): ProductContextMenuItem[] {
  const items: ProductContextMenuItem[] = [
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

  if (onSaveToCollection || onDistillMemory) {
    items.push({ type: 'separator', id: 'memory-collection-sep' });
    if (onSaveToCollection) {
      items.push({
        id: 'save-to-collection',
        label: copy.saveToCollection ?? '收藏到本空间',
        icon: BookmarkPlus,
        onSelect: onSaveToCollection,
      });
    }
    if (onDistillMemory) {
      items.push({
        id: 'distill-memory',
        label: copy.distillMemory ?? '提炼为记忆',
        icon: Brain,
        onSelect: onDistillMemory,
      });
    }
  }

  return items;
}
