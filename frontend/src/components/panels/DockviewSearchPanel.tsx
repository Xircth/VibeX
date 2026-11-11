import { useCallback } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useTranslation } from 'react-i18next';
import { ShellNavPanelDragHandle } from '@/components/layout/ShellNavPanelDragHandle';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import {
  useWorkspaceTextSearch,
  WorkspaceFileSearchField,
  WorkspaceFileSearchResults,
} from '@/components/file-tree/WorkspaceFileSearch';

function DockviewSearchPanel(_props: IDockviewPanelProps) {
  const { t } = useTranslation('panels');
  const { rootPath } = useFileTreeStore();
  const { openFilePreview } = usePanelActionsContext();
  const search = useWorkspaceTextSearch(rootPath);

  const handleOpenFile = useCallback(
    (filePath: string, location?: { line: number; column: number }) => {
      if (!rootPath) return;
      const usesBackslash = rootPath.includes('\\');
      const separator = usesBackslash ? '\\' : '/';
      const base = rootPath.replace(/[\\/]+$/, '');
      const normalizedRel = usesBackslash
        ? filePath.replaceAll('/', '\\')
        : filePath;
      const absolutePath = `${base}${separator}${normalizedRel}`;
      openFilePreview(absolutePath, {
        location: location ?? null,
      });
    },
    [rootPath, openFilePreview]
  );

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden bg-background"
      data-panel="search"
    >
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-2">
        <div className="min-w-0 flex-1">
          <WorkspaceFileSearchField search={search} autoFocus />
        </div>
        <ShellNavPanelDragHandle panelId={PANEL_IDS.SEARCH} />
      </div>
      {rootPath ? (
        <WorkspaceFileSearchResults
          search={search}
          onOpenFile={handleOpenFile}
        />
      ) : (
        <div className="file-tree-search-status" role="status">
          {t('searchPanel.selectWorkspaceFirst')}
        </div>
      )}
    </div>
  );
}

export default DockviewSearchPanel;
