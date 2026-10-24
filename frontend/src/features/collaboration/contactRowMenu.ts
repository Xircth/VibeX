import {
  Bell,
  BellOff,
  Copy,
  Eye,
  EyeOff,
  FolderInput,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import { UNGROUPED_SECTION_ID } from './contactGroups';
import type { ChatListEntry } from './spaceModel';

export type ContactMoveTarget = {
  id: string;
  name: string;
};

export type ContactRowMenuCopy = {
  pin: string;
  unpin: string;
  moveTo: string;
  markUnread: string;
  markRead: string;
  renameAssistant: string;
  renameGroup: string;
  copyThreadId: string;
  hideFromSidebar: string;
  showInSidebar: string;
  delete: string;
};

export const CONTACT_ROW_MENU_COPY: ContactRowMenuCopy = {
  pin: '置顶',
  unpin: '取消置顶',
  moveTo: '移至',
  markUnread: '标为未读',
  markRead: '标为已读',
  renameAssistant: '重命名助手',
  renameGroup: '重命名群组',
  copyThreadId: '复制对话 ID',
  hideFromSidebar: '从侧边栏隐藏',
  showInSidebar: '在侧边栏显示',
  delete: '删除',
};

export type BuildContactRowMenuInput = {
  entry: ChatListEntry;
  pinned: boolean;
  hidden: boolean;
  unread: boolean;
  moveTargets: readonly ContactMoveTarget[];
  copy?: ContactRowMenuCopy;
  onPin: () => void;
  onMove?: (sectionId: string) => void;
  onToggleUnread: () => void;
  onRename: () => void;
  onCopyId: () => void;
  onHide: () => void;
  onDelete: () => void;
};

export function buildContactRowMenuItems({
  entry,
  pinned,
  hidden,
  unread,
  moveTargets,
  copy = CONTACT_ROW_MENU_COPY,
  onPin,
  onMove,
  onToggleUnread,
  onRename,
  onCopyId,
  onHide,
  onDelete,
}: BuildContactRowMenuInput): ProductContextMenuItem[] {
  const items: ProductContextMenuItem[] = [
    {
      id: 'pin',
      label: pinned ? copy.unpin : copy.pin,
      icon: pinned ? PinOff : Pin,
      onSelect: onPin,
    },
  ];

  if (onMove && moveTargets.length > 0) {
    items.push({
      type: 'submenu',
      id: 'move',
      label: copy.moveTo,
      icon: FolderInput,
      children: moveTargets.map((target) => ({
        id: `move-${target.id}`,
        label: target.name,
        onSelect: () => onMove(target.id),
      })),
    });
  }

  items.push(
    {
      id: 'unread',
      label: unread ? copy.markRead : copy.markUnread,
      icon: unread ? BellOff : Bell,
      onSelect: onToggleUnread,
    },
    { type: 'separator', id: 'sep-rename' },
    {
      id: 'rename',
      label: entry.type === 'direct' ? copy.renameAssistant : copy.renameGroup,
      icon: Pencil,
      onSelect: onRename,
    },
    { type: 'separator', id: 'sep-copy' },
    {
      id: 'copy-id',
      label: copy.copyThreadId,
      icon: Copy,
      onSelect: onCopyId,
    },
    { type: 'separator', id: 'sep-hide' },
    {
      id: 'hide',
      label: hidden ? copy.showInSidebar : copy.hideFromSidebar,
      icon: hidden ? Eye : EyeOff,
      onSelect: onHide,
    },
    {
      id: 'delete',
      label: copy.delete,
      icon: Trash2,
      danger: true,
      onSelect: onDelete,
    }
  );

  return items;
}

export function moveTargetsForEntry(
  entry: ChatListEntry,
  sections: ReadonlyArray<{ id: string; name: string }> | null | undefined
): ContactMoveTarget[] {
  if (!sections || sections.length === 0) return [];
  const current = entry.groupId ?? UNGROUPED_SECTION_ID;
  return sections
    .filter((section) => section.id !== current)
    .map((section) => ({ id: section.id, name: section.name }));
}
