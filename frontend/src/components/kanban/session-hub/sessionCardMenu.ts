import type { TFunction } from 'i18next';
import {
  Copy,
  FileCode,
  FileDown,
  GitFork,
  Pencil,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { isSessionForkSupported } from './utils';

export interface BuildSessionCardMenuItemsParams {
  session: Pick<
    KanbanProjectSessionRecord,
    'agentId' | 'executor' | 'forkSupported'
  >;
  t: TFunction;
  onRename?: () => void;
  onCopySessionInfo: () => void;
  onCopySessionName: () => void;
  onExportHtml: () => void;
  onExportMarkdown: () => void;
  onFork?: () => void;
  isForking?: boolean;
  onDelete?: () => void;
  onRestore?: () => void;
  restoreLabel?: string;
}

export function buildSessionCardMenuItems({
  session,
  t,
  onRename,
  onCopySessionInfo,
  onCopySessionName,
  onExportHtml,
  onExportMarkdown,
  onFork,
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

  if (onFork && isSessionForkSupported(session)) {
    items.push({
      id: 'fork-session',
      label: t('tasks:hubListItem.forkFromSession'),
      icon: GitFork,
      disabled: isForking,
      onSelect: onFork,
    });
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
