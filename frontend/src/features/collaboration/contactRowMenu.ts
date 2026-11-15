import {
  Bell,
  BellOff,
  CalendarClock,
  Copy,
  Eye,
  EyeOff,
  FolderInput,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  UserMinus,
  Zap,
} from 'lucide-react';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import { UNGROUPED_SECTION_ID } from './contactGroups';
import { requestCollaborationPulseProposal } from './collaborationPulseEvents';
import type { ChatListEntry } from './spaceModel';
import i18n from '@/i18n';

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
  createPulseTrigger?: string;
  schedulePulse?: string;
  hideFromSidebar: string;
  showInSidebar: string;
  delete: string;
  stepDownSupervisor?: string;
};

export const CONTACT_ROW_MENU_COPY: ContactRowMenuCopy = {
  get pin() {
    return i18n.t('panels:contactRowMenu.pin');
  },
  get unpin() {
    return i18n.t('panels:contactRowMenu.unpin');
  },
  get moveTo() {
    return i18n.t('panels:contactRowMenu.moveTo');
  },
  get markUnread() {
    return i18n.t('panels:contactRowMenu.markUnread');
  },
  get markRead() {
    return i18n.t('panels:contactRowMenu.markRead');
  },
  get renameAssistant() {
    return i18n.t('panels:contactRowMenu.renameAssistant');
  },
  get renameGroup() {
    return i18n.t('panels:contactRowMenu.renameGroup');
  },
  get copyThreadId() {
    return i18n.t('panels:contactRowMenu.copyThreadId');
  },
  get createPulseTrigger() {
    return i18n.t(
      'panels:contactRowMenu.createPulseTrigger',
      'Create Event Trigger…'
    );
  },
  get schedulePulse() {
    return i18n.t('panels:contactRowMenu.schedulePulse', 'Schedule Pulse…');
  },
  get hideFromSidebar() {
    return i18n.t('panels:contactRowMenu.hideFromSidebar');
  },
  get showInSidebar() {
    return i18n.t('panels:contactRowMenu.showInSidebar');
  },
  get delete() {
    return i18n.t('panels:contactRowMenu.delete');
  },
  get stepDownSupervisor() {
    return i18n.t('panels:contactRowMenu.stepDownSupervisor', '卸任主管');
  },
};

export type BuildContactRowMenuInput = {
  entry: ChatListEntry;
  pinned: boolean;
  hidden: boolean;
  unread: boolean;
  moveTargets: readonly ContactMoveTarget[];
  copy?: ContactRowMenuCopy;
  isSupervisor?: boolean;
  onPin: () => void;
  onMove?: (sectionId: string) => void;
  onToggleUnread: () => void;
  onRename: () => void;
  onCopyId: () => void;
  onCreatePulseTrigger?: () => void;
  onSchedulePulse?: () => void;
  onHide: () => void;
  onDelete: () => void;
  onStepDownSupervisor?: () => void;
};

export function buildContactRowMenuItems({
  entry,
  pinned,
  hidden,
  unread,
  moveTargets,
  copy = CONTACT_ROW_MENU_COPY,
  isSupervisor = false,
  onPin,
  onMove,
  onToggleUnread,
  onRename,
  onCopyId,
  onCreatePulseTrigger,
  onSchedulePulse,
  onHide,
  onDelete,
  onStepDownSupervisor,
}: BuildContactRowMenuInput): ProductContextMenuItem[] {
  const items: ProductContextMenuItem[] = [];

  if (!isSupervisor) {
    items.push({
      id: 'pin',
      label: pinned ? copy.unpin : copy.pin,
      icon: pinned ? PinOff : Pin,
      onSelect: onPin,
    });

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
    }
  );

  if (entry.type === 'direct') {
    const resolvedMemberId =
      entry.member.member_id?.trim() ||
      entry.member.conversation_id?.trim() ||
      entry.threadId ||
      'bot';
    items.push(
      { type: 'separator', id: 'sep-pulse' },
      {
        id: 'create-pulse-trigger',
        label: copy.createPulseTrigger ?? 'Create Event Trigger…',
        icon: Zap,
        onSelect:
          onCreatePulseTrigger ??
          (() => {
            requestCollaborationPulseProposal({
              kind: 'bot',
              memberId: resolvedMemberId,
              botName: entry.name,
              mode: 'event',
            });
          }),
      },
      {
        id: 'schedule-pulse',
        label: copy.schedulePulse ?? 'Schedule Pulse…',
        icon: CalendarClock,
        onSelect:
          onSchedulePulse ??
          (() => {
            requestCollaborationPulseProposal({
              kind: 'bot',
              memberId: resolvedMemberId,
              botName: entry.name,
              mode: 'schedule',
            });
          }),
      }
    );
  }

  if (isSupervisor) {
    if (onStepDownSupervisor) {
      items.push(
        { type: 'separator', id: 'sep-step-down' },
        {
          id: 'step-down-supervisor',
          label: copy.stepDownSupervisor ?? '卸任主管',
          icon: UserMinus,
          onSelect: onStepDownSupervisor,
        }
      );
    }
    return items;
  }

  items.push(
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
