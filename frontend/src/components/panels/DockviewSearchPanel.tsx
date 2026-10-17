import { useCallback } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useTranslation } from 'react-i18next';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
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
      <div className="shrink-0 px-2 pb-1 pt-2">
        <WorkspaceFileSearchField search={search} autoFocus />
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
