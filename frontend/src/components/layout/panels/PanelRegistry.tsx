import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from 'dockview-react';
import { X } from 'lucide-react';
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
const LazyWebPreviewPanel = React.lazy(
  () => import('@/components/panels/DockviewWebPreviewPanel')
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
const LazyWorkspaceSessionListPanel = React.lazy(
  () => import('@/components/workspace-session-list/WorkspaceSessionListPanel')
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
  [PANEL_IDS.WEB_PREVIEW]: LazyWebPreviewPanel,
  [PANEL_IDS.DIFFS]: LazyDiffPanel,
  [PANEL_IDS.TERMINAL]: LazyTerminalPanel,
  [PANEL_IDS.AI_CHAT]: LazyAIChatPanel,
  [PANEL_IDS.GIT]: LazyGitPanel,
  [PANEL_IDS.WELCOME]: LazyWelcomePanel,
  [PANEL_IDS.LOGS]: LazyLogsPanel,
  [PANEL_IDS.NOTES]: LazyNotesPanel,
  [PANEL_IDS.SEARCH]: LazySearchPanel,
  [PANEL_IDS.SESSION_LIST]: LazyWorkspaceSessionListPanel,
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

// Safety net for serialized layouts that escaped the v22 store migration
// (e.g. restored from a backup): the Web Preview panel's pre-rename
// component id still resolves.
panelComponents['dev-preview'] = panelComponents[PANEL_IDS.WEB_PREVIEW];

const MAX_WORKSPACE_TAB_TITLE_CHARS = 6;

type WorkspaceDockviewTabProps = IDockviewPanelHeaderProps &
  React.HTMLAttributes<HTMLDivElement> & {
    hideClose?: boolean;
    closeActionOverride?: () => void;
  };

function truncateWorkspaceTabTitle(title: string): string {
  const chars = Array.from(title);
  if (chars.length <= MAX_WORKSPACE_TAB_TITLE_CHARS) {
    return title;
  }

  return `${chars.slice(0, MAX_WORKSPACE_TAB_TITLE_CHARS).join('')}...`;
}

export function WorkspaceDockviewTab({
  api,
  containerApi: _containerApi,
  params: _params,
  tabLocation: _tabLocation,
  hideClose,
  closeActionOverride,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  ...rest
}: WorkspaceDockviewTabProps) {
  const [title, setTitle] = React.useState(api.title ?? '');
  const isMiddleMouseButton = React.useRef(false);

  React.useEffect(() => {
    const disposable = api.onDidTitleChange((event) => {
      setTitle(event.title ?? '');
    });

    if (title !== (api.title ?? '')) {
      setTitle(api.title ?? '');
    }

    return () => disposable.dispose();
  }, [api, title]);

  const onClose = React.useCallback(
    (event: React.PointerEvent | React.MouseEvent) => {
      event.preventDefault();
      if (closeActionOverride) {
        closeActionOverride();
      } else {
        api.close();
      }
    },
    [api, closeActionOverride]
  );

  return (
    <div
      {...rest}
      data-testid="dockview-dv-default-tab"
      title={title}
      className="dv-default-tab"
      onPointerDown={(event) => {
        isMiddleMouseButton.current = event.button === 1;
        onPointerDown?.(event);
      }}
      onPointerUp={(event) => {
        if (isMiddleMouseButton.current && event.button === 1 && !hideClose) {
          isMiddleMouseButton.current = false;
          onClose(event);
        }
        onPointerUp?.(event);
      }}
      onPointerLeave={(event) => {
        isMiddleMouseButton.current = false;
        onPointerLeave?.(event);
      }}
    >
      <span className="dv-default-tab-content">
        {truncateWorkspaceTabTitle(title)}
      </span>
      {!hideClose && (
        <div
          className="dv-default-tab-action"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onClose}
          aria-label={`Close ${title}`}
          role="button"
        >
          <X className="h-3 w-3" />
        </div>
      )}
    </div>
  );
}

/**
 * Panel metadata for display purposes.
 */
export interface PanelMeta {
  id: PanelId;
  title: string;
  defaultPosition: 'left' | 'center' | 'bottom';
}

export function usePanelMeta(): PanelMeta[] {
  const { t } = useTranslation(['panels', 'common']);

  return [
    {
      id: PANEL_IDS.FILE_TREE,
      title: t('panelRegistry.fileExplorer'),
      defaultPosition: 'left',
    },
    { id: PANEL_IDS.KANBAN, title: 'Kanban', defaultPosition: 'center' },
    { id: PANEL_IDS.PREVIEW, title: 'Preview', defaultPosition: 'center' },
    {
      id: PANEL_IDS.WEB_PREVIEW,
      title: 'Web Preview',
      defaultPosition: 'center',
    },
    { id: PANEL_IDS.DIFFS, title: 'Diffs', defaultPosition: 'center' },
    { id: PANEL_IDS.TERMINAL, title: 'Terminal', defaultPosition: 'bottom' },
    {
      id: PANEL_IDS.GIT,
      title: t('panelRegistry.gitManager'),
      defaultPosition: 'left',
    },
    {
      id: PANEL_IDS.WELCOME,
      title: t('panelRegistry.welcome'),
      defaultPosition: 'center',
    },
    { id: PANEL_IDS.LOGS, title: 'Logs', defaultPosition: 'center' },
    {
      id: PANEL_IDS.NOTES,
      title: t('panelRegistry.notes'),
      defaultPosition: 'center',
    },
    {
      id: PANEL_IDS.SEARCH,
      title: t('panelRegistry.search'),
      defaultPosition: 'left',
    },
    {
      id: PANEL_IDS.SESSION_LIST,
      title: t('panelRegistry.sessionList'),
      defaultPosition: 'left',
    },
  ];
}
