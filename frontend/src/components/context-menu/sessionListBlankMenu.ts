import type { ProductContextMenuItem } from './contextMenuTypes';

export type SessionListSortMenuKey = 'name' | 'time' | 'agent';

export function buildSessionListBlankMenu({
  t,
  onSort,
  onCreateSession,
  onExportPack,
}: {
  t: (key: string) => string;
  onSort: (key: SessionListSortMenuKey) => void;
  onCreateSession: () => void;
  onExportPack: () => void;
}): ProductContextMenuItem[] {
  return [
    {
      type: 'submenu',
      id: 'auto-sort',
      label: t('common:contextMenu.autoSort'),
      children: [
        {
          id: 'sort-name',
          label: t('common:contextMenu.sortName'),
          onSelect: () => onSort('name'),
        },
        {
          id: 'sort-time',
          label: t('common:contextMenu.sortRecent'),
          onSelect: () => onSort('time'),
        },
        {
          id: 'sort-agent',
          label: t('common:contextMenu.sortAgent'),
          onSelect: () => onSort('agent'),
        },
      ],
    },
    {
      id: 'create-session',
      label: t('common:contextMenu.createSession'),
      onSelect: onCreateSession,
    },
    {
      id: 'export-pack',
      label: t('common:contextMenu.exportProjectPack'),
      onSelect: onExportPack,
    },
  ];
}
