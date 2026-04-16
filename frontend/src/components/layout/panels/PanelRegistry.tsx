import React from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { PANEL_IDS, type PanelId } from '@/stores/useLayoutStore';
import DockviewPreviewPanel from '@/components/panels/DockviewPreviewPanel';

/**
 * Lazy-loaded panel components.
 * Each panel is imported dynamically for code splitting.
 */
const LazyKanbanPanel = React.lazy(
  () => import('@/components/panels/DockviewKanbanPanel')
);
const LazyFileTreePanel = React.lazy(
  () => import('@/components/panels/DockviewFileTreePanel')
);
const LazyDevPreviewPanel = React.lazy(
  () => import('@/components/panels/DockviewDevPreviewPanel')
);
const LazyDiffPanel = React.lazy(
  () => import('@/components/panels/DockviewDiffsReviewPanel')
);
const LazyTerminalPanel = React.lazy(
  () => import('@/components/panels/DockviewTerminalPanel')
);
const LazyAIChatPanel = React.lazy(
  () => import('@/components/panels/DockviewAIChatPanel')
);
const LazyGitPanel = React.lazy(
  () => import('@/components/panels/DockviewGitPanel')
);
const LazyWelcomePanel = React.lazy(
  () => import('@/components/panels/DockviewWelcomePanel')
);
const LazyLogsPanel = React.lazy(
  () => import('@/components/panels/DockviewLogsPanel')
);
const LazyNotesPanel = React.lazy(
  () => import('@/components/panels/DockviewNotesPanel')
);
const LazySearchPanel = React.lazy(
  () => import('@/components/panels/DockviewSearchPanel')
);

/**
 * Fallback component shown while panels are loading.
 */
function PanelLoadingFallback() {
  return (
    <div className="flex items-center justify-center h-full w-full text-muted-foreground text-sm bg-background">
      Loading...
    </div>
  );
}

/**
 * Registry mapping panel component IDs to their lazy-loaded React components.
 */
const PANEL_COMPONENT_MAP: Record<
  PanelId,
  React.ComponentType<IDockviewPanelProps>
> = {
  [PANEL_IDS.KANBAN]: LazyKanbanPanel,
  [PANEL_IDS.FILE_TREE]: LazyFileTreePanel,
  // Keep Preview eagerly loaded to avoid occasional unresolved lazy chunk state
  // in packaged desktop builds.
  [PANEL_IDS.PREVIEW]: DockviewPreviewPanel,
  [PANEL_IDS.DEV_PREVIEW]: LazyDevPreviewPanel,
  [PANEL_IDS.DIFFS]: LazyDiffPanel,
  [PANEL_IDS.TERMINAL]: LazyTerminalPanel,
  [PANEL_IDS.AI_CHAT]: LazyAIChatPanel,
  [PANEL_IDS.GIT]: LazyGitPanel,
  [PANEL_IDS.WELCOME]: LazyWelcomePanel,
  [PANEL_IDS.LOGS]: LazyLogsPanel,
  [PANEL_IDS.NOTES]: LazyNotesPanel,
  [PANEL_IDS.SEARCH]: LazySearchPanel,
};

/**
 * The dockview component resolver.
 * Returns the appropriate panel component for the given component ID.
 */
export const panelComponents: Record<
  string,
  React.FC<IDockviewPanelProps>
> = Object.fromEntries(
  Object.entries(PANEL_COMPONENT_MAP).map(([id, LazyComponent]) => [
    id,
    function PanelWrapper(props: IDockviewPanelProps) {
      return (
        <React.Suspense fallback={<PanelLoadingFallback />}>
          <LazyComponent {...props} />
        </React.Suspense>
      );
    },
  ])
);

/**
 * Panel metadata for display purposes.
 */
export interface PanelMeta {
  id: PanelId;
  title: string;
  defaultPosition: 'left' | 'center' | 'bottom';
}

export const PANEL_META: PanelMeta[] = [
  { id: PANEL_IDS.FILE_TREE, title: '文件管理器', defaultPosition: 'left' },
  { id: PANEL_IDS.KANBAN, title: 'Kanban', defaultPosition: 'center' },
  { id: PANEL_IDS.PREVIEW, title: 'Preview', defaultPosition: 'center' },
  {
    id: PANEL_IDS.DEV_PREVIEW,
    title: 'Dev Preview',
    defaultPosition: 'center',
  },
  { id: PANEL_IDS.DIFFS, title: 'Diffs', defaultPosition: 'center' },
  { id: PANEL_IDS.TERMINAL, title: 'Terminal', defaultPosition: 'bottom' },
  { id: PANEL_IDS.GIT, title: 'Git 管理器', defaultPosition: 'left' },
  { id: PANEL_IDS.WELCOME, title: '欢迎', defaultPosition: 'center' },
  { id: PANEL_IDS.LOGS, title: 'Logs', defaultPosition: 'center' },
  { id: PANEL_IDS.NOTES, title: '笔记', defaultPosition: 'center' },
  { id: PANEL_IDS.SEARCH, title: '搜索', defaultPosition: 'left' },
];
