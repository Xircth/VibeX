import type { TFunction } from 'i18next';
import {
  Bot,
  Copy,
  FileCode,
  FileDown,
  Pencil,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import type { SelectableAgent } from '@/features/agents/useSelectableAgents';
import { buildForkTargetSubmenu } from '@/features/conversation/ForkTargetMenu';

export interface BuildSessionCardMenuItemsParams {
  t: TFunction;
  /** Bot sessions: open the Bot's chat in the collaboration space. */
  openCollaboration?: { label: string; onSelect: () => void };
  onRename?: () => void;
  onCopySessionInfo: () => void;
  onCopySessionName: () => void;
  onExportHtml: () => void;
  onExportMarkdown: () => void;
  forkAgents?: readonly SelectableAgent[];
  onForkToAgent?: (agentId: string) => void;
  isForking?: boolean;
  onDelete?: () => void;
  onRestore?: () => void;
  restoreLabel?: string;
}

export function buildSessionCardMenuItems({
  t,
  openCollaboration,
  onRename,
  onCopySessionInfo,
  onCopySessionName,
  onExportHtml,
  onExportMarkdown,
  forkAgents = [],
  onForkToAgent,
  isForking = false,
  onDelete,
  onRestore,
  restoreLabel,
}: BuildSessionCardMenuItemsParams): ProductContextMenuItem[] {
  const items: ProductContextMenuItem[] = [];

  if (onRestore) {
    items.push({
      id: 'restore-session',
      label: restoreLabel ?? t('tasks:hubListItem.moveToSessionList'),
      icon: RotateCcw,
      onSelect: onRestore,
    });
  }

  if (openCollaboration) {
    items.push({
      id: 'open-collaboration',
      label: openCollaboration.label,
      icon: Bot,
      onSelect: openCollaboration.onSelect,
    });
  }

  if (onRename) {
    items.push({
      id: 'rename-session',
      label: t('tasks:hubListItem.renameSession'),
      icon: Pencil,
      onSelect: onRename,
    });
  }

  if (items.length > 0) {
    items.push({
      type: 'separator',
      id: 'session-primary-separator',
    });
  }

  items.push(
    {
      type: 'submenu',
      id: 'copy-session',
      label: t('tasks:hubListItem.copy'),
      icon: Copy,
      children: [
        {
          id: 'copy-session-info',
          label: t('tasks:hubListItem.copySessionInfo'),
          icon: Copy,
          onSelect: onCopySessionInfo,
        },
        {
          id: 'copy-session-name',
          label: t('tasks:hubListItem.copySessionName'),
          icon: Copy,
          onSelect: onCopySessionName,
        },
      ],
    },
    {
      type: 'submenu',
      id: 'export-session',
      label: t('tasks:hubListItem.export'),
      icon: FileDown,
      children: [
        {
          id: 'export-html',
          label: t('tasks:hubListItem.exportAsHtml'),
          icon: FileCode,
          onSelect: onExportHtml,
        },
        {
          id: 'export-md',
          label: t('tasks:hubListItem.exportAsMarkdown'),
          icon: FileDown,
          onSelect: onExportMarkdown,
        },
      ],
    }
  );

  if (onForkToAgent) {
    items.push(
      buildForkTargetSubmenu({
        id: 'fork-session',
        label: t('tasks:hubListItem.forkFromSession'),
        headerLabel: t('common:contextMenu.selectForkTarget'),
        agents: forkAgents,
        disabled: isForking,
        onSelectAgent: onForkToAgent,
      })
    );
  }

  if (onDelete) {
    items.push(
      {
        type: 'separator',
        id: 'session-danger-separator',
      },
      {
        id: 'delete-session',
        label: t('tasks:hubListItem.deleteSession'),
        icon: Trash2,
        danger: true,
        onSelect: onDelete,
      }
    );
  }

  return items;
}
